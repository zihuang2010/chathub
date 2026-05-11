//! Hub client + ConnectionManager(Plan 3)。
//!
//! 公共 API(后续 task 渐进填充):
//!   - `HubClient`:Send + Subscribe(thin wrapper over tonic client)
//!   - `ConnectionManager`:状态机 + 后台 task + 事件总线
//!   - `ConnectionState`:Connecting / Subscribed / Disconnected{last_error}
//!   - `BackoffConfig` + `ExponentialBackoff`:重连退避配置与计算
//!   - `classify`:tonic Status → Action 路径分流

// 后续 Task 5-9 渐进填入。现在先放占位避免空 mod。
#[cfg(test)]
mod tests {
    #[test]
    fn placeholder() {}
}
