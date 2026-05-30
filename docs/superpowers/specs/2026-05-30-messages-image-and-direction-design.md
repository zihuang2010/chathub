# 消息页图片优化 + 消息方向修复 — 设计文档

- 日期：2026-05-30
- 范围：消息页（接待区）聊天气泡列表的图片渲染、图片本地化缓存、消息方向修复
- 状态：待用户复核

---

## 1. 背景与目标

消息页聊天气泡列表的图片当前存在四类问题，外加一个消息方向 bug。用户诉求合并为一个交付：

| #   | 诉求                                           | 类别                         |
| --- | ---------------------------------------------- | ---------------------------- |
| R1  | 图片按**原始比例**显示，不再被裁切成正方形     | 体验                         |
| R2  | 消除图片**闪烁**（首次加载 / 切回会话 / 滚动） | 体验/性能                    |
| R3  | 图片**下载到本地、写表、以后读本地**           | 架构（用户指定后端落库方案） |
| R4  | 图片**样式优化**：四边边框/圆角一致            | 样式                         |
| R5  | 点击图片**预览**（单图灯箱）                   | 功能                         |
| B1  | 修复**消息方向**：历史消息出/入站方向全反      | Bug                          |

方案路线（已与用户确认）：

- R2/R3：**后端落库**（非前端轻量方案）。
- R5：**单图灯箱**（非画廊）。
- B1：与图片功能**打包一起做**；老缓存走 **ON CONFLICT 自愈**。

---

## 2. 现状与根因

### 2.1 消息方向 Bug（B1）— 已坐实

服务端 `fetch_message_history` 的 `messageDirection` 真实契约（**针对当前账号**）：

- `1` = 当前账号发送 → **出站 out**
- `2` = 客户发送、账号接收 → **入站 in**
- `3` = 当前账号在其他设备发送、同步过来 → **出站 out**

两条写库路径用了**不一致**的约定：

| 路径     | 代码                                                                                      | 是否转换                 | 结果         |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------ | ------------ |
| 实时事件 | `message_event.rs::decode_message_row` → `to_local_direction`                             | ✅ spec→本地(1=in,2=out) | 正确         |
| 历史拉取 | `message_sync.rs::history_to_row`（`message_direction: h.message_direction`，**原样抄**） | ❌ 不转换                | **方向全反** |

两条路径写进同一张表 `hub_conversation_messages`。历史消息占绝大多数 → 用户看到的方向基本全反。

- `to_local_direction`（message*event.rs:25）逻辑正确：`1|3 => 2(out)`，`* => 1(in)`。
- 前端 `messageHistory.ts:213` `direction: h.messageDirection === 2 ? "out" : "in"` 期望的是**本地约定**（2=out）；只要后端两条路径都转成本地约定，前端**无需改逻辑**。
- 误导性注释：`hub.rs:711` `HistoryMessage.message_direction` 写"1=入/2=出"，实为**原始 spec**（1=发送）。
- impact 分析：`history_to_row` 上游 0 影响、`to_local_direction` 仅 `decode_message_row` 调用，均 **LOW 风险**。

### 2.2 图片闪烁（R2）— 根因

- 图片经 `cachedImageSrc(url,w)` 走 **`cachedimg://` 自定义协议**（lib.rs:1339），Rust 下载→缩略图→落盘（`app_cache_dir()/img-cache`）。
- WebView 对**自定义协议响应不做可靠的内存缓存**，每次 `<img>` 挂载都重新异步请求一次 → 先画一帧灰骨架 → 闪。
- 触发场景：①首次加载（盘上还没有，要下载）②切会话（气泡重渲、`<img>` 重挂）③滚动（`ChatArea.tsx` 在 >60 条时启用 `@tanstack/react-virtual`，行滚出/入视口卸载又重建 `<img>`）。

### 2.3 裁切/比例（R1）现状

- `MessageContent.tsx::MessageImage` 用**固定 192×192 方形盒 + `object-cover`**（刻意为消除布局抖动而裁切）。要既按比例又不抖，**渲染前必须先知道每张图的宽高**——这正是 R3"写表"要拿的信息。

### 2.4 持久化结构

- `hub_conversation_messages` 行存（`chathub-state/messages.rs`），附件以 `attachments_json`（JSON 串）整体存储，是**服务端真相**，reconcile 会覆盖它 → **尺寸/本地路径不能塞进它**（会被覆盖）。
- 迁移系统已到 V18（`chathub-state/migrations/`，`pool.rs` 注册）。
- `HistoryAttachment`（hub.rs:744）：`media_id`(alias `ossFilePath`)/`file_name`/`file_size`/`file_type`(alias `fileSuffix`)。图片 URL = `https://filet.jdd51.com` + `/` + `media_id`。

---

## 3. 设计总览

核心思想：**把"图片派生元数据（原始宽高 + 本地缩略图路径）"与"服务端附件真相"解耦**——单独建一张以**图片 URL 为键**的派生表 `hub_image_meta`，由后台预取任务填充，读消息时按 URL 注入给前端。

- 前端拿到**宽高** → 预留**精确比例盒**（按比例 R1、零布局抖动）。
- 前端拿到**本地路径** → 走 **Tauri asset 协议**读真实本地文件（WebView 缓存可靠 → 重挂同步命中、消除闪烁 R2/R3）。
- 派生表按 URL 解耦 → 彻底绕开 reconcile 覆盖 `attachments_json` 的坑。

---

## 4. 详细设计

### Part A — 消息方向修复（B1）

1. `message_event.rs`：`fn to_local_direction` 改为 `pub(crate) fn`（单一事实源，供历史路径复用）。
2. `message_sync.rs::history_to_row`：
   ```rust
   message_direction: to_local_direction(h.message_direction as i64),
   ```
   （`use crate::message_event::to_local_direction;`）
3. `messages.rs::upsert_messages` 的 `ON CONFLICT DO UPDATE SET` 增一列：
   ```sql
   message_direction = excluded.message_direction
   ```

   - 自愈：下次 reconcile 重拉时，已缓存的反向老行被纠正。
   - 安全性：方向对单条消息恒定不变，纳入更新无副作用（虽是"位置列"，但其值不会漂移）。
4. 注释修正：`hub.rs:711` 改为"原始 spec：1=发送 2=接收 3=多端同步"。
5. 前端：**零逻辑改动**（修复后 records 已是本地约定）。可顺手澄清 `messageHistory.ts:48` 注释为"本地约定"。

### Part B — 图片本地化（R2/R3）+ 按比例（R1）

#### B.1 数据模型

**新表（迁移 `V19__image_meta.sql`）**

```sql
CREATE TABLE hub_image_meta (
  url           TEXT PRIMARY KEY,   -- 完整 https 图片 URL（= filet.jdd51.com + '/' + media_id）
  width         INTEGER NOT NULL,   -- 原图宽（定比例盒）
  height        INTEGER NOT NULL,   -- 原图高
  local_path    TEXT NOT NULL,      -- 磁盘缩略图绝对路径（asset 协议读它）
  updated_at_ms INTEGER NOT NULL
);
```

> 不带 `employee_id`：图片按 URL 内容寻址、跨员工可共享。无主动淘汰（行很小）；img-cache LRU 删文件后 `local_path` 失效 → 前端 onError 回退 + 预取重建。

**`HistoryAttachment`（hub.rs）增 3 个可选字段**

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub width: Option<i64>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub height: Option<i64>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub local_path: Option<String>,
```

> 服务端不下发→解析为 None；读消息时注入。**不进 `attachments_json`**（解耦）。

**前端类型**：`messageHistory.ts::HistoryAttachment` 增 `width?/height?/localPath?`；`data.ts::MessagePart.image` 增 `localPath?`（已有 `width?/height?`）；`historyAttachmentToMessage` 透传三字段。

#### B.2 后端组件

1. `chathub-state`：新增 `ImageMetaStore`（`get_many(urls: &[String]) -> HashMap<String, ImageMeta>`、`upsert(meta)`）；`V19` 迁移 + `pool.rs` 注册；in-memory pool 单测。
2. `ImageCache` 扩展（`image_cache.rs`）：
   - 下载/缩略图时**捕获原图 `dimensions()`**。抽 `download_and_thumbnail(url, width) -> (bytes, (orig_w, orig_h), path)`，供 `get()`（serve）与 `prefetch()` 共用，**同一 sha256 文件**不重复下载。
   - 新增 `async fn prefetch(url) -> Result<(w,h,path)>`：复用 SSRF 白名单/LRU；命中 meta 即返回，未命中下载→落盘→返回原始宽高 + 路径。
   - 缩略图固定宽度 `THUMB_W = 512`（高分屏 2x，气泡显示宽度 ~256）。
3. 预取服务：`ImagePrefetcher`（持有 `ImageCache` + `ImageMetaStore` + `change_notice_tx` + 去重 `Mutex<HashSet<url>>`）。`ensure(urls, conversation_id, employee_id)`：对缺 meta 的 URL 后台 `spawn` 下载→`upsert` meta→完成后发 `ChangeNotice::server_upsert`（`conversation-messages`）让打开着的会话重读。best-effort，失败只记日志、不影响文本气泡。
4. 读命令注入（`lib.rs::load_conversation_messages` + `load_older_messages`）：构好 `records` 后，收集图片附件 URL（`media_id` → 拼 URL）→ `ImageMetaStore::get_many` 批量查 → 把命中的 `width/height/local_path` 注入对应 `HistoryAttachment`；缺失的交 `ImagePrefetcher::ensure` 后台预取。注入逻辑抽 `enrich_records_with_image_meta(...)` 复用。
5. asset 协议（`tauri.conf.json` + `lib.rs`）：
   - `app.security.assetProtocol = { "enable": true, "scope": [] }`。
   - setup() 内拿到 `img_cache_dir` 后程序化授权（避免配置里写死路径变量的平台差异）：
     ```rust
     app.asset_protocol_scope().allow_directory(&img_cache_dir, true)?;
     ```
   - `csp: null`（CSP 关闭）→ 无需改 img-src。

#### B.3 前端渲染

1. 新 helper `assetImageSrc(localPath)`：`convertFileSrc(localPath)`；非 Tauri / 空路径回退 undefined。
2. `MessageContent.tsx::MessageImage` 重构：
   - **有宽高** → 渲染**按比例盒**：外层 `style={{ aspectRatio: w/h }}` + `max-w` / `max-h` 上限（高窄图限高、宽扁图限宽），`<img className="object-contain">` 不裁切。
   - **有本地路径**（asset 源）→ **不画骨架**（缓存命中即出）；仅"无宽高/无本地路径的过渡态"保留骨架（现 `cachedimg://` 回退）。
   - **回退链**：`localPath`(asset) → 无则 `cachedImageSrc(url)`（预取未完成的过渡）；asset `onError`（LRU 删了文件）→ 回退 `cachedImageSrc(url)` 重新下载。

### Part C — 样式四边一致（R4）

- 现状：外层 `<a class="rounded-xl overflow-hidden">` 套内层 `rounded-lg`，双层圆角 + `object-cover` 裁切导致四边观感不一致；`InlineImage` 用 `ring-1`。
- 改为：**单层**圆角 + 边框落在**图片盒本身**（统一 `rounded-xl ring-1 ring-workbench-line`），`object-contain` + 比例盒确保四边内边一致；hover 态统一（`hover:ring-workbench-accent` / 阴影）。三处入口（`ImageStandalone`/`ImageAttachment`/`InlineImage`）统一到同一图片组件，消除样式分叉。

### Part D — 单图灯箱（R5）

- 新组件 `ImageLightbox`：点击图片 → 全屏遮罩（`fixed inset-0 bg-black/80`）展示**原图**（`part.url`，CSP 关闭可直接 https 加载）；`Esc` / 点遮罩关闭；右上角下载按钮（`<a download>`）。
- 接线：三处图片入口的点击由现有 `<a target=_blank>`（外部打开）替换为打开灯箱；不安全 URL 维持现有失败态。
- 无障碍：遮罩 `role="dialog" aria-modal`，焦点陷阱 + Esc 关闭。

---

## 5. 实现顺序（建议的提交分层）

1. **方向修复**（Part A）：最小、独立、低风险，先单独成一层（含单测）。
2. **样式 + 灯箱**（Part C + D）：纯前端，不依赖后端，独立成一层。
3. **后端 image_meta + 预取 + asset**（Part B 后端）：表/store/迁移/ImageCache/预取/读命令注入/asset 配置（含 Rust 单测）。
4. **前端消费宽高 + 本地路径**（Part B 前端）：`MessageImage` 比例盒 + asset 源 + 回退（含渲染测试）。

> 每个被改的 Rust/前端符号，**编辑前先 `gitnexus_impact`**；HIGH/CRITICAL 先告警。**提交前 `gitnexus_detect_changes`** 核对影响面。

---

## 6. 风险与缓解

| 风险                                 | 缓解                                                                  |
| ------------------------------------ | --------------------------------------------------------------------- |
| asset 协议内存常驻（tauri#2952）     | 缩略图小（512px）+ 虚拟化只挂可视窗口，峰值可控；必要时下调 `THUMB_W` |
| asset scope 平台差异（mac/win）      | 程序化 `allow_directory` 而非配置路径变量；阶段 3 真机手测两端        |
| LRU 删缩略图 → asset 404             | 前端 `onError` 回退 `cachedImageSrc(url)` 重新下载                    |
| 预取并发/重复                        | `Mutex<HashSet<url>>` 去重 + best-effort，失败不影响文本气泡          |
| 方向自愈不彻底（仅重拉到的行被纠正） | 已确认 ON CONFLICT 自愈即可；打开/翻页会重拉覆盖实际浏览场景          |
| `attachments_json` 被 reconcile 覆盖 | 派生数据走独立 `hub_image_meta` 表，不入 `attachments_json`           |

---

## 7. 测试计划

- **Rust**
  - `history_to_row`：spec 1→本地 2(out)、spec 2→本地 1(in)、spec 3→本地 2(out)。
  - `upsert_messages` 自愈：先存反向行 → 再 upsert → 断言 `message_direction` 被纠正。
  - `ImageMetaStore`：upsert / get_many round-trip（in-memory pool）。
  - `ImageCache::prefetch`：解码原始宽高、落盘、meta upsert（可用本地小图字节）。
  - 读命令注入：rows 有图片附件 + meta 命中 → records 注入 width/height/local_path。
- **前端（vitest）**
  - `MessageImage`：有宽高→比例盒 + object-contain；有 localPath→无骨架；asset onError→回退；无 meta→骨架回退。
  - `ImageLightbox`：点击开、Esc/点遮罩关、下载按钮存在。
  - 方向：现有气泡方向测试在后端修复后仍绿（前端零改动）。

---

## 8. 非目标 / YAGNI

- 不做画廊式预览（左右切换/缩放拖动）——仅单图灯箱。
- 不为 `hub_image_meta` 做复杂淘汰策略（行小、URL 寻址；依赖 img-cache LRU + onError 回退）。
- 不改实时事件方向路径（已正确）。
- 不预取灯箱原图到本地（点击时直连 https 即可）。
- 不引入新的图片处理依赖（复用现有 `image` crate）。
