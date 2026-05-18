# B2 · listFriends

按多账号(`wecomAccountIds`)拉取员工管理的好友(客户)列表。**阶段 2 起客户端走本地 SQLite 行存 + 全量同步 + 推送事件增量**,链路:

```
Tauri (UI)
  → invoke("list_friends", { accountIds, force? })
  → backends/src/lib.rs::list_friends
     ├─ 行存 fresh(<10min)→ 直接读 SQLite 返
     └─ 失效 / force → HubClient::list_all_friends_for_account 循环拉所有页
                       → friend_to_row(带 wecomAccountId 归属)→ replace_all_for_account
                       → mark_synced → 再读 SQLite 返
  → 返 Vec<WecomFriendRow>(camelCase JSON,21 字段含 wecomAccountId)

业务后台推送 FRIEND_* 事件(经 relay PushBatchOut → ConnectionManager → FriendEventApplier):
  → 应用到行存(INSERT OR REPLACE / DELETE)
  → broadcast friends_changed 给 Tauri → app.emit("friends_changed", { employeeId, wecomAccountId? })
  → 前端 useFriends listen 后 refetch(走行存,通常零远程往返)
```

底层 `list_friends` HTTP API 不变(仍是 POST + 分页);全量同步由 SDK `list_all_friends_for_account` 内部循环 list_friends 完成。

> 路径可由 `RELAY_PATH_LIST_FRIENDS` 环境变量覆盖。

## 请求

| 项     | 值                                                                    |
| ------ | --------------------------------------------------------------------- |
| 方法   | `POST`                                                                |
| 路径   | `/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listFriends` |
| Header | `Authorization: Bearer <client_token>`                                |
| Header | `Content-Type: application/json`                                      |
| Header | `X-Relay-Employee-Id: <employeeId>`(relay 已校验过,审计用)            |
| Body   | JSON,字段见下表                                                       |

### Body 字段

| 名                | 类型       | 必填 | 说明                                       |
| ----------------- | ---------- | ---- | ------------------------------------------ |
| `wecomAccountIds` | `string[]` | 是   | 要拉取的企微账号 ID 集合,顺序无关          |
| `current`         | `int`      | 是   | 页码,1 起                                  |
| `size`            | `int`      | 是   | 单页条数。客户端固定 **100**,前端不暴露    |
| `externalName`    | `string`   | 否   | 按好友姓名模糊匹配                         |
| `externalMobile`  | `string`   | 否   | 按已脱敏的手机号(如 `138****1234`)模糊匹配 |
| `addStartTime`    | `string`   | 否   | 加好友时间起点,`yyyy-MM-dd HH:mm:ss`       |
| `addEndTime`      | `string`   | 否   | 加好友时间终点,同上                        |

## 响应

### 2xx · 正常

业务后台统一包络(`{code:1, serviceCode, msg, data}`),`data` 形态如下:

```json
{
  "records": [
    {
      "externalUserId": "woABCDEFG123456",
      "externalName": "张三",
      "externalPosition": "产品经理",
      "externalAvatar": "https://example.com/avatar.png",
      "externalCorpName": "某某科技",
      "externalCorpFullName": "某某科技有限公司",
      "externalType": 1,
      "externalGender": 1,
      "externalMobile": "138****1234",
      "followRemark": "重要客户",
      "followDescription": "长期合作客户",
      "remarkCorpName": "某某科技(备注)",
      "addTime": "2025-03-15 14:30:00",
      "addWay": 1,
      "followState": "channel_state_001",
      "wechatChannelsNickname": "视频号昵称",
      "wechatChannelsSource": 2,
      "lastSyncTime": "2026-01-10 10:00:00",
      "syncStatus": 1
    }
  ],
  "total": 100,
  "current": 1,
  "size": 100,
  "pages": 5
}
```

### `records[]` 字段

| 字段                     | 类型   | 说明                                                                                          |
| ------------------------ | ------ | --------------------------------------------------------------------------------------------- |
| `externalUserId`         | string | 好友唯一 ID,前端用作 `Customer.id`,也用作 `weChat` 占位                                       |
| `externalName`           | string | 好友昵称                                                                                      |
| `externalPosition`       | string | 职位                                                                                          |
| `externalAvatar`         | string | 头像 URL                                                                                      |
| `externalCorpName`       | string | 所属企业短名                                                                                  |
| `externalCorpFullName`   | string | 所属企业全称                                                                                  |
| `externalType`           | int    | 1=微信用户,2=企微用户                                                                         |
| `externalGender`         | int    | 0=未知,1=男,2=女                                                                              |
| `externalMobile`         | string | **已脱敏**(如 `138****1234`),前端只展示不支持精确搜索                                         |
| `followRemark`           | string | 跟进备注,UI 上"备注"字段                                                                      |
| `followDescription`      | string | 跟进描述,UI 上"描述"字段                                                                      |
| `remarkCorpName`         | string | 备注企业名                                                                                    |
| `addTime`                | string | 加好友时间,`yyyy-MM-dd HH:mm:ss`,服务端本地时区                                               |
| `addWay`                 | int    | 加好友渠道(1=扫码 / 2=手机号 / 3=微信号 / 4=联系我 / 5=视频号 / 6=群聊 / 7=他人介绍 / 8=其他) |
| `followState`            | string | 跟进状态,如 `channel_state_001`,具体字典由业务后台维护                                        |
| `wechatChannelsNickname` | string | 视频号昵称(`wechatChannelsSource=2` 时有值)                                                   |
| `wechatChannelsSource`   | int    | 视频号来源类型                                                                                |
| `lastSyncTime`           | string | 最近一次同步时间                                                                              |
| `syncStatus`             | int    | 同步状态                                                                                      |

### 分页字段

| 字段      | 类型  | 说明                    |
| --------- | ----- | ----------------------- |
| `total`   | int64 | 命中(过滤后)总条数      |
| `current` | int   | 当前页码(回显)          |
| `size`    | int   | 单页大小(回显,固定 100) |
| `pages`   | int   | 总页数                  |

### 4xx / 5xx

| 状态码                | relay 映射                       | 客户端表现                   |
| --------------------- | -------------------------------- | ---------------------------- |
| 400 / 404 / 415 / 422 | `ProtocolMismatch`               | Terminate(协议错,不退出登录) |
| 401                   | `Unauthenticated`                | 退出登录                     |
| 5xx / 网络错          | `Internal` / `Transient`         | UI 提示"加载失败,点击重试"   |
| envelope `code != 1`  | `Business { service_code, msg }` | UI 弹 `msg` 给用户           |

非 2xx 在 SDK 层(`chathub-net/src/hub.rs::list_friends`)直接映射成 `AuthError::Internal`,
携带 `list_friends returned http {status}` 文案。

## Tauri 层行存 + 全量同步(V6 迁移)

**表结构**(`backends/crates/chathub-state/migrations/V6__friends_store.sql`):

- `wecom_friends`:21 字段行存,PK `(wecom_account_id, external_user_id)`。每行带 `wecom_account_id` 归属字段(API 响应不下发,Tauri 写入时由查询入参填),修复"多账号 chip 数字消失"。
- `wecom_friend_sync_state`:per `wecom_account_id` 记 `full_synced_at_ms / last_total`,Tauri 据此判 TTL 兜底要不要重拉。
- `wecom_friend_watermark`:PK `(client_id, employee_id)`,事件序号水位,UPSERT "取大不取小"应对 redelivery。

**同步策略**(`FRIENDS_FULL_SYNC_TTL_MS = 10 分钟`):

- 进客户页时调 `invoke("list_friends", { accountIds })`:对每个 acct 判 `is_fresh`,失效或 `force=true` 时调 `HubClient::list_all_friends_for_account` 循环拉所有页,写入行存,标 fresh。
- 上限保护:`MAX_PAGES=100`(即每账号最多 10000 条),触顶报 Internal。
- TTL 仅是兜底;事件 keep data fresh,正常情况下二次进入零远程往返。

调用方传 `force: true` 跳过 TTL 判断强刷(用户点"强制刷新"按钮)。

## 推送事件(FRIEND\_\*)

业务后台通过 relay PushBatchOut 通道推送好友变更事件,客户端 `FriendEventApplier`
(`backends/crates/chathub-net/src/friend_event.rs`)接收后应用到行存。

**事件 reason 字符串**(占位,联调时按业务后台契约校正):

| eventType               | eventReason      | payload 必填字段                | 客户端动作                     |
| ----------------------- | ---------------- | ------------------------------- | ------------------------------ |
| `FRIEND_BINDING_CHANGE` | `FRIEND_ADDED`   | wecomAccountId + 全 19 字段     | `INSERT OR REPLACE` 行存       |
| `FRIEND_BINDING_CHANGE` | `FRIEND_UPDATED` | 同上                            | `INSERT OR REPLACE` 行存(幂等) |
| `FRIEND_BINDING_CHANGE` | `FRIEND_REMOVED` | wecomAccountId + externalUserId | DELETE 行存                    |
| `FRIEND_STATUS_CHANGE`  | `*`(TBD)         | wecomAccountId                  | fallback 重拉该账号全量        |

**Fallback 兜底**:未知 reason / payload 缺关键字段 / `apply_binding` 失败 → 调
`list_all_friends_for_account(wecom_account_id)` 全量重拉该账号 → `replace_all_for_account` 替换行存。

**幂等性**:`INSERT OR REPLACE` + `DELETE` 天然幂等;水位 UPSERT 取大不取小,同 notify_seq 重投不会重复处理。

**前端通知**:`FriendEventApplier` 应用完毕后 broadcast `FriendChanged { employeeId, wecomAccountId? }` →
Tauri emit `friends_changed` → `useFriends` listen 后 `refetch()`(走行存,零远程往返)。

## 联调

mock 后台(`cargo run -p chathub-relay --bin chathub-mock-downstream`)默认每个 mock 账号生成 30 个好友,`MOCK_FRIENDS_PER_ACCOUNT` 环境变量可覆盖:

```bash
MOCK_FRIENDS_PER_ACCOUNT=50 cargo run -p chathub-relay --bin chathub-mock-downstream
```

mock 的 mock_friends 通过 FNV-1a hash `(wecom_account_id, i)` 派生确定性数据,涵盖各 `externalType` / `externalGender` / `addWay` 组合,并按 `addStartTime` / `addEndTime` 在 mock 内做服务端筛选。

直接调 mock(跳过 relay):

```bash
curl -X POST \
  -H "Authorization: Bearer mock-token-xxx" \
  -H "Content-Type: application/json" \
  -d '{"wecomAccountIds":["wa-bj-zhe"],"current":1,"size":100}' \
  http://localhost:8080/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listFriends
```

调用示例(Tauri JS):

```ts
import { fetchFriends } from "@/lib/api/customers";

// 阶段 2:返全量(单 / 多账号合并),每条带 wecomAccountId 归属
const friends = await fetchFriends({
  accountIds: ["wa-bj-zhe", "wa-sz-ling"],
});
console.log(friends.length); // 全量条数
console.log(friends.filter((f) => f.wecomAccountId === "wa-bj-zhe").length); // 单账号过滤

// 强制刷新(用户点"刷新"按钮)
await fetchFriends({ accountIds: ["wa-bj-zhe"], force: true });
```
