# B1 · listMine

获取当前员工可管理的企微账号列表。客户端入口在 Tauri `list_accounts` 命令,链路:

```
Tauri (UI)
  → invoke("list_accounts", { enabled })
  → backends/src/lib.rs::list_accounts
  → HubClient::list_accounts(filter)
  → Hub.Forward(method="list_accounts", query={enabled?})
  → relay (downstream::forward, GET)
  → 业务后台 listMine
```

> 路径可由 `RELAY_PATH_LIST_ACCOUNTS` 环境变量覆盖。

## 请求

| 项     | 值                                                                 |
| ------ | ------------------------------------------------------------------ | ----------- |
| 方法   | `GET`                                                              |
| 路径   | `/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine` |
| Header | `Authorization: Bearer <client_token>`                             |
| Header | `X-Relay-Employee-Id: <employeeId>`(relay 已校验过,审计用)         |
| Query  | `enabled=true                                                      | false` 可选 |

### Query 参数(占位约定 — 真后端 finalize 后再 freeze)

| 名        | 类型                    | 必填 | 说明                        |
| --------- | ----------------------- | ---- | --------------------------- |
| `enabled` | `bool` (`true`/`false`) | 否   | 仅启用 / 仅停用;不传 = 全量 |

## 响应

### 2xx · 正常

业务后台统一包络(`{code:1, serviceCode, msg, data}`),`data` 为数组(8 字段契约,2026-05 起):

```json
[
  {
    "wecomAccountId": "wa-bj-zhe",
    "wecomName": "北京客服·阿哲",
    "wecomAccount": "mock_wa-bj-zhe",
    "wecomAlias": "wa-bj-zhe_alias",
    "wecomAvatar": "https://example.com/avatar/wa-bj-zhe.png",
    "wecomStatus": 1,
    "gender": 1,
    "position": "工程师"
  }
]
```

| 字段             | 类型   | 说明                                                                                         |
| ---------------- | ------ | -------------------------------------------------------------------------------------------- |
| `wecomAccountId` | string | 账号唯一 ID,前端用作 `Account.id`,也作 mock 联调期派生 city/enterprise/trend 等富字段的 seed |
| `wecomName`      | string | 账号展示名(如 "北京客服·阿哲")                                                               |
| `wecomAccount`   | string | 账号唯一标识(企微账号短串)                                                                   |
| `wecomAlias`     | string | 别名,可独立通过 `ACCOUNT_ALIAS_CHANGED` 事件更新                                             |
| `wecomAvatar`    | string | 头像 URL                                                                                     |
| `wecomStatus`    | int    | 1=启用,0=停用。前端 `enabled` 派生自 `wecomStatus === 1`                                     |
| `gender`         | int    | 0=未知,1=男,2=女                                                                             |
| `position`       | string | 职位描述                                                                                     |

### 4xx / 5xx

| 状态码       | 客户端表现                                   |
| ------------ | -------------------------------------------- |
| 401 / 403    | UI 提示"未授权 / 无权限",可触发重新登录      |
| 5xx / 网络错 | UI 提示"加载失败,点击重试",不影响 token 状态 |

非 2xx 在 SDK 层(`chathub-net/src/hub.rs::list_accounts`)直接映射成 `AuthError::Internal`,
携带 `list_accounts returned http {status}` 文案。

## 前端 derive 约定(mock 联调期)

真后端只返 8 个字段,前端 `Account` 类型还需要 city / enterprise / status / trend7d / customerCount /
sessionCount / lastActiveAt / createdAt / colorToken / ownerName 等。这些字段在 mock 联调期由
`frontends/lib/api/accounts.ts::deriveAccount` 基于 `wecomAccountId` 作 seed 用 LCG 确定性派生 ——
**同一账号每次刷新得相同 derive 值**,UI 不会闪动。

真后端上线后,有两条路:

1. **业务后台直接补全字段** → SDK `ListAccountsItem` 扩字段、前端删 derive。
2. **业务后台拆 listMine + listMineDetail** → derive 保留作"未拉到详情前的占位",拉到详情后覆盖。

## 联调

mock 后台默认 30 条账号(末 3 条 `wecomStatus=0`),`MOCK_ACCOUNTS` 环境变量可覆盖:

```bash
MOCK_ACCOUNTS=wa-1,wa-2 cargo run -p chathub-relay --bin chathub-mock-downstream
```

调用示例(Tauri JS):

```ts
import { invoke } from "@tauri-apps/api/core";
import { fetchAccounts } from "@/lib/api/accounts";

// 高层(推荐)— 自动派生 Account 富字段
const accounts = await fetchAccounts(); // 全量
const enabledOnly = await fetchAccounts(true); // 过滤启用

// 低层 — 拿到原始 ListAccountsItem[]
const raw = await invoke("list_accounts", { enabled: undefined });
```
