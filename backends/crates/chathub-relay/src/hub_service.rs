//! HubSvc + JwtAuthInterceptor。
//! interceptor 仅挂在 HubServer(spec §10);AuthService 自己不挂。

use crate::error::RelayError;
use crate::jwt::{Claims, Verifier};
use crate::router::{Router, StreamTicket};
use crate::storage::events::EventStore;
use crate::storage::seqs::SeqAllocator;
use chathub_proto::v1::hub_server::Hub;
use chathub_proto::v1::{
    AckReadRequest, AckReadResponse, FetchHistoryRequest, FetchHistoryResponse, RecallRequest,
    RecallResponse, SendRequest, SendResponse, ServerEvent, SubscribeRequest,
};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::metadata::MetadataValue;
use tonic::service::Interceptor;
use tonic::{async_trait, Request, Response, Status};

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

// ─── HubSvc ────────────────────────────────────────────────────────────────

pub struct HubSvc {
    pub router: Arc<Router>,
    pub seqs: SeqAllocator,
    pub events: EventStore,
    pub downstream: Arc<crate::downstream::DownstreamClient>,
}

#[async_trait]
impl Hub for HubSvc {
    type SubscribeStream = ReceiverStream<Result<ServerEvent, Status>>;

    async fn subscribe(
        &self,
        req: Request<SubscribeRequest>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        let ctx = req
            .extensions()
            .get::<UserCtx>()
            .cloned()
            .ok_or_else(|| Status::unauthenticated("missing ctx"))?;
        let _since = req.into_inner().since_seqs; // T15 才用
        let (tx, rx) = mpsc::channel(32);
        let _out = self.router.register(
            StreamTicket {
                user_id: ctx.user_id,
                device_id: ctx.device_id,
                accounts: ctx.accounts,
            },
            tx,
        );
        // T14: _out.prev_senders + kicked 处理
        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn send(&self, _req: Request<SendRequest>) -> Result<Response<SendResponse>, Status> {
        Err(Status::unimplemented("send: T18"))
    }

    async fn recall(
        &self,
        _req: Request<RecallRequest>,
    ) -> Result<Response<RecallResponse>, Status> {
        Err(Status::unimplemented("recall: T19"))
    }

    async fn ack_read(
        &self,
        _req: Request<AckReadRequest>,
    ) -> Result<Response<AckReadResponse>, Status> {
        Err(Status::unimplemented("ack_read: T19"))
    }

    async fn fetch_history(
        &self,
        _req: Request<FetchHistoryRequest>,
    ) -> Result<Response<FetchHistoryResponse>, Status> {
        Err(Status::unimplemented("fetch_history: T20"))
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jwt::Signer;
    use crate::router::Router;
    use crate::storage::events::EventStore;
    use crate::storage::seqs::SeqAllocator;
    use crate::storage::Storage;
    use chathub_proto::v1::hub_client::HubClient as RawHubClient;
    use chathub_proto::v1::hub_server::HubServer;
    use chathub_proto::v1::{server_event, SubscribeRequest, SystemSignal};
    use std::net::SocketAddr;
    use tokio::net::TcpListener;
    use tokio_stream::wrappers::TcpListenerStream;
    use tokio_stream::StreamExt;
    use tonic::transport::{Endpoint, Server};

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

    async fn spawn_hub() -> (SocketAddr, Arc<Router>, crate::jwt::Signer) {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        let signer = crate::jwt::Signer::bootstrap(&storage, None, None, "chathub-relay")
            .await
            .unwrap();
        let router = Arc::new(Router::new());
        let svc = HubSvc {
            router: router.clone(),
            seqs: SeqAllocator::new(storage.clone()),
            events: EventStore::new(storage.clone()),
            downstream: Arc::new(
                crate::downstream::DownstreamClient::new("http://127.0.0.1:9", "x").unwrap(),
            ),
        };
        let ic = JwtAuthInterceptor::new(signer.verifier());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stream = TcpListenerStream::new(listener);
        tokio::spawn(async move {
            let _ = Server::builder()
                .add_service(HubServer::with_interceptor(svc, ic))
                .serve_with_incoming(stream)
                .await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        (addr, router, signer)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_receives_pushed_event() {
        let (addr, router, signer) = spawn_hub().await;
        let claims = signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800);
        let tok = signer.sign(&claims).unwrap();
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let channel = ep.connect().await.unwrap();
        let mut client = RawHubClient::with_interceptor(channel, {
            let tok = tok.clone();
            move |mut r: tonic::Request<()>| -> Result<tonic::Request<()>, Status> {
                r.metadata_mut()
                    .insert("chathub-protocol-version", "1".parse().unwrap());
                r.metadata_mut()
                    .insert("authorization", format!("Bearer {tok}").parse().unwrap());
                Ok(r)
            }
        });
        let stream = client
            .subscribe(SubscribeRequest {
                since_seqs: Default::default(),
            })
            .await
            .unwrap()
            .into_inner();
        // let server-side register settle
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        let evt = ServerEvent {
            wecom_account_id: "wa-1".into(),
            seq: 7,
            body: Some(server_event::Body::System(SystemSignal {
                kind: chathub_proto::v1::system_signal::Kind::Unspecified as i32,
                detail: "hi".into(),
            })),
        };
        router.fanout("wa-1", evt.clone()).unwrap();

        let mut stream = std::pin::pin!(stream);
        let got = stream.next().await.unwrap().unwrap();
        assert_eq!(got.seq, 7);
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
