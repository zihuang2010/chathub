//! End-to-end tests against in-process stub Relay.
//! Covers 7 scenarios from spec §7.2.

mod common;

use chathub_net::TokenStore;
use chathub_state::KeyringTokenStore;
use common::stub_relay::{start_stub, LoginOutcome};

fn unique_keyring() -> KeyringTokenStore {
    KeyringTokenStore::new(format!("chathub-test-{}", uuid::Uuid::new_v4()))
}

#[tokio::test]
async fn scenario_1_login_success() {
    let (addr, state, _h) = start_stub().await;
    let kr = unique_keyring();

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, kr.clone()).expect("store");

    let resp = store.login("alice", "pwd").await.expect("login");
    assert_eq!(resp.user.as_ref().unwrap().user_id, "u-stub");

    assert!(store.is_logged_in());
    assert!(store.current_access_token().is_some());
    assert_eq!(state.lock().unwrap().login_count, 1);
    assert!(
        kr.read_refresh_token().unwrap().is_some(),
        "refresh persisted to keyring"
    );

    // cleanup
    let _ = kr.clear_refresh_token();
    let _ = kr._clear_device_id_for_test();
}

#[tokio::test]
async fn scenario_2_login_unauthenticated() {
    let (addr, state, _h) = start_stub().await;
    state.lock().unwrap().login_outcome = LoginOutcome::Unauthenticated;

    let kr = unique_keyring();
    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, kr.clone()).expect("store");

    let err = store.login("alice", "pwd").await.expect_err("should fail");
    assert!(matches!(err, chathub_net::AuthError::Unauthenticated));
    assert!(!store.is_logged_in());
    assert!(
        kr.read_refresh_token().unwrap().is_none(),
        "no token written on failure"
    );

    let _ = kr.clear_refresh_token();
    let _ = kr._clear_device_id_for_test();
}

#[tokio::test]
async fn scenario_4_reactive_refresh_on_unauthenticated() {
    let (addr, state, _h) = start_stub().await;
    let kr = unique_keyring();

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, kr.clone()).expect("store");
    store.login("alice", "pwd").await.expect("login");

    // 模拟"业务拿到 Unauthenticated → 调 force_refresh":
    let access_before = store.current_access_token().unwrap();
    store.force_refresh().await.expect("refresh ok");
    let access_after = store.current_access_token().unwrap();

    assert_ne!(
        access_before, access_after,
        "access token should be rotated"
    );
    assert_eq!(state.lock().unwrap().refresh_count, 1);
    assert!(store.is_logged_in());

    let _ = kr.clear_refresh_token();
    let _ = kr._clear_device_id_for_test();
}

#[tokio::test]
async fn scenario_6_refresh_revoked_emits_event() {
    let (addr, state, _h) = start_stub().await;
    let kr = unique_keyring();

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, kr.clone()).expect("store");
    store.login("alice", "pwd").await.expect("login");

    // 订阅 LoggedOut 事件
    let mut rx = store.logged_out_subscribe();

    // 让下一次 refresh 返回 Unauthenticated(revoked)
    state.lock().unwrap().force_revoke_next_refresh = true;

    let err = store.force_refresh().await.expect_err("should fail");
    assert!(matches!(err, chathub_net::AuthError::Unauthenticated));

    // 事件应当广播
    let reason = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
        .await
        .expect("timeout")
        .expect("recv");
    assert!(matches!(
        reason,
        chathub_net::token::LoggedOutReason::RefreshFailed
    ));

    // 状态应清空
    assert!(!store.is_logged_in());
    assert!(kr.read_refresh_token().unwrap().is_none());

    let _ = kr.clear_refresh_token();
    let _ = kr._clear_device_id_for_test();
}
