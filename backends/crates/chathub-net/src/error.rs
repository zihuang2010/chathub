//! AuthError:chathub-net 的统一错误类型。
//! 翻译自 tonic::Status,序列化后跨 Tauri 边界给前端。

use chathub_proto::v1::{error_detail, ErrorDetail};
use prost::Message;

#[derive(thiserror::Error, Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AuthError {
    #[error("invalid credentials")]
    Unauthenticated,

    #[error("upgrade required (min={min_version})")]
    UpgradeRequired {
        min_version: String,
        download_url: String,
    },

    #[error("network error: {message}")]
    Network { message: String },

    #[error("storage error: {message}")]
    Storage { message: String },

    #[error("internal: {message}")]
    Internal { message: String },

    #[error("account disabled: {message}")]
    AccountDisabled { message: String },

    /// 下游协议契约不匹配(relay → 业务后台某接口收到 400/404/415 等永久错)。
    /// 客户端应 **Terminate**(不 Logout、不 Backoff),提示"协议错误,请联系管理员"。
    #[error("downstream protocol mismatch: {detail}")]
    ProtocolMismatch { detail: String },

    /// 业务后台 envelope `code != 1`(2026-05-17 统一包络后)。
    /// `service_code` / `msg` 由后台决定;UI 直接展示 `msg`。
    /// 客户端不重试不退出登录 —— token 没问题,只是业务侧拒绝本次操作。
    #[error("business error ({service_code}): {msg}")]
    Business { service_code: String, msg: String },
}

impl From<tonic::Status> for AuthError {
    fn from(s: tonic::Status) -> Self {
        use tonic::Code::*;
        // 优先解析 details 里的 ErrorDetail.UpgradeRequired
        if matches!(s.code(), FailedPrecondition) {
            if let Some(upgrade) = parse_upgrade_required(&s) {
                return upgrade;
            }
        }
        match s.code() {
            Unauthenticated => AuthError::Unauthenticated,
            Unavailable | DeadlineExceeded => AuthError::Network {
                message: s.message().to_string(),
            },
            PermissionDenied => AuthError::AccountDisabled {
                message: s.message().to_string(),
            },
            // FailedPrecondition + 无 ErrorDetail details → relay 标记的"协议契约不匹配"
            // (relay 通过 "downstream_protocol_mismatch:" 前缀串达,客户端 Terminate 不重试)
            FailedPrecondition if s.message().starts_with("downstream_protocol_mismatch:") => {
                AuthError::ProtocolMismatch {
                    detail: s.message().to_string(),
                }
            }
            // FailedPrecondition + "business_error:" 前缀 → 业务包络 code != 1
            // (relay 把 {serviceCode, msg} 用 JSON 串达;失败回退保留原 message 当 msg)
            FailedPrecondition if s.message().starts_with("business_error:") => {
                parse_business_error(s.message())
            }
            FailedPrecondition => AuthError::Internal {
                message: format!("precondition: {}", s.message()),
            },
            _ => AuthError::Internal {
                message: s.message().to_string(),
            },
        }
    }
}

impl From<chathub_state::StateError> for AuthError {
    fn from(e: chathub_state::StateError) -> Self {
        AuthError::Storage {
            message: e.to_string(),
        }
    }
}

impl From<tonic::transport::Error> for AuthError {
    fn from(e: tonic::transport::Error) -> Self {
        AuthError::Network {
            message: e.to_string(),
        }
    }
}

fn parse_business_error(message: &str) -> AuthError {
    // 形态:`business_error:{"serviceCode":"...","msg":"..."}`
    let payload = message.trim_start_matches("business_error:");
    #[derive(serde::Deserialize)]
    struct B {
        #[serde(default, rename = "serviceCode")]
        service_code: String,
        #[serde(default)]
        msg: String,
    }
    match serde_json::from_str::<B>(payload) {
        Ok(b) => AuthError::Business {
            service_code: b.service_code,
            msg: b.msg,
        },
        // JSON 解析失败 → 把整个 payload 当 msg(防呆,不至于丢业务错信息)
        Err(_) => AuthError::Business {
            service_code: String::new(),
            msg: payload.to_string(),
        },
    }
}

fn parse_upgrade_required(s: &tonic::Status) -> Option<AuthError> {
    let details = s.details();
    if details.is_empty() {
        return None;
    }
    // gRPC 的 details 是 protobuf-encoded google.rpc.Status,Plan 2 阶段我们简化为
    // "details 直接编码 ErrorDetail",由 stub-relay 与未来 Relay 共同遵守。
    let detail = ErrorDetail::decode(details).ok()?;
    match detail.body? {
        error_detail::Body::Upgrade(u) => Some(AuthError::UpgradeRequired {
            min_version: u.min_client_version,
            download_url: u.download_url,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::{Code, Status};

    #[test]
    fn unauthenticated_translates() {
        let err: AuthError = Status::unauthenticated("bad creds").into();
        assert!(matches!(err, AuthError::Unauthenticated));
    }

    #[test]
    fn permission_denied_translates_to_account_disabled() {
        let err: AuthError = Status::permission_denied("forbidden").into();
        match err {
            AuthError::AccountDisabled { message } => assert_eq!(message, "forbidden"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn unavailable_translates_to_network() {
        let err: AuthError = Status::unavailable("relay down").into();
        match err {
            AuthError::Network { message } => assert!(message.contains("relay down")),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn deadline_exceeded_translates_to_network() {
        let err: AuthError = Status::deadline_exceeded("timeout").into();
        assert!(matches!(err, AuthError::Network { .. }));
    }

    #[test]
    fn upgrade_required_with_details_parses() {
        let detail = ErrorDetail {
            body: Some(error_detail::Body::Upgrade(
                chathub_proto::v1::UpgradeRequired {
                    min_client_version: "1.5.0".into(),
                    download_url: "https://example.com/dl".into(),
                },
            )),
        };
        let bytes = detail.encode_to_vec();
        let status = Status::with_details(Code::FailedPrecondition, "upgrade", bytes.into());
        let err: AuthError = status.into();
        match err {
            AuthError::UpgradeRequired {
                min_version,
                download_url,
            } => {
                assert_eq!(min_version, "1.5.0");
                assert_eq!(download_url, "https://example.com/dl");
            }
            other => panic!("wrong: {other:?}"),
        }
    }

    #[test]
    fn internal_fallback() {
        let err: AuthError = Status::internal("boom").into();
        match err {
            AuthError::Internal { message } => assert!(message.contains("boom")),
            other => panic!("wrong: {other:?}"),
        }
    }

    #[test]
    fn failed_precondition_with_protocol_prefix_maps_to_protocol_mismatch() {
        // relay 用 "downstream_protocol_mismatch:" 前缀串达,客户端识别
        let status = Status::failed_precondition(
            "downstream_protocol_mismatch:415:verify_token returned non-2xx",
        );
        let err: AuthError = status.into();
        match err {
            AuthError::ProtocolMismatch { detail } => {
                assert!(detail.contains("415"));
                assert!(detail.contains("verify_token"));
            }
            other => panic!("expected ProtocolMismatch, got {other:?}"),
        }
    }

    #[test]
    fn failed_precondition_without_special_prefix_falls_back_to_internal() {
        // 没 protocol 前缀也没 upgrade details → 退化为 Internal(保留旧行为)
        let status = Status::failed_precondition("some other precondition");
        let err: AuthError = status.into();
        assert!(matches!(err, AuthError::Internal { .. }));
    }

    #[test]
    fn serializes_to_kebab_case_kind() {
        let err = AuthError::Unauthenticated;
        let json = serde_json::to_string(&err).unwrap();
        assert!(
            json.contains("\"kind\":\"unauthenticated\""),
            "json = {json}"
        );
    }

    #[test]
    fn business_error_prefix_round_trips_service_code_and_msg() {
        // relay 用 `business_error:{"serviceCode":"...","msg":"..."}` 串达
        let msg = serde_json::json!({
            "serviceCode": "wecom.balance.insufficient",
            "msg": "余额不足"
        })
        .to_string();
        let status = Status::failed_precondition(format!("business_error:{msg}"));
        let err: AuthError = status.into();
        match err {
            AuthError::Business { service_code, msg } => {
                assert_eq!(service_code, "wecom.balance.insufficient");
                assert_eq!(msg, "余额不足");
            }
            other => panic!("expected Business, got {other:?}"),
        }
    }

    #[test]
    fn business_error_with_garbage_payload_falls_back_to_msg() {
        // 容错:relay 串达失败 → 整个 payload 当 msg,至少不丢业务错信息
        let status = Status::failed_precondition("business_error:not-valid-json");
        let err: AuthError = status.into();
        match err {
            AuthError::Business { service_code, msg } => {
                assert!(service_code.is_empty());
                assert_eq!(msg, "not-valid-json");
            }
            other => panic!("expected Business, got {other:?}"),
        }
    }
}
