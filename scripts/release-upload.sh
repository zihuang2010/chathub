#!/usr/bin/env bash
# 把 dist-release/v<version> 推到 OSS 的 chathub-releases/ 下，供 Tauri updater 使用。
#
# 用法：
#   ./scripts/release-upload.sh                       # 取 package.json 当前版本
#   ./scripts/release-upload.sh --version 0.1.4
#   ./scripts/release-upload.sh --dry-run             # 只打印要执行的命令
#
# 上传顺序：bundles/ 先全部推完，latest.json 最后写入根路径，避免 updater
# 在产物未就位时就指向新版本。
set -euo pipefail

# 目标 OSS（与 backends/tauri.conf.json 的 updater endpoint、
# scripts/make-latest-json.mjs 输出的 url 模板严格一致）
BUCKET="jdd-rh-test1"
REGION="oss-cn-zhangjiakou"
PREFIX="chathub-releases"
EXPECTED_BASE_URL="https://${BUCKET}.${REGION}.aliyuncs.com/${PREFIX}"

DRY_RUN=0
VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)  VERSION="${2:?--version 需要值}"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,9p' "$0"; exit 0 ;;
    *)          echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -n "$VERSION" ]] || VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"

STAGE="${REPO_ROOT}/dist-release/v${VERSION}"
MANIFEST="${STAGE}/latest.json"
BUNDLES="${STAGE}/bundles"

command -v ossutil >/dev/null || { echo "ossutil 未安装" >&2; exit 1; }
[[ -f "$MANIFEST" ]] || { echo "找不到 manifest: $MANIFEST" >&2; exit 1; }
[[ -d "$BUNDLES"  ]] || { echo "找不到 bundles 目录: $BUNDLES" >&2; exit 1; }

echo "[release-upload] 版本   : $VERSION"
echo "[release-upload] 本地源 : $STAGE"
echo "[release-upload] 目标   : oss://${BUCKET}/${PREFIX}/  (版本目录 + latest.json)"
echo

# 严格校验：manifest 中每个平台的 url / signature 与本地实际文件一致
node --input-type=module - "$MANIFEST" "$BUNDLES" "$VERSION" "$EXPECTED_BASE_URL" <<'NODE'
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
const [manifestPath, bundlesRoot, version, baseUrl] = process.argv.slice(2);
const m = JSON.parse(readFileSync(manifestPath, "utf8"));
if (m.version !== version) {
  console.error(`✗ manifest.version (${m.version}) 与目标 version (${version}) 不一致`);
  process.exit(1);
}
const platformDir = {
  "darwin-aarch64": "macos-arm64",
  "darwin-x86_64":  "macos-x86_64",
  "windows-x86_64": "windows-x86_64",
};
let ok = true;
for (const [key, info] of Object.entries(m.platforms ?? {})) {
  const dir = platformDir[key];
  if (!dir) { console.error(`✗ 未知平台 key: ${key}`); ok = false; continue; }
  const want = `${baseUrl}/${version}/${dir}/`;
  if (!info.url.startsWith(want)) {
    console.error(`✗ ${key} url 前缀错误\n   实际: ${info.url}\n   期望: ${want}<file>`);
    ok = false; continue;
  }
  const fname    = basename(info.url);
  const localBin = resolve(bundlesRoot, dir, fname);
  const localSig = resolve(bundlesRoot, dir, `${fname}.sig`);
  if (!existsSync(localBin)) { console.error(`✗ 缺少构建物: ${localBin}`); ok = false; continue; }
  if (!existsSync(localSig)) { console.error(`✗ 缺少签名:   ${localSig}`); ok = false; continue; }
  if (readFileSync(localSig, "utf8").trim() !== info.signature) {
    console.error(`✗ ${key} signature 与本地 ${fname}.sig 不一致`);
    ok = false; continue;
  }
  console.log(`✓ ${key.padEnd(16)} ${dir}/${fname}`);
}
if (!ok) { console.error("\n校验失败，已中止上传。"); process.exit(1); }
NODE

echo
echo "[release-upload] 校验通过，开始上传"
echo

# ossutil 1.7 cp 选项：-r 递归 / -f 静默覆盖 / -u 增量（src 较新或 size 不同才传）
OSS_OPTS=(-r -f -u --jobs 3 --parallel 5)

run() {
  echo "+ $*"
  [[ $DRY_RUN -eq 1 ]] || "$@"
}

# 1) 先把 bundles/ 整体推到版本目录（注意源路径末尾的 /，把目录"内容"上传到 <version>/ 下）
run ossutil cp "${OSS_OPTS[@]}" \
  "${BUNDLES}/" \
  "oss://${BUCKET}/${PREFIX}/${VERSION}/"

# 2) 同步一份 latest.json 到版本目录，便于回溯
run ossutil cp -f \
  "${MANIFEST}" \
  "oss://${BUCKET}/${PREFIX}/${VERSION}/latest.json"

# 3) 最后才覆盖根路径的 latest.json —— updater 一旦读到就会下载产物，必须放最后
run ossutil cp -f \
  "${MANIFEST}" \
  "oss://${BUCKET}/${PREFIX}/latest.json"

echo
if [[ $DRY_RUN -eq 1 ]]; then
  echo "[release-upload] DRY-RUN 完成，未实际上传"
else
  echo "[release-upload] 完成"
  echo "manifest: ${EXPECTED_BASE_URL}/latest.json"
fi
