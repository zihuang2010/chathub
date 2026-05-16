//! Relay e2e(Plan 7 — 只剩 v2 + Auth 透传)。
//!
//! 所有测试 `#[tokio::test(flavor = "multi_thread")]` —— wiremock + tonic 共享 runtime 单线程会死锁。
#![allow(clippy::result_large_err)]

mod common;

use common::{mount_verify_token, spawn_relay};

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
        .post(format!("{push_url}/internal/push"))
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
    serde_json::json!({
        "accessToken": {
            "tokenValue": "biz-tok-7",
            "tokenType": { "value": "Bearer" },
            "issuedAt": "2026-05-16 10:00:00",
            "expiresAt": "2026-05-16 22:00:00"
        },
        "userId": 7,
        "nickName": "Alice",
        "channel": 3
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

// ─── /internal/push ──────────────────────────────────────────────────────

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
    assert_eq!(ack["inserted"], 1);
    assert_eq!(ack["notifySeq"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn push_idempotent_on_retry() {
    let h = spawn_relay().await;
    let body = push_body(
        100,
        42,
        serde_json::json!([
            { "eventType": "MESSAGE_UPSERT", "conversationId": "c1" }
        ]),
    );
    let r1: serde_json::Value = do_push(&h.push_url, &h.push_secret, &body)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(r1["inserted"], 1);
    let r2: serde_json::Value = do_push(&h.push_url, &h.push_secret, &body)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(r2["inserted"], 0);
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
        .post(format!("{}/internal/push", h.push_url))
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
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!([{"wxCsAccountId": "wa-1", "name": "abc"}])),
        )
        .mount(&h.downstream)
        .await;

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-list".into());
    let resp = hub
        .forward(ForwardRequest {
            method: "list_accounts".into(),
            body_json: bytes::Bytes::new(),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(resp.http_status, 200);
    let arr: serde_json::Value = serde_json::from_slice(&resp.body_json).unwrap();
    assert_eq!(arr[0]["wxCsAccountId"], "wa-1");
}
