#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const next = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next ?? "")) {
  console.error("usage: bump-version.mjs <semver>");
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");

const pkgPath = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const tauriPath = resolve(root, "backends/tauri.conf.json");
const tauri = JSON.parse(readFileSync(tauriPath, "utf8"));
tauri.version = next;
writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + "\n");

const cargoPath = resolve(root, "backends/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8").replace(
  /^version = "[^"]+"/m,
  `version = "${next}"`,
);
writeFileSync(cargoPath, cargo);

// 同步 Cargo.lock —— workspace 根在仓库根,把 lock 中本地包 chathub 钉到新版本。
// 必须自动执行:历史上漏掉这一步导致 Windows relay `cargo build --locked` 反复失败。
try {
  execFileSync("cargo", ["update", "-p", "chathub", "--precise", next], {
    cwd: root,
    stdio: "inherit",
  });
} catch {
  console.error(
    `::error:: 已改三处版本号,但同步 Cargo.lock 失败。请手动运行:cargo update -p chathub --precise ${next}`,
  );
  process.exit(1);
}

console.log(
  `bumped to ${next} in package.json / backends/tauri.conf.json / backends/Cargo.toml / Cargo.lock`,
);
