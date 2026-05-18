//! RelayError — relay 内部统一错误类型。
//! From<RelayError> for tonic::Status 用静态字符串,不透传下游 message(spec §12.5)。

use chathub_proto::v1::{error_detail, ErrorDetail, UpgradeRequired};
use prost::Message;

#[derive(thiserror::Error, Debug)]
pub enum RelayError {
    #[error("invalid credentials")]
    InvalidCreds,

    #[error("account disabled")]
    AccountDisabled,

    #[error("upgrade required (min={min_version})")]
    UpgradeRequired {
        min_version: String,
        download_url: String,
    },

    #[error("invalid argument")]
    InvalidArg,

    #[error("transient downstream")]
    Transient,

    #[error("internal")]
    Internal,

    /// 下游协议契约不匹配(verify_token / login / 业务接口 收到 400/404/415/422 等)。
    /// 这类错误是"永久"的 —— relay 跟后台对不上接口形态,客户端无脑重试无意义。
    /// 客户端应 Terminate(不 Logout、不 Backoff),提示用户"协议错误,请联系管理员"。
    #[error("downstream protocol mismatch (HTTP {code}): {reason}")]
    ProtocolMismatch { code: u16, reason: String },

    /// 业务后台 envelope `code != 1`(2026-05-17 起统一包络)。
    /// `service_code` / `msg` 由后台决定;relay 不解释语义,直接传 msg 给客户端展示。
    #[error("business error ({service_code}): {msg}")]
    BusinessError { service_code: String, msg: String },

    #[error("storage: {0}")]
    Storage(#[from] crate::storage::StorageError),

    #[error("http: {0}")]
    Http(String),
}

impl From<RelayError> for tonic::Status {
    fn from(e: RelayError) -> Self {
        use tonic::{Code, Status};
        match e {
            RelayError::InvalidCreds => Status::unauthenticated("invalid credentials"),
            RelayError::AccountDisabled => Status::permission_denied("account disabled"),
            RelayError::UpgradeRequired {
                min_version,
                download_url,
            } => {
                let detail = ErrorDetail {
                    body: Some(error_detail::Body::Upgrade(UpgradeRequired {
                        min_client_version: min_version,
                        download_url,
                    })),
                };
                Status::with_details(
                    Code::FailedPrecondition,
                    "upgrade required",
                    detail.encode_to_vec().into(),
                )
            }
            RelayError::InvalidArg => Status::invalid_argument("invalid argument"),
            RelayError::Transient => Status::unavailable("downstream unavailable"),
            // ProtocolMismatch → FailedPrecondition + 无 details(UpgradeRequired 用 details
            // 区分;chathub-net::From<Status> 检测无 details 时归类为 ProtocolMismatch)
            RelayError::ProtocolMismatch { code, reason } => {
                Status::failed_precondition(format!("downstream_protocol_mismatch:{code}:{reason}"))
            }
            // BusinessError → FailedPrecondition + "business_error:" 前缀 + JSON payload。
            // 同 ProtocolMismatch 一样靠 message 前缀消歧:chathub-net::From<Status> 识别后
            // 解析为 AuthError::Business { service_code, msg },前端 UI 直接拿 msg 展示。
            RelayError::BusinessError { service_code, msg } => {
                let payload = serde_json::json!({
                    "serviceCode": service_code,
                    "msg": msg,
                })
                .to_string();
                Status::failed_precondition(format!("business_error:{payload}"))
            }
            RelayError::Internal | RelayError::Http(_) | RelayError::Storage(_) => {
                Status::internal("internal")
            }
        }
    }
}

/// 把 downstream HTTP 状态码统一映射成 RelayError。
/// - 401/403 → InvalidCreds(客户端 Logout)
/// - 400/404/415/422 → ProtocolMismatch(客户端 Terminate)
/// - 5xx → Transient(客户端 Backoff)
/// - 其他 → Internal
pub fn map_downstream_4xx_5xx(code: u16, context: &str) -> RelayError {
    match code {
        401 | 403 => RelayError::InvalidCreds,
        400 | 404 | 415 | 422 => RelayError::ProtocolMismatch {
            code,
            reason: context.to_string(),
        },
        c if c >= 500 => RelayError::Transient,
        _ => RelayError::Internal,
    }
}
