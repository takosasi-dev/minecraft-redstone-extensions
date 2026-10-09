/**
 * 共通伝播ロジック（仕様書「共通伝播ロジック（安定性対策込み・全ブロック必須）」）
 *
 * 即時反応型ブロック（送信・ワイヤー・コーナー・パルス生成機・論理回路）は
 * すべてこのモジュールを経由して再計算する。
 *
 *   1. 入力変化を検知したら、その場でパーミュテーションを書き換えず、
 *      まず「更新予約済み」フラグ（pending Set にブロックの一意キーを入れる）を立てる。
 *      すでに立っていれば何もしない = 同一 tick 内の二重予約防止。
 *   2. system.run() で次 tick に実際の再計算とパーミュテーション更新を行う。
 *      同期的に隣接ブロックの更新を連鎖させないので、循環配線を組んでも
 *      無限再帰やスタックオーバーフローには構造的にならない。
 *   3. 更新処理が終わったらフラグを解除する。
 *   4. 出力値が変化したときだけパーミュテーションを更新する。
 *
 * これは「即時性より安定性を優先する」という設計判断である。
 * 結果として反応は最短でも 1 tick 遅れるが、循環配線を組んでもゲームは落ちず、
 * バニラのレッドストーンと同じように「発振し続けるだけ」で収まる。
 *
 * 入力変化の検知手段について:
 *   当初は minecraft:redstone_consumer の onRedstoneUpdate で検知していたが、
 *   エンジンが「1 つのブロックが redstone_producer と redstone_consumer の
 *   両方を持つこと」を禁止しているため、出力を持つブロックでは使えない
 *   （「Block cannot have both "minecraft:redstone_producer" and
 *     "minecraft:redstone_consumer" components.」でブロックごと読み込み失敗する）。
 *   そのため検知は minecraft:tick のポーリングに移し、
 *   そこから先の伝播は scheduleNeighbors() の明示的な連鎖で行っている。
 */

import { system } from "@minecraft/server";
import { blockKey, FACES, neighborBlock, withNeighborCache, invalidateFacts } from "./util.js";

/** 更新予約済みブロックの一意キー。手順 1 の一時フラグ本体。 */
const pending = new Set();

/**
 * typeId → 再計算関数の対応表。
 *
 * エンジンの制約で「1 つのブロックが redstone_producer と redstone_consumer の
 * 両方を持つ」ことができないため、出力を持つブロックは onRedstoneUpdate を
 * 受け取れない（consumer が付けられない）。
 * 代わりに
 *   - minecraft:tick のポーリング … バニラ側の変化に気づくための入口
 *   - 下の scheduleNeighbors()    … そこから先の伝播
 * の 2 段構えにしている。この表は後者で「隣は何のブロックで、
 * どの関数で再計算すればいいか」を引くために使う。
 */
const updaters = new Map();

/** ブロック種別ごとの再計算関数を登録する。各モジュールが起動時に呼ぶ。 */
export function registerUpdater(typeId, recompute) {
  updaters.set(typeId, recompute);
}

/** 登録済みの再計算関数でそのブロックの更新を予約する。 */
export function scheduleByType(block) {
  const recompute = updaters.get(block?.typeId);
  if (recompute) scheduleUpdate(block, recompute);
}

/**
 * 隣接する wr: ブロックの再計算を予約する。
 *
 * 出力値が実際に変わったときだけ呼ぶこと。呼ばれた側も「変化したときだけ」
 * さらに隣を予約するので、値が落ち着いたところで自然に連鎖が止まる。
 * 予約は 1 tick 後に実行されるため、連鎖しても再帰にはならない。
 */
export function scheduleNeighbors(block) {
  for (const face of FACES) {
    const nb = neighborBlock(block, face);
    if (nb && updaters.has(nb.typeId)) scheduleByType(nb);
  }
}

/**
 * ブロックの再計算を次 tick に 1 回だけ予約する。
 *
 * @param {import("@minecraft/server").Block} block
 * @param {(block: import("@minecraft/server").Block) => void} recompute
 *        次 tick に呼ばれる再計算関数。ブロックは取り直したものが渡される。
 */
export function scheduleUpdate(block, recompute) {
  let dimension, location, typeId;
  try {
    dimension = block.dimension;
    location = { x: block.location.x, y: block.location.y, z: block.location.z };
    typeId = block.typeId;
  } catch {
    // すでに壊されている等でブロック参照が無効
    return;
  }

  const key = blockKey(dimension.id, location);
  if (pending.has(key)) return; // 手順 1: 二重予約しない
  pending.add(key);

  system.run(() => {
    pending.delete(key); // 手順 3
    let fresh;
    try {
      fresh = dimension.getBlock(location);
    } catch {
      return; // チャンクが落ちた
    }
    // 1 tick の間に壊された／別のブロックに置き換わった場合は何もしない
    if (!fresh || fresh.typeId !== typeId) return;
    const started = profiling ? Date.now() : 0;
    try {
      // 再計算のあいだだけ隣接取得をキャッシュする。
      // 同じ隣を何度も offset() で取り直していたのを 1 回にまとめるためのもので、
      // スコープを 1 回の同期処理に限っているので動作は変わらない。
      // 詳しくは util.js の withNeighborCache のコメント。
      withNeighborCache(() => recompute(fresh));
    } catch (e) {
      console.warn(`[wr] recompute failed at ${key}: ${e}`);
    }
    if (profiling) {
      profileMs += Date.now() - started;
      profileRuns += 1;
    }
  });
}

// ---------------------------------------------------------------------------
// 実測プロファイラ（/scriptevent wr:profile）
// ---------------------------------------------------------------------------
//
// 「重いのはこのアドオンのせいか？」に答えるには、
// ブロック数から見積もるより **実際にかかっている時間を測る**ほうが確実。
// 1 tick の予算は 50ms（20 TPS）なので、ここが何 ms を占めているかが分かれば
// 主因かどうかを推測ではなく事実で言える。
//
// **既定では止めてある。** Date.now() を毎回の再計算で 2 回呼ぶので、
// 常時オンにすると測るために重くするという本末転倒になる。

let profiling = false;
let profileMs = 0;
let profileRuns = 0;
let profileStartTick = 0;

export function startProfiling() {
  profiling = true;
  profileMs = 0;
  profileRuns = 0;
  profileStartTick = system.currentTick;
}

/** @returns {{ticks:number, ms:number, runs:number, msPerTick:number, runsPerTick:number}} */
export function stopProfiling() {
  profiling = false;
  const ticks = Math.max(1, system.currentTick - profileStartTick);
  return {
    ticks,
    ms: profileMs,
    runs: profileRuns,
    msPerTick: profileMs / ticks,
    runsPerTick: profileRuns / ticks,
  };
}

export function isProfiling() {
  return profiling;
}

/**
 * 手順 4。指定したステートが 1 つでも変化していれば setPermutation する。
 * 変化がなければ何もせず false を返す（無駄な更新＝無駄な近隣通知を出さない）。
 *
 * @returns {boolean} 実際に更新したか
 */
export function applyStates(block, states) {
  let perm;
  try {
    perm = block.permutation;
  } catch {
    return false;
  }

  let changed = false;
  for (const [name, value] of Object.entries(states)) {
    if (perm.getState(name) !== value) {
      changed = true;
      break;
    }
  }
  if (!changed) return false;

  let next = perm;
  for (const [name, value] of Object.entries(states)) {
    next = next.withState(name, value);
  }
  try {
    block.setPermutation(next);
  } catch (e) {
    console.warn(`[wr] setPermutation failed: ${e}`);
    return false;
  }
  // ワールドを書き換えた。再計算スコープが覚えている導出結果は全部捨てる
  // （util.js の factsCache のコメント参照）。
  invalidateFacts();
  return true;
}

/** テスト・デバッグ用。予約中のキー数。 */
export function pendingCount() {
  return pending.size;
}
