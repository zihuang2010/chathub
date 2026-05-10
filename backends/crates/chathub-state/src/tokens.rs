//! KeyringTokenStore:把 refresh_token 与 device_id 存进 OS Keychain。
//!
//! Account naming:
//!   - "device_id"     → 持久 UUIDv4(本地设备唯一标识)
//!   - "refresh_token" → opaque base64 token 串
//!
//! 同一时刻只支持一个本地用户;切换用户必须先 logout(清 refresh)。

use crate::error::StateError;
use keyring::Entry;

const ACCOUNT_DEVICE_ID: &str = "device_id";
const ACCOUNT_REFRESH_TOKEN: &str = "refresh_token";

#[derive(Clone)]
pub struct KeyringTokenStore {
    service: String,
}

impl KeyringTokenStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    /// 取 device_id;不存在则生成 UUIDv4 写入并返回。幂等。
    pub fn ensure_device_id(&self) -> Result<String, StateError> {
        let entry = Entry::new(&self.service, ACCOUNT_DEVICE_ID)?;
        match entry.get_password() {
            Ok(id) => Ok(id),
            Err(keyring::Error::NoEntry) => {
                let id = uuid::Uuid::new_v4().to_string();
                entry.set_password(&id)?;
                Ok(id)
            }
            Err(e) => Err(e.into()),
        }
    }

    pub fn read_refresh_token(&self) -> Result<Option<String>, StateError> {
        let entry = Entry::new(&self.service, ACCOUNT_REFRESH_TOKEN)?;
        match entry.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn write_refresh_token(&self, token: &str) -> Result<(), StateError> {
        let entry = Entry::new(&self.service, ACCOUNT_REFRESH_TOKEN)?;
        entry.set_password(token)?;
        Ok(())
    }

    pub fn clear_refresh_token(&self) -> Result<(), StateError> {
        let entry = Entry::new(&self.service, ACCOUNT_REFRESH_TOKEN)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// 仅供测试:清掉 device_id(测试隔离用)
    #[doc(hidden)]
    pub fn _clear_device_id_for_test(&self) -> Result<(), StateError> {
        let entry = Entry::new(&self.service, ACCOUNT_DEVICE_ID)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_service() -> String {
        format!("chathub-test-{}", uuid::Uuid::new_v4())
    }

    fn cleanup(s: &KeyringTokenStore) {
        let _ = s.clear_refresh_token();
        let _ = s._clear_device_id_for_test();
    }

    #[test]
    fn ensure_device_id_is_idempotent() {
        let s = KeyringTokenStore::new(unique_service());
        let id1 = s.ensure_device_id().expect("first");
        let id2 = s.ensure_device_id().expect("second");
        assert_eq!(id1, id2);
        assert!(
            uuid::Uuid::parse_str(&id1).is_ok(),
            "should be valid UUIDv4"
        );
        cleanup(&s);
    }

    #[test]
    fn refresh_token_round_trip() {
        let s = KeyringTokenStore::new(unique_service());
        assert!(s.read_refresh_token().unwrap().is_none(), "starts empty");
        s.write_refresh_token("rt-abc").expect("write");
        assert_eq!(s.read_refresh_token().unwrap().as_deref(), Some("rt-abc"));
        s.clear_refresh_token().expect("clear");
        assert!(s.read_refresh_token().unwrap().is_none(), "cleared");
        cleanup(&s);
    }

    #[test]
    fn clear_when_absent_is_ok() {
        let s = KeyringTokenStore::new(unique_service());
        assert!(s.clear_refresh_token().is_ok());
        cleanup(&s);
    }
}
