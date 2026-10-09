/**
 * C-1. 計測アイテム (wr:probe)
 *
 * 通常の使用: 視線の先のブロックの電力をアクションバーに出す。
 *   wr:wire は wr:power ステート、wr:transmitter / wr:receiver / wr:corner_riser は
 *   チャンネルIDも併記、それ以外のブロックは getRedstonePower() の値を出す。
 *
 * スニーク + 使用: そのブロックの波形記録を開始／停止する。
 *   記録中は毎 tick 電力をサンプリングし、直近 40 tick を折れ線グラフとして
 *   アクションバーに出し続ける。パルス生成機の周期や可変リピーターの遅延を
 *   目で合わせるためのもの。
 */

import { world, system } from "@minecraft/server";
import { blockKey, maxIncomingPower } from "./util.js";
import { getTransmitterChannel, getReceiverChannel } from "./channels.js";

const MAX_DISTANCE = 8;
/** 連打で毎 tick 走らせないためのクールダウン（tick）。 */
const COOLDOWN_TICKS = 4;

/** 波形に残すサンプル数（tick）。 */
const WAVE_SAMPLES = 40;
/** 記録の自動停止までの時間（tick）。 */
const WAVE_TIMEOUT_TICKS = 20 * 60;

/**
 * 波形の描画に使う文字。電力 0〜15 を 8 段階に丸めて引く。
 * 実機でこれが豆腐（□）になる場合は、ここを "_.-=+*#@" のような
 * ASCII だけの並びに差し替えれば直る。
 */
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** player.id → 次に使用可能になる tick */
const cooldown = new Map();
/** player.id → { dimensionId, location, label, samples, until } */
const recorders = new Map();

/** ブロック名の表示。wr: のものは翻訳キー、バニラは identifier をそのまま出す。 */
function displayName(typeId) {
  if (typeId.startsWith("wr:")) return { translate: `tile.${typeId}.name` };
  return { text: typeId.replace("minecraft:", "") };
}

/** そのブロックが「今いくつを出しているか」。表示と波形で共通に使う。 */
function powerOf(block) {
  const perm = block.permutation;
  if (block.typeId === "wr:transmitter") return maxIncomingPower(block);

  const power = perm.getState("wr:power");
  if (typeof power === "number") return power;

  const on = perm.getState("wr:on");
  if (typeof on === "boolean") return on ? 15 : 0;

  try {
    return block.getRedstonePower() ?? 0;
  } catch {
    return 0;
  }
}

function describe(block) {
  const typeId = block.typeId;
  const perm = block.permutation;

  if (typeId === "wr:wire") {
    return {
      translate: "wr.msg.probe.wire",
      with: {
        rawtext: [displayName(typeId), { text: String(perm.getState("wr:power") ?? 0) }],
      },
    };
  }

  if (typeId === "wr:transmitter" || typeId === "wr:receiver" || typeId === "wr:corner_riser") {
    const key = blockKey(block.dimension.id, block.location);
    let channel = "-";
    if (typeId === "wr:transmitter") channel = getTransmitterChannel(key) ?? "default";
    else if (typeId === "wr:receiver") channel = getReceiverChannel(key) ?? "default";
    return {
      translate: "wr.msg.probe.channel",
      with: {
        rawtext: [displayName(typeId), { text: channel }, { text: String(powerOf(block)) }],
      },
    };
  }

  return {
    translate: "wr.msg.probe.vanilla",
    with: { rawtext: [displayName(typeId), { text: String(powerOf(block)) }] },
  };
}

// ---------------------------------------------------------------------------
// 波形記録
// ---------------------------------------------------------------------------

function sparkline(samples) {
  let out = "";
  for (const value of samples) {
    const index = Math.max(0, Math.min(SPARK.length - 1, Math.round((value / 15) * (SPARK.length - 1))));
    out += SPARK[index];
  }
  return out;
}

function toggleRecording(player, block) {
  if (recorders.has(player.id)) {
    recorders.delete(player.id);
    player.onScreenDisplay.setActionBar({ translate: "wr.msg.probe.record.stop" });
    return;
  }
  recorders.set(player.id, {
    dimensionId: block.dimension.id,
    location: { ...block.location },
    typeId: block.typeId,
    samples: [],
    until: system.currentTick + WAVE_TIMEOUT_TICKS,
  });
  player.onScreenDisplay.setActionBar({
    translate: "wr.msg.probe.record.start",
    with: { rawtext: [displayName(block.typeId)] },
  });
}

function stepRecorders() {
  if (recorders.size === 0) return;

  for (const player of world.getAllPlayers()) {
    const rec = recorders.get(player.id);
    if (!rec) continue;

    if (system.currentTick > rec.until) {
      recorders.delete(player.id);
      player.onScreenDisplay.setActionBar({ translate: "wr.msg.probe.record.stop" });
      continue;
    }

    let block;
    try {
      block = world.getDimension(rec.dimensionId).getBlock(rec.location);
    } catch {
      block = undefined;
    }
    if (!block) continue; // 未ロード。記録は残したまま待つ
    if (block.typeId !== rec.typeId) {
      // 対象が別のブロックに置き換わった＝記録の意味がなくなった
      recorders.delete(player.id);
      player.onScreenDisplay.setActionBar({ translate: "wr.msg.probe.record.stop" });
      continue;
    }

    const value = powerOf(block);
    rec.samples.push(value);
    if (rec.samples.length > WAVE_SAMPLES) rec.samples.shift();

    player.onScreenDisplay.setActionBar({
      translate: "wr.msg.probe.wave",
      with: { rawtext: [{ text: sparkline(rec.samples) }, { text: String(value) }] },
    });
  }

  // 退出したプレイヤーぶんの掃除
  if (recorders.size > 0) {
    const online = new Set(world.getAllPlayers().map((p) => p.id));
    for (const id of [...recorders.keys()]) {
      if (!online.has(id)) recorders.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------

export const probeComponent = {
  onUse(e) {
    const player = e.source;
    if (!player) return;

    const now = system.currentTick;
    if ((cooldown.get(player.id) ?? 0) > now) return;
    cooldown.set(player.id, now + COOLDOWN_TICKS);

    let hit;
    try {
      hit = player.getBlockFromViewDirection({
        maxDistance: MAX_DISTANCE,
        includePassableBlocks: true, // wr:wire は当たり判定を持たないため必須
        includeLiquidBlocks: false,
      });
    } catch {
      hit = undefined;
    }

    if (!hit?.block) {
      // 記録中に何もない方を向いて使ったら、記録の停止として扱う
      if (player.isSneaking && recorders.has(player.id)) {
        recorders.delete(player.id);
        player.onScreenDisplay.setActionBar({ translate: "wr.msg.probe.record.stop" });
        return;
      }
      player.onScreenDisplay.setActionBar({ translate: "wr.msg.probe.none" });
      return;
    }

    if (player.isSneaking) {
      toggleRecording(player, hit.block);
      return;
    }
    player.onScreenDisplay.setActionBar(describe(hit.block));
  },
};

export function registerProbeLoop() {
  system.runInterval(stepRecorders, 1);
}
