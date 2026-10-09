/**
 * パックのバージョンを一括で書き換える。
 *
 *   node tools/set_version.js 1.2.0
 *
 * 書き換える場所:
 *   RedstoneExtBP/manifest.json  header.version / 全 modules[].version /
 *                                RP への dependencies[].version
 *   RedstoneExtRP/manifest.json  header.version / 全 modules[].version
 *   両パックの texts/*.lang      pack.name の "vX.Y.Z"
 *   README.md                    先頭見出しの "vX.Y.Z"
 *
 * BP は RP の header.version を**固定値で参照**しているので、
 * 片方だけ上げると依存が解決できなくなる。必ずこのスクリプトで揃えること。
 *
 * バージョンを上げる理由:
 *   同じバージョンの .mcaddon を再インポートすると、Minecraft 側で
 *   古いパックが残ったり別フォルダに増えたりして、
 *   「直したはずなのに直っていない」という事故になる。
 *   配布物を作り直すたびに必ず上げる。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PACKS = ["RedstoneExtBP", "RedstoneExtRP"];

const arg = process.argv[2];
if (!arg || !/^\d+\.\d+\.\d+$/.test(arg)) {
  console.error("usage: node tools/set_version.js <major.minor.patch>   例: 1.2.0");
  process.exit(1);
}
const version = arg.split(".").map(Number);
const versionText = arg;

const touched = [];

function rewriteJson(file, fn) {
  const full = path.join(ROOT, file);
  const json = JSON.parse(fs.readFileSync(full, "utf8"));
  fn(json);
  fs.writeFileSync(full, JSON.stringify(json, null, 2) + "\n", "utf8");
  touched.push(file);
}

for (const pack of PACKS) {
  rewriteJson(path.join(pack, "manifest.json"), (m) => {
    m.header.version = version;
    for (const mod of m.modules ?? []) mod.version = version;
    // uuid を持つ依存 = 同梱パック同士の参照。module_name の方（API）は触らない。
    for (const dep of m.dependencies ?? []) {
      if (dep.uuid) dep.version = version;
    }
  });
}

// lang の pack.name に書いてあるバージョン表記
for (const pack of PACKS) {
  const dir = path.join(ROOT, pack, "texts");
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".lang")) continue;
    const full = path.join(dir, file);
    const before = fs.readFileSync(full, "utf8");
    const after = before.replace(/^(pack\.name=.*?)v\d+\.\d+\.\d+/m, `$1v${versionText}`);
    if (after !== before) {
      fs.writeFileSync(full, after, "utf8");
      touched.push(path.join(pack, "texts", file));
    }
  }
}

// scripts/dev.js の SCRIPT_VERSION（/scriptevent wr:version が返す値）。
//
// **ここがズレると診断コマンドが嘘をつく**ので、一致しなければ例外にする。
// パックの表示名と違って、これは「実際に動いているスクリプト」の版を示すためのもの。
{
  const full = path.join(ROOT, "RedstoneExtBP", "scripts", "dev.js");
  const before = fs.readFileSync(full, "utf8");
  const after = before.replace(
    /const SCRIPT_VERSION = "\d+\.\d+\.\d+";/,
    `const SCRIPT_VERSION = "${versionText}";`
  );
  if (after === before && !before.includes(`const SCRIPT_VERSION = "${versionText}";`)) {
    throw new Error("scripts/dev.js の SCRIPT_VERSION が見つからない");
  }
  if (after !== before) {
    fs.writeFileSync(full, after, "utf8");
    touched.push("RedstoneExtBP/scripts/dev.js");
  }
}

// README の先頭見出しだけ（本文中の「v1.1.0 で追加した」等の履歴は残す）
//
// README は BOM 付きで保存されているので、`^` を素直に使うと BOM に阻まれて
// **黙って一致しない**。実際に v1.26.0 でこれを踏み、README だけ古い版のまま
// 2 リリース進んでしまった。BOM を外してから当て、書き戻すときに戻す。
// 一致しなかったら例外にする（黙って通ると同じ事故を繰り返すため）。
{
  const full = path.join(ROOT, "README.md");
  const raw = fs.readFileSync(full, "utf8");
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const before = raw.slice(bom.length);
  const after = before.replace(/^(# .*?)v\d+\.\d+\.\d+/, `$1v${versionText}`);
  if (after === before && !before.startsWith(`# レッドストーン拡張アドオン v${versionText}`)) {
    throw new Error("README.md の先頭見出しにバージョンが見つからない");
  }
  if (after !== before) {
    fs.writeFileSync(full, bom + after, "utf8");
    touched.push("README.md");
  }
}

console.log(`version -> ${versionText}`);
for (const f of touched) console.log("  " + f);
