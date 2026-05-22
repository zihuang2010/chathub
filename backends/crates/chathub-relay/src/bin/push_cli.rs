//! chathub-push-cli — 本地联调用的 relay /rpc/v1/wecomAggregate/notify/push 推送工具。
//!
//! 背景:
//!   mock-downstream 只是 HTTP 业务后台,无法触发 Subscribe 事件流;接待列表的
//!   MESSAGE_UPSERT / fallback 节流 / unread 更新逻辑只能通过给 relay 的
//!   `/rpc/v1/wecomAggregate/notify/push` 端点手动推事件来联调。本 CLI 就是干这个的。
//!
//! 用法:
//!   cargo run -p chathub-relay --bin chathub-push-cli -- \
//!     --secret $RELAY_PUSH_SECRET \
//!     --employee-id 1234 \
//!     --conversation-id cv-wa-bj-zhe-000
//!
//! 完整选项(都有合理默认):
//!   --relay <url>             默认 http://127.0.0.1:50052
//!   --secret <secret>         必填(或从 RELAY_PUSH_SECRET env 读)
//!   --client-id <id>          默认 rh_wxchat(必须在 RELAY_ALLOWED_CLIENT_IDS 白名单内)
//!   --employee-id <i64>       必填
//!   --conversation-id <cv-id> 必填;wecom-account-id/external-user-id 默认从此派生
//!   --wecom-account-id <id>   默认从 conversation-id 取中段(cv-<acct>-NNN → <acct>)
//!   --external-user-id <id>   默认 "wo-<wecom-account-id>-<NNN>"
//!   --event-type <type>       默认 MESSAGE_UPSERT;可选 SESSION_SUMMARY_UPSERT
//!   --summary <text>          默认 "[push-cli test] <timestamp>"
//!   --notify-seq <u64>        默认 now epoch ms(粗糙单调,跨进程不保证)
//!   --repeat <N>              发送次数,默认 1
//!   --interval-ms <ms>        多次发送时的间隔,默认 1000
//!
//! 联调最小路径:
//!   1. 跑 relay (含 mock-downstream 在 50051):RELAY_PUSH_SECRET=xxx cargo run -p chathub-relay
//!   2. 跑 chathub-mock-downstream
//!   3. 启 Tauri 客户端,登录(mock employee_id=1234)
//!   4. 客户端列表里挑一条会话(如 cv-wa-bj-zhe-000),copy id
//!   5. 跑本 CLI 推该 conversation 的 MESSAGE_UPSERT 事件
//!   6. 客户端列表该行应自动刷新 lastMessageSummary

use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PushBatchIn {
    notify_seq: u64,
    client_id: String,
    employee_id: i64,
    batch_id: String,
    batch_time: String,
    events: Vec<serde_json::Value>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("argument error: {e}");
            eprintln!("\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    let client = reqwest::Client::new();
    let url = format!(
        "{}/rpc/v1/wecomAggregate/notify/push",
        args.relay.trim_end_matches('/')
    );

    for i in 0..args.repeat {
        let notify_seq = args.notify_seq.unwrap_or_else(|| now_ms() as u64) + i as u64;
        let event = build_event(&args);
        let body = PushBatchIn {
            notify_seq,
            client_id: args.client_id.clone(),
            employee_id: args.employee_id,
            batch_id: format!("push-cli-{}", uuid::Uuid::new_v4().simple()),
            batch_time: now_local_string(),
            events: vec![event],
        };

        let resp = client
            .post(&url)
            .bearer_auth(&args.secret)
            .json(&body)
            .send()
            .await;

        match resp {
            Ok(r) => {
                let status = r.status();
                let text = r.text().await.unwrap_or_default();
                if status.is_success() {
                    println!(
                        "[{}/{}] OK {status}  notify_seq={notify_seq}  resp={text}",
                        i + 1,
                        args.repeat
                    );
                } else {
                    eprintln!(
                        "[{}/{}] FAIL {status}  notify_seq={notify_seq}  resp={text}",
                        i + 1,
                        args.repeat
                    );
                    return ExitCode::from(1);
                }
            }
            Err(e) => {
                eprintln!("[{}/{}] network error: {e}", i + 1, args.repeat);
                return ExitCode::from(1);
            }
        }

        if i + 1 < args.repeat {
            tokio::time::sleep(Duration::from_millis(args.interval_ms)).await;
        }
    }

    ExitCode::SUCCESS
}

const USAGE: &str = "Usage:\n  chathub-push-cli --secret <s> --employee-id <i64> --conversation-id <cv-id> [...]\n\nSee file header for full options.";

struct Args {
    relay: String,
    secret: String,
    client_id: String,
    employee_id: i64,
    conversation_id: String,
    wecom_account_id: String,
    external_user_id: String,
    event_type: String,
    summary: String,
    notify_seq: Option<u64>,
    repeat: u32,
    interval_ms: u64,
}

fn parse_args() -> Result<Args, String> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let mut map: HashMap<String, String> = HashMap::new();
    let mut i = 0;
    while i < raw.len() {
        let key = raw[i].clone();
        if !key.starts_with("--") {
            return Err(format!("expected --flag, got {key}"));
        }
        let val = raw
            .get(i + 1)
            .cloned()
            .ok_or_else(|| format!("flag {key} missing value"))?;
        map.insert(key.trim_start_matches("--").to_string(), val);
        i += 2;
    }

    let relay = map
        .remove("relay")
        .unwrap_or_else(|| "http://127.0.0.1:50052".to_string());
    let secret = map
        .remove("secret")
        .or_else(|| std::env::var("RELAY_PUSH_SECRET").ok())
        .ok_or("--secret required (or set RELAY_PUSH_SECRET env)")?;
    let client_id = map
        .remove("client-id")
        .unwrap_or_else(|| "rh_wxchat".into());
    let employee_id: i64 = map
        .remove("employee-id")
        .ok_or("--employee-id required")?
        .parse()
        .map_err(|_| "--employee-id must be i64")?;
    let conversation_id = map
        .remove("conversation-id")
        .ok_or("--conversation-id required")?;

    // 从 conversation_id 派生默认 wecom_account_id / external_user_id
    // 约定形态:cv-<wecom_account_id>-<NNN>(mock-downstream::generate_recent_sessions 用此格式)
    let (default_acct, default_ext) = derive_from_conv(&conversation_id);
    let wecom_account_id = map.remove("wecom-account-id").unwrap_or(default_acct);
    let external_user_id = map.remove("external-user-id").unwrap_or(default_ext);

    let event_type = map
        .remove("event-type")
        .unwrap_or_else(|| "MESSAGE_UPSERT".into());
    let summary = map
        .remove("summary")
        .unwrap_or_else(|| format!("[push-cli test] {}", now_local_string()));
    let notify_seq = match map.remove("notify-seq") {
        Some(s) => Some(s.parse().map_err(|_| "--notify-seq must be u64")?),
        None => None,
    };
    let repeat: u32 = match map.remove("repeat") {
        Some(s) => s.parse().map_err(|_| "--repeat must be u32")?,
        None => 1,
    };
    let interval_ms: u64 = match map.remove("interval-ms") {
        Some(s) => s.parse().map_err(|_| "--interval-ms must be u64")?,
        None => 1000,
    };

    if !map.is_empty() {
        return Err(format!(
            "unknown flag(s): {:?}",
            map.keys().collect::<Vec<_>>()
        ));
    }

    Ok(Args {
        relay,
        secret,
        client_id,
        employee_id,
        conversation_id,
        wecom_account_id,
        external_user_id,
        event_type,
        summary,
        notify_seq,
        repeat,
        interval_ms,
    })
}

/// cv-wa-bj-zhe-000 → ("wa-bj-zhe", "wo-wa-bj-zhe-000")
/// 形态识别失败时返 ("wa-unknown", "wo-unknown")。
fn derive_from_conv(conv: &str) -> (String, String) {
    // strip leading "cv-",取剩下到最后一个 "-NNN" 之前为 account_id
    let s = conv.strip_prefix("cv-").unwrap_or(conv);
    if let Some(last_dash) = s.rfind('-') {
        let acct = &s[..last_dash];
        let suffix = &s[last_dash..];
        if !acct.is_empty() {
            return (acct.to_string(), format!("wo-{acct}{suffix}"));
        }
    }
    ("wa-unknown".into(), "wo-unknown".into())
}

fn build_event(args: &Args) -> serde_json::Value {
    json!({
        "eventType": args.event_type,
        "eventReason": "CUSTOMER_MESSAGE_RECEIVED",
        "conversationId": args.conversation_id,
        "wecomAccountId": args.wecom_account_id,
        "wecomName": "客服(push-cli)",
        "wecomAccount": format!("mock_{}", args.wecom_account_id),
        "wecomAlias": "客服(push-cli)",
        "externalUserId": args.external_user_id,
        "externalName": "外部用户(push-cli)",
        "externalAvatar": "",
        "externalMobile": "138****0000",
        "lastLocalMessageId": format!("lm-{}", uuid::Uuid::new_v4().simple()),
        "lastMessageType": 1,
        "lastMessageDirection": 1,
        "lastSendStatus": 3,
        "lastMessageSummary": args.summary,
        "lastMessageTime": now_iso8601_utc(),
        "unreadCount": 1,
        "hasUnread": true,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_iso8601_utc() -> String {
    let secs = now_ms() / 1000;
    let (y, mo, d, h, mi, s) = ymdhms_from_unix(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
}

fn now_local_string() -> String {
    // UTC+8 简化(跟 mock_downstream 一致)
    let secs = now_ms() / 1000 + 8 * 3600;
    let (y, mo, d, h, mi, s) = ymdhms_from_unix(secs);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
}

/// Howard Hinnant 简化:unix 秒 → (年, 月, 日, 时, 分, 秒)。
fn ymdhms_from_unix(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86400);
    let secs_in_day = secs.rem_euclid(86400) as u32;
    let h = secs_in_day / 3600;
    let mi = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, h, mi, s)
}
