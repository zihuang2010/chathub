//! StateError:chathub-state 公共错误类型。

#[derive(thiserror::Error, Debug)]
pub enum StateError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("sqlite pool error: {0}")]
    Pool(String),

    #[error("sqlite interact error: {0}")]
    Interact(String),

    #[error("migration error: {0}")]
    Migration(String),

    #[error("missing field: {0}")]
    MissingField(&'static str),

    #[error("internal: {0}")]
    Internal(String),
}

impl From<deadpool_sqlite::PoolError> for StateError {
    fn from(e: deadpool_sqlite::PoolError) -> Self {
        StateError::Pool(e.to_string())
    }
}

impl From<deadpool_sqlite::InteractError> for StateError {
    fn from(e: deadpool_sqlite::InteractError) -> Self {
        StateError::Interact(e.to_string())
    }
}
