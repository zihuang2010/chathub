//! Plan 5 e2e:7 个场景。fixture 在 common/mod.rs。
//! 所有测试 #[tokio::test(flavor = "multi_thread")] — 否则 wiremock + tonic
//! 共享 runtime 会死锁(spec §12.3,风险 R6)。
#![allow(clippy::result_large_err)]

mod common;

use common::{mint_jwt, spawn_relay};

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

/// 用于 Hub.* RPC 的带鉴权 raw client。
/// `chathub-net::HubClient::subscribe` 是 pub(crate),e2e 直接用 proto 生成客户端。
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

// ─── fixture 自检(T21 遗留) ──────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn fixture_self_test_healthz_returns_ok() {
    let h = spawn_relay().await;
    let resp = reqwest::get(format!("{}/healthz", h.push_url))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");
}

// ═══════════════════════════════════════════════════════════════════════════════
// e2e #1 — login_success_returns_token_and_user
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn login_success_returns_token_and_user() {
    use chathub_proto::v1::LoginRequest;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    Mock::given(method("POST"))
        .and(path("/v1/verify_user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
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

    assert!(!resp.access_token.is_empty());
    assert_eq!(resp.user.unwrap().user_id, "u-1");
    let claims = h.signer.verifier().verify(&resp.access_token).unwrap();
    assert_eq!(claims.sub, "u-1");
    assert_eq!(claims.device_id, "dev-A");
}

// ═══════════════════════════════════════════════════════════════════════════════
// e2e #2 — login_invalid_credentials_maps_to_unauthenticated
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn login_invalid_credentials_maps_to_unauthenticated() {
    use chathub_proto::v1::LoginRequest;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    Mock::given(method("POST"))
        .and(path("/v1/verify_user"))
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
// e2e #3 — subscribe_with_valid_jwt_receives_pushed_event
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_with_valid_jwt_receives_pushed_event() {
    use chathub_proto::v1::SubscribeRequest;
    use tokio_stream::StreamExt;

    let h = spawn_relay().await;
    let token = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");
    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client_with_token(ch, token);
    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_seqs: Default::default(),
        })
        .await
        .unwrap()
        .into_inner();

    // 等 server-side register 落地
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // POST /internal/push
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
// e2e #4 — subscribe_resumes_after_push_using_since_seqs
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_resumes_after_push_using_since_seqs() {
    use chathub_proto::v1::SubscribeRequest;
    use tokio_stream::StreamExt;

    let h = spawn_relay().await;
    let token = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");

    // 第一次:订阅,推 3 条,只消费前 2 条,然后 drop stream
    {
        let ch = raw_channel(h.grpc_addr).await;
        let mut hub = hub_client_with_token(ch, token.clone());
        let mut s1 = hub
            .subscribe(SubscribeRequest {
                since_seqs: Default::default(),
            })
            .await
            .unwrap()
            .into_inner();

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        for i in 1..=3_i64 {
            let body = incoming_push_body("wa-1", &format!("sm-{i}"), &format!("m{i}"));
            let _ = do_push(&h.push_url, &h.push_secret, &body).await;
        }

        // 消费 seq 1
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), s1.next()).await;
        // 消费 seq 2
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), s1.next()).await;
        // drop s1 — seq 3 留在 ring buffer,未消费
    }

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // 第二次:since_seqs={"wa-1":2},应只收到 seq 3
    let ch2 = raw_channel(h.grpc_addr).await;
    let mut hub2 = hub_client_with_token(ch2, token);
    let mut since = HashMap::new();
    since.insert("wa-1".to_string(), 2_i64);
    let mut s2 = hub2
        .subscribe(SubscribeRequest { since_seqs: since })
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
// e2e #5 — kicked_on_second_subscribe_with_different_device
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn kicked_on_second_subscribe_with_different_device() {
    use chathub_proto::v1::SubscribeRequest;
    use tokio_stream::StreamExt;

    let h = spawn_relay().await;
    let tok1 = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");
    let tok2 = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-B");

    let ch1 = raw_channel(h.grpc_addr).await;
    let mut hub1 = hub_client_with_token(ch1, tok1);
    let mut s1 = hub1
        .subscribe(SubscribeRequest {
            since_seqs: Default::default(),
        })
        .await
        .unwrap()
        .into_inner();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let ch2 = raw_channel(h.grpc_addr).await;
    let mut hub2 = hub_client_with_token(ch2, tok2);
    let _s2 = hub2
        .subscribe(SubscribeRequest {
            since_seqs: Default::default(),
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
// e2e #6 — send_translates_to_downstream_and_emits_status_change
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn send_translates_to_downstream_and_emits_status_change() {
    use chathub_proto::v1::{message_body, MessageBody, SendRequest, SubscribeRequest, TextBody};
    use tokio_stream::StreamExt;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let h = spawn_relay().await;
    Mock::given(method("POST"))
        .and(path("/v1/send"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "server_msg_id": "sm-99",
            "sent_at_ms": 1_700_000_000_000_i64
        })))
        .mount(&h.downstream)
        .await;

    let token = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");
    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client_with_token(ch, token);

    // Subscribe 先
    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_seqs: Default::default(),
        })
        .await
        .unwrap()
        .into_inner();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Send
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

    // Subscribe stream 应收到 MessageStatusChange{STATUS_SENT}
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
// e2e #7 — push_with_invalid_secret_returns_401
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
