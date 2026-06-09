#!/usr/bin/env bash
# 在本机 macOS 上本地打一个生产包(*.app + *.dmg),供真机自测。
#
# 背景:本仓库正式出 macOS 包靠 CI(.github/workflows/build.yml 跑 macos-14)。本脚本是
# 「在当前 Mac 上本地打包」的便捷路径,与 scripts/build-windows.sh 对称,env 同源。
#
# 重要前提(与 build-windows.sh 一致的设计决策):
#   1. 无 updater 签名:构建期用 --config 覆盖关掉 createUpdaterArtifacts,不改已提交的
#      tauri.conf.json。产物能装能跑,但【不能被 updater 自动更新】,仅供本地/内部测试。
#   2. 无 Apple 代码签名/公证:本地默认 ad-hoc 签名(同 CI)。本地构建的 .app 不带
#      com.apple.quarantine,可直接运行;不要拿去正式分发。
#   3. relay 地址默认烘进【测试 relay】(http://47.92.169.112:30003,同 build-windows)。
#      CHATHUB_RELAY_URL 是编译期 env,被 chathub-net/build.rs 写死进二进制;缺它会回落到
#      占位串 relay.example.com(装出来连不上)。可用外部 env 或 scripts/.env.mac 覆盖。
#
# 用法:
#   scripts/build-mac.sh                       # 默认:测试 relay + release + 无签名,出 app+dmg
#   CHATHUB_RELAY_URL=http://x:50051 scripts/build-mac.sh   # 临时换 relay
#   scripts/build-mac.sh --verbose             # 透传额外参数给 tauri build
#
# 可选:在 scripts/.env.mac(已被 .gitignore 忽略)里写 export CHATHUB_RELAY_URL=... 等变量,
# 脚本存在即 source,便于固定你自己的地址而不污染仓库。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── 目标三元组:按本机架构(arm64 / x86_64)选 native target ───────────────────
case "$(uname -m)" in
  arm64)  TARGET="aarch64-apple-darwin" ;;
  x86_64) TARGET="x86_64-apple-darwin" ;;
  *)      echo "[build-mac] 错误: 未知架构 $(uname -m)" >&2; exit 1 ;;
esac

# ── 预检 ───────────────────────────────────────────────────────────────────
fail() { echo "[build-mac] 错误: $*" >&2; exit 1; }

need() {
  # need <命令> <安装提示>
  command -v "$1" >/dev/null 2>&1 || fail "缺少 '$1'。$2"
}

echo "[build-mac] 预检工具链..."
need pnpm  "请先安装 pnpm(本仓库包管理器)。"
need cargo "请先安装 Rust 工具链(rustup)。"

# native target 一般默认就有;缺了给安装提示。
if ! rustup target list --installed 2>/dev/null | grep -qx "${TARGET}"; then
  fail "未安装 Rust target ${TARGET},请装: rustup target add ${TARGET}"
fi

# ── 编译期环境变量 ─────────────────────────────────────────────────────────
# 客户端编译期共享配置(AI 润色密钥等),与 build-windows 同源,存在即 source。
# 模板见 scripts/.env.client.example。
ENV_CLIENT="${SCRIPT_DIR}/.env.client"
if [ -f "${ENV_CLIENT}" ]; then
  echo "[build-mac] 载入 ${ENV_CLIENT}"
  # shellcheck disable=SC1090
  set -a; . "${ENV_CLIENT}"; set +a
fi

# 可选的本地配置(地址/附件域名等),存在才 source。
ENV_FILE="${SCRIPT_DIR}/.env.mac"
if [ -f "${ENV_FILE}" ]; then
  echo "[build-mac] 载入 ${ENV_FILE}"
  # shellcheck disable=SC1090
  set -a; . "${ENV_FILE}"; set +a
fi

# relay 地址:默认测试 relay,可被上面的 env / .env.mac 覆盖。
export CHATHUB_RELAY_URL="${CHATHUB_RELAY_URL:-http://47.92.169.112:30003}"

# 附件预览域名:默认填真实值 filet.jdd51.com,供前端 Vite 与后端 build.rs 同源拼附件 URL。
# 必须给【非空】默认值,且前(VITE_)后端两侧同源 —— 否则前端拼出的远程域与后端 SSRF 白名单
# host 不一致,消息图会被静默拒成 404。
export CHATHUB_ATTACHMENT_BASE_URL="${CHATHUB_ATTACHMENT_BASE_URL:-https://filet.jdd51.com}"
export VITE_CHATHUB_ATTACHMENT_BASE_URL="${VITE_CHATHUB_ATTACHMENT_BASE_URL:-${CHATHUB_ATTACHMENT_BASE_URL}}"

echo "[build-mac] CHATHUB_RELAY_URL=${CHATHUB_RELAY_URL}"
echo "[build-mac] CHATHUB_ATTACHMENT_BASE_URL=${CHATHUB_ATTACHMENT_BASE_URL}"
if [ -n "${CHATHUB_AI_API_KEY:-}" ]; then
  echo "[build-mac] CHATHUB_AI_API_KEY 已设置 (打包客户端 AI 润色可用)"
else
  echo "[build-mac] CHATHUB_AI_API_KEY 未设置 -> 打出的包 AI 润色显示「AI 未配置」(见 scripts/.env.client.example)"
fi
echo "[build-mac] target=${TARGET}  (无签名包: createUpdaterArtifacts=false)"
echo "[build-mac] cwd=${REPO_ROOT}"
echo

# ── 构建 ───────────────────────────────────────────────────────────────────
# --bundles app,dmg:  出可直接运行的 .app + 可分发的 .dmg(同 CI macos 矩阵)。
# --config ...:        构建期覆盖关掉 updater 签名,不动已提交的 tauri.conf.json。
# 前端会由 beforeBuildCommand(pnpm build)自动构建,继承上面导出的 env。
cd "${REPO_ROOT}"
pnpm tauri build \
  --target "${TARGET}" \
  --bundles app,dmg \
  --config '{"bundle":{"createUpdaterArtifacts":false}}' \
  "$@"

# ── 定位产物 ───────────────────────────────────────────────────────────────
# workspace 改造后产物落仓库根 target/;改造前在 backends/target/。两处都查(同 CI 思路)。
SEARCH_DIRS=()
for d in "${REPO_ROOT}/target/${TARGET}/release/bundle" \
         "${REPO_ROOT}/backends/target/${TARGET}/release/bundle"; do
  [ -d "$d" ] && SEARCH_DIRS+=("$d")
done

DMG="" ; APP=""
if [ "${#SEARCH_DIRS[@]}" -gt 0 ]; then
  DMG="$(find "${SEARCH_DIRS[@]}" -type f -name '*.dmg' -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -n1 || true)"
  APP="$(find "${SEARCH_DIRS[@]}" -type d -name '*.app' -print0 2>/dev/null \
    | xargs -0 ls -dt 2>/dev/null | head -n1 || true)"
fi

echo
if [ -n "${APP}" ] && [ -d "${APP}" ]; then
  echo "[build-mac] ✅ .app: ${APP}"
fi
if [ -n "${DMG}" ] && [ -f "${DMG}" ]; then
  echo "[build-mac] ✅ .dmg: ${DMG} ($(du -h "${DMG}" | cut -f1))"
fi
if [ -z "${APP}" ] && [ -z "${DMG}" ]; then
  fail "构建结束但没找到 .app/.dmg(查过: ${SEARCH_DIRS[*]:-无})。请翻上面的 tauri 输出排查。"
fi
echo "[build-mac] 提示: 无签名包,仅供本地/内部测试,不能被 updater 自动更新。"
echo "[build-mac] 直接运行: open \"${APP:-<未产出 .app>}\""
