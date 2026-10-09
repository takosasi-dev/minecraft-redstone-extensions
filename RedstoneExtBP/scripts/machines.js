/**
 * パートJ/K: 設置・排出・トラップ・音
 *
 *   J-1 wr:block_dispenser  信号を受けるたび、上のチェストのブロックを前面に置く
 *   J-2 wr:hopper_dropper   上から下へ高速でアイテムを移す。下が無ければ吐き出す
 *   J-3 wr:spike            上に乗ったモブにダメージ。倒すと経験値を落とす
 *   K-1 wr:block_breaker    信号を受けるたび、前面のブロックを壊して上のチェストへ
 *   K-2 wr:sound_block      信号の立ち上がりで効果音を鳴らす
 *
 * ホッパードロッパーとスパイクは「信号を受けている間は止まる」（バニラのホッパー準拠）。
 * ディスペンサー・ブレイカー・サウンドは逆で、**信号が引き金**。
 * 出力は持たないので redstone_consumer を付けられる（producer とは同居できない）。
 *
 * **稼働中フラグは wr:busy。wr:on にしてはいけない。**
 * util.js の powerFrom() は wr:on を「出力 15」として読むので、
 * 稼働中だけ隣のワイヤーが勝手に点いてしまう（v1.28.1 まで実際にそうなっていた）。
 */

import { ItemStack } from "@minecraft/server";
import { neighborBlock, maxIncomingPower, invalidateFacts } from "./util.js";
import { scheduleUpdate, applyStates, registerUpdater } from "./propagation_helper.js";

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

function frontOf(block) {
  const front = block.permutation.getState("minecraft:cardinal_direction");
  return typeof front === "string" ? front : "north";
}

/**
 * 今このブロックに信号が入っているか。
 *
 * **`onRedstoneUpdate` の `e.redstonePower` を当てにしてはいけない。**
 * v1.27.0 で最初そう書いてブロックディスペンサーが実機で一切動かなかった。
 * 理由は 2 つ:
 *   1. イベントが期待どおりに来ないことがある。来なければステートが
 *      永久に「信号なし」のままになる（ディスペンサーは信号で撃つので沈黙する）。
 *   2. `wr:` ブロックの出力はステート直読みでしか分からず、
 *      バニラのレッドストーンイベントを起こさない。つまりワイヤーで繋いでも見えない。
 * 確認済みで動いているブロック（調光ランプ等）はどれも、イベントは
 * 「何か変わったから計算し直せ」という合図としてだけ使い、
 * 値そのものは毎回 `maxIncomingPower()` で読み直している。それに揃える。
 */
function powered(block) {
  return maxIncomingPower(block) > 0;
}

/** 信号の有無をステートに写す。表示（テクスチャ）用なので値は毎回読み直す。 */
function syncPowered(block) {
  const on = powered(block);
  applyStates(block, { "wr:powered": on });
  return on;
}

/** イベントは合図としてだけ使う（値は updater 側で読み直す）。 */
function redstoneGate(updater) {
  return (e) => {
    scheduleUpdate(e.block, updater);
  };
}

// ---------------------------------------------------------------------------
// J-1. ブロックディスペンサー
// ---------------------------------------------------------------------------
//
// **信号の立ち上がりごとに 1 個**置く。押しっぱなしで積み続けないよう
// wr:armed で立ち上がりを取る（T フリップフロップと同じ方式）。
//
// 置けるのは **前面が空気のときだけ**。既に何かある場所は上書きしない
// （うっかり建築を消さないため）。
// アイテムIDとブロックIDが違うもの（レッドストーンの粉など）は
// setType が例外を投げるので、その場合は消費せずに諦める。

function placeFront(block) {
  const source = containerAt(block, "up");
  if (!source) return false;

  const target = neighborBlock(block, frontOf(block));
  if (!target || !target.isAir) return false;

  for (let slot = 0; slot < (source.size ?? 0); slot += 1) {
    let item;
    try {
      item = source.getItem(slot);
    } catch {
      continue;
    }
    if (!item) continue;

    try {
      target.setType(item.typeId);
      invalidateFacts(); // ワールドを書き換えたので導出結果は捨てる
    } catch {
      // ブロックとして置けないアイテム。消費せず次のスロットへ
      continue;
    }

    try {
      if ((item.amount ?? 1) > 1) {
        item.amount -= 1;
        source.setItem(slot, item);
      } else {
        source.setItem(slot, undefined);
      }
    } catch {
      // 減らせなかった。置いたぶんを戻して増殖を防ぐ
      try {
        target.setType("minecraft:air");
        invalidateFacts();
      } catch {
        /* 戻せなければ諦める */
      }
      return false;
    }
    return true;
  }
  return false;
}

function updateBlockDispenser(block) {
  // このブロックだけは信号が **引き金**（他の 2 種のように停止ではない）
  const on = syncPowered(block);
  const armed = block.permutation.getState("wr:armed") !== false;

  if (!on) {
    // 信号が切れている → 次の立ち上がりに備える
    if (!armed) applyStates(block, { "wr:armed": true, "wr:busy": false });
    return;
  }
  if (!armed) return; // 入りっぱなし。もう置いた

  const placed = placeFront(block);
  applyStates(block, { "wr:armed": false, "wr:busy": placed });
}
registerUpdater("wr:block_dispenser", updateBlockDispenser);

export const blockDispenserComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateBlockDispenser);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateBlockDispenser);
  },
  onRedstoneUpdate: redstoneGate(updateBlockDispenser),
};

// ---------------------------------------------------------------------------
// J-2. ホッパードロッパー
// ---------------------------------------------------------------------------
//
// 上のコンテナから下へアイテムを移す。**下にコンテナが無ければ
// アイテムとして吐き出す**（ホッパーとドロッパーを 1 つにしたもの）。
//
// バニラのホッパーは 8 tick に 1 個だが、こちらは 4 tick に 1 スタック。
// 大量のアイテムを捌く場面でホッパーを何本も並べずに済ませるのが狙い。

/** 1 回に運ぶスロット数。 */
const MOVE_SLOTS = 4;

function updateHopperDropper(block) {
  if (syncPowered(block)) {
    applyStates(block, { "wr:busy": false });
    return;
  }

  const source = containerAt(block, "up");
  if (!source) {
    applyStates(block, { "wr:busy": false });
    return;
  }
  const sink = containerAt(block, "down");
  let moved = 0;

  for (let slot = 0; slot < (source.size ?? 0) && moved < MOVE_SLOTS; slot += 1) {
    let item;
    try {
      item = source.getItem(slot);
    } catch {
      continue;
    }
    if (!item) continue;

    if (sink) {
      let leftover;
      try {
        leftover = sink.addItem(item);
      } catch {
        break;
      }
      // 入りきらなかったぶんは戻す（消さない）
      try {
        source.setItem(slot, leftover ?? undefined);
      } catch {
        break;
      }
      if (leftover) break; // 下が満杯。ここで打ち切る
    } else {
      // 下にコンテナが無ければドロッパーとして吐き出す
      const below = neighborBlock(block, "down");
      if (!below || !below.isAir) break;
      try {
        block.dimension.spawnItem(item, {
          x: block.location.x + 0.5,
          y: block.location.y - 0.5,
          z: block.location.z + 0.5,
        });
        source.setItem(slot, undefined);
      } catch {
        break;
      }
    }
    moved += 1;
  }

  applyStates(block, { "wr:busy": moved > 0 });
}
registerUpdater("wr:hopper_dropper", updateHopperDropper);

export const hopperDropperComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateHopperDropper);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateHopperDropper);
  },
  onRedstoneUpdate: redstoneGate(updateHopperDropper),
};

// ---------------------------------------------------------------------------
// J-3. スパイク
// ---------------------------------------------------------------------------
//
// 真上にいるモブにダメージを与える。**プレイヤーには効かない**
// （少人数の身内サーバー向けなので、事故で味方を刺すほうが害が大きい）。
//
// 経験値について: ブロックで倒したモブはバニラでは経験値を落とさない。
// そこで**倒したときに自分で経験値オーブを湧かせる**。
//
// スニーク + 右クリックで「加熱」に切り替えると、ダメージの前に火をつける。
// 火がついた状態で死んだモブは**バニラの仕組みで焼けた肉を落とす**ので、
// ドロップ表を触らずに「溶岩のスパイク」相当が作れる。

/** 1 回のダメージ量（ハート 2 個ぶん）。 */
const SPIKE_DAMAGE = 4;
/** 倒したときに湧かせる経験値オーブの数。 */
const SPIKE_XP_ORBS = 3;
/** 加熱モードで燃やす秒数。 */
const SPIKE_BURN_SECONDS = 5;

function healthOf(entity) {
  try {
    const health = entity.getComponent("minecraft:health");
    return typeof health?.currentValue === "number" ? health.currentValue : undefined;
  } catch {
    return undefined;
  }
}

function updateSpike(block) {
  if (syncPowered(block)) {
    applyStates(block, { "wr:busy": false });
    return;
  }

  const above = {
    x: block.location.x + 0.5,
    y: block.location.y + 1,
    z: block.location.z + 0.5,
  };

  let victims = [];
  try {
    victims = block.dimension.getEntities({
      location: above,
      maxDistance: 1.2,
      // プレイヤーとアイテムは刺さない
      excludeTypes: ["minecraft:player", "minecraft:item", "minecraft:xp_orb"],
    });
  } catch (e) {
    console.warn(`[wr] spike scan failed: ${e}`);
    return;
  }

  const hot = block.permutation.getState("wr:hot") === true;
  let hit = 0;

  for (const entity of victims) {
    const before = healthOf(entity);
    if (before === undefined || before <= 0) continue;

    try {
      // 先に燃やす。焼けた状態で死ねばバニラが調理済みの肉を落とす
      if (hot) entity.setOnFire?.(SPIKE_BURN_SECONDS, true);
      entity.applyDamage(SPIKE_DAMAGE);
    } catch {
      continue;
    }
    hit += 1;

    const after = healthOf(entity);
    if (after !== undefined && after > 0) continue;
    // 倒した → 経験値を湧かせる（ブロック死では本来落ちないため）
    for (let i = 0; i < SPIKE_XP_ORBS; i += 1) {
      try {
        block.dimension.spawnEntity("minecraft:xp_orb", above);
      } catch {
        break;
      }
    }
  }

  applyStates(block, { "wr:busy": hit > 0 });
}
registerUpdater("wr:spike", updateSpike);

export const spikeComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateSpike);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateSpike);
  },
  onRedstoneUpdate: redstoneGate(updateSpike),
  /** 右クリックで通常／加熱を切り替える。 */
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;
    const hot = e.block.permutation.getState("wr:hot") !== true;
    applyStates(e.block, { "wr:hot": hot });
    player.onScreenDisplay.setActionBar({
      translate: hot ? "wr.msg.spike.hot" : "wr.msg.spike.normal",
    });
  },
};

// ---------------------------------------------------------------------------
// K-1. ブロックブレイカー
// ---------------------------------------------------------------------------
//
// 信号の立ち上がりごとに、前面のブロックを 1 個壊して **上のチェスト**へ入れる。
// ディスペンサーと対になる（あちらは上から取って前に置く、こちらは前から取って上へ）。
//
// ---------------------------------------------------------------------------
// ドロップの決め方 —— シルクタッチ相当にしてある
// ---------------------------------------------------------------------------
// バニラの採掘ドロップ（石→丸石、鉱石→原石、草→土、幸運の倍率…）を
// スクリプトから正確に再現する手段が無い。表を持てば必ずどこかで間違うので、
// **「壊したブロックそのものが出る」= シルクタッチ相当**に振り切ってある。
// 予測しやすく、表のメンテもいらない。石を入れたら石が出る。
//
// ---------------------------------------------------------------------------
// 壊さないもの
// ---------------------------------------------------------------------------
// ・空気・液体 …… 壊すものが無い
// ・岩盤など壊せないもの …… destroy_time が無限のものは触らない
// ・**wr: のブロック** …… 精錬機や施錠のように座標キーの動的プロパティを持つものが
//   あり、スクリプトで消すと onPlayerDestroy が走らず記録だけが残る（幽霊化する）
// ・**中身を持つブロック**（チェスト等）…… 中身ごと消えるのは事故が大きすぎる

/** 壊してはいけないバニラブロック。 */
const UNBREAKABLE = new Set([
  "minecraft:bedrock",
  "minecraft:barrier",
  "minecraft:command_block",
  "minecraft:chain_command_block",
  "minecraft:repeating_command_block",
  "minecraft:structure_block",
  "minecraft:jigsaw",
  "minecraft:end_portal_frame",
  "minecraft:end_portal",
  "minecraft:nether_portal",
]);

/** そのブロックを壊してよいか。 */
function breakable(target) {
  if (!target) return false;
  const id = target.typeId;
  if (typeof id !== "string") return false;
  if (target.isAir || target.isLiquid) return false;
  if (UNBREAKABLE.has(id)) return false;
  // wr: ブロックは動的プロパティを持つものがあるのでスクリプトからは壊さない
  if (id.startsWith("wr:")) return false;
  // 中身のあるブロックは触らない（チェストが丸ごと消えるのを防ぐ）
  try {
    if (target.getComponent("minecraft:inventory")) return false;
  } catch {
    /* インベントリを問い合わせられないブロックはそのまま続行 */
  }
  return true;
}

/**
 * 前面のブロックを壊して上のコンテナへ。
 * 上にコンテナが無ければ足元に落とす（ホッパードロッパーと同じ考え方）。
 * @returns 壊せたか
 */
function breakFront(block) {
  const target = neighborBlock(block, frontOf(block));
  if (!breakable(target)) return false;

  // 先にアイテムを作る。作れないものは壊さない（消滅させないため）
  let drop;
  try {
    drop = target.getItemStack?.(1, true) ?? new ItemStack(target.typeId, 1);
  } catch {
    return false;
  }
  if (!drop) return false;

  try {
    target.setType("minecraft:air");
    invalidateFacts(); // ワールドを書き換えたので導出結果は捨てる
  } catch {
    return false;
  }

  // 上のチェストへ。入らなければ足元に落とす（消さない）
  const sink = containerAt(block, "up");
  if (sink) {
    let leftover;
    try {
      leftover = sink.addItem(drop);
    } catch {
      leftover = drop;
    }
    if (!leftover) return true;
    drop = leftover;
  }
  try {
    block.dimension.spawnItem(drop, {
      x: block.location.x + 0.5,
      y: block.location.y + 1,
      z: block.location.z + 0.5,
    });
  } catch {
    /* 落とせなくてもブロックは壊れている */
  }
  return true;
}

function updateBlockBreaker(block) {
  // ディスペンサーと同じく **信号が引き金**
  const on = syncPowered(block);
  const armed = block.permutation.getState("wr:armed") !== false;

  if (!on) {
    if (!armed) applyStates(block, { "wr:armed": true, "wr:busy": false });
    return;
  }
  if (!armed) return; // 入りっぱなし。もう壊した

  const broke = breakFront(block);
  applyStates(block, { "wr:armed": false, "wr:busy": broke });
}
registerUpdater("wr:block_breaker", updateBlockBreaker);

export const blockBreakerComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateBlockBreaker);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateBlockBreaker);
  },
  onRedstoneUpdate: redstoneGate(updateBlockBreaker),
};

// ---------------------------------------------------------------------------
// K-2. サウンドブロック
// ---------------------------------------------------------------------------
//
// 信号の立ち上がりで効果音を 1 回鳴らす。向きは持たない。
//
// バニラのノートブロックは音階を鳴らすためのもので、
// 「警報を鳴らす」「扉が開いた合図を出す」のような用途には向かない。
// ここでは**用途で選べる 16 種**を用意して、右クリックで巡回させる。
//
// 音量・ピッチは固定。ステートに持たせると 16×16 で状態数を食うわりに、
// 実際に欲しくなるのは「どの音か」だけなので割り切っている。

/** wr:sound の値 → 鳴らす音。用途がはっきりしているものを選んである。 */
const SOUNDS = [
  "note.bell", // 0 呼び鈴
  "note.harp", // 1 やわらかい合図
  "random.orb", // 2 完了
  "random.levelup", // 3 達成
  "random.click", // 4 カチッ
  "random.pop", // 5 ぽん
  "random.anvil_land", // 6 重い音
  "random.explode", // 7 爆発
  "mob.wither.spawn", // 8 警報（強）
  "ambient.weather.thunder", // 9 雷
  "random.glass", // 10 ガラス割れ
  "random.door_open", // 11 扉が開く
  "random.door_close", // 12 扉が閉まる
  "mob.villager.yes", // 13 承認
  "mob.villager.no", // 14 拒否
  "raid.horn", // 15 襲撃の角笛
];

function soundIndexOf(block) {
  const index = block.permutation.getState("wr:sound");
  return typeof index === "number" && index >= 0 && index < SOUNDS.length ? index : 0;
}

function playFrom(block) {
  const id = SOUNDS[soundIndexOf(block)];
  const at = {
    x: block.location.x + 0.5,
    y: block.location.y + 0.5,
    z: block.location.z + 0.5,
  };
  // dimension.playSound は座標指定で鳴らせる（プレイヤーを特定しなくてよい）
  try {
    block.dimension.playSound(id, at, { volume: 1, pitch: 1 });
  } catch (e) {
    console.warn(`[wr] playSound failed (${id}): ${e}`);
  }
}

function updateSoundBlock(block) {
  const on = maxIncomingPower(block) > 0;
  const armed = block.permutation.getState("wr:armed") !== false;

  if (!on) {
    if (!armed) applyStates(block, { "wr:armed": true });
    return;
  }
  if (!armed) return; // 入りっぱなし。もう鳴らした

  applyStates(block, { "wr:armed": false });
  playFrom(block);
}
registerUpdater("wr:sound_block", updateSoundBlock);

export const soundBlockComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateSoundBlock);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateSoundBlock);
  },
  onRedstoneUpdate(e) {
    scheduleUpdate(e.block, updateSoundBlock);
  },
  /** 右クリックで次の音へ。試聴も兼ねてその場で鳴らす。 */
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;
    const next = (soundIndexOf(e.block) + 1) % SOUNDS.length;
    applyStates(e.block, { "wr:sound": next });
    playFrom(e.block);
    player.onScreenDisplay.setActionBar({
      translate: "wr.msg.sound.selected",
      with: [String(next), SOUNDS[next]],
    });
  },
};

/** テスト用。選べる音の一覧。 */
export const SOUND_IDS = SOUNDS;
