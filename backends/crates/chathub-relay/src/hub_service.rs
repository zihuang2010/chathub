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
use prost::Message;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
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
        let since = req.into_inner().since_seqs;
        let (tx, rx) = mpsc::channel(32);

        // 1. **REPLAY 必先于 REGISTER**(spec §8,决策 #11)
        for (account, s) in &since {
            if !ctx.accounts.contains(account) {
                continue;
            }
            let rows = self
                .events
                .replay_after(account, *s, 200)
                .await
                .map_err(|e| Status::from(RelayError::from(e)))?;
            for (_seq, payload) in rows {
                let evt = ServerEvent::decode(&payload[..])
                    .map_err(|e| Status::internal(format!("decode: {e}")))?;
                if tx.send(Ok(evt)).await.is_err() {
                    break;
                }
            }
        }

        // 2. register(可能发 KICKED)
        let out = self.router.register(
            StreamTicket {
                user_id: ctx.user_id,
                device_id: ctx.device_id,
                accounts: ctx.accounts,
            },
            tx,
        );
        if out.kicked {
            // 真正多端踢:给 prev 发 KICKED
            for prev in out.prev_senders {
                let kicked_evt = ServerEvent {
                    wecom_account_id: String::new(),
                    seq: 0,
                    body: Some(chathub_proto::v1::server_event::Body::System(
                        chathub_proto::v1::SystemSignal {
                            kind: chathub_proto::v1::system_signal::Kind::Kicked as i32,
                            detail: "multi-device".into(),
                        },
                    )),
                };
                let _ = prev.try_send(Ok(kicked_evt));
                drop(prev);
            }
        } else {
            // 同 device 自重连:静默 drop prev
            for prev in out.prev_senders {
                drop(prev);
            }
        }
        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn send(&self, req: Request<SendRequest>) -> Result<Response<SendResponse>, Status> {
        let ctx = req
            .extensions()
            .get::<UserCtx>()
            .cloned()
            .ok_or_else(|| Status::unauthenticated("missing ctx"))?;
        let r = req.into_inner();
        let body = r
            .body
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("missing body"))?;
        let resp = self
            .downstream
            .send(crate::downstream::SendReq {
                user_id: &ctx.user_id,
                wecom_account_id: &r.wecom_account_id,
                conversation_id: &r.conversation_id,
                client_msg_id: &r.client_msg_id,
                body,
            })
            .await
            .map_err(Status::from)?;

        // 后续 fanout MessageStatusChange{STATUS_SENT}
        let status_evt = ServerEvent {
            wecom_account_id: r.wecom_account_id.clone(),
            seq: 0, // 将由 seqs.next_seq 重写
            body: Some(chathub_proto::v1::server_event::Body::StatusChange(
                chathub_proto::v1::MessageStatusChange {
                    conversation_id: r.conversation_id.clone(),
                    client_msg_id: r.client_msg_id.clone(),
                    server_msg_id: resp.server_msg_id.clone(),
                    status: chathub_proto::v1::message_status_change::Status::Sent as i32,
                },
            )),
        };
        let assigned = self
            .seqs
            .next_seq(&r.wecom_account_id)
            .await
            .map_err(|e| Status::from(RelayError::from(e)))?;
        let mut evt = status_evt;
        evt.seq = assigned;
        let mut buf = Vec::new();
        prost::Message::encode(&evt, &mut buf)
            .map_err(|e| Status::internal(format!("encode: {e}")))?;
        let _ = self
            .events
            .record(&r.wecom_account_id, assigned, buf, now_ms())
            .await;
        let _ = self.router.fanout(&r.wecom_account_id, evt);

        Ok(Response::new(SendResponse {
            server_msg_id: resp.server_msg_id,
            sent_at_ms: resp.sent_at_ms,
        }))
    }

    async fn recall(
        &self,
        req: Request<RecallRequest>,
    ) -> Result<Response<RecallResponse>, Status> {
        let ctx = req
            .extensions()
            .get::<UserCtx>()
            .cloned()
            .ok_or_else(|| Status::unauthenticated("missing ctx"))?;
        let r = req.into_inner();
        let resp = self
            .downstream
            .recall(crate::downstream::RecallReq {
                user_id: &ctx.user_id,
                wecom_account_id: &r.wecom_account_id,
                conversation_id: &r.conversation_id,
                server_msg_id: &r.server_msg_id,
            })
            .await
            .map_err(Status::from)?;
        Ok(Response::new(RecallResponse {
            recalled_at_ms: resp.recalled_at_ms,
        }))
    }

    async fn ack_read(
        &self,
        req: Request<AckReadRequest>,
    ) -> Result<Response<AckReadResponse>, Status> {
        let ctx = req
            .extensions()
            .get::<UserCtx>()
            .cloned()
            .ok_or_else(|| Status::unauthenticated("missing ctx"))?;
        let r = req.into_inner();
        let resp = self
            .downstream
            .ack_read(crate::downstream::AckReadReq {
                user_id: &ctx.user_id,
                wecom_account_id: &r.wecom_account_id,
                conversation_id: &r.conversation_id,
                last_read_server_msg_id: &r.last_read_server_msg_id,
            })
            .await
            .map_err(Status::from)?;
        Ok(Response::new(AckReadResponse {
            acked_at_ms: resp.acked_at_ms,
        }))
    }

    async fn fetch_history(
        &self,
        _req: Request<FetchHistoryRequest>,
    ) -> Result<Response<FetchHistoryResponse>, Status> {
        Err(Status::unimplemented("fetch_history: T20"))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

    async fn spawn_hub() -> (SocketAddr, Arc<Router>, crate::jwt::Signer, EventStore) {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        let signer = crate::jwt::Signer::bootstrap(&storage, None, None, "chathub-relay")
            .await
            .unwrap();
        let router = Arc::new(Router::new());
        let events = EventStore::new(storage.clone());
        let svc = HubSvc {
            router: router.clone(),
            seqs: SeqAllocator::new(storage.clone()),
            events: events.clone(),
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
        (addr, router, signer, events)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_receives_pushed_event() {
        let (addr, router, signer, _events) = spawn_hub().await;
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

    #[tokio::test(flavor = "multi_thread")]
    async fn second_subscribe_different_device_kicks_first() {
        let (addr, _router, signer, _events) = spawn_hub().await;
        let tok1 = signer
            .sign(&signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800))
            .unwrap();
        let tok2 = signer
            .sign(&signer.make_claims("u-1", vec!["wa-1".into()], "dev-B", 1800))
            .unwrap();

        let make_client = |tok: String| {
            let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
            async move {
                let channel = ep.connect().await.unwrap();
                RawHubClient::with_interceptor(channel, move |mut r: tonic::Request<()>| {
                    r.metadata_mut()
                        .insert("chathub-protocol-version", "1".parse().unwrap());
                    r.metadata_mut()
                        .insert("authorization", format!("Bearer {tok}").parse().unwrap());
                    Ok(r)
                })
            }
        };
        let mut c1 = make_client(tok1).await;
        let s1 = c1
            .subscribe(SubscribeRequest {
                since_seqs: Default::default(),
            })
            .await
            .unwrap()
            .into_inner();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        let mut c2 = make_client(tok2).await;
        let _s2 = c2
            .subscribe(SubscribeRequest {
                since_seqs: Default::default(),
            })
            .await
            .unwrap()
            .into_inner();

        let mut s1 = std::pin::pin!(s1);
        let got = tokio::time::timeout(std::time::Duration::from_secs(2), s1.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match got.body {
            Some(chathub_proto::v1::server_event::Body::System(sig)) => {
                assert_eq!(
                    sig.kind,
                    chathub_proto::v1::system_signal::Kind::Kicked as i32
                );
            }
            other => panic!("expected KICKED, got: {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn same_device_reconnect_does_not_emit_kicked() {
        let (addr, _router, signer, _events) = spawn_hub().await;
        let tok = signer
            .sign(&signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800))
            .unwrap();
        let mk = || {
            let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
            let tok = tok.clone();
            async move {
                let channel = ep.connect().await.unwrap();
                RawHubClient::with_interceptor(channel, move |mut r: tonic::Request<()>| {
                    r.metadata_mut()
                        .insert("chathub-protocol-version", "1".parse().unwrap());
                    r.metadata_mut()
                        .insert("authorization", format!("Bearer {tok}").parse().unwrap());
                    Ok(r)
                })
            }
        };
        let mut c1 = mk().await;
        let s1 = c1
            .subscribe(SubscribeRequest {
                since_seqs: Default::default(),
            })
            .await
            .unwrap()
            .into_inner();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let mut c2 = mk().await;
        let _s2 = c2
            .subscribe(SubscribeRequest {
                since_seqs: Default::default(),
            })
            .await
            .unwrap()
            .into_inner();
        // s1 应当 EOF(没有 KICKED 事件)
        let mut s1 = std::pin::pin!(s1);
        // 给一点时间 server 处理 register 并 drop prev sender
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let next = tokio::time::timeout(std::time::Duration::from_millis(500), s1.next()).await;
        // 拿到 None(EOF)即可,不能拿到 KICKED 事件
        match next {
            Ok(None) => {}
            Ok(Some(Ok(evt))) => {
                if let Some(chathub_proto::v1::server_event::Body::System(sig)) = evt.body {
                    assert_ne!(
                        sig.kind,
                        chathub_proto::v1::system_signal::Kind::Kicked as i32
                    );
                }
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_replays_strictly_above_since() {
        let (addr, _router, signer, events) = spawn_hub().await;
        for s in 1..=5_i64 {
            let evt = ServerEvent {
                wecom_account_id: "wa-1".into(),
                seq: s,
                body: Some(chathub_proto::v1::server_event::Body::System(
                    chathub_proto::v1::SystemSignal {
                        kind: chathub_proto::v1::system_signal::Kind::Unspecified as i32,
                        detail: format!("{s}"),
                    },
                )),
            };
            let mut buf = Vec::new();
            prost::Message::encode(&evt, &mut buf).unwrap();
            events.record("wa-1", s, buf, s).await.unwrap();
        }
        let tok = signer
            .sign(&signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800))
            .unwrap();
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let channel = ep.connect().await.unwrap();
        let mut client =
            RawHubClient::with_interceptor(channel, move |mut r: tonic::Request<()>| {
                r.metadata_mut()
                    .insert("chathub-protocol-version", "1".parse().unwrap());
                r.metadata_mut()
                    .insert("authorization", format!("Bearer {tok}").parse().unwrap());
                Ok(r)
            });
        let mut since = std::collections::HashMap::new();
        since.insert("wa-1".to_string(), 2_i64);
        let stream = client
            .subscribe(SubscribeRequest { since_seqs: since })
            .await
            .unwrap()
            .into_inner();
        let mut stream = std::pin::pin!(stream);
        let mut got_seqs = Vec::new();
        for _ in 0..3 {
            let e = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            got_seqs.push(e.seq);
        }
        assert_eq!(got_seqs, vec![3, 4, 5]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn recall_happy() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/recall"))
            .and(header("authorization", "Bearer dn-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "recalled_at_ms": 1234567890i64
            })))
            .mount(&mock)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        let signer = crate::jwt::Signer::bootstrap(&storage, None, None, "chathub-relay")
            .await
            .unwrap();
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new(&mock.uri(), "dn-secret").unwrap());
        let svc = HubSvc {
            router: Arc::new(Router::new()),
            seqs: SeqAllocator::new(storage.clone()),
            events: EventStore::new(storage),
            downstream,
        };

        let claims = signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800);
        let tok = signer.sign(&claims).unwrap();

        let mut req = Request::new(RecallRequest {
            wecom_account_id: "wa-1".to_string(),
            conversation_id: "conv-1".to_string(),
            server_msg_id: "msg-123".to_string(),
        });
        req.metadata_mut()
            .insert("chathub-protocol-version", "1".parse().unwrap());
        req.metadata_mut()
            .insert("authorization", format!("Bearer {tok}").parse().unwrap());
        req.extensions_mut().insert(UserCtx {
            user_id: "u-1".to_string(),
            accounts: vec!["wa-1".to_string()],
            device_id: "dev-A".to_string(),
        });

        let resp = svc.recall(req).await.unwrap();
        assert_eq!(resp.into_inner().recalled_at_ms, 1234567890i64);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ack_read_happy() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/ack_read"))
            .and(header("authorization", "Bearer dn-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "acked_at_ms": 1234567890i64
            })))
            .mount(&mock)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        let signer = crate::jwt::Signer::bootstrap(&storage, None, None, "chathub-relay")
            .await
            .unwrap();
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new(&mock.uri(), "dn-secret").unwrap());
        let svc = HubSvc {
            router: Arc::new(Router::new()),
            seqs: SeqAllocator::new(storage.clone()),
            events: EventStore::new(storage),
            downstream,
        };

        let claims = signer.make_claims("u-1", vec!["wa-1".into()], "dev-A", 1800);
        let tok = signer.sign(&claims).unwrap();
        let _ep = Endpoint::from_shared("http://127.0.0.1:0").unwrap();

        let mut req = Request::new(AckReadRequest {
            wecom_account_id: "wa-1".to_string(),
            conversation_id: "conv-1".to_string(),
            last_read_server_msg_id: "msg-456".to_string(),
        });
        req.metadata_mut()
            .insert("chathub-protocol-version", "1".parse().unwrap());
        req.metadata_mut()
            .insert("authorization", format!("Bearer {tok}").parse().unwrap());
        req.extensions_mut().insert(UserCtx {
            user_id: "u-1".to_string(),
            accounts: vec!["wa-1".to_string()],
            device_id: "dev-A".to_string(),
        });

        let resp = svc.ack_read(req).await.unwrap();
        assert_eq!(resp.into_inner().acked_at_ms, 1234567890i64);
    }
}
