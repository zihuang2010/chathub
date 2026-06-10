#!/usr/bin/env bash
# 本地联调:启动 Tauri 客户端,把 RELAY_URL 编译期注入指向本地 relay。
#
# CHATHUB_RELAY_URL 是编译期 env(被 chathub-net/build.rs 烘进 binary,
# 详见 chathub-net/src/lib.rs 里的 `env!("CHATHUB_RELAY_URL_RESOLVED")`)。
# 改了这个 env,cargo 会自动重编 chathub-net + 依赖它的 backends crate。
#
# 用法:
#   scripts/run-tauri-local.sh                       # 默认连本地 relay
#   CHATHUB_RELAY_URL=http://x:50051 scripts/run-tauri-local.sh   # 临时换 relay
#   scripts/run-tauri-local.sh --release             # 透传 tauri 参数

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 客户端编译期可选配置(AI 润色密钥等),存在即 source(已被 .gitignore 忽略)。
# 模板见 scripts/.env.client.example;改 CHATHUB_AI_* 会触发 backends 重编(build.rs)。
ENV_CLIENT="${SCRIPT_DIR}/.env.client"
if [ -f "${ENV_CLIENT}" ]; then
  echo "[tauri-local] 载入 ${ENV_CLIENT}"
  # shellcheck disable=SC1090
  set -a; . "${ENV_CLIENT}"; set +a
fi

export CHATHUB_RELAY_URL="${CHATHUB_RELAY_URL:-http://39.98.175.5:30003}"

# tauri 端的 EnvFilter 读 CHATHUB_LOG (见 backends/src/logging.rs::init),
# 不是 RUST_LOG。所有客户端 tracing target 都在 "chathub::*" 空间。
export CHATHUB_LOG="${CHATHUB_LOG:-info,chathub=debug}"

echo "[tauri-local] CHATHUB_RELAY_URL=${CHATHUB_RELAY_URL}"
echo "[tauri-local] CHATHUB_LOG=${CHATHUB_LOG}"
echo "[tauri-local] cwd=${REPO_ROOT}"
if [ -n "${CHATHUB_AI_API_KEY:-}" ]; then
  echo "[tauri-local] CHATHUB_AI_API_KEY 已设置 (AI 润色可用)"
else
  echo "[tauri-local] CHATHUB_AI_API_KEY 未设置 -> AI 润色会显示「AI 未配置」(见 scripts/.env.client.example)"
fi

cd "${REPO_ROOT}"
exec pnpm tauri dev "$@"
