#!/usr/bin/env bash
# 生产启动 chathub-relay:source 环境变量文件(注入配置)→ exec release 二进制。
#
# 配置注入发生在「启动时」(relay 运行时读 env),与 cargo build 无关:
# 同一个 release 二进制可跑任意环境,环境差异全在 env 文件里。
#
# 两步流程:
#   1) 构建(配置无关,一次即可):
#        (cd backends && cargo build --release -p chathub-relay)
#   2) 配置 + 启动:
#        cp scripts/.env.example scripts/.env.production   # 首次,填好真实值
#        scripts/run-relay-prod.sh
#
#   覆盖 env 文件:  RELAY_ENV_FILE=/path/to/other.env scripts/run-relay-prod.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${RELAY_ENV_FILE:-${SCRIPT_DIR}/.env.production}"
# release 二进制位置:cargo workspace 的 target-dir 落在仓库根(target/),
# 同时兼容落在 backends/target/ 的情况 —— 哪个存在用哪个。
BIN=""
for cand in \
  "${REPO_ROOT}/target/release/chathub-relay" \
  "${REPO_ROOT}/backends/target/release/chathub-relay"; do
  if [[ -x "${cand}" ]]; then BIN="${cand}"; break; fi
done

# 1. 环境变量文件
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[relay-prod] 缺少环境变量文件:${ENV_FILE}" >&2
  echo "[relay-prod] 请先:cp ${SCRIPT_DIR}/.env.example ${ENV_FILE} 并填好值" >&2
  exit 1
fi
# fail-fast:防止未替换的占位符直接上生产(忽略注释行)
if grep -v '^[[:space:]]*#' "${ENV_FILE}" | grep -q 'REPLACE_ME'; then
  echo "[relay-prod] ${ENV_FILE} 仍残留 REPLACE_ME 占位符,请先填好真实值" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "${ENV_FILE}"; set +a

# 2. release 二进制
if [[ -z "${BIN}" ]]; then
  echo "[relay-prod] 未找到 release 二进制(已查 target/release 与 backends/target/release)" >&2
  echo "[relay-prod] 请先构建:(cd ${REPO_ROOT}/backends && cargo build --release -p chathub-relay)" >&2
  exit 1
fi

echo "[relay-prod] env=${ENV_FILE}"
echo "[relay-prod] grpc=${RELAY_GRPC_ADDR:-127.0.0.1:50051}  push=${RELAY_PUSH_ADDR:-127.0.0.1:50052}  nacos=${RELAY_NACOS_ENABLED:-false}"
echo "[relay-prod] bin=${BIN}"

exec "${BIN}"
