// **動いている回路**のコストを測る。
//
// profile.mjs は静止した回路（＝何も変化していない）を測っている。
// だが実際にラグを感じるのは、パルス生成機やシーケンサーで
// **信号が動き続けている**ときのはず。そちらを測らないと的外れな最適化になる。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SRC = path.join(HERE, "..", "..", "RedstoneExtBP", "scripts");
  const DST = path.join(HERE, "scripts");
  fs.mkdirSync(DST, { recursive: true });
  for (const file of fs.readdirSync(SRC)) {
    if (!file.endsWith(".js") || file.startsWith("generate_")) continue;
    fs.copyFileSync(path.join(SRC, file), path.join(DST, file));
  }
}

const { world, system, advanceTicks, resetWorld, Block, Dimension, BlockPermutation } =
  await import("@minecraft/server");

const counts = {};
const bump = (k) => { counts[k] = (counts[k] ?? 0) + 1; };
const bp = Block.prototype;
for (const name of ["offset", "setPermutation", "setType", "getRedstonePower", "getComponent"]) {
  const real = bp[name];
  if (!real) continue;
  bp[name] = function (...a) { bump("Block." + name); return real.apply(this, a); };
}
for (const name of ["permutation", "typeId"]) {
  const d = Object.getOwnPropertyDescriptor(bp, name);
  const realGet = d.get;
  Object.defineProperty(bp, name, { ...d, get() { bump("Block." + name); return realGet.call(this); } });
}
const dp = Dimension.prototype;
for (const name of ["getBlock"]) {
  const real = dp[name];
  dp[name] = function (...a) { bump("Dimension." + name); return real.apply(this, a); };
}
const pp = BlockPermutation.prototype;
for (const name of ["getState", "withState"]) {
  const real = pp[name];
  pp[name] = function (...a) { bump("Permutation." + name); return real.apply(this, a); };
}

resetWorld();
const dim = world.getDimension("minecraft:overworld");
await import("./scripts/main.js");
system.beforeEvents.startup.emit({
  blockComponentRegistry: {
    registerCustomComponent: (id, c) => { (globalThis.__bc ??= new Map()).set(id, c); },
  },
  itemComponentRegistry: { registerCustomComponent: () => {} },
});
const bc = globalThis.__bc;

// ---- 構成: パルス生成機 → 30 マスのワイヤー、を 4 系統 --------------------
// 「点滅する照明」「クロック回路」みたいな、実際に置かれがちな形。
const RUNS = 4;
const LEN = 30;
const ticked = [];

// **電源は自分でトグルする。**
// 最初はパルス生成機を置いて済ませようとしたが、プロファイラでは
// registerTimingLoops() を起動していないので実際には点滅せず、
// 「動いている回路」のつもりで静止した回路を測っていた（setPermutation が 0 回で気づいた）。
// バニラの電源をこちらで切り替えるほうが、確実で再現もしやすい。
const sources = [];
for (let r = 0; r < RUNS; r += 1) {
  const z = r * 3;
  for (let i = -1; i < LEN; i += 1) dim.place({ x: i, y: 3, z }, "minecraft:stone");
  sources.push({ x: -1, y: 4, z });
  for (let i = 0; i < LEN; i += 1) {
    const loc = { x: i, y: 4, z };
    dim.place(loc, "wr:wire", {
      "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0,
      "wr:c0": false, "wr:c1": false, "wr:c2": false, "wr:c3": false, "wr:glow": false,
    });
    ticked.push(["wr:wire", loc]);
  }
}
const setSources = (on) => {
  for (const loc of sources) {
    dim.place(loc, on ? "minecraft:redstone_block" : "minecraft:air", {}, on ? 15 : 0);
  }
};
setSources(false);

// 落ち着かせる
for (let t = 0; t < 12; t += 1) {
  for (const [id, loc] of ticked) bc.get(id)?.onTick?.({ block: dim.getBlock(loc) });
  advanceTicks(1);
}
for (const k of Object.keys(counts)) delete counts[k];
let runCalls = 0;
const realRun = system.run.bind(system);
system.run = (fn) => { runCalls += 1; return realRun(fn); };

const TICKS = 80;
for (let t = 0; t < TICKS; t += 1) {
  // 8 tick ごとに電源を入れ切りする（点滅する照明・クロック回路の想定）
  if (t % 8 === 0) setSources((t / 8) % 2 === 0);
  if (t % 4 === 0) {
    for (const [id, loc] of ticked) bc.get(id)?.onTick?.({ block: dim.getBlock(loc) });
  }
  advanceTicks(1);
}

console.log(`構成: パルス生成機→${LEN}マスのワイヤー × ${RUNS} 系統 = ${ticked.length} ブロック`);
console.log(`      (${TICKS} tick、**信号が動き続けている状態**)`);
console.log("");
const total = Object.values(counts).reduce((a, b) => a + b, 0);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${String(v).padStart(9)}   1tickあたり ${(v / TICKS).toFixed(1)}`);
}
console.log(`  ${"system.run".padEnd(24)} ${String(runCalls).padStart(9)}   1tickあたり ${(runCalls / TICKS).toFixed(1)}`);
console.log("");
console.log(`ネイティブ往復 合計 = ${total}  (1tickあたり ${(total / TICKS).toFixed(0)})`);
console.log(`ブロック1個あたり 1 tick = ${(total / TICKS / ticked.length).toFixed(1)} 回`);
