# chathub-relay

Rust gRPC + HTTP gateway。Plan 6 起从"有状态认证服务器"重构为**无状态隔道网关**:
身份/Token 体系归业务后台,relay 只做长连接、push fanout、事件日志续点。

## 角色

- **上行平面**:Tauri 客户端 → relay gRPC → relay 透传到业务后台 HTTP
- **下行平面**:业务后台 HTTP `POST /rpc/v1/wecomAggregate/notify/push` → relay → 实时 fanout 到客户端 gRPC stream
- **持久化**:本地 SQLite(WAL),只存事件日志和序号,不存身份/token

详细设计见 `/Users/pis0sion/.claude/plans/relay-soft-glade.md` 和
`docs/工具网关通知事件与字段规范.md`。

## 环境变量

### 必填(无默认)

| Env                    | 含义                                                                          |
| ---------------------- | ----------------------------------------------------------------------------- |
| `RELAY_DOWNSTREAM_URL` | 业务后台 base URL,如 `http://erp.local`                                       |
| `RELAY_PUSH_SECRET`    | 业务后台 → relay 推送 (`/rpc/v1/wecomAggregate/notify/push`) 的 Bearer secret |

> 2026-05-16 OAuth2 重构后,`RELAY_DOWNSTREAM_SECRET` **已下线**。所有 relay → 业务后台的请求一律用**客户端原 Bearer token**透传(login 例外,走 OAuth2 Basic client auth)。

### 可选(带默认)

| Env                          | Default                                                                | 含义                                              |
| ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| `RELAY_GRPC_ADDR`            | `127.0.0.1:50051`                                                      | gRPC 监听地址                                     |
| `RELAY_PUSH_ADDR`            | `127.0.0.1:50052`                                                      | HTTP /rpc/v1/wecomAggregate/notify/push 监听地址  |
| `RELAY_DB_PATH`              | `./relay.db`                                                           | SQLite 文件路径                                   |
| `RELAY_LOG_DIR`              | `./logs`                                                               | 日志文件目录(按日轮转 JSON)                       |
| `RELAY_LOG_FILE_PREFIX`      | `relay`                                                                | 日志文件前缀,生成 `<prefix>.YYYY-MM-DD.log`       |
| `RELAY_LOG_MAX_FILES`        | `7`                                                                    | 按日保留的日志份数上限,超出删最旧;0 非法          |
| `RELAY_LOG_STDOUT`           | `compact`                                                              | stdout 格式:`off` / `compact` / `pretty` / `json` |
| `RUST_LOG`                   | `info,chathub_relay=debug`                                             | EnvFilter 标准入口                                |
| `RELAY_OAUTH_CLIENT_ID`      | `rh_wxchat`                                                            | OAuth2 Basic client id(login 时用)                |
| `RELAY_OAUTH_CLIENT_SECRET`  | `rh_wxchat`                                                            | OAuth2 Basic client secret(login 时用)            |
| `RELAY_PATH_LOGIN`           | `/account-app/oauth2/token`                                            | OAuth2 token endpoint                             |
| `RELAY_PATH_VERIFY_TOKEN`    | `/v1/verify_token`                                                     | introspection endpoint                            |
| `RELAY_PATH_LOGOUT`          | `/auth/logout`                                                         | logout endpoint                                   |
| `RELAY_PATH_SEND`            | `/v1/send`                                                             | Hub.Forward `"send"` 的业务后台路径(POST)         |
| `RELAY_PATH_RECALL`          | `/v1/recall`                                                           | 同上,`"recall"`(POST)                             |
| `RELAY_PATH_ACK_READ`        | `/v1/ack_read`                                                         | 同上,`"ack_read"`(POST)                           |
| `RELAY_PATH_FETCH_HISTORY`   | `/v1/fetch_history`                                                    | 同上,`"fetch_history"`(POST)                      |
| `RELAY_PATH_LIST_ACCOUNTS`   | `GET:/wechat-business-app/wecom-cs/v1/wecomAggregate/account/listMine` | `"list_accounts"`(GET)                            |
| `RELAY_FORCE_CLOSE_GRACE_MS` | `2000`                                                                 | 收到 CONNECTION_FORCE_CLOSE 后等多久才摘除连接    |
| `RELAY_ALLOWED_CLIENT_IDS`   | `rh_wxchat`                                                            | 逗号分隔的 push v2 clientId 白名单                |

`RELAY_PATH_*` 接受两种格式:

- `RELAY_PATH_X=/path` — verb 用默认表中的值(已部署的 SEND/RECALL/ACK_READ/FETCH_HISTORY 沿用 POST)
- `RELAY_PATH_X=GET:/path` 或 `RELAY_PATH_X=POST:/path` — 显式覆盖 verb

## 启动

```sh
export RELAY_DOWNSTREAM_URL=http://erp.local
export RELAY_PUSH_SECRET=push-secret
# OAuth2 credentials(可选,默认都是 rh_wxchat)
# export RELAY_OAUTH_CLIENT_ID=rh_wxchat
# export RELAY_OAUTH_CLIENT_SECRET=rh_wxchat
cargo run -p chathub-relay --bin chathub-relay
```

## gRPC API(Auth + Hub services)

```
service Auth {
  rpc Login(LoginRequest)   returns (LoginResponse);    // OAuth2 password grant
  rpc Logout(LogoutRequest) returns (LogoutResponse);
}

service Hub {
  rpc Subscribe(SubscribeRequest) returns (stream ServerEvent);
  rpc Ack(AckRequest) returns (AckResponse);
  rpc Forward(ForwardRequest) returns (ForwardResponse);
}
```

### Auth.Login(OAuth2 透传)

relay 收到 `LoginRequest { username, password, device_id, ... }` 后,以 OAuth2 password grant 形态发到业务后台:

```
POST {RELAY_DOWNSTREAM_URL}{RELAY_PATH_LOGIN}?scope=server&terminalId=<terminal_id>&grant_type=password
Authorization: Basic Base64("<RELAY_OAUTH_CLIENT_ID>:<RELAY_OAUTH_CLIENT_SECRET>")
Content-Type: application/x-www-form-urlencoded

username=<u>&password=<p>
```

> `terminalId` 不直接用 `device_id`,而是由 `device_id + username` 确定性派生的 UUIDv5
> (见 `downstream::terminal_id_for`)。否则同一台设备上多账号会共用同一终端标识,业务后台
> 会把不同账号当成同一终端而相互串扰。同设备同账号恒定不变、不同账号必不相同、仍是合法 UUID。

响应 `JddTokenVO` 被 relay 摘成 `LoginResponse { access_token, user{user_id, display_name}, wecom_accounts: [] }`。
**`wecom_accounts` 永远为空** —— 前端登录后调 `Hub.Forward("list_accounts", "")` 拿账号列表。

### Subscribe(employee-scope 单一长连接)

- `device_id` 非空 + `since_notify_seq` → relay 拿 employee_id 索引路由 + 重放 events_v2
  - 第一帧 `SubscribeAck { resumed_from_seq, replayed_to_seq, resync_required, resync_reason }`
  - 后续帧 `PushBatchOut { notify_seq, employee_id, batch_id, batch_time, events_json (bytes) }`
  - 客户端 `JSON.parse(events_json)` 后按 `eventType` 分支(参考 `docs/工具网关通知事件与字段规范.md`)
  - 超出 events_v2 保留窗口(默认 7 天)时 `resync_required=true`,客户端走业务后台 `recentFriends` / `message/history` 兜底

### Ack(客户端水位上报)

```
client → Hub.Ack({notify_seq: 1024})
```

relay 记录该 employee 已处理水位,仅观测;不参与事件日志清理(走 TTL)。

### Forward(单一业务透传)

```
client → Hub.Forward({method: "send", body_json: <bytes>})
relay  → POST $RELAY_DOWNSTREAM_URL$RELAY_PATH_SEND
           with Bearer <客户端原 token>     # ← OAuth2 重构后:不再是 relay shared secret
           and  X-Relay-Employee-Id: <emp-id>  # 审计/兜底用,业务后台可忽略
           body: <透传 body_json>
```

GET 方法(`RELAY_PATH_X=GET:/...`,如 `list_accounts`):relay 用 GET 转发,body 忽略。

- 加新业务方法 = 加 `RELAY_PATH_*` 环境变量;**relay 二进制不变**
- **客户端 token 透传**:业务后台从 Bearer 自己解 employee 身份;`X-Relay-Employee-Id` 仅作 relay 已验证身份的旁证
- **REST 隧道语义**:
  - 2xx → gRPC Ok + `ForwardResponse { body_json, http_status }`
  - 4xx → 同样 Ok(REST 风格透传),客户端**根据 `http_status` 自行判断业务错**,relay 不替它解读
  - 5xx → `Status::Internal`(transport-level)
  - 网络/超时 → `Status::Unavailable`

## 业务后台 → relay push (`POST /rpc/v1/wecomAggregate/notify/push`)

字段对应 `docs/工具网关通知事件与字段规范.md` §3:

```sh
curl -X POST http://127.0.0.1:50052/rpc/v1/wecomAggregate/notify/push \
  -H "Authorization: Bearer $RELAY_PUSH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "notifySeq": 1024,
    "clientId": "rh_wxchat",
    "employeeId": 1943599583609966592,
    "batchId": "rh_wxchat:1943599583609966592:1024",
    "batchTime": "2026-05-14 10:30:00",
    "events": [
      {
        "eventType": "MESSAGE_UPSERT",
        "eventReason": "CUSTOMER_MESSAGE_RECEIVED",
        "conversationId": "123456",
        "customerUserId": "rocky",
        "externalUserId": "woAJ2GCAAAXxx",
        "message": { ... }
      }
    ]
  }'
# → 200 {"notifySeq":1024,"inserted":1,"controlCount":0}
```

- **幂等**:同 `(employeeId, notifySeq, event_index)` 重投 → `inserted=0`(SQLite 主键 `INSERT OR IGNORE`)
- **clientId 白名单**:env `RELAY_ALLOWED_CLIENT_IDS`(逗号分隔)控制,默认 `["rh_wxchat"]`,非白名单返 403
- **Bearer 校验**:常数时间比较(P0-2),防时序攻击
- **事件分类**:5 种业务事件入事件日志(`MESSAGE_UPSERT` / `SESSION_SUMMARY_UPSERT` / `FRIEND_UPSERT` / `ACCOUNT_BINDING_CHANGE` / `ACCOUNT_STATUS_CHANGE`),`CONNECTION_FORCE_CLOSE` 仅作控制信号不入库,未知 eventType 默认入库(向前兼容)
- **离线员工**:事件入库但 fanout 0 投递,客户端下次 Subscribe v2 用 `since_notify_seq` 续点拉

## 运维注意

- **日志**:JSON 文件 + stdout 双 sink;`RELAY_LOG_*` 控制;`RUST_LOG` 控级别。文件按日轮转并保留最近 `RELAY_LOG_MAX_FILES` 份(默认 7,超出自动删最旧),磁盘占用有界。文件名带后缀:主日志 `<prefix>.<date>.log`、source-json 旁路 `relay-source-json.<date>.jsonl`(后缀让保留清理只动日志文件,不误删 `relay.db`)
- **事件日志保留**:`events_v2` 默认 TTL 7 天(stage 5+ 可配),超窗口客户端走兜底 API
- **关键不变量**:relay **不解析** 业务 `payload_json`;新增 eventType 不需 relay 升级
- **DownstreamRoutes**:加新业务方法只改 env + 业务后台部署,relay 不动
- **TokenAuthenticator**:LRU 缓存(10k 条,TTL ≤ 5 min)+ singleflight(并发首次 miss 只 1 次 verify_token)+ RAII guard(leader panic 也能清理 inflight)
- **SQLite 并发**:WAL + `busy_timeout=5s` + per-checkout PRAGMA reapply(`Storage::conn()`)
- **Hub.Forward 错误语义**:4xx 不映射成 gRPC error(避免客户端误判鉴权失败),通过 `ForwardResponse.http_status` 返回上游状态码;只有 5xx / 网络/超时 转 `Status::Internal/Unavailable`
- **Graceful shutdown**:Ctrl-C / SIGTERM → 广播 `SystemSignal::SERVER_DRAIN` → 等 2s → tonic/axum graceful_shutdown
- **本期不做**:多实例、mTLS、密钥轮换、限流、metrics endpoint
