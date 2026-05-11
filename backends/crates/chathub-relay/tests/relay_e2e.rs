//! Plan 5 e2e:7 个场景。fixture 在 common/mod.rs。
//! 所有测试 #[tokio::test(flavor = "multi_thread")] — 否则 wiremock + tonic
//! 共享 runtime 会死锁(spec §12.3,风险 R6)。

mod common;

use common::{mint_jwt, spawn_relay};

#[tokio::test(flavor = "multi_thread")]
async fn fixture_self_test_healthz_returns_ok() {
    let h = spawn_relay().await;
    let resp = reqwest::get(format!("{}/healthz", h.push_url))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = mint_jwt(&h.signer, "u-1", vec!["wa-1".into()], "dev-A");
}
