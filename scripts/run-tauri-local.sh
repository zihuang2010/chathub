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

export CHATHUB_RELAY_URL="${CHATHUB_RELAY_URL:-http://47.92.169.112:30003}"

# tauri 端的 EnvFilter 读 CHATHUB_LOG (见 backends/src/logging.rs::init),
# 不是 RUST_LOG。所有客户端 tracing target 都在 "chathub::*" 空间。
export CHATHUB_LOG="${CHATHUB_LOG:-info,chathub=debug}"

echo "[tauri-local] CHATHUB_RELAY_URL=${CHATHUB_RELAY_URL}"
echo "[tauri-local] CHATHUB_LOG=${CHATHUB_LOG}"
echo "[tauri-local] cwd=${REPO_ROOT}"

cd "${REPO_ROOT}"
exec pnpm tauri dev "$@"
