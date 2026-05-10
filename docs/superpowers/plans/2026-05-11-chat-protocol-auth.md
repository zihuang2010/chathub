# ChatHub Chat Protocol — Plan 2: Auth End-to-End

> **STUB — 待 Plan 1 合并后用 writing-plans skill 扩展。**

**Scope (草稿):**

- crates/chathub-state:SQLite 表(refresh_tokens、user_profile、wecom_accounts_cache)+ migrations + sqlx 接入
- crates/chathub-net 第一版:
  - mod channel:Endpoint 配置(http2*keep_alive*\*、tls_config、connect_timeout)
  - mod token:TokenStore actor(load from keyring → 内存缓存 → 5min 主动刷新)
  - mod interceptor:AuthInterceptor 注入 metadata(authorization + chathub-protocol-version + chathub-client-version + chathub-platform)
  - mod auth:login/refresh/logout 三个高层 API
- crates/stub-relay(测试用 bin 或 dev-dependency):tonic Server 实现 chathub.v1.Auth 三个 method,接受任意 user/password,返回固定 jwt-like 字符串
- backends:Tauri 命令 `login(username, password) -> Result<Profile, Err>` / `logout()` / `current_session() -> Option<Profile>`
- 集成测试:启动 stub-relay、客户端登录、kill stub、自动 refresh 触发、refresh 强制失败 → 应弹 LoggedOut 事件

**依赖:** Plan 1 已合并(workspace + chathub-proto 可用)。
