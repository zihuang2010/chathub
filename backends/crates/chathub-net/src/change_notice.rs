//! 统一变更通知 envelope —— 所有"本地缓存有更新"的事实都汇聚到这里,
//! 前端通过单一 `hub:change` 事件 + ChangeBus 调度,按 (topic, scope) 精准触发 refetch。
//!
//! 设计要点(对照 plan):
//!
//! - **topic**:资源类型 — 资源粒度刷新的分类键。当前只 3 类(Accounts / Friends /
//!   RecentSessions);新加资源时扩枚举(后端编译期约束)。
//! - **scope**:影响范围 — 前端按字段子集判定"这个事件影响我吗"。`employee_id`
//!   必带(跨员工隔离);其他字段缺省 = "影响该 employee 全量"。
//! - **kind**:Upsert / Delete / BulkInvalidate。BulkInvalidate 用于 fallback /
//!   resync 等"前端最好全量重拉"的场景,UI 可以选择直接 refresh 整张表。
//! - **source**:区分事件来源 — 服务端推送(ServerEvent)/ 客户端命令(LocalCommand)/
//!   重对齐信号(Resync)。前端可据此调整 UI 状态(比如 source=Resync 显示"对齐中..")。
//! - **occurred_at_ms**:事件发生时间,前端可用于"我已处理过更新的事件"幂等去重。
//!
//! 同源 + 同 scope 的多次 ChangeNotice 不去重(broadcast 256 buffer + 前端按需 refetch
//! 已经够);极端事件风暴可在 applier 侧加 throttle。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 资源类型枚举。新加资源时扩这里(同时前端 TS union 也要加)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeTopic {
    Accounts,
    Friends,
    RecentSessions,
    ConversationMessages,
}

/// 影响范围。employee_id 强制;其他字段缺省视为"全量"。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeScope {
    pub employee_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wecom_account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_user_id: Option<String>,
}

impl ChangeScope {
    /// 仅 employee_id 维度的快速构造(常用)。
    pub fn employee(employee_id: impl Into<String>) -> Self {
        Self {
            employee_id: employee_id.into(),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeKind {
    /// 资源新增 / 内容更新(行存 UPSERT)。
    Upsert,
    /// 资源被删除。
    Delete,
    /// 大批变动 / 服务端权威重定,前端应整体重拉(fallback / resync 用)。
    BulkInvalidate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeSource {
    /// 服务端 Subscribe 流推送的事件经 applier 写入。
    ServerEvent,
    /// 客户端命令(Tauri command)直接写入本地行存。
    LocalCommand,
    /// SubscribeAck.resync_required / SystemSignal::ResyncRequired 触发的全量对齐。
    Resync,
}

/// 完整的"变更通知"。前端通过 `listen("hub:change")` 接收,内部按 topic + scope 分发。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeNotice {
    pub topic: ChangeTopic,
    pub scope: ChangeScope,
    pub kind: ChangeKind,
    pub source: ChangeSource,
    pub occurred_at_ms: i64,
}

impl ChangeNotice {
    /// 便捷构造:server-event + upsert 的常见组合。
    pub fn server_upsert(topic: ChangeTopic, scope: ChangeScope) -> Self {
        Self {
            topic,
            scope,
            kind: ChangeKind::Upsert,
            source: ChangeSource::ServerEvent,
            occurred_at_ms: now_unix_ms(),
        }
    }

    pub fn server_bulk(topic: ChangeTopic, scope: ChangeScope) -> Self {
        Self {
            topic,
            scope,
            kind: ChangeKind::BulkInvalidate,
            source: ChangeSource::ServerEvent,
            occurred_at_ms: now_unix_ms(),
        }
    }

    pub fn command_upsert(topic: ChangeTopic, scope: ChangeScope) -> Self {
        Self {
            topic,
            scope,
            kind: ChangeKind::Upsert,
            source: ChangeSource::LocalCommand,
            occurred_at_ms: now_unix_ms(),
        }
    }

    pub fn resync(topic: ChangeTopic, scope: ChangeScope) -> Self {
        Self {
            topic,
            scope,
            kind: ChangeKind::BulkInvalidate,
            source: ChangeSource::Resync,
            occurred_at_ms: now_unix_ms(),
        }
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把一段时间窗内的多条 [`ChangeNotice`] 按 `(topic, scope)` 合并:每个 key 只留最新一条,
/// 供 emit 桥尾沿防抖后按时间序一次性发出。纯逻辑、无 time/Tauri 依赖,便于单测。
///
/// 写入纪律:
///   - **同 key 最新者胜**:`occurred_at_ms` 更大的覆盖,同值保留先到。
///   - **BulkInvalidate 优先级**:同 key 内只要出现过一次 BulkInvalidate,合并结果的 `kind`
///     恒为 BulkInvalidate(更保守 = 前端整表重拉),不被随后的 Upsert 降级。
///   - **不同 key 不互相合并**:不同 account / conversation / employee 各自独立,前端按 scope
///     精准过滤的语义不变。
///
/// `source == Resync` 的全量对齐**不**经过本合并器(由调用方在防抖前立即放行),故 [`merge`]
/// 收到的恒为 ServerEvent / LocalCommand。
///
/// [`merge`]: ChangeCoalescer::merge
#[derive(Default)]
pub struct ChangeCoalescer {
    pending: HashMap<String, ChangeNotice>,
}

impl ChangeCoalescer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// 按 `(topic, scope)` 合并进 pending。见类型注释的写入纪律。
    pub fn merge(&mut self, notice: ChangeNotice) {
        let key = Self::key(&notice);
        match self.pending.get_mut(&key) {
            Some(existing) => {
                // 任一侧曾是 BulkInvalidate → 合并结果保持 BulkInvalidate。
                let bulk = existing.kind == ChangeKind::BulkInvalidate
                    || notice.kind == ChangeKind::BulkInvalidate;
                if notice.occurred_at_ms >= existing.occurred_at_ms {
                    *existing = notice;
                }
                if bulk {
                    existing.kind = ChangeKind::BulkInvalidate;
                }
            }
            None => {
                self.pending.insert(key, notice);
            }
        }
    }

    /// 取出全部待发,按 `occurred_at_ms` 升序(时间有序),并清空 pending。
    pub fn drain_ordered(&mut self) -> Vec<ChangeNotice> {
        let mut out: Vec<ChangeNotice> = self.pending.drain().map(|(_, v)| v).collect();
        out.sort_by_key(|n| n.occurred_at_ms);
        out
    }

    /// 合并键:topic + scope 四字段拼串。避免给 [`ChangeScope`] 加 `Hash`/`Eq` 派生。
    fn key(n: &ChangeNotice) -> String {
        format!(
            "{:?}|{}|{}|{}|{}",
            n.topic,
            n.scope.employee_id,
            n.scope.wecom_account_id.as_deref().unwrap_or(""),
            n.scope.conversation_id.as_deref().unwrap_or(""),
            n.scope.external_user_id.as_deref().unwrap_or(""),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_camel_case_envelope() {
        let n = ChangeNotice::server_upsert(
            ChangeTopic::RecentSessions,
            ChangeScope {
                employee_id: "1234".into(),
                wecom_account_id: Some("wa-1".into()),
                ..Default::default()
            },
        );
        let json = serde_json::to_string(&n).unwrap();
        assert!(json.contains("\"topic\":\"recent-sessions\""));
        assert!(json.contains("\"employeeId\":\"1234\""));
        assert!(json.contains("\"wecomAccountId\":\"wa-1\""));
        assert!(json.contains("\"kind\":\"upsert\""));
        assert!(json.contains("\"source\":\"server-event\""));
        // None 字段应被跳过
        assert!(!json.contains("conversationId"));
    }

    #[test]
    fn serialize_conversation_messages_topic() {
        let n = ChangeNotice::server_upsert(
            ChangeTopic::ConversationMessages,
            ChangeScope {
                employee_id: "u-1".into(),
                conversation_id: Some("c1".into()),
                ..Default::default()
            },
        );
        let json = serde_json::to_string(&n).unwrap();
        assert!(json.contains("\"topic\":\"conversation-messages\""));
        assert!(json.contains("\"conversationId\":\"c1\""));
    }

    // ─── ChangeCoalescer ────────────────────────────────────────────────────

    /// 指定 occurred_at_ms 的 server-event upsert(scope 仅 employee + 可选 account)。
    fn notice(topic: ChangeTopic, emp: &str, acct: Option<&str>, at_ms: i64) -> ChangeNotice {
        ChangeNotice {
            topic,
            scope: ChangeScope {
                employee_id: emp.into(),
                wecom_account_id: acct.map(Into::into),
                ..Default::default()
            },
            kind: ChangeKind::Upsert,
            source: ChangeSource::ServerEvent,
            occurred_at_ms: at_ms,
        }
    }

    #[test]
    fn coalescer_keeps_latest_per_scope() {
        let mut c = ChangeCoalescer::new();
        assert!(c.is_empty());
        c.merge(notice(
            ChangeTopic::RecentSessions,
            "u-1",
            Some("wa-1"),
            100,
        ));
        c.merge(notice(
            ChangeTopic::RecentSessions,
            "u-1",
            Some("wa-1"),
            300,
        ));
        c.merge(notice(
            ChangeTopic::RecentSessions,
            "u-1",
            Some("wa-1"),
            200,
        ));
        let out = c.drain_ordered();
        assert_eq!(out.len(), 1, "同 (topic,scope) 合并成一条");
        assert_eq!(out[0].occurred_at_ms, 300, "保留最新一条");
        assert!(c.is_empty(), "drain 后清空");
    }

    #[test]
    fn coalescer_distinct_scopes_not_merged() {
        let mut c = ChangeCoalescer::new();
        // 不同 account → 不合并
        c.merge(notice(
            ChangeTopic::RecentSessions,
            "u-1",
            Some("wa-1"),
            100,
        ));
        c.merge(notice(
            ChangeTopic::RecentSessions,
            "u-1",
            Some("wa-2"),
            100,
        ));
        // 不同 topic → 不合并
        c.merge(notice(ChangeTopic::Friends, "u-1", Some("wa-1"), 100));
        // 不同 employee → 不合并
        c.merge(notice(
            ChangeTopic::RecentSessions,
            "u-2",
            Some("wa-1"),
            100,
        ));
        assert_eq!(c.drain_ordered().len(), 4);
    }

    #[test]
    fn coalescer_drain_is_time_ordered() {
        let mut c = ChangeCoalescer::new();
        c.merge(notice(
            ChangeTopic::RecentSessions,
            "u-1",
            Some("wa-3"),
            300,
        ));
        c.merge(notice(
            ChangeTopic::RecentSessions,
            "u-1",
            Some("wa-1"),
            100,
        ));
        c.merge(notice(
            ChangeTopic::RecentSessions,
            "u-1",
            Some("wa-2"),
            200,
        ));
        let times: Vec<i64> = c.drain_ordered().iter().map(|n| n.occurred_at_ms).collect();
        assert_eq!(times, vec![100, 200, 300], "按 occurred_at_ms 升序");
    }

    #[test]
    fn coalescer_bulk_precedence_survives_later_upsert() {
        let mut c = ChangeCoalescer::new();
        // 先 bulk(旧),后 upsert(新)同 scope → 合并结果仍是 BulkInvalidate,但取新的时间戳。
        let mut bulk = notice(ChangeTopic::RecentSessions, "u-1", Some("wa-1"), 100);
        bulk.kind = ChangeKind::BulkInvalidate;
        c.merge(bulk);
        c.merge(notice(
            ChangeTopic::RecentSessions,
            "u-1",
            Some("wa-1"),
            300,
        ));
        let out = c.drain_ordered();
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].kind,
            ChangeKind::BulkInvalidate,
            "bulk 不被随后 upsert 降级"
        );
        assert_eq!(out[0].occurred_at_ms, 300, "时间取更新者");
    }

    #[test]
    fn coalescer_bulk_precedence_when_bulk_arrives_later() {
        let mut c = ChangeCoalescer::new();
        // 先 upsert(旧),后 bulk(新)→ 同样升级为 BulkInvalidate。
        c.merge(notice(
            ChangeTopic::RecentSessions,
            "u-1",
            Some("wa-1"),
            100,
        ));
        let mut bulk = notice(ChangeTopic::RecentSessions, "u-1", Some("wa-1"), 300);
        bulk.kind = ChangeKind::BulkInvalidate;
        c.merge(bulk);
        let out = c.drain_ordered();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, ChangeKind::BulkInvalidate);
    }
}
