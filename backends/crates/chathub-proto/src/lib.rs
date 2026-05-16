// crates/chathub-proto/src/lib.rs
//! ChatHub gRPC contracts(由 tonic-build 在 build.rs 中从 proto/chathub/v1/*.proto 生成)。
//!
//! Plan 7 — 只剩 v2 三件套:
//!   - `auth_client::AuthClient` + `LoginRequest/Response` + `LogoutRequest/Response`
//!   - `hub_client::HubClient` + `SubscribeRequest` + `AckRequest/Response` + `ForwardRequest/Response`
//!   - `ServerEvent` 含 `PushBatchOut`/`SubscribeAck`/`SystemSignal` 三种 body
//!
//! 老的 Send/Recall/AckRead/FetchHistory / IncomingMsg / MessageRecalled / ReadReceipt /
//! MessageStatusChange / MessageBody / HistoryMessage / Mention / ReplyToRef / RemoteId 全已删除。

#![allow(clippy::all)]
#![allow(non_snake_case, missing_docs)]

pub mod v1 {
    tonic::include_proto!("chathub.v1");
}

#[cfg(test)]
mod tests {
    use super::v1::auth_client::AuthClient;
    use super::v1::{LoginRequest, LoginResponse, LogoutRequest};
    use tonic::transport::Channel;

    #[test]
    fn login_request_default_compiles() {
        let req = LoginRequest::default();
        assert_eq!(req.username, "");
        assert_eq!(req.client_ver, "");
    }

    #[test]
    fn login_response_default_compiles() {
        let resp = LoginResponse::default();
        assert!(resp.access_token.is_empty());
        assert!(resp.user.is_none());
    }

    #[test]
    fn logout_request_round_trips_via_prost() {
        use prost::Message;
        let req = LogoutRequest {
            token: "abc".into(),
        };
        let bytes = req.encode_to_vec();
        let decoded = LogoutRequest::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded.token, "abc");
    }

    #[allow(dead_code, unused_must_use)]
    fn _auth_client_new_signature_exists() {
        let _: fn(Channel) -> AuthClient<Channel> = AuthClient::<Channel>::new;
    }

    #[test]
    fn user_profile_serializes_to_json() {
        use super::v1::UserProfile;
        let p = UserProfile {
            user_id: "u-1".into(),
            display_name: "Alice".into(),
            avatar_url: "".into(),
            role: "operator".into(),
            tenant_id: "t-42".into(),
        };
        let json = serde_json::to_string(&p).expect("serialize");
        assert!(json.contains("\"user_id\":\"u-1\""));
        let back: UserProfile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, p);
    }

    #[test]
    fn server_event_with_push_batch_serializes_round_trip() {
        use super::v1::{server_event, PushBatchOut, ServerEvent};
        let evt = ServerEvent {
            body: Some(server_event::Body::PushBatch(PushBatchOut {
                notify_seq: 42,
                client_id: "rh_wxchat".into(),
                employee_id: 99,
                batch_id: "rh_wxchat:99:42".into(),
                batch_time: "2026-05-14 10:30:00".into(),
                device_id: "dev-A".into(),
                events_json: br#"[{"eventType":"MESSAGE_UPSERT"}]"#.to_vec(),
            })),
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        let back: ServerEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, evt);
    }

    #[test]
    fn server_event_with_system_drain_serializes_round_trip() {
        use super::v1::{server_event, system_signal, ServerEvent, SystemSignal};
        let evt = ServerEvent {
            body: Some(server_event::Body::System(SystemSignal {
                kind: system_signal::Kind::ServerDrain as i32,
                detail: "shutting down".into(),
            })),
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        let back: ServerEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, evt);
    }
}
