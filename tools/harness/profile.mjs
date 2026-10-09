// 実機に近い規模の回路を組んで、1 tick あたり何回ネイティブ呼び出しが起きるか数える。
// Bedrock のスクリプトで効くのは JS↔ネイティブの往復なので、そこを指標にする。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// **test.mjs と同じく BP/scripts をコピーしてから測ること。**
// ここを忘れると「前回 test.mjs が置いていった古いコピー」を測ってしまい、
// 変更しても数字が動かない（実際に一度これで測り間違えた）。
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

const {
  world, system, advanceTicks, resetWorld, Block, Dimension, BlockPermutation,
} = await import("@minecraft/server");

const counts = {};
const bump = (k) => { counts[k] = (counts[k] ?? 0) + 1; };

const bp = Block.prototype;
for (const name of ["offset", "setPermutation", "setType", "getRedstonePower", "getComponent"]) {
  const real = bp[name];
  if (!real) continue;
  bp[name] = function (...a) { bump("Block." + name); return real.apply(this, a); };
}
const dp = Dimension.prototype;
for (const name of ["getBlock", "getEntities"]) {
  const real = dp[name];
  if (!real) continue;
  dp[name] = function (...a) { bump("Dimension." + name); return real.apply(this, a); };
}
// permutation.getState も本物ではネイティブ往復
const pp = BlockPermutation.prototype;
for (const name of ["getState", "withState"]) {
  const real = pp[name];
  pp[name] = function (...a) { bump("Permutation." + name); return real.apply(this, a); };
}
// block.permutation / block.typeId 自体も本物ではネイティブ呼び出し
for (const name of ["permutation", "typeId"]) {
  const d = Object.getOwnPropertyDescriptor(bp, name);
  const realGet = d.get;
  Object.defineProperty(bp, name, {
    ...d,
    get() { bump("Block." + name); return realGet.call(this); },
  });
}

resetWorld();
const dim = world.getDimension("minecraft:overworld");

await import("./scripts/main.js");
system.beforeEvents.startup.emit({
  blockComponentRegistry: {
    registerCustomComponent: (id, comp) => { (globalThis.__bc ??= new Map()).set(id, comp); },
  },
  itemComponentRegistry: { registerCustomComponent: () => {} },
});
const bc = globalThis.__bc;

// ---- 実機に近い構成 ----
// ワイヤーは **必ず支えの上に置く**。宙に浮かせると「支えが無い→壊れる」判定が
// 毎 tick 走って、測りたいものとは別の負荷が乗る（最初これで測り間違えた）。
const WIRES = 300, GATES = 20, LAMPS = 30;
const placed = [];
for (let i = 0; i < WIRES; i += 1) {
  const x = i % 50, z = Math.floor(i / 50);
  dim.place({ x, y: 3, z }, "minecraft:stone"); // 支え
  const loc = { x, y: 4, z };
  dim.place(loc, "wr:wire", {
    "minecraft:block_face": "up",
    "wr:power": 0, "wr:color": 0,
    "wr:c0": false, "wr:c1": false, "wr:c2": false, "wr:c3": false, "wr:glow": false,
  });
  placed.push(["wr:wire", loc]);
}
for (let i = 0; i < GATES; i += 1) {
  const loc = { x: i, y: 6, z: 0 };
  dim.place({ x: i, y: 5, z: 0 }, "minecraft:stone");
  dim.place(loc, "wr:and_gate", { "minecraft:cardinal_direction": "north", "wr:power": 0 });
  placed.push(["wr:and_gate", loc]);
}
for (let i = 0; i < LAMPS; i += 1) {
  const loc = { x: i, y: 8, z: 0 };
  dim.place(loc, "wr:lamp", { "wr:light": 0, "wr:color": 0 });
  placed.push(["wr:lamp", loc]);
}

// 落ち着かせてから計測開始
for (let t = 0; t < 12; t += 1) {
  for (const [id, loc] of placed) bc.get(id)?.onTick?.({ block: dim.getBlock(loc) });
  advanceTicks(1);
}
for (const k of Object.keys(counts)) delete counts[k];
let runCalls = 0;
const realRun = system.run.bind(system);
system.run = (fn) => { runCalls += 1; return realRun(fn); };

const TICKS = 80;
for (let t = 0; t < TICKS; t += 1) {
  if (t % 4 === 0) {
    for (const [id, loc] of placed) {
      const comp = bc.get(id);
      if (comp?.onTick) comp.onTick({ block: dim.getBlock(loc) });
    }
  }
  advanceTicks(1);
}

console.log(`構成: ワイヤー${WIRES} / 論理回路${GATES} / ランプ${LAMPS}  (${TICKS} tick、すべて静止状態)`);
console.log("");
const total = Object.values(counts).reduce((a, b) => a + b, 0);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${String(v).padStart(8)}   1tickあたり ${(v / TICKS).toFixed(1)}`);
}
console.log(`  ${"system.run".padEnd(24)} ${String(runCalls).padStart(8)}   1tickあたり ${(runCalls / TICKS).toFixed(1)}`);
console.log("");
const perTick = total / TICKS;
const perBlockPoll = total / (TICKS / 4) / placed.length;
console.log(`ネイティブ往復 合計 = ${total}  (1tickあたり ${perTick.toFixed(0)})`);
console.log(`ブロック1個あたり 1 ポーリング = ${perBlockPoll.toFixed(1)} 回`);

// ---------------------------------------------------------------------------
// 予算チェック（性能の後戻り検出）
// ---------------------------------------------------------------------------
//
// **この数字は「速さ」ではなく「無駄の量」を測っている。**
// 静止した回路なのだから、本来やることはほとんど無い。
// ここが増えたということは、たいてい
//   ・同じ隣を取り直す 6 面走査を足した
//   ・キャッシュの効かない経路（block.typeId 直読みなど）を足した
//   ・毎ポーリング走る処理を足した
// のどれかで、実機では他アドオンのモブ処理を圧迫する形で出る。
//
// **上限に引っかかったら、まず「本当に必要な処理か」を疑うこと。**
// 必要だと判断したうえで上げるぶんには構わないが、
// **理由をコミットメッセージに残すこと**。黙って上げると歯止めが無くなる。
//
// 実測の推移:
//   v1.27.1  11,717 /tick   133.9 /ブロック/ポーリング
//   v1.28.0   4,723 /tick    54.0 /ブロック/ポーリング  ← 再計算スコープのキャッシュ導入

const BUDGET = {
  perTick: 5200, //  現在 4,723。1 割ほど余裕を持たせてある
  perBlockPoll: 60, // 現在 54.0
  systemRunPerTick: 100, // 現在 87.5。案B（一括化）をやれば 1 桁になる
};

const over = [];
if (perTick > BUDGET.perTick) {
  over.push(`1tickあたり ${perTick.toFixed(0)} 回 > 上限 ${BUDGET.perTick}`);
}
if (perBlockPoll > BUDGET.perBlockPoll) {
  over.push(`ブロック1個あたり ${perBlockPoll.toFixed(1)} 回 > 上限 ${BUDGET.perBlockPoll}`);
}
if (runCalls / TICKS > BUDGET.systemRunPerTick) {
  over.push(`system.run が 1tickあたり ${(runCalls / TICKS).toFixed(1)} 回 > 上限 ${BUDGET.systemRunPerTick}`);
}

console.log("");
if (over.length === 0) {
  console.log("予算内。OK");
} else {
  console.error("性能が後戻りしている:");
  for (const line of over) console.error("  x " + line);
  console.error("");
  console.error("  毎ポーリング走る処理や 6 面走査を足していないか確認すること。");
  console.error("  意図した増加なら profile.mjs の BUDGET を理由つきで上げる。");
  process.exit(1);
}
