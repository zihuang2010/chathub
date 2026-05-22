#!/usr/bin/env bash
# 本地联调:启动 mock 下游(OAuth2 重构后,所有端点都接受任意值)。
#
# 必须先于 relay 启动 —— relay 启动时不会立刻连下游,但客户端 Login 触发
# OAuth2 token / verify_token / forward 时,下游必须已在跑。
#
# 用法:
#   scripts/run-mock-downstream.sh
#   MOCK_DOWNSTREAM_ADDR=127.0.0.1:18080 scripts/run-mock-downstream.sh
#   MOCK_USER_ID=4321 MOCK_ACCOUNTS=wa-1,wa-2 scripts/run-mock-downstream.sh
#
# mock 行为:
#   - 每个 HTTP 请求/响应整段 dump 到 stdout(method/URL/headers/body)
#   - OAuth2 token 接受任意 Basic + 任意 username/password → 返 JddTokenVO
#   - verify_token / logout / 业务接口 接受任意 Bearer
#   - listMine 返 MOCK_ACCOUNTS 列表(脚本不预设,fallback 到 binary 内置 30 条)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.local"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
fi

# 2026-05-16 OAuth2 重构后,MOCK_DOWNSTREAM_SECRET 不再需要(改走客户端 token 透传)。
# OAuth2 Basic client_id:client_secret 默认 rh_wxchat:rh_wxchat(对齐 RELAY_OAUTH_CLIENT_*)。
export MOCK_OAUTH_CLIENT_ID="${MOCK_OAUTH_CLIENT_ID:-${RELAY_OAUTH_CLIENT_ID:-rh_wxchat}}"
export MOCK_OAUTH_CLIENT_SECRET="${MOCK_OAUTH_CLIENT_SECRET:-${RELAY_OAUTH_CLIENT_SECRET:-rh_wxchat}}"
export MOCK_DOWNSTREAM_ADDR="${MOCK_DOWNSTREAM_ADDR:-127.0.0.1:8080}"
export MOCK_USER_ID="${MOCK_USER_ID:-1234}"
export MOCK_NICK_NAME="${MOCK_NICK_NAME:-匠多多}"
# 锁定 MOCK_TOKEN 为 user_id 派生形态:跨重启稳定,便于客户端 try_resume 联调。
# 想要随机 token 验证"token 失效"场景时,export MOCK_TOKEN=随机值。
export MOCK_TOKEN="${MOCK_TOKEN:-mock-token-${MOCK_USER_ID}}"
# MOCK_ACCOUNTS 不预设 — 让 binary 内置默认(30 条样例账号)生效。
# 想跑特定列表时显式 export:`MOCK_ACCOUNTS=wa-1,wa-2 scripts/run-mock-downstream.sh`

export RUST_LOG="${RUST_LOG:-info,mock_downstream=debug}"

echo "[mock-downstream] addr=${MOCK_DOWNSTREAM_ADDR}"
echo "[mock-downstream] oauth client_id=${MOCK_OAUTH_CLIENT_ID} client_secret=${MOCK_OAUTH_CLIENT_SECRET}"
echo "[mock-downstream] user_id=${MOCK_USER_ID} nick_name=${MOCK_NICK_NAME} token=${MOCK_TOKEN}"
echo "[mock-downstream] accounts=${MOCK_ACCOUNTS:-<binary 内置默认 30 条>}"
echo "[mock-downstream] RUST_LOG=${RUST_LOG}"
echo "[mock-downstream] 每个请求/响应都会整段 dump 到 stdout"

cd "${REPO_ROOT}"
exec cargo run -q -p chathub-relay --bin chathub-mock-downstream "$@"
