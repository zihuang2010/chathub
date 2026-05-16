//! 内嵌迁移 SQL,由 rusqlite_migration 应用。

use rusqlite_migration::{Migrations, M};

const M001: &str = include_str!("../../migrations/001_initial.sql");
const M002: &str = include_str!("../../migrations/002_events_v2.sql");
const M003: &str = include_str!("../../migrations/003_drop_legacy.sql");

pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(M001), M::up(M002), M::up(M003)])
}
