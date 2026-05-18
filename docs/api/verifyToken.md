# A2 · verifyToken

Relay 在客户端 Subscribe / Ack / Forward 之前,先用客户端 Bearer token 调业务后台校验身份。
登录路径登录成功后会**预填 cache**,Subscribe 直接命中,跳过这一跳(见 `relay/auth_service.rs:55-65`)。
Cache miss / TTL 过期(5 min)再走真实 HTTP。

> 路径可由 `RELAY_PATH_VERIFY_TOKEN` 环境变量覆盖。

## 请求

| 项     | 值                                                                  |
| ------ | ------------------------------------------------------------------- |
| 方法   | `POST`                                                              |
| 路径   | `/wechat-business-app/rpc/v1/wecomAggregate/connection/verifyToken` |
| Header | `Authorization: Bearer <client_token>`                              |
| Header | `Content-Type: application/json`                                    |
| Body   | `{}`                                                                |

**为什么发 `{}` 而不是空 body**:Spring 默认对 `@PostMapping` 在请求**无 Content-Type 或无 body** 时返 415 Unsupported Media Type,
不进 handler。`{}` + JSON header 是最不可能被挑刺的形态。详见 `downstream.rs:272-285`。

## 响应

### 2xx · 正常

```json
{
  "employeeId": 1231231233112313,
  "username": "",
  "nickName": "",
  "mobile": "",
  "channel": ""
}
```

| 字段         | 类型   | 说明                                                                                                                                                                      |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `employeeId` | int64  | **关键字段**。0 或缺失 → relay `Subscribe/Ack/Forward` 以 `FailedPrecondition` 拒绝 + 错误信息含 "employee_id missing"。relay cache 仍会持有该 ctx 5 min,避免重复打后台。 |
| `username`   | string | 当前未消费,可空                                                                                                                                                           |
| `nickName`   | string | 当前未消费,可空                                                                                                                                                           |
| `mobile`     | string | 当前未消费,可空                                                                                                                                                           |
| `channel`    | string | 当前未消费,可空                                                                                                                                                           |

### 4xx / 5xx

| 状态码                | relay 映射                         | 客户端表现               |
| --------------------- | ---------------------------------- | ------------------------ |
| 400 / 404 / 415 / 422 | `ProtocolMismatch`                 | Terminate(协议错,不重试) |
| 401                   | `InvalidCreds` → `Unauthenticated` | 退出登录                 |
| 5xx                   | `Transient` / `Internal`           | Backoff 重试             |

## relay 内部缓存

- `TokenAuthenticator` 用 `sha256(token)[..8]` 做 cache key
- TTL 5 min(`MAX_CACHE_TTL`)
- Singleflight:同 token 并发 miss 时只发一次下游 verify

## 联调

mock 后台默认 endpoint(`scripts/run-relay-local.sh` 会自动起 `chathub-mock-downstream`):
任意 Bearer token 都接受,返固定 `employeeId = MOCK_USER_ID`(默认 1234)。
