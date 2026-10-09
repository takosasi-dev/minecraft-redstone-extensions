/**
 * パートA: ワイヤレスレッドストーン
 *   A-1 wr:transmitter  電力を検知してチャンネルに書き込む
 *   A-2 wr:receiver     チャンネルの最大値を 4 tick ごとに集約して出力する
 *   A-3 wr:remote       手持ちアイテムの名前をチャンネルとして 0/15 をトグルする
 */

import { world, system, EquipmentSlot } from "@minecraft/server";
import { blockKey, maxIncomingPower } from "./util.js";
import { scheduleUpdate, applyStates, scheduleNeighbors } from "./propagation_helper.js";
import {
  sanitizeChannel,
  setTransmitterChannel,
  setTransmitterPower,
  getTransmitterChannel,
  clearTransmitter,
  setReceiverChannel,
  getReceiverChannel,
  clearReceiver,
  receiverEntries,
  channelMaxima,
  getRemote,
  setRemote,
  reconcile,
  setChannelListener,
} from "./channels.js";
import { openRemoteChannelPicker, openBlockChannelPicker } from "./channel_ui.js";

/**
 * 受信ブロックの定期ポーリング間隔。
 *
 * 通常の更新は setChannelListener によるプッシュ（値が動いた次の tick）で行うので、
 * こちらは取りこぼしの保険。短くする必要はない。
 */
const RECEIVER_POLL_TICKS = 20;
const RECONCILE_TICKS = 200;

/** 設置直前に手に持っていたアイテムの名前。player.id → nameTag。 */
const heldNameTag = new Map();

/** 値が動いたチャンネル。次 tick にまとめて受信ブロックへ反映する。 */
const dirtyChannels = new Set();
let flushQueued = false;

// ---------------------------------------------------------------------------
// A-1. 送信ブロック
// ---------------------------------------------------------------------------

function updateTransmitter(block) {
  const key = blockKey(block.dimension.id, block.location);
  const channel = getTransmitterChannel(key) ?? "default";
  setTransmitterPower(key, channel, maxIncomingPower(block));
}

export const transmitterComponent = {
  // 共通伝播ロジック: ここでは予約するだけ。実処理は次 tick。
  onRedstoneUpdate(e) {
    scheduleUpdate(e.block, updateTransmitter);
  },
  onTick(e) {
    // onRedstoneUpdate が取りこぼした変化（隣接ブロックの差し替え等）の保険。
    scheduleUpdate(e.block, updateTransmitter);
  },
  onPlace(e) {
    scheduleUpdate(e.block, updateTransmitter);
  },
  onPlayerDestroy(e) {
    clearTransmitter(blockKey(e.block.dimension.id, e.block.location));
  },
  /** 設置後のチャンネル変更。 */
  onPlayerInteract(e) {
    if (!e.player) return;
    const key = blockKey(e.block.dimension.id, e.block.location);
    openBlockChannelPicker(e.player, e.block, "wr:transmitter", getTransmitterChannel(key) ?? "default");
  },
};

// ---------------------------------------------------------------------------
// A-2. 受信ブロック
// ---------------------------------------------------------------------------

export const receiverComponent = {
  onPlace(e) {
    const key = blockKey(e.block.dimension.id, e.block.location);
    if (getReceiverChannel(key) === undefined) setReceiverChannel(key, "default");
  },
  onPlayerDestroy(e) {
    clearReceiver(blockKey(e.block.dimension.id, e.block.location));
  },
  /** 設置後のチャンネル変更。 */
  onPlayerInteract(e) {
    if (!e.player) return;
    const key = blockKey(e.block.dimension.id, e.block.location);
    openBlockChannelPicker(e.player, e.block, "wr:receiver", getReceiverChannel(key) ?? "default");
  },
};

/**
 * 受信ブロックの更新。
 *
 * @param only 省略時は全受信ブロック。チャンネル名の Set を渡すと、
 *             そのチャンネルの受信ブロックだけを更新する（プッシュ更新用）。
 */
function refreshReceivers(only) {
  const entries = receiverEntries();
  if (entries.length === 0) return;

  const maxima = channelMaxima();
  for (const [key, channel] of entries) {
    if (only && !only.has(channel)) continue;
    const parts = key.split("|");
    if (parts.length !== 4) {
      clearReceiver(key);
      continue;
    }
    const [dimensionId, x, y, z] = parts;
    let block;
    try {
      block = world.getDimension(dimensionId).getBlock({
        x: Number(x),
        y: Number(y),
        z: Number(z),
      });
    } catch {
      continue; // 次元が取れない
    }
    if (!block) continue; // 未ロードチャンク: 何もしない
    if (block.typeId !== "wr:receiver") {
      clearReceiver(key);
      continue;
    }
    // 出力が変わったら、隣接する wr: ブロックにも再計算させる
    if (applyStates(block, { "wr:power": maxima.get(channel) ?? 0 })) {
      scheduleNeighbors(block);
    }
  }
}

// ---------------------------------------------------------------------------
// A-3. リモコンアイテム
// ---------------------------------------------------------------------------

export const remoteComponent = {
  onUse(e) {
    const player = e.source;
    if (!player) return;
    const channel = sanitizeChannel(e.itemStack?.nameTag);

    // スニーク + 使用でチャンネル選択UI。通常の使用はトグル。
    if (player.isSneaking) {
      openRemoteChannelPicker(player, channel);
      return;
    }

    const next = getRemote(channel) > 0 ? 0 : 15;
    setRemote(channel, next);
    player.onScreenDisplay.setActionBar({
      translate: next > 0 ? "wr.msg.remote.on" : "wr.msg.remote.off",
      with: [channel],
    });
    player.playSound(next > 0 ? "random.click" : "random.click", { pitch: next > 0 ? 1.4 : 0.8 });
  },
};

// ---------------------------------------------------------------------------
// 設置時のチャンネル付与・破壊時のクリーンアップ
// ---------------------------------------------------------------------------

function channelFromPlayer(player) {
  const cached = heldNameTag.get(player.id);
  if (cached !== undefined) return sanitizeChannel(cached);
  try {
    const equippable = player.getComponent("minecraft:equippable");
    const item = equippable?.getEquipment(EquipmentSlot.Mainhand);
    return sanitizeChannel(item?.nameTag);
  } catch {
    return "default";
  }
}

export function registerWirelessEvents() {
  // 設置に使ったアイテムの名前を控えておく。
  // playerPlaceBlock の afterEvent はアイテム情報を持たず、サバイバルでは
  // 最後の 1 個を置いた時点で手が空になるため、直前の interact で拾う。
  world.beforeEvents.playerInteractWithBlock.subscribe((e) => {
    const tag = e.itemStack?.nameTag;
    if (tag === undefined) heldNameTag.delete(e.player.id);
    else heldNameTag.set(e.player.id, tag);
  });

  world.afterEvents.playerPlaceBlock.subscribe((e) => {
    const typeId = e.block.typeId;
    if (typeId !== "wr:transmitter" && typeId !== "wr:receiver") return;
    const key = blockKey(e.block.dimension.id, e.block.location);
    const channel = channelFromPlayer(e.player);
    if (typeId === "wr:transmitter") setTransmitterChannel(key, channel);
    else setReceiverChannel(key, channel);
    e.player.onScreenDisplay.setActionBar({
      translate: "wr.msg.channel.set",
      with: [channel],
    });
  });

  world.afterEvents.playerLeave.subscribe((e) => {
    heldNameTag.delete(e.playerId);
  });

  // 爆発で壊された場合のクリーンアップ（onPlayerDestroy は発火しない）。
  world.afterEvents.blockExplode.subscribe((e) => {
    const typeId = e.explodedBlockPermutation?.type?.id;
    if (typeId !== "wr:transmitter" && typeId !== "wr:receiver") return;
    const key = blockKey(e.dimension.id, e.block.location);
    if (typeId === "wr:transmitter") clearTransmitter(key);
    else clearReceiver(key);
  });

  // チャンネルの値が動いたら、そのチャンネルの受信ブロックを次 tick で更新する。
  // 4 tick ごとのポーリング待ちをやめて、送信と同じ速さで反応させるため。
  setChannelListener((channel) => {
    dirtyChannels.add(channel);
    if (flushQueued) return;
    flushQueued = true;
    system.run(() => {
      flushQueued = false;
      const channels = new Set(dirtyChannels);
      dirtyChannels.clear();
      refreshReceivers(channels);
    });
  });

  // 取りこぼしの保険（プッシュが主、こちらは従）
  system.runInterval(() => refreshReceivers(), RECEIVER_POLL_TICKS);
  system.runInterval(reconcile, RECONCILE_TICKS);
}
