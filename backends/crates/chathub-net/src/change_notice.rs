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
}
