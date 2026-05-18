//! Event policy —— relay 唯一需要的"业务知识"。
//!
//! 业务后台 push 的每个 event 有一个字符串 `eventType`(spec §6 定义了 6 种)。
//! relay 不解析业务 payload,但要决定:
//!   - **Persist**:写入 hub_events 事件日志(离线漏掉会让客户端 UI 显示错状态;
//!     续点必须能补)。
//!   - **ControlOnly**:不入库,fanout 后执行特殊控制动作(目前只有
//!     `CONNECTION_FORCE_CLOSE`:推给客户端后启动 grace timer 关闭连接)。
//!
//! 未知 `eventType` 默认 **Persist**(向前兼容业务后台先升级 — relay 至少能保
//! 住事件给客户端续点,只是不知道是否需要特殊控制动作)。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventPolicy {
    /// 写入 hub_events 事件日志,fanout 给在线连接(由 stage 3.5+ 的 router 完成)。
    Persist,
    /// 不入库;仅 fanout 后触发控制动作(force_close grace timer 等)。
    ControlOnly,
}

pub fn policy(event_type: &str) -> EventPolicy {
    match event_type {
        "MESSAGE_UPSERT"
        | "SESSION_SUMMARY_UPSERT"
        | "FRIEND_UPSERT"
        | "ACCOUNT_BINDING_CHANGE"
        | "ACCOUNT_STATUS_CHANGE" => EventPolicy::Persist,
        "CONNECTION_FORCE_CLOSE" => EventPolicy::ControlOnly,
        _ => EventPolicy::Persist,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_persist_types_classified_as_persist() {
        for t in [
            "MESSAGE_UPSERT",
            "SESSION_SUMMARY_UPSERT",
            "FRIEND_UPSERT",
            "ACCOUNT_BINDING_CHANGE",
            "ACCOUNT_STATUS_CHANGE",
        ] {
            assert_eq!(policy(t), EventPolicy::Persist, "for {t}");
        }
    }

    #[test]
    fn force_close_classified_as_control_only() {
        assert_eq!(policy("CONNECTION_FORCE_CLOSE"), EventPolicy::ControlOnly);
    }

    #[test]
    fn unknown_type_defaults_to_persist() {
        // 向前兼容:业务后台先升级时,relay 仍然保住事件等续点
        assert_eq!(policy("FUTURE_EVENT_TYPE"), EventPolicy::Persist);
        assert_eq!(policy(""), EventPolicy::Persist);
    }
}
