/**
 * パートC の時間系ブロック
 *   C-2 wr:pulse_generator    外部入力がある間だけ 0/15 をトグルし続ける
 *   C-3 wr:variable_repeater  入力変化を wr:delay×2 tick 遅らせて出力する
 *   C-7 wr:asym_repeater      立ち上がりと立ち下がりで別々の遅延をかける
 *
 * どちらも「背面から入力を受け、前面にだけ出力する」指向性ブロック。
 * 仕様書には向きの指定が無かったが、全方向に出力すると自分の出力を自分の
 * 入力として読んでしまい、一度動き出すと永久に止まらなくなる。
 * そのため論理回路（パートD）と同じ minecraft:cardinal_direction 方式に揃えた。
 */

import { system, world } from "@minecraft/server";
import { OPPOSITE, powerFrom, blockKey, worldHour } from "./util.js";
import { openNumberSetting, openNumberSettings, stepValue } from "./block_ui.js";
import { registerDpSettings } from "./config_tool.js";
import {
  scheduleUpdate,
  applyStates,
  registerUpdater,
  scheduleNeighbors,
} from "./propagation_helper.js";

/**
 * パルス生成機のトグル周期（tick）の範囲。**1〜2400 tick（0.05 秒〜2 分）**。
 *
 * v1.30.1 までは十の位（wr:period_tens 0-4）と一の位（wr:period_ones 0-9）の
 * 2 ステートに分けて 1〜50 tick を表していた。
 * 1 ステートに持てる値は 16 個までなので、これ以上広げるには
 * ステートを足す（＝掛け算で状態数が増える）しかなかった。
 *
 * v1.31.0 で**周期をワールド動的プロパティに移した**ので、
 * 上限はステートの制約から外れた（ブロック側は 400 → 8 状態、予算 -392）。
 * 「長い周期は粗い刻みにする」ようなモード切り替えも要らず、
 * 1 本のスライダーが端から端まで 1 tick 刻みのまま伸びている。
 */
const PERIOD_MIN = 1;
const PERIOD_MAX = 2400;
/** 既定の周期。ステートの既定値が 5 tick だった頃と合わせてある。 */
const PERIOD_DEFAULT = 5;

/**
 * スニーク + 右クリックで送るプリセット（tick）。
 *
 * 1〜2400 を +1 で回すと 30 秒→2 分だけで 1800 回になるので、
 * 微調整ではなく**よく使う値の巡回**に割り当てている。
 * 細かい値はスライダー側で決める。
 */
const PERIOD_PRESETS = [5, 20, 100, 600, 1200, 2400];

/** 周期を入れるワールド動的プロパティの接頭辞。 */
const PERIOD_PREFIX = "wr:pulse|";
/**
 * wr:delay 1 段階あたりの tick 数と、段数の範囲（実時間では 2〜32 tick）。
 *
 * 1 つのステートに持てる値は 16 個までなので、段数はここが上限。
 * v1.30.0 で 8 段（16 tick）から 16 段（32 tick）に広げた。
 * 遅延は見た目に影響しないので、広げてもパーミュテーションは増えない。
 */
const DELAY_STEP = 2;
const DELAY_MIN = 1;
const DELAY_MAX = 16;

const clampPeriod = (v) =>
  Math.max(PERIOD_MIN, Math.min(PERIOD_MAX, Math.round(v) || PERIOD_DEFAULT));

/** 周期（tick）を読む。未設定は既定値。 */
export function periodOf(block) {
  const raw = world.getDynamicProperty(
    PERIOD_PREFIX + blockKey(block.dimension.id, block.location)
  );
  return typeof raw === "number" ? clampPeriod(raw) : PERIOD_DEFAULT;
}

function writePeriod(block, period) {
  const value = clampPeriod(period);
  world.setDynamicProperty(
    PERIOD_PREFIX + blockKey(block.dimension.id, block.location),
    value === PERIOD_DEFAULT ? undefined : value
  );
  return value;
}

/** ブロックが無くなったときの後始末。放っておくと幽霊プロパティが残る。 */
export function clearPeriod(dimensionId, location) {
  world.setDynamicProperty(PERIOD_PREFIX + blockKey(dimensionId, location), undefined);
}

/** 今の値の次に大きいプリセット。上限まで来たら先頭へ戻る。 */
/** presets の中から現在値より大きい最初の値へ。無ければ先頭へ戻る（巡回）。 */
function nextPreset(value, presets) {
  return presets.find((v) => v > value) ?? presets[0];
}

/** 前面（出力方向）。取得できない場合は north 扱い。 */
function frontOf(block) {
  const front = block.permutation.getState("minecraft:cardinal_direction");
  return typeof front === "string" ? front : "north";
}

/** 背面（主入力）から届いている電力。 */
function backInput(block) {
  return powerFrom(block, OPPOSITE[frontOf(block)]);
}

// ---------------------------------------------------------------------------
// C-2. パルス生成機
// ---------------------------------------------------------------------------

/** 稼働中のパルス生成機。key → { dimension, location, period, counter } */
const running = new Map();

function updatePulseGenerator(block) {
  const key = blockKey(block.dimension.id, block.location);
  const powered = backInput(block) > 0;

  if (!powered) {
    running.delete(key);
    if (applyStates(block, { "wr:on": false })) scheduleNeighbors(block);
    return;
  }

  const period = periodOf(block);
  const entry = running.get(key);
  if (entry) {
    entry.period = period;
  } else {
    running.set(key, {
      dimension: block.dimension,
      location: { ...block.location },
      period,
      counter: 0,
    });
  }
}

/**
 * 稼働中のパルス生成機をまとめて 1 tick 進める。
 * ブロックごとに runInterval を持たせると設置数ぶんタイマーが増えるので、
 * 共有の 1 tick ループ + カウンタ方式にしている。
 */
function stepPulseGenerators() {
  if (running.size === 0) return;
  for (const [key, entry] of [...running]) {
    entry.counter += 1;
    if (entry.counter < entry.period) continue;
    entry.counter = 0;

    let block;
    try {
      block = entry.dimension.getBlock(entry.location);
    } catch {
      running.delete(key);
      continue;
    }
    if (!block) continue; // 未ロード: 記録は残したまま待つ
    if (block.typeId !== "wr:pulse_generator") {
      running.delete(key);
      continue;
    }
    const on = block.permutation.getState("wr:on");
    if (applyStates(block, { "wr:on": !on })) scheduleNeighbors(block);
  }
}
registerUpdater("wr:pulse_generator", updatePulseGenerator);

export const pulseGeneratorComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updatePulseGenerator);
  },
  onTick(e) {
    scheduleUpdate(e.block, updatePulseGenerator);
  },
  onPlayerDestroy(e) {
    running.delete(blockKey(e.block.dimension.id, e.block.location));
    clearPeriod(e.block.dimension.id, e.block.location);
  },
  /**
   * 右クリック            … スライダーで 1〜2400 tick を直接指定
   * スニーク + 右クリック … よく使う値を巡回（5 → 20 → 100 → 600 → 1200 → 2400 → 5）
   *
   * 他ブロックのスニークは「+1 の微調整」だが、ここは範囲が 2400 まであるので
   * +1 では端から端まで届かない（30 秒→2 分だけで 1800 回）。
   * 実際に使う値だけ拾えるほうが速いので、プリセット送りにしている。
   */
  onPlayerInteract(e) {
    const block = e.block;
    const player = e.player;
    if (!player) return;
    if (player.isSneaking) {
      setPeriod(block, nextPreset(periodOf(block), PERIOD_PRESETS), player);
      return;
    }
    openNumberSetting(player, block, {
      titleKey: "wr.ui.pulse.title",
      labelKey: "wr.ui.pulse.label",
      min: PERIOD_MIN,
      max: PERIOD_MAX,
      value: periodOf(block),
      apply: (fresh, value) => setPeriod(fresh, value, player),
    });
  },
};

// 設定コピー機の受け口。クリップボードのキーは "wr:period" の 1 本にした
// （ステートだった頃の "wr:period_tens" / "wr:period_ones" は 1〜50 しか表せず、
//  そのまま使うと新しい範囲を写せない）。
registerDpSettings("wr:pulse_generator", {
  read: (block) => ({ "wr:period": periodOf(block) }),
  write: (block, values) => {
    const period = values["wr:period"];
    if (typeof period !== "number") return false;
    setPeriod(block, period);
    return true;
  },
});

/**
 * 周期を設定して再起動させる。
 *
 * `running` を消すのは、稼働中のカウンタを新しい周期で数え直させるため
 * （残さないと「今の周期で数え終わるまで前の間隔のまま」になる）。
 */
function setPeriod(block, period, player) {
  const value = writePeriod(block, period);
  running.delete(blockKey(block.dimension.id, block.location));
  scheduleUpdate(block, updatePulseGenerator);
  player?.onScreenDisplay.setActionBar({
    translate: "wr.msg.pulse.period",
    with: [String(value)],
  });
}


// ---------------------------------------------------------------------------
// C-3. 可変ディレイリピーター
// ---------------------------------------------------------------------------

/**
 * 保留中の出力変更。key → { handle, target }
 *
 * 制約: これはメモリ上の Map なので、ワールドをリロードすると保留中の
 * タイマーは失われる。リロード直後の 1 回目の onTick / onRedstoneUpdate で
 * 入力を読み直して整合するため実害は「遅延が一度リセットされる」だけだが、
 * 厳密なタイミング回路を組む場合は注意。
 */
const pendingOutput = new Map();

function cancelPending(key) {
  const entry = pendingOutput.get(key);
  if (!entry) return;
  system.clearRun(entry.handle);
  pendingOutput.delete(key);
}

/**
 * 「出力を target にする」を delay tick 後に 1 回だけ予約する。
 * 可変ディレイリピーターと非対称ディレイリピーターの共通部分。
 *
 * @param typeId 予約時のブロック種別。発火時に別のブロックへ置き換わっていたら捨てる。
 */
function scheduleOutput(block, typeId, target, delay) {
  const dimension = block.dimension;
  const location = { ...block.location };
  const key = blockKey(dimension.id, location);

  const existing = pendingOutput.get(key);
  if (existing && existing.target === target) return; // 同じ変更を予約済み

  cancelPending(key);

  const handle = system.runTimeout(() => {
    pendingOutput.delete(key);
    let fresh;
    try {
      fresh = dimension.getBlock(location);
    } catch {
      return;
    }
    if (!fresh || fresh.typeId !== typeId) return;
    // 出力はバイナリ（ON のとき常に 15）。パーミュテーション側で power を決めている。
    if (applyStates(fresh, { "wr:on": target })) scheduleNeighbors(fresh);
  }, Math.max(1, delay)); // 遅延 0 段でも最短は 1 tick（このアドオンの構造上の下限）

  pendingOutput.set(key, { handle, target });
}

function updateVariableRepeater(block) {
  const key = blockKey(block.dimension.id, block.location);

  const target = backInput(block) > 0;
  const current = block.permutation.getState("wr:on") === true;

  if (target === current) {
    // すでに目的の状態。保留中の逆方向の変更は無効化する。
    cancelPending(key);
    return;
  }

  const delayState = block.permutation.getState("wr:delay");
  const delay = (typeof delayState === "number" ? delayState : 1) * DELAY_STEP;
  scheduleOutput(block, "wr:variable_repeater", target, delay);
}
registerUpdater("wr:variable_repeater", updateVariableRepeater);

export const variableRepeaterComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateVariableRepeater);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateVariableRepeater);
  },
  onPlayerDestroy(e) {
    cancelPending(blockKey(e.block.dimension.id, e.block.location));
  },
  /**
   * 右クリックでスライダーを開いて遅延を直接指定（tick 単位で表示する）。
   * スニーク + 右クリックは 1 段ぶんの微調整。
   */
  onPlayerInteract(e) {
    const block = e.block;
    const player = e.player;
    if (!player) return;

    const current = block.permutation.getState("wr:delay");
    const delay = typeof current === "number" ? current : DELAY_MIN;

    if (player.isSneaking) {
      setDelay(block, stepValue(delay, DELAY_MIN, DELAY_MAX), player);
      return;
    }
    // スライダーは段数ではなく実際の tick 数で見せる（2 tick 刻み）
    openNumberSetting(player, block, {
      titleKey: "wr.ui.repeater.title",
      labelKey: "wr.ui.repeater.label",
      min: DELAY_MIN * DELAY_STEP,
      max: DELAY_MAX * DELAY_STEP,
      step: DELAY_STEP,
      value: delay * DELAY_STEP,
      apply: (fresh, ticks) => setDelay(fresh, Math.round(ticks / DELAY_STEP), player),
    });
  },
};

/** 遅延（段数）を設定する。 */
function setDelay(block, delay, player) {
  const clamped = Math.max(DELAY_MIN, Math.min(DELAY_MAX, delay));
  applyStates(block, { "wr:delay": clamped });
  player?.onScreenDisplay.setActionBar({
    translate: "wr.msg.repeater.delay",
    with: [String(clamped * DELAY_STEP)],
  });
}

// ---------------------------------------------------------------------------
// C-7. 非対称ディレイリピーター (wr:asym_repeater)
// ---------------------------------------------------------------------------
//
// 可変ディレイリピーターは 1 つの遅延を立ち上がりにも立ち下がりにも使うので、
// **「点くのは速く、消えるのはゆっくり」が作れない**。
// 消灯を遅らせる照明、離してもしばらく回り続けるドロッパー、
// チャタリング除け（短い入力を無視する）のような形はどれもこれで、
// 従来はリピーター＋論理回路を数個組まないと表せなかった。
//
// ここでは立ち上がり用 (rise) と立ち下がり用 (fall) を別々に持つ。
// どちらも 0〜600 tick（0〜30 秒）。0 にすればその向きだけ最速になる。
// v1.31.1 で 30 tick 上限から拡張。動的プロパティなので段階に区切る理由が無く、
// tick を直接持てる（後述のとおりステートの 16 値制限からは元々外れている）。
//
// 遅延の待ち方は可変ディレイリピーターと同じ scheduleOutput()。
// **保留中の遅延はワールドをリロードすると失われる**という制約も同じ
// （メモリ上の pendingOutput に持っているため）。
//
// **2 つの遅延はブロックステートではなくワールド動的プロパティに持つ**（v1.30.1）。
// どちらも見た目には効かないのでパーミュテーションの条件式では使っておらず、
// ステートに置くと 16 × 16 = 256 倍がそのまま状態数の予算（65,536）に乗るだけだった。
// 外して 2,048 → 8 状態。**設定値が 2 つ以上あると掛け算になる**ので、
// 「設定値は見た目に効かないから安い」は 1 つのときだけ成り立つ。
//
// 動的プロパティなのでリロードしても残る（消えるのは保留中のタイマーだけで、
// これはステートに持っていた頃と同じ）。座標をキーにする以上、
// **壊されたら消す**のと **ピストンで動かさない**のが要る。
// 前者は onPlayerDestroy と blockExplode（main.js）で、
// 後者は movement_type: immovable（v1.31.3。popped だとピストンで壊れても
// onPlayerDestroy が来ず、元の座標に設定が残っていた）。

/** rise / fall の範囲（tick を直接指定。スライダーの刻みだけ ASYM_STEP）。 */
const ASYM_STEP = 2;
const ASYM_MIN = 0;
const ASYM_MAX = 600; // 30 秒

/** 遅延 2 本を入れるワールド動的プロパティの接頭辞。値は rise * ASYM_PACK + fall。 */
const ASYM_PREFIX = "wr:asym|";
const ASYM_PACK = 1024; // ASYM_MAX（600）を余裕を持って超える桁

/**
 * 遅延 2 本を読む。未設定（置いたばかり）は 0/0 = どちらも最速。
 * ステートの既定値が 0 だった頃と同じ挙動になるので、初期化は要らない。
 */
export function asymDelaysOf(block) {
  const raw = world.getDynamicProperty(
    ASYM_PREFIX + blockKey(block.dimension.id, block.location)
  );
  const packed = typeof raw === "number" ? raw : 0;
  return { rise: Math.floor(packed / ASYM_PACK), fall: packed % ASYM_PACK };
}

function writeAsymDelays(block, rise, fall) {
  const clamp = (v) => Math.max(ASYM_MIN, Math.min(ASYM_MAX, Math.round(v) || 0));
  const r = clamp(rise);
  const f = clamp(fall);
  world.setDynamicProperty(
    ASYM_PREFIX + blockKey(block.dimension.id, block.location),
    r === 0 && f === 0 ? undefined : r * ASYM_PACK + f
  );
  return { rise: r, fall: f };
}

/** ブロックが無くなったときの後始末。放っておくと幽霊プロパティが残る。 */
export function clearAsymDelays(dimensionId, location) {
  world.setDynamicProperty(ASYM_PREFIX + blockKey(dimensionId, location), undefined);
}

function updateAsymRepeater(block) {
  const key = blockKey(block.dimension.id, block.location);

  const target = backInput(block) > 0;
  const current = block.permutation.getState("wr:on") === true;

  if (target === current) {
    cancelPending(key);
    return;
  }

  // 立ち上がりなら rise、立ち下がりなら fall。ここだけが可変リピーターとの違い。
  const { rise, fall } = asymDelaysOf(block);
  scheduleOutput(block, "wr:asym_repeater", target, target ? rise : fall);
}
registerUpdater("wr:asym_repeater", updateAsymRepeater);

export const asymRepeaterComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateAsymRepeater);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateAsymRepeater);
  },
  onPlayerDestroy(e) {
    cancelPending(blockKey(e.block.dimension.id, e.block.location));
    clearAsymDelays(e.block.dimension.id, e.block.location);
  },
  /**
   * 右クリック            … スライダー 2 本（ON 遅延 / OFF 遅延）を開く
   * スニーク + 右クリック … 2 つの遅延を入れ替える
   *
   * 他のブロックのスニーク操作は「+1 の微調整」だが、ここは値が 2 つあって
   * どちらを動かすのか決められない。代わりに、実際によく使う
   * 「速く点いて遅く消える ⇔ 遅く点いて速く消える」の反転を割り当てている。
   */
  onPlayerInteract(e) {
    const block = e.block;
    const player = e.player;
    if (!player) return;

    const { rise, fall } = asymDelaysOf(block);

    if (player.isSneaking) {
      setAsymDelays(block, fall, rise, player);
      return;
    }
    // スライダーは tick を直接見せる（2 tick 刻み）
    openNumberSettings(player, block, {
      titleKey: "wr.ui.asym.title",
      sliders: [
        {
          labelKey: "wr.ui.asym.rise",
          min: ASYM_MIN,
          max: ASYM_MAX,
          step: ASYM_STEP,
          value: rise,
        },
        {
          labelKey: "wr.ui.asym.fall",
          min: ASYM_MIN,
          max: ASYM_MAX,
          step: ASYM_STEP,
          value: fall,
        },
      ],
      apply: (fresh, [riseTicks, fallTicks]) => setAsymDelays(fresh, riseTicks, fallTicks, player),
    });
  },
};

// 設定コピー機はステートを読み書きするので、動的プロパティ組はここで受け口を渡す。
// クリップボードのキーはステートだった頃と同じ "wr:rise" / "wr:fall" のままにして、
// 古いワールドのクリップボードでも読めるようにしてある。
registerDpSettings("wr:asym_repeater", {
  read: (block) => {
    const { rise, fall } = asymDelaysOf(block);
    return { "wr:rise": rise, "wr:fall": fall };
  },
  write: (block, values) => {
    const rise = values["wr:rise"];
    const fall = values["wr:fall"];
    if (typeof rise !== "number" && typeof fall !== "number") return false;
    const current = asymDelaysOf(block);
    writeAsymDelays(
      block,
      typeof rise === "number" ? rise : current.rise,
      typeof fall === "number" ? fall : current.fall
    );
    scheduleUpdate(block, updateAsymRepeater);
    return true;
  },
});

/**
 * ON 遅延・OFF 遅延（tick）をまとめて設定する。
 *
 * 動的プロパティを書いてもパーミュテーションは動かない＝再計算のきっかけが無いので、
 * 自分で更新を予約する（ステートに持っていた頃は applyStates が兼ねていた）。
 */
function setAsymDelays(block, rise, fall, player) {
  const { rise: r, fall: f } = writeAsymDelays(block, rise, fall);
  scheduleUpdate(block, updateAsymRepeater);
  player?.onScreenDisplay.setActionBar({
    translate: "wr.msg.asym.delay",
    with: [String(r), (r / 20).toFixed(1), String(f), (f / 20).toFixed(1)],
  });
}

// ---------------------------------------------------------------------------
// C-5. ワンショット (wr:one_shot)
// ---------------------------------------------------------------------------
//
// 背面入力の**立ち上がりで、決めた長さだけ**前面に 15 を出す。
// 出している間は追加の入力を無視する（モノステーブル）。
//
// このアドオンには「遅らせる」（可変リピーター）と
// 「入力がある間ずっと点滅」（パルス生成機）はあったが、
// **押した瞬間に決まった長さのパルスを 1 発**が無かった。
// ボタン 1 個で扉を数秒開ける、という一番よく使う形がこれ。
//
// 残り時間は system.runTimeout ではなく**自分で毎 tick 数え直す**方式（v1.30.0 以来）。
// メモリ上のタイマー（scheduleOutput 方式）はワールドをリロードすると消えて
// **出しっぱなしになる**（可変リピーターの既知の制約）ため、ここでは使わない。
//
// **長さ・残りはどちらもワールド動的プロパティに持つ（v1.31.2）。**
// v1.31.1 まではブロックステート（wr:length 1〜15 段 / wr:remain 0〜15）だった。
// DPもステートと同じくリロードしても残るので「出しっぱなしにならない」性質は変わらない。
// 外したことで **dir4×on2×armed2×length16×remain16=4,096 → dir4×on2×armed2=16 状態
// （予算 -4,080）**、上限も 60 tick → 1200 tick（1 分）に広げられた
// （非対称リピーター v1.31.1 と同じ理由・同じやり方）。

const ONE_SHOT_STEP = 4; // スライダーの刻み。minecraft:tick の間隔（4 tick）と合わせてある
const ONE_SHOT_MIN = 4;
const ONE_SHOT_MAX = 1200; // 1 分
const ONE_SHOT_DEFAULT = 20; // 旧デフォルト（5 段 × 4 tick）と揃えた
/** よく使う長さ（1/3/5/15/30/60 秒）。長い範囲を +4 で巡るのは非現実的なので、
 *  パルス生成機（v1.31.0）と同じくプリセット送りにしてある。 */
const ONE_SHOT_PRESETS = [20, 60, 100, 300, 600, 1200];

const ONE_SHOT_LEN_PREFIX = "wr:oslen|";
const ONE_SHOT_REMAIN_PREFIX = "wr:osremain|";

export function oneShotLengthOf(block) {
  const raw = world.getDynamicProperty(
    ONE_SHOT_LEN_PREFIX + blockKey(block.dimension.id, block.location)
  );
  return typeof raw === "number" ? raw : ONE_SHOT_DEFAULT;
}

function writeOneShotLength(block, ticks) {
  const clamped = Math.max(ONE_SHOT_MIN, Math.min(ONE_SHOT_MAX, Math.round(ticks) || 0));
  world.setDynamicProperty(
    ONE_SHOT_LEN_PREFIX + blockKey(block.dimension.id, block.location),
    clamped === ONE_SHOT_DEFAULT ? undefined : clamped
  );
  return clamped;
}

export function oneShotRemainOf(dimensionId, location) {
  const raw = world.getDynamicProperty(ONE_SHOT_REMAIN_PREFIX + blockKey(dimensionId, location));
  return typeof raw === "number" ? raw : 0;
}

function writeOneShotRemain(dimensionId, location, ticks) {
  world.setDynamicProperty(
    ONE_SHOT_REMAIN_PREFIX + blockKey(dimensionId, location),
    ticks > 0 ? ticks : undefined
  );
}

/** ブロックが無くなったときの後始末。放っておくと幽霊プロパティが残る。 */
export function clearOneShot(dimensionId, location) {
  const key = blockKey(dimensionId, location);
  world.setDynamicProperty(ONE_SHOT_LEN_PREFIX + key, undefined);
  world.setDynamicProperty(ONE_SHOT_REMAIN_PREFIX + key, undefined);
}

function updateOneShot(block) {
  const perm = block.permutation;
  const dimensionId = block.dimension.id;
  const location = block.location;
  const left = oneShotRemainOf(dimensionId, location);

  if (left > 0) {
    // 出力中。数え終わったら切る（入力は見ない＝追加入力を無視する）
    const next = left - ONE_SHOT_STEP;
    writeOneShotRemain(dimensionId, location, next);
    if (next <= 0) {
      applyStates(block, { "wr:on": false });
      scheduleNeighbors(block);
    }
    return;
  }

  const front = frontOf(block);
  const main = powerFrom(block, OPPOSITE[front]);
  const armed = perm.getState("wr:armed") !== false;

  if (main <= 0) {
    // 入力が切れた → 次の立ち上がりを受け付ける
    if (!armed) applyStates(block, { "wr:armed": true });
    return;
  }
  if (!armed) return; // 入りっぱなし。もう撃った

  const length = oneShotLengthOf(block);
  writeOneShotRemain(dimensionId, location, length);
  applyStates(block, { "wr:on": true, "wr:armed": false });
  scheduleNeighbors(block);
}
registerUpdater("wr:one_shot", updateOneShot);

export const oneShotComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateOneShot);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateOneShot);
  },
  onPlayerDestroy(e) {
    clearOneShot(e.block.dimension.id, e.block.location);
  },
  onPlayerInteract(e) {
    const block = e.block;
    const player = e.player;
    if (!player) return;
    const current = oneShotLengthOf(block);

    if (player.isSneaking) {
      setOneShotLength(block, nextPreset(current, ONE_SHOT_PRESETS), player);
      return;
    }
    openNumberSetting(player, block, {
      titleKey: "wr.ui.oneshot.title",
      labelKey: "wr.ui.oneshot.label",
      min: ONE_SHOT_MIN,
      max: ONE_SHOT_MAX,
      step: ONE_SHOT_STEP,
      value: current,
      apply: (fresh, ticks) => setOneShotLength(fresh, ticks, player),
    });
  },
};

function setOneShotLength(block, ticks, player) {
  const clamped = writeOneShotLength(block, ticks);
  player?.onScreenDisplay.setActionBar({
    translate: "wr.msg.oneshot.length",
    with: [String(clamped), (clamped / 20).toFixed(1)],
  });
}

registerDpSettings("wr:one_shot", {
  read: (block) => ({ "wr:length": oneShotLengthOf(block) }),
  write: (block, values) => {
    const length = values["wr:length"];
    if (typeof length !== "number") return false;
    writeOneShotLength(block, length);
    scheduleUpdate(block, updateOneShot);
    return true;
  },
});

// ---------------------------------------------------------------------------
// C-8. クロックディバイダー (wr:clock_divider)
// ---------------------------------------------------------------------------
//
// 背面入力の立ち上がりを数え、**divisor 回に 1 回だけ**そのパルスを
// そのまま前面へ通す（それ以外の回は 15 を出さない）。
// 速い点滅（パルス生成機の短い周期など）を間引いて、
// 「4 回に 1 回だけ光らせる」といった演出や、
// 高頻度クロックを分周して他のブロックの負荷を下げる用途に使う。
//
// divisor・カウンターはどちらもワールド動的プロパティに持つ。
// カウンターは「今の状態」であって設定ではないが、状態数の予算には
// divisor と同じだけ掛け算で乗るので、見た目に効かない値が 2 つある
// ブロックとして非対称リピーター（v1.31.1）と同じ扱いにしてある。

const CLOCK_DIV_MIN = 1;
const CLOCK_DIV_MAX = 16;
const CLOCK_DIV_DEFAULT = 4;

const CLOCK_DIV_PREFIX = "wr:cdiv|";
const CLOCK_CNT_PREFIX = "wr:cdcnt|";

export function clockDivisorOf(block) {
  const raw = world.getDynamicProperty(
    CLOCK_DIV_PREFIX + blockKey(block.dimension.id, block.location)
  );
  return typeof raw === "number" ? raw : CLOCK_DIV_DEFAULT;
}

function writeClockDivisor(block, divisor) {
  const clamped = Math.max(
    CLOCK_DIV_MIN,
    Math.min(CLOCK_DIV_MAX, Math.round(divisor) || CLOCK_DIV_DEFAULT)
  );
  world.setDynamicProperty(
    CLOCK_DIV_PREFIX + blockKey(block.dimension.id, block.location),
    clamped === CLOCK_DIV_DEFAULT ? undefined : clamped
  );
  return clamped;
}

export function clockCountOf(dimensionId, location) {
  const raw = world.getDynamicProperty(CLOCK_CNT_PREFIX + blockKey(dimensionId, location));
  return typeof raw === "number" ? raw : 0;
}

function writeClockCount(dimensionId, location, count) {
  world.setDynamicProperty(
    CLOCK_CNT_PREFIX + blockKey(dimensionId, location),
    count > 0 ? count : undefined
  );
}

/** ブロックが無くなったときの後始末。放っておくと幽霊プロパティが残る。 */
export function clearClockDivider(dimensionId, location) {
  const key = blockKey(dimensionId, location);
  world.setDynamicProperty(CLOCK_DIV_PREFIX + key, undefined);
  world.setDynamicProperty(CLOCK_CNT_PREFIX + key, undefined);
}

function updateClockDivider(block) {
  const dimensionId = block.dimension.id;
  const location = block.location;
  const perm = block.permutation;
  const main = powerFrom(block, OPPOSITE[frontOf(block)]);
  const armed = perm.getState("wr:armed") !== false;

  if (main <= 0) {
    // 入力が切れた → 次の立ち上がりを受け付ける。出力もここで必ず落とす
    const patch = {};
    if (!armed) patch["wr:armed"] = true;
    if (perm.getState("wr:on") === true) patch["wr:on"] = false;
    if (Object.keys(patch).length > 0 && applyStates(block, patch)) scheduleNeighbors(block);
    return;
  }

  let count = clockCountOf(dimensionId, location);
  if (armed) {
    // 立ち上がりを 1 回検知。divisor 回に 1 回だけ 0 に戻る＝そのときだけ通す
    count = (count + 1) % clockDivisorOf(block);
    writeClockCount(dimensionId, location, count);
  }
  const patch = { "wr:on": count === 0 };
  if (armed) patch["wr:armed"] = false;
  if (applyStates(block, patch)) scheduleNeighbors(block);
}
registerUpdater("wr:clock_divider", updateClockDivider);

export const clockDividerComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateClockDivider);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateClockDivider);
  },
  onPlayerDestroy(e) {
    clearClockDivider(e.block.dimension.id, e.block.location);
  },
  /**
   * 右クリックでスライダーを開いて divisor を直接指定。
   * スニーク + 右クリックは +1 の微調整（16 の次は 1 に戻る）。
   * どちらの操作も divisor を変えたらカウンターを 0 に戻す
   * （古い divisor で数えていた途中経過を持ち越さないため）。
   */
  onPlayerInteract(e) {
    const block = e.block;
    const player = e.player;
    if (!player) return;
    const current = clockDivisorOf(block);

    if (player.isSneaking) {
      setClockDivisor(block, stepValue(current, CLOCK_DIV_MIN, CLOCK_DIV_MAX), player);
      return;
    }
    openNumberSetting(player, block, {
      titleKey: "wr.ui.clockdiv.title",
      labelKey: "wr.ui.clockdiv.label",
      min: CLOCK_DIV_MIN,
      max: CLOCK_DIV_MAX,
      value: current,
      apply: (fresh, value) => setClockDivisor(fresh, value, player),
    });
  },
};

function setClockDivisor(block, divisor, player) {
  const clamped = writeClockDivisor(block, divisor);
  writeClockCount(block.dimension.id, block.location, 0);
  player?.onScreenDisplay.setActionBar({
    translate: "wr.msg.clockdiv.divisor",
    with: [String(clamped)],
  });
}

registerDpSettings("wr:clock_divider", {
  read: (block) => ({ "wr:div": clockDivisorOf(block) }),
  write: (block, values) => {
    const divisor = values["wr:div"];
    if (typeof divisor !== "number") return false;
    writeClockDivisor(block, divisor);
    writeClockCount(block.dimension.id, block.location, 0);
    scheduleUpdate(block, updateClockDivider);
    return true;
  },
});

// ---------------------------------------------------------------------------
// C-6. シーケンサー (wr:sequencer)
// ---------------------------------------------------------------------------
//
// 出力先を北 → 東 → 南 → 西 と一定間隔で回していく。
// 照明を順番に点けていく演出（チェイサー）や、複数系統への順次分配に使う。
//
// **出力方向は minecraft:cardinal_direction を書き換えて表す。**
// このアドオンの wr: ブロック同士は connected_faces ではなく
// ステート（powerFrom）で電力を読み合っていて、
// 「面ごとに違う値」を表現する手段が無いため。
// cardinal_direction を回せば powerFrom の前面判定がそのまま効くうえ、
// ブロックの見た目（矢印）も一緒に回るので、今どこに出ているかが目で分かる。

// 間隔の上限を広げるために **粗いモード (wr:slow)** を持たせている（v1.30.0）。
//
// 残り時間 wr:remain は 1 つのステートなので 16 段（0〜15）しか持てず、
// この 16 段が上限を直接決めてしまう。段数を増やすには remain も増やすことになり、
// 状態数は掛け算で効くので、少し広げるだけで予算（ワールド全体で 65,536）を食い潰す。
// そこで **1 段あたりの重みを 5 倍にするフラグを 1 枚**足した。
// 状態数は 2 倍で済み、上限は 60 tick → 300 tick（15 秒）になる。
//
// 設定UIでは 1 本のスライダー（4〜300 tick）にまとめて見せ、
// 60 tick を超えたら自動で粗いモードへ切り替える。
// 60 を超えたところで刻みが 4 → 20 tick になるが、
// もともと「照明を順に点ける」用途なので実用上は問題にならない。
const SEQ_UNIT = 4;
const SEQ_SLOW_UNIT = 20;
const SEQ_MIN = 1;
const SEQ_MAX = 15;

/** そのシーケンサーの 1 段あたりの tick 数。 */
function seqUnitOf(block) {
  return block.permutation.getState("wr:slow") === true ? SEQ_SLOW_UNIT : SEQ_UNIT;
}

/** 目標の tick 数を {slow, units} に落とす。細かい側を優先する。 */
function seqStatesFor(ticks) {
  const wanted = Math.max(SEQ_UNIT, Math.round(ticks));
  if (wanted <= SEQ_MAX * SEQ_UNIT) {
    const units = Math.max(SEQ_MIN, Math.min(SEQ_MAX, Math.round(wanted / SEQ_UNIT)));
    return { slow: false, units };
  }
  const units = Math.max(SEQ_MIN, Math.min(SEQ_MAX, Math.round(wanted / SEQ_SLOW_UNIT)));
  return { slow: true, units };
}

/** 回る順。cardinal_direction をこの順に送る。 */
const SEQ_ORDER = ["north", "east", "south", "west"];

/** 粗いモードで「今回は数える回」かどうか。1 段 = 20 tick にするための間引き。 */
const SEQ_SLOW_DIVISOR = SEQ_SLOW_UNIT / SEQ_UNIT;
function seqSlowTurn() {
  // minecraft:tick は 4 tick ちょうどの間隔で来るので、
  // floor(currentTick / 4) は呼ばれるたびに 1 ずつ増える。
  // その 5 回に 1 回だけ数えれば 1 段 = 20 tick になる。
  // **ワールド時刻から決めているので、追加のステートもメモリ上のカウンタも要らない**
  // （リロードしてもずれず、状態数も増えない）。
  return Math.floor(system.currentTick / SEQ_UNIT) % SEQ_SLOW_DIVISOR === 0;
}

function updateSequencer(block) {
  const perm = block.permutation;

  // 粗いモードは 5 回に 1 回しか進めない
  if (perm.getState("wr:slow") === true && !seqSlowTurn()) return;

  const remain = perm.getState("wr:remain");
  const left = typeof remain === "number" ? remain : 0;

  if (left > 0) {
    applyStates(block, { "wr:remain": left - 1 });
    return;
  }

  const period = perm.getState("wr:period");
  const units = typeof period === "number" ? period : 5;

  const front = frontOf(block);
  const at = SEQ_ORDER.indexOf(front);
  const next = SEQ_ORDER[(at + 1) % SEQ_ORDER.length];

  applyStates(block, {
    "minecraft:cardinal_direction": next,
    "wr:remain": units,
    "wr:on": true,
  });
  // 出力先が変わったので、前の向きの隣も新しい向きの隣も計算し直させる
  scheduleNeighbors(block);
}
registerUpdater("wr:sequencer", updateSequencer);

export const sequencerComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateSequencer);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateSequencer);
  },
  /**
   * 右クリック            … スライダー（4〜300 tick）で間隔を指定
   * スニーク + 右クリック … 今の刻みで 1 段ぶんの微調整
   *
   * スライダーは粗い／細かいを意識させず 1 本にまとめてある。
   * 60 tick を超えたぶんは自動で粗いモードになり、刻みが 20 tick になる。
   */
  onPlayerInteract(e) {
    const block = e.block;
    const player = e.player;
    if (!player) return;
    const current = block.permutation.getState("wr:period");
    const units = typeof current === "number" ? current : 5;
    const unit = seqUnitOf(block);

    if (player.isSneaking) {
      setSequencerPeriod(block, (stepValue(units, SEQ_MIN, SEQ_MAX) * unit), player);
      return;
    }
    openNumberSetting(player, block, {
      titleKey: "wr.ui.sequencer.title",
      labelKey: "wr.ui.sequencer.label",
      min: SEQ_MIN * SEQ_UNIT,
      max: SEQ_MAX * SEQ_SLOW_UNIT,
      step: SEQ_UNIT,
      value: units * unit,
      apply: (fresh, ticks) => setSequencerPeriod(fresh, ticks, player),
    });
  },
};

/** 間隔を **tick 数**で設定する（粗い／細かいの割り振りはここで決める）。 */
function setSequencerPeriod(block, ticks, player) {
  const { slow, units } = seqStatesFor(ticks);
  applyStates(block, { "wr:period": units, "wr:slow": slow });
  player?.onScreenDisplay.setActionBar({
    translate: "wr.msg.sequencer.period",
    with: [String(units * (slow ? SEQ_SLOW_UNIT : SEQ_UNIT))],
  });
}

// ---------------------------------------------------------------------------
// C-4. 時刻トリガー (wr:timer)
// ---------------------------------------------------------------------------
//
// パルス生成機は 1〜50 tick の短い周期しか扱えず、時刻センサーは
// 「今が何時か」をアナログで出すだけなので、
// **「毎朝 6 時に 1 回だけパルス」ができなかった**。そこを埋める。
//
// 時刻の指定は 0〜23 時。1 つのステートに 16 個までしか値を置けないので、
// パルス生成機と同じく十の位（0〜2）と一の位（0〜9）に分けて持つ。
//
// モードが 2 つあるが、数値の欄は 1 つで兼ねている:
//   wr:every = false … その「時刻」ちょうどに 1 回
//   wr:every = true  … その「時間数」ごとに 1 回（1〜12）
//
// 立ち上がりの検出は wr:armed。条件を満たしている間に何度も撃たないための印で、
// T フリップフロップやカウンターと同じ考え方。
// tick は 20（1 秒）なので、条件を満たしてから最大 1 秒で撃つ。

const TIMER_HOUR_MAX = 23;
const TIMER_EVERY_MAX = 12;

/** ステートから設定値（時刻 or 何時間ごと）を読む。 */
function timerValueOf(block) {
  const perm = block.permutation;
  const tens = perm.getState("wr:hour_tens");
  const ones = perm.getState("wr:hour_ones");
  return (typeof tens === "number" ? tens : 0) * 10 + (typeof ones === "number" ? ones : 0);
}

function timerValueStates(value) {
  const clamped = Math.max(0, Math.min(TIMER_HOUR_MAX, Math.round(value)));
  return { "wr:hour_tens": Math.floor(clamped / 10), "wr:hour_ones": clamped % 10 };
}

/** 今その条件を満たしているか。 */
function timerMatches(block, hour) {
  const every = block.permutation.getState("wr:every") === true;
  const value = timerValueOf(block);
  if (!every) return hour === value;
  const step = Math.max(1, Math.min(TIMER_EVERY_MAX, value));
  return hour % step === 0;
}

function updateTimer(block) {
  let hour;
  try {
    hour = worldHour(world.getTimeOfDay?.() ?? 0);
  } catch (e) {
    console.warn(`[wr] timer time read failed: ${e}`);
    return;
  }

  // 撃った次の tick（1 秒後）で必ず落とす。パルス幅は 1 秒。
  if (block.permutation.getState("wr:on") === true) {
    if (applyStates(block, { "wr:on": false })) scheduleNeighbors(block);
    return;
  }

  const armed = block.permutation.getState("wr:armed") !== false;
  if (!timerMatches(block, hour)) {
    // 条件から外れたら次に備える
    if (!armed) applyStates(block, { "wr:armed": true });
    return;
  }
  if (!armed) return; // この時間帯ではもう撃った

  applyStates(block, { "wr:on": true, "wr:armed": false });
  scheduleNeighbors(block);
}
registerUpdater("wr:timer", updateTimer);

export const timerComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateTimer);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateTimer);
  },
  /**
   * 右クリック            … 時刻／間隔をスライダーで設定
   * スニーク + 右クリック … モードの切り替え（時刻ちょうど ⇔ N 時間ごと）
   */
  onPlayerInteract(e) {
    const block = e.block;
    const player = e.player;
    if (!player) return;

    if (player.isSneaking) {
      const every = block.permutation.getState("wr:every") !== true;
      applyStates(block, { "wr:every": every, "wr:armed": true });
      scheduleUpdate(block, updateTimer);
      player.onScreenDisplay.setActionBar({
        translate: every ? "wr.msg.timer.every" : "wr.msg.timer.at",
      });
      return;
    }

    const every = block.permutation.getState("wr:every") === true;
    openNumberSetting(player, block, {
      titleKey: every ? "wr.ui.timer.every.title" : "wr.ui.timer.at.title",
      labelKey: every ? "wr.ui.timer.every.label" : "wr.ui.timer.at.label",
      min: every ? 1 : 0,
      max: every ? TIMER_EVERY_MAX : TIMER_HOUR_MAX,
      value: timerValueOf(block),
      apply: (fresh, value) => {
        applyStates(fresh, { ...timerValueStates(value), "wr:armed": true });
        scheduleUpdate(fresh, updateTimer);
        player.onScreenDisplay.setActionBar({
          translate: every ? "wr.msg.timer.setevery" : "wr.msg.timer.setat",
          with: [String(Math.round(value))],
        });
      },
    });
  },
};

export function registerTimingLoops() {
  system.runInterval(stepPulseGenerators, 1);

  // 非対称リピーターの遅延・パルス生成機の周期・ワンショットの長さと残り・
  // クロックディバイダーの divisor とカウンターは、どれも座標キーの
  // 動的プロパティなので、**爆発で消えたときは onPlayerDestroy が来ない**。
  // ここで拾わないと幽霊が残る（同じ座標に置き直した次のブロックが、
  // 前のブロックの設定を引き継いでしまう）。
  world.afterEvents.blockExplode?.subscribe((e) => {
    const typeId = e.explodedBlockPermutation?.type?.id;
    const key = blockKey(e.dimension.id, e.block.location);
    if (typeId === "wr:asym_repeater") {
      cancelPending(key);
      clearAsymDelays(e.dimension.id, e.block.location);
    } else if (typeId === "wr:pulse_generator") {
      running.delete(key);
      clearPeriod(e.dimension.id, e.block.location);
    } else if (typeId === "wr:one_shot") {
      clearOneShot(e.dimension.id, e.block.location);
    } else if (typeId === "wr:clock_divider") {
      clearClockDivider(e.dimension.id, e.block.location);
    }
  });
}

// periodOf / asymDelaysOf / clearPeriod / clearAsymDelays / oneShotLengthOf /
// oneShotRemainOf / clearOneShot / clockDivisorOf / clockCountOf /
// clearClockDivider は宣言側で export 済み。
// periodStates は周期を動的プロパティへ移した v1.31.0 で不要になった。
export {
  PERIOD_MIN,
  PERIOD_MAX,
  PERIOD_PRESETS,
  DELAY_STEP,
  ONE_SHOT_MIN,
  ONE_SHOT_MAX,
  ONE_SHOT_PRESETS,
  CLOCK_DIV_MIN,
  CLOCK_DIV_MAX,
};
