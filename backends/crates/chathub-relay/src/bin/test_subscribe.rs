//! chathub-test-subscribe — 本地联调辅助:用预签 JWT 直接调 hub.Subscribe,持续打印事件。
//!
//! 用法(env 入参):
//!   TOKEN=$(USER_ID=u-test ACCOUNTS=wa-1 cargo run -q -p chathub-relay --bin chathub-mint-jwt) \
//!     ACCOUNTS=wa-1 [RELAY_URL=http://127.0.0.1:50051] \
//!     cargo run -p chathub-relay --bin chathub-test-subscribe
//!
//! ACCOUNTS 控制 SubscribeRequest.since_seqs 的 keys(value 全 0,从最新开始)。

use chathub_proto::v1::hub_client::HubClient;
use chathub_proto::v1::SubscribeRequest;
use std::collections::HashMap;
use std::time::Duration;
use tonic::metadata::MetadataValue;
use tonic::transport::{Channel, Endpoint};
use tonic::Request;

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let url = std::env::var("RELAY_URL").unwrap_or_else(|_| "http://127.0.0.1:50051".to_string());
    let token = std::env::var("TOKEN")
        .map_err(|_| anyhow::anyhow!("TOKEN env required (mint via chathub-mint-jwt)"))?;

    let mut since_seqs: HashMap<String, i64> = HashMap::new();
    if let Ok(s) = std::env::var("ACCOUNTS") {
        for a in s.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
            since_seqs.insert(a.to_string(), 0);
        }
    }

    let channel: Channel = Endpoint::from_shared(url.clone())?
        .http2_keep_alive_interval(Duration::from_secs(10))
        .keep_alive_timeout(Duration::from_secs(5))
        .keep_alive_while_idle(true)
        .connect_timeout(Duration::from_secs(8))
        .connect()
        .await?;

    let bearer: MetadataValue<_> = format!("Bearer {token}").parse()?;
    let mut hub = HubClient::with_interceptor(channel, move |mut req: Request<()>| {
        let md = req.metadata_mut();
        md.insert("authorization", bearer.clone());
        md.insert("chathub-protocol-version", MetadataValue::from_static("1"));
        md.insert(
            "chathub-client-version",
            MetadataValue::from_static("test-client"),
        );
        md.insert("chathub-platform", MetadataValue::from_static("test"));
        Ok(req)
    });

    eprintln!(
        "[client] subscribing url={url} accounts={:?}",
        since_seqs.keys().collect::<Vec<_>>()
    );
    let mut stream = hub
        .subscribe(SubscribeRequest { since_seqs })
        .await?
        .into_inner();

    while let Some(evt) = stream.message().await? {
        println!(
            "[event] account={} seq={} body={:?}",
            evt.wecom_account_id, evt.seq, evt.body
        );
    }
    eprintln!("[client] stream closed");
    Ok(())
}
