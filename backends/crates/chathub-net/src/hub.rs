//! Hub client + ConnectionManager(Plan 3)。
//!
//! 公共 API(后续 task 渐进填充):
//!   - `HubClient`:Send + Subscribe(thin wrapper over tonic client)
//!   - `ConnectionManager`:状态机 + 后台 task + 事件总线
//!   - `ConnectionState`:Connecting / Subscribed / Disconnected{last_error}
//!   - `BackoffConfig` + `ExponentialBackoff`:重连退避配置与计算
//!   - `classify`:tonic Status → Action 路径分流

use crate::error::AuthError;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 重连退避配置。生产默认 1s/2x/15s full jitter,测试通常用 10ms/2x/150ms 加速。
#[derive(Clone, Debug)]
pub struct BackoffConfig {
    pub base: Duration,
    pub factor: f64,
    pub cap: Duration,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            base: Duration::from_secs(1),
            factor: 2.0,
            cap: Duration::from_secs(15),
        }
    }
}

/// 对前端暴露的 3 状态机。`hub:connection` 事件 payload 序列化此 enum。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ConnectionState {
    Connecting,
    Subscribed,
    Disconnected {
        #[serde(skip_serializing_if = "Option::is_none")]
        last_error: Option<AuthError>,
    },
}

/// Full jitter 指数退避。`next()` 返回 `[0, min(cap, base * factor^attempt))` 的随机时长。
#[allow(dead_code)]
pub(crate) struct ExponentialBackoff {
    base: Duration,
    factor: f64,
    cap: Duration,
    attempt: u32,
}

#[allow(dead_code)]
impl ExponentialBackoff {
    pub fn new(cfg: &BackoffConfig) -> Self {
        Self {
            base: cfg.base,
            factor: cfg.factor,
            cap: cfg.cap,
            attempt: 0,
        }
    }

    /// 下一次退避时长。attempt 饱和加,不溢出。
    pub fn next(&mut self) -> Duration {
        let exp = self.factor.powi(self.attempt as i32);
        let raw_ms = (self.base.as_millis() as f64) * exp;
        let cap_ms = self.cap.as_millis() as f64;
        let bound_ms = raw_ms.min(cap_ms);
        // full jitter:[0, bound_ms)
        let jittered_ms = rand::random::<f64>() * bound_ms;
        self.attempt = self.attempt.saturating_add(1);
        Duration::from_millis(jittered_ms as u64)
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_cfg() -> BackoffConfig {
        BackoffConfig {
            base: Duration::from_millis(10),
            factor: 2.0,
            cap: Duration::from_millis(150),
        }
    }

    #[test]
    fn exponential_backoff_first_call_within_1x_base() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        let d = b.next();
        // attempt=0 → bound = base * 2^0 = base = 10ms;jittered ∈ [0, 10ms)
        assert!(d <= Duration::from_millis(10), "got {d:?}");
    }

    #[test]
    fn exponential_backoff_caps_at_cap() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        // 跑 20 次,attempt 远超 cap 阈值;每次都应 ≤ cap
        for _ in 0..20 {
            let d = b.next();
            assert!(d <= Duration::from_millis(150), "got {d:?}");
        }
    }

    #[test]
    fn exponential_backoff_reset_zeroes_attempt() {
        let mut b = ExponentialBackoff::new(&fast_cfg());
        for _ in 0..5 {
            let _ = b.next();
        }
        b.reset();
        // reset 后 attempt=0,bound = base * 2^0 = 10ms
        let d = b.next();
        assert!(d <= Duration::from_millis(10), "got {d:?}");
    }

    #[test]
    fn connection_state_connecting_serializes_kebab_case_tag() {
        let s = ConnectionState::Connecting;
        let json = serde_json::to_string(&s).expect("serialize");
        assert_eq!(json, r#"{"state":"connecting"}"#);
    }

    #[test]
    fn connection_state_subscribed_serializes() {
        let s = ConnectionState::Subscribed;
        let json = serde_json::to_string(&s).expect("serialize");
        assert_eq!(json, r#"{"state":"subscribed"}"#);
    }

    #[test]
    fn connection_state_disconnected_no_error_omits_field() {
        let s = ConnectionState::Disconnected { last_error: None };
        let json = serde_json::to_string(&s).expect("serialize");
        assert_eq!(json, r#"{"state":"disconnected"}"#);
    }

    #[test]
    fn connection_state_disconnected_with_error_includes_field() {
        let s = ConnectionState::Disconnected {
            last_error: Some(AuthError::Unauthenticated),
        };
        let json = serde_json::to_string(&s).expect("serialize");
        // AuthError 已 serde derive(kind=unauthenticated),嵌套即可
        assert!(json.contains(r#""state":"disconnected""#), "{json}");
        assert!(json.contains(r#""last_error""#), "{json}");
        assert!(json.contains(r#""kind":"unauthenticated""#), "{json}");
    }
}
