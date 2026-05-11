# chathub-relay — Walking Skeleton

Rust gRPC gateway:client ↔ relay ↔ downstream HTTP。

## 环境变量

| Env                         | Required | Default           |
| --------------------------- | -------- | ----------------- |
| `RELAY_GRPC_ADDR`           | no       | `127.0.0.1:50051` |
| `RELAY_PUSH_ADDR`           | no       | `127.0.0.1:50052` |
| `RELAY_DB_PATH`             | no       | `./relay.db`      |
| `RELAY_DOWNSTREAM_URL`      | **yes**  | —                 |
| `RELAY_DOWNSTREAM_SECRET`   | no       | empty             |
| `RELAY_PUSH_SECRET`         | **yes**  | —                 |
| `RELAY_JWT_PRIVATE_PEM`     | no       | (gen 后入 kv 表)  |
| `RELAY_JWT_KID`             | no       | (gen)             |
| `RELAY_ISSUER`              | no       | `chathub-relay`   |
| `RELAY_ACCESS_TTL_SECS`     | no       | `1800`            |
| `RELAY_REFRESH_TTL_SECS`    | no       | `2592000`         |
| `RELAY_REFRESH_HASH_PEPPER` | **yes**  | —                 |

## 启动

```sh
export RELAY_DOWNSTREAM_URL=http://erp.local
export RELAY_DOWNSTREAM_SECRET=dn-secret
export RELAY_PUSH_SECRET=push-secret
export RELAY_REFRESH_HASH_PEPPER=$(openssl rand -hex 32)
cargo run -p chathub-relay --bin chathub-relay
```

## 下游 5 endpoint 合约(spec-only,Plan 6+ 实现)

```sh
# verify_user
curl -sX POST $RELAY_DOWNSTREAM_URL/v1/verify_user \
  -H "Authorization: Bearer $RELAY_DOWNSTREAM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"username":"u","password":"p","device_id":"d","device_name":"M"}'

# send
curl -sX POST $RELAY_DOWNSTREAM_URL/v1/send \
  -H "Authorization: Bearer $RELAY_DOWNSTREAM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u-1","wecom_account_id":"wa-1","conversation_id":"c","client_msg_id":"x","body":{"text":{"content":"hi"}}}'

# recall
curl -sX POST $RELAY_DOWNSTREAM_URL/v1/recall \
  -H "Authorization: Bearer $RELAY_DOWNSTREAM_SECRET" -H "Content-Type: application/json" \
  -d '{"user_id":"u-1","wecom_account_id":"wa-1","conversation_id":"c","server_msg_id":"sm-1"}'

# ack_read
curl -sX POST $RELAY_DOWNSTREAM_URL/v1/ack_read \
  -H "Authorization: Bearer $RELAY_DOWNSTREAM_SECRET" -H "Content-Type: application/json" \
  -d '{"user_id":"u-1","wecom_account_id":"wa-1","conversation_id":"c","last_read_server_msg_id":"sm-1"}'

# fetch_history
curl -sX POST $RELAY_DOWNSTREAM_URL/v1/fetch_history \
  -H "Authorization: Bearer $RELAY_DOWNSTREAM_SECRET" -H "Content-Type: application/json" \
  -d '{"user_id":"u-1","wecom_account_id":"wa-1","conversation_id":"c","limit":50,"cursor":""}'
```

## 下游 → relay push

```sh
curl -sX POST http://127.0.0.1:50052/internal/push \
  -H "Authorization: Bearer $RELAY_PUSH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "wecom_account_id":"wa-1",
    "event":{
      "wecom_account_id":"","seq":0,
      "incoming":{
        "conversation_id":"c-1","from_user_id":"peer-1","sent_at_ms":0,
        "server_msg_id":"sm-1","body":{"text":{"content":"hello"}}
      }
    }
  }'
# → 202 {"assigned_seq":1,"no_stream":false}
```

## 运维注意

- **HMAC pepper 不能轻易换**:换 pepper = invalidate 所有 refresh_token。
- **DB 回滚 = session 失效**:用户需重新 login。
- Plan 5 不做 JWT key rotation,不做 mTLS;留 Plan 6+。
