# chathub-relay

Rust gRPC + HTTP gateway。Plan 6 起从"有状态认证服务器"重构为**无状态隔道网关**:
身份/Token 体系归业务后台,relay 只做长连接、push fanout、事件日志续点。

## 角色

- **上行平面**:Tauri 客户端 → relay gRPC → relay 透传到业务后台 HTTP
- **下行平面**:业务后台 HTTP `POST /internal/push/v2` → relay → 实时 fanout 到客户端 gRPC stream
- **持久化**:本地 SQLite(WAL),只存事件日志和序号,不存身份/token

详细设计见 `/Users/pis0sion/.claude/plans/relay-soft-glade.md` 和
`docs/工具网关通知事件与字段规范.md`。

## 环境变量

### 必填(无默认)

| Env                       | 含义                                                       |
| ------------------------- | ---------------------------------------------------------- |
| `RELAY_DOWNSTREAM_URL`    | 业务后台 base URL,如 `http://erp.local`                    |
| `RELAY_DOWNSTREAM_SECRET` | relay → 业务后台 HTTP 调用的 Bearer secret                 |
| `RELAY_PUSH_SECRET`       | 业务后台 → relay 推送 (`/internal/push*`) 的 Bearer secret |

### 可选(带默认)

| Env                        | Default                    | 含义                                              |
| -------------------------- | -------------------------- | ------------------------------------------------- |
| `RELAY_GRPC_ADDR`          | `127.0.0.1:50051`          | gRPC 监听地址                                     |
| `RELAY_PUSH_ADDR`          | `127.0.0.1:50052`          | HTTP /internal/push 监听地址                      |
| `RELAY_DB_PATH`            | `./relay.db`               | SQLite 文件路径                                   |
| `RELAY_LOG_DIR`            | `./logs`                   | 日志文件目录(按日轮转 JSON)                       |
| `RELAY_LOG_FILE_PREFIX`    | `relay`                    | 日志文件前缀,生成 `<prefix>.YYYY-MM-DD`           |
| `RELAY_LOG_STDOUT`         | `compact`                  | stdout 格式:`off` / `compact` / `pretty` / `json` |
| `RUST_LOG`                 | `info,chathub_relay=debug` | EnvFilter 标准入口                                |
| `RELAY_PATH_SEND`          | `/v1/send`                 | Hub.Forward `"send"` 的业务后台路径               |
| `RELAY_PATH_RECALL`        | `/v1/recall`               | 同上,`"recall"`                                   |
| `RELAY_PATH_ACK_READ`      | `/v1/ack_read`             | 同上,`"ack_read"`                                 |
| `RELAY_PATH_FETCH_HISTORY` | `/v1/fetch_history`        | 同上,`"fetch_history"`                            |

## 启动

```sh
export RELAY_DOWNSTREAM_URL=http://erp.local
export RELAY_DOWNSTREAM_SECRET=dn-secret
export RELAY_PUSH_SECRET=push-secret
cargo run -p chathub-relay --bin chathub-relay
```

## gRPC API(Hub service)

```
service Hub {
  rpc Subscribe(SubscribeRequest) returns (stream ServerEvent);
  rpc Ack(AckRequest) returns (AckResponse);                       // Plan 6
  rpc Forward(ForwardRequest) returns (ForwardResponse);           // Plan 6
  // 兼容期(stage 5 后删除):
  rpc Send / Recall / AckRead / FetchHistory                       // legacy
}
```

### Subscribe(单一长连接)

- 老客户端:`device_id` 留空 + `since_seqs` map → 走 legacy account 路径
- **新客户端**(Plan 6):`device_id` 非空 + `since_notify_seq` → 走 employee 路径
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
           with Bearer $RELAY_DOWNSTREAM_SECRET
           and  X-Relay-Employee-Id: <emp-id>
           body: <透传 body_json>
```

- 加新业务方法 = 加 `RELAY_PATH_*` 环境变量;**relay 二进制不变**
- HTTP 错误映射:401 → `Unauthenticated`,403 → `PermissionDenied`,4xx → `InvalidArgument`,5xx → `Internal`,网络/超时 → `Unavailable`

## 业务后台 → relay push (`POST /internal/push/v2`)

字段对应 `docs/工具网关通知事件与字段规范.md` §3:

```sh
curl -X POST http://127.0.0.1:50052/internal/push/v2 \
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
- **clientId 白名单**:本期硬编码 `["rh_wxchat"]`,非白名单返 403
- **事件分类**:5 种业务事件入事件日志(`MESSAGE_UPSERT` / `SESSION_SUMMARY_UPSERT` / `FRIEND_UPSERT` / `ACCOUNT_BINDING_CHANGE` / `ACCOUNT_STATUS_CHANGE`),`CONNECTION_FORCE_CLOSE` 仅作控制信号不入库,未知 eventType 默认入库(向前兼容)
- **离线员工**:事件入库但 fanout 0 投递,客户端下次 Subscribe v2 用 `since_notify_seq` 续点拉

旧 `/internal/push` endpoint 兼容期保留(对应 legacy account-scope ServerEvent oneof 变体)。

## 运维注意

- **日志**:JSON 文件 + stdout 双 sink;`RELAY_LOG_*` 控制;`RUST_LOG` 控级别
- **事件日志保留**:`events_v2` 默认 TTL 7 天(stage 5+ 可配),超窗口客户端走兜底 API
- **关键不变量**:relay **不解析** 业务 `payload_json`;新增 eventType 不需 relay 升级
- **DownstreamRoutes**:加新业务方法只改 env + 业务后台部署,relay 不动
- **TokenAuthenticator**:LRU 缓存(10k 条,TTL ≤ 5 min)+ singleflight(并发首次 miss 只 1 次 verify_token)
- **本期不做**:多实例、mTLS、密钥轮换、限流、metrics endpoint
