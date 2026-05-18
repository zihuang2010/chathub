# 本地数据库建表规范

适用于 ChatHub 仓库内所有本地 SQLite 表。所有新增 / 改动均按本文为准。

## 1. 背景

ChatHub 有两个独立的本地 SQLite 库:

| 库             | owner crate     | 路径                                   | 角色                                         |
| -------------- | --------------- | -------------------------------------- | -------------------------------------------- |
| `state.sqlite` | `chathub-state` | `$APP_DATA_DIR/state.sqlite`(Tauri 端) | 客户端本地缓存:会话、账号、好友、token、水位 |
| `relay.db`     | `chathub-relay` | 进程 cwd(默认根目录)                   | Relay 服务端事件日志                         |

两边都用 `deadpool-sqlite` + `rusqlite_migration`,启动时按版本号顺序跑 migration。

历史上表名没有统一前缀,跟 `rusqlite_migration` 元表混在 `sqlite_master` 里靠肉眼分;`kv` 通用表又把"凭据"和"运行时水位"塞在一张表里,语义模糊。本文把规则一次定清,避免后续每加一张表都得现讨论。

## 2. 命名规则

### 2.1 表名

- **必须**以 `hub_` 开头。
- snake_case,业务域名贴在前缀后。例:`hub_wecom_accounts`、`hub_events`。
- 如果表是某个领域的多张子表,用同一前缀串联。例:好友领域三张:
  - `hub_wecom_friends`(行存)
  - `hub_wecom_friend_sync_state`(同步状态)
  - `hub_wecom_friend_watermark`(事件水位)

### 2.2 索引名

- **必须**以 `idx_hub_` 开头。
- 模式:`idx_hub_<表名去掉 hub_ 部分>_<列简写>`。例:`idx_hub_wecom_accounts_employee`。

### 2.3 字段

- snake_case。
- 时间戳列统一两种风格:
  - `_at_ms`:unix 毫秒整数,`INTEGER NOT NULL`。新表优先选这个。
  - `_at`:ISO-8601 字符串(`yyyy-MM-dd HH:mm:ss` 或带 `T` 的 RFC3339),`TEXT NOT NULL`。只在第三方契约本身就是字符串时使用(例:好友 `add_time` 直接透传企微响应)。
- 布尔语义用 `INTEGER NOT NULL`(0/1),不用 `BOOLEAN`(SQLite 没有原生类型,会被存成 INTEGER)。
- 主键约束:
  - 单行表(全表只允许 1 行):`id INTEGER PRIMARY KEY CHECK (id = 1)`,参考 `hub_current_session`。
  - 业务主键直接 `PRIMARY KEY`,不强求 `id INTEGER AUTOINCREMENT`。

## 3. KV 拆分约定

`kv` 通用表已拆为两张同构表,语义解耦:

| 表             | 用途                             | 当前 key 示例        | Owner Store       |
| -------------- | -------------------------------- | -------------------- | ----------------- |
| `hub_secrets`  | 本地凭据(敏感)                   | `device_id`、`token` | `LocalTokenStore` |
| `hub_settings` | 运行时状态 / 水位(可重建,非敏感) | `notify_seq`         | `NotifySeqStore`  |

两张表 schema 完全一致:

```sql
CREATE TABLE hub_secrets (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);
```

**新增 KV 数据时按"敏感性"二选一**:能丢就能重建的进 `hub_settings`,泄露会受损的进 `hub_secrets`。两张表都不许混塞另一类。如果出现第三类需求(例如离线消息草稿、用户偏好),新建一张 `hub_drafts` / `hub_preferences` 表,不要再往这两张里堆。

## 4. Migration 流程

### 4.1 文件位置 & 命名

| Crate           | 目录                                        | 命名                                 |
| --------------- | ------------------------------------------- | ------------------------------------ |
| `chathub-state` | `backends/crates/chathub-state/migrations/` | `V{N}__{name}.sql`,`N` 从 1 严格递增 |
| `chathub-relay` | `backends/crates/chathub-relay/migrations/` | `{NNN}_{name}.sql`,三位数字          |

两套命名都是历史遗留(state 走 Flyway 风格、relay 走 sqlx 风格),不强求统一。**新增按各 crate 已有风格继续**即可。

### 4.2 注册入口

新建 migration 文件后,必须在对应入口添加 `include_str!`:

- `chathub-state`:`backends/crates/chathub-state/src/pool.rs::apply_migrations`(`M::up(include_str!(...))` 列表)
- `chathub-relay`:`backends/crates/chathub-relay/src/storage/migrations.rs::migrations`

漏加 → 表不会被创建,启动后第一次查询直接 `no such table`。

### 4.3 改老 migration(开发阶段允许)

`rusqlite_migration` 不校验已运行 migration 的内容,但实际 DB 上的表 schema 是按"第一次跑过的 SQL"建的。改老 migration 后,旧 DB 不会自动 ALTER。

**当前是开发阶段,允许就地改老 migration 文件**,前提是改的人:

1. 自检本地 DB 无重要数据(`state.sqlite` 里没未同步的会话,`relay.db` 里没未消费的事件)。
2. 删干净本地 db 文件:
   ```bash
   # Relay 端
   rm -f relay.db relay.db-wal relay.db-shm
   # 客户端(Tauri)
   rm -f "$APP_DATA_DIR/state.sqlite" "$APP_DATA_DIR/state.sqlite-wal" "$APP_DATA_DIR/state.sqlite-shm"
   ```
3. PR 描述里**显式注明**"本次包含 migration breaking change,需重建本地 db"。

进入"准生产"阶段后,本节失效,改老 migration 必须改走"新增 V{N+1} 写 ALTER/RENAME"的路子。届时本文需更新。

## 5. 不允许的事

- **Rust 代码里硬编码 `CREATE TABLE` / `ALTER TABLE`**。所有 schema 变更走 migration 文件。测试 fixture 也走 `SqlitePool::in_memory()`(它会跑全部 migration),不许手插 DDL。
- **`format!` / 字符串拼接构造表名**。表名必须是字面量,方便 grep。
- **Tauri 命令 / 业务代码直接读写表**。所有 DB 访问必须经过 `chathub-state` 暴露的 Store 公有 API(`SessionStore`、`AccountCacheStore`、`FriendsStore`、`LocalTokenStore`、`NotifySeqStore`)或 `chathub-relay` 的 `EventLog`。
- **新增没有 `hub_` 前缀的表 / 没有 `idx_hub_` 前缀的索引**。`pool.rs` / `storage/mod.rs` 的测试会断言表清单,漏前缀的表名会被卡住。

## 6. 现有表清单(2026-05 校准)

### 6.1 `state.sqlite`(chathub-state)

| 表                            | Owner Store         | 创建于             |
| ----------------------------- | ------------------- | ------------------ |
| `hub_current_session`         | `SessionStore`      | V1                 |
| `hub_wecom_accounts`          | `AccountCacheStore` | V1(V4 DROP + 重建) |
| `hub_wecom_account_watermark` | `AccountCacheStore` | V4                 |
| `hub_secrets`                 | `LocalTokenStore`   | V3                 |
| `hub_settings`                | `NotifySeqStore`    | V3                 |
| `hub_wecom_friends`           | `FriendsStore`      | V6                 |
| `hub_wecom_friend_sync_state` | `FriendsStore`      | V6                 |
| `hub_wecom_friend_watermark`  | `FriendsStore`      | V6                 |

### 6.2 `relay.db`(chathub-relay)

| 表           | Owner      | 创建于 |
| ------------ | ---------- | ------ |
| `hub_events` | `EventLog` | 002    |

新增表请同步更新本节,把"在哪个 migration 创建、被哪个 Store 持有"写清楚。
