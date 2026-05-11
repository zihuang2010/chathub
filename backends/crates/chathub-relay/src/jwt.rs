//! JWT Signer / Verifier(Ed25519,jsonwebtoken=9)。
//!
//! 算法决策:Ed25519 替代 Plan 2 spec 的 RS256(密钥 32B vs ~2KB,签快 10×、验快 30%;
//! 客户端 parse_upgrade_required 不校验 alg/kid,wire-compat)。
//!
//! bootstrap 优先级:env RELAY_JWT_PRIVATE_PEM → kv 表 "jwt_priv_pem" → 生成新对入 kv。

use crate::storage::{kv::KvStore, Storage};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Claims {
    pub iss: String,
    pub sub: String,
    pub exp: i64,
    pub iat: i64,
    pub accounts: Vec<String>,
    pub device_id: String,
}

#[derive(thiserror::Error, Debug)]
pub enum JwtError {
    #[error("storage: {0}")]
    Storage(#[from] crate::storage::StorageError),
    #[error("jwt: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),
    #[error("keygen: {0}")]
    KeyGen(String),
    #[error("invalid PEM")]
    InvalidPem,
    #[error("missing kid")]
    MissingKid,
}

const KV_PRIV_PEM: &str = "jwt_priv_pem";
const KV_KID: &str = "jwt_kid";

#[derive(Clone)]
pub struct Signer {
    inner: Arc<Inner>,
}

struct Inner {
    encoding: EncodingKey,
    decoding: DecodingKey,
    kid: String,
    issuer: String,
}

#[derive(Clone)]
pub struct Verifier {
    inner: Arc<Inner>,
}

impl Signer {
    /// bootstrap:env PEM > kv 表 > 生成。
    pub async fn bootstrap(
        storage: &Storage,
        env_pem: Option<&str>,
        env_kid: Option<&str>,
        issuer: &str,
    ) -> Result<Self, JwtError> {
        let kv = KvStore::new(storage.clone());
        let (pem, kid) = match env_pem {
            Some(p) => (p.to_string(), env_kid.unwrap_or("env-key").to_string()),
            None => {
                if let (Some(p), Some(k)) = (kv.get(KV_PRIV_PEM).await?, kv.get(KV_KID).await?) {
                    (
                        String::from_utf8(p).map_err(|_| JwtError::InvalidPem)?,
                        String::from_utf8(k).map_err(|_| JwtError::InvalidPem)?,
                    )
                } else {
                    let (pem, kid) = generate_ed25519_pem()?;
                    kv.put(KV_PRIV_PEM, pem.as_bytes().to_vec()).await?;
                    kv.put(KV_KID, kid.as_bytes().to_vec()).await?;
                    (pem, kid)
                }
            }
        };

        let encoding = EncodingKey::from_ed_pem(pem.as_bytes())?;
        let public_pem = derive_public_pem_from_pkcs8_pem(&pem)?;
        let decoding = DecodingKey::from_ed_pem(public_pem.as_bytes())?;

        Ok(Self {
            inner: Arc::new(Inner {
                encoding,
                decoding,
                kid,
                issuer: issuer.to_string(),
            }),
        })
    }

    pub fn verifier(&self) -> Verifier {
        Verifier {
            inner: self.inner.clone(),
        }
    }

    pub fn issuer(&self) -> &str {
        &self.inner.issuer
    }

    pub fn sign(&self, claims: &Claims) -> Result<String, JwtError> {
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(self.inner.kid.clone());
        Ok(jsonwebtoken::encode(&header, claims, &self.inner.encoding)?)
    }

    /// 工具:用当前 signer 配置构造 Claims(now/exp 自动)
    pub fn make_claims(
        &self,
        user_id: &str,
        accounts: Vec<String>,
        device_id: &str,
        ttl_secs: i64,
    ) -> Claims {
        let now = unix_now();
        Claims {
            iss: self.inner.issuer.clone(),
            sub: user_id.to_string(),
            exp: now + ttl_secs,
            iat: now,
            accounts,
            device_id: device_id.to_string(),
        }
    }
}

impl Verifier {
    pub fn verify(&self, token: &str) -> Result<Claims, JwtError> {
        let mut v = Validation::new(Algorithm::EdDSA);
        v.leeway = 0;
        v.set_issuer(&[&self.inner.issuer]);
        let data = jsonwebtoken::decode::<Claims>(token, &self.inner.decoding, &v)?;
        Ok(data.claims)
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 生成 Ed25519 PKCS#8 私钥 PEM(jsonwebtoken 9 EncodingKey 接受此格式)+ kid。
fn generate_ed25519_pem() -> Result<(String, String), JwtError> {
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 =
        Ed25519KeyPair::generate_pkcs8(&rng).map_err(|e| JwtError::KeyGen(e.to_string()))?;
    let pem = pkcs8_to_pem(pkcs8.as_ref());
    let kid = format!("k-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    Ok((pem, kid))
}

/// 把 PKCS#8 DER 包成 PEM(BEGIN PRIVATE KEY)。
fn pkcs8_to_pem(der: &[u8]) -> String {
    der_to_pem(der, "PRIVATE KEY")
}

/// 从 PKCS#8 私钥 PEM 推 SubjectPublicKeyInfo 公钥 PEM。
fn derive_public_pem_from_pkcs8_pem(priv_pem: &str) -> Result<String, JwtError> {
    let der = decode_pem_body(priv_pem).ok_or(JwtError::InvalidPem)?;
    let kp = Ed25519KeyPair::from_pkcs8(&der).map_err(|e| JwtError::KeyGen(e.to_string()))?;
    let pub_bytes = kp.public_key().as_ref().to_vec();
    // 包成 SPKI:30 2a 30 05 06 03 2b 65 70 03 21 00 || pub
    let mut spki = Vec::with_capacity(44);
    spki.extend_from_slice(&[
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ]);
    spki.extend_from_slice(&pub_bytes);
    Ok(der_to_pem(&spki, "PUBLIC KEY"))
}

/// 通用 DER → PEM:base64 编码 + 64-char 行包 + BEGIN/END header。
fn der_to_pem(der: &[u8], label: &str) -> String {
    let body = BASE64.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in body.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

fn decode_pem_body(pem: &str) -> Option<Vec<u8>> {
    let mut body = String::new();
    for line in pem.lines() {
        if line.starts_with("-----") {
            continue;
        }
        body.push_str(line.trim());
    }
    BASE64.decode(body.as_bytes()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_signer() -> Signer {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        Signer::bootstrap(&storage, None, None, "chathub-relay")
            .await
            .expect("bootstrap")
    }

    #[tokio::test]
    async fn sign_then_verify_round_trip() {
        let signer = fresh_signer().await;
        let claims = signer.make_claims("u1", vec!["wa-1".into()], "dev-1", 1800);
        let tok = signer.sign(&claims).unwrap();
        let got = signer.verifier().verify(&tok).unwrap();
        assert_eq!(got, claims);
    }

    #[tokio::test]
    async fn tampered_token_fails_verify() {
        let signer = fresh_signer().await;
        let claims = signer.make_claims("u1", vec![], "dev-1", 1800);
        let mut tok = signer.sign(&claims).unwrap();
        // 翻转最后一个 base64 字符(签名段)
        let last = tok.pop().unwrap();
        tok.push(if last == 'A' { 'B' } else { 'A' });
        assert!(signer.verifier().verify(&tok).is_err());
    }

    #[tokio::test]
    async fn expired_token_fails_verify() {
        let signer = fresh_signer().await;
        let mut claims = signer.make_claims("u1", vec![], "dev-1", 0);
        claims.exp = unix_now() - 10; // 已过期 10 秒
        claims.iat = claims.exp - 10;
        let tok = signer.sign(&claims).unwrap();
        let err = signer.verifier().verify(&tok).unwrap_err();
        match err {
            JwtError::Jwt(_) => {}
            other => panic!("wrong: {other:?}"),
        }
    }

    #[tokio::test]
    async fn wrong_issuer_fails_verify() {
        let signer = fresh_signer().await;
        let mut claims = signer.make_claims("u1", vec![], "dev-1", 1800);
        claims.iss = "evil".into();
        let tok = signer.sign(&claims).unwrap();
        assert!(signer.verifier().verify(&tok).is_err());
    }

    #[tokio::test]
    async fn bootstrap_persists_key_across_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage1 = Storage::open(&db).await.unwrap();
        let s1 = Signer::bootstrap(&storage1, None, None, "iss")
            .await
            .unwrap();
        let claims = s1.make_claims("u1", vec![], "dev-1", 1800);
        let tok = s1.sign(&claims).unwrap();
        drop(s1);
        drop(storage1);

        // 重新打开同 DB
        let storage2 = Storage::open(&db).await.unwrap();
        let s2 = Signer::bootstrap(&storage2, None, None, "iss")
            .await
            .unwrap();
        let got = s2.verifier().verify(&tok).unwrap();
        assert_eq!(got, claims);
    }
}
