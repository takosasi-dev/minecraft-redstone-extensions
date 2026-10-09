/**
 * スモークテスト。
 *
 *   cd tools/harness && node test.mjs
 *
 * BP/scripts/ の実装をそのままコピーして、スタブ版 @minecraft/server の上で動かす。
 * ゲーム内の挙動を保証するものではないが、
 *   - 例外を投げずに読み込める / 起動できる
 *   - 電力の減衰・論理演算・遅延・チャンネル集約が仕様どおりの数値になる
 *   - 循環配線でも無限再帰せず、tick を回し続けられる
 * ところまでは自動で確認できる。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  world,
  system,
  ItemStack,
  advanceTicks,
  addPlayer,
} from "@minecraft/server";
import { shownForms, queueResponse, resetForms } from "@minecraft/server-ui";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..", "RedstoneExtBP", "scripts");
const DST = path.join(HERE, "scripts");

// ---- 実装のコピー（generate_* はビルド専用の CommonJS なので除外） ----------

fs.mkdirSync(DST, { recursive: true });
for (const file of fs.readdirSync(SRC)) {
  if (!file.endsWith(".js") || file.startsWith("generate_")) continue;
  fs.copyFileSync(path.join(SRC, file), path.join(DST, file));
}

// ---- テストユーティリティ ---------------------------------------------------

let failures = 0;
let checks = 0;

// propagation_helper の scheduleUpdate は再計算の例外を console.warn に握り潰す
// （1 ブロックの不具合でワールド全体を巻き込まないための作り）。
// おかげで **import 漏れやタイプミスがそのブロックを黙って無効化する**。
// v1.27.0 で refiner.js の maxIncomingPower 取り込み忘れがこれで隠れかけた。
// テストでは握り潰させない。
// （`[wr]` は診断コマンドの出力にも使うので、失敗を示すものだけ拾う）
const swallowed = [];
const realWarn = console.warn;
console.warn = (...args) => {
  const text = args.join(" ");
  if (text.includes("[wr]") && /failed/i.test(text)) swallowed.push(text);
  realWarn(...args);
};

function check(label, actual, expected) {
  checks += 1;
  const ok = Object.is(actual, expected);
  if (!ok) {
    failures += 1;
    console.error(`  x ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`  o ${label} = ${JSON.stringify(actual)}`);
  }
}

function section(name) {
  console.log(`\n# ${name}`);
}

const DIM = "minecraft:overworld";
const dim = world.getDimension(DIM);

/**
 * tick を進めたうえで、Promise（フォームの .then）が消化されるまで待つ。
 * advanceTicks は同期実行なので、これを挟まないとフォームの応答処理が走らない。
 */
async function settle(ticks = 1) {
  for (let i = 0; i < ticks; i += 1) {
    advanceTicks(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const at = (x, y, z) => ({ x, y, z });
const stateOf = (loc, name) => dim.getBlock(loc).permutation.getState(name);

/**
 * コンテナのテスト用ダミー。
 *
 * **本物の `getItem()` は複製を返す。** 返ってきた ItemStack をいじっても、
 * `setItem()` で書き戻さない限りコンテナには反映されない。
 * ここで素の参照を返していると「amount を減らしたが setItem を忘れた」が
 * **テスト緑のまま実機だけで壊れる**ので、本物に合わせて複製を返す。
 *
 * @param slots   実際の中身（テスト側はこの配列を直接見て検証する）
 * @param addItem 空きに入れる関数。省略すると addItem を持たないコンテナになる
 */
function makeContainer(slots, { size = 27, addItem } = {}) {
  const copy = (it) =>
    it ? Object.assign(Object.create(Object.getPrototypeOf(it)), it) : undefined;
  const container = {
    size,
    getItem: (i) => copy(slots[i]),
    setItem: (i, v) => {
      slots[i] = v;
    },
  };
  if (addItem) container.addItem = (item) => addItem(item, slots);
  return container;
}

function fakePlayer(id, heldName, heldTypeId = "wr:transmitter") {
  let held = new ItemStack(heldTypeId);
  held.nameTag = heldName;
  /** インベントリの中身（チャンネル名変更のテストで使う）。 */
  const slots = [];
  const container = {
    size: 9,
    getItem: (i) => slots[i],
    setItem: (i, item) => {
      slots[i] = item;
    },
    /**
     * カードキーの発行で使う。空きが無ければ余りを返す（本物と同じ約束）。
     * テストから `container.full = true` にすると満杯を再現できる。
     */
    addItem: (item) => {
      if (container.full) return item;
      slots.push(item);
      return undefined;
    },
  };
  /** プレイヤー動的プロパティ（解錠の記憶に使う）。 */
  const props = new Map();
  const player = {
    inventory: container,
    id,
    isSneaking: false,
    getDynamicProperty: (key) => props.get(key),
    setDynamicProperty: (key, value) => {
      if (value === undefined) props.delete(key);
      else props.set(key, value);
    },
    /** 直近に出したアクションバーの中身（テストからの覗き見用）。 */
    lastActionBar: undefined,
    /** 視線の先として返すブロック。 */
    viewTarget: undefined,
    onScreenDisplay: {
      setActionBar(msg) {
        player.lastActionBar = msg;
      },
    },
    playSound() {},
    sendMessage() {},
    getGameMode: () => "Creative",
    location: { x: 0, y: 0, z: 0 },
    dimension: dim,
    getComponent: (name) =>
      name === "minecraft:inventory"
        ? { container }
        : {
            getEquipment: () => held,
            setEquipment: (_slot, item) => {
              held = item;
            },
          },
    setHeld: (item) => {
      held = item;
    },
    getHeld: () => held,
    getBlockFromViewDirection: () => (player.viewTarget ? { block: player.viewTarget } : undefined),
  };
  return player;
}

// ---- 起動 -------------------------------------------------------------------

await import("./scripts/main.js");

// 直接呼んで確かめたいものだけ、同じモジュールインスタンスを取り出しておく
const { renameChannel, listChannels } = await import("./scripts/channels.js");
const { categoryOf, deleteCategory, listCategories, setChannelCategory } =
  await import("./scripts/directory.js");
const timingMod = await import("./scripts/timing.js");
const logicMod = await import("./scripts/logic.js");

/** ブロック定義（生成物）が宣言しているステート名。 */
function blockDefStates(name) {
  const full = path.join(HERE, "..", "..", "RedstoneExtBP", "blocks", `${name}.json`);
  return JSON.parse(fs.readFileSync(full, "utf8").replace(/^﻿/, ""))
    ["minecraft:block"].description.states ?? {};
}

// 設定をワールド動的プロパティに持つブロックを、テストから直に仕込むための道具。
// **キーと詰め方は実装との取り決めそのもの**なので、形式を変えたらここも落ちる
// ＝保存形式の契約として置いてある。
function setDpSetting(prefix, loc, value) {
  world.setDynamicProperty(`${prefix}${DIM}|${loc.x}|${loc.y}|${loc.z}`, value);
}
/** 非対称リピーターの遅延 2 本（rise * 1024 + fall。1024 は実装の ASYM_PACK と合わせる）。 */
const setAsymDp = (loc, rise, fall) =>
  setDpSetting("wr:asym|", loc, rise === 0 && fall === 0 ? undefined : rise * 1024 + fall);
/** パルス生成機の周期（tick）。既定の 5 は持たない。 */
const setPulseDp = (loc, period) =>
  setDpSetting("wr:pulse|", loc, period === 5 ? undefined : period);
/** ワンショットの長さ（tick）。既定の 20 は持たない。 */
const setOneShotLengthDp = (loc, ticks) =>
  setDpSetting("wr:oslen|", loc, ticks === 20 ? undefined : ticks);
/** ワンショットの残り（tick）。0 以下は持たない。 */
const setOneShotRemainDp = (loc, ticks) =>
  setDpSetting("wr:osremain|", loc, ticks > 0 ? ticks : undefined);
/** 閾値ブロックの rise/fall（rise * 16 + fall）。どちらも既定の 1 なら持たない。 */
const setThresholdDp = (loc, rise, fall) =>
  setDpSetting("wr:th|", loc, rise === 1 && fall === 1 ? undefined : rise * 16 + fall);
/** クロックディバイダーの divisor。既定の 4 は持たない。 */
const setClockDivDp = (loc, divisor) => setDpSetting("wr:cdiv|", loc, divisor === 4 ? undefined : divisor);
/** クロックディバイダーのカウンター。0 は持たない。 */
const setClockCntDp = (loc, count) => setDpSetting("wr:cdcnt|", loc, count > 0 ? count : undefined);

const blockComponents = new Map();
const itemComponents = new Map();
system.beforeEvents.startup.emit({
  blockComponentRegistry: {
    registerCustomComponent: (name, comp) => blockComponents.set(name, comp),
  },
  itemComponentRegistry: {
    registerCustomComponent: (name, comp) => itemComponents.set(name, comp),
  },
});
advanceTicks(1); // main.js の system.run(bootOnce) を消化

section("登録");
// 装飾建材 5 種はスクリプトを持たないので、ここには出てこない。
check("ブロックコンポーネント数", blockComponents.size, 48);
check("アイテムコンポーネント数", itemComponents.size, 5);

/** そのブロックの onTick を叩いて、共通伝播ロジックを 1 巡させる。 */
function pump(locs, ticks = 4) {
  for (let i = 0; i < ticks; i += 1) {
    for (const loc of locs) {
      const block = dim.getBlock(loc);
      const comp = blockComponents.get(block.typeId);
      comp?.onTick?.({ block });
    }
    advanceTicks(1);
  }
}

// ---- B-1 ワイヤーの減衰 ------------------------------------------------------

section("B-1 ワイヤー: 受電値 -1 で減衰する");
dim.place(at(0, 0, 0), "minecraft:redstone_block", {}, 15);
for (const x of [1, 2, 3]) {
  dim.place(at(x, -1, 0), "minecraft:stone");
  dim.place(at(x, 0, 0), "wr:wire", { "minecraft:block_face": "up", "wr:power": 0 });
}
const wireLocs = [at(1, 0, 0), at(2, 0, 0), at(3, 0, 0)];
pump(wireLocs, 8);
check("1 本目", stateOf(at(1, 0, 0), "wr:power"), 14);
check("2 本目", stateOf(at(2, 0, 0), "wr:power"), 13);
check("3 本目", stateOf(at(3, 0, 0), "wr:power"), 12);

section("伝播: 先頭だけ tick すれば連鎖で最後まで届く");
// redstone_consumer が使えないので onRedstoneUpdate は来ない。
// 「値が変わったら隣を再計算予約する」連鎖だけで端まで伝わることを確かめる。
// ここでは pump() を使わず、先頭の 1 本しか onTick を叩かない。
for (const x of [11, 12, 13, 14, 15]) {
  dim.place(at(x, 0, 0), "minecraft:stone");
  dim.place(at(x, 1, 0), "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
}
dim.place(at(10, 1, 0), "minecraft:redstone_block", {}, 15);
blockComponents.get("wr:wire").onTick({ block: dim.getBlock(at(11, 1, 0)) });
advanceTicks(12);
check("1 本目", stateOf(at(11, 1, 0), "wr:power"), 14);
check("2 本目（連鎖）", stateOf(at(12, 1, 0), "wr:power"), 13);
check("3 本目（連鎖）", stateOf(at(13, 1, 0), "wr:power"), 12);
check("5 本目（連鎖）", stateOf(at(15, 1, 0), "wr:power"), 10);
// 電源を切ると 0 まで戻る（連鎖が下り方向にも効く）
dim.place(at(10, 1, 0), "minecraft:air");
blockComponents.get("wr:wire").onTick({ block: dim.getBlock(at(11, 1, 0)) });
advanceTicks(20);
check("電源を切ると端まで 0 に戻る", stateOf(at(15, 1, 0), "wr:power"), 0);

section("消灯の速さ: 長い配線でも数 tick で全部消える");
// 以前は隣の古い値を読んで 1 段ずつ落ちていたため、15 マスだと十数 tick かかった。
// 今は値が動くときに網ごと計算し直すので、長さに関係なくすぐ消える。
const longRun = [];
for (let x = 30; x < 45; x += 1) {
  const loc = at(x, 1, 0);
  dim.place(at(x, 0, 0), "minecraft:stone");
  dim.place(loc, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
  longRun.push(loc);
}
dim.place(at(29, 1, 0), "minecraft:redstone_block", {}, 15);
blockComponents.get("wr:wire").onTick({ block: dim.getBlock(longRun[0]) });
advanceTicks(4);
check("15 マスが点灯（末端は 0 まで減衰）", stateOf(longRun[0], "wr:power"), 14);
check("14 マス目", stateOf(longRun[13], "wr:power"), 1);

dim.place(at(29, 1, 0), "minecraft:air"); // 電源を撤去
blockComponents.get("wr:wire").onTick({ block: dim.getBlock(longRun[0]) });
advanceTicks(3); // 1 tick 遅延 + 反映
const stillLit = longRun.filter((loc) => stateOf(loc, "wr:power") > 0).length;
check("3 tick で 15 マス全部消える", stillLit, 0);

section("オフ時に発振しない（反射が 1 tick 遅れて返ってくる場合）");
// バニラのブロックが返す電力は 1 tick ほど遅れて追従する。
// 「今の出力」だけで反射を判定すると、0 に落とした直後に古い値が通ってしまい
// 0 → 13 → 0 → 12 … とクロック回路のようにガタつく。
// 直前に出していた値もおぼえているので、そうならないことを確かめる。
const oscLoc = at(50, 1, 0);
const oscSupport = dim.place(at(50, 0, 0), "minecraft:dirt");
dim.place(oscLoc, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
dim.place(at(49, 1, 0), "minecraft:redstone_block", {}, 15);
blockComponents.get("wr:wire").onTick({ block: dim.getBlock(oscLoc) });
advanceTicks(3);
check("点灯している", stateOf(oscLoc, "wr:power"), 14);

// 支持ブロックが 1 tick 遅れでワイヤーの出力を返すようにする
let lagged = stateOf(oscLoc, "wr:power");
const stepReflector = () => {
  const current = stateOf(oscLoc, "wr:power");
  oscSupport._redstonePower = lagged;
  lagged = current;
};
dim.place(at(49, 1, 0), "minecraft:air"); // 電源を撤去
const history = [];
for (let i = 0; i < 30; i += 1) {
  stepReflector();
  blockComponents.get("wr:wire").onTick({ block: dim.getBlock(oscLoc) });
  advanceTicks(1);
  history.push(stateOf(oscLoc, "wr:power"));
}
check("最終的に 0", history.at(-1), 0);
// いったん 0 になったあとに再点灯していないこと（＝発振していない）
const zeroAt = history.indexOf(0);
check("0 になってから再点灯しない", history.slice(zeroAt).every((v) => v === 0), true);
console.log(`  (推移: ${history.slice(0, 8).join(",")} ...)`);

section("送信機に繋がったワイヤーがオフになる");
// 実機の症状の再現: 天井のワイヤーが送信機に繋がっていると、
// 感圧板を離しても点きっぱなしになっていた。
// 送信機は redstone_consumer なので、ワイヤーが与えた電力を
// getRedstonePower() でそのまま返してくる。それを入力として読むと永久ラッチする。
const txLoc = at(70, 5, 0);
dim.place(txLoc, "wr:transmitter");
const ceilWire = [at(71, 5, 0), at(72, 5, 0), at(73, 5, 0)];
for (const loc of ceilWire) {
  dim.place(at(loc.x, loc.y + 1, loc.z), "minecraft:stone"); // 天井（支持は上）
  dim.place(loc, "wr:wire", { "minecraft:block_face": "down", "wr:power": 0, "wr:color": 0 });
}
// 感圧板が支持ブロックを帯電させている状態
const plate = dim.getBlock(at(71, 6, 0));
plate._redstonePower = 15;
blockComponents.get("wr:wire").onTick({ block: dim.getBlock(ceilWire[0]) });
advanceTicks(3);
check("感圧板を踏むと点く", stateOf(ceilWire[0], "wr:power"), 14);

// 送信機が「ワイヤーからもらった電力」を返す状態を再現する
const reflectingTx = dim.getBlock(txLoc);
plate._redstonePower = 0; // 感圧板から離れた
for (let i = 0; i < 20; i += 1) {
  reflectingTx._redstonePower = stateOf(ceilWire[0], "wr:power"); // 送信機は反射し続ける
  blockComponents.get("wr:wire").onTick({ block: dim.getBlock(ceilWire[0]) });
  advanceTicks(1);
}
check("離すと消える（送信機経由で latch しない）",
  ceilWire.map((l) => stateOf(l, "wr:power")).join(","), "0,0,0");

section("B-1 ワイヤー: 支持面が消えたらポップオフする");
dim.place(at(3, -1, 0), "minecraft:air");
pump([at(3, 0, 0)], 3);
check("ブロックが消えた", dim.getBlock(at(3, 0, 0)).typeId, "minecraft:air");
check("アイテムがドロップした", dim.spawnedItems.at(-1)?.itemStack.typeId, "wr:wire");

// ---- B-2 段差コーナー --------------------------------------------------------

section("B-2 段差コーナー: 減衰なしで素通しする");
// 直前のテストで 3 本目を落としたので、支持面ごと置き直す
dim.place(at(3, -1, 0), "minecraft:stone");
dim.place(at(3, 0, 0), "wr:wire", { "minecraft:block_face": "up", "wr:power": 0 });
dim.place(at(4, -1, 0), "minecraft:stone");
dim.place(at(4, 0, 0), "wr:corner_riser", { "wr:power": 0 });
dim.place(at(5, -1, 0), "minecraft:stone");
dim.place(at(5, 0, 0), "wr:wire", { "minecraft:block_face": "up", "wr:power": 0 });
pump([at(1, 0, 0), at(2, 0, 0), at(3, 0, 0), at(4, 0, 0), at(5, 0, 0)], 10);
check("3 本目のワイヤー", stateOf(at(3, 0, 0), "wr:power"), 12);
check("コーナーは 12 を減衰なしで受け取る", stateOf(at(4, 0, 0), "wr:power"), 12);
check("コーナーの先のワイヤー", stateOf(at(5, 0, 0), "wr:power"), 11);

// ---- D-1 NOT 回路 ------------------------------------------------------------

// ---- 段差コーナー: バニラ経由の自己反射でラッチしない ----------------------

section("B-2 段差コーナー: バニラのブロックからの読み返しでラッチしない");
// 実機で確認された症状の再現:
// コーナーが自分で出した電力を隣の土ブロックが getRedstonePower() でそのまま返す。
// 減衰ゼロのまま読むと電源を切っても永久に点いたままになる。
const riserLoc = at(80, 0, 0);
dim.place(at(80, -1, 0), "minecraft:dirt");
dim.place(riserLoc, "wr:corner_riser", { "wr:power": 0 });
dim.place(at(81, 0, 0), "minecraft:lever", {}, 15);
pump([riserLoc], 4);
check("レバーで点く（バニラ経由なので -1）", stateOf(riserLoc, "wr:power"), 14);

/** 「自分が出した電力をそのまま返す」土ブロックを毎 tick 再現する。 */
const reflector = dim.getBlock(at(80, -1, 0));
const reflect = () => {
  reflector._redstonePower = stateOf(riserLoc, "wr:power");
};
reflect();
dim.place(at(81, 0, 0), "minecraft:air"); // レバーを外す
for (let i = 0; i < 40; i += 1) {
  reflect();
  blockComponents.get("wr:corner_riser").onTick({ block: dim.getBlock(riserLoc) });
  advanceTicks(1);
}
check("電源を外すと 0 まで落ちる（ラッチしない）", stateOf(riserLoc, "wr:power"), 0);

// ---- ワイヤーの接続形状 -----------------------------------------------------

section("ワイヤーの接続形状");
const armsOf = (loc) => {
  const p = dim.getBlock(loc).permutation;
  return ["wr:c0", "wr:c1", "wr:c2", "wr:c3"].filter((k) => p.getState(k) === true).join(",");
};
const placeWire = (loc, color = 0) => {
  dim.place(at(loc.x, loc.y - 1, loc.z), "minecraft:stone");
  dim.place(loc, "wr:wire", {
    "minecraft:block_face": "up",
    "wr:power": 0,
    "wr:color": color,
  });
};

// 単独 → 腕なし（点）
placeWire(at(90, 0, 0));
pump([at(90, 0, 0)], 2);
check("単独設置は腕なし（点）", armsOf(at(90, 0, 0)), "");

// 床のワイヤーは c0=北 / c1=南 / c2=東 / c3=西
// 東に 1 本足す → 1 本接続なので直線（東西両方の腕）に見せる
placeWire(at(91, 0, 0));
pump([at(90, 0, 0), at(91, 0, 0)], 2);
check("1 本だけ繋がると直線になる", armsOf(at(90, 0, 0)), "wr:c2,wr:c3");

// さらに北に 1 本 → 東と北の L 字
placeWire(at(90, 0, -1));
pump([at(90, 0, 0), at(90, 0, -1)], 2);
check("2 方向なら L 字", armsOf(at(90, 0, 0)), "wr:c0,wr:c2");

// 色違いは繋がらない
placeWire(at(90, 0, 1), 12); // 青
pump([at(90, 0, 0), at(90, 0, 1)], 2);
check("色違いの隣とは繋がらない", armsOf(at(90, 0, 0)), "wr:c0,wr:c2");

// 同じ色に染め直すと繋がる
dim.getBlock(at(90, 0, 1)).setPermutation(
  dim.getBlock(at(90, 0, 1)).permutation.withState("wr:color", 0)
);
pump([at(90, 0, 0), at(90, 0, 1)], 2);
check("同じ色にすると繋がる", armsOf(at(90, 0, 0)), "wr:c0,wr:c1,wr:c2");

section("ワイヤーの接続形状: 壁に貼った場合");
// block_face = 'north'（相手の北面に接して設置）→ 支持は南側の壁。
// 面内は上下と東西なので、c0=上 / c1=下 / c2=東 / c3=西 になる。
const wallLoc = at(95, 1, 0);
dim.place(at(95, 1, 1), "minecraft:stone"); // 南側の支持ブロック
dim.place(wallLoc, "wr:wire", {
  "minecraft:block_face": "north",
  "wr:power": 0,
  "wr:color": 0,
});
pump([wallLoc], 2);
check("壁で単独なら腕なし", armsOf(wallLoc), "");

// 真上に同じ壁面のワイヤーを足す → 上下方向の直線
dim.place(at(95, 2, 1), "minecraft:stone");
dim.place(at(95, 2, 0), "wr:wire", {
  "minecraft:block_face": "north",
  "wr:power": 0,
  "wr:color": 0,
});
pump([wallLoc, at(95, 2, 0)], 2);
check("上に繋がると縦の直線（c0=上 / c1=下）", armsOf(wallLoc), "wr:c0,wr:c1");

// さらに東に足す → 上と東の L 字
dim.place(at(96, 1, 1), "minecraft:stone");
dim.place(at(96, 1, 0), "wr:wire", {
  "minecraft:block_face": "north",
  "wr:power": 0,
  "wr:color": 0,
});
pump([wallLoc, at(96, 1, 0)], 2);
check("上と東なら L 字（c0 / c2=東）", armsOf(wallLoc), "wr:c0,wr:c2");

section("支持面の自動吸着: 別のものをクリックして置いても壁に貼り直す");
// 実機の症状の再現。壁のワイヤーの真上にもう 1 本足そうとして
// 「下のワイヤー」（当たり判定が壁いっぱいの板なのでクリックしやすい）を
// クリックすると block_face が up になり、
//   ・板が床向きになって壁から浮く
//   ・腕の向きが上下ではなく南北東西になり、繋がっている方向と合わない
// が同時に起きていた。
dim.place(at(120, 1, -1), "minecraft:stone"); // 北側の壁
dim.place(at(120, 2, -1), "minecraft:stone");
const wallA = at(120, 1, 0);
const wallB = at(120, 2, 0);
dim.place(wallA, "wr:wire", { "minecraft:block_face": "south", "wr:power": 0, "wr:color": 0 });
dim.place(wallB, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
pump([wallA, wallB], 3);
check("壁に貼り直される", stateOf(wallB, "minecraft:block_face"), "south");
check("腕も上下向きになる", armsOf(wallB), "wr:c0,wr:c1");
check("落ちてはいない", dim.getBlock(wallB).typeId, "wr:wire");

section("支持面の自動吸着: block_face が支持面そのものを指していても直る");
// block_face の解釈が「クリックした面」でも「接している面」でも
// 同じ結果に落ち着くことの確認。
dim.place(at(125, 0, 0), "minecraft:stone");
const flippedLoc = at(125, 1, 0);
dim.place(flippedLoc, "wr:wire", { "minecraft:block_face": "down", "wr:power": 0, "wr:color": 0 });
pump([flippedLoc], 3);
check("床向きに直る", stateOf(flippedLoc, "minecraft:block_face"), "up");

section("支持面の自動吸着: 迷ったら隣の板と同じ壁を選ぶ");
// 壁を伝う配線の一番下の 1 枚だけ向きがズレた状況。
// 真下に床があるので、固定の優先順（床が先頭）だけだと
// **壁の配線がそこだけ床に寝てしまう**。
// 隣の板が貼りついている面を先に試すことで、同じ壁に揃う。
dim.place(at(150, 0, 0), "minecraft:stone"); // 真下の床
dim.place(at(150, 1, -1), "minecraft:stone"); // 北の壁
dim.place(at(150, 2, -1), "minecraft:stone");
const runTop = at(150, 2, 0);
const runBottom = at(150, 1, 0);
dim.place(runTop, "wr:wire", { "minecraft:block_face": "south", "wr:power": 0, "wr:color": 0 });
// 下の 1 枚だけ、支えの無い向き（西）を向いている
dim.place(runBottom, "wr:wire", { "minecraft:block_face": "east", "wr:power": 0, "wr:color": 0 });
pump([runTop, runBottom], 3);
check("上の板と同じ north の壁に揃う", stateOf(runBottom, "minecraft:block_face"), "south");
check("真下に床があっても床に寝ない", dim.getBlock(runBottom).typeId, "wr:wire");

section("配線レンチ: 貼りつく面を後から変えられる");
// 床と北の壁の両方がある角。ここなら貼れる面が 2 つあるので送れる。
dim.place(at(160, 0, 0), "minecraft:stone"); // 床
dim.place(at(160, 1, -1), "minecraft:stone"); // 北の壁
const wrenchLoc = at(160, 1, 0);
dim.place(wrenchLoc, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
const wrenchPlayer = fakePlayer("wrench", undefined, "wr:wrench");
const wrench = itemComponents.get("wr:wrench");

check("最初は床向き", stateOf(wrenchLoc, "minecraft:block_face"), "up");
wrench.onUseOn({ source: wrenchPlayer, block: dim.getBlock(wrenchLoc) });
check("1 回で壁向きに送られる", stateOf(wrenchLoc, "minecraft:block_face"), "south");
wrench.onUseOn({ source: wrenchPlayer, block: dim.getBlock(wrenchLoc) });
check("もう 1 回で床向きに戻る", stateOf(wrenchLoc, "minecraft:block_face"), "up");
// 自動吸着に引き戻されないこと（支えのある面しか選ばないので残る）
pump([wrenchLoc], 3);
check("tick を回しても戻らない", stateOf(wrenchLoc, "minecraft:block_face"), "up");

section("配線レンチ: 貼れる面が 1 つしかないときは知らせる");
dim.place(at(165, 1, -1), "minecraft:stone"); // 北の壁だけ（床は無い）
const onlyLoc = at(165, 1, 0);
dim.place(onlyLoc, "wr:wire", { "minecraft:block_face": "south", "wr:power": 0, "wr:color": 0 });
wrench.onUseOn({ source: wrenchPlayer, block: dim.getBlock(onlyLoc) });
check("面は変わらない", stateOf(onlyLoc, "minecraft:block_face"), "south");
check("その旨のメッセージが出る", wrenchPlayer.lastActionBar?.translate, "wr.msg.wrench.only");

section("配線レンチ: スニークで繋がった配線をまとめて揃える");
// 北の壁ぞいに 3 枚。真ん中の 1 枚だけ床（配線室のように床にも支えがある）。
for (const y of [1, 2, 3]) dim.place(at(170, y, -1), "minecraft:stone");
dim.place(at(170, 0, 0), "minecraft:stone"); // 一番下の板の真下の床
const alignA = at(170, 1, 0);
const alignB = at(170, 2, 0);
const alignC = at(170, 3, 0);
dim.place(alignA, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
for (const loc of [alignB, alignC]) {
  dim.place(loc, "wr:wire", { "minecraft:block_face": "south", "wr:power": 0, "wr:color": 0 });
}
check("下の 1 枚だけ床向き", stateOf(alignA, "minecraft:block_face"), "up");
wrenchPlayer.isSneaking = true;
wrench.onUseOn({ source: wrenchPlayer, block: dim.getBlock(alignC) });
wrenchPlayer.isSneaking = false;
check("まとめて壁向きに揃う", stateOf(alignA, "minecraft:block_face"), "south");
check("元から壁向きのものはそのまま", stateOf(alignB, "minecraft:block_face"), "south");
check("揃えたメッセージが出る", wrenchPlayer.lastActionBar?.translate, "wr.msg.wrench.aligned");

section("配線レンチ: 薄板以外に使っても何も壊さない");
wrench.onUseOn({ source: wrenchPlayer, block: dim.getBlock(at(160, 0, 0)) });
check("対象外の案内が出る", wrenchPlayer.lastActionBar?.translate, "wr.msg.wrench.target");
check("石はそのまま", dim.getBlock(at(160, 0, 0)).typeId, "minecraft:stone");

section("支持面の自動吸着: ワイヤーはワイヤーの支えにならない");
// 1px の板なので、ワイヤーの上に空中でワイヤーを積むことはできない。
dim.place(at(130, 0, 0), "minecraft:stone");
dim.place(at(130, 1, 0), "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
dim.place(at(130, 2, 0), "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
pump([at(130, 1, 0), at(130, 2, 0)], 3);
check("支えが無いワイヤーは落ちる", dim.getBlock(at(130, 2, 0)).typeId, "minecraft:air");
check("支えのある方は残る", dim.getBlock(at(130, 1, 0)).typeId, "wr:wire");

section("設置の向き: クリックした面にそのまま貼る");
// 実機の症状。壁をクリックしても block_face が期待どおりに入らず、
// **どのワイヤーも同じ向きを向いてしまう**（一定方向を向く）。
// ensureSupport() だけでは直らない。あれは「記録されている支持面に
// 何か置いてあれば正しい」と見なすので、たまたま支えがあると誤りが残るため。
//
// 北の壁を見て右クリック → クリックしたのは壁の south 面
// → 板は壁の north 側に貼りつく → block_face は 'south' が正しい。
dim.place(at(140, 1, -1), "minecraft:stone"); // 北側の壁
dim.place(at(140, 0, 0), "minecraft:stone"); // 床（誤った向きでも支えが見つかる状況）
const placedLoc = at(140, 1, 0);
const placer = fakePlayer("placer", undefined, "wr:wire");

// エンジンが block_face を入れ損ねて既定値のままになった状況を作る
dim.place(placedLoc, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });

world.beforeEvents.playerInteractWithBlock.emit({
  player: placer,
  block: dim.getBlock(at(140, 1, -1)), // クリックしたのは壁
  blockFace: "South", // Direction 列挙は大文字始まり
});
world.afterEvents.playerPlaceBlock.emit({ player: placer, block: dim.getBlock(placedLoc) });
check("クリックした面が採用される", stateOf(placedLoc, "minecraft:block_face"), "south");
pump([placedLoc], 3);
check("床があっても壁に貼ったままになる", stateOf(placedLoc, "minecraft:block_face"), "south");

section("設置の向き: 隣の薄板をクリックしたら、その板と同じ面を引き継ぐ");
// 壁づたいに伸ばすとき、隣のワイヤー（当たり判定が壁いっぱいの板）を
// クリックしてしまっても向きが揃うこと。
dim.place(at(140, 2, -1), "minecraft:stone"); // 壁を 1 段のばす
const stackedLoc = at(140, 2, 0);
dim.place(stackedLoc, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
world.beforeEvents.playerInteractWithBlock.emit({
  player: placer,
  block: dim.getBlock(placedLoc), // クリックしたのは下のワイヤー（block_face=south）
  blockFace: "Up", // その板の上面を叩いた
});
world.afterEvents.playerPlaceBlock.emit({ player: placer, block: dim.getBlock(stackedLoc) });
check("下の板と同じ south を引き継ぐ", stateOf(stackedLoc, "minecraft:block_face"), "south");

// 2 本が縦に並んだので、腕は上下（c0 / c1）を向くはず。
// ここが南北東西になっていたら、板の向きと腕の対応がズレている。
pump([placedLoc, stackedLoc], 3);
check("下の板の腕が上下向きになる", armsOf(placedLoc), "wr:c0,wr:c1");
check("上の板の腕も上下向きになる", armsOf(stackedLoc), "wr:c0,wr:c1");

section("診断コマンド: /scriptevent wr:wires");
// ワイヤーは 1px の板で当たり判定が薄く、wr:inputs で狙うと後ろの壁に当たる。
// 立っているだけで周囲の板の貼りつき面を一覧できることを確かめる。
const diagPlayer = fakePlayer("diag", undefined, "wr:probe");
diagPlayer.location = { x: 140.5, y: 1.5, z: 0.5 };
diagPlayer.dimension = dim;
const diagLines = [];
diagPlayer.sendMessage = (msg) => diagLines.push(String(msg));
system.afterEvents.scriptEventReceive.emit({
  id: "wr:wires",
  message: "3",
  sourceEntity: diagPlayer,
});
const plain = diagLines.join("\n").replace(/§./g, "");
check("薄板ダンプの見出しが出る", plain.includes("[wr] 薄板ダンプ"), true);
check("壁の 2 枚が拾われる", /\/ 2 枚/.test(plain), true);
check("貼りつき面の集計に north が出る", plain.includes("north=2"), true);
check("全部同じ向きなら注意書きが出る", plain.includes("すべて同じ面に貼りついています"), true);

section("設置の向き: 古いクリックは設置に結びつけない");
const staleLoc = at(145, 1, 0);
dim.place(at(145, 0, 0), "minecraft:stone");
dim.place(staleLoc, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
world.beforeEvents.playerInteractWithBlock.emit({
  player: placer,
  block: dim.getBlock(at(145, 0, 0)),
  blockFace: "North",
});
advanceTicks(20); // TTL（10 tick）を大きく超えて放置
world.afterEvents.playerPlaceBlock.emit({ player: placer, block: dim.getBlock(staleLoc) });
check("時間切れのクリックは無視される", stateOf(staleLoc, "minecraft:block_face"), "up");

section("D-1 NOT 回路");
dim.place(at(0, 5, 0), "wr:not_gate", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
});
pump([at(0, 5, 0)], 3);
check("入力なし → ON", stateOf(at(0, 5, 0), "wr:on"), true);
dim.place(at(0, 5, 1), "minecraft:redstone_block", {}, 15); // 背面（south）
pump([at(0, 5, 0)], 3);
check("背面に入力 → OFF", stateOf(at(0, 5, 0), "wr:on"), false);

// ---- D-2 / D-3 AND・OR 回路 --------------------------------------------------

section("D-2 AND 回路 / D-3 OR 回路");
// 前面 north → 主入力は背面 south (z+1)、副入力は右側面 east (x+1)
dim.place(at(0, 10, 0), "wr:and_gate", {
  "minecraft:cardinal_direction": "north",
  "wr:power": 0,
});
dim.place(at(0, 10, 1), "minecraft:redstone_wire", {}, 9);
dim.place(at(1, 10, 0), "minecraft:redstone_wire", {}, 5);
pump([at(0, 10, 0)], 3);
check("AND = min(9, 5)", stateOf(at(0, 10, 0), "wr:power"), 5);

dim.place(at(0, 12, 0), "wr:or_gate", {
  "minecraft:cardinal_direction": "north",
  "wr:power": 0,
});
dim.place(at(0, 12, 1), "minecraft:redstone_wire", {}, 9);
dim.place(at(1, 12, 0), "minecraft:redstone_wire", {}, 5);
pump([at(0, 12, 0)], 3);
check("OR = max(9, 5)", stateOf(at(0, 12, 0), "wr:power"), 9);

section("D-2 AND 回路: 設置方向を変えても副入力が追従する");
// 前面 east → 主入力は west (x-1)、副入力は south (z+1)
dim.place(at(0, 14, 0), "wr:and_gate", {
  "minecraft:cardinal_direction": "east",
  "wr:power": 0,
});
dim.place(at(-1, 14, 0), "minecraft:redstone_wire", {}, 12);
dim.place(at(0, 14, 1), "minecraft:redstone_wire", {}, 7);
pump([at(0, 14, 0)], 3);
check("AND = min(12, 7)", stateOf(at(0, 14, 0), "wr:power"), 7);

// ---- C-3 可変ディレイリピーター ---------------------------------------------

section("C-3 可変ディレイリピーター: wr:delay x 2 tick 遅れて出力が変わる");
dim.place(at(0, 20, 0), "wr:variable_repeater", {
  "minecraft:cardinal_direction": "north",
  "wr:delay": 3, // 3 x 2 = 6 tick
  "wr:on": false,
});
dim.place(at(0, 20, 1), "minecraft:redstone_block", {}, 15); // 背面
const repeater = dim.getBlock(at(0, 20, 0));
blockComponents.get("wr:variable_repeater").onTick({ block: repeater });
advanceTicks(1); // 共通伝播ロジックの 1 tick 遅延ぶん
advanceTicks(4);
check("4 tick 後はまだ OFF", stateOf(at(0, 20, 0), "wr:on"), false);
advanceTicks(4);
check("6 tick 後は ON", stateOf(at(0, 20, 0), "wr:on"), true);

// ---- C-2 パルス生成機 --------------------------------------------------------

section("C-2 パルス生成機: 入力がある間だけ周期的にトグルする");
// 周期はブロックステートではなくワールド動的プロパティ（v1.31.0）。
// 既定は 5 tick なので、置いただけで従来と同じ動きになる。
dim.place(at(0, 25, 0), "wr:pulse_generator", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
});
dim.place(at(0, 25, 1), "minecraft:redstone_block", {}, 15);
pump([at(0, 25, 0)], 2);
const before = stateOf(at(0, 25, 0), "wr:on");
advanceTicks(5);
check("5 tick でトグルした", stateOf(at(0, 25, 0), "wr:on"), !before);
advanceTicks(5);
check("さらに 5 tick で戻った", stateOf(at(0, 25, 0), "wr:on"), before);
// 入力を切ると停止する
dim.place(at(0, 25, 1), "minecraft:air");
pump([at(0, 25, 0)], 3);
const stopped = stateOf(at(0, 25, 0), "wr:on");
advanceTicks(20);
check("入力を切ると停止する", stateOf(at(0, 25, 0), "wr:on"), stopped);
check("停止時は OFF", stopped, false);

section("C-2 パルス生成機: 周期 1〜2400 tick");
const pulseComp = blockComponents.get("wr:pulse_generator");
const pulseLoc = at(0, 25, 0);
const periodPlayer = fakePlayer("pulse", undefined);
const periodOfBlock = () => timingMod.periodOf(dim.getBlock(pulseLoc));

check("未設定なら既定の 5 tick", periodOfBlock(), 5);
check(
  "周期はステートに持っていない",
  Object.keys(blockDefStates("pulse_generator")).join(","),
  "wr:on"
);

// スニーク + 右クリックはプリセット送り（+1 だと 1〜2400 を回りきれない）
periodPlayer.isSneaking = true;
pulseComp.onPlayerInteract({ block: dim.getBlock(pulseLoc), player: periodPlayer });
check("5 の次のプリセットは 20", periodOfBlock(), 20);
for (const expected of [100, 600, 1200, 2400]) {
  pulseComp.onPlayerInteract({ block: dim.getBlock(pulseLoc), player: periodPlayer });
  check(`次のプリセットは ${expected}`, periodOfBlock(), expected);
}
// 上限まで来たら先頭へ戻る
pulseComp.onPlayerInteract({ block: dim.getBlock(pulseLoc), player: periodPlayer });
check("2400 の次は先頭の 5 に戻る", periodOfBlock(), 5);

// プリセットに無い値からでも「次に大きいプリセット」へ行く
setPulseDp(pulseLoc, 37);
pulseComp.onPlayerInteract({ block: dim.getBlock(pulseLoc), player: periodPlayer });
check("37 の次は 100（プリセット外からでも送れる）", periodOfBlock(), 100);
periodPlayer.isSneaking = false;

// 右クリックはスライダー
resetForms();
queueResponse({ canceled: false, formValues: [37] });
pulseComp.onPlayerInteract({ block: dim.getBlock(pulseLoc), player: periodPlayer });
await settle(2);
check("右クリックでスライダーが開く", shownForms[0]?.fields?.[0]?.type, "slider");
check(
  "スライダーの範囲は 1〜2400",
  `${shownForms[0]?.fields?.[0]?.min}-${shownForms[0]?.fields?.[0]?.max}`,
  "1-2400"
);
check("37 tick に設定された", periodOfBlock(), 37);

// 30 秒〜2 分のスパンが 1 tick 刻みのまま指定できる（粗いモードへ落ちない）
advanceTicks(12);
resetForms();
queueResponse({ canceled: false, formValues: [1817] });
pulseComp.onPlayerInteract({ block: dim.getBlock(pulseLoc), player: periodPlayer });
await settle(2);
check("1817 tick のような半端な長周期も丸められない", periodOfBlock(), 1817);
advanceTicks(12);

// 連打しても多重に開かない（UserBusy 対策のクールダウン）
advanceTicks(12); // 直前に開いたぶんのクールダウンを明ける
resetForms();
queueResponse({ canceled: false, formValues: [10] });
queueResponse({ canceled: false, formValues: [11] });
pulseComp.onPlayerInteract({ block: dim.getBlock(pulseLoc), player: periodPlayer });
pulseComp.onPlayerInteract({ block: dim.getBlock(pulseLoc), player: periodPlayer });
await settle(2);
check("連打してもフォームは 1 枚だけ", shownForms.length, 1);
advanceTicks(12); // クールダウン明け

// 周期 1 に戻して実挙動を見る
resetForms();
queueResponse({ canceled: false, formValues: [1] });
pulseComp.onPlayerInteract({ block: dim.getBlock(pulseLoc), player: periodPlayer });
await settle(2);
check("1 tick に設定", periodOfBlock(), 1);

// 実際に 1 tick 周期で動く
dim.place(at(0, 25, 1), "minecraft:redstone_block", {}, 15);
pump([pulseLoc], 2);
const p1 = stateOf(pulseLoc, "wr:on");
advanceTicks(1);
check("周期 1 tick で毎 tick 反転する", stateOf(pulseLoc, "wr:on"), !p1);

// ---- A ワイヤレス ------------------------------------------------------------

section("A ワイヤレス送受信");
const player = fakePlayer("p1", "ALPHA");
dim.place(at(0, 30, 0), "wr:transmitter");
world.afterEvents.playerPlaceBlock.emit({ player, block: dim.getBlock(at(0, 30, 0)), dimension: dim });
dim.place(at(50, 30, 0), "wr:receiver", { "wr:power": 0 });
world.afterEvents.playerPlaceBlock.emit({ player, block: dim.getBlock(at(50, 30, 0)), dimension: dim });

dim.place(at(0, 30, 1), "minecraft:redstone_block", {}, 15);
// 送信機は onRedstoneUpdate で即反応し、受信機はチャンネルの変化を
// プッシュで受け取る。20 tick のポーリングを待たずに追従するはず。
blockComponents.get("wr:transmitter").onRedstoneUpdate({ block: dim.getBlock(at(0, 30, 0)) });
advanceTicks(3);
check("受信ブロックが 3 tick 以内に 15 を受け取った", stateOf(at(50, 30, 0), "wr:power"), 15);

// 切ったときも同じ速さで落ちる
dim.place(at(0, 30, 1), "minecraft:air");
blockComponents.get("wr:transmitter").onRedstoneUpdate({ block: dim.getBlock(at(0, 30, 0)) });
advanceTicks(3);
check("切ると 3 tick 以内に 0 に落ちる", stateOf(at(50, 30, 0), "wr:power"), 0);

// 以降のテストのために戻しておく
dim.place(at(0, 30, 1), "minecraft:redstone_block", {}, 15);
blockComponents.get("wr:transmitter").onRedstoneUpdate({ block: dim.getBlock(at(0, 30, 0)) });
advanceTicks(3);
check("再投入で戻る", stateOf(at(50, 30, 0), "wr:power"), 15);

section("A 同じチャンネルの受信機を複数台");
// 同じチャンネル ALPHA の受信機を離れた場所に 3 台置く
const multi = [at(60, 30, 0), at(60, 30, 10), at(60, 30, 20)];
for (const loc of multi) {
  dim.place(loc, "wr:receiver", { "wr:power": 0 });
  world.afterEvents.playerPlaceBlock.emit({
    player: fakePlayer("multi", "ALPHA"),
    block: dim.getBlock(loc),
    dimension: dim,
  });
}
advanceTicks(3);
check("3 台とも 15 を受け取る", multi.map((l) => stateOf(l, "wr:power")).join(","), "15,15,15");

// 送信を切ると 3 台とも落ちる
dim.place(at(0, 30, 1), "minecraft:air");
blockComponents.get("wr:transmitter").onRedstoneUpdate({ block: dim.getBlock(at(0, 30, 0)) });
advanceTicks(3);
check("3 台とも 0 に落ちる", multi.map((l) => stateOf(l, "wr:power")).join(","), "0,0,0");

// 送信機を 2 台にして、強い方が採用されるか
dim.place(at(0, 30, 1), "minecraft:redstone_wire", {}, 7);
blockComponents.get("wr:transmitter").onRedstoneUpdate({ block: dim.getBlock(at(0, 30, 0)) });
dim.place(at(64, 30, 0), "wr:transmitter");
world.afterEvents.playerPlaceBlock.emit({
  player: fakePlayer("multi2", "ALPHA"),
  block: dim.getBlock(at(64, 30, 0)),
  dimension: dim,
});
dim.place(at(64, 30, 1), "minecraft:redstone_wire", {}, 12);
blockComponents.get("wr:transmitter").onRedstoneUpdate({ block: dim.getBlock(at(64, 30, 0)) });
advanceTicks(3);
check("送信機 2 台なら最大値が出る", multi.map((l) => stateOf(l, "wr:power")).join(","), "12,12,12");

// 後片付け（以降のテストが ALPHA の送信機を 1 台前提にしているため）
blockComponents.get("wr:transmitter").onPlayerDestroy({ block: dim.getBlock(at(64, 30, 0)) });
dim.place(at(64, 30, 0), "minecraft:air");
dim.place(at(0, 30, 1), "minecraft:redstone_block", {}, 15);
blockComponents.get("wr:transmitter").onRedstoneUpdate({ block: dim.getBlock(at(0, 30, 0)) });
advanceTicks(3);
check("片方を壊しても残りが効く", multi.map((l) => stateOf(l, "wr:power")).join(","), "15,15,15");

check(
  "チャンネル ALPHA のプロパティが存在する",
  world.getDynamicPropertyIds().some((id) => id.startsWith("wr:ch:ALPHA|tx|")),
  true
);

section("A チャンネル名の一括変更");
// ALPHA を GAMMA に変えたら、送信機・受信機・リモコンが全部追従すること
const renamer = addPlayer(fakePlayer("renamer", undefined, "wr:remote"));
const stashed = new ItemStack("wr:remote");
stashed.nameTag = "ALPHA";
renamer.inventory.setItem(0, stashed);
const other = new ItemStack("wr:remote");
other.nameTag = "OMEGA"; // 巻き込まれてはいけない
renamer.inventory.setItem(1, other);

renamer.isSneaking = true;

/** リモコンのチャンネル選択フォームを開く。 */
async function openPicker(channel, responses) {
  resetForms();
  for (const r of responses) queueResponse(r);
  const item = new ItemStack("wr:remote");
  item.nameTag = channel;
  renamer.setHeld(item);
  itemComponents.get("wr:remote").onUse({ source: renamer, itemStack: item });
  await settle(2);
}

/** 一度開いてボタンの並びを読む（位置を決め打ちしないため）。 */
async function pickerButtons(channel) {
  await openPicker(channel, [{ canceled: true }]);
  return shownForms[0]?.buttons ?? [];
}

const buttons = await pickerButtons("ALPHA");
check(
  "「新規入力」ボタンがある",
  buttons.some((b) => b.text?.translate === "wr.ui.channel.new"),
  true
);
check(
  "「名前を変更」ボタンがある",
  buttons.some((b) => b.text?.translate === "wr.ui.channel.rename"),
  true
);

/**
 * チャンネル名を一括変更する。
 * ボタンの位置もドロップダウンの並びも実際のフォームから読み取るので、
 * チャンネルが増減しても壊れない。
 */
async function renameVia(currentChannel, targetChannel, newName) {
  const btns = await pickerButtons(currentChannel);
  const rIdx = btns.findIndex((b) => b.text?.translate === "wr.ui.channel.rename");
  // ドロップダウンの並びを読むためだけに一度開いて閉じる
  await openPicker(currentChannel, [
    { canceled: false, selection: rIdx },
    { canceled: true },
  ]);
  const options = shownForms[1]?.fields?.[0]?.options ?? [];
  await openPicker(currentChannel, [
    { canceled: false, selection: rIdx },
    { canceled: false, formValues: [options.indexOf(targetChannel), newName] },
  ]);
  return options;
}

const listed = await renameVia("ALPHA", "ALPHA", "GAMMA");
check("名前変更フォームはドロップダウン付き", shownForms[1]?.fields?.[0]?.type, "dropdown");
check("ドロップダウンに ALPHA が並ぶ", listed.includes("ALPHA"), true);
check("受信機は GAMMA に移った", getReceiverChannelOf(multi[0]), "GAMMA");
check("インベントリのリモコンも GAMMA に", renamer.inventory.getItem(0)?.nameTag, "GAMMA");
check("別チャンネルのリモコンは無事", renamer.inventory.getItem(1)?.nameTag, "OMEGA");
check(
  "旧チャンネルのプロパティは残っていない",
  world.getDynamicPropertyIds().some((id) => id.startsWith("wr:ch:ALPHA|")),
  false
);
advanceTicks(3);
check("受信機は電力を保ったまま", stateOf(multi[0], "wr:power"), 15);

// 戻しておく（以降のテストが ALPHA 前提のため）
await renameVia("GAMMA", "GAMMA", "ALPHA");
check("元に戻せる", getReceiverChannelOf(multi[0]), "ALPHA");
renamer.isSneaking = false;
resetForms();

function getReceiverChannelOf(loc) {
  return world.getDynamicProperty(`wr:rx|${DIM}|${loc.x}|${loc.y}|${loc.z}`);
}

section("A リモコン");
const remoteItem = new ItemStack("wr:remote");
remoteItem.nameTag = "ALPHA";
itemComponents.get("wr:remote").onUse({ source: player, itemStack: remoteItem });
check("リモコンのプロパティが立った", world.getDynamicProperty("wr:ch:ALPHA|remote"), 15);
itemComponents.get("wr:remote").onUse({ source: player, itemStack: remoteItem });
check("もう一度使うと戻る", world.getDynamicProperty("wr:ch:ALPHA|remote"), 0);

section("A 破壊時のクリーンアップ（爆発）");
const txBlock = dim.getBlock(at(0, 30, 0));
const txPerm = txBlock.permutation;
dim.place(at(0, 30, 0), "minecraft:air");
world.afterEvents.blockExplode.emit({
  block: txBlock,
  dimension: dim,
  explodedBlockPermutation: txPerm,
});
check(
  "爆発後にチャンネルのプロパティが消えた",
  world.getDynamicPropertyIds().some((id) => id.startsWith("wr:ch:ALPHA|tx|")),
  false
);

// ---- 追加の論理回路 ---------------------------------------------------------

section("XOR / NAND / NOR / XNOR");
/** 前面 north の 2 入力ゲートを 1 つ置いて、主入力・副入力を与えたときの wr:on。 */
function gateOn(typeId, y, mainPower, subPower) {
  const loc = at(20, y, 0);
  dim.place(loc, typeId, { "minecraft:cardinal_direction": "north", "wr:on": false });
  dim.place(at(20, y, 1), "minecraft:redstone_wire", {}, mainPower); // 背面
  dim.place(at(21, y, 0), "minecraft:redstone_wire", {}, subPower); // 右側面
  pump([loc], 3);
  return stateOf(loc, "wr:on");
}
check("XOR(1,0) = ON", gateOn("wr:xor_gate", 40, 15, 0), true);
check("XOR(1,1) = OFF", gateOn("wr:xor_gate", 41, 15, 15), false);
check("XOR(0,0) = OFF", gateOn("wr:xor_gate", 42, 0, 0), false);
check("NAND(1,1) = OFF", gateOn("wr:nand_gate", 43, 15, 15), false);
check("NAND(1,0) = ON", gateOn("wr:nand_gate", 44, 15, 0), true);
check("NOR(0,0) = ON", gateOn("wr:nor_gate", 45, 0, 0), true);
check("NOR(1,0) = OFF", gateOn("wr:nor_gate", 46, 15, 0), false);
check("XNOR(1,1) = ON", gateOn("wr:xnor_gate", 47, 15, 15), true);
check("XNOR(1,0) = OFF", gateOn("wr:xnor_gate", 48, 15, 0), false);

// ---- 比較ブロック -----------------------------------------------------------

section("比較ブロック: 主入力と副入力の大小を比べる");
// 前面 north → 主入力は south（背面）、副入力は east（右側面）
const cmpLoc = at(26, 44, 0);
const cmpComp = blockComponents.get("wr:compare");
function compareWith(main, sub, mode) {
  dim.place(cmpLoc, "wr:compare", {
    "minecraft:cardinal_direction": "north",
    "wr:on": false,
    "wr:mode": mode,
  });
  dim.place(at(26, 44, 1), "minecraft:redstone_wire", {}, main); // 背面
  dim.place(at(27, 44, 0), "minecraft:redstone_wire", {}, sub); // 右側面
  cmpComp.onTick({ block: dim.getBlock(cmpLoc) });
  advanceTicks(2);
  return stateOf(cmpLoc, "wr:on");
}
check("mode0 (>)  10 > 3 → ON", compareWith(10, 3, 0), true);
check("mode0 (>)  3 > 10 → OFF", compareWith(3, 10, 0), false);
check("mode0 (>)  等しければ OFF", compareWith(5, 5, 0), false);
check("mode1 (>=) 等しければ ON", compareWith(5, 5, 1), true);
check("mode1 (>=) 下回れば OFF", compareWith(4, 5, 1), false);
check("mode2 (==) 等しければ ON", compareWith(7, 7, 2), true);
check("mode2 (==) 違えば OFF", compareWith(7, 8, 2), false);

// 右クリックで比べ方が巡回する
dim.place(cmpLoc, "wr:compare", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
  "wr:mode": 0,
});
const cmpPlayer = fakePlayer("cmp", undefined, "minecraft:stick");
cmpComp.onPlayerInteract({ block: dim.getBlock(cmpLoc), player: cmpPlayer });
check("右クリックで次のモードへ", stateOf(cmpLoc, "wr:mode"), 1);
cmpComp.onPlayerInteract({ block: dim.getBlock(cmpLoc), player: cmpPlayer });
cmpComp.onPlayerInteract({ block: dim.getBlock(cmpLoc), player: cmpPlayer });
check("一周して 0 に戻る", stateOf(cmpLoc, "wr:mode"), 0);

// ---- レジスタ ---------------------------------------------------------------

section("レジスタ: 副入力の立ち上がりで主入力を取り込む");
const regLoc = at(28, 44, 0);
dim.place(regLoc, "wr:register", {
  "minecraft:cardinal_direction": "north",
  "wr:power": 0,
  "wr:armed": true,
});
const regComp = blockComponents.get("wr:register");
const regMain = at(28, 44, 1); // 背面 = 取り込む値
const regTrig = at(29, 44, 0); // 右側面 = 取り込み信号
const pumpReg = () => {
  regComp.onTick({ block: dim.getBlock(regLoc) });
  advanceTicks(1);
};

dim.place(regMain, "minecraft:redstone_wire", {}, 9);
dim.place(regTrig, "minecraft:redstone_wire", {}, 0);
pumpReg();
check("取り込み信号が無ければ 0 のまま", stateOf(regLoc, "wr:power"), 0);

dim.place(regTrig, "minecraft:redstone_wire", {}, 15);
pumpReg();
check("立ち上がりで取り込む", stateOf(regLoc, "wr:power"), 9);

// 取り込んだあとに主入力が変わっても、保持している値は動かない
dim.place(regMain, "minecraft:redstone_wire", {}, 2);
pumpReg();
pumpReg();
check("入りっぱなしでは取り込み直さない", stateOf(regLoc, "wr:power"), 9);

// 一度切ってからならまた取り込む
dim.place(regTrig, "minecraft:redstone_wire", {}, 0);
pumpReg();
check("切っても保持している", stateOf(regLoc, "wr:power"), 9);
dim.place(regTrig, "minecraft:redstone_wire", {}, 15);
pumpReg();
check("切ってからならまた取り込む", stateOf(regLoc, "wr:power"), 2);

// 右クリックで 0 に戻す
regComp.onPlayerInteract({
  block: dim.getBlock(regLoc),
  player: fakePlayer("reg", undefined, "minecraft:stick"),
});
check("右クリックで 0 に戻る", stateOf(regLoc, "wr:power"), 0);

// ---- 閾値ブロック -----------------------------------------------------------

section("閾値ブロック");
const thLoc = at(24, 40, 0);
dim.place(thLoc, "wr:threshold", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
});
setThresholdDp(thLoc, 8, 8); // rise=fall はヒステリシス無し＝従来の「1本の閾値」と同じ
check(
  "ステートには持っていない（rise/fallは動的プロパティ）",
  Object.keys(blockDefStates("threshold")).join(","),
  "wr:on"
);
dim.place(at(24, 40, 1), "minecraft:redstone_wire", {}, 7);
pump([thLoc], 3);
check("入力 7 < 閾値 8 → OFF", stateOf(thLoc, "wr:on"), false);
dim.place(at(24, 40, 1), "minecraft:redstone_wire", {}, 8);
pump([thLoc], 3);
check("入力 8 >= 閾値 8 → ON", stateOf(thLoc, "wr:on"), true);

section("閾値ブロック: シュミットトリガー化（rise/fallを分ければチャタリングしない）v1.31.2");
const thHystLoc = at(24, 40, 10);
dim.place(thHystLoc, "wr:threshold", { "minecraft:cardinal_direction": "north", "wr:on": false });
setThresholdDp(thHystLoc, 10, 4); // ON: 10 以上 / OFF: 4 未満
dim.place(at(24, 40, 11), "minecraft:redstone_wire", {}, 6);
pump([thHystLoc], 3);
check("6 は rise(10) 未満 → まだ OFF", stateOf(thHystLoc, "wr:on"), false);
dim.place(at(24, 40, 11), "minecraft:redstone_wire", {}, 10);
pump([thHystLoc], 3);
check("10 で rise に届いて ON", stateOf(thHystLoc, "wr:on"), true);
dim.place(at(24, 40, 11), "minecraft:redstone_wire", {}, 6);
pump([thHystLoc], 3);
check("6 は fall(4) 以上なので ON を維持（ここがチャタリングしない部分）", stateOf(thHystLoc, "wr:on"), true);
dim.place(at(24, 40, 11), "minecraft:redstone_wire", {}, 3);
pump([thHystLoc], 3);
check("3 は fall(4) 未満で OFF に落ちる", stateOf(thHystLoc, "wr:on"), false);

section("閾値ブロック: wr: の電源から受け取った値がずれない");
// ワイヤーが wr: の電源から受け取るときに減衰していると、
// 「閾値 5 なのに 6 以上でないと ON にならない」というズレになる。
const cLoc = at(26, 40, 2);
dim.place(cLoc, "wr:constant", { "wr:power": 5 });
dim.place(at(26, 39, 1), "minecraft:stone");
const wLoc = at(26, 40, 1);
dim.place(wLoc, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
const th2 = at(26, 40, 0);
dim.place(th2, "wr:threshold", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
});
setThresholdDp(th2, 5, 5);
pump([wLoc, th2], 4);
check("定数電源 5 → ワイヤーも 5（減衰しない）", stateOf(wLoc, "wr:power"), 5);
check("閾値 5 で ON になる", stateOf(th2, "wr:on"), true);

const thPlayer = fakePlayer("th", undefined);
const thComp = blockComponents.get("wr:threshold");

// スニーク + 右クリックは rise だけ +1 の微調整（fall はそのまま）
thPlayer.isSneaking = true;
thComp.onPlayerInteract({ block: dim.getBlock(thLoc), player: thPlayer });
check("スニーク+右クリックで rise が 1 上がる", logicMod.thresholdLevelsOf(dim.getBlock(thLoc)).rise, 9);
check("fall は変わらない", logicMod.thresholdLevelsOf(dim.getBlock(thLoc)).fall, 8);
pump([thLoc], 3);
check("fall(8) は変わらないので入力 8 のまま ON を維持する", stateOf(thLoc, "wr:on"), true);
thPlayer.isSneaking = false;

// 右クリックはスライダー 2 本（rise / fall）
resetForms();
queueResponse({ canceled: false, formValues: [8, 8] });
thComp.onPlayerInteract({ block: dim.getBlock(thLoc), player: thPlayer });
await settle(2);
check("スライダーが 2 本開く", shownForms[0]?.fields?.length, 2);
check("スライダーの範囲は 1〜15", `${shownForms[0]?.fields?.[0]?.min}-${shownForms[0]?.fields?.[0]?.max}`, "1-15");
check("スライダーで 8/8 に戻せる", logicMod.thresholdLevelsOf(dim.getBlock(thLoc)).rise, 8);

section("閾値ブロック: 壊す・爆破すると rise/fall の記録も消える");
thComp.onPlayerDestroy({ block: dim.getBlock(thLoc), player: thPlayer });
check("破壊で rise が既定の 1 に戻る", logicMod.thresholdLevelsOf(dim.getBlock(thLoc)).rise, 1);
setThresholdDp(thLoc, 9, 2);
world.afterEvents.blockExplode.emit({
  block: dim.getBlock(thLoc),
  dimension: dim,
  explodedBlockPermutation: { type: { id: "wr:threshold" } },
});
await settle(1);
check("爆発でも消える（onPlayerDestroy は来ない）", logicMod.thresholdLevelsOf(dim.getBlock(thLoc)).rise, 1);

// ---- 定数電源 ---------------------------------------------------------------

section("定数電源ブロック");
const constLoc = at(28, 40, 0);
dim.place(constLoc, "wr:constant", { "wr:power": 0 });
const constPlayer = fakePlayer("cs", undefined);
const constComp = blockComponents.get("wr:constant");

// スニーク + 右クリックは +1 の微調整
constPlayer.isSneaking = true;
for (let i = 0; i < 3; i += 1) {
  constComp.onPlayerInteract({ block: dim.getBlock(constLoc), player: constPlayer });
}
check("スニーク+右クリック 3 回で出力 3", stateOf(constLoc, "wr:power"), 3);
constPlayer.isSneaking = false;

// 右クリックはスライダー
resetForms();
queueResponse({ canceled: false, formValues: [11] });
constComp.onPlayerInteract({ block: dim.getBlock(constLoc), player: constPlayer });
await settle(2);
check("右クリックでスライダーが開く", shownForms[0]?.fields?.[0]?.type, "slider");
check("スライダーの範囲は 0〜15", `${shownForms[0]?.fields?.[0]?.min}-${shownForms[0]?.fields?.[0]?.max}`, "0-15");
check("スライダーで 11 に設定", stateOf(constLoc, "wr:power"), 11);

section("C-3 可変ディレイリピーター: 設定UI");
const repLoc = at(0, 20, 0);
const repPlayer = fakePlayer("rep", undefined);
const repComp = blockComponents.get("wr:variable_repeater");

repPlayer.isSneaking = true;
const beforeDelay = stateOf(repLoc, "wr:delay");
repComp.onPlayerInteract({ block: dim.getBlock(repLoc), player: repPlayer });
check("スニーク+右クリックで 1 段上がる", stateOf(repLoc, "wr:delay"), beforeDelay + 1);
repPlayer.isSneaking = false;

resetForms();
queueResponse({ canceled: false, formValues: [10] }); // 10 tick = 5 段
repComp.onPlayerInteract({ block: dim.getBlock(repLoc), player: repPlayer });
await settle(2);
check("スライダーは tick 単位で 2〜32", `${shownForms[0]?.fields?.[0]?.min}-${shownForms[0]?.fields?.[0]?.max}`, "2-32");
check("2 tick 刻み", shownForms[0]?.fields?.[0]?.config?.valueStep, 2);
check("10 tick を選ぶと 5 段になる", stateOf(repLoc, "wr:delay"), 5);

// 上限を広げたぶん（v1.30.0 で 16 → 32 tick）が本当に書けること。
// block_ui.js は同じプレイヤーが続けてフォームを開けないよう
// 10 tick のクールダウンを持っているので、そのぶん待ってから開き直す。
advanceTicks(12);
resetForms();
queueResponse({ canceled: false, formValues: [32] });
repComp.onPlayerInteract({ block: dim.getBlock(repLoc), player: repPlayer });
await settle(2);
check("32 tick を選ぶと 16 段になる", stateOf(repLoc, "wr:delay"), 16);

// ---- RSラッチ ---------------------------------------------------------------

section("RSラッチ");
const rsLoc = at(32, 40, 0);
dim.place(rsLoc, "wr:rs_latch", { "minecraft:cardinal_direction": "north", "wr:on": false });
dim.place(at(32, 40, 1), "minecraft:redstone_wire", {}, 15); // セット = 背面
dim.place(at(33, 40, 0), "minecraft:redstone_wire", {}, 0); // リセット = 右側面
pump([rsLoc], 3);
check("セット入力で ON", stateOf(rsLoc, "wr:on"), true);
dim.place(at(32, 40, 1), "minecraft:redstone_wire", {}, 0);
pump([rsLoc], 3);
check("両方 0 でも保持する", stateOf(rsLoc, "wr:on"), true);
dim.place(at(33, 40, 0), "minecraft:redstone_wire", {}, 15);
pump([rsLoc], 3);
check("リセット入力で OFF", stateOf(rsLoc, "wr:on"), false);

// ---- Tフリップフロップ ------------------------------------------------------

section("Tフリップフロップ");
const tfLoc = at(36, 40, 0);
dim.place(tfLoc, "wr:t_flipflop", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
  "wr:armed": true,
});
const pulseInto = (loc) => {
  dim.place(at(36, 40, 1), "minecraft:redstone_wire", {}, 15);
  pump([loc], 3);
  dim.place(at(36, 40, 1), "minecraft:redstone_wire", {}, 0);
  pump([loc], 3);
};
pulseInto(tfLoc);
check("1 回目の立ち上がりで ON", stateOf(tfLoc, "wr:on"), true);
pulseInto(tfLoc);
check("2 回目で OFF", stateOf(tfLoc, "wr:on"), false);
// 入力を入れっぱなしにしても反転は 1 回だけ
dim.place(at(36, 40, 1), "minecraft:redstone_wire", {}, 15);
pump([tfLoc], 10);
check("入力を保持しても 1 回しか反転しない", stateOf(tfLoc, "wr:on"), true);

// ---- ワイヤーの染色 ---------------------------------------------------------

section("ワイヤーの染色: 同じ色のときだけ繋がる");
// 電源 → 赤ワイヤー → 青ワイヤー → 赤ワイヤー と並べる
dim.place(at(59, 50, 0), "minecraft:redstone_block", {}, 15);
for (const x of [60, 61, 62]) dim.place(at(x, 49, 0), "minecraft:stone");
dim.place(at(60, 50, 0), "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
dim.place(at(61, 50, 0), "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 12 });
dim.place(at(62, 50, 0), "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
const dyeLine = [at(60, 50, 0), at(61, 50, 0), at(62, 50, 0)];
pump(dyeLine, 8);
check("赤ワイヤーは電源から 14", stateOf(at(60, 50, 0), "wr:power"), 14);
check("隣の青ワイヤーには流れない", stateOf(at(61, 50, 0), "wr:power"), 0);
check("その先の赤ワイヤーも 0", stateOf(at(62, 50, 0), "wr:power"), 0);

section("ワイヤーの染色: 染料で色が変わる");
const dyePlayer = fakePlayer("dye", undefined, "minecraft:blue_dye");
dyePlayer.setHeld(new ItemStack("minecraft:blue_dye", 3));
blockComponents.get("wr:wire").onPlayerInteract({
  block: dim.getBlock(at(60, 50, 0)),
  player: dyePlayer,
});
check("赤 → 青(12) に染まった", stateOf(at(60, 50, 0), "wr:color"), 12);
pump(dyeLine, 8);
check("青同士が繋がって流れるようになった", stateOf(at(61, 50, 0), "wr:power"), 13);
check("色違いになった 3 本目は 0 のまま", stateOf(at(62, 50, 0), "wr:power"), 0);

// ---- 計測器 -----------------------------------------------------------------

section("計測器: 通常使用と波形記録");
const probePlayer = addPlayer(fakePlayer("probe", undefined, "wr:probe"));
const probe = itemComponents.get("wr:probe");
const probeItem = new ItemStack("wr:probe");

probePlayer.viewTarget = dim.getBlock(at(60, 50, 0));
probe.onUse({ source: probePlayer, itemStack: probeItem });
check("ワイヤーを見ると wire メッセージ", probePlayer.lastActionBar?.translate, "wr.msg.probe.wire");

probePlayer.viewTarget = undefined;
advanceTicks(5); // クールダウン明け
probe.onUse({ source: probePlayer, itemStack: probeItem });
check("何も無ければ NO TARGET", probePlayer.lastActionBar?.translate, "wr.msg.probe.none");

// 波形記録: パルス生成機を対象にする
dim.place(at(64, 50, 0), "wr:pulse_generator", {
  "minecraft:cardinal_direction": "north",
  "wr:period_index": 0,
  "wr:on": false,
});
dim.place(at(64, 50, 1), "minecraft:redstone_block", {}, 15);
pump([at(64, 50, 0)], 2);
probePlayer.isSneaking = true;
probePlayer.viewTarget = dim.getBlock(at(64, 50, 0));
advanceTicks(5);
probe.onUse({ source: probePlayer, itemStack: probeItem });
check("記録開始メッセージ", probePlayer.lastActionBar?.translate, "wr.msg.probe.record.start");
advanceTicks(12);
check("記録中は波形メッセージが出る", probePlayer.lastActionBar?.translate, "wr.msg.probe.wave");
const waveText = probePlayer.lastActionBar?.with?.rawtext?.[0]?.text ?? "";
check("12 tick ぶんサンプリングされた", waveText.length, 12);
check("0/15 のトグルなので 2 種類の文字が出る", new Set(waveText).size, 2);
advanceTicks(5);
probe.onUse({ source: probePlayer, itemStack: probeItem });
check("もう一度使うと停止", probePlayer.lastActionBar?.translate, "wr.msg.probe.record.stop");
probePlayer.isSneaking = false;

// ---- リモコンのチャンネル選択UI ---------------------------------------------

section("リモコンのチャンネル選択UI");
resetForms();
const uiPlayer = fakePlayer("ui", "ALPHA", "wr:remote");
const uiRemote = new ItemStack("wr:remote");
uiRemote.nameTag = "ALPHA";
uiPlayer.setHeld(uiRemote);
uiPlayer.isSneaking = true;

// 一覧から既存のチャンネル（先頭 = 現在のチャンネル）を選ぶ
queueResponse({ canceled: false, selection: 0 });
itemComponents.get("wr:remote").onUse({ source: uiPlayer, itemStack: uiRemote });
await settle(2);
check("フォームが 1 つ開いた", shownForms.length, 1);
check("先頭のボタンは現在のチャンネル", shownForms[0]?.buttons?.[0]?.text, "ALPHA");
check("最後のボタンは名前変更", shownForms[0]?.buttons?.at(-1)?.text?.translate, "wr.ui.channel.rename");

/**
 * フォームを一度開いて、目的のボタンが何番目かを調べる。
 *
 * ボタンの並びは登録済みチャンネル数やカテゴリー数で変わるので、
 * 固定のインデックスを書くとテストが勝手に壊れる。
 * 一度キャンセルで開いて中身を読み、本番の選択に使う。
 */
async function buttonIndex(open, translateKey) {
  resetForms();
  queueResponse({ canceled: true });
  open();
  await settle(2);
  const buttons = shownForms[0]?.buttons ?? [];
  return buttons.findIndex((b) => b.text?.translate === translateKey);
}

/** 「新しいチャンネルを入力」ボタンを押して、テキストを入力する。 */
async function enterNewChannel(text) {
  const open = () =>
    itemComponents.get("wr:remote").onUse({ source: uiPlayer, itemStack: uiPlayer.getHeld() });
  const index = await buttonIndex(open, "wr.ui.channel.new");
  resetForms();
  queueResponse({ canceled: false, selection: index });
  queueResponse({ canceled: false, formValues: [text] });
  open();
  await settle(2);
}

await enterNewChannel("BETA");
check("一覧 → 入力欄の 2 画面が開いた", shownForms.length, 2);
check("2 枚目は入力フォーム", shownForms[1]?.kind, "modal");
check(
  "一覧に新規入力ボタンがある",
  shownForms[0]?.buttons?.some((b) => b.text?.translate === "wr.ui.channel.new"),
  true
);
check("入力したチャンネルにリネームされた", uiPlayer.getHeld()?.nameTag, "BETA");

// 空入力・区切り文字入りは sanitizeChannel で丸められる
await enterNewChannel("   ");
check("空入力は default になる", uiPlayer.getHeld()?.nameTag, "default");
await enterNewChannel("A|B");
check("区切り文字 | は _ に置き換わる", uiPlayer.getHeld()?.nameTag, "A_B");
uiPlayer.isSneaking = false;

// ---- 設置済みブロックのチャンネル変更 ---------------------------------------

section("設置済み送信機/受信機のチャンネル変更");
const chPlayer = fakePlayer("ch", undefined);
dim.place(at(70, 30, 0), "wr:transmitter");
world.afterEvents.playerPlaceBlock.emit({
  player: fakePlayer("ch-place", "OLD"),
  block: dim.getBlock(at(70, 30, 0)),
  dimension: dim,
});
check(
  "設置時のチャンネルが OLD",
  world.getDynamicPropertyIds().some((id) => id.startsWith("wr:ch:OLD|tx|")),
  true
);

// 右クリック → 新規入力で GAMMA に変更
const openTx = () =>
  blockComponents.get("wr:transmitter").onPlayerInteract({
    block: dim.getBlock(at(70, 30, 0)),
    player: chPlayer,
  });
const txNewIndex = await buttonIndex(openTx, "wr.ui.channel.new");
resetForms();
queueResponse({ canceled: false, selection: txNewIndex });
queueResponse({ canceled: false, formValues: ["GAMMA"] });
openTx();
await settle(2);
check("ブロック用のフォームが開いた", shownForms[0]?.title?.translate, "wr.ui.block.title");
check(
  "旧チャンネルのプロパティが消えた",
  world.getDynamicPropertyIds().some((id) => id.startsWith("wr:ch:OLD|tx|")),
  false
);
check(
  "新チャンネルのプロパティに移った",
  world.getDynamicPropertyIds().some((id) => id.startsWith("wr:ch:GAMMA|tx|")),
  true
);

// 受信機側も同じ経路で変えられる
dim.place(at(72, 30, 0), "wr:receiver", { "wr:power": 0 });
world.afterEvents.playerPlaceBlock.emit({
  player: fakePlayer("ch-place2", "OLD"),
  block: dim.getBlock(at(72, 30, 0)),
  dimension: dim,
});
const openRx = () =>
  blockComponents.get("wr:receiver").onPlayerInteract({
    block: dim.getBlock(at(72, 30, 0)),
    player: chPlayer,
  });
const rxNewIndex = await buttonIndex(openRx, "wr.ui.channel.new");
resetForms();
queueResponse({ canceled: false, selection: rxNewIndex });
queueResponse({ canceled: false, formValues: ["GAMMA"] });
openRx();
await settle(2);
// 送信機 GAMMA に電力を入れて、受信機が追従するか
dim.place(at(70, 30, 1), "minecraft:redstone_block", {}, 15);
pump([at(70, 30, 0)], 3);
advanceTicks(8);
check("チャンネル変更後も受信機が追従する", stateOf(at(72, 30, 0), "wr:power"), 15);

// フォームを開いている間にブロックが壊された場合
resetForms();
queueResponse({ canceled: false, selection: 0 });
const doomed = dim.getBlock(at(70, 30, 0));
blockComponents.get("wr:transmitter").onPlayerInteract({ block: doomed, player: chPlayer });
dim.place(at(70, 30, 0), "minecraft:air"); // 決定前に壊す
await settle(2);
check(
  "壊されていたら書き込まず警告する",
  chPlayer.lastActionBar?.translate,
  "wr.msg.channel.gone"
);

// ---- チャンネルのカテゴリー分けとパスワード ---------------------------------

section("カテゴリー: 管理ブロックで作って振り分ける");
const hubPlayer = fakePlayer("hub", undefined);
dim.place(at(80, 30, 0), "wr:channel_hub");
const openHub = () =>
  blockComponents.get("wr:channel_hub").onPlayerInteract({
    block: dim.getBlock(at(80, 30, 0)),
    player: hubPlayer,
  });

// カテゴリーを作る
const newCatIndex = await buttonIndex(openHub, "wr.ui.hub.newcat");
resetForms();
queueResponse({ canceled: false, selection: newCatIndex });
queueResponse({ canceled: false, formValues: ["拠点"] });
openHub();
await settle(3);
check("カテゴリーを作成した", hubPlayer.lastActionBar?.translate, "wr.msg.category.created");
check(
  "カテゴリーが動的プロパティに残る",
  world.getDynamicPropertyIds().includes("wr:cat|拠点"),
  true
);

// GAMMA を「拠点」に移す
const moveIndex = await buttonIndex(openHub, "wr.ui.hub.move");
resetForms();
queueResponse({ canceled: false, selection: moveIndex });
openHub();
await settle(2);
// 応答を積んでいないのでモーダルはキャンセル扱いになり、そのあとメニューが開き直る。
// 末尾ではなく「最初のモーダル」を見ること。
const moveForm = shownForms.find((f) => f.kind === "modal");
const gammaAt = moveForm?.fields?.[0]?.options?.indexOf("GAMMA") ?? -1;
const catAt = moveForm?.fields?.[1]?.options?.indexOf("拠点") ?? -1;
check("振り分けフォームにチャンネル一覧が出る", gammaAt >= 0, true);
check("移動先の先頭はデフォルト", moveForm?.fields?.[1]?.options?.[0], "— デフォルト —");

resetForms();
queueResponse({ canceled: false, selection: moveIndex });
queueResponse({ canceled: false, formValues: [gammaAt, catAt] });
openHub();
await settle(3);
check("チャンネルを移した", hubPlayer.lastActionBar?.translate, "wr.msg.category.moved");

// パスワードのテストで使う専用チャンネルを 1 本作っておく
dim.place(at(74, 30, 0), "wr:transmitter");
world.afterEvents.playerPlaceBlock.emit({
  player: fakePlayer("secret-place", "SECRET"),
  block: dim.getBlock(at(74, 30, 0)),
  dimension: dim,
});

// 選択UIでは「拠点」がフォルダとして並ぶ。
// 現在のチャンネル（ここでは GAMMA）はカテゴリーに入れても一枚目に固定される。
resetForms();
queueResponse({ canceled: true });
openTx();
await settle(2);
const topButtons = shownForms[0]?.buttons ?? [];
check(
  "一枚目にカテゴリーのフォルダが並ぶ",
  topButtons.some((b) => b.text?.translate === "wr.ui.category.entry"),
  true
);
check(
  "現在のチャンネルはカテゴリーに入れても先頭に出る",
  topButtons[0]?.text,
  "GAMMA"
);

// 現在のチャンネル以外は、カテゴリーに入れると一枚目から消える
setChannelCategory("SECRET", "拠点");
resetForms();
queueResponse({ canceled: true });
openTx();
await settle(2);
check(
  "振り分けたチャンネルは一枚目から消える",
  (shownForms[0]?.buttons ?? []).some((b) => b.text === "SECRET"),
  false
);
setChannelCategory("SECRET", "");

// フォルダを開くと中に GAMMA がいる
const folderIndex = topButtons.findIndex((b) => b.text?.translate === "wr.ui.category.entry");
resetForms();
queueResponse({ canceled: false, selection: folderIndex });
queueResponse({ canceled: true });
openTx();
await settle(2);
check(
  "フォルダの中にチャンネルがある",
  (shownForms[1]?.buttons ?? []).some((b) => b.text === "GAMMA"),
  true
);
check("フォルダ画面には戻るボタンがある",
  shownForms[1]?.buttons?.at(-1)?.text?.translate, "wr.ui.category.back");

section("パスワード: 設定すると一覧から消え、入力すると出てくる");
const pwIndex = await buttonIndex(openHub, "wr.ui.hub.password");
resetForms();
queueResponse({ canceled: false, selection: pwIndex });
openHub();
await settle(2);
const pwChannels = shownForms.find((f) => f.kind === "modal")?.fields?.[0]?.options ?? [];
const secretAt = pwChannels.indexOf("SECRET");
check("パスワード設定の対象にチャンネルが並ぶ", secretAt >= 0, true);

resetForms();
queueResponse({ canceled: false, selection: pwIndex });
queueResponse({ canceled: false, formValues: [secretAt, "himitsu"] });
openHub();
await settle(3);
check("パスワードを設定した", hubPlayer.lastActionBar?.translate, "wr.msg.password.set");
check(
  "パスワードが動的プロパティに残る",
  world.getDynamicProperty("wr:chpw|SECRET"),
  "himitsu"
);

// 設定した本人はそのまま見える（締め出されない）
resetForms();
queueResponse({ canceled: true });
blockComponents.get("wr:channel_hub").onPlayerInteract({
  block: dim.getBlock(at(80, 30, 0)),
  player: hubPlayer,
});
await settle(2);
check("設定した本人は自動で解錠される", hubPlayer.getDynamicProperty("wr:unlock|SECRET"), true);

// 別のプレイヤーからは見えない
const lockedPlayer = fakePlayer("locked", undefined);
const openLocked = () =>
  blockComponents.get("wr:transmitter").onPlayerInteract({
    block: dim.getBlock(at(70, 30, 2)),
    player: lockedPlayer,
  });
dim.place(at(70, 30, 2), "wr:transmitter");
resetForms();
queueResponse({ canceled: true });
openLocked();
await settle(2);
check(
  "未解錠のプレイヤーには出ない",
  (shownForms[0]?.buttons ?? []).some((b) => b.text === "SECRET"),
  false
);

// 間違ったパスワードでは開かない
const unlockIndex = await buttonIndex(openLocked, "wr.ui.channel.unlock");
resetForms();
queueResponse({ canceled: false, selection: unlockIndex });
queueResponse({ canceled: false, formValues: ["chigau"] });
openLocked();
await settle(3);
check("違うパスワードは弾かれる", lockedPlayer.lastActionBar?.translate, "wr.msg.unlock.ng");

// 正しいパスワードを入れると解錠され、一覧に出てくる
resetForms();
queueResponse({ canceled: false, selection: unlockIndex });
queueResponse({ canceled: false, formValues: ["himitsu"] });
queueResponse({ canceled: true }); // 解錠後に開き直る一覧
openLocked();
await settle(3);
check("正しいパスワードで解錠", lockedPlayer.lastActionBar?.translate, "wr.msg.unlock.ok");
check("解錠がプレイヤーに記録される", lockedPlayer.getDynamicProperty("wr:unlock|SECRET"), true);
check(
  "解錠後は一覧に出る",
  (shownForms.at(-1)?.buttons ?? []).some((b) => b.text === "SECRET"),
  true
);

section("パスワード: 名前を変えても引き継がれる");
addPlayer(lockedPlayer); // オンラインの人の解錠は付け替えられる
const renamed = renameChannel("SECRET", "SECRET2");
check("送信機も付け替わる", renamed.transmitters, 1);
check("パスワードが移る", world.getDynamicProperty("wr:chpw|SECRET2"), "himitsu");
check("旧名のパスワードは消える", world.getDynamicProperty("wr:chpw|SECRET"), undefined);
check("解錠済みの人は解錠のまま", lockedPlayer.getDynamicProperty("wr:unlock|SECRET2"), true);

section("カテゴリー: 消しても中のチャンネルは残る");
check("移動前のカテゴリー", categoryOf("GAMMA"), "拠点");
deleteCategory("拠点");
check("カテゴリーが消えた", listCategories().length, 0);
check("チャンネルはデフォルトに戻る", categoryOf("GAMMA"), "");
check("チャンネル自体は残っている", listChannels().includes("GAMMA"), true);

// ---- 光源 -------------------------------------------------------------------

section("E-1 調光ランプ: 受電値がそのまま明るさになる");
// 定数電源 → ワイヤー2本 → ランプ と並べる。
// 電源から wr: ブロックへは減衰なしで伝わり、ワイヤー同士は 1 マスごとに 1 減衰する。
// ランプはその「今そのマスに来ている強さ」をそのまま明るさにする。
for (const x of [200, 201, 202]) dim.place(at(x, 0, 0), "minecraft:stone");
dim.place(at(200, 1, 0), "wr:constant", { "wr:power": 9 });
const wireNear = at(201, 1, 0);
const wireFar = at(202, 1, 0);
for (const loc of [wireNear, wireFar]) {
  dim.place(loc, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
}
const lampLoc = at(203, 1, 0);
dim.place(lampLoc, "wr:lamp", { "wr:light": 0, "wr:color": 0 });
pump([wireNear, wireFar, lampLoc], 8);
check("電源の隣のワイヤーは減衰なしの 9", stateOf(wireNear, "wr:power"), 9);
check("その次のワイヤーは 8", stateOf(wireFar, "wr:power"), 8);
check("ランプの明るさも 8", stateOf(lampLoc, "wr:light"), 8);

// 電源を弱めれば明るさも追従する（バニラのランプと違い ON/OFF ではない）
dim.getBlock(at(200, 1, 0)).setPermutation(
  dim.getBlock(at(200, 1, 0)).permutation.withState("wr:power", 3)
);
pump([wireNear, wireFar, lampLoc], 8);
check("電源を 3 に落とすと明るさ 2", stateOf(lampLoc, "wr:light"), 2);

section("E-1 調光ランプ: 電力を出力し返さない（ワイヤーが消えなくなる事故の防止）");
// ランプが wr:power を持っていると powerFrom() が「出力」として読んでしまい、
// 自分で点けたランプから電力を読み返してワイヤーが永久に点いたままになる。
// 明るさを wr:light に持たせているので、ランプは電源には見えない。
dim.getBlock(at(200, 1, 0)).setType("minecraft:air");
pump([wireNear, wireFar, lampLoc], 12);
check("電源を外すとワイヤーは 0", stateOf(wireFar, "wr:power"), 0);
check("ランプも消える", stateOf(lampLoc, "wr:light"), 0);

section("E-1 調光ランプ: 染料で色が変わる");
const lampPlayer = fakePlayer("lamp", undefined, "minecraft:lime_dye");
lampPlayer.setHeld(new ItemStack("minecraft:lime_dye", 2));
blockComponents.get("wr:lamp").onPlayerInteract({
  block: dim.getBlock(lampLoc),
  player: lampPlayer,
});
check("ライム(6) に染まった", stateOf(lampLoc, "wr:color"), 6);

section("E-2 発光ブロック: 置くと明るさ 15、右クリックで変えられる");
const glowLoc = at(210, 1, 0);
dim.place(glowLoc, "wr:glow_block", { "wr:light": 0, "wr:color": 0 });
blockComponents.get("wr:glow_block").onPlace({ block: dim.getBlock(glowLoc) });
advanceTicks(2);
check("設置直後は 15", stateOf(glowLoc, "wr:light"), 15);

// スニーク + 右クリックは +1 の微調整。15 の次は 0 に戻る。
const glowPlayer = fakePlayer("glow", undefined, "minecraft:stick");
glowPlayer.setHeld(new ItemStack("minecraft:stick", 1));
glowPlayer.isSneaking = true;
blockComponents.get("wr:glow_block").onPlayerInteract({
  block: dim.getBlock(glowLoc),
  player: glowPlayer,
});
check("15 の次は 0", stateOf(glowLoc, "wr:light"), 0);
blockComponents.get("wr:glow_block").onPlayerInteract({
  block: dim.getBlock(glowLoc),
  player: glowPlayer,
});
check("さらに押すと 1", stateOf(glowLoc, "wr:light"), 1);

// 染料を持っているときは色が優先される（明るさは変わらない）
glowPlayer.setHeld(new ItemStack("minecraft:purple_dye", 1));
blockComponents.get("wr:glow_block").onPlayerInteract({
  block: dim.getBlock(glowLoc),
  player: glowPlayer,
});
check("パープル(11) に染まった", stateOf(glowLoc, "wr:color"), 11);
check("明るさは変わらない", stateOf(glowLoc, "wr:light"), 1);

section("E-3 隠し光源パネル: 支持面に吸着し、支えが消えても落ちない");
dim.place(at(220, 1, -1), "minecraft:stone"); // 北側の壁
const panelLoc = at(220, 1, 0);
// ワイヤーと同じ症状（別のものをクリックして block_face が up になる）を再現
dim.place(panelLoc, "wr:light_panel", { "minecraft:block_face": "up", "wr:light": 0 });
blockComponents.get("wr:light_panel").onPlace({ block: dim.getBlock(panelLoc) });
advanceTicks(2);
check("壁に貼り直される", stateOf(panelLoc, "minecraft:block_face"), "south");
check("設置直後の明るさは 15", stateOf(panelLoc, "wr:light"), 15);

dim.getBlock(at(220, 1, -1)).setType("minecraft:air"); // 支えを壊す
pump([panelLoc], 3);
check("支えが無くなっても落ちない", dim.getBlock(panelLoc).typeId, "wr:light_panel");

section("E-3 隠し光源パネル: 1px の板なのでワイヤーの支えにならない");
dim.place(at(230, 0, 0), "minecraft:stone");
dim.place(at(230, 1, 0), "wr:light_panel", { "minecraft:block_face": "up", "wr:light": 15 });
dim.place(at(230, 2, 0), "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
pump([at(230, 2, 0)], 3);
check("パネルの上のワイヤーは落ちる", dim.getBlock(at(230, 2, 0)).typeId, "minecraft:air");

section("ワイヤーの発光モード: グロウストーンダストでトグルする");
const glowWireLoc = at(240, 1, 0);
dim.place(at(240, 0, 0), "minecraft:stone");
dim.place(glowWireLoc, "wr:wire", {
  "minecraft:block_face": "up",
  "wr:power": 0,
  "wr:color": 0,
  "wr:glow": false,
});
const glowWirePlayer = fakePlayer("glowwire", undefined, "minecraft:glowstone_dust");
glowWirePlayer.setHeld(new ItemStack("minecraft:glowstone_dust", 4));
const wireComp = blockComponents.get("wr:wire");
wireComp.onPlayerInteract({ block: dim.getBlock(glowWireLoc), player: glowWirePlayer });
check("発光モードが入る", stateOf(glowWireLoc, "wr:glow"), true);
check("色は変わらない", stateOf(glowWireLoc, "wr:color"), 0);
wireComp.onPlayerInteract({ block: dim.getBlock(glowWireLoc), player: glowWirePlayer });
check("もう一度で戻る", stateOf(glowWireLoc, "wr:glow"), false);

// ---- 算術回路 ---------------------------------------------------------------

section("即時リピーター: 減衰した信号を 15 に立て直し、逆流させない");
// 背面 = south（前面 north の裏）に弱い入力、前面に 15 が出ること。
const instLoc = at(290, 5, 0);
dim.place(instLoc, "wr:instant_repeater", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
});
dim.place(at(290, 5, 1), "minecraft:redstone_wire", {}, 3); // 背面に弱い信号
pump([instLoc], 3);
check("入力 3 でも出力は 15（増幅）", stateOf(instLoc, "wr:on"), true);

// 副入力（右側面）は見ない ＝ 逆流しない
dim.place(at(290, 5, 1), "minecraft:redstone_wire", {}, 0);
dim.place(at(291, 5, 0), "minecraft:redstone_block", {}, 15); // 右側面
pump([instLoc], 3);
check("背面以外からは反応しない", stateOf(instLoc, "wr:on"), false);
dim.getBlock(at(291, 5, 0)).setType("minecraft:air");

// 遅延はこのアドオンの最小（1 tick）。可変リピーターの最小 2 tick より速い。
dim.place(at(290, 5, 1), "minecraft:redstone_wire", {}, 15);
const instComp = blockComponents.get("wr:instant_repeater");
instComp.onTick({ block: dim.getBlock(instLoc) });
advanceTicks(1);
check("1 tick で出力が立ち上がる", stateOf(instLoc, "wr:on"), true);

section("加算回路 / 減算回路");
// 論理回路と同じ向きの決まり（背面 = 主入力、右側面 = 副入力、前面 = 出力）。
// 前面を north にすると主入力は south、副入力は east。
const addLoc = at(300, 5, 0);
dim.place(addLoc, "wr:adder", { "minecraft:cardinal_direction": "north", "wr:power": 0 });
dim.place(at(300, 5, 1), "minecraft:redstone_wire", {}, 9); // 背面
dim.place(at(301, 5, 0), "minecraft:redstone_wire", {}, 4); // 右側面
pump([addLoc], 3);
check("9 + 4 = 13", stateOf(addLoc, "wr:power"), 13);

// 15 で頭打ちになる（飽和加算）
dim.place(at(300, 5, 1), "minecraft:redstone_wire", {}, 12);
pump([addLoc], 3);
check("12 + 4 は 15 で頭打ち", stateOf(addLoc, "wr:power"), 15);

const subLoc = at(310, 5, 0);
dim.place(subLoc, "wr:subtractor", { "minecraft:cardinal_direction": "north", "wr:power": 0 });
dim.place(at(310, 5, 1), "minecraft:redstone_wire", {}, 11); // 背面
dim.place(at(311, 5, 0), "minecraft:redstone_wire", {}, 4); // 右側面
pump([subLoc], 3);
check("11 - 4 = 7", stateOf(subLoc, "wr:power"), 7);

// 0 で下げ止まる
dim.place(at(311, 5, 0), "minecraft:redstone_wire", {}, 15);
pump([subLoc], 3);
check("11 - 15 は 0 で止まる", stateOf(subLoc, "wr:power"), 0);

// ---- カウンター -------------------------------------------------------------

section("カウンター: 立ち上がりごとに +1、リセットで 0");
const cntLoc = at(320, 5, 0);
dim.place(cntLoc, "wr:counter", {
  "minecraft:cardinal_direction": "north",
  "wr:power": 0,
  "wr:armed": true,
});
const pulseCounter = (times) => {
  for (let i = 0; i < times; i += 1) {
    dim.place(at(320, 5, 1), "minecraft:redstone_wire", {}, 15); // 背面 ON
    pump([cntLoc], 3);
    dim.place(at(320, 5, 1), "minecraft:redstone_wire", {}, 0); // 背面 OFF
    pump([cntLoc], 3);
  }
};
pulseCounter(3);
check("3 回押すと 3", stateOf(cntLoc, "wr:power"), 3);

// 入力を入れっぱなしにしても 1 回しか数えない
dim.place(at(320, 5, 1), "minecraft:redstone_wire", {}, 15);
pump([cntLoc], 12);
check("押しっぱなしでは 1 回だけ数える", stateOf(cntLoc, "wr:power"), 4);
dim.place(at(320, 5, 1), "minecraft:redstone_wire", {}, 0);
pump([cntLoc], 3);

// 15 の次は 0 に戻る
dim.getBlock(cntLoc).setPermutation(dim.getBlock(cntLoc).permutation.withState("wr:power", 15));
pulseCounter(1);
check("15 の次は 0 に戻る", stateOf(cntLoc, "wr:power"), 0);

// 右側面のリセット入力
pulseCounter(5);
check("5 回押して 5", stateOf(cntLoc, "wr:power"), 5);
dim.place(at(321, 5, 0), "minecraft:redstone_wire", {}, 15); // 右側面 = リセット
pump([cntLoc], 3);
check("リセットで 0", stateOf(cntLoc, "wr:power"), 0);
// リセット中はカウントを受け付けない
dim.place(at(320, 5, 1), "minecraft:redstone_wire", {}, 15);
pump([cntLoc], 6);
check("リセット中は数えない", stateOf(cntLoc, "wr:power"), 0);
dim.place(at(321, 5, 0), "minecraft:redstone_wire", {}, 0);
dim.place(at(320, 5, 1), "minecraft:redstone_wire", {}, 0);
pump([cntLoc], 3);

// ---- 数値表示ブロック -------------------------------------------------------

section("数値表示ブロック: 受電値をそのまま表示する");
const dispLoc = at(330, 5, 0);
dim.place(dispLoc, "wr:display", { "wr:value": 0 });
dim.place(at(330, 5, 1), "wr:constant", { "wr:power": 12 });
pump([dispLoc], 4);
check("12 を表示", stateOf(dispLoc, "wr:value"), 12);

// 表示ブロックは電力を出さない（wr:power を持たせると隣のワイヤーが読み返す）
dim.place(at(329, 4, 0), "minecraft:stone");
const dispWire = at(329, 5, 0);
dim.place(dispWire, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0 });
pump([dispWire, dispLoc], 6);
check("隣のワイヤーは表示ブロックから電力を受け取らない", stateOf(dispWire, "wr:power"), 0);

dim.getBlock(at(330, 5, 1)).setType("minecraft:air");
pump([dispLoc], 6);
check("入力を外すと 0 に戻る", stateOf(dispLoc, "wr:value"), 0);

// ---- センサー ---------------------------------------------------------------

section("F-1 エンティティセンサー: 半径内の数を電力にする");
const sensorLoc = at(340, 5, 0);
dim.place(sensorLoc, "wr:entity_sensor", { "wr:power": 0, "wr:radius": 4, "wr:mode": 0 });
// 半径 4 の内側に 3 体、外側に 1 体
dim.entities = [
  { typeId: "minecraft:cow", location: { x: 341, y: 5, z: 0 } },
  { typeId: "minecraft:player", location: { x: 342, y: 5, z: 0 } },
  { typeId: "minecraft:item", location: { x: 340, y: 5, z: 2 } },
  // 半径 4 の外・半径 8 の内（中心は 340.5 なので距離 5.5）
  { typeId: "minecraft:cow", location: { x: 346, y: 5, z: 0 } },
];
pump([sensorLoc], 3);
check("半径 4 の中の 3 体を数える", stateOf(sensorLoc, "wr:power"), 3);

// 検知対象の切り替え（スニーク + 右クリック）
const sensorPlayer = fakePlayer("sensor", undefined, "minecraft:stick");
sensorPlayer.isSneaking = true;
const sensorComp = blockComponents.get("wr:entity_sensor");
sensorComp.onPlayerInteract({ block: dim.getBlock(sensorLoc), player: sensorPlayer });
check("モードが プレイヤー(1) に進む", stateOf(sensorLoc, "wr:mode"), 1);
pump([sensorLoc], 3);
check("プレイヤーだけ数えると 1", stateOf(sensorLoc, "wr:power"), 1);

sensorComp.onPlayerInteract({ block: dim.getBlock(sensorLoc), player: sensorPlayer });
check("モードが モブ(2) に進む", stateOf(sensorLoc, "wr:mode"), 2);
pump([sensorLoc], 3);
check("モブだけ数えると 1（牛のみ・アイテムとプレイヤーは除外）", stateOf(sensorLoc, "wr:power"), 1);

sensorComp.onPlayerInteract({ block: dim.getBlock(sensorLoc), player: sensorPlayer });
check("モードが アイテム(3) に進む", stateOf(sensorLoc, "wr:mode"), 3);
pump([sensorLoc], 3);
check("アイテムだけ数えると 1", stateOf(sensorLoc, "wr:power"), 1);

sensorComp.onPlayerInteract({ block: dim.getBlock(sensorLoc), player: sensorPlayer });
check("3 の次は 指定プレイヤー(4)", stateOf(sensorLoc, "wr:mode"), 4);
pump([sensorLoc], 3);
check("名前が未設定なら誰も検知しない", stateOf(sensorLoc, "wr:power"), 0);

// 名前を設定すればその人だけ数える
resetForms();
queueResponse({ canceled: false, formValues: ["Steve", 4] });
sensorPlayer.isSneaking = false;
sensorComp.onPlayerInteract({ block: dim.getBlock(sensorLoc), player: sensorPlayer });
await settle(3);
dim.entities = [
  { typeId: "minecraft:player", name: "Steve", location: { x: 341, y: 5, z: 0 } },
  { typeId: "minecraft:player", name: "Alex", location: { x: 342, y: 5, z: 0 } },
];
pump([sensorLoc], 3);
check("指定した名前の人だけ数える", stateOf(sensorLoc, "wr:power"), 1);

// 座標キーの動的プロパティなので、爆破でも消えないと次に置いた人が名前を引き継ぐ
world.afterEvents.blockExplode.emit({
  block: dim.getBlock(sensorLoc),
  dimension: dim,
  explodedBlockPermutation: { type: { id: "wr:entity_sensor" } },
});
await settle(1);
pump([sensorLoc], 3);
check("爆発で指定名がリセットされ、また誰も検知しない", stateOf(sensorLoc, "wr:power"), 0);

sensorPlayer.isSneaking = true;
sensorComp.onPlayerInteract({ block: dim.getBlock(sensorLoc), player: sensorPlayer });
check("4 の次は すべて(0) に戻る", stateOf(sensorLoc, "wr:mode"), 0);
sensorPlayer.isSneaking = false;

// 半径を広げると半径外の 1 体も入る
dim.entities = [
  { typeId: "minecraft:cow", location: { x: 341, y: 5, z: 0 } },
  { typeId: "minecraft:player", location: { x: 342, y: 5, z: 0 } },
  { typeId: "minecraft:item", location: { x: 340, y: 5, z: 2 } },
  { typeId: "minecraft:cow", location: { x: 346, y: 5, z: 0 } },
];
dim.getBlock(sensorLoc).setPermutation(
  dim.getBlock(sensorLoc).permutation.withState("wr:radius", 8)
);
pump([sensorLoc], 3);
check("半径 8 なら 4 体", stateOf(sensorLoc, "wr:power"), 4);
dim.entities = [];

section("F-2 時刻センサー: 正午が最大・真夜中が最小");
const { powerForTime } = await import("./scripts/sensors.js");
check("正午(6000) は 15", powerForTime(6000, false), 15);
check("真夜中(18000) は 0", powerForTime(18000, false), 0);
check("日の出(0) は中間の 8", powerForTime(0, false), 8);
check("夜モードでは反転する（正午 0）", powerForTime(6000, true), 0);
check("夜モードの真夜中は 15", powerForTime(18000, true), 15);

const dayLoc = at(350, 5, 0);
dim.place(dayLoc, "wr:daylight_sensor", { "wr:power": 0, "wr:night": false });
world.setTimeOfDay(6000);
pump([dayLoc], 3);
check("正午に置くと 15 を出す", stateOf(dayLoc, "wr:power"), 15);

// 右クリックで昼夜反転
blockComponents.get("wr:daylight_sensor").onPlayerInteract({
  block: dim.getBlock(dayLoc),
  player: fakePlayer("day", undefined, "minecraft:stick"),
});
check("夜モードに切り替わる", stateOf(dayLoc, "wr:night"), true);
pump([dayLoc], 3);
check("夜モードの正午は 0", stateOf(dayLoc, "wr:power"), 0);

world.setTimeOfDay(18000);
pump([dayLoc], 3);
check("真夜中に進めると 15", stateOf(dayLoc, "wr:power"), 15);
world.setTimeOfDay(6000);

// ---- 施錠 -------------------------------------------------------------------

const {
  issueKey,
  setKeyRevoked,
  isKeyValid,
  listKeys,
  setLockKeys,
  setLockPassword,
  lockKeysOf,
  sanitizeKeyId,
  deleteKey: deleteKeyForTest,
} = await import("./scripts/security.js");

section("H-1 施錠ブロック: 正しいカードキーで開き、時間で閉じる");
const lockLoc = at(360, 5, 0);
dim.place(lockLoc, "wr:lock", { "wr:on": false, "wr:remain": 0, "wr:seconds": 3 });
const lockBlock = dim.getBlock(lockLoc);
issueKey("GATE1");
setLockKeys(lockBlock, "GATE1");
check("鍵IDが記録される", lockKeysOf(dim.getBlock(lockLoc)).join(","), "GATE1");

const keyPlayer = fakePlayer("key", undefined, "wr:card_key");
const lockComp = blockComponents.get("wr:lock");
const card = new ItemStack("wr:card_key");
card.nameTag = "GATE1";
keyPlayer.setHeld(card);
lockComp.onPlayerInteract({ block: dim.getBlock(lockLoc), player: keyPlayer });
check("正しいカードで開く", stateOf(lockLoc, "wr:on"), true);
check("残り時間が設定値になる", stateOf(lockLoc, "wr:remain"), 3);

// 1 秒（20 tick）ごとの onTick で減っていく
const tickLock = () => {
  lockComp.onTick({ block: dim.getBlock(lockLoc) });
  advanceTicks(1);
};
tickLock();
check("1 回目の tick で 2 に減る", stateOf(lockLoc, "wr:remain"), 2);
tickLock();
tickLock();
check("0 になったら閉じる", stateOf(lockLoc, "wr:remain"), 0);
check("出力も切れる", stateOf(lockLoc, "wr:on"), false);

section("H-1 施錠ブロック: 合鍵・失効カードは通さない");
// 金床で名前を変えただけのカード（発行記録が無い）
const fake = new ItemStack("wr:card_key");
fake.nameTag = "GATE9";
keyPlayer.setHeld(fake);
lockComp.onPlayerInteract({ block: dim.getBlock(lockLoc), player: keyPlayer });
check("鍵IDが違えば開かない", stateOf(lockLoc, "wr:on"), false);
check("拒否メッセージが出る", keyPlayer.lastActionBar?.translate, "wr.msg.lock.denied");

// 鍵IDは合っているが発行記録が無い場合
setLockKeys(dim.getBlock(lockLoc),"GATE9");
lockComp.onPlayerInteract({ block: dim.getBlock(lockLoc), player: keyPlayer });
check("発行されていない鍵IDでは開かない", stateOf(lockLoc, "wr:on"), false);
check("未発行の案内が出る", keyPlayer.lastActionBar?.translate, "wr.msg.lock.unknown");

// 失効させたカード
setLockKeys(dim.getBlock(lockLoc),"GATE1");
keyPlayer.setHeld(card);
setKeyRevoked("GATE1", true);
lockComp.onPlayerInteract({ block: dim.getBlock(lockLoc), player: keyPlayer });
check("失効したカードでは開かない", stateOf(lockLoc, "wr:on"), false);
check("失効の案内が出る", keyPlayer.lastActionBar?.translate, "wr.msg.lock.revoked");

// 戻せば開く
setKeyRevoked("GATE1", false);
lockComp.onPlayerInteract({ block: dim.getBlock(lockLoc), player: keyPlayer });
check("有効に戻すと開く", stateOf(lockLoc, "wr:on"), true);

section("H-1 施錠ブロック: リロードしても開きっぱなしにならない");
// 残り時間はブロックステートに持っているので、tick が来れば続きから閉まる。
// （system.runTimeout だとワールドをまたいだ時点でタイマーが消えて開いたままになる）
check("開いている", stateOf(lockLoc, "wr:on"), true);
for (let i = 0; i < 5; i += 1) tickLock();
check("放置すれば必ず閉じる", stateOf(lockLoc, "wr:on"), false);

section("H-1 施錠ブロック: 1 つのロックに複数の鍵IDを登録できる");
const multiLoc = at(370, 5, 0);
dim.place(multiLoc, "wr:lock", { "wr:on": false, "wr:remain": 0, "wr:seconds": 2 });
for (const id of ["ADMIN", "STAFF"]) issueKey(id);
const saved = setLockKeys(dim.getBlock(multiLoc), " ADMIN , STAFF , ADMIN ,, ");
check("重複と空白を畳んで 2 件", saved.join(","), "ADMIN,STAFF");

const multiPlayer = fakePlayer("multi", undefined, "wr:card_key");
const useCard = (id) => {
  const c = new ItemStack("wr:card_key");
  c.nameTag = id;
  multiPlayer.setHeld(c);
  // 前回の解錠が残っていると判定できないので閉じてから試す
  applyLockClosed(multiLoc);
  lockComp.onPlayerInteract({ block: dim.getBlock(multiLoc), player: multiPlayer });
  return stateOf(multiLoc, "wr:on");
};
function applyLockClosed(loc) {
  const b = dim.getBlock(loc);
  b.setPermutation(b.permutation.withState("wr:on", false).withState("wr:remain", 0));
}
check("1 つ目の鍵で開く", useCard("ADMIN"), true);
check("2 つ目の鍵でも開く", useCard("STAFF"), true);
check("登録していない鍵では開かない", useCard("GUEST"), false);

// 片方だけ失効させても、もう片方は開く
setKeyRevoked("ADMIN", true);
check("失効させた方は開かない", useCard("ADMIN"), false);
check("もう片方はそのまま開く", useCard("STAFF"), true);
setKeyRevoked("ADMIN", false);

// 上限を超えたぶんは切り捨てる
const many = setLockKeys(dim.getBlock(multiLoc), "A,B,C,D,E,F,G,H,I,J");
check("上限 8 件で打ち切る", many.length, 8);
// 鍵IDにカンマは入れられない（区切りが壊れるため）
check("鍵IDのカンマは潰される", sanitizeKeyId("A,B"), "A_B");
setLockKeys(dim.getBlock(multiLoc), "ADMIN,STAFF");

section("H-1 施錠ブロック: カードをかざして登録／解除できる");
// 設定画面を開いて鍵IDを打ち直さずに済ませるための近道。
const tapLoc = at(375, 5, 0);
dim.place(tapLoc, "wr:lock", { "wr:on": false, "wr:remain": 0, "wr:seconds": 2 });
issueKey("TAP");
const tapPlayer = fakePlayer("tap", undefined, "wr:card_key");
const tapCard = new ItemStack("wr:card_key");
tapCard.nameTag = "TAP";
tapPlayer.setHeld(tapCard);

tapPlayer.isSneaking = true;
lockComp.onPlayerInteract({ block: dim.getBlock(tapLoc), player: tapPlayer });
check("かざすと登録される", lockKeysOf(dim.getBlock(tapLoc)).join(","), "TAP");
check("登録のメッセージが出る", tapPlayer.lastActionBar?.translate, "wr.msg.lock.keyadded");

lockComp.onPlayerInteract({ block: dim.getBlock(tapLoc), player: tapPlayer });
check("もう一度かざすと外れる", lockKeysOf(dim.getBlock(tapLoc)).length, 0);
check("解除のメッセージが出る", tapPlayer.lastActionBar?.translate, "wr.msg.lock.keyremoved");

// 登録したら実際に開くこと（スニークを外して普通に使う）
lockComp.onPlayerInteract({ block: dim.getBlock(tapLoc), player: tapPlayer });
tapPlayer.isSneaking = false;
lockComp.onPlayerInteract({ block: dim.getBlock(tapLoc), player: tapPlayer });
check("登録した鍵で開く", stateOf(tapLoc, "wr:on"), true);

section("H-2 再発行パスワード: 設定した鍵は正しい入力でしか複製できない");
const { setKeyPassword, canReissue, hasKeyPassword, isKeyIssued } =
  await import("./scripts/security.js");
issueKey("VAULT");
setKeyPassword("VAULT", "hi-mi-tsu");
check("パスワード付きとして扱われる", hasKeyPassword("VAULT"), true);
check("正しいパスワードなら再発行できる", canReissue("VAULT", "hi-mi-tsu"), true);
check("間違っていれば再発行できない", canReissue("VAULT", "zenzen"), false);
check("空欄でも再発行できない", canReissue("VAULT", ""), false);

// パスワードを付けていない鍵は誰でも複製できる（従来どおり）
issueKey("FREE");
check("パスワード無しなら誰でも複製できる", canReissue("FREE", ""), true);

// 未発行のIDは新規なので常に通る
check("未発行のIDは新規扱い", canReissue("NOBODY", ""), true);
check("発行済み判定", isKeyIssued("VAULT"), true);

// 記録ごと消すとパスワードも消える（消し残しで復活したIDに古い鍵が付かないように）
deleteKeyForTest("VAULT");
check("削除するとパスワードも消える", hasKeyPassword("VAULT"), false);
issueKey("VAULT");
setKeyPassword("VAULT", "hi-mi-tsu");

section("H-2 カードキー発行機: 発行するとカードが手に入る");
resetForms();
const issuePlayer = addPlayer(fakePlayer("issue", undefined, "minecraft:stick"));
queueResponse({ canceled: false, formValues: ["LOBBY"] });
itemComponentsTerminalIssue();
function itemComponentsTerminalIssue() {
  blockComponents
    .get("wr:key_terminal")
    .onPlayerInteract({ block: dim.getBlock(at(380, 5, 0)), player: issuePlayer });
}
await settle(3);
// メニュー → 発行 の 2 段なので、1 枚目のボタンを選ぶ応答も要る
resetForms();
queueResponse({ canceled: false, selection: 0 }); // メニューの「発行して受け取る」
queueResponse({ canceled: false, formValues: ["LOBBY"] }); // 鍵ID
queueResponse({ canceled: true }); // 戻ったメニューを閉じる
itemComponentsTerminalIssue();
await settle(4);
const givenCards = [];
for (let i = 0; i < issuePlayer.inventory.size + 4; i += 1) {
  const item = issuePlayer.inventory.getItem(i);
  if (item?.typeId === "wr:card_key") givenCards.push(item.nameTag);
}
check("カードキーが配られる", givenCards.includes("LOBBY"), true);
check("その鍵IDは有効になる", isKeyValid("LOBBY"), true);

section("H-2 カードキー発行機: 持ち物が満杯なら足元に落とす");
const droppedBefore = dim.spawnedItems.length;
issuePlayer.inventory.full = true;
resetForms();
queueResponse({ canceled: false, selection: 0 });
queueResponse({ canceled: false, formValues: ["OVERFLOW"] });
queueResponse({ canceled: true });
itemComponentsTerminalIssue();
await settle(4);
check("黙って消さずに落とす", dim.spawnedItems.length > droppedBefore, true);
issuePlayer.inventory.full = false;

section("H-2 カードキー発行機: 発行と失効の記録");
issueKey("OFFICE");
check("発行済みに載る", listKeys().includes("OFFICE"), true);
check("有効として扱われる", isKeyValid("OFFICE"), true);
setKeyRevoked("OFFICE", true);
check("失効させると無効になる", isKeyValid("OFFICE"), false);
check("一覧からは消えない（復活できる）", listKeys().includes("OFFICE"), true);

section("H-1 施錠ブロック: パスワードでも開く");
const pwLoc = at(365, 5, 0);
dim.place(pwLoc, "wr:lock", { "wr:on": false, "wr:remain": 0, "wr:seconds": 2 });
setLockPassword(dim.getBlock(pwLoc), "1234");
resetForms();
queueResponse({ canceled: false, formValues: ["9999"] }); // 間違い
const pwPlayer = addPlayer(fakePlayer("pw", undefined, "minecraft:stick"));
pwPlayer.setHeld(new ItemStack("minecraft:stick", 1));
blockComponents.get("wr:lock").onPlayerInteract({ block: dim.getBlock(pwLoc), player: pwPlayer });
await settle(3);
check("間違ったパスワードでは開かない", stateOf(pwLoc, "wr:on"), false);

queueResponse({ canceled: false, formValues: ["1234"] }); // 正解
blockComponents.get("wr:lock").onPlayerInteract({ block: dim.getBlock(pwLoc), player: pwPlayer });
await settle(3);
check("正しいパスワードで開く", stateOf(pwLoc, "wr:on"), true);

// ---- ワンショット / シーケンサー / ランダマイザー / 天候 ---------------------

section("C-5 ワンショット: 立ち上がりで決めた長さだけ出す");
// 前面 north → 背面は south。長さ 12 tick（v1.31.2 からDPで tick を直接指定）
const osLoc = at(430, 5, 0);
dim.place(osLoc, "wr:one_shot", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
  "wr:armed": true,
});
setOneShotLengthDp(osLoc, 12);
const osComp = blockComponents.get("wr:one_shot");
const osRemain = (loc) => timingMod.oneShotRemainOf(DIM, loc);
const pumpOs = () => {
  osComp.onTick({ block: dim.getBlock(osLoc) });
  advanceTicks(1);
};

dim.place(at(430, 5, 1), "minecraft:redstone_wire", {}, 15); // 背面 ON
pumpOs();
check("立ち上がりで出る", stateOf(osLoc, "wr:on"), true);
check("残りが長さぶん入る", osRemain(osLoc), 12);
check(
  "ステートには持っていない",
  Object.keys(blockDefStates("one_shot")).join(","),
  "wr:on,wr:armed"
);

// 入力を入れっぱなしにしても延長されない
pumpOs();
pumpOs();
check("入れっぱなしでも延長しない", osRemain(osLoc), 4);
pumpOs();
check("長さぶんで切れる", stateOf(osLoc, "wr:on"), false);

// 入りっぱなしのままでは撃ち直さない
pumpOs();
pumpOs();
check("入りっぱなしでは二度撃たない", stateOf(osLoc, "wr:on"), false);

// 一度切ってからならまた撃つ
dim.place(at(430, 5, 1), "minecraft:redstone_wire", {}, 0);
pumpOs();
dim.place(at(430, 5, 1), "minecraft:redstone_wire", {}, 15);
pumpOs();
check("切ってからならまた撃つ", stateOf(osLoc, "wr:on"), true);

section("C-5 ワンショット: 長さの範囲拡張とプリセット送り（v1.31.2）");
const { ONE_SHOT_MIN, ONE_SHOT_MAX, ONE_SHOT_PRESETS } = timingMod;
const osPlayer = fakePlayer("oneshot", undefined);
resetForms();
queueResponse({ canceled: false, formValues: [600] });
osComp.onPlayerInteract({ block: dim.getBlock(osLoc), player: osPlayer });
await settle(2);
check(
  `スライダーは ${ONE_SHOT_MIN}〜${ONE_SHOT_MAX} tick`,
  `${shownForms[0]?.fields?.[0]?.min}-${shownForms[0]?.fields?.[0]?.max}`,
  `${ONE_SHOT_MIN}-${ONE_SHOT_MAX}`
);
check("600 tick まで書ける", timingMod.oneShotLengthOf(dim.getBlock(osLoc)), 600);
check("秒換算のメッセージが乗る", osPlayer.lastActionBar?.with?.[1], "30.0");

// スニークはプリセット送り（20→60→100→300→600→1200→20）。範囲が広いので +1 は非現実的
osPlayer.isSneaking = true;
osComp.onPlayerInteract({ block: dim.getBlock(osLoc), player: osPlayer });
check("600 の次のプリセットは 1200", timingMod.oneShotLengthOf(dim.getBlock(osLoc)), 1200);
osComp.onPlayerInteract({ block: dim.getBlock(osLoc), player: osPlayer });
check("1200 の次は先頭の 20 に戻る", timingMod.oneShotLengthOf(dim.getBlock(osLoc)), ONE_SHOT_PRESETS[0]);
osPlayer.isSneaking = false;
setOneShotLengthDp(osLoc, 20); // 次のセクションへ影響しないよう既定へ戻す

section("C-5 ワンショット: 壊す・爆破すると長さ/残りの記録も消える");
setOneShotLengthDp(osLoc, 40);
setOneShotRemainDp(osLoc, 8);
osComp.onPlayerDestroy({ block: dim.getBlock(osLoc), player: osPlayer });
check("破壊で長さの記録が既定に戻る", timingMod.oneShotLengthOf(dim.getBlock(osLoc)), 20);
check("破壊で残りの記録も消える", osRemain(osLoc), 0);

setOneShotLengthDp(osLoc, 40);
world.afterEvents.blockExplode.emit({
  block: dim.getBlock(osLoc),
  dimension: dim,
  explodedBlockPermutation: { type: { id: "wr:one_shot" } },
});
await settle(1);
check("爆発でも消える（onPlayerDestroy は来ない）", timingMod.oneShotLengthOf(dim.getBlock(osLoc)), 20);

section("C-8 クロックディバイダー: divisor 回に 1 回だけ通す");
const cdLoc = at(433, 5, 0);
dim.place(cdLoc, "wr:clock_divider", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
  "wr:armed": true,
});
check(
  "ステートには持っていない",
  Object.keys(blockDefStates("clock_divider")).join(","),
  "wr:on,wr:armed"
);
check("既定の divisor は 4", timingMod.clockDivisorOf(dim.getBlock(cdLoc)), 4);
const cdComp = blockComponents.get("wr:clock_divider");
const pumpCd = () => {
  cdComp.onTick({ block: dim.getBlock(cdLoc) });
  advanceTicks(1);
};

// 1〜3 回目のパルスは通さない
for (let i = 1; i <= 3; i += 1) {
  dim.place(at(433, 5, 1), "minecraft:redstone_wire", {}, 15);
  pumpCd();
  check(`${i} 回目のパルスは通さない`, stateOf(cdLoc, "wr:on"), false);
  dim.place(at(433, 5, 1), "minecraft:redstone_wire", {}, 0);
  pumpCd();
}
// 4 回目だけ通す
dim.place(at(433, 5, 1), "minecraft:redstone_wire", {}, 15);
pumpCd();
check("4 回目は通す", stateOf(cdLoc, "wr:on"), true);
dim.place(at(433, 5, 1), "minecraft:redstone_wire", {}, 0);
pumpCd();
check("入力が切れたら出力も切れる", stateOf(cdLoc, "wr:on"), false);
check("4 回目のあとカウンターが 0 に戻る", timingMod.clockCountOf(DIM, cdLoc), 0);

// 周期が終わればまた 1 回目から数え直す
dim.place(at(433, 5, 1), "minecraft:redstone_wire", {}, 15);
pumpCd();
check("次周期の 1 回目はまた通さない", stateOf(cdLoc, "wr:on"), false);
dim.place(at(433, 5, 1), "minecraft:redstone_wire", {}, 0);
pumpCd();

section("C-8 クロックディバイダー: 設定UI");
const cdPlayer = fakePlayer("clockdiv", undefined);
cdPlayer.isSneaking = true;
cdComp.onPlayerInteract({ block: dim.getBlock(cdLoc), player: cdPlayer });
check("スニーク+右クリックで divisor が 1 上がる", timingMod.clockDivisorOf(dim.getBlock(cdLoc)), 5);
cdPlayer.isSneaking = false;

resetForms();
queueResponse({ canceled: false, formValues: [8] });
cdComp.onPlayerInteract({ block: dim.getBlock(cdLoc), player: cdPlayer });
await settle(2);
check(
  "スライダーの範囲は 1〜16",
  `${shownForms[0]?.fields?.[0]?.min}-${shownForms[0]?.fields?.[0]?.max}`,
  "1-16"
);
check("スライダーで 8 に変更", timingMod.clockDivisorOf(dim.getBlock(cdLoc)), 8);
check("メッセージが出る", cdPlayer.lastActionBar?.translate, "wr.msg.clockdiv.divisor");
check("divisor 変更でカウンターも 0 に戻る", timingMod.clockCountOf(DIM, cdLoc), 0);

section("C-8 クロックディバイダー: 壊す・爆破すると divisor/カウンターの記録も消える");
setClockCntDp(cdLoc, 3);
cdComp.onPlayerDestroy({ block: dim.getBlock(cdLoc), player: cdPlayer });
check("破壊で divisor が既定の 4 に戻る", timingMod.clockDivisorOf(dim.getBlock(cdLoc)), 4);
check("破壊でカウンターも消える", timingMod.clockCountOf(DIM, cdLoc), 0);

setClockDivDp(cdLoc, 9);
setClockCntDp(cdLoc, 2);
world.afterEvents.blockExplode.emit({
  block: dim.getBlock(cdLoc),
  dimension: dim,
  explodedBlockPermutation: { type: { id: "wr:clock_divider" } },
});
await settle(1);
check("爆発でも消える（onPlayerDestroy は来ない）", timingMod.clockDivisorOf(dim.getBlock(cdLoc)), 4);
check("爆発でカウンターも消える", timingMod.clockCountOf(DIM, cdLoc), 0);

section("C-6 シーケンサー: 出力先が 4 方向を回る");
const seqLoc = at(440, 5, 0);
dim.place(seqLoc, "wr:sequencer", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
  "wr:period": 2,
  "wr:remain": 0,
});
const seqComp = blockComponents.get("wr:sequencer");
const pumpSeq = () => {
  seqComp.onTick({ block: dim.getBlock(seqLoc) });
  advanceTicks(1);
};
pumpSeq();
check("north の次は east", stateOf(seqLoc, "minecraft:cardinal_direction"), "east");
check("間隔ぶん待つ", stateOf(seqLoc, "wr:remain"), 2);
pumpSeq();
pumpSeq();
check("待っている間は動かない", stateOf(seqLoc, "minecraft:cardinal_direction"), "east");
pumpSeq();
check("次は south", stateOf(seqLoc, "minecraft:cardinal_direction"), "south");
for (let i = 0; i < 3; i += 1) pumpSeq();
check("その次は west", stateOf(seqLoc, "minecraft:cardinal_direction"), "west");
for (let i = 0; i < 3; i += 1) pumpSeq();
check("一周して north に戻る", stateOf(seqLoc, "minecraft:cardinal_direction"), "north");

// ---- C-6 シーケンサー: 粗いモード（v1.30.0 で上限を 60 → 300 tick に拡張）----
//
// wr:remain は 16 段しか持てないので、間隔の上限は「1 段の重み」でしか伸ばせない。
// 粗いモードでは 5 回に 1 回しか数えず、1 段 = 20 tick になる。
// どの回で数えるかは system.currentTick から決めている（追加のステートを持たない）ので、
// **今が「数える回」かどうか**を tick を合わせて確かめる。

section("C-6 シーケンサー: 粗いモードは 5 回に 1 回しか進まない");
const slowLoc = at(444, 5, 0);
dim.place(slowLoc, "wr:sequencer", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
  "wr:period": 1,
  "wr:remain": 0,
  "wr:slow": true,
});

/** floor(currentTick / 4) % 5 が target になるまで進める。 */
const alignSlot = (target) => {
  while (Math.floor(system.currentTick / 4) % 5 !== target) advanceTicks(1);
};
const tickSlow = () => seqComp.onTick({ block: dim.getBlock(slowLoc) });

// 数えない回では何も起きない
alignSlot(2);
tickSlow();
advanceTicks(1);
check("数えない回は向きが変わらない", stateOf(slowLoc, "minecraft:cardinal_direction"), "north");
check("数えない回は残り時間も動かない", stateOf(slowLoc, "wr:remain"), 0);

// 数える回では進む
alignSlot(0);
tickSlow();
advanceTicks(1);
check("数える回では向きが変わる", stateOf(slowLoc, "minecraft:cardinal_direction"), "east");
check("残り時間が設定ぶん入る", stateOf(slowLoc, "wr:remain"), 1);

// 次の 4 スロット（16 tick ぶん）は素通りし、5 回目でようやく 1 減る
for (let slot = 1; slot <= 4; slot += 1) {
  alignSlot(slot);
  tickSlow();
  advanceTicks(1);
}
check("間の 4 スロットでは減らない", stateOf(slowLoc, "wr:remain"), 1);
alignSlot(0);
tickSlow();
advanceTicks(1);
check("5 回目で 1 減る", stateOf(slowLoc, "wr:remain"), 0);

section("C-6 シーケンサー: 設定UI（1 本のスライダーで 4〜300 tick）");
const seqPlayer = fakePlayer("seq", undefined);
resetForms();
queueResponse({ canceled: false, formValues: [40] });
seqComp.onPlayerInteract({ block: dim.getBlock(seqLoc), player: seqPlayer });
await settle(2);
check(
  "スライダーは 4〜300",
  `${shownForms[0]?.fields?.[0]?.min}-${shownForms[0]?.fields?.[0]?.max}`,
  "4-300"
);
check("40 tick は細かいモードの 10 段", stateOf(seqLoc, "wr:period"), 10);
check("60 tick 以下では粗いモードにならない", stateOf(seqLoc, "wr:slow"), false);

// 60 tick を超えたぶんは自動で粗いモードへ落ちる（クールダウンぶん待つ）
advanceTicks(12);
resetForms();
queueResponse({ canceled: false, formValues: [300] });
seqComp.onPlayerInteract({ block: dim.getBlock(seqLoc), player: seqPlayer });
await settle(2);
check("300 tick で粗いモードになる", stateOf(seqLoc, "wr:slow"), true);
check("300 tick は粗いモードの 15 段", stateOf(seqLoc, "wr:period"), 15);

// 細かい側に戻せること（戻れないと 60 tick 以下が二度と選べなくなる）
advanceTicks(12);
resetForms();
queueResponse({ canceled: false, formValues: [8] });
seqComp.onPlayerInteract({ block: dim.getBlock(seqLoc), player: seqPlayer });
await settle(2);
check("細かいモードに戻せる", stateOf(seqLoc, "wr:slow"), false);
check("8 tick は 2 段", stateOf(seqLoc, "wr:period"), 2);

// ---- C-7 非対称ディレイリピーター -------------------------------------------
//
// 可変ディレイリピーターとの違いは 1 点だけ:
// **立ち上がりと立ち下がりで別の遅延を使う**。
// そこを外すと「両方 rise になっている」「両方 fall になっている」のどちらでも
// 片側のテストだけは通ってしまうので、ON と OFF の両方を測る。

// 遅延 2 本はブロックステートではなくワールド動的プロパティ（v1.30.1）。
// ステートに戻すと 16 x 16 = 256 倍が状態数の予算に乗るので、
// **ステートで置こうとしたら落ちる**ようにここで縛っておく
// （スタブの withState() は宣言されていないステート名で例外を投げる）。
section("C-7 非対称ディレイリピーター: ON と OFF で別々の遅延がかかる");
const asymLoc = at(460, 5, 0);
dim.place(asymLoc, "wr:asym_repeater", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
});
const asymDelays = (loc) => timingMod.asymDelaysOf(dim.getBlock(loc));
setAsymDp(asymLoc, 2, 10); // ON 2 tick / OFF 10 tick
check("動的プロパティから読める", asymDelays(asymLoc).fall, 10);
check(
  "ステートには持っていない",
  Object.keys(blockDefStates("asym_repeater")).join(","),
  "wr:on"
);
const asymComp = blockComponents.get("wr:asym_repeater");
const pumpAsym = () => {
  asymComp.onTick({ block: dim.getBlock(asymLoc) });
  advanceTicks(1); // 共通伝播ロジックの 1 tick 遅延ぶん
};

// 立ち上がり: 2 tick で ON になる
dim.place(at(460, 5, 1), "minecraft:redstone_block", {}, 15); // 背面
pumpAsym();
advanceTicks(1);
check("1 tick ではまだ OFF", stateOf(asymLoc, "wr:on"), false);
advanceTicks(2);
check("2 tick で ON", stateOf(asymLoc, "wr:on"), true);

// 立ち下がり: 同じブロックなのに 10 tick かかる
dim.place(at(460, 5, 1), "minecraft:air", {}, 0);
pumpAsym();
advanceTicks(4);
check("4 tick ではまだ ON のまま", stateOf(asymLoc, "wr:on"), true);
advanceTicks(8);
check("10 tick で OFF", stateOf(asymLoc, "wr:on"), false);

section("C-7 非対称ディレイリピーター: 遅延 0 でも最短 1 tick で動く");
const fastLoc = at(464, 5, 0);
dim.place(fastLoc, "wr:asym_repeater", {
  "minecraft:cardinal_direction": "north",
  "wr:on": false,
});
check("未設定なら 0/0（置いたばかりは最速）", asymDelays(fastLoc).rise, 0);
dim.place(at(464, 5, 1), "minecraft:redstone_block", {}, 15);
asymComp.onTick({ block: dim.getBlock(fastLoc) });
advanceTicks(1); // 共通伝播ロジック
advanceTicks(1); // 遅延 0 tick でも 1 tick は待つ
check("0 tick でも例外なく ON になる", stateOf(fastLoc, "wr:on"), true);

section("C-7 非対称ディレイリピーター: 設定UI");
const asymPlayer = fakePlayer("asym", undefined);
resetForms();
queueResponse({ canceled: false, formValues: [6, 24] });
asymComp.onPlayerInteract({ block: dim.getBlock(asymLoc), player: asymPlayer });
await settle(2);
check("スライダーが 2 本開く", shownForms[0]?.fields?.length, 2);
check(
  "どちらも 0〜600 tick",
  `${shownForms[0]?.fields?.[0]?.min}-${shownForms[0]?.fields?.[1]?.max}`,
  "0-600"
);
check("ON 側にそのまま 6 tick", asymDelays(asymLoc).rise, 6);
check("OFF 側にそのまま 24 tick", asymDelays(asymLoc).fall, 24);

// スニークは入れ替え。他ブロックの「+1」と違うので、ここで固定しておく
asymPlayer.isSneaking = true;
asymComp.onPlayerInteract({ block: dim.getBlock(asymLoc), player: asymPlayer });
check("スニーク+右クリックで ON 側に元の OFF 値が入る", asymDelays(asymLoc).rise, 24);
check("スニーク+右クリックで OFF 側に元の ON 値が入る", asymDelays(asymLoc).fall, 6);
asymPlayer.isSneaking = false;

// 上限を 30 tick → 600 tick に広げたぶん（v1.31.1）が本当に書けること。
// block_ui.js は同じプレイヤーが続けてフォームを開けないよう
// 10 tick のクールダウンを持っているので、そのぶん待ってから開き直す。
advanceTicks(12);
resetForms();
queueResponse({ canceled: false, formValues: [600, 600] });
asymComp.onPlayerInteract({ block: dim.getBlock(asymLoc), player: asymPlayer });
await settle(2);
check("600 tick まで書ける", asymDelays(asymLoc).rise, 600);
check("秒換算のメッセージが乗る", asymPlayer.lastActionBar?.with?.[1], "30.0");

// 座標キーの動的プロパティなので、壊したら消えないと次に置いた人が引き継いでしまう
section("C-7 非対称ディレイリピーター: 壊すと遅延の記録も消える");
asymComp.onPlayerDestroy({ block: dim.getBlock(asymLoc), player: asymPlayer });
check("破壊で幽霊プロパティが残らない", asymDelays(asymLoc).rise, 0);
setAsymDp(asymLoc, 4, 4);
world.afterEvents.blockExplode.emit({
  block: dim.getBlock(asymLoc),
  dimension: dim,
  explodedBlockPermutation: { type: { id: "wr:asym_repeater" } },
});
await settle(1);
check("爆発でも消える（onPlayerDestroy は来ない）", asymDelays(asymLoc).fall, 0);

section("C-2 パルス生成機: 壊すと周期の記録も消える");
const pgGhost = at(468, 5, 0);
dim.place(pgGhost, "wr:pulse_generator", {
  "minecraft:cardinal_direction": "north", "wr:on": false,
});
setPulseDp(pgGhost, 1200);
pulseComp.onPlayerDestroy({ block: dim.getBlock(pgGhost), player: periodPlayer });
check("破壊で既定に戻る", timingMod.periodOf(dim.getBlock(pgGhost)), 5);
setPulseDp(pgGhost, 2400);
world.afterEvents.blockExplode.emit({
  block: dim.getBlock(pgGhost),
  dimension: dim,
  explodedBlockPermutation: { type: { id: "wr:pulse_generator" } },
});
await settle(1);
check("爆発でも既定に戻る", timingMod.periodOf(dim.getBlock(pgGhost)), 5);

section("ランダマイザー: 立ち上がりごとに 1 回だけ振る");
const rndLoc = at(450, 5, 0);
dim.place(rndLoc, "wr:randomizer", {
  "minecraft:cardinal_direction": "north",
  "wr:power": 0,
  "wr:armed": true,
  "wr:binary": true, // 0 か 15 だけなので判定しやすい
});
const rndComp = blockComponents.get("wr:randomizer");
dim.place(at(450, 5, 1), "minecraft:redstone_wire", {}, 15);
pump([rndLoc], 3);
const firstRoll = stateOf(rndLoc, "wr:power");
check("0 か 15 のどちらかになる", firstRoll === 0 || firstRoll === 15, true);
check("armed が倒れる", stateOf(rndLoc, "wr:armed"), false);

// 入りっぱなしでは振り直さない
for (let i = 0; i < 10; i += 1) pump([rndLoc], 1);
check("入れっぱなしでは振り直さない", stateOf(rndLoc, "wr:power"), firstRoll);

// 何度も振れば 0 と 15 の両方が出る（乱数が効いていることの確認）
const seen = new Set();
for (let i = 0; i < 60; i += 1) {
  dim.place(at(450, 5, 1), "minecraft:redstone_wire", {}, 0);
  pump([rndLoc], 2);
  dim.place(at(450, 5, 1), "minecraft:redstone_wire", {}, 15);
  pump([rndLoc], 2);
  seen.add(stateOf(rndLoc, "wr:power"));
}
check("60 回振れば 0 と 15 の両方が出る", seen.size, 2);

section("F-4 天候センサー: 雨と雷で強くなる");
const wxLoc = at(460, 5, 0);
dim.place(wxLoc, "wr:weather_sensor", { "wr:power": 0, "wr:night": false });
const wxComp = blockComponents.get("wr:weather_sensor");
const pumpWx = () => {
  wxComp.onTick({ block: dim.getBlock(wxLoc) });
  advanceTicks(1);
};
dim.weather = "Clear";
pumpWx();
check("晴れは 0", stateOf(wxLoc, "wr:power"), 0);
dim.weather = "Rain";
pumpWx();
check("雨は 8", stateOf(wxLoc, "wr:power"), 8);
dim.weather = "Thunder";
pumpWx();
check("雷雨は 15", stateOf(wxLoc, "wr:power"), 15);

// 右クリックで反転
wxComp.onPlayerInteract({
  block: dim.getBlock(wxLoc),
  player: fakePlayer("wx", undefined, "minecraft:stick"),
});
pumpWx();
check("反転すると雷雨で 0", stateOf(wxLoc, "wr:power"), 0);
dim.weather = "Clear";
pumpWx();
check("反転なら晴れで 15", stateOf(wxLoc, "wr:power"), 15);
dim.weather = undefined;

// ---- コンテナ計測器 ---------------------------------------------------------

section("F-3 コンテナ計測器: 隣のチェストの中身を読む");
// テスト用のチェストを作る（スタブの Block.container を差し込むと
// インベントリを持つブロックとして振る舞う）
function fakeChest(loc, items, size = 27) {
  const block = dim.place(loc, "minecraft:chest");
  block.container = makeContainer(items, { size });
  return block;
}

const csLoc = at(400, 5, 0);
dim.place(csLoc, "wr:container_sensor", { "wr:power": 0, "wr:mode": 0 });
// 27 スロット中 1 スロットだけ、64 個入るアイテムが 64 個 → 割合 1/27
fakeChest(at(400, 4, 0), [{ typeId: "minecraft:stone", amount: 64, maxAmount: 64 }]);
const csComp = blockComponents.get("wr:container_sensor");
const pumpCs = () => {
  csComp.onTick({ block: dim.getBlock(csLoc) });
  advanceTicks(1);
};
pumpCs();
check("1 個でも入っていれば最低 1", stateOf(csLoc, "wr:power"), 1);

// 満杯にすれば 15
const full = [];
for (let i = 0; i < 27; i += 1) full.push({ typeId: "minecraft:stone", amount: 64, maxAmount: 64 });
fakeChest(at(400, 4, 0), full);
pumpCs();
check("満杯なら 15", stateOf(csLoc, "wr:power"), 15);

// 空なら 0
fakeChest(at(400, 4, 0), []);
pumpCs();
check("空なら 0", stateOf(csLoc, "wr:power"), 0);

// 種類数モード
fakeChest(at(400, 4, 0), [
  { typeId: "minecraft:stone", amount: 1, maxAmount: 64 },
  { typeId: "minecraft:dirt", amount: 1, maxAmount: 64 },
  { typeId: "minecraft:stone", amount: 1, maxAmount: 64 },
]);
const csPlayer = fakePlayer("cs", undefined, "minecraft:stick");
csPlayer.setHeld(new ItemStack("minecraft:stick", 1));
csComp.onPlayerInteract({ block: dim.getBlock(csLoc), player: csPlayer });
check("モードが 種類数(1) に進む", stateOf(csLoc, "wr:mode"), 1);
pumpCs();
check("種類は 2 つ", stateOf(csLoc, "wr:power"), 2);

// 空きスロット数モード（27 - 使用 3 = 24 → 15 で頭打ち）
csComp.onPlayerInteract({ block: dim.getBlock(csLoc), player: csPlayer });
pumpCs();
check("空きスロットは 15 で頭打ち", stateOf(csLoc, "wr:power"), 15);

// 指定アイテムモード: スニーク + 右クリックで手持ちを対象にする
csComp.onPlayerInteract({ block: dim.getBlock(csLoc), player: csPlayer });
check("モードが 指定アイテム(3) に進む", stateOf(csLoc, "wr:mode"), 3);
csPlayer.setHeld(new ItemStack("minecraft:dirt", 1));
csPlayer.isSneaking = true;
csComp.onPlayerInteract({ block: dim.getBlock(csLoc), player: csPlayer });
csPlayer.isSneaking = false;
check("対象を設定したメッセージ", csPlayer.lastActionBar?.translate, "wr.msg.container.filter");
fakeChest(at(400, 4, 0), [
  { typeId: "minecraft:dirt", amount: 5, maxAmount: 64 },
  { typeId: "minecraft:stone", amount: 40, maxAmount: 64 },
]);
pumpCs();
check("指定アイテムだけ数える", stateOf(csLoc, "wr:power"), 5);

// 座標キーの動的プロパティなので、爆破でも消えないと次に置いた計測器がフィルタを引き継ぐ
world.afterEvents.blockExplode.emit({
  block: dim.getBlock(csLoc),
  dimension: dim,
  explodedBlockPermutation: { type: { id: "wr:container_sensor" } },
});
await settle(1);
pumpCs();
check("爆発でフィルタがリセットされ、指定アイテムモードのまま 0 になる", stateOf(csLoc, "wr:power"), 0);

// 隣にコンテナが無ければ 0
dim.getBlock(at(400, 4, 0)).setType("minecraft:air");
pumpCs();
check("コンテナが無ければ 0", stateOf(csLoc, "wr:power"), 0);

// ---- 時刻トリガー -----------------------------------------------------------

section("C-4 時刻トリガー: 指定時刻に 1 回だけ撃つ");
// getTimeOfDay は 0 が朝 6 時。9 時にしたいなら (9-6)*1000 = 3000
const hourToTime = (h) => (((h - 6) % 24) + 24) % 24 * 1000;
const timerLoc = at(410, 5, 0);
dim.place(timerLoc, "wr:timer", {
  "wr:on": false,
  "wr:armed": true,
  "wr:every": false,
  "wr:hour_tens": 0,
  "wr:hour_ones": 9, // 9 時
});
const timerComp = blockComponents.get("wr:timer");
const pumpTimer = () => {
  timerComp.onTick({ block: dim.getBlock(timerLoc) });
  advanceTicks(1);
};

world.setTimeOfDay(hourToTime(8));
pumpTimer();
check("8 時では撃たない", stateOf(timerLoc, "wr:on"), false);

world.setTimeOfDay(hourToTime(9));
pumpTimer();
check("9 時になったら撃つ", stateOf(timerLoc, "wr:on"), true);
pumpTimer();
check("1 秒後に落ちる", stateOf(timerLoc, "wr:on"), false);

// 同じ時間帯にいる間は撃ち直さない。
// **pump は 1 回だけにすること**。2 回回すと「撃つ→落ちる」で
// 見かけ上 false に戻り、撃ち続けるバグを見逃す。
pumpTimer();
check("同じ時間帯では二度撃たない", stateOf(timerLoc, "wr:on"), false);

// 時間が変わってからまた 9 時になれば撃つ
world.setTimeOfDay(hourToTime(10));
pumpTimer();
world.setTimeOfDay(hourToTime(9));
pumpTimer();
check("次の日はまた撃つ", stateOf(timerLoc, "wr:on"), true);
pumpTimer();

section("C-4 時刻トリガー: N 時間ごとモード");
dim.place(timerLoc, "wr:timer", {
  "wr:on": false,
  "wr:armed": true,
  "wr:every": true,
  "wr:hour_tens": 0,
  "wr:hour_ones": 6, // 6 時間ごと
});
world.setTimeOfDay(hourToTime(5));
pumpTimer();
check("5 時では撃たない", stateOf(timerLoc, "wr:on"), false);
world.setTimeOfDay(hourToTime(6));
pumpTimer();
check("6 の倍数で撃つ", stateOf(timerLoc, "wr:on"), true);
pumpTimer();
// 条件から外れる時間を通らないと次を撃たない（同じ時間帯での連打よけ）。
// 実際のワールドでは時間が連続して進むので必ずここを通る。
world.setTimeOfDay(hourToTime(9));
pumpTimer();
check("外れている間は撃たない", stateOf(timerLoc, "wr:on"), false);
world.setTimeOfDay(hourToTime(12));
pumpTimer();
check("12 時でも撃つ", stateOf(timerLoc, "wr:on"), true);
pumpTimer();
world.setTimeOfDay(6000);

// ---- アクセスログ -----------------------------------------------------------

section("H-3 アクセスログ: 解錠も拒否も記録される");
const { readAccessLog, clearAccessLog, LOG_LIMIT } = await import("./scripts/access_log.js");
clearAccessLog();

const logLockLoc = at(420, 5, 0);
dim.place(logLockLoc, "wr:lock", { "wr:on": false, "wr:remain": 0, "wr:seconds": 2 });
issueKey("LOGKEY");
setLockKeys(dim.getBlock(logLockLoc), "LOGKEY");

const logPlayer = fakePlayer("logger", undefined, "wr:card_key");
logPlayer.name = "Alex";
const okCard = new ItemStack("wr:card_key");
okCard.nameTag = "LOGKEY";
logPlayer.setHeld(okCard);
lockComp.onPlayerInteract({ block: dim.getBlock(logLockLoc), player: logPlayer });

const ngCard = new ItemStack("wr:card_key");
ngCard.nameTag = "WRONG";
logPlayer.setHeld(ngCard);
lockComp.onPlayerInteract({ block: dim.getBlock(logLockLoc), player: logPlayer });

const rows = readAccessLog();
check("2 件記録されている", rows.length, 2);
check("新しい順に並ぶ（拒否が先頭）", rows[0]?.result, "ng");
check("拒否の鍵IDが残る", rows[0]?.detail, "WRONG");
check("解錠も残る", rows[1]?.result, "ok");
check("プレイヤー名が残る", rows[1]?.player, "Alex");
check("座標が残る", rows[1]?.position, "420,5,0");

section("H-3 アクセスログ: 上限を超えたら古いものから消える");
clearAccessLog();
for (let i = 0; i < LOG_LIMIT + 5; i += 1) {
  logPlayer.setHeld(okCard);
  lockComp.onPlayerInteract({ block: dim.getBlock(logLockLoc), player: logPlayer });
}
const capped = readAccessLog();
check("上限で頭打ちになる", capped.length, LOG_LIMIT);
clearAccessLog();
check("消せる", readAccessLog().length, 0);

// ---- 鉱石精錬機 -------------------------------------------------------------

section("I-1 鉱石精錬機: 上から吸って下へ吐く");
const { isRefinable, targetOf, setTarget, pointsOf } = await import("./scripts/refiner.js");
check("石炭は変換表にある", isRefinable("minecraft:coal"), true);
check("丸石も変換表にある", isRefinable("minecraft:cobblestone"), true);
check("表に無いものは弾く", isRefinable("minecraft:diamond_sword"), false);

// 変換表の抜けは「実機で入れてみて初めて気づく」形の不具合なので、
// **プレイヤーが当然入ると思うものを名指しで並べておく**。
// v1.27.0 までネザライトインゴットと未精錬鉱石が抜けていた（ユーザー報告）。
// 表は入力と出力の両方を兼ねているので、抜けていると変換先にも選べない。
for (const id of [
  "minecraft:netherite_ingot",
  "minecraft:netherite_scrap",
  "minecraft:netherite_block",
  "minecraft:ancient_debris",
  "minecraft:raw_iron",
  "minecraft:raw_gold",
  "minecraft:raw_copper",
  "minecraft:raw_iron_block",
  "minecraft:diamond",
  "minecraft:diamond_block",
  "minecraft:emerald",
  "minecraft:gold_ingot",
  "minecraft:iron_ingot",
  "minecraft:copper_ingot",
]) {
  check(`${id.replace("minecraft:", "")} は変換表にある`, isRefinable(id), true);
}

const refLoc = at(470, 5, 0);
dim.place(refLoc, "wr:ore_refiner", { "wr:busy": false, "wr:disabled": false });

// 上のチェスト = 入力、下のチェスト = 出力
const inSlots = [{ typeId: "minecraft:iron_ingot", amount: 16, maxAmount: 64 }];
const outSlots = [];
const inBlock = dim.place(at(470, 6, 0), "minecraft:chest");
inBlock.container = makeContainer(inSlots);
const outBlock = dim.place(at(470, 4, 0), "minecraft:chest");
outBlock.container = makeContainer(outSlots, {
  addItem: (item, slots) => { slots.push(item); return undefined; },
});

// 鉄 8 ポイント × 16 個 = 128 ポイント → ダイヤ 1 個ぶん
const refComp = blockComponents.get("wr:ore_refiner");
const refPlayer = fakePlayer("ref", undefined, "minecraft:diamond");
refPlayer.setHeld(new ItemStack("minecraft:diamond", 1));
refComp.onPlayerInteract({ block: dim.getBlock(refLoc), player: refPlayer });
check("持っているものが変換先になる", targetOf(dim.getBlock(refLoc)), "minecraft:diamond");

const pumpRef = () => {
  refComp.onTick({ block: dim.getBlock(refLoc) });
  advanceTicks(1);
};
pumpRef();
check("入力を吸い出す", inSlots[0], undefined);
pumpRef();
check("ダイヤが 1 個できる", outSlots.filter((i) => i.typeId === "minecraft:diamond").length, 1);
check("端数は残らない（128 ちょうど）", pointsOf(dim.getBlock(refLoc)), 0);

section("I-1 鉱石精錬機: 表に無いものは触らない");
inSlots[0] = { typeId: "minecraft:diamond_sword", amount: 1, maxAmount: 1 };
pumpRef();
check("剣は吸い出されない", inSlots[0]?.typeId, "minecraft:diamond_sword");

section("I-1 鉱石精錬機: レッドストーン信号で止まる");
// 電力は **隣のブロックから読ませる**（イベントの引数で駆動しない。
// 実機ではイベントが来ないことがあり、wr: ブロックの出力はそもそも見えない）
inSlots[0] = { typeId: "minecraft:iron_ingot", amount: 16, maxAmount: 64 };
const refPower = at(471, 5, 0); // east から給電する
dim.place(refPower, "minecraft:redstone_block", {}, 15);
pumpRef();
check("止まっている間は吸わない", inSlots[0]?.amount, 16);
check("止まっている見た目になる", stateOf(refLoc, "wr:disabled"), true);
dim.place(refPower, "minecraft:air", {}, 0);
pumpRef();
check("信号が切れれば再開する", inSlots[0], undefined);

section("I-1 鉱石精錬機: 壊すと変換先の記録も消える");
// 座標キーの動的プロパティなので、爆破でも消えないと次に置いた精錬機が
// 変換先とたまったポイントを引き継いでしまう（実質増殖）
world.afterEvents.blockExplode.emit({
  block: dim.getBlock(refLoc),
  dimension: dim,
  explodedBlockPermutation: { type: { id: "wr:ore_refiner" } },
});
await settle(1);
check("爆発で変換先の記録がリセットされる", targetOf(dim.getBlock(refLoc)), "");
check("爆発でたまったポイントもリセットされる", pointsOf(dim.getBlock(refLoc)), 0);

// ---- XPタンク ---------------------------------------------------------------

section("I-2 XPタンク: あずける・引き出す");
const { storedXp, XP_CAPACITY } = await import("./scripts/xp_tank.js");
const xpLoc = at(480, 5, 0);
dim.place(xpLoc, "wr:xp_tank", { "wr:power": 0 });
const xpComp = blockComponents.get("wr:xp_tank");

// 経験値を持つプレイヤーを作る。
//
// **本物の Bedrock の挙動をまねること。** 以前はここを
// 「addExperience(delta) で total をそのまま足し引きする」と書いていたので、
// **レベルぶんを吸えない不具合が丸ごと見えなかった**（実機で発覚）。
// 本物の addExperience は負の値でも **今のレベルで稼いだぶんまでしか減らせず、
// レベルには手が届かない**。レベルまで消すには resetLevel() が要る。
const xpForLevel = (l) => (l < 16 ? 2 * l + 7 : l < 31 ? 5 * l - 38 : 9 * l - 158);

function attachXp(player, startLevel, startProgress) {
  const m = { level: startLevel, progress: startProgress };
  m.total = () => {
    let t = m.progress;
    for (let l = 0; l < m.level; l += 1) t += xpForLevel(l);
    return t;
  };
  Object.defineProperty(player, "level", { get: () => m.level, configurable: true });
  Object.defineProperty(player, "xpEarnedAtCurrentLevel", {
    get: () => m.progress,
    configurable: true,
  });
  player.getTotalXp = () => m.total();
  player.addExperience = (delta) => {
    if (delta < 0) {
      // レベルは削れない。バーの中身だけが減る
      m.progress = Math.max(0, m.progress + delta);
    } else {
      m.progress += delta;
      while (m.progress >= xpForLevel(m.level)) {
        m.progress -= xpForLevel(m.level);
        m.level += 1;
      }
    }
    return m.total();
  };
  player.resetLevel = () => {
    m.level = 0;
    m.progress = 0;
  };
  return m;
}

const xpPlayer = fakePlayer("xp", undefined, "minecraft:stick");
xpPlayer.setHeld(undefined);
// レベル 0・バーに 500（＝バーだけで持っている状態）
let xp = attachXp(xpPlayer, 0, 500);

xpComp.onPlayerInteract({ block: dim.getBlock(xpLoc), player: xpPlayer });
check("プレイヤーの経験値が 0 になる", xpPlayer.getTotalXp(), 0);
check("タンクに入る", storedXp(dim.getBlock(xpLoc)), 500);
xpComp.onTick({ block: dim.getBlock(xpLoc) });
advanceTicks(1);
check("たまっていれば出力が出る", stateOf(xpLoc, "wr:power") > 0, true);

xpPlayer.isSneaking = true;
xpComp.onPlayerInteract({ block: dim.getBlock(xpLoc), player: xpPlayer });
xpPlayer.isSneaking = false;
check("引き出すとプレイヤーに戻る", xpPlayer.getTotalXp(), 500);
check("タンクは空になる", storedXp(dim.getBlock(xpLoc)), 0);
xpComp.onTick({ block: dim.getBlock(xpLoc) });
advanceTicks(1);
check("空なら出力も 0", stateOf(xpLoc, "wr:power"), 0);

section("I-2 XPタンク: レベルぶんも吸い取れる");
// **バーが空でレベルだけ持っている状態**。addExperience(-n) では 1 も減らせない。
// v1.27.0 まではここで「経験値のやりとりに失敗しました」が出ていた（ユーザー報告）。
xp = attachXp(xpPlayer, 30, 0);
const level30 = xpPlayer.getTotalXp();
check("レベル 30 は約 1395 XP", level30, 1395);
xpComp.onPlayerInteract({ block: dim.getBlock(xpLoc), player: xpPlayer });
check("レベルぶんもタンクに入る", storedXp(dim.getBlock(xpLoc)), level30);
check("プレイヤーは 0 になる", xpPlayer.getTotalXp(), 0);
check("レベルも 0 になる", xpPlayer.level, 0);

section("I-2 XPタンク: 一部だけ取るときは残りを返す");
// タンクの残りを 100 にする（公開の手順だけで積む）
const fillTank = (amount) => {
  xpPlayer.isSneaking = true;
  xpComp.onPlayerInteract({ block: dim.getBlock(xpLoc), player: xpPlayer }); // 空にする
  xpPlayer.isSneaking = false;
  attachXp(xpPlayer, 0, amount);
  if (amount > 0) xpComp.onPlayerInteract({ block: dim.getBlock(xpLoc), player: xpPlayer });
};
fillTank(XP_CAPACITY - 100);
check("下ごしらえ: 残りは 100", XP_CAPACITY - storedXp(dim.getBlock(xpLoc)), 100);

xp = attachXp(xpPlayer, 30, 0);
xpComp.onPlayerInteract({ block: dim.getBlock(xpLoc), player: xpPlayer });
check("入るぶんだけ受け取る", storedXp(dim.getBlock(xpLoc)), XP_CAPACITY);
check("残りは手元に返る", xpPlayer.getTotalXp(), level30 - 100);

section("I-2 XPタンク: 返し損ねたぶんは受け取りすぎない");
// 0 にしたあとの「残りを返す」が一度だけ失敗する環境を再現する。
// このとき取り上げた量がタンクの空きを超えるので、超過は手元に戻す必要がある
// （戻さないと、あふれたぶんが消えてしまう）。
fillTank(XP_CAPACITY - 100);
xp = attachXp(xpPlayer, 30, 0);
const realAdd = xpPlayer.addExperience;
let addFailures = 1;
xpPlayer.addExperience = (delta) => {
  if (addFailures > 0 && delta > 0) {
    addFailures -= 1;
    throw new Error("返却に失敗");
  }
  return realAdd(delta);
};
xpComp.onPlayerInteract({ block: dim.getBlock(xpLoc), player: xpPlayer });
check("空きぶんしか受け取らない", storedXp(dim.getBlock(xpLoc)), XP_CAPACITY);
check("取りすぎたぶんは手元に戻る", xpPlayer.getTotalXp(), level30 - 100);

section("I-2 XPタンク: 減らせなければ増やさない");
// 0 にする手段が両方とも効かない環境を再現する
fillTank(0);
xp = attachXp(xpPlayer, 0, 300);
xpPlayer.resetLevel = () => { throw new Error("resetLevel 不可"); };
xpComp.onPlayerInteract({ block: dim.getBlock(xpLoc), player: xpPlayer });
check("減っていないので入らない", storedXp(dim.getBlock(xpLoc)), 0);
check("プレイヤーの経験値もそのまま", xpPlayer.getTotalXp(), 300);

section("I-2 XPタンク: 上限を超えて受け取らない");
xp = attachXp(xpPlayer, 0, XP_CAPACITY * 2);
xpPlayer.resetLevel = () => { xp.level = 0; xp.progress = 0; };
xpComp.onPlayerInteract({ block: dim.getBlock(xpLoc), player: xpPlayer });
check("上限までしか入らない", storedXp(dim.getBlock(xpLoc)), XP_CAPACITY);
check("あふれたぶんは手元に残る", xpPlayer.getTotalXp(), XP_CAPACITY);

section("I-2 XPタンク: 壊すとたまったXPも消える");
// 座標キーの動的プロパティなので、爆破でも消えないと次に置いたタンクが
// 前のXPを引き継いでしまう（実質増殖）
world.afterEvents.blockExplode.emit({
  block: dim.getBlock(xpLoc),
  dimension: dim,
  explodedBlockPermutation: { type: { id: "wr:xp_tank" } },
});
await settle(1);
check("爆発でたまったXPがリセットされる", storedXp(dim.getBlock(xpLoc)), 0);

// ---- 設置・排出・トラップ ---------------------------------------------------

// 電力は **本物と同じく隣のブロックから読ませる**。
// イベントの引数（redstonePower）だけで駆動すると、実機で
// 「イベントが来ない／wr: ブロックの出力が見えない」不具合を丸ごと見逃す。
// v1.27.0 でブロックディスペンサーが実機で一切動かなかったのがまさにこれ。
const powerFromNeighbor = (loc, on) => {
  dim.place(loc, on ? "minecraft:redstone_block" : "minecraft:air", {}, on ? 15 : 0);
};

section("J-1 ブロックディスペンサー: 信号の立ち上がりで 1 個だけ置く");
const bdLoc = at(490, 5, 0);
dim.place(bdLoc, "wr:block_dispenser", {
  "minecraft:cardinal_direction": "north",
  "wr:busy": false,
  "wr:armed": true,
  "wr:powered": false,
});
const bdPower = at(490, 5, 1); // 背面（south）から給電する
const bdSlots = [{ typeId: "minecraft:stone", amount: 3, maxAmount: 64 }];
const bdChest = dim.place(at(490, 6, 0), "minecraft:chest");
bdChest.container = makeContainer(bdSlots);
const bdComp = blockComponents.get("wr:block_dispenser");
const bdFront = at(490, 5, -1); // north

const pumpBd = () => {
  bdComp.onTick({ block: dim.getBlock(bdLoc) });
  advanceTicks(1);
};

powerFromNeighbor(bdPower, true);
pumpBd();
check("前面にブロックが置かれる", dim.getBlock(bdFront).typeId, "minecraft:stone");
check("在庫が 1 減る", bdSlots[0]?.amount, 2);
check("信号を受けている見た目になる", stateOf(bdLoc, "wr:powered"), true);

// 押しっぱなしでは積み続けない
dim.getBlock(bdFront).setType("minecraft:air");
pumpBd();
check("入りっぱなしでは置き直さない", dim.getBlock(bdFront).typeId, "minecraft:air");

// 一度切ってからならまた置く
powerFromNeighbor(bdPower, false);
pumpBd();
check("信号を切ると見た目も戻る", stateOf(bdLoc, "wr:powered"), false);
powerFromNeighbor(bdPower, true);
pumpBd();
check("切ってからならまた置く", dim.getBlock(bdFront).typeId, "minecraft:stone");

// 既に何かある場所は上書きしない
powerFromNeighbor(bdPower, false);
pumpBd();
dim.getBlock(bdFront).setType("minecraft:diamond_block");
const stockBefore = bdSlots[0]?.amount;
powerFromNeighbor(bdPower, true);
pumpBd();
check("空気でなければ上書きしない", dim.getBlock(bdFront).typeId, "minecraft:diamond_block");
check("在庫も減らない", bdSlots[0]?.amount, stockBefore);

section("J-2 ホッパードロッパー: 上から下へ運ぶ");
const hdLoc = at(500, 5, 0);
dim.place(hdLoc, "wr:hopper_dropper", { "wr:busy": false, "wr:powered": false });
const hdPower = at(501, 5, 0); // east から給電する
const upSlots = [{ typeId: "minecraft:cobblestone", amount: 64, maxAmount: 64 }];
const downSlots = [];
const upChest = dim.place(at(500, 6, 0), "minecraft:chest");
upChest.container = makeContainer(upSlots);
const downChest = dim.place(at(500, 4, 0), "minecraft:chest");
downChest.container = makeContainer(downSlots, {
  addItem: (item, slots) => { slots.push(item); return undefined; },
});
const hdComp = blockComponents.get("wr:hopper_dropper");
hdComp.onTick({ block: dim.getBlock(hdLoc) });
advanceTicks(1);
check("上から消える", upSlots[0], undefined);
check("下に入る", downSlots.length, 1);
check("スタックごと運ぶ", downSlots[0]?.amount, 64);

// **稼働中でも電力を漏らさないこと。**
// 稼働フラグを wr:on という名前にしていると powerFrom() が「出力 15」として読み、
// 隣のワイヤーが勝手に点く（v1.28.1 まで実際にそうなっていた）。
// 向きを持たないブロックなので全方向に漏れる。
{
  const leakWire = at(500, 5, 1); // ホッパードロッパーの真横
  dim.place(at(500, 4, 1), "minecraft:stone"); // ワイヤーの支え
  dim.place(leakWire, "wr:wire", {
    "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0,
    "wr:c0": false, "wr:c1": false, "wr:c2": false, "wr:c3": false, "wr:glow": false,
  });
  upSlots[0] = { typeId: "minecraft:cobblestone", amount: 64, maxAmount: 64 };
  hdComp.onTick({ block: dim.getBlock(hdLoc) });
  advanceTicks(1);
  check("運んでいる（稼働中）", stateOf(hdLoc, "wr:busy"), true);
  blockComponents.get("wr:wire").onTick({ block: dim.getBlock(leakWire) });
  advanceTicks(2);
  check("稼働中でも隣のワイヤーは点かない", stateOf(leakWire, "wr:power"), 0);
}

// レッドストーンで止まる
upSlots[0] = { typeId: "minecraft:dirt", amount: 8, maxAmount: 64 };
powerFromNeighbor(hdPower, true);
hdComp.onTick({ block: dim.getBlock(hdLoc) });
advanceTicks(1);
check("止まっている間は運ばない", upSlots[0]?.amount, 8);
check("止まっている見た目になる", stateOf(hdLoc, "wr:powered"), true);

// 下にコンテナが無ければドロップする
const droppedBeforeHd = dim.spawnedItems.length;
dim.getBlock(at(500, 4, 0)).setType("minecraft:air");
powerFromNeighbor(hdPower, false);
hdComp.onTick({ block: dim.getBlock(hdLoc) });
advanceTicks(1);
check("下が空なら吐き出す", dim.spawnedItems.length > droppedBeforeHd, true);
check("吐いたぶんは上から消える", upSlots[0], undefined);

section("J-3 スパイク: 真上のモブを刺す。プレイヤーは刺さない");
const spLoc = at(510, 5, 0);
dim.place(spLoc, "wr:spike", { "wr:busy": false, "wr:hot": false, "wr:powered": false });
const spComp = blockComponents.get("wr:spike");

let cowHealth = 10;
const cow = {
  typeId: "minecraft:cow",
  location: { x: 510.5, y: 6, z: 0.5 },
  getComponent: (n) => (n === "minecraft:health" ? { currentValue: cowHealth } : undefined),
  applyDamage: (amount) => { cowHealth -= amount; },
  setOnFire: () => { cow.burned = true; },
};
dim.entities = [cow];
spComp.onTick({ block: dim.getBlock(spLoc) });
advanceTicks(1);
check("ダメージが入る", cowHealth, 6);
check("稼働中の見た目になる", stateOf(spLoc, "wr:busy"), true);
check("通常モードでは燃やさない", cow.burned, undefined);

// 加熱モードにすると火をつける
spComp.onPlayerInteract({
  block: dim.getBlock(spLoc),
  player: fakePlayer("spike", undefined, "minecraft:stick"),
});
check("加熱モードに切り替わる", stateOf(spLoc, "wr:hot"), true);
spComp.onTick({ block: dim.getBlock(spLoc) });
advanceTicks(1);
check("加熱モードでは火をつける", cow.burned, true);

// 倒すと経験値オーブが湧く
const spawnedBefore = dim.spawnedEntities?.length ?? 0;
cowHealth = 2;
spComp.onTick({ block: dim.getBlock(spLoc) });
advanceTicks(1);
check("倒すと経験値が湧く", (dim.spawnedEntities?.length ?? 0) > spawnedBefore, true);

// プレイヤーは除外される（getEntities の excludeTypes で弾く）。
// **体力を持たせておくこと**。持たせないと「刺そうとしても体力が読めず素通り」
// になってしまい、除外が効いているかを確かめられない。
let playerHealth = 20;
dim.entities = [
  {
    typeId: "minecraft:player",
    location: { x: 510.5, y: 6, z: 0.5 },
    getComponent: (n) => (n === "minecraft:health" ? { currentValue: playerHealth } : undefined),
    applyDamage: (amount) => { playerHealth -= amount; },
    setOnFire: () => {},
  },
];
spComp.onTick({ block: dim.getBlock(spLoc) });
advanceTicks(1);
check("プレイヤーだけなら反応しない", stateOf(spLoc, "wr:busy"), false);
check("プレイヤーは無傷", playerHealth, 20);
dim.entities = [];

// ---- ブロックブレイカー -----------------------------------------------------

section("K-1 ブロックブレイカー: 前面を壊して上のチェストへ");
const bbLoc = at(520, 5, 0);
dim.place(bbLoc, "wr:block_breaker", {
  "minecraft:cardinal_direction": "north",
  "wr:busy": false,
  "wr:armed": true,
  "wr:powered": false,
});
const bbPower = at(520, 5, 1); // 背面から給電
const bbFront = at(520, 5, -1);
const bbSlots = [];
const bbChest = dim.place(at(520, 6, 0), "minecraft:chest");
bbChest.container = makeContainer(bbSlots, {
  addItem: (item, slots) => { slots.push(item); return undefined; },
});
const bbComp = blockComponents.get("wr:block_breaker");
const pumpBb = () => {
  bbComp.onTick({ block: dim.getBlock(bbLoc) });
  advanceTicks(1);
};

dim.place(bbFront, "minecraft:stone");
powerFromNeighbor(bbPower, true);
pumpBb();
check("前面が壊れる", dim.getBlock(bbFront).typeId, "minecraft:air");
check("上のチェストに入る", bbSlots[0]?.typeId, "minecraft:stone");

// 押しっぱなしでは壊し続けない
dim.place(bbFront, "minecraft:dirt");
pumpBb();
check("入りっぱなしでは壊し直さない", dim.getBlock(bbFront).typeId, "minecraft:dirt");
powerFromNeighbor(bbPower, false);
pumpBb();
powerFromNeighbor(bbPower, true);
pumpBb();
check("切ってからならまた壊す", dim.getBlock(bbFront).typeId, "minecraft:air");

// **壊してはいけないもの**
const bbCount = bbSlots.length;
for (const [id, why] of [
  ["minecraft:bedrock", "岩盤は壊さない"],
  ["wr:wire", "wr: のブロックは壊さない"],
]) {
  powerFromNeighbor(bbPower, false);
  pumpBb();
  dim.place(bbFront, id);
  powerFromNeighbor(bbPower, true);
  pumpBb();
  check(why, dim.getBlock(bbFront).typeId, id);
}
check("壊さなかったぶんは回収もしない", bbSlots.length, bbCount);

// 中身を持つブロック（チェスト）も守る
powerFromNeighbor(bbPower, false);
pumpBb();
const victim = dim.place(bbFront, "minecraft:chest");
victim.container = makeContainer([{ typeId: "minecraft:diamond", amount: 5 }]);
powerFromNeighbor(bbPower, true);
pumpBb();
check("中身のあるブロックは壊さない", dim.getBlock(bbFront).typeId, "minecraft:chest");

// ---- サウンドブロック -------------------------------------------------------

section("K-2 サウンドブロック: 立ち上がりで 1 回だけ鳴らす");
const sbLoc = at(530, 5, 0);
dim.place(sbLoc, "wr:sound_block", { "wr:sound": 0, "wr:armed": true });
const sbPower = at(530, 5, 1);
const sbComp = blockComponents.get("wr:sound_block");
const { SOUND_IDS } = await import("./scripts/machines.js");
const pumpSb = () => {
  sbComp.onTick({ block: dim.getBlock(sbLoc) });
  advanceTicks(1);
};
dim.playedSounds = [];

pumpSb();
check("信号が無ければ鳴らない", dim.playedSounds.length, 0);
powerFromNeighbor(sbPower, true);
pumpSb();
check("立ち上がりで鳴る", dim.playedSounds.length, 1);
check("選んだ音が鳴る", dim.playedSounds[0]?.soundId, SOUND_IDS[0]);
pumpSb();
pumpSb();
check("入りっぱなしでは鳴り続けない", dim.playedSounds.length, 1);
powerFromNeighbor(sbPower, false);
pumpSb();
powerFromNeighbor(sbPower, true);
pumpSb();
check("切ってからならまた鳴る", dim.playedSounds.length, 2);

// 右クリックで音を選ぶ（試聴を兼ねて鳴る）
const sbPlayer = fakePlayer("snd", undefined, "minecraft:stick");
sbComp.onPlayerInteract({ block: dim.getBlock(sbLoc), player: sbPlayer });
check("右クリックで次の音へ", stateOf(sbLoc, "wr:sound"), 1);
check("選ぶと試聴で鳴る", dim.playedSounds.at(-1)?.soundId, SOUND_IDS[1]);
check("音は 16 種そろっている", SOUND_IDS.length, 16);

// ---- 数値表示: 10 進 2 桁 ----------------------------------------------------

section("数値表示: 10 進 2 桁モード");
const onesLoc = at(540, 5, 0);
const tensLoc = at(539, 5, 0); // 西隣 = 上位桁
const dispComp = blockComponents.get("wr:display");
for (const loc of [onesLoc, tensLoc]) {
  dim.place(loc, "wr:display", { "wr:value": 0, "wr:dec": true });
}
dim.place(at(540, 5, 1), "minecraft:redstone_wire", {}, 13);
dispComp.onTick({ block: dim.getBlock(onesLoc) });
advanceTicks(2);
check("一の位に 3", stateOf(onesLoc, "wr:value"), 3);
check("十の位に 1", stateOf(tensLoc, "wr:value"), 1);

// 桁が減ったら上位桁は 0 で埋める（前の "1" が残らない）
dim.place(at(540, 5, 1), "minecraft:redstone_wire", {}, 4);
dispComp.onTick({ block: dim.getBlock(onesLoc) });
advanceTicks(2);
check("一の位に 4", stateOf(onesLoc, "wr:value"), 4);
check("十の位は 0 に戻る", stateOf(tensLoc, "wr:value"), 0);

// 上位桁は自分では電力を読まない（読むと両方同じ数字になってしまう）
dim.place(at(539, 5, 1), "minecraft:redstone_wire", {}, 9);
dispComp.onTick({ block: dim.getBlock(tensLoc) });
advanceTicks(2);
check("上位桁は自分の電力を読まない", stateOf(tensLoc, "wr:value"), 0);

// 既定は今までどおり 16 進 1 桁
const hexLoc = at(545, 5, 0);
dim.place(hexLoc, "wr:display", { "wr:value": 0, "wr:dec": false });
dim.place(at(545, 5, 1), "minecraft:redstone_wire", {}, 13);
dispComp.onTick({ block: dim.getBlock(hexLoc) });
advanceTicks(2);
check("16 進モードでは 13 のまま（表示は D）", stateOf(hexLoc, "wr:value"), 13);

// ---- 設定コピー機 -----------------------------------------------------------

section("設定コピー機: 同じ種類のあいだで設定を写す");
const cfg = await import("./scripts/config_tool.js");
cfg.clearClipboard();
const srcLoc = at(550, 5, 0);
const dstLoc = at(551, 5, 0);
dim.place(srcLoc, "wr:variable_repeater", {
  "minecraft:cardinal_direction": "north", "wr:delay": 12, "wr:on": false,
});
dim.place(dstLoc, "wr:variable_repeater", {
  "minecraft:cardinal_direction": "north", "wr:delay": 3, "wr:on": false,
});
const toolPlayer = fakePlayer("cfg", undefined, "wr:config_tool");
toolPlayer.setHeld(new ItemStack("wr:config_tool"));
const cfgThComp = blockComponents.get("wr:variable_repeater");

// コピー（そのまま右クリック）
cfgThComp.onPlayerInteract({ block: dim.getBlock(srcLoc), player: toolPlayer });
check("コピーできた", cfg.clipboardOf()?.values?.["wr:delay"], 12);

// 貼り付け（スニーク + 右クリック）
toolPlayer.isSneaking = true;
cfgThComp.onPlayerInteract({ block: dim.getBlock(dstLoc), player: toolPlayer });
toolPlayer.isSneaking = false;
check("貼り付けできた", stateOf(dstLoc, "wr:delay"), 12);

// 種類が違えば貼り付けない。
// **ステート名が重なっている組み合わせで試すこと。**
// 名前が食い違う組み合わせだと「写す値が無いので何も起きない」だけになり、
// 種類チェックが効いているか確かめられない（最初それで素通りした）。
// コンテナ計測器と比較ブロックはどちらも wr:mode を持っている。
const csrcLoc = at(552, 5, 0);
const cdstLoc = at(552, 7, 0);
dim.place(csrcLoc, "wr:container_sensor", { "wr:power": 0, "wr:mode": 2 });
dim.place(cdstLoc, "wr:compare", {
  "minecraft:cardinal_direction": "north", "wr:on": false, "wr:mode": 0,
});
blockComponents.get("wr:container_sensor").onPlayerInteract({
  block: dim.getBlock(csrcLoc), player: toolPlayer,
});
check("計測器の mode をコピーした", cfg.clipboardOf()?.values?.["wr:mode"], 2);
toolPlayer.isSneaking = true;
blockComponents.get("wr:compare").onPlayerInteract({
  block: dim.getBlock(cdstLoc), player: toolPlayer,
});
toolPlayer.isSneaking = false;
check("種類が違えば貼り付けない", stateOf(cdstLoc, "wr:mode"), 0);

// 設定を**動的プロパティ**に持つブロック（非対称リピーター）もコピーできること。
// ステート組と経路が別なので、片方だけ直すともう片方が黙って写らなくなる。
section("設定コピー機: 動的プロパティに持つ設定も写る");
const asymSrc = at(556, 5, 0);
const asymDst = at(557, 5, 0);
dim.place(asymSrc, "wr:asym_repeater", {
  "minecraft:cardinal_direction": "north", "wr:on": false,
});
dim.place(asymDst, "wr:asym_repeater", {
  "minecraft:cardinal_direction": "north", "wr:on": false,
});
setAsymDp(asymSrc, 2, 9);
const cfgAsymComp = blockComponents.get("wr:asym_repeater");
cfgAsymComp.onPlayerInteract({ block: dim.getBlock(asymSrc), player: toolPlayer });
check("遅延 2 本をコピーした", cfg.clipboardOf()?.values?.["wr:fall"], 9);
toolPlayer.isSneaking = true;
cfgAsymComp.onPlayerInteract({ block: dim.getBlock(asymDst), player: toolPlayer });
toolPlayer.isSneaking = false;
check("貼り付け先の ON 側に写った", asymDelays(asymDst).rise, 2);
check("貼り付け先の OFF 側に写った", asymDelays(asymDst).fall, 9);

// パルス生成機も同じ経路。**長い周期がそのまま写ること**を見る
// （ステートだった頃のキーのままだと 1〜50 しか表せず、ここで詰まる）
const pgSrc = at(558, 5, 0);
const pgDst = at(559, 5, 0);
dim.place(pgSrc, "wr:pulse_generator", {
  "minecraft:cardinal_direction": "north", "wr:on": false,
});
dim.place(pgDst, "wr:pulse_generator", {
  "minecraft:cardinal_direction": "north", "wr:on": false,
});
setPulseDp(pgSrc, 1800);
const cfgPulseComp = blockComponents.get("wr:pulse_generator");
cfgPulseComp.onPlayerInteract({ block: dim.getBlock(pgSrc), player: toolPlayer });
check("長い周期をコピーした", cfg.clipboardOf()?.values?.["wr:period"], 1800);
toolPlayer.isSneaking = true;
cfgPulseComp.onPlayerInteract({ block: dim.getBlock(pgDst), player: toolPlayer });
toolPlayer.isSneaking = false;
check("貼り付け先も 1800 tick になった", timingMod.periodOf(dim.getBlock(pgDst)), 1800);

// 閾値ブロックも同じ経路。rise/fall の 2 本とも写ること
const thSrc = at(561, 5, 0);
const thDst = at(562, 5, 0);
dim.place(thSrc, "wr:threshold", { "minecraft:cardinal_direction": "north", "wr:on": false });
dim.place(thDst, "wr:threshold", { "minecraft:cardinal_direction": "north", "wr:on": false });
setThresholdDp(thSrc, 10, 4);
const cfgThreshComp = blockComponents.get("wr:threshold");
cfgThreshComp.onPlayerInteract({ block: dim.getBlock(thSrc), player: toolPlayer });
check("rise/fall をコピーした", cfg.clipboardOf()?.values?.["wr:fall"], 4);
toolPlayer.isSneaking = true;
cfgThreshComp.onPlayerInteract({ block: dim.getBlock(thDst), player: toolPlayer });
toolPlayer.isSneaking = false;
check("貼り付け先の rise に写った", logicMod.thresholdLevelsOf(dim.getBlock(thDst)).rise, 10);
check("貼り付け先の fall に写った", logicMod.thresholdLevelsOf(dim.getBlock(thDst)).fall, 4);

// クロックディバイダーも同じ経路。divisor だけが設定、カウンターは写さない
const cdSrc = at(563, 5, 0);
const cdDst = at(564, 5, 0);
dim.place(cdSrc, "wr:clock_divider", { "minecraft:cardinal_direction": "north", "wr:on": false });
dim.place(cdDst, "wr:clock_divider", { "minecraft:cardinal_direction": "north", "wr:on": false });
setClockDivDp(cdSrc, 12);
const cfgClockComp = blockComponents.get("wr:clock_divider");
cfgClockComp.onPlayerInteract({ block: dim.getBlock(cdSrc), player: toolPlayer });
check("divisor をコピーした", cfg.clipboardOf()?.values?.["wr:div"], 12);
toolPlayer.isSneaking = true;
cfgClockComp.onPlayerInteract({ block: dim.getBlock(cdDst), player: toolPlayer });
toolPlayer.isSneaking = false;
check("貼り付け先の divisor に写った", timingMod.clockDivisorOf(dim.getBlock(cdDst)), 12);

// **道具を持っていなければ従来どおり設定UIが開く**（コピー機が邪魔をしない）
resetForms();
const bareLoc = at(553, 5, 0);
dim.place(bareLoc, "wr:threshold", {
  "minecraft:cardinal_direction": "north", "wr:on": false,
});
setThresholdDp(bareLoc, 5, 5);
const barePlayer = fakePlayer("bare", undefined, "minecraft:stick");
barePlayer.setHeld(new ItemStack("minecraft:stick"));
queueResponse({ canceled: false, formValues: [9, 9] });
blockComponents.get("wr:threshold").onPlayerInteract({ block: dim.getBlock(bareLoc), player: barePlayer });
await settle(4);
check("素手なら設定UIが開く", shownForms.length > 0, true);

// ---- 置いた／壊した瞬間に隣を起こす -----------------------------------------

section("接続の腕: バニラのブロックを置いた瞬間に形が変わる");
// **バニラのブロックを隣に置いても、ワイヤーには何のイベントも来ない。**
// 置いた側から周囲を起こしていないと、次のポーリング（4 tick）まで形が変わらない。
{
  const wLoc = at(560, 5, 0);
  dim.place(at(560, 4, 0), "minecraft:stone"); // 支え
  dim.place(wLoc, "wr:wire", {
    "minecraft:block_face": "up", "wr:power": 0, "wr:color": 0,
    "wr:c0": false, "wr:c1": false, "wr:c2": false, "wr:c3": false, "wr:glow": false,
  });
  blockComponents.get("wr:wire").onTick({ block: dim.getBlock(wLoc) });
  advanceTicks(2);
  // ARM_WORLD.up の c0 は north。north にレバー（VANILLA_CONNECTABLE）を置く
  check("置く前は腕が無い", stateOf(wLoc, "wr:c0"), false);

  const placed = dim.place(at(560, 5, -1), "minecraft:lever");
  // **onTick は呼ばない。** イベントだけで形が変わることを確かめる
  world.afterEvents.playerPlaceBlock.emit({
    block: placed,
    player: fakePlayer("wake", undefined, "minecraft:lever"),
  });
  advanceTicks(2);
  check("置いた瞬間に腕が立つ（ポーリングを待たない）", stateOf(wLoc, "wr:c0"), true);

  // 壊したときも同じ
  dim.place(at(560, 5, -1), "minecraft:air");
  world.afterEvents.playerBreakBlock.emit({
    block: dim.getBlock(at(560, 5, -1)),
    dimension: dim,
    player: fakePlayer("wake2", undefined, "minecraft:stick"),
  });
  advanceTicks(2);
  check("壊した瞬間に腕が消える", stateOf(wLoc, "wr:c0"), false);
}

// ---- 実測プロファイラ -------------------------------------------------------

section("wr:profile: 再計算の回数と時間を数えている");
// **既定では止まっていること。** 常時オンだと Date.now() を毎回 2 回呼ぶので、
// 測るために重くするという本末転倒になる。
{
  const prof = await import("./scripts/propagation_helper.js");
  check("既定では止まっている", prof.isProfiling(), false);

  prof.startProfiling();
  check("開始できる", prof.isProfiling(), true);

  // 適当なブロックを何回か再計算させる（定数電源は入力を読まないので onTick が無い）
  const pLoc = at(570, 5, 0);
  dim.place(pLoc, "wr:lamp", { "wr:light": 0, "wr:color": 0 });
  const pComp = blockComponents.get("wr:lamp");
  for (let i = 0; i < 5; i += 1) {
    pComp.onTick({ block: dim.getBlock(pLoc) });
    advanceTicks(1);
  }

  const stats = prof.stopProfiling();
  check("止められる", prof.isProfiling(), false);
  check("再計算を数えている", stats.runs >= 5, true);
  check("tick 数を数えている", stats.ticks >= 5, true);
  check("1tick あたりの回数が出る", stats.runsPerTick > 0, true);
  check("時間はマイナスにならない", stats.msPerTick >= 0, true);
}

// ---- バージョン表示 ---------------------------------------------------------

section("/scriptevent wr:version が manifest と一致する");
// **ズレると診断コマンドが嘘をつく。**
// 「入れ直したのに直っていない」を切り分ける唯一の手がかりなので、
// ここが信用できないと原因にたどり着けない。
{
  const devSrc = fs.readFileSync(path.join(DST, "dev.js"), "utf8");
  const inScript = devSrc.match(/const SCRIPT_VERSION = "([\d.]+)";/)?.[1];
  const manifest = JSON.parse(
    fs.readFileSync(path.join(SRC, "..", "manifest.json"), "utf8").replace(/^﻿/, "")
  );
  check("SCRIPT_VERSION が書かれている", typeof inScript, "string");
  check("manifest と一致している", inScript, manifest.header.version.join("."));
}

// ---- 再計算スコープのキャッシュ ---------------------------------------------
//
// 1 回の再計算のあいだ、隣ハンドルと導出結果（typeId・ステート）を覚えている。
// **正しさは「書き込んだら導出結果を全部捨てる」の 1 点にかかっている**ので、
// そこを直接確かめる。ここが緩むと「切ったのに点いたまま」の類の不具合に化ける。

section("キャッシュ: 書き込んだら次の読み取りに反映される");
const cacheUtil = await import("./scripts/util.js");
const cacheProp = await import("./scripts/propagation_helper.js");
const cacheLoc = at(600, 20, 0);
dim.place(cacheLoc, "wr:constant", { "wr:power": 3 });

check("スコープの外では効いていない", cacheUtil.neighborCacheActive(), false);
cacheUtil.withNeighborCache(() => {
  check("スコープの中では効いている", cacheUtil.neighborCacheActive(), true);
  const b = dim.getBlock(cacheLoc);
  check("書き込み前の値が読める", cacheUtil.stateOf(b, "wr:power"), 3);
  cacheProp.applyStates(b, { "wr:power": 9 });
  check("書き込んだら新しい値が見える", cacheUtil.stateOf(b, "wr:power"), 9);

  check("typeId が読める", cacheUtil.typeIdOf(b), "wr:constant");
  b.setType("minecraft:air");
  cacheUtil.invalidateFacts();
  check("置き換えたら新しい typeId が見える", cacheUtil.typeIdOf(b), "minecraft:air");
});
check("スコープを抜けたら破棄されている", cacheUtil.neighborCacheActive(), false);

section("キャッシュ: 貼り直した面がその tick の腕に反映される");
// ensureSupport が block_face を書き換えたあと、**同じ再計算の中で** armStates が
// faceOf() を読む。ここでキャッシュを捨て損ねると、古い面で腕を計算してしまう。
//   block_face=up（支えは下）だが下は空気。北に石があるので south へ貼り直される。
//   ARM_WORLD.up  の c0 は north、ARM_WORLD.south の c0 は up。
//   真上にワイヤーを置いてあるので、正しく貼り直せていれば c0 が立つ。
const armLoc = at(600, 21, 0);
dim.place(at(600, 21, -1), "minecraft:stone"); // 北の支え
dim.place(at(600, 22, 0), "wr:wire", {
  "minecraft:block_face": "south", "wr:power": 0, "wr:color": 0,
  "wr:c0": false, "wr:c1": false, "wr:c2": false, "wr:c3": false, "wr:glow": false,
});
dim.place(armLoc, "wr:wire", {
  "minecraft:block_face": "up", // 嘘の面（下に支えは無い）
  "wr:power": 0, "wr:color": 0,
  "wr:c0": false, "wr:c1": false, "wr:c2": false, "wr:c3": false, "wr:glow": false,
});
blockComponents.get("wr:wire").onTick({ block: dim.getBlock(armLoc) });
advanceTicks(1);
check("北の壁へ貼り直される", stateOf(armLoc, "minecraft:block_face"), "south");
check("貼り直した面で腕が立つ", stateOf(armLoc, "wr:c0"), true);

// ---- ガイドブック -----------------------------------------------------------

section("ガイドブック");
resetForms();
const bookPlayer = fakePlayer("book", undefined, "wr:guide_book");
queueResponse({ canceled: false, selection: 3 }); // 目次 → 4 章目
queueResponse({ canceled: true }); // 章を閉じる
itemComponents.get("wr:guide_book").onUse({ source: bookPlayer, itemStack: new ItemStack("wr:guide_book") });
await settle(3);
check("目次と章の 2 画面が開いた", shownForms.length, 2);
check("目次に 18 章ぶんのボタンがある", shownForms[0]?.buttons?.length, 18);
check("開いた章に本文がある", (shownForms[1]?.body?.length ?? 0) > 0, true);

// ---- 循環配線 ---------------------------------------------------------------

section("安定性: 循環配線でもクラッシュしない");
const ring = [];
for (const [x, z] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
  const loc = at(x + 100, 40, z);
  dim.place(at(loc.x, loc.y - 1, loc.z), "minecraft:stone");
  dim.place(loc, "wr:wire", { "minecraft:block_face": "up", "wr:power": 0 });
  ring.push(loc);
}
// リングの 1 箇所に電源を刺す
dim.place(at(99, 40, 0), "minecraft:redstone_block", {}, 15);
let crashed = null;
try {
  pump(ring, 60);
} catch (e) {
  crashed = String(e);
}
check("例外なく 60 tick 回った", crashed, null);
const ringPowers = ring.map((loc) => stateOf(loc, "wr:power"));
check("リングの電力が 0〜15 に収まっている", ringPowers.every((p) => p >= 0 && p <= 15), true);
console.log(`  (リングの電力: ${ringPowers.join(", ")})`);

// ---- 結果 -------------------------------------------------------------------

section("スクリプトが例外を握り潰していない");
check("握り潰された失敗が 1 件も無い", swallowed.length, 0);
for (const line of swallowed.slice(0, 5)) console.error("    " + line);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
