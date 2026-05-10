//! Plan 2 Task 14~15。
pub struct AuthApi;
#[derive(Debug, Clone, Copy)]
pub enum LoggedOutReason {
    Manual,
    RefreshFailed,
    Kicked,
}
