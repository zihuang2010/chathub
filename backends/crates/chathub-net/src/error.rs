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
    fn serializes_to_kebab_case_kind() {
        let err = AuthError::Unauthenticated;
        let json = serde_json::to_string(&err).unwrap();
        assert!(
            json.contains("\"kind\":\"unauthenticated\""),
            "json = {json}"
        );
    }
}
