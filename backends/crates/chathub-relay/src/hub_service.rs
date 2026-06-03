//! HubSvc + ProtocolInterceptor + TokenAuthenticator(Plan 7 — 已清掉所有 legacy)。
//!
//! 认证模型(Relay 纯隔道):
//!   - ProtocolInterceptor(同步):校 `chathub-protocol-version`,提取 `Bearer <token>`
//!     放进 request extensions。不做 token 校验(那是 async,拦截器是 sync)。
//!   - 各 HubSvc method 开头调 `authenticate(&req).await`:从 extensions 取 token,
//!     调业务后台 verifyToken 拿连接身份 `UserCtx`,带进程内缓存 + singleflight + RAII guard。
//!   - 已建立的 stream 不重验;token 失效靠下次重连时 verifyToken 失败自然拒。
//!
//! Hub RPC 只剩三件套:
//!   - Subscribe:employee-scope 长连接,首帧 SubscribeAck + 实时 PushBatchOut + 控制 SystemSignal
//!   - Ack:per-employee 已处理 notify_seq 水位(仅 relay 内部观测)
//!   - Forward:业务 RPC 单一透传(REST 隧道语义,4xx 通过 http_status 返回,不映射 gRPC error)

use crate::config::DownstreamRoutes;
use crate::downstream::DownstreamClient;
use crate::error::RelayError;
use crate::router::Router;
use crate::storage::events::{EventLog, EventRow};
use chathub_proto::v1::hub_server::Hub;
use chathub_proto::v1::{
    AckRequest, AckResponse, ForwardRequest, ForwardResponse, ServerEvent, SubscribeRequest,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, OnceCell};
use tokio_stream::wrappers::ReceiverStream;
use tonic::service::Interceptor;
use tonic::{async_trait, Request, Response, Status};

/// 连接身份 —— verifyToken 返回的内容,绑定到一条 gRPC 连接。
#[derive(Clone, Debug)]
pub struct UserCtx {
    pub user_id: String,
    pub accounts: Vec<String>,
    pub device_id: String,
    /// 员工数值 ID。relay 用作 router 索引、ack 水位 key、Forward X-Relay-Employee-Id header。
    /// 老 mock / 业务后台未升级时 verify_token 不返回该字段 → 默认 0 → relay 拒绝所有 v2 RPC。
    pub employee_id: i64,
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
//
// F8 极致性能 + 安全(2026-05-16):
//   - cache:`moka::future::Cache` 替代 `Mutex<HashMap>` —— 并发安全 + LRU + TTL 内置,
//     单点 mutex 不再是 5000 conn × N RPC/s 的串行化瓶颈。
//   - inflight singleflight:仍保留 `DashMap<key, Arc<OnceCell>>` + RAII guard,但 DashMap
//     无中心 mutex,leader 选举与读 cache 同等无锁(竞争分摊到 64 shard)。
//   - 缓存满时 moka 自动按 LRU 淘汰 → 避免老实现 `cache.clear()` 引发的 thundering-herd。
//   - cache key 保留 SHA-256(防 token 明文驻留内存,即便短时也少一份风险)。

/// `TokenAuthenticator::new` 不指定容量时的默认上限。生产由 `Config::auth_cache_max_entries`
/// 通过 env 注入,该常量仅作 `new()` 测试 / 老 caller 的兜底。
const DEFAULT_CACHE_ENTRIES: u64 = 10_000;
const MAX_CACHE_TTL: Duration = Duration::from_secs(300);

/// OnceCell 里存的 — UserCtx + cache TTL(leader 算一次,follower 共享)。
type InflightResult = Result<(UserCtx, Duration), Status>;

/// RAII guard:leader 必持有。任何方式离开 authenticate 作用域(正常返回 / panic 展开)
/// 都会触发 Drop 摘除 inflight 条目,防止 leader future panic 后死锁。
struct InflightGuard<'a> {
    inflight: &'a dashmap::DashMap<String, Arc<OnceCell<InflightResult>>>,
    key: String,
}
impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        self.inflight.remove(&self.key);
    }
}

/// 调业务后台 verifyToken 把 token 换成 `UserCtx`,带进程内缓存 + singleflight。
pub struct TokenAuthenticator {
    downstream: Arc<DownstreamClient>,
    /// moka 提供并发安全 + 容量 LRU + per-entry TTL,免锁竞争。
    cache: moka::future::Cache<String, UserCtx>,
    /// 同 token 并发 miss 时 dedupe 到一个 verify_token 调用,避免 stampede。
    inflight: dashmap::DashMap<String, Arc<OnceCell<InflightResult>>>,
    /// employee_id → 该员工近期 cache key,供 `invalidate_employee` 反查后逐 key 失效。
    /// relay 无法从 employee_id 反查 token,故维护此小索引;每员工上限 16,
    /// 仅在写缓存的冷路径维护,不碰 authenticate 命中热路径。
    /// 条目随 invalidate_employee 移除;企微客服员工数有界,内存可控。
    emp_keys: dashmap::DashMap<i64, Vec<String>>,
}

impl TokenAuthenticator {
    /// 默认容量构造 — 测试用 / 老 caller 兜底。生产用 `with_capacity`。
    pub fn new(downstream: Arc<DownstreamClient>) -> Self {
        Self::with_capacity(downstream, DEFAULT_CACHE_ENTRIES)
    }

    /// 由 `Config::auth_cache_max_entries` 注入容量。
    pub fn with_capacity(downstream: Arc<DownstreamClient>, max_entries: u64) -> Self {
        Self {
            downstream,
            cache: moka::future::Cache::builder()
                .max_capacity(max_entries)
                .time_to_live(MAX_CACHE_TTL)
                .build(),
            inflight: dashmap::DashMap::new(),
            emp_keys: dashmap::DashMap::new(),
        }
    }

    pub async fn authenticate(&self, token: &str) -> Result<UserCtx, Status> {
        let key = cache_key(token);

        // 1. 命中未过期缓存(moka 内部并发安全,read-only 无锁)
        if let Some(ctx) = self.cache.get(&key).await {
            return Ok(ctx);
        }

        // 2. Singleflight:DashMap entry API → claim or join;leader 持 guard 自动清理
        let (cell, leader_guard) = {
            use dashmap::mapref::entry::Entry;
            match self.inflight.entry(key.clone()) {
                Entry::Occupied(o) => (o.get().clone(), None),
                Entry::Vacant(v) => {
                    let cell = Arc::new(OnceCell::new());
                    v.insert(cell.clone());
                    let guard = InflightGuard {
                        inflight: &self.inflight,
                        key: key.clone(),
                    };
                    (cell, Some(guard))
                }
            }
        };

        // 3. 调 verify_token(只有 leader 的 future 会被 OnceCell 真正 poll)
        // 新合约返 {allowed, rejectCode, rejectMessage, employeeId, ...};allowed==false 在
        // downstream 层即以 BusinessError 拒。employeeId 缺失 / 0 这里不拒,落给
        // Subscribe/Ack/Forward 层以 FailedPrecondition 返回更友好的提示(见 hub_service:324/445/478)。
        // device_id 由 Subscribe 自带,UserCtx 这里留空。
        let downstream = self.downstream.clone();
        let token_owned = token.to_string();
        let result = cell
            .get_or_init(move || async move {
                let resp = downstream
                    .verify_token(&token_owned)
                    .await
                    .map_err(Status::from)?;
                let ctx = UserCtx {
                    user_id: resp.employee_id.to_string(),
                    accounts: Vec::new(),
                    device_id: String::new(),
                    employee_id: resp.employee_id,
                };
                Ok((ctx, MAX_CACHE_TTL))
            })
            .await
            .clone();

        // 4. leader 写缓存(inflight 摘除靠 leader_guard 自动 Drop)
        // moka per-entry TTL:用 builder 的全局 TTL 上限即可,
        // 短 TTL token 仍能用全局 TTL 包,过期由 moka 自动剔除。
        if leader_guard.is_some() {
            if let Ok((ctx, _ttl)) = &result {
                self.record_employee_key(ctx.employee_id, key.clone());
                self.cache.insert(key.clone(), ctx.clone()).await;
            }
        }

        result.map(|(ctx, _ttl)| ctx)
    }

    /// 登录成功后由 AuthSvc 调用 —— 把刚 mint 出来的 token + 已知 UserCtx 写进 cache,
    /// 让紧接着的 Subscribe 直接命中,避开多余的 verify_token 一跳。
    ///
    /// 业务端"自动续期"模型下,verify_token 只在 cache miss(客户端重启 / relay 重启
    /// / 5min TTL 过期)时才调,真正"登录刚结束就 Subscribe"那一次完全跳过。
    pub async fn prepopulate(&self, token: &str, ctx: UserCtx) {
        let key = cache_key(token);
        self.record_employee_key(ctx.employee_id, key.clone());
        self.cache.insert(key, ctx).await;
    }

    /// 登出时按 token 精确失效 —— 否则旧 token 在 5min TTL 内仍能命中缓存 Subscribe/Ack。
    pub async fn invalidate(&self, token: &str) {
        self.cache.invalidate(&cache_key(token)).await;
    }

    /// FORCE_CLOSE(独占登录被踢)时失效该 employee 的所有缓存 token,含被踢的旧 token。
    /// 逐 key 调 `cache.invalidate`(确定性即时),不用 moka 的 `invalidate_entries_if` —
    /// 后者按内部量化时间戳惰性失效,登录与踢人间隔很短时不生效,不适合安全失效。
    pub async fn invalidate_employee(&self, employee_id: i64) {
        if let Some((_, keys)) = self.emp_keys.remove(&employee_id) {
            for k in keys {
                self.cache.invalidate(&k).await;
            }
        }
    }

    /// 记录 employee 当前 token 的 cache key(去重 + 每员工上限),供 invalidate_employee 反查。
    /// 仅在写缓存(login 预填 / verify 回填)的冷路径调用,不碰 authenticate 命中热路径。
    fn record_employee_key(&self, employee_id: i64, key: String) {
        const MAX_KEYS_PER_EMPLOYEE: usize = 16;
        let mut entry = self.emp_keys.entry(employee_id).or_default();
        let keys = entry.value_mut();
        if !keys.contains(&key) {
            keys.push(key);
            if keys.len() > MAX_KEYS_PER_EMPLOYEE {
                keys.remove(0);
            }
        }
    }

    /// 测试辅助:强制跑完 moka 惰性失效后,判断 token 是否仍在缓存。跨模块测试(push)用。
    #[cfg(test)]
    pub(crate) async fn is_cached_for_test(&self, token: &str) -> bool {
        self.cache.run_pending_tasks().await;
        self.cache.get(&cache_key(token)).await.is_some()
    }
}

/// cache key:token 的完整 SHA-256 十六进制。
/// 不截断 —— 截断到前 8 字节(64bit)存在 token 碰撞返回他人 UserCtx 的身份冒用风险。
/// 仍 hash 而非存明文,避免 token 原文驻留内存。
fn cache_key(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

// ─── HubSvc ────────────────────────────────────────────────────────────────

pub struct HubSvc {
    pub router: Arc<Router>,
    /// employee_id + notify_seq + event_index 主键的事件日志,Subscribe 用它续点。
    pub events_log: EventLog,
    pub downstream: Arc<DownstreamClient>,
    pub auth: Arc<TokenAuthenticator>,
    /// Hub.Forward 的 method → HTTP path 映射(env-driven)。
    pub routes: DownstreamRoutes,
    /// 通知流 clientId(notify/pull 请求体用)。固定 `rh_wxchat`。
    pub client_id: String,
    /// notify/pull 补偿拉取配置(来自 Config)。
    pub notify_pull_enabled: bool,
    pub notify_pull_page_size: u32,
    pub notify_pull_max_iters: u32,
    pub notify_pull_budget_ms: u64,
}

impl HubSvc {
    /// 从 extensions 取拦截器放入的 Bearer token,调 verifyToken 拿连接身份。
    async fn authenticate<T>(&self, req: &Request<T>) -> Result<UserCtx, Status> {
        let token = self.bearer(req)?;
        self.auth.authenticate(&token).await
    }

    /// 提取拦截器放入的原 Bearer token 字符串(用于 Hub.Forward 透传给业务后台)。
    #[allow(clippy::result_large_err)] // Status 主导;项目整体未 Box Status,跟现有风格一致
    fn bearer<T>(&self, req: &Request<T>) -> Result<String, Status> {
        Ok(req
            .extensions()
            .get::<BearerToken>()
            .ok_or_else(|| Status::unauthenticated("missing bearer"))?
            .0
            .clone())
    }

    /// 缺口补偿:从业务端 outbox 同步分页拉取 `notify_seq > since` 的批次,幂等写回本地
    /// event log(复用 push 的 `convert_batch_to_rows`)。
    ///
    /// 返回 `true` = 已完整补齐(服务端 `has_more=false` 自然结束);
    /// `false` = 失败 / 超时间预算 / 超迭代上限 / 游标不前进 → 调用方置 `resync_required=true`
    /// 让客户端走 REST 全量兜底。受 `notify_pull_budget_ms` + `notify_pull_max_iters` 双重约束,
    /// 绝不在重连风暴下挂死 subscribe。
    async fn backfill_from_outbox(
        &self,
        client_token: &str,
        employee_id: i64,
        since: u64,
        reason: &str,
    ) -> bool {
        use crate::downstream::NotifyPullReq;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_millis(self.notify_pull_budget_ms);
        let mut start = since + 1;

        for iter in 0..self.notify_pull_max_iters {
            if std::time::Instant::now() >= deadline {
                tracing::warn!(
                    employee_id,
                    start,
                    "notify_pull over budget; aborting backfill"
                );
                return false;
            }
            let request_id = format!("PULL_{employee_id}_{since}_{iter}");
            let resp = match self
                .downstream
                .notify_pull(
                    client_token,
                    NotifyPullReq {
                        client_id: &self.client_id,
                        employee_id,
                        notify_seq_list: None,
                        start_notify_seq: Some(start),
                        end_notify_seq: None,
                        limit: self.notify_pull_page_size,
                        request_id: &request_id,
                        reason,
                        trace_id: &request_id,
                    },
                )
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(employee_id, error = %e, "notify_pull request failed; aborting backfill");
                    return false;
                }
            };

            // 写回:payload 与 §6.3 push body 同构 → 复用 PushBatchIn + convert_batch_to_rows。
            // missing_notify_seq_list 不算失败(被关键词过滤的消息不占 notifySeq,是合法空洞)。
            let mut max_seq_seen = start.saturating_sub(1);
            for b in &resp.batches {
                max_seq_seen = max_seq_seen.max(b.notify_seq);
                match serde_json::from_value::<crate::push::PushBatchIn>(b.payload.clone()) {
                    Ok(pb) => match crate::push::convert_batch_to_rows(&pb, now_ms) {
                        Ok(c) => {
                            if let Err(e) = self.events_log.insert_batch(c.rows).await {
                                tracing::warn!(employee_id, error = %e, "backfill insert_batch failed");
                                return false;
                            }
                        }
                        Err(idx) => tracing::warn!(
                            employee_id,
                            notify_seq = b.notify_seq,
                            event_index = idx,
                            "backfill batch has empty eventType; skipped"
                        ),
                    },
                    Err(e) => tracing::warn!(
                        employee_id,
                        notify_seq = b.notify_seq,
                        error = %e,
                        "backfill payload parse failed; skipped"
                    ),
                }
            }

            if !resp.has_more {
                tracing::info!(
                    employee_id,
                    iters = iter + 1,
                    "notify_pull backfill complete"
                );
                return true;
            }
            // 推进游标;服务端没给 next 或没前进则中止,避免死循环。
            let next = resp.next_start_notify_seq.unwrap_or(max_seq_seen + 1);
            if next <= start {
                tracing::warn!(
                    employee_id,
                    start,
                    next,
                    "notify_pull cursor not advancing; aborting"
                );
                return false;
            }
            start = next;
        }
        tracing::warn!(
            employee_id,
            max_iters = self.notify_pull_max_iters,
            "notify_pull hit max iters; backfill incomplete"
        );
        false
    }
}

/// 把 hub_events 一组(同 notify_seq)行序列化为 PushBatchOut 帧并 send。
async fn send_replay_batch(
    tx: &mpsc::Sender<Result<ServerEvent, Status>>,
    group: &[EventRow],
    employee_id: i64,
) {
    if group.is_empty() {
        return;
    }
    // F7:直接 byte 拼 `[row1,row2,...]`,跳过 parse→Value→serialize 来回。
    // 每行 payload_json 是单 event 的合法 JSON 文本(写入时由 serde_json 保证),
    // 拼到外层数组里仍然是合法 JSON。1000 行 replay 节省 ~80% CPU。
    let events_json: bytes::Bytes = {
        let total_len: usize =
            2 + group.iter().map(|r| r.payload_json.len()).sum::<usize>() + group.len();
        let mut buf = Vec::with_capacity(total_len);
        buf.push(b'[');
        for (i, r) in group.iter().enumerate() {
            if i > 0 {
                buf.push(b',');
            }
            buf.extend_from_slice(r.payload_json.as_bytes());
        }
        buf.push(b']');
        buf.into()
    };

    let head = &group[0];
    let pb = chathub_proto::v1::PushBatchOut {
        notify_seq: head.notify_seq as u64,
        client_id: head.client_id.clone(),
        employee_id,
        batch_id: head.batch_id.clone().unwrap_or_default(),
        batch_time: head.batch_time.clone().unwrap_or_default(),
        device_id: String::new(),
        events_json, // 已经是 Bytes
    };
    let frame = ServerEvent {
        body: Some(chathub_proto::v1::server_event::Body::PushBatch(pb)),
    };
    let _ = tx.send(Ok(frame)).await;
}

#[async_trait]
impl Hub for HubSvc {
    type SubscribeStream = ReceiverStream<Result<ServerEvent, Status>>;

    /// Subscribe(Plan 7 — employee-scope 唯一路径):
    /// 1. 要求 employee_id 非 0(老业务后台未升级则 FailedPrecondition)
    /// 2. 第一帧发 SubscribeAck(resumed_from_seq / replayed_to_seq / resync_required)
    /// 3. 重放 hub_events > since_notify_seq 的事件,按 notify_seq 分组成 PushBatchOut
    /// 4. register_employee 到 router,后续实时 push v2 由 fanout_employee 投递
    /// 5. 起 cleanup task,客户端断开时(rx 被 drop)自动 drop_employee_stream
    #[tracing::instrument(skip_all, fields(employee_id, device_id, since_notify_seq))]
    async fn subscribe(
        &self,
        req: Request<SubscribeRequest>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        let ctx = self.authenticate(&req).await?;
        // notify/pull 缺口补偿透传同一客户端 token(在 into_inner 消费 req 前抓取)。
        let client_token = self.bearer(&req)?;
        let inner = req.into_inner();
        tracing::Span::current().record("employee_id", ctx.employee_id);
        tracing::Span::current().record("device_id", inner.device_id.as_str());
        tracing::Span::current().record("since_notify_seq", inner.since_notify_seq);

        if ctx.employee_id == 0 {
            tracing::warn!(
                user_id = %ctx.user_id,
                "subscribe rejected: employee_id missing from verify_token"
            );
            return Err(Status::failed_precondition(format!(
                "employee_id missing for user_id={} (business backend upgrade required)",
                ctx.user_id
            )));
        }

        let since = inner.since_notify_seq;
        let device_id = inner.device_id.clone();

        // mpsc buffer 256(spec §每员工 burst 通常 <10/s,256 已足够)
        let (tx, rx) = mpsc::channel(256);

        // F7:① resync 判断 + ② replay 查询 **并行**(两个独立 SQLite 查询)。
        // 串行时累加 ~2-4ms;并行后 ≈ max(两者),5000 重连场景下省 10s+ CPU/s。
        const REPLAY_LIMIT: i64 = 1000;
        let earliest_fut = self.events_log.earliest_for(ctx.employee_id);
        let query_fut =
            self.events_log
                .query_since(ctx.employee_id, since as i64, REPLAY_LIMIT + 1);
        let (earliest_result, query_result) = tokio::join!(earliest_fut, query_fut);

        let earliest = earliest_result.map_err(|e| Status::from(RelayError::from(e)))?;
        let initial_rows = query_result.map_err(|e| Status::from(RelayError::from(e)))?;

        // 缺口判定:since>0 且(日志全空[全损 / 换机]或最早 seq 已跳过 since+1[窗口缺口])。
        // earliest=None && since>0 是过去的静默丢失盲区 —— 现在也判为缺口,触发补偿。
        let earliest_seq = earliest.map(|(s, _)| s as u64);
        let needs_pull = since > 0 && earliest_seq.map(|min| min > since + 1).unwrap_or(true);

        let mut resync_required = false;
        let mut resync_reason = String::new();

        // 缺口 → 同步预算化向业务端 outbox 补偿拉取(notify/pull)。补齐后重查日志续点;
        // 失败/超预算/关闭 → 置 resync_required 让客户端走 REST 全量兜底(永不静默丢)。
        let mut rows = if needs_pull {
            let reason_code = if earliest_seq.is_none() {
                "RELAY_LOG_MISSING"
            } else {
                "CLIENT_GAP_REPLAY"
            };
            let pulled_ok = if self.notify_pull_enabled {
                self.backfill_from_outbox(&client_token, ctx.employee_id, since, reason_code)
                    .await
            } else {
                false
            };
            if !pulled_ok {
                resync_required = true;
                resync_reason = if self.notify_pull_enabled {
                    "notify_pull backfill incomplete; resync via recentFriends/history".to_string()
                } else {
                    "notify_pull disabled; resync via recentFriends/history".to_string()
                };
            }
            // 不论补偿是否完整,都以重查结果回放(补回的部分能直接续点)。
            self.events_log
                .query_since(ctx.employee_id, since as i64, REPLAY_LIMIT + 1)
                .await
                .map_err(|e| Status::from(RelayError::from(e)))?
        } else {
            initial_rows
        };

        let more_available = rows.len() as i64 > REPLAY_LIMIT;
        if more_available {
            rows.truncate(REPLAY_LIMIT as usize);
            resync_required = true;
            if resync_reason.is_empty() {
                resync_reason = format!(
                    "more than {REPLAY_LIMIT} events queued; resync via recentFriends/history"
                );
            }
            tracing::warn!(
                employee_id = ctx.employee_id,
                queued = REPLAY_LIMIT + 1,
                "subscribe replay truncated; resync_required=true"
            );
        }
        // B2(spec §6.2):resync_required 时 ack 直接报 head(MAX(notify_seq)),并跳过逐帧重放,
        // 让客户端(P3-B1)把游标跳到 head + 走 REST 全量对齐,消除"截断→since不前进→反复重放"循环。
        // 空表 / 日志全损 → latest_for=None → 回退 since(游标不倒退)。
        let replayed_to_seq = if resync_required {
            let head = self
                .events_log
                .latest_for(ctx.employee_id)
                .await
                .map_err(|e| Status::from(RelayError::from(e)))?
                .map(|s| s as u64)
                .unwrap_or(since);
            // 跳重放:清空待发回放集,P1 spawn 内的回放循环对空 rows 零迭代。
            rows.clear();
            head
        } else {
            // 正常小回放路径不变:replayed_to_seq = 窗口内最后一条(此时即 head)。
            rows.last().map(|r| r.notify_seq as u64).unwrap_or(since)
        };

        // ③ 首帧 SubscribeAck —— 同步发(单帧,256 缓冲不阻塞)。
        let ack_frame = ServerEvent {
            body: Some(chathub_proto::v1::server_event::Body::SubscribeAck(
                chathub_proto::v1::SubscribeAck {
                    resumed_from_seq: since,
                    replayed_to_seq,
                    resync_required,
                    resync_reason: resync_reason.clone(),
                },
            )),
        };
        if tx.send(Ok(ack_frame)).await.is_err() {
            tracing::debug!("subscribe client gone before ack delivered");
            return Ok(Response::new(ReceiverStream::new(rx)));
        }
        tracing::info!(
            replayed_to_seq,
            resync_required,
            replay_rows = rows.len(),
            "subscribe ack sent"
        );

        // ④ 注册 employee 路由 —— **同步**,先于 Response 返回。
        //    保证客户端可见 ack 时连接已注册:读到 ack 后立即 push 必达实时流,
        //    且既有 first_connection 测试断言连接数=1 确定成立(register 不在 spawn 内)。
        let reg = self
            .router
            .register_employee(ctx.employee_id, device_id.clone(), tx.clone());
        let connection_id = reg.connection_id;
        tracing::info!(connection_id = %connection_id, "subscribe registered");

        // ⑤ 回放 + cleanup 移入 spawn:回放帧数可达 REPLAY_LIMIT(1000)> mpsc(256),
        //    必须在 Response 返回后与 tonic drain rx 并发发送,否则 send().await 在缓冲满时
        //    死锁(handler 不返回 → 客户端拿不到响应头 → 永久 Connecting)。
        let router = self.router.clone();
        let emp_id = ctx.employee_id;
        let conn_id_for_drop = connection_id.clone();
        tokio::spawn(async move {
            // 按 notify_seq 分组重放 PushBatchOut(同 seq 多事件视为一个原子 batch)。
            let mut group_start = 0usize;
            for i in 0..rows.len() {
                let is_last = i + 1 == rows.len();
                let boundary = !is_last && rows[i].notify_seq != rows[i + 1].notify_seq;
                if is_last || boundary {
                    send_replay_batch(&tx, &rows[group_start..=i], emp_id).await;
                    group_start = i + 1;
                }
            }
            // 客户端断开(rx 被 drop)→ 摘除 router 注册。
            tx.closed().await;
            router.drop_employee_stream(emp_id, &conn_id_for_drop);
            tracing::debug!(
                employee_id = emp_id,
                connection_id = %conn_id_for_drop,
                "subscribe stream dropped"
            );
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    /// Ack:客户端处理完一批事件后上报 notify_seq 水位。
    /// 仅 relay 内部观测;事件日志清理走 TTL,不依赖此值。
    /// 员工身份从 token 取,客户端不能伪造。
    #[tracing::instrument(skip_all, fields(notify_seq))]
    async fn ack(&self, req: Request<AckRequest>) -> Result<Response<AckResponse>, Status> {
        let ctx = self.authenticate(&req).await?;
        if ctx.employee_id == 0 {
            tracing::warn!(
                user_id = %ctx.user_id,
                "Hub.Ack rejected: employee_id missing from verify_token"
            );
            return Err(Status::failed_precondition(format!(
                "employee_id missing for user_id={} (business backend upgrade required)",
                ctx.user_id
            )));
        }
        let r = req.into_inner();
        tracing::Span::current().record("notify_seq", r.notify_seq);
        self.router.update_ack_mark(ctx.employee_id, r.notify_seq);
        tracing::debug!(
            employee_id = ctx.employee_id,
            notify_seq = r.notify_seq,
            "Hub.Ack ok"
        );
        Ok(Response::new(AckResponse {}))
    }

    /// Forward:业务 RPC 透传统一入口。REST 隧道语义(P0-5):
    /// - 2xx → Ok(ForwardResponse{body, http_status})
    /// - 4xx → 同样 Ok(REST 风格透传),客户端按 http_status 自行判断业务错
    /// - 5xx → Status::Internal
    /// - 网络/超时 → Status::Unavailable
    #[tracing::instrument(skip_all, fields(method, employee_id, body_len))]
    async fn forward(
        &self,
        req: Request<ForwardRequest>,
    ) -> Result<Response<ForwardResponse>, Status> {
        let ctx = self.authenticate(&req).await?;
        let client_token = self.bearer(&req)?;
        if ctx.employee_id == 0 {
            tracing::warn!(
                user_id = %ctx.user_id,
                "Hub.Forward rejected: employee_id missing from verify_token"
            );
            return Err(Status::failed_precondition(format!(
                "employee_id missing for user_id={} (business backend upgrade required)",
                ctx.user_id
            )));
        }
        let r = req.into_inner();
        tracing::Span::current().record("method", &r.method);
        tracing::Span::current().record("employee_id", ctx.employee_id);
        tracing::Span::current().record("body_len", r.body_json.len());

        let outcome = self
            .downstream
            .forward(
                &self.routes,
                &r.method,
                ctx.employee_id,
                r.body_json,
                &r.query,
                &client_token,
            )
            .await
            .map_err(Status::from)?;
        // client_token 出函数后立刻 drop,不进缓存不进 struct(安全约束)
        drop(client_token);
        Ok(Response::new(ForwardResponse {
            body_json: outcome.body.into(), // F6: Vec<u8> → Bytes
            http_status: outcome.http_status as u32,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::Router;
    use crate::storage::Storage;
    use chathub_proto::v1::server_event::Body;
    use std::net::SocketAddr;
    use tokio::net::TcpListener;
    use tokio_stream::wrappers::TcpListenerStream;
    use tokio_stream::StreamExt;
    use tonic::transport::{Endpoint, Server};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn req_with(meta: &[(&'static str, &str)]) -> Request<()> {
        let mut r = Request::new(());
        for (k, v) in meta {
            r.metadata_mut().insert(*k, v.parse().unwrap());
        }
        r
    }

    const VERIFY_PATH: &str =
        "/wechat-business-app/wecom-cs/v1/wecomAggregate/connection/verifyToken";

    /// 2026-05-17 包络化后,业务后台响应统一是 `{code:1, msg:"成功", data:...}`。
    /// 测试 fixture 用这个 helper 把原 payload 包成成功包络。
    fn envelope_ok_json(data: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "code": 1,
            "serviceCode": "",
            "msg": "成功",
            "data": data
        })
    }

    /// 业务后台 mock verify_token:返回带 employeeId 的连接身份。
    /// `_device_id` 仅为保留旧调用点签名,新合约响应不携带 device_id —
    /// Subscribe 自行从 gRPC 请求体里取。
    async fn mount_verify_token(
        mock: &MockServer,
        token: &str,
        employee_id: i64,
        _device_id: &str,
    ) {
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .and(header("authorization", &*format!("Bearer {token}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(envelope_ok_json(
                serde_json::json!({
                    "employeeId": employee_id,
                    "username": "",
                    "nickName": "",
                    "mobile": "",
                    "channel": ""
                }),
            )))
            .mount(mock)
            .await;
    }

    /// 业务后台 mock verify_token,但**不**返 employeeId(老后台 / 未关联员工)。
    async fn mount_verify_token_no_employee(mock: &MockServer, token: &str) {
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .and(header("authorization", &*format!("Bearer {token}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(envelope_ok_json(
                serde_json::json!({
                    "username": "",
                    "nickName": "",
                    "mobile": "",
                    "channel": ""
                }),
            )))
            .mount(mock)
            .await;
    }

    async fn build_svc(mock: &MockServer) -> HubSvc {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        let storage = Storage::open(&db).await.unwrap();
        std::mem::forget(tmp);
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new_with_defaults(&mock.uri()).unwrap());
        HubSvc {
            router: Arc::new(Router::new()),
            events_log: EventLog::new(storage),
            downstream: downstream.clone(),
            auth: Arc::new(TokenAuthenticator::new(downstream)),
            routes: crate::config::DownstreamRoutes::default_for_test(),
            client_id: "rh_wxchat".into(),
            notify_pull_enabled: true,
            notify_pull_page_size: 100,
            notify_pull_max_iters: 50,
            notify_pull_budget_ms: 4000,
        }
    }

    fn sub_request(device_id: &str, since: u64) -> Request<SubscribeRequest> {
        let mut req = Request::new(SubscribeRequest {
            since_notify_seq: since,
            device_id: device_id.into(),
            client_version: "1.0.0".into(),
        });
        req.extensions_mut()
            .insert(BearerToken("tok-A".to_string()));
        req
    }

    fn make_event_row(employee_id: i64, notify_seq: i64, event_index: i64) -> EventRow {
        EventRow {
            employee_id,
            notify_seq,
            event_index,
            event_type: "MESSAGE_UPSERT".into(),
            event_reason: Some("CUSTOMER_MESSAGE_RECEIVED".into()),
            conversation_id: Some("conv-1".into()),
            customer_user_id: Some("u-c".into()),
            external_user_id: Some("ext-1".into()),
            client_id: "rh_wxchat".into(),
            batch_id: Some(format!("rh_wxchat:{employee_id}:{notify_seq}")),
            batch_time: Some("2026-05-14 10:30:00".into()),
            event_time: Some("2026-05-14 10:30:00".into()),
            payload_json: format!(
                r#"{{"eventType":"MESSAGE_UPSERT","notifySeq":{notify_seq},"index":{event_index}}}"#
            ),
            created_at_ms: notify_seq * 1000,
        }
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
            ("authorization", "Bearer abc"),
        ]);
        let ok = ic.call(r).unwrap();
        assert_eq!(ok.extensions().get::<BearerToken>().unwrap().0, "abc");
    }

    // ── TokenAuthenticator ──────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn authenticator_happy_returns_ctx() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-1", 7, "dev-A").await;
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new_with_defaults(&mock.uri()).unwrap());
        let auth = TokenAuthenticator::new(downstream);
        let ctx = auth.authenticate("tok-1").await.unwrap();
        assert_eq!(ctx.employee_id, 7);
        // 新合约 verifyToken 不返 device_id;Subscribe 自行从 gRPC 请求体取。
        assert_eq!(ctx.device_id, "");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn authenticator_missing_employee_id_returns_ctx_with_zero() {
        // 新合约:200 但 body 不带 employeeId(老后台 / 未关联员工) — authenticate 不在此层拒,
        // 留给 Subscribe/Ack/Forward 层用 FailedPrecondition + 信息更全的错误消息拒。
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(envelope_ok_json(serde_json::json!({ "username": "" }))),
            )
            .mount(&mock)
            .await;
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new_with_defaults(&mock.uri()).unwrap());
        let auth = TokenAuthenticator::new(downstream);
        let ctx = auth.authenticate("tok-noemp").await.unwrap();
        assert_eq!(ctx.employee_id, 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn authenticator_backend_401_maps_unauthenticated() {
        // 新合约:token 失效 → 后台直接 401(不是 200 + active=false)→ Unauthenticated
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new_with_defaults(&mock.uri()).unwrap());
        let auth = TokenAuthenticator::new(downstream);
        let err = auth.authenticate("bad").await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn authenticator_caches_result_second_call_skips_downstream() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(envelope_ok_json(serde_json::json!({
                    "employeeId": 42, "username": "", "nickName": "", "mobile": "", "channel": ""
                }))),
            )
            .expect(1) // wiremock 在 drop 时校验:必须恰好 1 次
            .mount(&mock)
            .await;
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new_with_defaults(&mock.uri()).unwrap());
        let auth = TokenAuthenticator::new(downstream);
        let _ = auth.authenticate("tok-X").await.unwrap();
        let _ = auth.authenticate("tok-X").await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn authenticator_invalidate_forces_reverify() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(envelope_ok_json(serde_json::json!({
                    "employeeId": 7, "username": "", "nickName": "", "mobile": "", "channel": ""
                }))),
            )
            .expect(2) // invalidate 后第二次必须回源
            .mount(&mock)
            .await;
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new_with_defaults(&mock.uri()).unwrap());
        let auth = TokenAuthenticator::new(downstream);
        let _ = auth.authenticate("tok-inv").await.unwrap();
        assert!(auth.is_cached_for_test("tok-inv").await);
        auth.invalidate("tok-inv").await;
        assert!(!auth.is_cached_for_test("tok-inv").await);
        let _ = auth.authenticate("tok-inv").await.unwrap(); // 回源(verify 第 2 次)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn authenticator_invalidate_employee_evicts_only_that_employee() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-emp7", 7, "dev").await;
        mount_verify_token(&mock, "tok-emp8", 8, "dev").await;
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new_with_defaults(&mock.uri()).unwrap());
        let auth = TokenAuthenticator::new(downstream);
        assert_eq!(auth.authenticate("tok-emp7").await.unwrap().employee_id, 7);
        assert_eq!(auth.authenticate("tok-emp8").await.unwrap().employee_id, 8);
        auth.invalidate_employee(7).await;
        // emp7 的 token 被逐 key 失效;emp8 不受影响
        assert!(!auth.is_cached_for_test("tok-emp7").await);
        assert!(auth.is_cached_for_test("tok-emp8").await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn authenticator_singleflight_50_concurrent_calls_one_verify() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(VERIFY_PATH))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(100))
                    .set_body_json(envelope_ok_json(serde_json::json!({
                        "employeeId": 42, "username": "", "nickName": "", "mobile": "", "channel": ""
                    }))),
            )
            .expect(1)
            .mount(&mock)
            .await;
        let downstream =
            Arc::new(crate::downstream::DownstreamClient::new_with_defaults(&mock.uri()).unwrap());
        let auth = Arc::new(TokenAuthenticator::new(downstream));
        let mut set = tokio::task::JoinSet::new();
        for _ in 0..50 {
            let a = auth.clone();
            set.spawn(async move { a.authenticate("tok-X").await.map(|c| c.employee_id) });
        }
        let mut count_ok = 0;
        while let Some(r) = set.join_next().await {
            if matches!(r.unwrap(), Ok(42)) {
                count_ok += 1;
            }
        }
        assert_eq!(count_ok, 50);
    }

    // ── Subscribe(v2 唯一路径)──────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_first_connection_returns_ack_no_replay() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        let svc = build_svc(&mock).await;
        let router = svc.router.clone();
        let stream_resp = svc.subscribe(sub_request("dev-A", 0)).await.unwrap();
        let mut stream = stream_resp.into_inner();
        let first = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match first.body {
            Some(Body::SubscribeAck(ack)) => {
                assert_eq!(ack.resumed_from_seq, 0);
                assert_eq!(ack.replayed_to_seq, 0);
                assert!(!ack.resync_required);
            }
            other => panic!("expected SubscribeAck, got {other:?}"),
        }
        assert_eq!(router.employee_connection_count(42), 1);
    }

    /// B2 改写:since=50、earliest=100>since+1 → needs_pull → backfill 失败 → resync_required。
    /// B2 后 replayed_to_seq=head=MAX(100,101)=101(与改前巧合相同),但**不发任何回放帧**。
    /// 原测试断言 PushBatch(100)/(101) 在 B2 后不再成立,改为断言 ack 字段 + 无后续帧。
    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_with_since_replays_events_grouped_by_notify_seq() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        let svc = build_svc(&mock).await;
        svc.events_log
            .insert_batch(vec![
                make_event_row(42, 100, 0),
                make_event_row(42, 100, 1),
                make_event_row(42, 101, 0),
            ])
            .await
            .unwrap();
        let stream_resp = svc.subscribe(sub_request("dev-A", 50)).await.unwrap();
        let mut stream = stream_resp.into_inner();
        // ack:resync_required=true(缺口)、replayed_to_seq=head=101(B2:latest_for MAX)。
        let first = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match first.body {
            Some(Body::SubscribeAck(ack)) => {
                assert_eq!(ack.resumed_from_seq, 50);
                assert_eq!(
                    ack.replayed_to_seq, 101,
                    "B2:resync 路径 replayed_to_seq=head=101"
                );
                assert!(
                    ack.resync_required,
                    "min=100 > since+1=51 → needs_pull 失败 → resync"
                );
            }
            other => panic!("expected SubscribeAck, got {other:?}"),
        }
        // B2:resync 路径跳重放——不应有任何 PushBatch 帧。
        let next = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            StreamExt::next(&mut stream),
        )
        .await;
        match next {
            Err(_) => {} // 超时 = 无更多帧,正确。
            Ok(Some(Ok(ev))) => panic!("resync 路径不应发回放帧,却收到 {:?}", ev.body),
            Ok(other) => panic!("意外的流终止:{other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_with_large_replay_does_not_deadlock() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        let svc = build_svc(&mock).await;

        // 300 个 distinct notify_seq → 300 回放帧 + 1 ack = 301 > mpsc(256)。
        let rows: Vec<EventRow> = (1..=300_i64)
            .map(|seq| make_event_row(42, seq, 0))
            .collect();
        svc.events_log.insert_batch(rows).await.unwrap();

        // 当前代码:handler 在第 257 次 send().await 阻塞、subscribe() 永不返回 → 超时(FAIL)。
        // 修好后:subscribe() 立即返回 Response。
        let resp = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            svc.subscribe(sub_request("dev-A", 0)),
        )
        .await
        .expect("subscribe 必须立即返回响应头,不能死锁")
        .expect("subscribe 应成功");

        // drain 整条流:1 ack + 300 PushBatch 全部收到。
        let mut stream = resp.into_inner();
        let first = StreamExt::next(&mut stream).await.unwrap().unwrap();
        assert!(
            matches!(first.body, Some(Body::SubscribeAck(_))),
            "首帧必须是 SubscribeAck"
        );
        let mut push_frames = 0;
        while let Ok(Some(Ok(ev))) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            StreamExt::next(&mut stream),
        )
        .await
        {
            if matches!(ev.body, Some(Body::PushBatch(_))) {
                push_frames += 1;
            }
            if push_frames == 300 {
                break;
            }
        }
        assert_eq!(push_frames, 300, "应收齐全部 300 个回放帧");
    }

    // ── B2 resync 跳重放单测 ───────────────────────────────────────────────

    /// notify/pull 503 → backfill 失败(用于 subscribe_resync_empty_log_falls_back_to_since)。
    async fn mount_notify_pull_503(mock: &MockServer) {
        Mock::given(method("POST"))
            .and(path(
                "/wechat-business-app/rpc/v1/wecomAggregate/notify/pull",
            ))
            .respond_with(ResponseTemplate::new(503))
            .mount(mock)
            .await;
    }

    /// B2:resync_required(由截断触发,>REPLAY_LIMIT 行)→ ack.replayed_to_seq 跳到
    /// head(latest_for=MAX),且**不发任何回放帧**(回放循环短路)。
    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_resync_skips_replay_and_acks_head() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        let svc = build_svc(&mock).await;

        // 1001 个 distinct notify_seq(>REPLAY_LIMIT=1000)→ 截断 → resync_required。
        // head = MAX(notify_seq) = 1001(而非截断窗口内的 last=1000)。
        let rows: Vec<EventRow> = (1..=1001_i64)
            .map(|seq| make_event_row(42, seq, 0))
            .collect();
        svc.events_log.insert_batch(rows).await.unwrap();

        let resp = svc.subscribe(sub_request("dev-A", 0)).await.unwrap();
        let mut stream = resp.into_inner();

        // 首帧:ack.resync_required=true 且 replayed_to_seq=1001(head),不是 1000。
        let first = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match first.body {
            Some(Body::SubscribeAck(ack)) => {
                assert!(ack.resync_required, "1001>1000 → 截断 → resync");
                assert_eq!(
                    ack.replayed_to_seq, 1001,
                    "replayed_to_seq 应=head(MAX),非截断 last"
                );
            }
            other => panic!("expected SubscribeAck, got {other:?}"),
        }

        // 后续不应有任何 PushBatch 帧:resync 跳重放。给短 timeout,超时即"无帧"(符合预期)。
        let next = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            StreamExt::next(&mut stream),
        )
        .await;
        match next {
            Err(_) => {} // 超时 = 无更多帧,正确。
            Ok(Some(Ok(ev))) => panic!("resync 路径不应发回放帧,却收到 {:?}", ev.body),
            Ok(other) => panic!("意外的流终止:{other:?}"),
        }
    }

    /// B2 空表回退(spec §6.2 / MAJOR D):日志空 + since>0 + notify_pull 失败 → resync_required,
    /// latest_for=None → replayed_to_seq 回退为 since,且不发回放帧。
    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_resync_empty_log_falls_back_to_since() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        // notify_pull 503 → 补偿失败 → resync 兜底(needs_pull 路径)。
        mount_notify_pull_503(&mock).await;
        let svc = build_svc(&mock).await;
        // 不插任何 hub_events → 日志空 → latest_for=None。

        // since=10 > 0 且日志空 → needs_pull;补偿失败 → resync_required。
        let resp = svc.subscribe(sub_request("dev-A", 10)).await.unwrap();
        let mut stream = resp.into_inner();

        let first = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match first.body {
            Some(Body::SubscribeAck(ack)) => {
                assert!(ack.resync_required, "空日志+since>0+pull失败 → resync");
                assert_eq!(
                    ack.replayed_to_seq, 10,
                    "空表 latest_for=None → 回退 since=10"
                );
            }
            other => panic!("expected SubscribeAck, got {other:?}"),
        }

        // 无回放帧。
        let next = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            StreamExt::next(&mut stream),
        )
        .await;
        assert!(matches!(next, Err(_)), "resync 空表路径不应发回放帧");
    }

    /// B2 不影响正常小回放:resync_required=false → 照发重放帧、replayed_to_seq=rows.last()。
    /// (回归保护,确保 B2 分叉没把非 resync 路径带歪。)
    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_non_resync_still_replays_frames() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        let svc = build_svc(&mock).await;
        // since=100,日志含 101/102 → earliest=101=since+1 → 无缺口 → 不截断 → resync_required=false。
        svc.events_log
            .insert_batch(vec![make_event_row(42, 101, 0), make_event_row(42, 102, 0)])
            .await
            .unwrap();

        let resp = svc.subscribe(sub_request("dev-A", 100)).await.unwrap();
        let mut stream = resp.into_inner();

        let first = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match first.body {
            Some(Body::SubscribeAck(ack)) => {
                assert!(
                    !ack.resync_required,
                    "earliest=since+1 → 无缺口 → 不 resync"
                );
                assert_eq!(
                    ack.replayed_to_seq, 102,
                    "非 resync:replayed_to_seq=rows.last()"
                );
            }
            other => panic!("expected SubscribeAck, got {other:?}"),
        }
        // 照发 2 个回放帧 101、102。
        let f2 = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match f2.body {
            Some(Body::PushBatch(pb)) => assert_eq!(pb.notify_seq, 101),
            other => panic!("expected PushBatch 101, got {other:?}"),
        }
        let f3 = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match f3.body {
            Some(Body::PushBatch(pb)) => assert_eq!(pb.notify_seq, 102),
            other => panic!("expected PushBatch 102, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_rejects_when_employee_id_missing() {
        let mock = MockServer::start().await;
        mount_verify_token_no_employee(&mock, "tok-A").await;
        let svc = build_svc(&mock).await;
        let err = svc.subscribe(sub_request("dev-A", 0)).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::FailedPrecondition);
        // 新合约下 user_id 派生自 employeeId,缺失时为 "0";断言错误信息提示了 employee_id 问题
        assert!(err.message().contains("employee_id missing"));
    }

    // ── Ack ──────────────────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn ack_updates_router_water_mark() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        let svc = build_svc(&mock).await;
        let router = svc.router.clone();

        let mut req = Request::new(AckRequest { notify_seq: 500 });
        req.extensions_mut().insert(BearerToken("tok-A".into()));
        svc.ack(req).await.unwrap();
        assert_eq!(router.get_ack_mark(42), 500);

        let mut req2 = Request::new(AckRequest { notify_seq: 200 });
        req2.extensions_mut().insert(BearerToken("tok-A".into()));
        svc.ack(req2).await.unwrap();
        assert_eq!(router.get_ack_mark(42), 500); // 单调

        let mut req3 = Request::new(AckRequest { notify_seq: 800 });
        req3.extensions_mut().insert(BearerToken("tok-A".into()));
        svc.ack(req3).await.unwrap();
        assert_eq!(router.get_ack_mark(42), 800);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ack_rejected_when_employee_id_missing() {
        let mock = MockServer::start().await;
        mount_verify_token_no_employee(&mock, "tok-A").await;
        let svc = build_svc(&mock).await;
        let mut req = Request::new(AckRequest { notify_seq: 500 });
        req.extensions_mut().insert(BearerToken("tok-A".into()));
        let err = svc.ack(req).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::FailedPrecondition);
    }

    // ── Forward ──────────────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_passes_through_to_business_backend() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        Mock::given(method("POST"))
            .and(path("/v1/send"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "echo": "ok", "got": "payload" })),
            )
            .mount(&mock)
            .await;
        let svc = build_svc(&mock).await;
        let mut req = Request::new(ForwardRequest {
            method: "send".into(),
            body_json: bytes::Bytes::from_static(br#"{"conversationId":"c1","contentText":"hi"}"#),
            query: Default::default(),
        });
        req.extensions_mut().insert(BearerToken("tok-A".into()));
        let resp = svc.forward(req).await.unwrap().into_inner();
        assert_eq!(resp.http_status, 200);
        let parsed: serde_json::Value = serde_json::from_slice(&resp.body_json).unwrap();
        assert_eq!(parsed["echo"], "ok");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_business_4xx_surfaces_as_ok_with_http_status() {
        // P0-5:业务 403 → Ok(http_status=403),不映射成 gRPC PermissionDenied
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        Mock::given(method("POST"))
            .and(path("/v1/send"))
            .respond_with(ResponseTemplate::new(403).set_body_json(
                serde_json::json!({ "errorCode": "RATE_LIMITED", "message": "send too fast" }),
            ))
            .mount(&mock)
            .await;
        let svc = build_svc(&mock).await;
        let mut req = Request::new(ForwardRequest {
            method: "send".into(),
            body_json: bytes::Bytes::from_static(b"{}"),
            query: Default::default(),
        });
        req.extensions_mut().insert(BearerToken("tok-A".into()));
        let resp = svc
            .forward(req)
            .await
            .expect("should NOT be gRPC error")
            .into_inner();
        assert_eq!(resp.http_status, 403);
        let body: serde_json::Value = serde_json::from_slice(&resp.body_json).unwrap();
        assert_eq!(body["errorCode"], "RATE_LIMITED");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_business_5xx_maps_to_internal_grpc_error() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        Mock::given(method("POST"))
            .and(path("/v1/send"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock)
            .await;
        let svc = build_svc(&mock).await;
        let mut req = Request::new(ForwardRequest {
            method: "send".into(),
            body_json: bytes::Bytes::from_static(b"{}"),
            query: Default::default(),
        });
        req.extensions_mut().insert(BearerToken("tok-A".into()));
        let err = svc.forward(req).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::Internal);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_unknown_method_returns_invalid_argument() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        let svc = build_svc(&mock).await;
        let mut req = Request::new(ForwardRequest {
            method: "totally_unknown_method".into(),
            body_json: bytes::Bytes::from_static(b"{}"),
            query: Default::default(),
        });
        req.extensions_mut().insert(BearerToken("tok-A".into()));
        let err = svc.forward(req).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forward_rejected_when_employee_id_missing() {
        let mock = MockServer::start().await;
        mount_verify_token_no_employee(&mock, "tok-A").await;
        let svc = build_svc(&mock).await;
        let mut req = Request::new(ForwardRequest {
            method: "send".into(),
            body_json: bytes::Bytes::from_static(b"{}"),
            query: Default::default(),
        });
        req.extensions_mut().insert(BearerToken("tok-A".into()));
        let err = svc.forward(req).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::FailedPrecondition);
    }

    // ── Subscribe v2 + gRPC stack(simple e2e via in-process listener)──

    async fn spawn_hub_listening() -> (SocketAddr, MockServer) {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 99, "dev-A").await;
        let svc = build_svc(&mock).await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stream = TcpListenerStream::new(listener);
        tokio::spawn(async move {
            let _ = Server::builder()
                .add_service(chathub_proto::v1::hub_server::HubServer::with_interceptor(
                    svc,
                    ProtocolInterceptor::new(),
                ))
                .serve_with_incoming(stream)
                .await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        (addr, mock)
    }

    // tonic::Status ~176B,with_interceptor 闭包 Result<_, Status> 必然 large(上游契约)。
    #[allow(clippy::result_large_err)]
    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_full_stack_first_frame_is_subscribe_ack() {
        let (addr, _mock) = spawn_hub_listening().await;
        let channel = Endpoint::from_shared(format!("http://{addr}"))
            .unwrap()
            .connect()
            .await
            .unwrap();
        let mut client = chathub_proto::v1::hub_client::HubClient::with_interceptor(
            channel,
            move |mut r: Request<()>| {
                r.metadata_mut()
                    .insert("chathub-protocol-version", "1".parse().unwrap());
                r.metadata_mut()
                    .insert("authorization", "Bearer tok-A".parse().unwrap());
                Ok(r)
            },
        );
        let resp = client
            .subscribe(SubscribeRequest {
                since_notify_seq: 0,
                device_id: "dev-A".into(),
                client_version: "1.0.0".into(),
            })
            .await
            .unwrap();
        let mut s = resp.into_inner();
        let first = StreamExt::next(&mut s).await.unwrap().unwrap();
        assert!(matches!(first.body, Some(Body::SubscribeAck(_))));
    }
}
