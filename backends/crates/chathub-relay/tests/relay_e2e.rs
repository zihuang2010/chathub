//! Relay e2e(Plan 7 — 只剩 v2 + Auth 透传)。
//!
//! 所有测试 `#[tokio::test(flavor = "multi_thread")]` —— wiremock + tonic 共享 runtime 单线程会死锁。
#![allow(clippy::result_large_err)]

mod common;

use common::{
    mount_notify_pull, mount_notify_pull_status, mount_verify_token, spawn_relay, spawn_relay_with,
    PullCfg,
};

use chathub_proto::v1::server_event::Body;
use chathub_proto::v1::{AckRequest, ForwardRequest, SubscribeRequest};
use tokio_stream::StreamExt;
use tonic::transport::Endpoint;

async fn raw_channel(addr: std::net::SocketAddr) -> tonic::transport::Channel {
    Endpoint::from_shared(format!("http://{addr}"))
        .unwrap()
        .connect()
        .await
        .unwrap()
}

fn hub_client(
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
            Ok(req)
        },
    )
}

async fn do_push(push_url: &str, secret: &str, body: &serde_json::Value) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("{push_url}/rpc/v1/wecomAggregate/notify/push"))
        .bearer_auth(secret)
        .json(body)
        .send()
        .await
        .unwrap()
}

fn push_body(notify_seq: u64, employee_id: i64, events: serde_json::Value) -> serde_json::Value {
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
async fn fixture_self_test_healthz_returns_ok() {
    let h = spawn_relay().await;
    let resp = reqwest::get(format!("{}/healthz", h.push_url))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

// ─── Auth 透传(OAuth2)─────────────────────────────────────────────────

fn jdd_response() -> serde_json::Value {
    // 业务后台 2026-05-17 起统一包络 `{code:1, msg:"成功", data:JddTokenVO}`。
    serde_json::json!({
        "code": 1,
        "serviceCode": "",
        "msg": "成功",
        "data": {
            "accessToken": {
                "tokenValue": "biz-tok-7",
                "tokenType": { "value": "Bearer" },
                "issuedAt": "2026-05-16 10:00:00",
                "expiresAt": "2026-05-16 22:00:00"
            },
            "userId": "7",
            "nickName": "Alice",
            "channel": 3
        }
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn login_oauth2_passes_through_business_token_and_user() {
    use chathub_proto::v1::LoginRequest;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    Mock::given(method("POST"))
        .and(path("/account-app/oauth2/token"))
        .and(query_param("scope", "server"))
        .and(query_param("terminalId", "dev-A"))
        .and(query_param("grant_type", "password"))
        .and(header(
            "authorization",
            "Basic cmhfd3hjaGF0OnJoX3d4Y2hhdA==",
        ))
        .and(header("content-type", "application/x-www-form-urlencoded"))
        .respond_with(ResponseTemplate::new(200).set_body_json(jdd_response()))
        .mount(&h.downstream)
        .await;
    let mut client =
        chathub_proto::v1::auth_client::AuthClient::connect(format!("http://{}", h.grpc_addr))
            .await
            .unwrap();
    let resp = client
        .login(LoginRequest {
            username: "u".into(),
            password: "p".into(),
            device_id: "dev-A".into(),
            device_name: "Mac".into(),
            client_ver: "".into(),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(resp.access_token, "biz-tok-7");
    assert_eq!(resp.user.as_ref().unwrap().user_id, "7");
    assert_eq!(resp.user.as_ref().unwrap().display_name, "Alice");
    // wecom_accounts 永远空 —— 前端走 list_accounts via Forward
    assert!(resp.wecom_accounts.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn login_oauth2_invalid_credentials_maps_to_unauthenticated() {
    use chathub_proto::v1::LoginRequest;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    Mock::given(method("POST"))
        .and(path("/account-app/oauth2/token"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&h.downstream)
        .await;
    let mut client =
        chathub_proto::v1::auth_client::AuthClient::connect(format!("http://{}", h.grpc_addr))
            .await
            .unwrap();
    let err = client
        .login(LoginRequest {
            username: "u".into(),
            password: "wrong".into(),
            device_id: "dev-A".into(),
            device_name: "Mac".into(),
            client_ver: "".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), tonic::Code::Unauthenticated);
}

#[tokio::test(flavor = "multi_thread")]
async fn login_oauth2_malformed_response_maps_internal() {
    use chathub_proto::v1::LoginRequest;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    Mock::given(method("POST"))
        .and(path("/account-app/oauth2/token"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"garbage": true})),
        )
        .mount(&h.downstream)
        .await;
    let mut client =
        chathub_proto::v1::auth_client::AuthClient::connect(format!("http://{}", h.grpc_addr))
            .await
            .unwrap();
    let err = client
        .login(LoginRequest {
            username: "u".into(),
            password: "p".into(),
            device_id: "dev-A".into(),
            device_name: "Mac".into(),
            client_ver: "".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), tonic::Code::Internal);
}

// ─── /rpc/v1/wecomAggregate/notify/push ───────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn push_persists_event_and_returns_ack() {
    let h = spawn_relay().await;
    let body = push_body(
        1,
        42,
        serde_json::json!([
            { "eventType": "MESSAGE_UPSERT", "conversationId": "c1" }
        ]),
    );
    let resp = do_push(&h.push_url, &h.push_secret, &body).await;
    assert_eq!(resp.status(), 200);
    let ack: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(ack["code"], 1);
    assert_eq!(ack["serviceCode"], "260000000");
    assert_eq!(ack["data"]["accepted"], true);
    assert_eq!(ack["data"]["acceptedEventCount"], 1);
    assert_eq!(ack["data"]["notifySeq"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn push_idempotent_on_retry() {
    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-idem", 42, "dev-A").await;
    let body = push_body(
        100,
        42,
        serde_json::json!([
            { "eventType": "MESSAGE_UPSERT", "conversationId": "c1" }
        ]),
    );

    // 推两次同一 batch(同 notifySeq):两次都受理成功,relay 持久化层 INSERT OR IGNORE 去重。
    let r1: serde_json::Value = do_push(&h.push_url, &h.push_secret, &body)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(r1["data"]["accepted"], true);
    let r2: serde_json::Value = do_push(&h.push_url, &h.push_secret, &body)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(r2["data"]["accepted"], true);

    // 幂等性在重放层验证:订阅 since=99 只应回放一帧 notifySeq=100,重投不产生重复。
    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-idem".into());
    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_notify_seq: 99,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        })
        .await
        .unwrap()
        .into_inner();

    match stream.next().await.unwrap().unwrap().body {
        Some(Body::SubscribeAck(_)) => {}
        other => panic!("expected SubscribeAck, got {other:?}"),
    }
    match stream.next().await.unwrap().unwrap().body {
        Some(Body::PushBatch(pb)) => assert_eq!(pb.notify_seq, 100),
        other => panic!("expected PushBatch(100), got {other:?}"),
    }
    // 不应有第二帧:重投未在 event log 产生重复行。
    let dup = tokio::time::timeout(std::time::Duration::from_millis(300), stream.next()).await;
    assert!(dup.is_err(), "retry must not replay a duplicate frame");
}

#[tokio::test(flavor = "multi_thread")]
async fn push_unknown_client_id_returns_403() {
    let h = spawn_relay().await;
    let body = serde_json::json!({
        "notifySeq": 1, "clientId": "rogue", "employeeId": 42,
        "batchTime": "x", "events": [{ "eventType": "MESSAGE_UPSERT" }]
    });
    let resp = do_push(&h.push_url, &h.push_secret, &body).await;
    assert_eq!(resp.status(), 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn push_with_invalid_secret_returns_401() {
    let h = spawn_relay().await;
    let body = push_body(
        1,
        42,
        serde_json::json!([{ "eventType": "MESSAGE_UPSERT" }]),
    );
    let resp = reqwest::Client::new()
        .post(format!("{}/rpc/v1/wecomAggregate/notify/push", h.push_url))
        .bearer_auth("WRONG")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
}

// ─── Subscribe v2 + 实时 fanout ──────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_with_no_since_returns_ack_then_realtime_push() {
    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-v2", 99, "dev-A").await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-v2".into());
    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_notify_seq: 0,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        })
        .await
        .unwrap()
        .into_inner();

    let f1 = stream.next().await.unwrap().unwrap();
    match f1.body {
        Some(Body::SubscribeAck(ack)) => {
            assert_eq!(ack.resumed_from_seq, 0);
            assert!(!ack.resync_required);
        }
        other => panic!("expected SubscribeAck, got {other:?}"),
    }

    let body = push_body(
        77,
        99,
        serde_json::json!([
            { "eventType": "MESSAGE_UPSERT", "conversationId": "c-a",
              "message": { "localMessageId": "LM-7" } }
        ]),
    );
    let resp = do_push(&h.push_url, &h.push_secret, &body).await;
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
        }
        other => panic!("expected PushBatch, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_with_since_replays_persisted_events() {
    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-v2", 55, "dev-A").await;

    for seq in [10u64, 11, 12] {
        let body = push_body(
            seq,
            55,
            serde_json::json!([
                { "eventType": "MESSAGE_UPSERT", "conversationId": format!("c-{seq}") }
            ]),
        );
        let resp = do_push(&h.push_url, &h.push_secret, &body).await;
        assert_eq!(resp.status(), 200);
    }

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-v2".into());
    let mut stream = hub
        .subscribe(SubscribeRequest {
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
        }
        other => panic!("expected SubscribeAck, got {other:?}"),
    }
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

// ─── notify/pull 缺口补偿 ─────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_backfills_from_outbox_after_event_log_loss() {
    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-bf", 77, "dev-A").await;

    // push seqs 1..=5 → 入库
    for seq in 1u64..=5 {
        let body = push_body(
            seq,
            77,
            serde_json::json!([{ "eventType": "MESSAGE_UPSERT", "conversationId": format!("c-{seq}") }]),
        );
        assert_eq!(
            do_push(&h.push_url, &h.push_secret, &body).await.status(),
            200
        );
    }

    // 模拟 relay event log 全损:删光 hub_events(cutoff=i64::MAX → 全部 created_at_ms 命中)
    let deleted = h
        .events_log
        .cleanup_older_than(i64::MAX, 1_000_000)
        .await
        .unwrap();
    assert!(deleted >= 5);
    assert!(h
        .events_log
        .query_since(77, 0, 100)
        .await
        .unwrap()
        .is_empty());

    // 业务端 outbox 仍有 seqs 3..=5(客户端水位 since=2,期望补回 3,4,5)
    mount_notify_pull(&h.downstream, 77, &[3, 4, 5]).await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-bf".into());
    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_notify_seq: 2,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        })
        .await
        .unwrap()
        .into_inner();

    let f1 = stream.next().await.unwrap().unwrap();
    match f1.body {
        Some(Body::SubscribeAck(ack)) => {
            assert_eq!(ack.resumed_from_seq, 2);
            assert_eq!(ack.replayed_to_seq, 5, "补偿拉取后续点到 5");
            assert!(!ack.resync_required, "补齐完整 → 不需要 resync");
        }
        other => panic!("expected SubscribeAck, got {other:?}"),
    }
    for expected in [3u64, 4, 5] {
        let f = stream.next().await.unwrap().unwrap();
        match f.body {
            Some(Body::PushBatch(pb)) => assert_eq!(pb.notify_seq, expected),
            other => panic!("expected PushBatch {expected}, got {other:?}"),
        }
    }
    // 补回的行确实写回了本地 log(3,4,5)
    assert_eq!(h.events_log.query_since(77, 2, 100).await.unwrap().len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_resync_required_when_notify_pull_fails() {
    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-bf2", 88, "dev-A").await;
    // 业务端 notify_pull 503 → 补偿失败 → 回退 resync
    mount_notify_pull_status(&h.downstream, 503).await;

    // 日志空 + since=10 → 缺口
    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-bf2".into());
    let mut stream = hub
        .subscribe(SubscribeRequest {
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
            assert!(ack.resync_required, "notify_pull 503 → resync 兜底");
            assert!(!ack.resync_reason.is_empty());
        }
        other => panic!("expected SubscribeAck, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_resync_required_when_notify_pull_disabled() {
    let h = spawn_relay_with(PullCfg {
        enabled: false,
        ..Default::default()
    })
    .await;
    mount_verify_token(&h.downstream, "tok-bf3", 99, "dev-A").await;
    // 即便挂了 notify_pull,disabled 时也不该调用
    mount_notify_pull(&h.downstream, 99, &[4, 5]).await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-bf3".into());
    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_notify_seq: 3,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        })
        .await
        .unwrap()
        .into_inner();

    let f1 = stream.next().await.unwrap().unwrap();
    match f1.body {
        Some(Body::SubscribeAck(ack)) => {
            assert!(ack.resync_required, "disabled → resync 兜底");
        }
        other => panic!("expected SubscribeAck, got {other:?}"),
    }
    // 断言零 notify_pull 调用
    let reqs = h.downstream.received_requests().await.unwrap();
    let pulls = reqs
        .iter()
        .filter(|r| r.url.path().contains("notify/pull"))
        .count();
    assert_eq!(pulls, 0, "disabled 不得调用 notify_pull");
}

// ─── Forward(REST 隧道)──────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn forward_routes_to_business_backend() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-v2", 33, "dev-A").await;
    Mock::given(method("POST"))
        .and(path("/v1/send"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"server_msg_id": "S-9"})),
        )
        .mount(&h.downstream)
        .await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-v2".into());
    let resp = hub
        .forward(ForwardRequest {
            method: "send".into(),
            body_json: bytes::Bytes::from_static(br#"{"conversationId":"c1"}"#),
            query: Default::default(),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(resp.http_status, 200);
    let parsed: serde_json::Value = serde_json::from_slice(&resp.body_json).unwrap();
    assert_eq!(parsed["server_msg_id"], "S-9");
}

// ─── Ack ────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn hub_ack_round_trip() {
    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-v2", 7, "dev-A").await;
    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-v2".into());
    let _ = hub
        .ack(AckRequest { notify_seq: 1024 })
        .await
        .expect("ack ok");
}

// ─── login 预填 cache ─────────────────────────────────────────────────────

/// 验证关键优化:login 成功后 relay 预填 TokenAuthenticator cache,
/// 紧接着 Subscribe **不调** verify_token —— mock 上**不挂** verify_token endpoint,
/// 如果还调,wiremock 默认 404 → relay ProtocolMismatch → Subscribe 失败。
#[tokio::test(flavor = "multi_thread")]
async fn login_prepopulates_cache_subscribe_skips_verify_token() {
    use chathub_proto::v1::LoginRequest;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    Mock::given(method("POST"))
        .and(path("/account-app/oauth2/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "code": 1,
            "serviceCode": "",
            "msg": "成功",
            "data": {
                "accessToken": {
                    "tokenValue": "freshly-minted-token",
                    "tokenType": { "value": "Bearer" },
                    "issuedAt": "2026-05-16 10:00:00",
                    "expiresAt": "2026-05-16 22:00:00"
                },
                "userId": 88,
                "nickName": "Bob",
                "channel": 3
            }
        })))
        .mount(&h.downstream)
        .await;

    // 1. login
    let mut auth_client =
        chathub_proto::v1::auth_client::AuthClient::connect(format!("http://{}", h.grpc_addr))
            .await
            .unwrap();
    let login_resp = auth_client
        .login(LoginRequest {
            username: "u".into(),
            password: "p".into(),
            device_id: "dev-A".into(),
            device_name: "Mac".into(),
            client_ver: "".into(),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(login_resp.access_token, "freshly-minted-token");

    // 2. 用刚拿到的 token 立即 Subscribe(走 cache 预填路径,不调 verify_token)
    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "freshly-minted-token".into());
    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_notify_seq: 0,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        })
        .await
        .expect("subscribe should succeed via cache prepopulate (no verify_token call)")
        .into_inner();

    // 第一帧应该是 SubscribeAck(employee_id=88 from prepopulated UserCtx)
    let ack = stream.next().await.unwrap().unwrap();
    match ack.body {
        Some(Body::SubscribeAck(_)) => {} // good — Subscribe 通了,确认 cache 命中
        other => panic!("expected SubscribeAck, got {other:?}"),
    }
}

// ─── Forward 客户端 token 透传 + GET dispatch ───────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn forward_passes_client_token_not_relay_secret_to_backend() {
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "client-tok-A", 88, "dev-A").await;
    // 关键断言:业务后台收到的 Authorization 必须是客户端 token,而不是 relay 任何 shared secret
    Mock::given(method("POST"))
        .and(path("/v1/send"))
        .and(header("authorization", "Bearer client-tok-A"))
        .and(header("x-relay-employee-id", "88"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true})))
        .mount(&h.downstream)
        .await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "client-tok-A".into());
    let resp = hub
        .forward(ForwardRequest {
            method: "send".into(),
            body_json: bytes::Bytes::from_static(br#"{"x":1}"#),
            query: Default::default(),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(resp.http_status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn forward_list_accounts_dispatches_get() {
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-list", 12, "dev-A").await;
    // list_accounts 在默认 routes 表里是 GET
    Mock::given(method("GET"))
        .and(path(
            "/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine",
        ))
        .and(header("authorization", "Bearer tok-list"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "wecomAccountId": "wa-1",
                "wecomName": "abc",
                "wecomAccount": "mock_wa-1",
                "wecomAlias": "wa-1_alias",
                "wecomAvatar": "https://example.com/avatar/wa-1.png",
                "wecomStatus": 1,
                "gender": 1,
                "position": "工程师"
            }])),
        )
        .mount(&h.downstream)
        .await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-list".into());
    let resp = hub
        .forward(ForwardRequest {
            method: "list_accounts".into(),
            body_json: bytes::Bytes::new(),
            query: Default::default(),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(resp.http_status, 200);
    let arr: serde_json::Value = serde_json::from_slice(&resp.body_json).unwrap();
    assert_eq!(arr[0]["wecomAccountId"], "wa-1");
}

// ─── 截断不 loop(B2 语义):resync 跳重放 + ack 报 head + since=head 续点不再 loop ──

/// P1 e2e 原来断言"收齐 1000 回放帧";B2 上线后 resync 路径跳重放,原断言失效。
/// 本测试改写为 B2 语义:
///   1. 不死锁守护:timeout 包 subscribe,断言立即返回响应头。
///   2. 首帧 SubscribeAck:resync_required==true,replayed_to_seq==1001(head=MAX)。
///   3. ack 之后无 PushBatch 帧(短 timeout 断言超时 = 无帧)。
///   4. 第二次 subscribe(since=head=1001):resync_required==false、无积压帧 —— loop 已消除。
#[tokio::test(flavor = "multi_thread")]
async fn subscribe_resync_truncation_skips_replay_and_acks_head() {
    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-big", 88, "dev-A").await;

    // 预置 1001 个 distinct notify_seq(>REPLAY_LIMIT=1000 → 截断 + resync_required)。
    // head = MAX = 1001。
    let rows: Vec<chathub_relay::storage::events::EventRow> = (1..=1001_i64)
        .map(|seq| chathub_relay::storage::events::EventRow {
            employee_id: 88,
            notify_seq: seq,
            event_index: 0,
            event_type: "MESSAGE_UPSERT".into(),
            event_reason: Some("CUSTOMER_MESSAGE_RECEIVED".into()),
            conversation_id: Some("conv-1".into()),
            customer_user_id: Some("u-c".into()),
            external_user_id: Some("ext-1".into()),
            client_id: "rh_wxchat".into(),
            batch_id: Some(format!("rh_wxchat:88:{seq}")),
            batch_time: Some("2026-05-14 10:30:00".into()),
            event_time: Some("2026-05-14 10:30:00".into()),
            payload_json: r#"{"eventType":"MESSAGE_UPSERT"}"#.into(),
            created_at_ms: seq * 1000,
        })
        .collect();
    h.events_log.insert_batch(rows).await.unwrap();

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-big".into());

    // 第一次订阅 since=0:死锁守护 + B2 ack 语义。
    // 死锁时 subscribe() 拿不到响应头 → 挂起;timeout 把死锁变成可断言的失败。
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        hub.subscribe(SubscribeRequest {
            since_notify_seq: 0,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        }),
    )
    .await
    .expect("subscribe 必须立即返回响应头,不能死锁")
    .unwrap()
    .into_inner();

    // 首帧:ack.resync_required=true 且 replayed_to_seq=1001(head=MAX),不是截断 last=1000。
    let first = stream.next().await.unwrap().unwrap();
    match first.body {
        Some(Body::SubscribeAck(ack)) => {
            assert!(ack.resync_required, "1001>1000 → 截断 → resync");
            assert_eq!(
                ack.replayed_to_seq, 1001,
                "ack 报 head(MAX=1001),非截断 last(1000)"
            );
        }
        other => panic!("expected SubscribeAck, got {other:?}"),
    }

    // 不应有任何回放帧:resync 跳重放。短 timeout 内无帧 = 正确。
    let next = tokio::time::timeout(std::time::Duration::from_millis(500), stream.next()).await;
    assert!(next.is_err(), "resync 截断路径不应发回放帧,却收到了一帧");
    drop(stream); // 断开第一条流,释放注册。

    // 第二次订阅 since=head(=1001):无新事件 → 无截断 → resync_required=false、零回放帧。
    // 这就是 B2 消除 loop 的体现:客户端把游标推到 head 后不再被反复重放轰炸。
    let ch2 = raw_channel(h.grpc_addr).await;
    let mut hub2 = hub_client(ch2, "tok-big".into());
    let mut stream2 = hub2
        .subscribe(SubscribeRequest {
            since_notify_seq: 1001,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        })
        .await
        .unwrap()
        .into_inner();
    let ack2 = stream2.next().await.unwrap().unwrap();
    match ack2.body {
        Some(Body::SubscribeAck(ack)) => {
            assert!(
                !ack.resync_required,
                "since=head 无积压 → 不再 resync(loop 消除)"
            );
            assert_eq!(
                ack.replayed_to_seq, 1001,
                "since=head 续点 replayed_to_seq=since"
            );
        }
        other => panic!("expected SubscribeAck, got {other:?}"),
    }
    let none = tokio::time::timeout(std::time::Duration::from_millis(500), stream2.next()).await;
    assert!(none.is_err(), "since=head 续点不应有任何回放帧");
}
