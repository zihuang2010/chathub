use std::path::Path;

use time::macros::format_description;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling;
use tracing_subscriber::fmt::time::LocalTime;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter, Layer};

/// 日志级别运行时控制(设置页"日志级别"用)。
/// `CHATHUB_LOG` 环境变量仍是最高优先级排障后门:显式设置时,设置页的级别不生效。
pub struct LogControl {
    handle: tracing_subscriber::reload::Handle<EnvFilter, tracing_subscriber::Registry>,
    env_override: bool,
}

impl LogControl {
    /// 热切换 EnvFilter。`CHATHUB_LOG` 已显式设置时 no-op(env 优先)。
    pub fn set_directives(&self, directives: &str) {
        if self.env_override {
            return;
        }
        if let Err(e) = self.handle.reload(EnvFilter::new(directives)) {
            tracing::warn!(error = %e, directives, "日志级别热切换失败");
        }
    }
}

pub fn init(log_dir: &Path) -> anyhow::Result<(WorkerGuard, LogControl)> {
    std::fs::create_dir_all(log_dir)?;

    let file_appender = rolling::daily(log_dir, "chathub.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    let timer = LocalTime::new(format_description!(
        "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:3]"
    ));

    let env_override = std::env::var("CHATHUB_LOG").is_ok();
    let env_filter = EnvFilter::try_from_env("CHATHUB_LOG")
        // 默认放开 chathub_net=debug:推送链路(subscribe/PushBatch 收帧/SubscribeAck/流错误)
        // 的日志 target 为 chathub_net::hub,不在 chathub 命名空间下;不加这段则收帧与 ack 的
        // debug 全被过滤,排查 Windows 收不到推送时日志里看不到关键证据。
        .unwrap_or_else(|_| EnvFilter::new("info,chathub=debug,chathub_net=debug"));

    // reload 包一层:设置页"日志级别"运行时热切换(update_settings → LogControl::set_directives)。
    let (filter_layer, reload_handle) = tracing_subscriber::reload::Layer::new(env_filter);

    let stdout_layer = fmt::layer()
        .with_timer(timer.clone())
        .with_target(true)
        .with_ansi(true)
        .with_writer(std::io::stdout);

    let file_layer = fmt::layer()
        .with_timer(timer)
        .with_target(true)
        .with_ansi(false)
        .with_writer(file_writer);

    tracing_subscriber::registry()
        .with(filter_layer)
        .with(stdout_layer.boxed())
        .with(file_layer.boxed())
        .init();

    Ok((
        guard,
        LogControl {
            handle: reload_handle,
            env_override,
        },
    ))
}
