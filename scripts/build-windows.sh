#!/usr/bin/env bash
# 在 macOS 上交叉编译出 Windows 的 NSIS 安装包(*-setup.exe)。
#
# 背景:本仓库正式出 Windows 包靠 CI(.github/workflows/build.yml 跑 windows-latest)。
# 本脚本是「在当前 Mac 上本地交叉打包」的便捷路径,依赖已装好的工具链:
#   cargo-xwin + rustup target x86_64-pc-windows-msvc + LLVM(clang-cl/llvm-rc/llvm-lib) + makensis
# 这是 Tauri 官方标注的「实验性」非 Windows 交叉编译路径,首跑可能撞到个别工具缺失或
# bundler 小问题;预检会尽量提前暴露。最稳的正式出包途径仍是 CI。
#
# 重要前提(由设计决策固定):
#   1. 无 updater 签名:构建期用 --config 覆盖关掉 createUpdaterArtifacts,不改已提交的
#      tauri.conf.json。产物能装能跑,但装出来的客户端【不能被 updater 自动更新】,仅供
#      本地/内部测试,别拿去正式分发。
#   2. relay 地址默认烘进【测试 relay】(http://47.92.169.112:30003,同 run-tauri-local)。
#      CHATHUB_RELAY_URL 是编译期 env,被 chathub-net/build.rs 写死进二进制;缺它会回落到
#      占位串 relay.example.com(装出来连不上)。可用外部 env 或 scripts/.env.windows 覆盖。
#
# 用法:
#   scripts/build-windows.sh                  # 默认:测试 relay + release + 无签名
#   CHATHUB_RELAY_URL=http://x:50051 scripts/build-windows.sh   # 临时换 relay
#   scripts/build-windows.sh --verbose        # 透传额外参数给 tauri build
#
# 可选:在 scripts/.env.windows(已被 .gitignore 忽略)里写 export CHATHUB_RELAY_URL=...
# 等变量,脚本存在即 source,便于固定你自己的地址而不污染仓库。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TARGET="x86_64-pc-windows-msvc"

# ── LLVM 工具上 PATH ───────────────────────────────────────────────────────
# brew 装的 llvm 不会自动进 PATH;cargo-xwin 需要 clang-cl/llvm-rc/llvm-lib。
LLVM_BIN="/opt/homebrew/opt/llvm/bin"
if [ -d "${LLVM_BIN}" ]; then
  export PATH="${LLVM_BIN}:${PATH}"
fi

# ── 预检 ───────────────────────────────────────────────────────────────────
# 缺啥报啥并给安装提示,避免跑到一半(尤其是漫长的 cargo 编译后)才崩。
fail() { echo "[build-windows] 错误: $*" >&2; exit 1; }

need() {
  # need <命令> <安装提示>
  command -v "$1" >/dev/null 2>&1 || fail "缺少 '$1'。$2"
}

echo "[build-windows] 预检工具链..."

need pnpm        "请先安装 pnpm(本仓库包管理器)。"
need cargo       "请先安装 Rust 工具链(rustup)。"
need cargo-xwin  "交叉编译器缺失,请装: cargo install cargo-xwin"
need clang-cl    "LLVM 工具缺失,请装: brew install llvm (并确认 ${LLVM_BIN} 存在)"
need llvm-rc     "LLVM 资源编译器缺失,请装: brew install llvm"
need llvm-lib    "LLVM 库工具缺失,请装: brew install llvm"
need makensis    "NSIS 缺失(生成安装包用),请装: brew install makensis"

# rustup target
if ! rustup target list --installed 2>/dev/null | grep -qx "${TARGET}"; then
  fail "未安装 Rust target ${TARGET},请装: rustup target add ${TARGET}"
fi

# 链接器:本机若无 lld-link,cargo-xwin 默认回退用 rustup 自带的 rust-lld,通常可用。
# 仅当 lld-link 与 rust-lld 都没有时才视为致命。
if ! command -v lld-link >/dev/null 2>&1; then
  RUST_SYSROOT="$(rustc --print sysroot 2>/dev/null || true)"
  if ! ls "${RUST_SYSROOT}"/lib/rustlib/*/bin/rust-lld >/dev/null 2>&1; then
    fail "找不到链接器(lld-link 与 rust-lld 均缺失),请装: brew install lld"
  fi
  echo "[build-windows] 提示: 无 lld-link,将由 cargo-xwin 回退使用 rust-lld。"
fi

# ── 编译期环境变量 ─────────────────────────────────────────────────────────
# 客户端编译期共享配置(AI 润色密钥等),与 run-tauri-local 同源,存在即 source。
# 模板见 scripts/.env.client.example。
ENV_CLIENT="${SCRIPT_DIR}/.env.client"
if [ -f "${ENV_CLIENT}" ]; then
  echo "[build-windows] 载入 ${ENV_CLIENT}"
  # shellcheck disable=SC1090
  set -a; . "${ENV_CLIENT}"; set +a
fi

# 可选的本地配置(地址/附件域名等),存在才 source。
ENV_FILE="${SCRIPT_DIR}/.env.windows"
if [ -f "${ENV_FILE}" ]; then
  echo "[build-windows] 载入 ${ENV_FILE}"
  # shellcheck disable=SC1090
  set -a; . "${ENV_FILE}"; set +a
fi

# relay 地址:默认测试 relay,可被上面的 env / .env.windows 覆盖。
export CHATHUB_RELAY_URL="${CHATHUB_RELAY_URL:-http://47.92.169.112:30003}"

# 附件预览域名:默认填真实值 filet.jdd51.com,供前端 Vite 与后端 build.rs 同源拼附件 URL。
# 必须给【非空】默认值 —— 若导出空串 "",前端 `?? 默认` 兜不住空串(只兜 undefined)会拼出相对
# 路径(如 `/t/dev/...png`),图片/语音 URL 缺域名全挂(Windows 实测根因);后端 host 也会变空。
export CHATHUB_ATTACHMENT_BASE_URL="${CHATHUB_ATTACHMENT_BASE_URL:-https://filet.jdd51.com}"
export VITE_CHATHUB_ATTACHMENT_BASE_URL="${VITE_CHATHUB_ATTACHMENT_BASE_URL:-${CHATHUB_ATTACHMENT_BASE_URL}}"

# 首次需联网下载 MSVC CRT/SDK(xwin)时自动接受微软许可,避免交互卡住。
export XWIN_ACCEPT_LICENSE="${XWIN_ACCEPT_LICENSE:-1}"

echo "[build-windows] CHATHUB_RELAY_URL=${CHATHUB_RELAY_URL}"
echo "[build-windows] CHATHUB_ATTACHMENT_BASE_URL=${CHATHUB_ATTACHMENT_BASE_URL}"
if [ -n "${CHATHUB_AI_API_KEY:-}" ]; then
  echo "[build-windows] CHATHUB_AI_API_KEY 已设置 (打包客户端 AI 润色可用)"
else
  echo "[build-windows] CHATHUB_AI_API_KEY 未设置 -> 打出的包 AI 润色显示「AI 未配置」(见 scripts/.env.client.example)"
fi
echo "[build-windows] target=${TARGET}  (无签名包: createUpdaterArtifacts=false)"
echo "[build-windows] cwd=${REPO_ROOT}"
echo

# ── 构建 ───────────────────────────────────────────────────────────────────
# --runner cargo-xwin: 让 tauri 用 cargo-xwin 完成到 MSVC 目标的交叉编译。
# --bundles nsis:      只产 Windows 安装包(tauri.conf 的 targets 还混着 mac 的 app/dmg)。
# --config ...:        构建期覆盖关掉 updater 签名,不动已提交的 tauri.conf.json。
# 前端会由 beforeBuildCommand(pnpm build)自动构建,继承上面导出的 env。
cd "${REPO_ROOT}"
pnpm tauri build \
  --runner cargo-xwin \
  --target "${TARGET}" \
  --bundles nsis \
  --config '{"bundle":{"createUpdaterArtifacts":false}}' \
  "$@"

# ── 定位产物 ───────────────────────────────────────────────────────────────
# workspace 改造后产物落仓库根 target/;改造前在 backends/target/。两处都查(同 CI 思路)。
SEARCH_DIRS=()
for d in "${REPO_ROOT}/target/${TARGET}" "${REPO_ROOT}/backends/target/${TARGET}"; do
  [ -d "$d" ] && SEARCH_DIRS+=("$d")
done

SETUP_EXE=""
if [ "${#SEARCH_DIRS[@]}" -gt 0 ]; then
  # 取最新的一个 *-setup.exe(可能存在历史构建残留)。
  SETUP_EXE="$(find "${SEARCH_DIRS[@]}" -type f -name '*-setup.exe' -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -n1 || true)"
fi

echo
if [ -n "${SETUP_EXE}" ] && [ -f "${SETUP_EXE}" ]; then
  SIZE="$(du -h "${SETUP_EXE}" | cut -f1)"
  echo "[build-windows] ✅ 完成: ${SETUP_EXE} (${SIZE})"
  echo "[build-windows] 提示: 无签名包,仅供本地/内部测试,不能被 updater 自动更新。"
else
  fail "构建结束但没找到 *-setup.exe(查过: ${SEARCH_DIRS[*]:-无})。请翻上面的 tauri 输出排查。"
fi
