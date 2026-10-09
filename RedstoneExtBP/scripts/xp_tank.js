/**
 * パートI-2: XPタンク (wr:xp_tank)
 *
 *   右クリック            … 持っている経験値を全部あずける
 *   スニーク + 右クリック … タンクの中身を全部引き出す
 *
 * たまっている量に応じて **0〜15 を全方向に出力**するので、
 * 「満タンになったら知らせる」といった配線が組める。
 *
 * ---------------------------------------------------------------------------
 * 経験値の受け渡しで気をつけたこと
 * ---------------------------------------------------------------------------
 * **先にプレイヤーから減らし、減った実測値だけをタンクに足す。**
 * 逆順（先にタンクへ足す）にすると、減らすのに失敗したときに
 * 経験値が増えてしまう。この順なら最悪でも「減らしたのに入らなかった」で、
 * 増殖よりは害が小さい。減った量は getTotalXp() の差分で実測する
 * （addExperience の戻り値の意味が版によって違う可能性があるため）。
 *
 * 保存は座標キーの動的プロパティなので、ピストンで動かされると
 * 記録と実体がずれる → ブロック側で immovable にしてある。
 */

import { world } from "@minecraft/server";
import { blockKey, clampPower } from "./util.js";
import { scheduleUpdate, applyStates, registerUpdater, scheduleNeighbors } from "./propagation_helper.js";

const XP_PREFIX = "wr:xp|";

/** 満タン扱いの量。出力 15 になる基準（レベル 30 が約 1400 なので約 70 レベルぶん）。 */
export const XP_CAPACITY = 10000;

function idOf(block) {
  return blockKey(block.dimension.id, block.location);
}

export function storedXp(block) {
  const value = world.getDynamicProperty(XP_PREFIX + idOf(block));
  return typeof value === "number" && value > 0 ? value : 0;
}

function setStoredXp(block, amount) {
  const next = Math.max(0, Math.floor(amount));
  world.setDynamicProperty(XP_PREFIX + idOf(block), next > 0 ? next : undefined);
  return next;
}

export function clearXpTank(dimensionId, location) {
  world.setDynamicProperty(XP_PREFIX + blockKey(dimensionId, location), undefined);
}

/** たまっている量 → 出力 0〜15。1 でも入っていれば最低 1 を返す。 */
function levelFor(amount) {
  if (amount <= 0) return 0;
  return clampPower(Math.max(1, Math.round((amount / XP_CAPACITY) * 15)));
}

function updateXpTank(block) {
  const power = levelFor(storedXp(block));
  if (applyStates(block, { "wr:power": power })) scheduleNeighbors(block);
}
registerUpdater("wr:xp_tank", updateXpTank);

function totalXpOf(player) {
  try {
    const value = player.getTotalXp?.();
    return typeof value === "number" && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * プレイヤーの経験値を 0 にする。
 *
 * **`addExperience(-n)` はレベルを削れない。** 経験値バーの中身（今のレベルで
 * 稼いだぶん）しか減らせず、バーが空でレベルだけ持っている人には何も起きない。
 * v1.27.0 まではこれで「バーぶんは吸えるがレベルぶんは吸えず、
 * 挙句に失敗メッセージが出る」状態だった（ユーザー報告）。
 * レベルまで含めて回収するには、一度 0 にしてから残りを返すしかない。
 */
function zeroXp(player) {
  if (typeof player.resetLevel === "function") {
    player.resetLevel();
    return;
  }
  // resetLevel が無い版向けの逃げ道
  player.addLevels(-(player.level ?? 0));
  player.addExperience(-(player.xpEarnedAtCurrentLevel ?? 0));
}

/** プレイヤーから経験値を減らす。@returns 実際に減った量 */
function takeXp(player, amount) {
  const before = totalXpOf(player);
  const want = Math.min(before, Math.floor(amount));
  if (want <= 0) return 0;

  try {
    zeroXp(player);
  } catch {
    return 0;
  }
  // 取りすぎたぶんを返す。ここが失敗しても「全部タンクに入る」だけで、
  // 引き出せば戻ってくるので経験値は消えない
  const keep = before - want;
  if (keep > 0) {
    try {
      player.addExperience(keep);
    } catch {
      /* 返し損ねたぶんは下の実測に出るので、そのままタンクへ */
    }
  }

  const after = totalXpOf(player);
  return Math.max(0, before - after);
}

function actionBar(player, translate, withValues) {
  player.onScreenDisplay.setActionBar(
    withValues ? { translate, with: withValues } : { translate }
  );
}

export const xpTankComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateXpTank);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateXpTank);
  },
  onPlayerDestroy(e) {
    clearXpTank(e.block.dimension.id, e.block.location);
  },
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;
    const block = e.block;
    const stored = storedXp(block);

    if (player.isSneaking) {
      // 引き出す
      if (stored <= 0) {
        actionBar(player, "wr.msg.xp.empty");
        return;
      }
      try {
        player.addExperience(stored);
      } catch {
        actionBar(player, "wr.msg.xp.failed");
        return;
      }
      setStoredXp(block, 0);
      scheduleUpdate(block, updateXpTank);
      actionBar(player, "wr.msg.xp.withdrew", [String(stored)]);
      return;
    }

    // あずける。空きぶんだけ受け取る
    const room = XP_CAPACITY - stored;
    if (room <= 0) {
      actionBar(player, "wr.msg.xp.full", [String(stored)]);
      return;
    }
    const held = totalXpOf(player);
    if (held <= 0) {
      actionBar(player, "wr.msg.xp.none");
      return;
    }
    // **先に減らして、実際に減った量だけ入れる**（増殖させないため）
    const taken = takeXp(player, Math.min(held, room));
    if (taken <= 0) {
      actionBar(player, "wr.msg.xp.failed");
      return;
    }
    // 返し損ねて取りすぎていたら、入る量だけ受け取って残りは手元に戻す
    const accepted = Math.min(taken, room);
    const surplus = taken - accepted;
    if (surplus > 0) {
      try {
        player.addExperience(surplus);
      } catch {
        /* 戻せなければ諦める（タンクの容量を超えて持つことはできない） */
      }
    }
    const total = setStoredXp(block, stored + accepted);
    scheduleUpdate(block, updateXpTank);
    actionBar(player, "wr.msg.xp.stored", [String(accepted), String(total)]);
  },
};

/**
 * たまったXPは座標キーの動的プロパティなので、`onPlayerDestroy` だけでは
 * **爆破されたときに幽霊が残る**（次に同じ場所へ置いたタンクが前の量を
 * 引き継いでしまう＝実質増殖）。他のブロック（非対称リピーター等）と
 * 同じ理由で blockExplode でも消す。
 */
export function registerXpTankCleanup() {
  world.afterEvents.blockExplode?.subscribe((e) => {
    if (e.explodedBlockPermutation?.type?.id === "wr:xp_tank") {
      clearXpTank(e.dimension.id, e.block.location);
    }
  });
}
