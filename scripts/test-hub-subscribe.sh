#!/usr/bin/env bash
# 本地联调:跳过登录,用预签 JWT 直接调 hub.Subscribe,持续打印 ServerEvent。
#
# 前置:scripts/run-relay-local.sh 已在跑(grpc=127.0.0.1:50051)。
# 脚本会自动读 scripts/.env.local 取 RELAY_DB_PATH,确保和 relay 用同一个 db
# (mint-jwt 必须读到 relay 启动后写入的 jwt_priv_pem,否则会签不一致的 key)。
#
# 用法:
#   USER_ID=u-test ACCOUNTS=wa-1 scripts/test-hub-subscribe.sh
#   USER_ID=u-test ACCOUNTS=wa-1,wa-2 DEVICE_ID=mac-1 scripts/test-hub-subscribe.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.local"

if [[ -f "${ENV_FILE}" ]]; then
  set -a; source "${ENV_FILE}"; set +a
fi

# 必填参数
: "${USER_ID:?USER_ID env required (e.g. USER_ID=u-test)}"
: "${ACCOUNTS:?ACCOUNTS env required, comma-separated (e.g. ACCOUNTS=wa-1,wa-2)}"

export DEVICE_ID="${DEVICE_ID:-test-device-1}"
export TTL_SECS="${TTL_SECS:-1800}"
export RELAY_DB_PATH="${RELAY_DB_PATH:-${REPO_ROOT}/relay.db}"
export RELAY_ISSUER="${RELAY_ISSUER:-chathub-relay}"
export RELAY_URL="${RELAY_URL:-http://127.0.0.1:50051}"

if [[ ! -f "${RELAY_DB_PATH}" ]]; then
  echo "[test-hub] relay.db not found at ${RELAY_DB_PATH}" >&2
  echo "[test-hub] start relay first: scripts/run-relay-local.sh" >&2
  exit 1
fi

cd "${REPO_ROOT}"

echo "[test-hub] minting JWT  user=${USER_ID} accounts=${ACCOUNTS} device=${DEVICE_ID} ttl=${TTL_SECS}s db=${RELAY_DB_PATH}"
TOKEN="$(cargo run -q -p chathub-relay --bin chathub-mint-jwt)"
echo "[test-hub] token=${TOKEN:0:24}…${TOKEN: -8}  (len=${#TOKEN})"

echo "[test-hub] subscribing to ${RELAY_URL} (Ctrl-C to stop)"
TOKEN="${TOKEN}" RELAY_URL="${RELAY_URL}" ACCOUNTS="${ACCOUNTS}" \
  exec cargo run -q -p chathub-relay --bin chathub-test-subscribe
