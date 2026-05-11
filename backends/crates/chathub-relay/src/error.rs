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

    #[error("storage: {0}")]
    Storage(#[from] crate::storage::StorageError),

    #[error("jwt: {0}")]
    Jwt(#[from] crate::jwt::JwtError),

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
            RelayError::Internal
            | RelayError::Http(_)
            | RelayError::Storage(_)
            | RelayError::Jwt(_) => Status::internal("internal"),
        }
    }
}
