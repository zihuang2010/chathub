//! chathub-test-subscribe — 本地联调辅助:直接调 hub.Subscribe(v2),持续打印事件。
//!
//! 用法:
//!   TOKEN=<biz-token> SINCE=0 DEVICE_ID=dev-A \
//!     [RELAY_URL=http://127.0.0.1:50051] \
//!     cargo run -p chathub-relay --bin chathub-test-subscribe
//!
//! TOKEN  = 业务后台签发的 access_token(由业务后台 /v1/verify_token 验证)
//! SINCE  = since_notify_seq(0 = 首连只接实时)
//! DEVICE_ID = 客户端生成的设备标识

use chathub_proto::v1::hub_client::HubClient;
use chathub_proto::v1::SubscribeRequest;
use std::time::Duration;
use tonic::metadata::MetadataValue;
use tonic::transport::{Channel, Endpoint};
use tonic::Request;

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let url = std::env::var("RELAY_URL").unwrap_or_else(|_| "http://127.0.0.1:50051".to_string());
    let token = std::env::var("TOKEN")
        .map_err(|_| anyhow::anyhow!("TOKEN env required (业务后台签发的 access_token)"))?;
    let since: u64 = std::env::var("SINCE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let device_id = std::env::var("DEVICE_ID").unwrap_or_else(|_| "test-device".to_string());

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

    eprintln!("[client] subscribing url={url} since={since} device_id={device_id}");
    let mut stream = hub
        .subscribe(SubscribeRequest {
            since_notify_seq: since,
            device_id,
            client_version: "test-client".into(),
        })
        .await?
        .into_inner();

    while let Some(evt) = stream.message().await? {
        println!("[event] body={:?}", evt.body);
    }
    eprintln!("[client] stream closed");
    Ok(())
}
