//! DownstreamClient — reqwest 封装下游 HTTP 合约(spec §9.2)。
//! 共用错误转化:HTTP code → RelayError。

use crate::error::RelayError;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone)]
pub struct DownstreamClient {
    base_url: String,
    secret: String,
    http: Client,
}

#[derive(Serialize)]
pub struct VerifyUserReq<'a> {
    pub username: &'a str,
    pub password: &'a str,
    pub device_id: &'a str,
    pub device_name: &'a str,
}

#[derive(Deserialize, Debug, Clone)]
pub struct VerifyUserResp {
    pub user_id: String,
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: String,
    pub role: String,
    pub tenant_id: String,
    pub wecom_accounts: Vec<WecomAccount>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct WecomAccount {
    pub wecom_account_id: String,
    pub corp_id: String,
    pub agent_id: i64,
    pub display_name: String,
    pub enabled: bool,
}

#[derive(Deserialize, Debug)]
struct ErrPayload {
    code: String,
    #[serde(default)]
    min_version: String,
    #[serde(default)]
    download_url: String,
}

impl DownstreamClient {
    pub fn new(base_url: &str, secret: &str) -> Result<Self, RelayError> {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| RelayError::Http(e.to_string()))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            secret: secret.to_string(),
            http,
        })
    }

    pub async fn verify_user(&self, req: VerifyUserReq<'_>) -> Result<VerifyUserResp, RelayError> {
        let url = format!("{}/v1/verify_user", self.base_url);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.secret)
            .json(&req)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() || e.is_connect() {
                    RelayError::Transient
                } else {
                    RelayError::Http(e.to_string())
                }
            })?;
        translate(resp).await
    }
}

/// 通用响应翻译:200 → 反序列化 T;4xx/5xx → 映射错误。
pub(crate) async fn translate<T: for<'de> Deserialize<'de>>(
    resp: reqwest::Response,
) -> Result<T, RelayError> {
    let status = resp.status();
    if status.is_success() {
        let body = resp
            .json::<T>()
            .await
            .map_err(|e| RelayError::Http(e.to_string()))?;
        return Ok(body);
    }
    // 试着解析 {code, ...}
    let code = status.as_u16();
    let err: Option<ErrPayload> = resp.json().await.ok();
    match (code, err.as_ref().map(|e| e.code.as_str())) {
        (401, _) => Err(RelayError::InvalidCreds),
        (403, _) => Err(RelayError::AccountDisabled),
        (412, _) => {
            let (m, d) = err
                .map(|e| (e.min_version, e.download_url))
                .unwrap_or_default();
            Err(RelayError::UpgradeRequired {
                min_version: m,
                download_url: d,
            })
        }
        (400, _) => Err(RelayError::InvalidArg),
        (c, _) if c >= 500 => Err(RelayError::Transient),
        _ => Err(RelayError::Internal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_user_happy() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .and(header("authorization", "Bearer dn-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id":"u-1","display_name":"D","role":"op","tenant_id":"t",
                "wecom_accounts":[{"wecom_account_id":"wa-1","corp_id":"c","agent_id":1,"display_name":"w","enabled":true}]
            })))
            .mount(&mock)
            .await;

        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let resp = client
            .verify_user(VerifyUserReq {
                username: "u",
                password: "p",
                device_id: "d1",
                device_name: "Mac",
            })
            .await
            .unwrap();
        assert_eq!(resp.user_id, "u-1");
        assert_eq!(resp.wecom_accounts.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_user_401_maps_invalid_creds() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(serde_json::json!({"code":"INVALID_CREDS"})),
            )
            .mount(&mock)
            .await;

        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let err = client
            .verify_user(VerifyUserReq {
                username: "u",
                password: "bad",
                device_id: "d1",
                device_name: "Mac",
            })
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::InvalidCreds));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_user_503_maps_transient() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let err = client
            .verify_user(VerifyUserReq {
                username: "u",
                password: "p",
                device_id: "d",
                device_name: "M",
            })
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::Transient));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_user_412_maps_upgrade_required() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_user"))
            .respond_with(ResponseTemplate::new(412).set_body_json(serde_json::json!({
                "code":"UPGRADE_REQUIRED","min_version":"1.5.0","download_url":"https://x/y"
            })))
            .mount(&mock)
            .await;
        let client = DownstreamClient::new(&mock.uri(), "dn-secret").unwrap();
        let err = client
            .verify_user(VerifyUserReq {
                username: "u",
                password: "p",
                device_id: "d",
                device_name: "M",
            })
            .await
            .unwrap_err();
        match err {
            RelayError::UpgradeRequired { min_version, .. } => assert_eq!(min_version, "1.5.0"),
            other => panic!("wrong: {other:?}"),
        }
    }
}
