//! End-to-end tests against in-process stub Relay。
//!
//! Relay 退化为纯隔道后,客户端不做续签:覆盖 login / logout / 冷启动 resume。

mod common;

use chathub_net::{AuthApi, TokenStore};
use chathub_state::{LocalTokenStore, SessionStore, SqlitePool};
use common::stub_relay::{start_stub, LoginOutcome};
use std::sync::Arc;

async fn fresh_local() -> LocalTokenStore {
    let pool = SqlitePool::in_memory().await.expect("pool");
    LocalTokenStore::new(pool)
}

#[tokio::test]
async fn scenario_1_login_success_persists_token() {
    let (addr, state, _h) = start_stub().await;
    let local = fresh_local().await;

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, local, "dev-1".into());

    let resp = store.login("alice", "pwd").await.expect("login");
    assert_eq!(resp.user.as_ref().unwrap().user_id, "u-stub");

    assert!(store.is_logged_in());
    assert!(store.current_access_token().is_some());
    assert_eq!(state.lock().unwrap().login_count, 1);
    // token 持久化到本地 SQLite(冷启动 resume 用)
    assert!(
        store.try_load_token().await.is_some(),
        "token persisted to local SQLite"
    );
}

#[tokio::test]
async fn scenario_2_login_unauthenticated_writes_nothing() {
    let (addr, state, _h) = start_stub().await;
    state.lock().unwrap().login_outcome = LoginOutcome::Unauthenticated;

    let local = fresh_local().await;
    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, local, "dev-1".into());

    let err = store.login("alice", "pwd").await.expect_err("should fail");
    assert!(matches!(err, chathub_net::AuthError::Unauthenticated));
    assert!(!store.is_logged_in());
    assert!(
        store.try_load_token().await.is_none(),
        "no token written on failure"
    );
}

#[tokio::test]
async fn scenario_5_logout_emits_event_and_clears_token() {
    let (addr, state, _h) = start_stub().await;
    let local = fresh_local().await;

    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");
    let store = TokenStore::new(ep, local, "dev-1".into());
    store.login("alice", "pwd").await.expect("login");

    let mut rx = store.logged_out_subscribe();
    store.logout().await.expect("logout");

    let reason = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
        .await
        .expect("timeout")
        .expect("recv");
    assert!(matches!(
        reason,
        chathub_net::token::LoggedOutReason::Manual
    ));

    assert!(!store.is_logged_in());
    assert!(store.try_load_token().await.is_none());
    assert_eq!(state.lock().unwrap().logout_count, 1);
}

#[tokio::test]
async fn scenario_7_resume_after_restart_loads_local_token() {
    let (addr, _state, _h) = start_stub().await;
    // 同一个 pool 模拟磁盘:跨"重启"持久化 token + profile
    let pool = SqlitePool::in_memory().await.expect("pool");
    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");

    // ── 第一次运行:登录 ──
    let store1 = Arc::new(TokenStore::new(
        ep.clone(),
        LocalTokenStore::new(pool.clone()),
        "dev-1".into(),
    ));
    let api1 = AuthApi::new(store1.clone(), SessionStore::new(pool.clone()));
    api1.login("alice", "pwd").await.expect("login");
    drop(api1);
    drop(store1);

    // ── "进程重启":新 TokenStore + 新 AuthApi,共用同一 pool ──
    let store2 = Arc::new(TokenStore::new(
        ep,
        LocalTokenStore::new(pool.clone()),
        "dev-1".into(),
    ));
    let api2 = AuthApi::new(store2.clone(), SessionStore::new(pool));
    let resumed = api2.try_resume_session().await.expect("resume");

    assert!(resumed.is_some(), "should resume session from local SQLite");
    assert_eq!(resumed.unwrap().user_id, "u-stub");
    assert!(store2.is_logged_in());
    // resume 不发任何网络请求(不续签)
}

#[tokio::test]
async fn resume_with_no_local_token_returns_none() {
    let (addr, _state, _h) = start_stub().await;
    let pool = SqlitePool::in_memory().await.expect("pool");
    let ep = chathub_net::build_endpoint(format!("http://{addr}")).expect("ep");

    let store = Arc::new(TokenStore::new(
        ep,
        LocalTokenStore::new(pool.clone()),
        "dev-1".into(),
    ));
    let api = AuthApi::new(store.clone(), SessionStore::new(pool));
    let resumed = api.try_resume_session().await.expect("resume");
    assert!(resumed.is_none(), "no local token → no session");
    assert!(!store.is_logged_in());
}
