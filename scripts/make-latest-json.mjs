#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// usage: node scripts/make-latest-json.mjs <staging-root> <bundle-base-url>
//   staging-root expects:
//     <staging-root>/bundles/macos-arm64/   *.app.tar.gz(.sig) [+ *.dmg]
//     <staging-root>/bundles/macos-x86_64/  *.app.tar.gz(.sig) [+ *.dmg]
//     <staging-root>/bundles/windows-x86_64/*-setup.exe(.sig)
//   bundle-base-url e.g. https://<bucket>.oss-cn-<region>.aliyuncs.com/releases
//   final url       =  <base>/<version>/<platform-dir>/<bundle-file>
// note: Tauri 2 default mode signs *-setup.exe directly (no .nsis.zip wrapper).
const [stagingRoot, baseUrl] = process.argv.slice(2);
if (!stagingRoot || !baseUrl) {
  console.error("usage: make-latest-json.mjs <staging-root> <bundle-base-url>");
  process.exit(1);
}

const repoRoot = resolve(import.meta.dirname, "..");
const version = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
).version;

const platforms = {
  "darwin-aarch64": { dir: "macos-arm64", match: (f) => f.endsWith(".app.tar.gz") },
  "darwin-x86_64": { dir: "macos-x86_64", match: (f) => f.endsWith(".app.tar.gz") },
  "windows-x86_64": {
    dir: "windows-x86_64",
    // setup.exe 而非 .nsis.zip（Tauri 2 默认模式直接签 .exe）
    match: (f) => f.endsWith("-setup.exe"),
  },
};

const bundlesRoot = resolve(stagingRoot, "bundles");
const out = {
  version,
  notes: `Release ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {},
};

for (const [key, { dir, match }] of Object.entries(platforms)) {
  const p = resolve(bundlesRoot, dir);
  let files;
  try {
    files = readdirSync(p);
  } catch {
    console.error(`missing platform dir: ${p}`);
    process.exit(1);
  }
  const bundle = files.find(match);
  const sig = bundle && files.find((f) => f === `${bundle}.sig`);
  if (!bundle || !sig) {
    console.error(`missing bundle or .sig in ${p} (saw: ${files.join(", ")})`);
    process.exit(1);
  }
  out.platforms[key] = {
    signature: readFileSync(join(p, sig), "utf8").trim(),
    url: `${baseUrl.replace(/\/$/, "")}/${version}/${dir}/${bundle}`,
  };
}

const target = resolve(stagingRoot, "latest.json");
writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${target}`);
