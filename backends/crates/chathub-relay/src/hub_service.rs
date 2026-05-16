//! HubSvc + ProtocolInterceptor + TokenAuthenticator。
//!
//! 认证模型(Relay 纯隔道):
//!   - ProtocolInterceptor(同步):校 `chathub-protocol-version`,提取 `Bearer <token>`
//!     放进 request extensions。不做 token 校验(那是 async,拦截器是 sync)。
//!   - 各 HubSvc method 开头调 `authenticate(&req).await`:从 extensions 取 token,
//!     调业务后台 verifyToken 拿连接身份 `UserCtx`,带进程内缓存。
//!   - 已建立的 stream 不重验;token 失效靠下次重连时 verifyToken 失败自然拒。

use crate::downstream::{DownstreamClient, VerifyTokenReq};
use crate::error::RelayError;
use crate::router::{Router, StreamTicket};
use crate::storage::events::EventStore;
use crate::storage::seqs::SeqAllocator;
use chathub_proto::v1::hub_server::Hub;
use chathub_proto::v1::{
    AckReadRequest, AckReadResponse, FetchHistoryRequest, FetchHistoryResponse, RecallRequest,
    RecallResponse, SendRequest, SendResponse, ServerEvent, SubscribeRequest,
};
use prost::Message;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::service::Interceptor;
use tonic::{async_trait, Request, Response, Status};

/// 连接身份 —— verifyToken 返回的内容,绑定到一条 gRPC 连接。
#[derive(Clone, Debug)]
pub struct UserCtx {
    pub user_id: String,
    pub accounts: Vec<String>,
    pub device_id: String,
}

/// 拦截器提取的 Bearer token,放进 extensions 供各 method 异步校验。
#[derive(Clone)]
struct BearerToken(String);

// ─── ProtocolInterceptor ───────────────────────────────────────────────────

/// 同步拦截器:校协议版本 + 提取 Bearer token。真正的 token 校验在各 method 异步做。
#[derive(Clone, Default)]
pub struct ProtocolInterceptor;

impl ProtocolInterceptor {
    pub fn new() -> Self {
        Self
    }
}

impl Interceptor for ProtocolInterceptor {
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
        // 2. 提取 Bearer(不校验,只取串)
        let token = {
            let auth = req
                .metadata()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| Status::unauthenticated("missing bearer"))?;
            auth.strip_prefix("Bearer ")
                .ok_or_else(|| Status::unauthenticated("missing bearer"))?
                .to_string()
        };
        req.extensions_mut().insert(BearerToken(token));
        Ok(req)
    }
}

// ─── TokenAuthenticator ────────────────────────────────────────────────────

const MAX_CACHE_ENTRIES: usize = 10_000;
const MAX_CACHE_TTL: Duration = Duration::from_secs(300);

struct CachedCtx {
    ctx: UserCtx,
    expires_at: Instant,
}

/// 调业务后台 verifyToken 把 token 换成 `UserCtx`,带进程内缓存。
///
/// 缓存:key = sha256(token)[:16](不存明文),TTL = min(exp_ms-now, 5min)。
/// 满 10000 条时整体清空(walking skeleton 的简单上限策略)。
/// 不做 single-flight:并发首次 miss 会各发一次 verifyToken,可接受。
pub struct TokenAuthenticator {
    downstream: Arc<DownstreamClient>,
    cache: parking_lot::Mutex<HashMap<String, CachedCtx>>,
}

impl TokenAuthenticator {
    pub fn new(downstream: Arc<DownstreamClient>) -> Self {
        Self {
            downstream,
            cache: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    pub async fn authenticate(&self, token: &str) -> Result<UserCtx, Status> {
        let key = cache_key(token);

        // 1. 命中未过期缓存
        {
            let cache = self.cache.lock();
            if let Some(entry) = cache.get(&key) {
                if entry.expires_at > Instant::now() {
                    return Ok(entry.ctx.clone());
                }
            }
        }

        // 2. miss → verifyToken
        let resp = self
            .downstream
            .verify_token(VerifyTokenReq { token })
            .await
            .map_err(Status::from)?;
        if !resp.active {
            return Err(Status::unauthenticated("token inactive"));
        }
        let ctx = UserCtx {
            user_id: resp.user_id,
            accounts: resp.accounts,
            device_id: resp.device_id,
        };

        // 3. 写缓存
        {
            let mut cache = self.cache.lock();
            if cache.len() >= MAX_CACHE_ENTRIES {
                cache.clear();
            }
            cache.insert(
                key,
                CachedCtx {
                    ctx: ctx.clone(),
                    expires_at: Instant::now() + cache_ttl(resp.exp_ms),
                },
            );
        }
        Ok(ctx)
    }
}

fn cache_key(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(&digest[..8]) // 16 hex chars
}

fn cache_ttl(exp_ms: Option<i64>) -> Duration {
    match exp_ms {
        Some(exp) => {
            let remain = (exp - now_ms()).max(0) as u64;
            Duration::from_millis(remain).min(MAX_CACHE_TTL)
        }
        None => MAX_CACHE_TTL,
    }
}

// ─── HubSvc ────────────────────────────────────────────────────────────────

pub struct HubSvc {
    pub router: Arc<Router>,
    pub seqs: SeqAllocator,
    pub events: EventStore,
    pub downstream: Arc<DownstreamClient>,
    pub auth: Arc<TokenAuthenticator>,
}

impl HubSvc {
    /// 从 extensions 取拦截器放入的 Bearer token,调 verifyToken 拿连接身份。
    async fn authenticate<T>(&self, req: &Request<T>) -> Result<UserCtx, Status> {
        let token = req
            .extensions()
            .get::<BearerToken>()
            .ok_or_else(|| Status::unauthenticated("missing bearer"))?
            .0
            .clone();
        self.auth.authenticate(&token).await
    }
}

#[async_trait]
impl Hub for HubSvc {
    type SubscribeStream = ReceiverStream<Result<ServerEvent, Status>>;

    async fn subscribe(
        &self,
        req: Request<SubscribeRequest>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        let ctx = self.authenticate(&req).await?;
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
        let ctx = self.authenticate(&req).await?;
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
        let ctx = self.authenticate(&req).await?;
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
        let ctx = self.authenticate(&req).await?;
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
        req: Request<FetchHistoryRequest>,
    ) -> Result<Response<FetchHistoryResponse>, Status> {
        let ctx = self.authenticate(&req).await?;
        let r = req.into_inner();
        let resp = self
            .downstream
            .fetch_history(crate::downstream::FetchHistoryReq {
                user_id: &ctx.user_id,
                wecom_account_id: &r.wecom_account_id,
                conversation_id: &r.conversation_id,
                limit: r.limit,
                cursor: &r.cursor,
            })
            .await
            .map_err(Status::from)?;
        Ok(Response::new(FetchHistoryResponse {
            messages: resp.messages,
            next_cursor: resp.next_cursor,
        }))
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
#[allow(clippy::result_large_err)]
mod tests {
    use super::*;
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
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn req_with(meta: &[(&'static str, &str)]) -> Request<()> {
        let mut r = Request::new(());
        for (k, v) in meta {
            r.metadata_mut().insert(*k, v.parse().unwrap());
        }
        r
    }

    /// 在 mock 下游挂一条 verify_token:token=`token` → 返回给定身份。
    async fn mount_verify_token(
        mock: &MockServer,
        token: &str,
        user_id: &str,
        device_id: &str,
        accounts: &[&str],
    ) {
        Mock::given(method("POST"))
            .and(path("/v1/verify_token"))
            .and(body_partial_json(serde_json::json!({ "token": token })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "active": true,
                "user_id": user_id,
                "device_id": device_id,
                "accounts": accounts,
            })))
            .mount(mock)
            .await;
    }

    async fn spawn_hub() -> (SocketAddr, Arc<Router>, MockServer, EventStore) {
        let mock = MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        let router = Arc::new(Router::new());
        let events = EventStore::new(storage.clone());
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new(&mock.uri(), "dn-secret").unwrap());
        let svc = HubSvc {
            router: router.clone(),
            seqs: SeqAllocator::new(storage.clone()),
            events: events.clone(),
            downstream: downstream.clone(),
            auth: Arc::new(TokenAuthenticator::new(downstream)),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stream = TcpListenerStream::new(listener);
        tokio::spawn(async move {
            let _ = Server::builder()
                .add_service(HubServer::with_interceptor(svc, ProtocolInterceptor::new()))
                .serve_with_incoming(stream)
                .await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        (addr, router, mock, events)
    }

    fn hub_client_with_token(
        channel: tonic::transport::Channel,
        token: String,
    ) -> RawHubClient<
        tonic::service::interceptor::InterceptedService<
            tonic::transport::Channel,
            impl FnMut(Request<()>) -> Result<Request<()>, Status>,
        >,
    > {
        RawHubClient::with_interceptor(channel, move |mut r: Request<()>| {
            r.metadata_mut()
                .insert("chathub-protocol-version", "1".parse().unwrap());
            r.metadata_mut()
                .insert("authorization", format!("Bearer {token}").parse().unwrap());
            Ok(r)
        })
    }

    // ── ProtocolInterceptor 单元测试 ──────────────────────────────────────

    #[test]
    fn interceptor_rejects_missing_protocol_version() {
        let mut ic = ProtocolInterceptor::new();
        let r = req_with(&[("authorization", "Bearer x")]);
        let err = ic.call(r).unwrap_err();
        assert_eq!(err.code(), tonic::Code::FailedPrecondition);
    }

    #[test]
    fn interceptor_rejects_missing_bearer() {
        let mut ic = ProtocolInterceptor::new();
        let r = req_with(&[("chathub-protocol-version", "1")]);
        let err = ic.call(r).unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
    }

    #[test]
    fn interceptor_extracts_bearer_into_extensions() {
        let mut ic = ProtocolInterceptor::new();
        let r = req_with(&[
            ("chathub-protocol-version", "1"),
            ("authorization", "Bearer biz-tok-123"),
        ]);
        let out = ic.call(r).unwrap();
        assert_eq!(
            out.extensions().get::<BearerToken>().unwrap().0,
            "biz-tok-123"
        );
    }

    // ── TokenAuthenticator 单元测试 ───────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn authenticator_happy_returns_ctx() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-1", "u-1", "dev-A", &["wa-1", "wa-2"]).await;
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new(&mock.uri(), "dn-secret").unwrap());
        let auth = TokenAuthenticator::new(downstream);
        let ctx = auth.authenticate("tok-1").await.unwrap();
        assert_eq!(ctx.user_id, "u-1");
        assert_eq!(ctx.device_id, "dev-A");
        assert_eq!(ctx.accounts, vec!["wa-1".to_string(), "wa-2".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn authenticator_inactive_token_unauthenticated() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_token"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"active": false})),
            )
            .mount(&mock)
            .await;
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new(&mock.uri(), "dn-secret").unwrap());
        let auth = TokenAuthenticator::new(downstream);
        let err = auth.authenticate("stale").await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn authenticator_caches_result_second_call_skips_downstream() {
        let mock = MockServer::start().await;
        // expect(1):缓存命中后第二次 authenticate 不应再打下游
        Mock::given(method("POST"))
            .and(path("/v1/verify_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "active": true, "user_id": "u-1", "device_id": "dev-A", "accounts": ["wa-1"],
                "exp_ms": 1_900_000_000_000i64
            })))
            .expect(1)
            .mount(&mock)
            .await;
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new(&mock.uri(), "dn-secret").unwrap());
        let auth = TokenAuthenticator::new(downstream);
        let c1 = auth.authenticate("tok-cache").await.unwrap();
        let c2 = auth.authenticate("tok-cache").await.unwrap();
        assert_eq!(c1.user_id, c2.user_id);
        // mock 在 drop 时校验 expect(1)
    }

    // ── HubSvc 端到端测试 ─────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_receives_pushed_event() {
        let (addr, router, mock, _events) = spawn_hub().await;
        mount_verify_token(&mock, "tok-A", "u-1", "dev-A", &["wa-1"]).await;
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let channel = ep.connect().await.unwrap();
        let mut client = hub_client_with_token(channel, "tok-A".into());
        let stream = client
            .subscribe(SubscribeRequest {
                since_seqs: Default::default(),
            })
            .await
            .unwrap()
            .into_inner();
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
    async fn subscribe_rejected_when_token_inactive() {
        let (addr, _router, mock, _events) = spawn_hub().await;
        Mock::given(method("POST"))
            .and(path("/v1/verify_token"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"active": false})),
            )
            .mount(&mock)
            .await;
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let channel = ep.connect().await.unwrap();
        let mut client = hub_client_with_token(channel, "stale".into());
        let err = client
            .subscribe(SubscribeRequest {
                since_seqs: Default::default(),
            })
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn second_subscribe_different_device_kicks_first() {
        let (addr, _router, mock, _events) = spawn_hub().await;
        mount_verify_token(&mock, "tok-A", "u-1", "dev-A", &["wa-1"]).await;
        mount_verify_token(&mock, "tok-B", "u-1", "dev-B", &["wa-1"]).await;

        let mk = |tok: String| {
            let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
            async move {
                let channel = ep.connect().await.unwrap();
                hub_client_with_token(channel, tok)
            }
        };
        let mut c1 = mk("tok-A".into()).await;
        let s1 = c1
            .subscribe(SubscribeRequest {
                since_seqs: Default::default(),
            })
            .await
            .unwrap()
            .into_inner();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        let mut c2 = mk("tok-B".into()).await;
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
        let (addr, _router, mock, _events) = spawn_hub().await;
        mount_verify_token(&mock, "tok-A", "u-1", "dev-A", &["wa-1"]).await;
        let mk = || {
            let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
            async move {
                let channel = ep.connect().await.unwrap();
                hub_client_with_token(channel, "tok-A".into())
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
        let mut s1 = std::pin::pin!(s1);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let next = tokio::time::timeout(std::time::Duration::from_millis(500), s1.next()).await;
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
        let (addr, _router, mock, events) = spawn_hub().await;
        mount_verify_token(&mock, "tok-A", "u-1", "dev-A", &["wa-1"]).await;
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
        let ep = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let channel = ep.connect().await.unwrap();
        let mut client = hub_client_with_token(channel, "tok-A".into());
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
        use wiremock::matchers::header;

        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", "u-1", "dev-A", &["wa-1"]).await;
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
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new(&mock.uri(), "dn-secret").unwrap());
        let svc = HubSvc {
            router: Arc::new(Router::new()),
            seqs: SeqAllocator::new(storage.clone()),
            events: EventStore::new(storage),
            downstream: downstream.clone(),
            auth: Arc::new(TokenAuthenticator::new(downstream)),
        };

        let mut req = Request::new(RecallRequest {
            wecom_account_id: "wa-1".to_string(),
            conversation_id: "conv-1".to_string(),
            server_msg_id: "msg-123".to_string(),
        });
        req.extensions_mut()
            .insert(BearerToken("tok-A".to_string()));

        let resp = svc.recall(req).await.unwrap();
        assert_eq!(resp.into_inner().recalled_at_ms, 1234567890i64);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ack_read_happy() {
        use wiremock::matchers::header;

        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", "u-1", "dev-A", &["wa-1"]).await;
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
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new(&mock.uri(), "dn-secret").unwrap());
        let svc = HubSvc {
            router: Arc::new(Router::new()),
            seqs: SeqAllocator::new(storage.clone()),
            events: EventStore::new(storage),
            downstream: downstream.clone(),
            auth: Arc::new(TokenAuthenticator::new(downstream)),
        };

        let mut req = Request::new(AckReadRequest {
            wecom_account_id: "wa-1".to_string(),
            conversation_id: "conv-1".to_string(),
            last_read_server_msg_id: "msg-456".to_string(),
        });
        req.extensions_mut()
            .insert(BearerToken("tok-A".to_string()));

        let resp = svc.ack_read(req).await.unwrap();
        assert_eq!(resp.into_inner().acked_at_ms, 1234567890i64);
    }
}
