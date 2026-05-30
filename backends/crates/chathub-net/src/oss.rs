//! OSS 直传:聊天附件(图片/文件/语音)发送前的统一上传通道。
//!
//! 流程(契约 3.8):
//! 1. `token_info`:走 forward 通道 GET `oss/tokenInfoByVersion?version=1` 取 `jdd-rh`
//!    bucket 的 STS 临时凭证。
//! 2. `gen_post_path`:GET `oss/genPostPathByVersion?version=1&appName=wechat-business-app
//!    &fileSuf=&fileType=1&businessCode=wecom/chat` 取本次上传的 OSS objectName。
//! 3. `put_object`:用第 1 步 STS 凭证对 PUT 做 OSS V1 签名,直传到第 2 步 objectName。
//!
//! `message/send` 只接收上传成功后的 objectName 作 `filePath`;客户端不自行生成 objectName /
//! 日期目录 / 环境目录,一律以 `genPostPathByVersion` 返回的完整 objectName 为准。

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;

use crate::error::AuthError;
use crate::hub::HubClient;

type HmacSha1 = Hmac<Sha1>;

/// 聊天附件直传的自定义域名(CNAME → `jdd-rh.oss-cn-zhangjiakou.aliyuncs.com`)。
/// 直传 URL 用此域名,但签名 CanonicalizedResource 仍按 `/{bucket}/{objectName}` 计算。
const OSS_UPLOAD_HOST: &str = "filet.jdd51.com";

/// 签名 CanonicalizedResource 用的 bucket 名。`tokenInfoByVersion` 实测返回空 bucket,
/// 而 OSS 在 CNAME 侧按 `filet.jdd51.com` 绑定的真实 bucket(`jdd-rh`)计算签名,
/// 故此处固定用 `jdd-rh`(与 `OSS_UPLOAD_HOST` 是同一组固定配置)。
const OSS_BUCKET: &str = "jdd-rh";

/// `oss/tokenInfoByVersion` 返回的 STS 临时凭证(envelope.data 形态)。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OssStsCredentials {
    /// 固定 `jdd-rh`。
    pub bucket: String,
    /// 形如 `oss-cn-zhangjiakou`,对应 endpoint `oss-cn-zhangjiakou.aliyuncs.com`。
    pub region: String,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub security_token: String,
    /// 凭证过期时间;本实现每次上传现取现用,不缓存,过期字段仅留作排查。
    #[serde(default)]
    pub expiration: String,
}

/// 上传成功后回给前端的结果。前端把 `object_name` 作 `filePath` 传给 `message/send`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedAttachment {
    pub object_name: String,
    pub file_name: String,
    pub file_size: i64,
}

/// 附件上传器:复用 `HubClient` 的 forward 通道取凭证/路径,自带 reqwest 做签名直传。
///
/// `HubClient` 内部是 tonic 自动生成的 client(cheap-clone),直接按值持有即可,
/// 无需再包一层 `Arc`。
#[derive(Clone)]
pub struct OssUploader {
    hub: HubClient,
    http: reqwest::Client,
}

impl OssUploader {
    pub fn new(hub: HubClient) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { hub, http }
    }

    /// 取 STS 临时凭证(`version=1` → `jdd-rh` bucket / `/t` 资源前缀)。
    async fn token_info(&self) -> Result<OssStsCredentials, AuthError> {
        let mut query = HashMap::new();
        query.insert("version".to_string(), "1".to_string());
        let resp = self
            .hub
            .forward_with_query("oss_token_info", Vec::new(), query)
            .await?;
        if resp.http_status != 200 {
            return Err(AuthError::Internal {
                message: format!("oss_token_info returned http {}", resp.http_status),
            });
        }
        serde_json::from_slice::<OssStsCredentials>(&resp.body_json).map_err(|e| {
            AuthError::Internal {
                message: format!("oss_token_info JSON parse: {e}"),
            }
        })
    }

    /// 取 OSS objectName。聊天附件固定 `businessCode=wecom/chat`、`fileType=1`(长期资源)。
    /// `file_suf` 为不带点的后缀,如 `jpg`/`amr`/`pdf`。
    async fn gen_post_path(&self, file_suf: &str) -> Result<String, AuthError> {
        let mut query = HashMap::new();
        query.insert("version".to_string(), "1".to_string());
        query.insert("appName".to_string(), "wechat-business-app".to_string());
        query.insert("fileSuf".to_string(), file_suf.to_string());
        query.insert("fileType".to_string(), "1".to_string());
        query.insert("businessCode".to_string(), "wecom/chat".to_string());
        let resp = self
            .hub
            .forward_with_query("oss_gen_post_path", Vec::new(), query)
            .await?;
        if resp.http_status != 200 {
            return Err(AuthError::Internal {
                message: format!("oss_gen_post_path returned http {}", resp.http_status),
            });
        }
        // envelope.data 即 objectName 字符串(JSON 字符串)。
        serde_json::from_slice::<String>(&resp.body_json).map_err(|e| AuthError::Internal {
            message: format!("oss_gen_post_path JSON parse: {e}"),
        })
    }

    /// 完整流程:取凭证 → 取路径 → 直传 OSS。成功返回 objectName 等元数据。
    pub async fn upload(
        &self,
        bytes: Vec<u8>,
        file_name: String,
        file_suf: String,
        content_type: Option<String>,
    ) -> Result<UploadedAttachment, AuthError> {
        let file_size = bytes.len() as i64;
        tracing::info!(
            file_name = %file_name,
            file_suf = %file_suf,
            content_type = ?content_type,
            file_size,
            "oss upload: start"
        );

        let creds = self.token_info().await.inspect_err(|e| {
            tracing::error!(?e, "oss upload: token_info failed");
        })?;
        tracing::debug!(
            bucket = %creds.bucket,
            region = %creds.region,
            expiration = %creds.expiration,
            "oss upload: got sts credentials"
        );

        let object_name = self.gen_post_path(&file_suf).await.inspect_err(|e| {
            tracing::error!(?e, "oss upload: gen_post_path failed");
        })?;
        tracing::debug!(object_name = %object_name, "oss upload: got object name");

        let content_type = content_type.unwrap_or_else(|| "application/octet-stream".to_string());
        self.put_object(&creds, &object_name, bytes, &content_type)
            .await
            .inspect_err(|e| {
                tracing::error!(?e, %object_name, "oss upload: put_object failed");
            })?;

        tracing::info!(object_name = %object_name, file_size, "oss upload: success");
        Ok(UploadedAttachment {
            object_name,
            file_name,
            file_size,
        })
    }

    /// 用 STS 凭证对 PUT 做 OSS V1(HMAC-SHA1)签名并直传。
    ///
    /// StringToSign = VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders + CanonicalizedResource
    /// 其中 CanonicalizedOSSHeaders 含 `x-oss-security-token`(STS 必带);CanonicalizedResource
    /// 为 `/{bucket}/{objectName}`(virtual-host 风格请求签名仍用此形态)。
    async fn put_object(
        &self,
        creds: &OssStsCredentials,
        object_name: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<(), AuthError> {
        // 直传走 bucket 绑定的自定义域名;签名仍以 /{bucket}/{objectName} 为准(见 canonical_resource)。
        let host = OSS_UPLOAD_HOST;
        let url = format!("https://{host}/{object_name}");

        // RFC1123 GMT 日期(chrono 的 %a/%b 恒英文,符合 OSS 要求)。
        let date = chrono::Utc::now()
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string();

        let canonical_oss_headers = format!("x-oss-security-token:{}\n", creds.security_token);
        let canonical_resource = format!("/{}/{}", OSS_BUCKET, object_name);
        let string_to_sign =
            format!("PUT\n\n{content_type}\n{date}\n{canonical_oss_headers}{canonical_resource}");

        let mut mac =
            HmacSha1::new_from_slice(creds.access_key_secret.as_bytes()).map_err(|e| {
                AuthError::Internal {
                    message: format!("oss sign hmac key: {e}"),
                }
            })?;
        mac.update(string_to_sign.as_bytes());
        let signature =
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        let authorization = format!("OSS {}:{}", creds.access_key_id, signature);

        let resp = self
            .http
            .put(&url)
            .header("Date", &date)
            .header("Content-Type", content_type)
            .header("x-oss-security-token", &creds.security_token)
            .header("Authorization", authorization)
            .body(bytes)
            .send()
            .await
            .map_err(|e| AuthError::Internal {
                message: format!("oss put network: {e}"),
            })?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let body = body.chars().take(500).collect::<String>();
            tracing::error!(
                status = status.as_u16(),
                %host,
                bucket = OSS_BUCKET,
                %object_name,
                %body,
                "oss put: object storage rejected PUT"
            );
            return Err(AuthError::Internal {
                message: format!("oss put http {}: {}", status.as_u16(), body),
            });
        }
        Ok(())
    }
}
