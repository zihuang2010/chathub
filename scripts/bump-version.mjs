#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

console.log(`bumped to ${next} in package.json / backends/tauri.conf.json / backends/Cargo.toml`);
console.log("next: pnpm install && cargo check --manifest-path backends/Cargo.toml");
