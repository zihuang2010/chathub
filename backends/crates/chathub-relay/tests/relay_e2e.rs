//! Relay e2e:纯隔道 + 透传网关。fixture 在 common/mod.rs。
//! 所有测试 #[tokio::test(flavor = "multi_thread")] — 否则 wiremock + tonic
//! 共享 runtime 会死锁。
#![allow(clippy::result_large_err)]

mod common;

use common::{mount_verify_token, spawn_relay};

use std::collections::HashMap;
use tonic::transport::Endpoint;

// ─── 辅助:建 raw hub gRPC client(含 bearer + protocol-version 拦截器) ───────

async fn raw_channel(addr: std::net::SocketAddr) -> tonic::transport::Channel {
    Endpoint::from_shared(format!("http://{addr}"))
        .unwrap()
        .connect()
        .await
        .unwrap()
}

/// 用于 Hub.* RPC 的带鉴权 raw client。token 为业务后台签发的不透明串。
fn hub_client_with_token(
    channel: tonic::transport::Channel,
    token: String,
) -> chathub_proto::v1::hub_client::HubClient<
    tonic::codegen::InterceptedService<tonic::transport::Channel, impl tonic::service::Interceptor>,
> {
    chathub_proto::v1::hub_client::HubClient::with_interceptor(
        channel,
        move |mut req: tonic::Request<()>| {
            req.metadata_mut()
                .insert("chathub-protocol-version", "1".parse().unwrap());
            req.metadata_mut()
                .insert("authorization", format!("Bearer {token}").parse().unwrap());
            req.metadata_mut()
                .insert("chathub-client-version", "0.1.0".parse().unwrap());
            req.metadata_mut()
                .insert("chathub-platform", "macos".parse().unwrap());
            Ok(req)
        },
    )
}

// ─── push 辅助:POST /internal/push ──────────────────────────────────────────

async fn do_push(push_url: &str, secret: &str, body: &serde_json::Value) -> u16 {
    let resp = reqwest::Client::new()
        .post(format!("{push_url}/internal/push"))
        .bearer_auth(secret)
        .json(body)
        .send()
        .await
        .unwrap();
    resp.status().as_u16()
}

// ─── 通用 push body:推一条 incoming 消息 ─────────────────────────────────────

fn incoming_push_body(account: &str, server_msg_id: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "wecom_account_id": account,
        "event": {
            "wecom_account_id": "",
            "seq": 0,
            "incoming": {
                "conversation_id": "conv-1",
                "from_user_id": "peer-1",
                "sent_at_ms": 0,
                "server_msg_id": server_msg_id,
                "body": {"text": {"text": text}}
            }
        }
    })
}

// ─── fixture 自检 ────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn fixture_self_test_healthz_returns_ok() {
    let h = spawn_relay().await;
    let resp = reqwest::get(format!("{}/healthz", h.push_url))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

// ═══════════════════════════════════════════════════════════════════════════════
// e2e #1 — login 透传:relay 把业务后台返回的 token + user 原样回客户端
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn login_passes_through_business_token_and_user() {
    use chathub_proto::v1::LoginRequest;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    Mock::given(method("POST"))
        .and(path("/auth/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "biz-token-xyz",
            "user_id": "u-1",
            "display_name": "A",
            "role": "op",
            "tenant_id": "t",
            "wecom_accounts": [
                {"wecom_account_id":"wa-1","corp_id":"c","agent_id":1,"display_name":"w","enabled":true}
            ]
        })))
        .mount(&h.downstream)
        .await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut auth = chathub_proto::v1::auth_client::AuthClient::new(ch);
    let resp = auth
        .login(LoginRequest {
            username: "u".into(),
            password: "p".into(),
            device_id: "dev-A".into(),
            device_name: "Mac".into(),
            client_ver: "0.1.0".into(),
        })
        .await
        .unwrap()
        .into_inner();

    // relay 不签发、不解析:原样透传业务 token
    assert_eq!(resp.access_token, "biz-token-xyz");
    assert_eq!(resp.user.unwrap().user_id, "u-1");
    assert_eq!(resp.wecom_accounts.len(), 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// e2e #2 — login 凭证错误 → Unauthenticated
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn login_invalid_credentials_maps_to_unauthenticated() {
    use chathub_proto::v1::LoginRequest;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    Mock::given(method("POST"))
        .and(path("/auth/login"))
        .respond_with(
            ResponseTemplate::new(401).set_body_json(serde_json::json!({"code":"INVALID_CREDS"})),
        )
        .mount(&h.downstream)
        .await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut auth = chathub_proto::v1::auth_client::AuthClient::new(ch);
    let st = auth
        .login(LoginRequest {
            username: "u".into(),
            password: "bad".into(),
            device_id: "dev".into(),
            device_name: "M".into(),
            client_ver: "0.1.0".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(st.code(), tonic::Code::Unauthenticated);
}

// ═══════════════════════════════════════════════════════════════════════════════
// e2e #3 — subscribe(verifyToken 通过)收到 push 事件
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_with_valid_token_receives_pushed_event() {
    use chathub_proto::v1::SubscribeRequest;
    use tokio_stream::StreamExt;

    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-A", "u-1", "dev-A", &["wa-1"]).await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client_with_token(ch, "tok-A".into());
    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_seqs: Default::default(),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let body = incoming_push_body("wa-1", "sm-1", "hello");
    let status = do_push(&h.push_url, &h.push_secret, &body).await;
    assert_eq!(status, 202);

    let evt = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(evt.wecom_account_id, "wa-1");
    assert_eq!(evt.seq, 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// e2e #3b — subscribe:verifyToken 返回 active:false → Unauthenticated
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_with_inactive_token_is_rejected() {
    use chathub_proto::v1::SubscribeRequest;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    Mock::given(method("POST"))
        .and(path("/v1/verify_token"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"active": false})),
        )
        .mount(&h.downstream)
        .await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client_with_token(ch, "stale-token".into());
    let err = hub
        .subscribe(SubscribeRequest {
            since_seqs: Default::default(),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), tonic::Code::Unauthenticated);
}

// ═══════════════════════════════════════════════════════════════════════════════
// e2e #4 — subscribe 用 since_seqs 续接
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_resumes_after_push_using_since_seqs() {
    use chathub_proto::v1::SubscribeRequest;
    use tokio_stream::StreamExt;

    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-A", "u-1", "dev-A", &["wa-1"]).await;

    // 第一次:订阅,推 3 条,只消费前 2 条,然后 drop stream
    {
        let ch = raw_channel(h.grpc_addr).await;
        let mut hub = hub_client_with_token(ch, "tok-A".into());
        let mut s1 = hub
            .subscribe(SubscribeRequest {
                since_seqs: Default::default(),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_inner();

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        for i in 1..=3_i64 {
            let body = incoming_push_body("wa-1", &format!("sm-{i}"), &format!("m{i}"));
            let _ = do_push(&h.push_url, &h.push_secret, &body).await;
        }

        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), s1.next()).await;
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), s1.next()).await;
        // drop s1 — seq 3 留在 ring buffer,未消费
    }

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // 第二次:since_seqs={"wa-1":2},应只收到 seq 3
    let ch2 = raw_channel(h.grpc_addr).await;
    let mut hub2 = hub_client_with_token(ch2, "tok-A".into());
    let mut since = HashMap::new();
    since.insert("wa-1".to_string(), 2_i64);
    let mut s2 = hub2
        .subscribe(SubscribeRequest {
            since_seqs: since,
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();
    let got = tokio::time::timeout(std::time::Duration::from_secs(2), s2.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(got.seq, 3);
}

// ═══════════════════════════════════════════════════════════════════════════════
// e2e #5 — 不同设备第二次 subscribe 踢掉第一个
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn kicked_on_second_subscribe_with_different_device() {
    use chathub_proto::v1::SubscribeRequest;
    use tokio_stream::StreamExt;

    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-A", "u-1", "dev-A", &["wa-1"]).await;
    mount_verify_token(&h.downstream, "tok-B", "u-1", "dev-B", &["wa-1"]).await;

    let ch1 = raw_channel(h.grpc_addr).await;
    let mut hub1 = hub_client_with_token(ch1, "tok-A".into());
    let mut s1 = hub1
        .subscribe(SubscribeRequest {
            since_seqs: Default::default(),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let ch2 = raw_channel(h.grpc_addr).await;
    let mut hub2 = hub_client_with_token(ch2, "tok-B".into());
    let _s2 = hub2
        .subscribe(SubscribeRequest {
            since_seqs: Default::default(),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();

    let got = tokio::time::timeout(std::time::Duration::from_secs(2), s1.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    match got.body {
        Some(chathub_proto::v1::server_event::Body::System(sig)) => {
            assert_eq!(
                sig.kind,
                chathub_proto::v1::system_signal::Kind::Kicked as i32
            );
        }
        other => panic!("expected KICKED, got: {other:?}"),
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// e2e #6 — send 透传下游 + fanout MessageStatusChange
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn send_translates_to_downstream_and_emits_status_change() {
    use chathub_proto::v1::{message_body, MessageBody, SendRequest, SubscribeRequest, TextBody};
    use tokio_stream::StreamExt;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-A", "u-1", "dev-A", &["wa-1"]).await;
    Mock::given(method("POST"))
        .and(path("/v1/send"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "server_msg_id": "sm-99",
            "sent_at_ms": 1_700_000_000_000_i64
        })))
        .mount(&h.downstream)
        .await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client_with_token(ch, "tok-A".into());

    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_seqs: Default::default(),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let resp = hub
        .send(SendRequest {
            wecom_account_id: "wa-1".into(),
            conversation_id: "conv-1".into(),
            client_msg_id: "client-uuid".into(),
            body: Some(MessageBody {
                kind: Some(message_body::Kind::Text(TextBody {
                    text: "hello".into(),
                })),
                reply_to: None,
                mentions: vec![],
            }),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(resp.server_msg_id, "sm-99");

    let evt = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    match evt.body {
        Some(chathub_proto::v1::server_event::Body::StatusChange(s)) => {
            assert_eq!(s.client_msg_id, "client-uuid");
            assert_eq!(s.server_msg_id, "sm-99");
            assert_eq!(
                s.status,
                chathub_proto::v1::message_status_change::Status::Sent as i32
            );
        }
        other => panic!("expected MessageStatusChange, got: {other:?}"),
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// e2e #7 — push 密钥错误 → 401
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn push_with_invalid_secret_returns_401() {
    let h = spawn_relay().await;
    let body = serde_json::json!({
        "wecom_account_id": "wa-1",
        "event": {
            "wecom_account_id": "",
            "seq": 0,
            "system": {"kind": "KIND_UNSPECIFIED", "detail": ""}
        }
    });
    let status = do_push(&h.push_url, "WRONG", &body).await;
    assert_eq!(status, 401);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Plan 6 stage 5 — e2e for /internal/push/v2 + Subscribe v2 + Hub.Ack + Hub.Forward
// ═══════════════════════════════════════════════════════════════════════════════

use common::mount_verify_token_v2;

/// 业务后台 push v2 batch helper:走 spec §3 字段。
async fn do_push_v2(push_url: &str, secret: &str, body: &serde_json::Value) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("{push_url}/internal/push/v2"))
        .bearer_auth(secret)
        .json(body)
        .send()
        .await
        .unwrap()
}

fn push_v2_body(notify_seq: u64, employee_id: i64, events: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "notifySeq": notify_seq,
        "clientId": "rh_wxchat",
        "employeeId": employee_id,
        "batchId": format!("rh_wxchat:{employee_id}:{notify_seq}"),
        "batchTime": "2026-05-14 10:30:00",
        "events": events,
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn push_v2_persists_event_and_returns_ack_with_count() {
    let h = spawn_relay().await;
    let body = push_v2_body(
        1,
        42,
        serde_json::json!([
            { "eventType": "MESSAGE_UPSERT", "conversationId": "c1", "customerUserId": "u1" }
        ]),
    );
    let resp = do_push_v2(&h.push_url, &h.push_secret, &body).await;
    assert_eq!(resp.status(), 200);
    let ack: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(ack["inserted"], 1);
    assert_eq!(ack["controlCount"], 0);
    assert_eq!(ack["notifySeq"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn push_v2_idempotent_on_retry_returns_zero_inserted() {
    let h = spawn_relay().await;
    let body = push_v2_body(
        100,
        42,
        serde_json::json!([
            { "eventType": "MESSAGE_UPSERT", "conversationId": "c1" }
        ]),
    );
    // 首次:1 行入库
    let r1: serde_json::Value = do_push_v2(&h.push_url, &h.push_secret, &body)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(r1["inserted"], 1);
    // 重投:0 行入库,200 OK(幂等)
    let r2: serde_json::Value = do_push_v2(&h.push_url, &h.push_secret, &body)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(r2["inserted"], 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn push_v2_unknown_client_id_returns_403() {
    let h = spawn_relay().await;
    let body = serde_json::json!({
        "notifySeq": 1,
        "clientId": "rogue_client",
        "employeeId": 42,
        "batchTime": "2026-05-14 10:30:00",
        "events": [{ "eventType": "MESSAGE_UPSERT" }]
    });
    let resp = do_push_v2(&h.push_url, &h.push_secret, &body).await;
    assert_eq!(resp.status(), 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_v2_with_no_since_returns_ack_then_realtime_push() {
    use chathub_proto::v1::server_event::Body;
    use chathub_proto::v1::SubscribeRequest;
    use tokio_stream::StreamExt;

    let h = spawn_relay().await;
    mount_verify_token_v2(&h.downstream, "tok-v2", 99, "dev-A").await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client_with_token(ch, "tok-v2".into());
    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_seqs: Default::default(),
            since_notify_seq: 0,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        })
        .await
        .unwrap()
        .into_inner();

    // 第一帧:SubscribeAck
    let f1 = stream.next().await.unwrap().unwrap();
    match f1.body {
        Some(Body::SubscribeAck(ack)) => {
            assert_eq!(ack.resumed_from_seq, 0);
            assert_eq!(ack.replayed_to_seq, 0);
            assert!(!ack.resync_required);
        }
        other => panic!("expected SubscribeAck, got {other:?}"),
    }

    // 业务后台 push v2 → 该 employee 应当实时收到
    let body = push_v2_body(
        77,
        99,
        serde_json::json!([
            { "eventType": "MESSAGE_UPSERT", "conversationId": "c-a", "message": { "localMessageId": "LM-7" } }
        ]),
    );
    let resp = do_push_v2(&h.push_url, &h.push_secret, &body).await;
    assert_eq!(resp.status(), 200);

    let f2 = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
        .await
        .expect("realtime push timeout")
        .unwrap()
        .unwrap();
    match f2.body {
        Some(Body::PushBatch(pb)) => {
            assert_eq!(pb.notify_seq, 77);
            assert_eq!(pb.employee_id, 99);
            let arr: serde_json::Value = serde_json::from_slice(&pb.events_json).unwrap();
            assert_eq!(arr[0]["eventType"], "MESSAGE_UPSERT");
            assert_eq!(arr[0]["message"]["localMessageId"], "LM-7");
        }
        other => panic!("expected PushBatch, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_v2_with_since_replays_persisted_events() {
    use chathub_proto::v1::server_event::Body;
    use chathub_proto::v1::SubscribeRequest;
    use tokio_stream::StreamExt;

    let h = spawn_relay().await;
    mount_verify_token_v2(&h.downstream, "tok-v2", 55, "dev-A").await;

    // 业务后台先 push 3 个 batch(此时该 employee 没在线)
    for seq in [10u64, 11, 12] {
        let body = push_v2_body(
            seq,
            55,
            serde_json::json!([
                { "eventType": "MESSAGE_UPSERT", "conversationId": format!("c-{seq}") }
            ]),
        );
        let resp = do_push_v2(&h.push_url, &h.push_secret, &body).await;
        assert_eq!(resp.status(), 200);
    }

    // 客户端上线,since=10 → 应该重放 11, 12
    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client_with_token(ch, "tok-v2".into());
    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_seqs: Default::default(),
            since_notify_seq: 10,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        })
        .await
        .unwrap()
        .into_inner();

    let f1 = stream.next().await.unwrap().unwrap();
    match f1.body {
        Some(Body::SubscribeAck(ack)) => {
            assert_eq!(ack.resumed_from_seq, 10);
            assert_eq!(ack.replayed_to_seq, 12);
            assert!(!ack.resync_required); // since=10 == earliest_min - 1 + 1 = OK
        }
        other => panic!("expected SubscribeAck, got {other:?}"),
    }
    // 两条 PushBatchOut 重放(seq 11、12)
    let f2 = stream.next().await.unwrap().unwrap();
    match f2.body {
        Some(Body::PushBatch(pb)) => assert_eq!(pb.notify_seq, 11),
        other => panic!("expected PushBatch 11, got {other:?}"),
    }
    let f3 = stream.next().await.unwrap().unwrap();
    match f3.body {
        Some(Body::PushBatch(pb)) => assert_eq!(pb.notify_seq, 12),
        other => panic!("expected PushBatch 12, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn forward_e2e_routes_method_to_business_backend() {
    use chathub_proto::v1::ForwardRequest;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    mount_verify_token_v2(&h.downstream, "tok-v2", 33, "dev-A").await;
    // 业务后台 /v1/send 回 echo
    Mock::given(method("POST"))
        .and(path("/v1/send"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"server_msg_id": "S-9", "sent_at_ms": 42})),
        )
        .mount(&h.downstream)
        .await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client_with_token(ch, "tok-v2".into());
    let resp = hub
        .forward(ForwardRequest {
            method: "send".into(),
            body_json: br#"{"conversationId":"c1","contentText":"hi"}"#.to_vec(),
        })
        .await
        .unwrap()
        .into_inner();
    let parsed: serde_json::Value = serde_json::from_slice(&resp.body_json).unwrap();
    assert_eq!(parsed["server_msg_id"], "S-9");
    assert_eq!(parsed["sent_at_ms"], 42);
}

#[tokio::test(flavor = "multi_thread")]
async fn hub_ack_e2e_round_trip() {
    use chathub_proto::v1::AckRequest;

    let h = spawn_relay().await;
    mount_verify_token_v2(&h.downstream, "tok-v2", 7, "dev-A").await;
    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client_with_token(ch, "tok-v2".into());
    // Ack 不需要 stream;直接调
    let _ = hub
        .ack(AckRequest { notify_seq: 1024 })
        .await
        .expect("ack ok");
}
