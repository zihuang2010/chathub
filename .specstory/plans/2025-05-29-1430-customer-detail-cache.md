# 客户详情本地缓存（当天 TTL，后端 SQLite 落盘）

## 一、需求确认（已与用户对齐）

- **本地留存一份客户详情**：客户列表/接待页打开的客户详情快照在本地落盘。
- **TTL = 当天有效**：缓存命中条件为「写入时间与当前时间为同一本地日历日」，跨天即过期。
- **本地有则取本地**：非强制拉取时，命中当天缓存直接返回本地，不走远程。
- **强制则走远程并更新缓存**：`isForceRefresh=true`（刷新按钮）始终远程拉取并覆盖缓存。
- **存储位置 = 后端 SQLite 落盘**：在 `chathub-state` 新建独立缓存表/Store，重写逻辑，**不复用已退役的好友行存**。
- **作用范围 = 两处都覆盖**：客户管理页 `CustomersPage` 与接待页 `MessagesPage`。两者前端均汇聚到
  `useFriendDetail.ts` → `fetchFriendDetail` → Tauri `friend_detail` 命令，因此缓存做在**命令层**即可一处覆盖两端。

## 二、现状（探索结论）

- 前端唯一汇聚点：`frontends/lib/api/useFriendDetail.ts`（被 CustomersPage、MessagesPage 共用），
  已具备：选中切换自动拉取（非强制）、reqId 竞态守卫、`refresh(true)` 强制刷新。**本次前端无需改动。**
- Tauri 命令：`backends/src/lib.rs` 的 `friend_detail(app, hub, wecom_account_id, external_user_id, is_force_refresh)`，
  当前实现仅 `hub.friend_detail(req).await`，**完全不落地**（注释明确「不入库,临时拉取」）。
- 业务后台自身有「一天一次」节流；客户端只透传 flag。新增的当天缓存与之语义一致（都按天）。
- 数据类型：`chathub_net::WecomFriendDetail`（serde camelCase，已派生 Serialize+Deserialize）→ 可整体 JSON 序列化存储。
- Store 范式（参考 `chathub-state/src/quick_replies.rs`）：`Store { db: Db }`，`db.lock()` 拿 rusqlite 连接，
  返回 `Result<_, StateError>`；通过 `XxxStore::new(db.clone())` 构造，`tauri::Builder.manage(store)` 托管，
  命令以 `store: tauri::State<'_, XxxStore>` 注入。
- 迁移：`chathub-state/migrations/`，最新 `V18`，新增用 `V19`。
- `friend_detail` 影响分析：**LOW**（命令为入口，无图内 Rust 调用者）。

## 三、设计

缓存做在**后端命令层**，对前端透明（前端不改）。Store 只存**不透明 JSON 字符串**，不依赖 `chathub-net` 类型，保持 crate 解耦。

**缓存键**：`(wecom_account_id, external_user_id)` 复合主键。
**TTL 判定**：存 `cached_at_ms`（写入时刻毫秒）。读时用 `chrono::Local` 把 `cached_at_ms` 与 `now` 各自折算为
`yyyy-mm-dd`，相同即「当天命中」，否则过期。（按本地日历日，符合「到今天 24 点」语义。）

**命令新逻辑**（`friend_detail`）：

1. `is_force_refresh == true` → 远程拉取 → UPSERT 缓存（json + now_ms）→ 返回远程结果。
2. 否则 → 查缓存：
   - 命中且为当天 → 反序列化返回本地。
   - 未命中 / 跨天 → 远程拉取 → UPSERT 缓存 → 返回远程结果。

> 远程失败时：保持现有行为（向上抛错）。可选增强「远程失败回退过期缓存」——本次**不做**，避免超出需求（最小改动）。

## 四、实施步骤

1. **新增迁移** `backends/crates/chathub-state/migrations/V19__friend_detail_cache.sql`
   - 目标：建表 `friend_detail_cache(wecom_account_id TEXT NOT NULL, external_user_id TEXT NOT NULL,
detail_json TEXT NOT NULL, cached_at_ms INTEGER NOT NULL, PRIMARY KEY(wecom_account_id, external_user_id))`。
   - 风险：低；纯新增表，不触碰已退役表。
   - 验证：`cargo build` 触发迁移；启动后表存在。

2. **新增 Store** `backends/crates/chathub-state/src/friend_detail_cache.rs`
   - `FriendDetailCacheStore { db: Db }`，方法：
     - `get_fresh_today(account, ext) -> Result<Option<String /*json*/>>`：查记录并用 `chrono::Local`
       比对 `cached_at_ms` 与 now 是否同一本地日历日，跨天视为未命中（当天 TTL 下沉到 Store，命令层不碰 chrono）。
     - `upsert(account, ext, json) -> Result<()>`：内部取 now 毫秒写入，`INSERT ... ON CONFLICT DO UPDATE`。
   - 仿 `quick_replies.rs` 写法（`db.lock()` + rusqlite + `StateError`）。
   - 在 `chathub-state/src/lib.rs` 导出该模块与类型。
   - 风险：低。验证：`cargo build` 通过。

3. **接线** `backends/src/lib.rs`
   - 构造 `FriendDetailCacheStore::new(db.clone())` 并 `.manage(...)`（紧邻 quick_replies_store 接线处）。
   - 风险：低。验证：编译通过、`.manage` 类型可被命令注入。

4. **改命令** `backends/src/lib.rs::friend_detail`
   - 注入 `cache: tauri::State<'_, FriendDetailCacheStore>`。
   - 实现第三节逻辑：非强制时 `get_fresh_today` 命中→`serde_json::from_str` 返回；否则（强制/未命中/跨天）
     远程拉取→`serde_json::to_string`→`cache.upsert`→返回远程。当天判定已在 Store，命令层不引入 chrono。
   - 注释更新（去掉「不入库」，改述「当天缓存+强制绕过」）。
   - 风险：低（影响分析 LOW；逻辑为「命中前置」，未命中行为与旧版一致）。
   - 验证：见第五节。

5. **前端**：不改。确认 `useFriendDetail` 行为与新命令语义吻合（非强制=可命中缓存；刷新=强制远程+更新）。

## 五、验证方案

- `cargo build`（后端编译 + 迁移就绪）。
- 后端单测：为 `FriendDetailCacheStore` 加 `get/upsert/当天命中/跨天过期` 单测（仿 quick_replies 测试风格，若该文件已有测试模块）。
- 手动联调（可用 `mock_downstream`）：
  1. 选中客户 → 首次拉取走远程、写缓存。
  2. 切走再切回 / 重启 app 同一天 → 非强制命中本地（远程不被调用）。
  3. 点刷新 → 强制走远程并覆盖缓存。
  4. 跨天（或临时改系统日期 / 单测模拟）→ 非强制重新走远程。
- 提交前按规范跑 `gitnexus_detect_changes()` 核对改动范围。

## 六、未决/取舍

- 「远程失败回退过期缓存」：本次不做（最小改动）。如需，后续可加。
- 缓存清理：暂不加 TTL 清理任务（行数等于活跃客户数，量级可控）；如需可后续加跨天惰性删除。
- `chrono` 依赖：已确认 `chathub-state/Cargo.toml` 依赖 `chrono 0.4`。当天判定下沉到 Store 层用 `chrono::Local`
  实现（Store 暴露 `is_fresh_today(cached_at_ms)` 或直接在 `get` 内只返回当天有效记录），命令层不引入新依赖。
