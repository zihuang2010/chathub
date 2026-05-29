//! chathub-relay — Rust gRPC gateway。
//!
//! 模块组织:
//!   - config / error / router / downstream
//!   - storage::{seqs, events, kv, migrations}
//!   - auth_service(纯透传)/ hub_service(verifyToken 认证)/ push
//!
//! Relay 退化为纯隔道:不签发、不存储 token,认证委托业务后台 verifyToken。

pub mod auth_service;
pub mod config;
pub mod downstream;
pub mod error;
pub mod event_policy;
pub mod hub_service;
pub mod nacos;
pub mod push;
pub mod router;
pub mod secret;
pub mod storage;
