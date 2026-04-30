use std::path::Path;

use time::macros::format_description;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling;
use tracing_subscriber::fmt::time::LocalTime;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter, Layer};

pub fn init(log_dir: &Path) -> anyhow::Result<WorkerGuard> {
    std::fs::create_dir_all(log_dir)?;

    let file_appender = rolling::daily(log_dir, "chathub.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    let timer = LocalTime::new(format_description!(
        "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:3]"
    ));

    let env_filter = EnvFilter::try_from_env("CHATHUB_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,chathub=debug"));

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
        .with(env_filter)
        .with(stdout_layer.boxed())
        .with(file_layer.boxed())
        .init();

    Ok(guard)
}
