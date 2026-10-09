/**
 * 面に貼りつく薄板ブロック（wr:wire / wr:light_panel）が共有する支持面ロジック。
 *
 * ---------------------------------------------------------------------------
 * なぜ block_face を鵜呑みにできないのか
 * ---------------------------------------------------------------------------
 * 板の向きは minecraft:placement_position トレイトの
 * minecraft:block_face ステートで決まるが、このステートは
 * **「設置時にプレイヤーがクリックした面」** でしかない。
 * 狙った壁とは別のものをクリックして置くと、板が接している面とズレる。
 *
 * 実機で出た症状（v1.12.0 で修正）はこれ。壁にワイヤーを縦に伸ばそうとして
 * 1 つ下のワイヤー（当たり判定が壁いっぱいの板なのでクリックしやすい）を
 * クリックすると block_face が up になり、
 *   ・板が床向きになって壁から離れて浮く
 *   ・腕の向きが上下ではなく南北東西になって、繋がっている方向と合わない
 * の 2 つが同時に起きる。
 *
 * そこで **block_face を鵜呑みにせず、実際に支えがある面に貼り直す**。
 * 設置直後だけでなく毎 tick 確かめるので、すでに置いてある板も
 * ワールドに入り直すだけで自動的に正しい面へ吸着する。
 */

import { world, system } from "@minecraft/server";
import { FACES, OPPOSITE, neighborBlock, typeIdOf, stateOf } from "./util.js";
import { applyStates, scheduleByType } from "./propagation_helper.js";

/** 支持面の優先順。床 → 壁 → 天井（バニラのダストの感覚に合わせる）。 */
const SUPPORT_PRIORITY = ["down", "north", "south", "east", "west", "up"];

/** このモジュールを使う 1px の薄板。互いの支えにはなれない。 */
const THIN_PLATES = new Set(["wr:wire", "wr:light_panel"]);

export const isThinPlate = (block) => !!block && THIN_PLATES.has(typeIdOf(block));

/**
 * その隣接ブロックが板を支えられるか。
 * 空気と液体だけを弾く保守的な条件にしている
 * （草・松明のような非固体ブロックまで弾くと、判定に使える安定 API が乏しく
 *   誤爆しやすいため）。薄板同士だけは例外で、厚み 1px なので支えにならない。
 */
function canSupport(nb) {
  if (!nb || nb.isAir || nb.isLiquid) return false;
  return !isThinPlate(nb);
}

/**
 * その位置で板を貼れる面（block_face の値）の一覧。
 *
 * 配線レンチ（wrench.js）が「次の向き」を選ぶのに使う。
 * ここに無い面を無理に書き込んでも、次の tick に ensureSupport() が
 * 支えの有る面へ引き戻すか落とすので、選ばせないほうが親切。
 */
export function placeableFaces(block) {
  const faces = [];
  for (const support of SUPPORT_PRIORITY) {
    if (canSupport(neighborBlock(block, support))) faces.push(OPPOSITE[support]);
  }
  return faces;
}

/**
 * 隣り合っている薄板が貼りついている面（支持方向）を、多い順に返す。
 *
 * 配線は同じ壁を伝っていくものなので、貼り直し先に迷ったら
 * 「隣の板と同じ壁」を選ぶのが意図に近い。
 */
function neighborPlateFaces(block) {
  const count = new Map();
  for (const f of FACES) {
    const nb = neighborBlock(block, f);
    if (!isThinPlate(nb)) continue;
    const support = OPPOSITE[faceOf(nb)];
    if (support) count.set(support, (count.get(support) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([face]) => face);
}

/** その板が記録している block_face。壊れていれば up 扱い。 */
export function faceOf(block) {
  const face = stateOf(block, "minecraft:block_face");
  return typeof face === "string" && OPPOSITE[face] ? face : "up";
}

/**
 * 支持面が本当にそこにあるか確かめ、無ければ貼り直す。
 *
 * @param block 対象の薄板ブロック
 * @returns {"ok"|"fixed"|"none"} none = どの面にも支えが無い
 */
export function ensureSupport(block) {
  const face = faceOf(block);
  const current = OPPOSITE[face];
  const supporter = neighborBlock(block, current);
  if (supporter === undefined) return "ok"; // 未ロード・ワールド外は判定不能
  if (canSupport(supporter)) return "ok";

  // 候補の順番:
  //   1. face 自身 … block_face の解釈が「クリックした面」ではなく
  //      「接している面」だった場合の保険。どちらの規約でも正しい面に落ち着く。
  //   2. 隣り合う薄板が貼りついている面 … 配線は同じ壁を伝っていくものなので、
  //      迷ったら「隣と同じ壁」を選ぶのが意図に近い。これが無いと
  //      SUPPORT_PRIORITY の先頭（床）に落ちて、壁の配線が床に寝てしまう。
  //   3. 固定の優先順（床 → 壁 → 天井）
  for (const support of [face, ...neighborPlateFaces(block), ...SUPPORT_PRIORITY]) {
    if (support === current) continue;
    if (!canSupport(neighborBlock(block, support))) continue;
    // 書けなかったときは落とさずそのままにしておく（見た目が崩れるだけで済ませる）
    return applyStates(block, { "minecraft:block_face": OPPOSITE[support] }) ? "fixed" : "ok";
  }
  return "none";
}

// ---------------------------------------------------------------------------
// 設置時の向き — プレイヤーがクリックした面をそのまま採用する
// ---------------------------------------------------------------------------
//
// ensureSupport() だけでは「壁に貼ろうとしたのに一定方向を向く」症状が直らない。
// あれは **記録されている支持面に何か置いてあれば、そのまま正しいと見なす**
// 作りなので、block_face が最初から間違っていても
// （床がある・裏に別のブロックがある等で）たまたま支えが見つかると直らない。
//
// 根っこは minecraft:placement_position トレイトの block_face が
// 期待どおりに入ってこないこと。そこでエンジンのステートを当てにせず、
// **プレイヤーが実際にクリックした面**を interact イベントで控えておき、
// 設置直後に上書きする。これなら
//   ・トレイトが正しく動いていれば同じ値なので何も起きない（applyStates が false）
//   ・動いていなければこちらが正しい向きに直す
// のどちらに転んでも壊れない。
//
// 面の向きの対応:
//   北の壁を見て右クリック → クリックしたのは壁の south 面
//   → 新しい板は壁の south 側のマスに置かれ、north 側（＝壁）に貼りつく
//   → SUPPORT_OF['south'] === 'north' なので block_face = 'south' が正しい。
//   つまり **block_face にはクリックした面をそのまま入れればよい**。

/** playerId → { face, tick }。設置イベントで引き当てるまでの一時記憶。 */
const lastClickedFace = new Map();

/** これ以上古いクリックは設置と結びつけない（別の操作とみなす）。 */
const CLICK_TTL_TICKS = 10;

/** Direction 列挙（"South" など）でも小文字の面名でも受け取れるようにする。 */
function normalizeFace(value) {
  if (typeof value !== "string") return undefined;
  const face = value.toLowerCase();
  return OPPOSITE[face] ? face : undefined;
}

export function registerPlacementTracking() {
  world.beforeEvents.playerInteractWithBlock?.subscribe((e) => {
    const player = e.player;
    if (!player) return;
    const clicked = normalizeFace(e.blockFace);
    if (!clicked) return;

    // クリックした相手が同じ薄板なら、その板が貼りついている面を引き継ぐ。
    // 壁づたいにワイヤーを伸ばすとき、隣のワイヤー（当たり判定が壁いっぱいの板なので
    // クリックしやすい）を叩いてしまっても向きが揃う。
    let face = clicked;
    try {
      if (isThinPlate(e.block)) face = faceOf(e.block);
    } catch {
      // ブロック参照が無効なら、クリック面をそのまま使う
    }
    lastClickedFace.set(player.id, { face, tick: system.currentTick });
  });

  world.afterEvents.playerPlaceBlock?.subscribe((e) => {
    if (!isThinPlate(e.block)) return;
    const recorded = lastClickedFace.get(e.player?.id);
    if (!recorded) return;
    if (system.currentTick - recorded.tick > CLICK_TTL_TICKS) return;
    applyStates(e.block, { "minecraft:block_face": recorded.face });
  });

  world.afterEvents.playerLeave?.subscribe((e) => {
    lastClickedFace.delete(e.playerId);
  });

  registerNeighborWakeups();
}

// ---------------------------------------------------------------------------
// 置いた／壊した瞬間に隣を起こす
// ---------------------------------------------------------------------------
//
// ワイヤーの接続の腕は「隣に繋がるものがあるか」で決まるが、
// **バニラのブロックを隣に置いても、ワイヤー側には何のイベントも来ない**。
// wr: ブロック同士なら onPlace が scheduleNeighbors() を呼ぶので即座に伝わるが、
// 相手がバニラだとその経路が無く、
// **次のポーリング（4 tick 間隔）まで形が変わらない**（最大 5 tick ≒ 0.25 秒）。
//
// 置いた・壊した瞬間にその周囲を起こしてやれば、この待ちが 1 tick になる。
// **イベント駆動なので、何もしていないときのコストは増えない**
// （ポーリング間隔を詰めて速くする案とはここが違う）。
//
// 起こす範囲を隣接 6 面に絞っているのは、
// ワイヤーの形は隣接しか見ていないため。広げても得るものが無い。

function wakeNeighborsAt(dimension, location) {
  let block;
  try {
    block = dimension.getBlock(location);
  } catch {
    return;
  }
  if (!block) return;
  for (const face of FACES) {
    const nb = neighborBlock(block, face);
    if (nb) scheduleByType(nb);
  }
}

function registerNeighborWakeups() {
  world.afterEvents.playerPlaceBlock?.subscribe((e) => {
    wakeNeighborsAt(e.block.dimension, e.block.location);
  });
  // 壊したほうは block が既に空気なので、座標から取り直して周囲を起こす
  world.afterEvents.playerBreakBlock?.subscribe((e) => {
    wakeNeighborsAt(e.dimension ?? e.block?.dimension, e.block.location);
  });
}
