//! Secret 输出脱敏工具。
//!
//! `downstream.rs` 的安全约束说"日志只允许 token 前 8 char + ***"。本模块提供
//! 强制脱敏的 helper,把"靠记忆遵守"升级为"靠类型/函数兜底",防止后续 contributor
//! 在新 tracing 调用里直接拼明文 token。
//!
//! 使用:
//! ```ignore
//! use crate::secret::redact_token;
//! tracing::info!(target = "x", token = %redact_token(client_token), "verify ok");
//! // 输出: token=abc12345*** (前 8 char + ***)
//! ```

use std::fmt;

/// 包装一段 secret 字符串,只 `Display`/`Debug` 出前 8 字符 + `***`。
/// 拿不到全文 — 即使被 `format!("{:?}", ...)` 也只看到脱敏形态。
///
/// 注意:本 wrapper 不阻止有人 `as_ref()` / 解引用拿到原文 —— 它只防"无意识 log"。
/// 真正"绝对不进 struct/cache"的承诺,仍由 `&str` 流转 + code review 保证。
pub struct Redacted<'a>(pub &'a str);

impl fmt::Display for Redacted<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_redacted(self.0, f)
    }
}

impl fmt::Debug for Redacted<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_redacted(self.0, f)
    }
}

/// 函数风格便捷:`tracing::info!(token = %redact_token(t), ...)`。
pub fn redact_token(s: &str) -> Redacted<'_> {
    Redacted(s)
}

fn write_redacted(s: &str, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    if s.is_empty() {
        return f.write_str("***");
    }
    // 按 char 截前 8,避免在 UTF-8 多字节里截一半。token 实际是 ASCII,稳妥起见统一。
    let head: String = s.chars().take(8).collect();
    write!(f, "{head}***")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_token_truncated_to_head_plus_marker() {
        assert_eq!(format!("{}", Redacted("abc12345xyz")), "abc12345***");
    }

    #[test]
    fn empty_token_is_just_marker() {
        assert_eq!(format!("{}", Redacted("")), "***");
    }

    #[test]
    fn under_8_chars_is_still_redacted() {
        // 全长 < 8 时,前缀就是它本身;但后面仍接 *** 表明"这是 secret"
        assert_eq!(format!("{}", Redacted("abc")), "abc***");
    }

    #[test]
    fn debug_and_display_match() {
        let r = Redacted("supersecret-12345");
        assert_eq!(format!("{r}"), format!("{r:?}"));
        assert_eq!(format!("{r}"), "supersec***");
    }

    #[test]
    fn fn_style_helper_works() {
        assert_eq!(format!("{}", redact_token("abcdefghij")), "abcdefgh***");
    }
}
