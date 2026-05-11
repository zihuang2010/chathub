//! 内嵌迁移 SQL,由 rusqlite_migration 应用。

use rusqlite_migration::{Migrations, M};

const M001: &str = include_str!("../../migrations/001_initial.sql");

pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(M001)])
}
