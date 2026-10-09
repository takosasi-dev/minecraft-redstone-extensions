/**
 * パートB: 壁・天井対応ワイヤー ＋ 段差コーナーブロック
 *   B-1 wr:wire          6 面どこにでも這わせられるワイヤー。受電値 -1 を出力
 *   B-2 wr:corner_riser  減衰なしで電力を素通しする立方体
 *
 * ワイヤーは染料で 16 色に染められる。色は見た目だけでなく接続にも効いていて、
 * **ワイヤー同士は同じ色のときしか繋がらない**。
 * 隣り合わせても混線しないので、並走するバス配線が組める。
 * ワイヤー以外（電源・論理回路・コーナーなど）との接続は色に関係なく行われる。
 *
 * ---------------------------------------------------------------------------
 * 電力の求め方（2 つの落とし穴への対処）
 * ---------------------------------------------------------------------------
 *
 * (1) バニラのブロックからの「反射」を無視する
 *
 *   バニラの固体ブロックは、こちらが redstone_producer で与えた電力を
 *   getRedstonePower() から減衰なしでそのまま返してくる
 *   （実機確認: コーナーが 13 を出すと隣の土が raw=13 を返す）。
 *   これを入力として読むと、電源を切っても自分の電力を読み返し続ける。
 *
 *   対処: **自分の出力以下しか出していないバニラブロックは無視する。**
 *   バニラからの入力には必ず -1 を掛けるので、本物の電源なら必ず
 *   「自分の出力より大きい」側に来る。取りこぼしは起きない。
 *
 *   ここで比べる「自分の出力」は現在値だけでは足りない。
 *   網が 0 に落ちた直後はバニラ側がまだ古い電力を返しているので、
 *   現在値 0 と比べると反射が通ってしまい、
 *   0 → 13 → 0 → 12 … とクロック回路のようにガタつく。
 *   そのため **直前に出していた値も一定時間おぼえておき、大きい方と比べる**。
 *
 *   なお wr: ブロック同士はステートを直接読んでいて反射しないので、
 *   この判定も減衰も不要（＝電源の値がそのまま伝わる）。
 *
 * (2) 1 マスずつしか値が動かない「さざ波」をなくす
 *
 *   隣の古い値を読んで -1 する方式だと、電源を切ったときに
 *   14 → 13 → 12 … と 1 tick に 1 段ずつしか落ちず、
 *   長い配線だと消えるまでに十数 tick かかる。
 *
 *   対処: 値が変わるときは自分だけ直すのではなく、
 *   **繋がっているワイヤー網全体を 1 回のパスで計算し直す**（recomputeNetwork）。
 *   外部電源からの多点 BFS なので、点灯も消灯も 1 回で正しい値に落ち着く。
 */

import { ItemStack, EquipmentSlot, GameMode, system } from "@minecraft/server";
import {
  FACES,
  OPPOSITE,
  neighborBlock,
  powerFrom,
  clampPower,
  isOurs,
  blockKey,
  typeIdOf,
  stateOf,
  invalidateFacts,
} from "./util.js";
import {
  scheduleUpdate,
  applyStates,
  registerUpdater,
  scheduleNeighbors,
} from "./propagation_helper.js";
import { colorFromDye, colorNameKey } from "./colors.js";
import { ensureSupport, faceOf } from "./surface.js";
// 腕がどのワールド方位を向くかの対応表。ジオメトリと同じ生成器が書き出すので、
// モデルとこの表がズレることはない（tools/generate_wire_geometry.js）。
import { ARM_WORLD, ARM_OPPOSITE, ARM_SLOTS } from "./wire_arms.js";

/** 1 回の再計算で辿るワイヤー網の最大ブロック数（暴走よけ）。 */
const NETWORK_LIMIT = 512;

/**
 * バニラ側で「繋がって見えてほしい」ブロックの判定。
 * 網羅リストを持つと更新が大変なので識別子の部分一致で見る。
 * ここで拾えなくても通電自体には影響しない（見た目だけの話）。
 */
const VANILLA_CONNECTABLE = [
  "redstone", "repeater", "comparator", "lever", "button", "pressure_plate",
  "piston", "observer", "lamp", "door", "rail", "dispenser", "dropper",
  "hopper", "noteblock", "tnt", "target", "daylight", "sculk_sensor",
  "lightning_rod", "bell", "tripwire",
];

// ここは再計算のたびに何百回も通るので、ステートと typeId は
// util.js のスコープキャッシュ経由で読む（同じブロックの読み直しを潰すため）。

/** そのワイヤーの色。ステートが読めない場合は既定色（0 = レッド）扱い。 */
function colorOf(block) {
  const color = stateOf(block, "wr:color");
  return typeof color === "number" ? color : 0;
}

/** そのブロックが今出している電力。 */
function outputOf(block) {
  const power = stateOf(block, "wr:power");
  return typeof power === "number" ? power : 0;
}

const isWire = (b) => !!b && typeIdOf(b) === "wr:wire";
const isRiser = (b) => !!b && typeIdOf(b) === "wr:corner_riser";

/** ワイヤー網として繋がっているか（ワイヤー同士は同色のときだけ）。 */
function linked(a, b) {
  if (!a || !b) return false;
  if (isWire(a) && isWire(b)) return colorOf(a) === colorOf(b);
  return (isWire(a) || isRiser(a)) && (isWire(b) || isRiser(b));
}

// ---------------------------------------------------------------------------
// 入力の読み取り
// ---------------------------------------------------------------------------

/**
 * 直前に出していた電力の記憶。key → { power, tick }
 *
 * バニラ側が返してくる電力は 1 tick ほど遅れて追従するので、
 * 「今 0 でも、さっきまで 14 を出していた」ことを覚えていないと
 * 古い反射を本物の入力として拾ってしまう。
 */
const recentOutput = new Map();
const RECENT_TTL_TICKS = 8;

function rememberOutput(key, power) {
  if (power > 0) recentOutput.set(key, { power, tick: system.currentTick });
  else recentOutput.delete(key);
}

/** 反射とみなす上限。現在の出力と、少し前まで出していた値の大きい方。 */
function reflectionFloor(block) {
  const current = outputOf(block);
  const remembered = recentOutput.get(blockKey(block.dimension.id, block.location));
  if (!remembered) return current;
  if (system.currentTick - remembered.tick > RECENT_TTL_TICKS) return current;
  return Math.max(current, remembered.power);
}

/**
 * 1 面ぶんの入力。網の外からの電力だけを返す。
 *
 * @param floor      反射とみなす上限（reflectionFloor）
 * @param skipLinked 網の内側（同じ再計算で扱うブロック）は 0 を返す
 */
function externalAt(block, face, floor, { riser, color, skipLinked }) {
  const nb = neighborBlock(block, face);
  if (!nb) return 0;
  if (skipLinked && linked(block, nb)) return 0;

  if (isOurs(nb)) {
    if (isWire(nb) && !riser && colorOf(nb) !== color) return 0; // 色違いとは繋がらない
    const value = powerFrom(block, face); // 指向性ブロックの前面判定は共通ヘルパーに任せる
    // ステートを直接読んでいるので反射しない。減衰が要るのは
    //   ・ワイヤー → ワイヤー / コーナー（バニラのダストと同じ 1 減衰）
    //   ・コーナー → コーナー（減衰ゼロだと相互ラッチする）
    // だけで、電源系（定数電源・受信機・論理回路）からは値がそのまま伝わる。
    const decays = riser ? isRiser(nb) : isWire(nb) || isRiser(nb);
    return decays ? value - 1 : value;
  }

  let raw = 0;
  try {
    raw = nb.getRedstonePower() ?? 0;
  } catch {
    return 0;
  }
  // 自分が与えた電力が返ってきているだけなら無視する（上のコメント (1)）
  if (raw <= floor) return 0;
  // バニラからの入力は必ず 1 落とす。こうしておくと出力が必ず読んだ値より小さくなり、
  // 上の反射判定が本物の電源を取りこぼすことがなくなる。
  return raw - 1;
}

/** 網の外から届いている電力の最大値。 */
function externalPower(block, opts) {
  const floor = reflectionFloor(block);
  let best = 0;
  for (const face of FACES) {
    const value = externalAt(block, face, floor, opts);
    if (value > best) best = value;
  }
  return best;
}

// ---------------------------------------------------------------------------
// ワイヤー網の一括再計算
// ---------------------------------------------------------------------------

/** 同じ tick に同じ網を何度も計算し直さないための印。 */
const recomputedThisTick = new Set();
let tickGuardStarted = false;

function startTickGuard() {
  if (tickGuardStarted) return;
  tickGuardStarted = true;
  system.runInterval(() => recomputedThisTick.clear(), 1);
}

/** 連結しているワイヤー／コーナーを集める。 */
function collectNetwork(start) {
  const nodes = new Map();
  const stack = [start];
  while (stack.length > 0 && nodes.size < NETWORK_LIMIT) {
    const block = stack.pop();
    const key = blockKey(block.dimension.id, block.location);
    if (nodes.has(key)) continue;
    nodes.set(key, block);
    for (const face of FACES) {
      const nb = neighborBlock(block, face);
      if (!nb || !linked(block, nb)) continue;
      const k = blockKey(nb.dimension.id, nb.location);
      if (!nodes.has(k)) stack.push(nb);
    }
  }
  return nodes;
}

/**
 * 繋がっているワイヤー網を丸ごと計算し直す。
 *
 * 外部電源を種にした多点の最大値伝播（辺のコストはワイヤーに入るとき 1、
 * コーナーに入るときは 0、コーナー同士は 1）。値は 0〜15 に収まるので
 * 高々 16 周で収束する。
 */
function recomputeNetwork(start) {
  startTickGuard();
  const startKey = blockKey(start.dimension.id, start.location);
  if (recomputedThisTick.has(startKey)) return;

  const nodes = collectNetwork(start);
  const keys = [...nodes.keys()];
  for (const key of keys) recomputedThisTick.add(key);

  // 種: 網の外から入ってくる電力（減衰は externalAt が済ませている）
  const value = new Map();
  for (const [key, block] of nodes) {
    const opts = { riser: isRiser(block), color: colorOf(block), skipLinked: true };
    value.set(key, clampPower(externalPower(block, opts)));
  }

  // 網の中を伝播させる
  for (let round = 0; round < 16; round += 1) {
    let changed = false;
    for (const [key, block] of nodes) {
      let best = value.get(key);
      for (const face of FACES) {
        const nb = neighborBlock(block, face);
        if (!nb || !linked(block, nb)) continue;
        const nk = blockKey(nb.dimension.id, nb.location);
        const from = value.get(nk);
        if (from === undefined) continue;
        // ワイヤーに入るときは 1 減衰。コーナーに入るときは、
        // 相手がコーナーなら 1、ワイヤーなら 0（素通し）。
        const cost = isRiser(block) ? (isRiser(nb) ? 1 : 0) : 1;
        const candidate = from - cost;
        if (candidate > best) best = candidate;
      }
      if (best !== value.get(key)) {
        value.set(key, clampPower(best));
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 反映。変わったノードの周りの wr: ブロック（論理回路など）にも再計算させる
  for (const [key, block] of nodes) {
    const next = value.get(key);
    // 下げる前の値をおぼえておく。バニラ側の反射は 1 tick ほど遅れて追従するので、
    // これが無いと落とした直後に古い反射を拾ってガタつく。
    rememberOutput(key, Math.max(outputOf(block), next));
    const patch = { "wr:power": next };
    if (isWire(block)) Object.assign(patch, armStates(block, colorOf(block)));
    if (applyStates(block, patch)) scheduleNeighbors(block);
  }
}

// ---------------------------------------------------------------------------
// B-1. ワイヤー
// ---------------------------------------------------------------------------

/**
 * 板がどの面に貼りつくかは minecraft:block_face ステートで決まるが、
 * このステートは「設置時にクリックした面」でしかなく、板が実際に接している面と
 * ズレることがある。その補正（支持面の自動吸着）は surface.js に切り出してある。
 * 経緯と症状はそちらの先頭コメントを参照。
 */

function popOff(block) {
  const dimension = block.dimension;
  const { x, y, z } = block.location;
  try {
    block.setType("minecraft:air");
    invalidateFacts(); // ワールドを書き換えたので導出結果は捨てる
    dimension.spawnItem(new ItemStack("wr:wire", 1), { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
  } catch (e) {
    console.warn(`[wr] wire pop-off failed: ${e}`);
  }
}

/** その方位の隣接ブロックと「繋がって見える」か。 */
function connectsTo(block, worldFace, color) {
  const nb = neighborBlock(block, worldFace);
  if (!nb || nb.isAir) return false;
  if (isWire(nb)) return colorOf(nb) === color; // 同色のワイヤーだけ
  if (isOurs(nb)) return true; // コーナー・論理回路・送受信機などは繋ぐ
  return VANILLA_CONNECTABLE.some((k) => nb.typeId.includes(k));
}

/**
 * 接続の腕（wr:cn / cs / ce / cw）を求める。
 * バニラのダストに合わせて、1 本も繋がっていなければ「点」、
 * 1 本だけなら反対側も出して「直線」に見せる。
 */
function armStates(block, color) {
  const map = ARM_WORLD[faceOf(block)] ?? ARM_WORLD.up;

  const arms = {};
  for (const slot of ARM_SLOTS) arms["wr:" + slot] = false;

  let count = 0;
  let only;
  for (const slot of ARM_SLOTS) {
    if (connectsTo(block, map[slot], color)) {
      arms["wr:" + slot] = true;
      count += 1;
      only = slot;
    }
  }
  if (count === 1) arms["wr:" + ARM_OPPOSITE[only]] = true;
  return arms;
}

function updateWire(block) {
  // 支持面が本物か先に確かめる。ズレていれば貼り直し、どこにも支えが無ければ落とす。
  if (ensureSupport(block) === "none") {
    popOff(block);
    return;
  }
  const color = colorOf(block);

  // 見た目（接続の腕）は自分だけで決まるので先に更新する
  applyStates(block, armStates(block, color));

  // 電力が動くなら、自分だけ直さずに網ごと計算し直す。
  // こうしないと 1 tick に 1 段ずつしか値が動かず、消えるのが遅くなる。
  let best = externalPower(block, { riser: false, color, skipLinked: true });
  for (const face of FACES) {
    const nb = neighborBlock(block, face);
    if (!nb || !linked(block, nb)) continue;
    const candidate = outputOf(nb) - 1;
    if (candidate > best) best = candidate;
  }
  if (clampPower(best) !== outputOf(block)) recomputeNetwork(block);
}
registerUpdater("wr:wire", updateWire);

/** 手持ちを 1 個消費する（クリエイティブでは消費しない）。 */
function consumeHeldItem(player) {
  try {
    if (player.getGameMode?.() === GameMode.Creative) return;
  } catch {
    // getGameMode が使えない環境ではそのまま消費する
  }
  try {
    const equippable = player.getComponent("minecraft:equippable");
    const item = equippable?.getEquipment(EquipmentSlot.Mainhand);
    if (!item) return;
    if (item.amount > 1) {
      item.amount -= 1;
      equippable.setEquipment(EquipmentSlot.Mainhand, item);
    } else {
      equippable.setEquipment(EquipmentSlot.Mainhand, undefined);
    }
  } catch (e) {
    console.warn(`[wr] consume failed: ${e}`);
  }
}

/**
 * 発光モードの切り替え。
 *
 * 光の強さは電力そのもの（wr:glow が立っているワイヤーの
 * minecraft:light_emission = wr:power）なので、消灯中のワイヤーは光らない。
 * ワイヤーは 1 マスごとに 1 減衰するため、長く伸ばすと自然に暗くなっていく。
 */
function toggleGlow(block, player) {
  const next = block.permutation.getState("wr:glow") !== true;
  if (!applyStates(block, { "wr:glow": next })) return;
  if (next) consumeHeldItem(player); // OFF に戻すときは返さない代わりに消費もしない
  player.onScreenDisplay.setActionBar({
    translate: next ? "wr.msg.wire.glow.on" : "wr.msg.wire.glow.off",
  });
}

function heldItem(player) {
  try {
    return player.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Mainhand);
  } catch {
    return undefined;
  }
}

export const wireComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateWire);
    // 隣のワイヤーの接続形状も変わるので、まとめて描き直させる
    scheduleNeighbors(e.block);
  },
  onPlayerDestroy(e) {
    // 壊した跡地の隣も繋がりが変わる
    scheduleNeighbors(e.block);
  },
  // minecraft:tick（4 tick 間隔）。支持面の消失チェックと、
  // バニラ側の電力変化に気づくためのポーリングを兼ねる。
  // （出力を持つブロックには redstone_consumer を付けられないので
  //   onRedstoneUpdate は使えない。propagation_helper.js の先頭コメント参照）
  onTick(e) {
    scheduleUpdate(e.block, updateWire);
  },
  /**
   * 染料を持って右クリックすると色が変わる。
   * グロウストーンダストなら発光モードのトグル（ON にするときだけ 1 個消費）。
   */
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;
    const item = heldItem(player);

    if (item?.typeId === "minecraft:glowstone_dust") {
      toggleGlow(e.block, player);
      return;
    }

    const color = colorFromDye(item?.typeId);
    if (color === undefined) return;
    if (colorOf(e.block) === color) return;

    applyStates(e.block, { "wr:color": color });
    consumeHeldItem(player);
    // 色が変わると繋がる相手も変わるので、自分と隣接ワイヤーを再計算させる
    scheduleUpdate(e.block, updateWire);
    for (const face of FACES) {
      const nb = neighborBlock(e.block, face);
      if (isWire(nb)) scheduleUpdate(nb, updateWire);
    }
    player.onScreenDisplay.setActionBar({
      translate: "wr.msg.wire.dyed",
      with: { rawtext: [{ translate: colorNameKey(color) }] },
    });
  },
};

// ---------------------------------------------------------------------------
// B-2. 段差コーナーブロック
// ---------------------------------------------------------------------------

function updateCornerRiser(block) {
  let best = externalPower(block, { riser: true, color: undefined, skipLinked: true });
  for (const face of FACES) {
    const nb = neighborBlock(block, face);
    if (!nb || !linked(block, nb)) continue;
    const candidate = outputOf(nb) - (isRiser(nb) ? 1 : 0);
    if (candidate > best) best = candidate;
  }
  if (clampPower(best) !== outputOf(block)) recomputeNetwork(block);
}
registerUpdater("wr:corner_riser", updateCornerRiser);

export const cornerRiserComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateCornerRiser);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateCornerRiser);
  },
};

export { consumeHeldItem, heldItem };
