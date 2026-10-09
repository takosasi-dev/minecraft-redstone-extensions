/**
 * パートI-1: 鉱石精錬機 (wr:ore_refiner)
 *
 * 上のチェストから素材を吸い出して「変換ポイント」に換え、
 * ためたポイントで下のチェストへ目的のアイテムを吐き出す。
 * 価値の低いものを大量に入れて価値の高いものを少量得る（またはその逆）。
 *
 * ---------------------------------------------------------------------------
 * ポイントの持ち方
 * ---------------------------------------------------------------------------
 * 表向きの単位は **石炭 1 個 = 1 ポイント**。
 * ただし丸石や木材は石炭より安いので、そのままだと 1 未満になって整数で書けない。
 *
 * そこで内部では **1 ポイント = SCALE(64) の細かい単位**で数える。
 *   石炭        1 ポイント → 64
 *   丸石     1/32 ポイント →  2
 *   ダイヤ    128 ポイント → 8192
 * 表に書く数字は石炭基準のまま（ユーザーから見える値を変えない）で、
 * 端数のある安い素材も同じ表で扱える。
 *
 * ---------------------------------------------------------------------------
 * 保存
 * ---------------------------------------------------------------------------
 *   wr:refine|<座標>     変換先のアイテム identifier
 *   wr:refinepts|<座標>  たまっている内部ポイント
 * 座標をキーにしているのでピストンで動かされると記録とずれる → immovable。
 */

import { ItemStack, world } from "@minecraft/server";
import { blockKey, neighborBlock, maxIncomingPower } from "./util.js";
import { scheduleUpdate, applyStates, registerUpdater } from "./propagation_helper.js";
import { heldItem } from "./wire.js";

/** 1 ポイント（＝石炭 1 個）を何分割して持つか。 */
const SCALE = 64;

/** 1 tick（20 tick 間隔）で吸い出す最大スロット数。重くならないように絞る。 */
const PULL_PER_TICK = 4;
/** 1 回に吐き出す最大個数。 */
const PUSH_PER_TICK = 16;

/**
 * 変換ポイント表（石炭 1 個 = 1 ポイント）。
 *
 * `per` は「何個で表の値になるか」。省略すると 1 個あたり。
 * 丸石や木材のように石炭より安いものは per を大きくして端数を表す。
 *
 * ここに無いアイテムは**変換できない**（吸い出しもしない）。
 * 無制限に何でも受け付けると、たまたま入っていた道具まで溶けてしまうため。
 */
const VALUES = [
  // --- 石・土系（1 ポイント未満） ---
  ["minecraft:cobblestone", 1, 32],
  ["minecraft:stone", 1, 32],
  ["minecraft:deepslate", 1, 24],
  ["minecraft:cobbled_deepslate", 1, 24],
  ["minecraft:netherrack", 1, 32],
  ["minecraft:dirt", 1, 48],
  ["minecraft:sand", 1, 32],
  ["minecraft:gravel", 1, 24],
  ["minecraft:andesite", 1, 32],
  ["minecraft:diorite", 1, 32],
  ["minecraft:granite", 1, 32],
  ["minecraft:tuff", 1, 24],
  ["minecraft:calcite", 1, 16],
  ["minecraft:basalt", 1, 24],
  // --- 木材系 ---
  ["minecraft:oak_planks", 1, 16],
  ["minecraft:spruce_planks", 1, 16],
  ["minecraft:birch_planks", 1, 16],
  ["minecraft:jungle_planks", 1, 16],
  ["minecraft:acacia_planks", 1, 16],
  ["minecraft:dark_oak_planks", 1, 16],
  ["minecraft:mangrove_planks", 1, 16],
  ["minecraft:cherry_planks", 1, 16],
  ["minecraft:bamboo_planks", 1, 16],
  ["minecraft:crimson_planks", 1, 16],
  ["minecraft:warped_planks", 1, 16],
  ["minecraft:oak_log", 1, 4],
  ["minecraft:spruce_log", 1, 4],
  ["minecraft:birch_log", 1, 4],
  ["minecraft:jungle_log", 1, 4],
  ["minecraft:acacia_log", 1, 4],
  ["minecraft:dark_oak_log", 1, 4],
  ["minecraft:mangrove_log", 1, 4],
  ["minecraft:cherry_log", 1, 4],
  ["minecraft:stick", 1, 32],
  ["minecraft:glass", 1, 16],
  // --- 石炭以上（元の表のとおり） ---
  ["minecraft:coal", 1],
  ["minecraft:charcoal", 1],
  ["minecraft:lapis_lazuli", 2],
  ["minecraft:redstone", 2],
  ["minecraft:quartz", 2],
  ["minecraft:amethyst_shard", 2],
  ["minecraft:copper_ingot", 6],
  ["minecraft:iron_ingot", 8],
  ["minecraft:gold_ingot", 12],
  ["minecraft:emerald", 12],
  ["minecraft:diamond", 128],
  ["minecraft:netherite_scrap", 2048],
  ["minecraft:ancient_debris", 2048], // 精錬すると欠片 1 個
  // ネザライトインゴットは欠片 4 + 金 4。2048×4 + 12×4 = 8240
  ["minecraft:netherite_ingot", 8240],
  // --- 未精錬（掘ったままの形。これが無いと採掘した鉱石をそのまま入れられない） ---
  ["minecraft:raw_copper", 6],
  ["minecraft:raw_iron", 8],
  ["minecraft:raw_gold", 12],
  // --- ブロック（素材 9 個ぶん。まとめて入れられると楽なので） ---
  ["minecraft:coal_block", 9],
  ["minecraft:lapis_block", 18],
  ["minecraft:redstone_block", 18],
  ["minecraft:copper_block", 54],
  ["minecraft:iron_block", 72],
  ["minecraft:gold_block", 108],
  ["minecraft:emerald_block", 108],
  ["minecraft:raw_copper_block", 54],
  ["minecraft:raw_iron_block", 72],
  ["minecraft:raw_gold_block", 108],
  ["minecraft:diamond_block", 1152],
  ["minecraft:netherite_block", 74160],
];

/** identifier → 内部ポイント（1 個あたり）。 */
const UNIT = new Map(
  VALUES.map(([id, points, per = 1]) => [id, Math.max(1, Math.round((points * SCALE) / per))])
);

/** そのアイテムが変換表にあるか。 */
export function isRefinable(typeId) {
  return UNIT.has(typeId);
}

/** 内部ポイント → 石炭換算の表示用文字列。 */
export function pointsText(internal) {
  const coal = internal / SCALE;
  return coal >= 10 ? String(Math.floor(coal)) : coal.toFixed(2).replace(/\.?0+$/, "");
}

const TARGET_PREFIX = "wr:refine|";
const POINTS_PREFIX = "wr:refinepts|";

function idOf(block) {
  return blockKey(block.dimension.id, block.location);
}

export function targetOf(block) {
  const value = world.getDynamicProperty(TARGET_PREFIX + idOf(block));
  return typeof value === "string" ? value : "";
}

export function setTarget(block, typeId) {
  world.setDynamicProperty(
    TARGET_PREFIX + idOf(block),
    typeId === undefined || typeId === "" ? undefined : typeId
  );
}

export function pointsOf(block) {
  const value = world.getDynamicProperty(POINTS_PREFIX + idOf(block));
  return typeof value === "number" ? value : 0;
}

function setPoints(block, points) {
  world.setDynamicProperty(POINTS_PREFIX + idOf(block), points > 0 ? points : undefined);
}

/** ブロックを壊したときの後始末。ためたポイントは失われる。 */
export function clearRefiner(dimensionId, location) {
  const id = blockKey(dimensionId, location);
  world.setDynamicProperty(TARGET_PREFIX + id, undefined);
  world.setDynamicProperty(POINTS_PREFIX + id, undefined);
}

/** その向きの隣にあるコンテナ。 */
function containerAt(block, face) {
  const nb = neighborBlock(block, face);
  if (!nb) return undefined;
  try {
    return nb.getComponent("minecraft:inventory")?.container;
  } catch {
    return undefined;
  }
}

/**
 * 上のチェストから変換表にあるものを吸い出してポイントに換える。
 * @returns 増えた内部ポイント
 */
function pull(container) {
  let gained = 0;
  let touched = 0;
  for (let slot = 0; slot < (container.size ?? 0) && touched < PULL_PER_TICK; slot += 1) {
    let item;
    try {
      item = container.getItem(slot);
    } catch {
      continue;
    }
    if (!item) continue;
    const unit = UNIT.get(item.typeId);
    if (unit === undefined) continue; // 表に無いものは触らない

    gained += unit * (item.amount ?? 1);
    try {
      container.setItem(slot, undefined);
    } catch {
      // 取り除けなかったぶんは無かったことにする（増殖させない）
      gained -= unit * (item.amount ?? 1);
      continue;
    }
    touched += 1;
  }
  return gained;
}

/**
 * ためたポイントを目的のアイテムにして下のチェストへ入れる。
 * @returns 消費した内部ポイント
 */
function push(container, targetId, points) {
  const unit = UNIT.get(targetId);
  if (unit === undefined || unit <= 0) return 0;

  let spent = 0;
  let made = 0;
  while (points - spent >= unit && made < PUSH_PER_TICK) {
    let leftover;
    try {
      leftover = container.addItem(new ItemStack(targetId, 1));
    } catch {
      break;
    }
    if (leftover) break; // 入りきらない。ポイントは残しておく
    spent += unit;
    made += 1;
  }
  return spent;
}

function updateRefiner(block) {
  // レッドストーン信号を受けている間は止まる（バニラのホッパーと同じ感覚）。
  // **値は毎回読み直す**。onRedstoneUpdate の e.redstonePower を信じると、
  // イベントが来なかったときにステートが固まるうえ、wr: ブロックの出力は
  // そもそもバニラのイベントを起こさないので繋いでも効かない
  // （v1.27.0 で machines.js が実機で動かなかった原因。machines.js の powered() 参照）
  const disabled = maxIncomingPower(block) > 0;
  applyStates(block, { "wr:disabled": disabled });
  if (disabled) {
    applyStates(block, { "wr:busy": false });
    return;
  }

  const target = targetOf(block);
  let points = pointsOf(block);
  let working = false;

  const input = containerAt(block, "up");
  if (input) {
    const gained = pull(input);
    if (gained > 0) {
      points += gained;
      working = true;
    }
  }

  if (target.length > 0 && points > 0) {
    const output = containerAt(block, "down");
    if (output) {
      const spent = push(output, target, points);
      if (spent > 0) {
        points -= spent;
        working = true;
      }
    }
  }

  setPoints(block, points);
  applyStates(block, { "wr:busy": working });
}
registerUpdater("wr:ore_refiner", updateRefiner);

export const oreRefinerComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateRefiner);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateRefiner);
  },
  onRedstoneUpdate(e) {
    // イベントは「何か変わった」という合図としてだけ使う（値は updater が読み直す）
    scheduleUpdate(e.block, updateRefiner);
  },
  onPlayerDestroy(e) {
    clearRefiner(e.block.dimension.id, e.block.location);
  },
  /**
   * 変換先の選択は **作りたいものを手に持って右クリック**。
   * 素手なら今の状態（変換先とたまっているポイント）を表示する。
   */
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;
    const block = e.block;
    const item = heldItem(player);

    if (!item) {
      const target = targetOf(block);
      player.onScreenDisplay.setActionBar({
        translate: target.length > 0 ? "wr.msg.refiner.status" : "wr.msg.refiner.notarget",
        with: [target.replace("minecraft:", ""), pointsText(pointsOf(block))],
      });
      return;
    }

    if (!isRefinable(item.typeId)) {
      player.onScreenDisplay.setActionBar({
        translate: "wr.msg.refiner.unsupported",
        with: [item.typeId.replace("minecraft:", "")],
      });
      return;
    }

    setTarget(block, item.typeId);
    scheduleUpdate(block, updateRefiner);
    player.onScreenDisplay.setActionBar({
      translate: "wr.msg.refiner.target",
      with: [item.typeId.replace("minecraft:", ""), pointsText(UNIT.get(item.typeId))],
    });
  },
};

/**
 * 変換先・たまったポイントはどちらも座標キーの動的プロパティなので、
 * `onPlayerDestroy` だけでは**爆破されたときに幽霊が残る**
 * （次に同じ場所へ置いた精錬機が前のポイントを引き継いでしまう＝実質増殖）。
 * 他のブロック（非対称リピーター等）と同じ理由で blockExplode でも消す。
 */
export function registerRefinerCleanup() {
  world.afterEvents.blockExplode?.subscribe((e) => {
    if (e.explodedBlockPermutation?.type?.id === "wr:ore_refiner") {
      clearRefiner(e.dimension.id, e.block.location);
    }
  });
}
