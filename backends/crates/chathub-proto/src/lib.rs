// crates/chathub-proto/src/lib.rs
//! ChatHub gRPC contracts(由 tonic-build 在 build.rs 中从 proto/chathub/v1/*.proto 生成)。
//!
//! 主要导出:
//!   - chathub_proto::v1::auth_client::AuthClient<Channel>
//!   - chathub_proto::v1::auth_server::{Auth, AuthServer}
//!   - chathub_proto::v1::hub_client::HubClient<Channel>
//!   - chathub_proto::v1::{LoginRequest, LoginResponse, RefreshTokenRequest, ...}
//!   - chathub_proto::v1::{ErrorDetail, RetryInfo, QuotaFailure, ...}
//!
//! 后续计划在引用时一律走 `chathub_proto::v1::...` 命名空间。

#![allow(clippy::all)]
#![allow(non_snake_case, missing_docs)]

pub mod v1 {
    tonic::include_proto!("chathub.v1");
}

#[cfg(test)]
mod tests {
    use super::v1::auth_client::AuthClient;
    use super::v1::{LoginRequest, LoginResponse, RefreshTokenRequest};
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
        assert_eq!(resp.access_exp_ms, 0);
    }

    #[test]
    fn refresh_request_round_trips_via_prost() {
        // 编解码自检:防止 build.rs 配置漂了
        use prost::Message;
        let req = RefreshTokenRequest {
            refresh_token: "abc".into(),
            device_id: "dev-1".into(),
        };
        let bytes = req.encode_to_vec();
        let decoded = RefreshTokenRequest::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded.refresh_token, "abc");
        assert_eq!(decoded.device_id, "dev-1");
    }

    /// 仅作类型存在性 + 函数签名检查,不真的连服务端。
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
    fn server_event_with_incoming_serializes_round_trip() {
        use super::v1::message_body;
        use super::v1::{server_event, IncomingMsg, MessageBody, ServerEvent, TextBody};

        let evt = ServerEvent {
            wecom_account_id: "wxa1".into(),
            seq: 42,
            body: Some(server_event::Body::Incoming(IncomingMsg {
                conversation_id: "conv-1".into(),
                from_user_id: "peer-1".into(),
                body: Some(MessageBody {
                    kind: Some(message_body::Kind::Text(TextBody { text: "hi".into() })),
                    reply_to: None,
                    mentions: vec![],
                }),
                sent_at_ms: 1_700_000_000_000,
                server_msg_id: "sm-1".into(),
                remote: None,
            })),
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        let back: ServerEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, evt);
    }

    #[test]
    fn server_event_with_system_kicked_serializes_round_trip() {
        use super::v1::{server_event, system_signal, ServerEvent, SystemSignal};
        let evt = ServerEvent {
            wecom_account_id: "wxa1".into(),
            seq: 100,
            body: Some(server_event::Body::System(SystemSignal {
                kind: system_signal::Kind::Kicked as i32,
                detail: "another device".into(),
            })),
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        let back: ServerEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, evt);
    }

    #[test]
    fn server_event_with_recalled_serializes_round_trip() {
        use super::v1::{server_event, MessageRecalled, ServerEvent};

        let evt = ServerEvent {
            wecom_account_id: "wxa1".into(),
            seq: 50,
            body: Some(server_event::Body::Recalled(MessageRecalled {
                conversation_id: "conv-1".into(),
                server_msg_id: "sm-1".into(),
                recalled_at_ms: 1_700_000_000_000,
                by_user_id: "peer-1".into(),
            })),
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        let back: ServerEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, evt);
    }

    #[test]
    fn message_status_change_delivered_serializes_round_trip() {
        use super::v1::{message_status_change, server_event, MessageStatusChange, ServerEvent};

        let evt = ServerEvent {
            wecom_account_id: "wxa1".into(),
            seq: 60,
            body: Some(server_event::Body::StatusChange(MessageStatusChange {
                conversation_id: "conv-1".into(),
                client_msg_id: "client-uuid".into(),
                server_msg_id: "sm-2".into(),
                status: message_status_change::Status::Delivered as i32,
            })),
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        let back: ServerEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, evt);
    }
}
