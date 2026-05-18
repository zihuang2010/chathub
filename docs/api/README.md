# 业务后台对接接口清单

Relay 不签发 / 不存储 token,认证全部委托业务后台。下面是已对接的接口,按 relay 调用路径分:

| 编号 | 接口                  | 方法 | 路径                                                                  | 调用方                    | 说明                                                                                     |
| ---- | --------------------- | ---- | --------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| A1   | OAuth2 password grant | POST | `/account-app/oauth2/token`                                           | relay → 业务后台          | 登录,详见 [oauth2-token.md](./oauth2-token.md)(本次未改)                                 |
| A2   | verifyToken           | POST | `/wechat-business-app/rpc/v1/wecomAggregate/connection/verifyToken`   | relay → 业务后台          | Subscribe / Ack / Forward 前的身份校验,详见 [verifyToken.md](./verifyToken.md)           |
| A3   | logout                | POST | `/auth/logout`                                                        | relay → 业务后台          | best-effort,不影响客户端登出(本次未改)                                                   |
| B1   | listMine              | GET  | `/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine`    | 客户端 → relay → 业务后台 | 当前员工可管理企微账号列表,详见 [listMine.md](./listMine.md)                             |
| B2   | listFriends           | POST | `/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listFriends` | 客户端 → relay → 业务后台 | 按多账号拉取好友(客户)列表,服务端分页 + 本地缓存,详见 [listFriends.md](./listFriends.md) |

## 对接约定

- **camelCase JSON**:业务后台一律 camelCase 字段(`employeeId` / `wxCsAccountId`),SDK Rust 端用 `#[serde(rename_all = "camelCase")]` 桥接。
- **Bearer 透传**:除 OAuth2 login 用 Basic auth 外,其余接口的 `Authorization: Bearer <token>` 是客户端原 token,relay 不替换。
- **HTTP 状态语义**:
  - 2xx → 正常响应
  - 401 → relay 映射 `Unauthenticated` / `InvalidCreds`
  - 4xx(400/404/415/422) → relay 映射 `ProtocolMismatch`(客户端 terminate,不退出登录)
  - 5xx / 网络错 → relay 映射 `Internal` / `Transient`(客户端 backoff 重试)
- **Forward 通道**:business RPC 用 `Hub.Forward(method, body_json, query)` 透传,relay 不解 body。`method` 在 `routes` 表查 (verb, path) 后拼下游 URL。
