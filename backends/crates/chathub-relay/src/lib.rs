//! chathub-relay — Rust gRPC gateway (Plan 5 walking skeleton).
//!
//! 模块组织(后续 task 填):
//!   - config / error / jwt / router / downstream
//!   - storage::{sessions, seqs, events, kv, migrations}
//!   - auth_service / hub_service / push
//!
//! Plan 5 walking skeleton 只跑 in-process,不暴露稳定 public API。

pub mod config;
pub mod downstream;
pub mod error;
pub mod jwt;
pub mod storage;
