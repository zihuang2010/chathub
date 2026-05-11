//! HubSvc + JwtAuthInterceptor。
//! interceptor 仅挂在 HubServer(spec §10);AuthService 自己不挂。

use crate::error::RelayError;
use crate::jwt::{Claims, Verifier};
use tonic::metadata::MetadataValue;
use tonic::service::Interceptor;
use tonic::{Request, Status};

#[derive(Clone, Debug)]
pub struct UserCtx {
    pub user_id: String,
    pub accounts: Vec<String>,
    pub device_id: String,
}

#[derive(Clone)]
pub struct JwtAuthInterceptor {
    verifier: Verifier,
}

impl JwtAuthInterceptor {
    pub fn new(verifier: Verifier) -> Self {
        Self { verifier }
    }
}

impl Interceptor for JwtAuthInterceptor {
    fn call(&mut self, mut req: Request<()>) -> Result<Request<()>, Status> {
        // 1. 校协议版本
        let ver = req
            .metadata()
            .get("chathub-protocol-version")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if ver != "1" {
            return Err(Status::from(RelayError::UpgradeRequired {
                min_version: "1.0.0".into(),
                download_url: "".into(),
            }));
        }
        // 2. 校 Bearer
        let auth = req
            .metadata()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| Status::unauthenticated("missing bearer"))?;
        let token = auth
            .strip_prefix("Bearer ")
            .ok_or_else(|| Status::unauthenticated("missing bearer"))?;
        let claims: Claims = self
            .verifier
            .verify(token)
            .map_err(|_| Status::unauthenticated("invalid token"))?;
        req.extensions_mut().insert(UserCtx {
            user_id: claims.sub,
            accounts: claims.accounts,
            device_id: claims.device_id,
        });
        let _ = MetadataValue::try_from("ok"); // suppress unused
        Ok(req)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jwt::Signer;
    use crate::storage::Storage;

    async fn fresh_verifier() -> (Signer, Verifier) {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        let signer = Signer::bootstrap(&storage, None, None, "chathub-relay")
            .await
            .unwrap();
        let v = signer.verifier();
        (signer, v)
    }

    fn req_with(meta: &[(&'static str, &str)]) -> Request<()> {
        let mut r = Request::new(());
        for (k, v) in meta {
            r.metadata_mut().insert(*k, v.parse().unwrap());
        }
        r
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_missing_protocol_version() {
        let (_s, v) = fresh_verifier().await;
        let mut ic = JwtAuthInterceptor::new(v);
        let r = req_with(&[("authorization", "Bearer x")]);
        let err = ic.call(r).unwrap_err();
        assert_eq!(err.code(), tonic::Code::FailedPrecondition);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_missing_bearer() {
        let (_s, v) = fresh_verifier().await;
        let mut ic = JwtAuthInterceptor::new(v);
        let r = req_with(&[("chathub-protocol-version", "1")]);
        let err = ic.call(r).unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_bad_signature() {
        let (_s, v) = fresh_verifier().await;
        let mut ic = JwtAuthInterceptor::new(v);
        let r = req_with(&[
            ("chathub-protocol-version", "1"),
            ("authorization", "Bearer not-a-jwt"),
        ]);
        let err = ic.call(r).unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn accepts_valid_and_injects_ctx() {
        let (signer, v) = fresh_verifier().await;
        let mut ic = JwtAuthInterceptor::new(v);
        let claims = signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800);
        let tok = signer.sign(&claims).unwrap();
        let r = req_with(&[
            ("chathub-protocol-version", "1"),
            ("authorization", &format!("Bearer {tok}")),
        ]);
        let out = ic.call(r).unwrap();
        let ctx = out.extensions().get::<UserCtx>().unwrap();
        assert_eq!(ctx.user_id, "u-1");
        assert_eq!(ctx.device_id, "dev-A");
        assert_eq!(ctx.accounts, vec!["wa-1".to_string()]);
    }
}
