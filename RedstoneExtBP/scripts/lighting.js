/**
 * パートE: 光源
 *   E-1 wr:lamp         受けた電力の強さをそのまま明るさにする調光ランプ（16 色）
 *   E-2 wr:glow_block   レッドストーン不要の発光建材（16 色・明るさ 0〜15）
 *   E-3 wr:light_panel  6 面どこにでも貼れる、ほぼ透明な 1px の光源パネル
 *
 * ---------------------------------------------------------------------------
 * 明るさの持ち方
 * ---------------------------------------------------------------------------
 * どのブロックも現在の明るさを **wr:light** ステートに持ち、ブロック JSON 側の
 * パーミュテーションが minecraft:light_emission に写している。
 *
 * ここで wr:power という名前を使ってはいけない。util.js の powerFrom() は
 * wr: ブロックの wr:power を「そのブロックの出力」として読むので、
 * ランプが受電値を出力しているように見えてしまい、
 * 隣のワイヤーが自分で点けたランプから電力を読み返して消えなくなる。
 * 光源はすべて電力の受け手（sink）であって、電力は一切出さない。
 */

import { maxIncomingPower, clampPower } from "./util.js";
import { scheduleUpdate, applyStates, registerUpdater } from "./propagation_helper.js";
import { colorFromDye, colorNameKey } from "./colors.js";
import { openNumberSetting, stepValue } from "./block_ui.js";
import { ensureSupport } from "./surface.js";
import { consumeHeldItem, heldItem } from "./wire.js";

/** 設置直後の明るさ。ステートの既定値（配列の先頭 = 0）だと真っ暗なので上書きする。 */
const DEFAULT_LIGHT = 15;

function lightOf(block) {
  const level = block.permutation.getState("wr:light");
  return typeof level === "number" ? level : 0;
}

function colorOf(block) {
  const color = block.permutation.getState("wr:color");
  return typeof color === "number" ? color : 0;
}

/** 染料を持っていたら色を塗る。塗ったら true。 */
function tryDye(block, player, messageKey) {
  const color = colorFromDye(heldItem(player)?.typeId);
  if (color === undefined) return false;
  if (colorOf(block) !== color) {
    applyStates(block, { "wr:color": color });
    consumeHeldItem(player);
  }
  player.onScreenDisplay.setActionBar({
    translate: messageKey,
    with: { rawtext: [{ translate: colorNameKey(color) }] },
  });
  return true;
}

function setLight(block, level, player) {
  const next = clampPower(level);
  applyStates(block, { "wr:light": next });
  player?.onScreenDisplay.setActionBar({
    translate: "wr.msg.light.level",
    with: [String(next)],
  });
}

/** 右クリックで明るさスライダー、スニーク + 右クリックで +1 の微調整。 */
function openLightSetting(block, player) {
  if (player.isSneaking) {
    setLight(block, stepValue(lightOf(block), 0, 15), player);
    return;
  }
  openNumberSetting(player, block, {
    titleKey: "wr.ui.light.title",
    labelKey: "wr.ui.light.label",
    min: 0,
    max: 15,
    value: lightOf(block),
    apply: (fresh, value) => setLight(fresh, value, player),
  });
}

// ---------------------------------------------------------------------------
// E-1. 調光レッドストーンランプ
// ---------------------------------------------------------------------------

/**
 * 受電値をそのまま明るさにする。
 *
 * 出力を持たないので redstone_consumer が付けられ、onRedstoneUpdate で
 * バニラ側の変化に気づける。ただし wr: ブロックの出力はステート直読みでしか
 * 分からず、そちらは redstone のイベントを起こさないことがあるので
 * minecraft:tick のポーリングも併用している。
 */
function updateLamp(block) {
  const level = clampPower(maxIncomingPower(block));
  applyStates(block, { "wr:light": level });
}
registerUpdater("wr:lamp", updateLamp);

export const lampComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateLamp);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateLamp);
  },
  onRedstoneUpdate(e) {
    scheduleUpdate(e.block, updateLamp);
  },
  /** 染料で色を変える。明るさは電力で決まるので手では設定させない。 */
  onPlayerInteract(e) {
    if (!e.player) return;
    tryDye(e.block, e.player, "wr.msg.lamp.dyed");
  },
};

// ---------------------------------------------------------------------------
// E-2. 発光建材ブロック
// ---------------------------------------------------------------------------

export const glowBlockComponent = {
  onPlace(e) {
    // ステートの既定値は配列の先頭（= 0 = 真っ暗）なので、置いた瞬間に明るくする。
    // ステート配列の並び順に依存しないよう、既定値そのものは当てにしない。
    scheduleUpdate(e.block, (block) => {
      applyStates(block, { "wr:light": DEFAULT_LIGHT });
    });
  },
  /** 染料を持っていれば色、そうでなければ明るさの設定。 */
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;
    if (tryDye(e.block, player, "wr.msg.glow.dyed")) return;
    openLightSetting(e.block, player);
  },
};

// ---------------------------------------------------------------------------
// E-3. 隠し光源パネル
// ---------------------------------------------------------------------------

/**
 * 板の向きの補正だけ行う。ワイヤーと違い、支えが無くなっても落とさない
 * （見た目がほぼ無いので、落として拾わせるより残っている方が扱いやすい）。
 */
function updateLightPanel(block) {
  ensureSupport(block);
}
registerUpdater("wr:light_panel", updateLightPanel);

export const lightPanelComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, (block) => {
      applyStates(block, { "wr:light": DEFAULT_LIGHT });
      ensureSupport(block);
    });
  },
  onTick(e) {
    scheduleUpdate(e.block, updateLightPanel);
  },
  onPlayerInteract(e) {
    if (!e.player) return;
    openLightSetting(e.block, e.player);
  },
};
