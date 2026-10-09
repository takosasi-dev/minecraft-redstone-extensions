/**
 * パートD: 論理回路（NOT・AND・OR）
 *
 * 設計方針（3 種共通）:
 *   - 床置き専用（placement_filter で allowed_faces を up に限定）
 *   - 前面 = 設置時にプレイヤーが向いていた方向 = 出力方向
 *   - 主入力 = 背面 / 副入力（AND・OR）= 前面を向いて立ったときの右側面
 *     方位は cardinal_direction から動的に計算するので、設置向きを変えるだけで
 *     正しい面が自動的に副入力になる
 *   - 出力は前面にのみ（redstone_producer の connected_faces を前面 1 面に限定）
 *   - 共通伝播ロジック（1 tick 遅延方式）を適用
 *
 * 入力の検知について:
 *   出力（redstone_producer）を持つブロックには redstone_consumer を付けられず、
 *   onRedstoneUpdate が使えない（エンジンが両立を禁止している）。
 *   そのため
 *     - minecraft:tick（4 tick 間隔）… バニラのレバー等の変化に気づくための入口
 *     - scheduleNeighbors()          … 値が変わったら隣の wr: ブロックを再計算
 *   の 2 段構えで伝播させている。
 *   主入力・副入力はその都度 powerFrom() で面ごとに読み直すので、
 *   もともと「ブロック全体の合計電力」しか分からない onRedstoneUpdate に
 *   依存していなかった点は変わらない。
 */

import { world } from "@minecraft/server";
import { OPPOSITE, RIGHT_OF, powerFrom, clampPower, blockKey } from "./util.js";
import {
  scheduleUpdate,
  applyStates,
  registerUpdater,
  scheduleNeighbors,
} from "./propagation_helper.js";
import { openNumberSetting, openNumberSettings, stepValue } from "./block_ui.js";
import { registerDpSettings } from "./config_tool.js";

function frontOf(block) {
  const front = block.permutation.getState("minecraft:cardinal_direction");
  return typeof front === "string" ? front : "north";
}

/** 主入力（背面）と副入力（右側面）をまとめて読む。 */
function readInputs(block) {
  const front = frontOf(block);
  return {
    main: powerFrom(block, OPPOSITE[front]),
    sub: powerFrom(block, RIGHT_OF[front] ?? "east"),
  };
}

// ---------------------------------------------------------------------------
// D-1. NOT 回路
// ---------------------------------------------------------------------------

function updateNotGate(block) {
  const { main } = readInputs(block);
  // 完全バイナリ: 主入力 0 なら 15、それ以外は 0
  if (applyStates(block, { "wr:on": main === 0 })) scheduleNeighbors(block);
}
registerUpdater("wr:not_gate", updateNotGate);

export const notGateComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateNotGate);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateNotGate);
  },
};

// ---------------------------------------------------------------------------
// D-2 / D-3. AND・OR 回路（アナログ）
// ---------------------------------------------------------------------------

function analogGateComponent(typeId, combine) {
  const update = (block) => {
    const { main, sub } = readInputs(block);
    if (applyStates(block, { "wr:power": clampPower(combine(main, sub)) })) {
      scheduleNeighbors(block);
    }
  };
  registerUpdater(typeId, update);
  return {
    onPlace(e) {
      scheduleUpdate(e.block, update);
    },
    onTick(e) {
      scheduleUpdate(e.block, update);
    },
  };
}

/** 出力 = min(主入力, 副入力) */
export const andGateComponent = analogGateComponent("wr:and_gate", (a, b) => Math.min(a, b));

/** 出力 = max(主入力, 副入力) */
export const orGateComponent = analogGateComponent("wr:or_gate", (a, b) => Math.max(a, b));

// ---------------------------------------------------------------------------
// 算術回路（加算器・減算器）
//
// AND / OR と同じアナログ 2 入力ブロック。clampPower() が 0〜15 に丸めるので、
// 加算は 15 で頭打ち（飽和）、減算は 0 で下げ止まる。
// バニラのコンパレーターの減算モードに相当するものが単体のブロックになっている。
// ---------------------------------------------------------------------------

/** 出力 = min(15, 主入力 + 副入力) */
export const adderComponent = analogGateComponent("wr:adder", (a, b) => a + b);

/** 出力 = max(0, 主入力 - 副入力) */
export const subtractorComponent = analogGateComponent("wr:subtractor", (a, b) => a - b);

// ---------------------------------------------------------------------------
// 追加の論理回路（XOR・NAND・NOR・XNOR）
//
// AND / OR はアナログ（強度をそのまま扱う）だが、この 4 種は
// 「否定」や「排他」がアナログでは定義できないので **完全バイナリ** にしてある。
// NOT 回路と同じく、入力が 0 かどうかだけを見て 0/15 を出す。
// ---------------------------------------------------------------------------

function binaryGateComponent(typeId, combine) {
  const update = (block) => {
    const { main, sub } = readInputs(block);
    if (applyStates(block, { "wr:on": combine(main > 0, sub > 0) })) {
      scheduleNeighbors(block);
    }
  };
  registerUpdater(typeId, update);
  return {
    onPlace(e) {
      scheduleUpdate(e.block, update);
    },
    onTick(e) {
      scheduleUpdate(e.block, update);
    },
  };
}

/** 主入力と副入力の片方だけが ON のとき 15。 */
export const xorGateComponent = binaryGateComponent("wr:xor_gate", (a, b) => a !== b);

/** 両方 ON のときだけ 0、それ以外は 15。 */
export const nandGateComponent = binaryGateComponent("wr:nand_gate", (a, b) => !(a && b));

/** 両方 OFF のときだけ 15。 */
export const norGateComponent = binaryGateComponent("wr:nor_gate", (a, b) => !(a || b));

/** 主入力と副入力が一致しているとき 15。 */
export const xnorGateComponent = binaryGateComponent("wr:xnor_gate", (a, b) => a === b);

// ---------------------------------------------------------------------------
// 比較ブロック (wr:compare)
//
// 主入力（背面）と副入力（右側面）の **大小を比べて** 0/15 を出す。
//
// 閾値ブロックは「定数と比べる」もので、加算・減算は「値を作る」もの。
// **2 つの入力を比べる**手段だけが無かったので、これで埋まる。
// カウンター → 比較 → の順に繋げば「N 個たまったら」がそのまま組める。
//
// モードは右クリックで巡回する（wr:mode）:
//   0 … 主 >  副
//   1 … 主 >= 副
//   2 … 主 == 副
// ---------------------------------------------------------------------------

/** wr:mode の値 → 比べ方。 */
const COMPARE_OPS = [
  (a, b) => a > b,
  (a, b) => a >= b,
  (a, b) => a === b,
];
/** モードの説明（アクションバー用）。 */
const COMPARE_LABEL = ["wr.msg.compare.gt", "wr.msg.compare.ge", "wr.msg.compare.eq"];

function compareModeOf(block) {
  const mode = block.permutation.getState("wr:mode");
  return typeof mode === "number" && mode >= 0 && mode < COMPARE_OPS.length ? mode : 0;
}

function updateCompare(block) {
  const { main, sub } = readInputs(block);
  const on = COMPARE_OPS[compareModeOf(block)](main, sub);
  if (applyStates(block, { "wr:on": on })) scheduleNeighbors(block);
}
registerUpdater("wr:compare", updateCompare);

export const compareComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateCompare);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateCompare);
  },
  /** 右クリックで比べ方を切り替える。 */
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;
    const next = (compareModeOf(e.block) + 1) % COMPARE_OPS.length;
    applyStates(e.block, { "wr:mode": next });
    scheduleUpdate(e.block, updateCompare);
    player.onScreenDisplay.setActionBar({ translate: COMPARE_LABEL[next] });
  },
};

// ---------------------------------------------------------------------------
// 即時リピーター (wr:instant_repeater)
//
// 背面に入力があれば前面に 15 を出すだけの「バッファ（ダイオード）」。
// 反転もしなければ遅延も足さないので、
//   ・減衰した信号を 15 に戻す（増幅）
//   ・前面にしか出さないので逆流しない
// の 2 つだけを担う。
//
// **遅延は 1 tick で、これはこのアドオンで出せる最小値**。
// 共通伝播ロジックが「次 tick にまとめて 1 回だけ再計算する」方式なので、
// 完全な 0 tick にはできない（propagation_helper.js の先頭コメント参照）。
// それでもバニラのリピーターの最小 2 tick、
// wr:variable_repeater の最小 2 tick よりは速い。
//
// 機能としては閾値ブロックを 1 に設定したものと同じだが、
// 「遅延を足さずに信号を立て直したい」ときにそれを探し当てるのは難しいので、
// 名前と見た目を割り当てて独立したブロックにしてある。
// ---------------------------------------------------------------------------

/** 主入力が入っていれば 15。副入力は見ない。 */
export const instantRepeaterComponent = binaryGateComponent(
  "wr:instant_repeater",
  (main) => main
);

// ---------------------------------------------------------------------------
// ランダマイザー (wr:randomizer)
//
// 背面入力の**立ち上がりごと**に、前面の出力をランダムな値にする。
// 入りっぱなしでも 1 回しか振らない（T フリップフロップと同じ armed 方式）。
//
//   wr:binary = false … 0〜15 のどれか（アナログ）
//   wr:binary = true  … 0 か 15 のどちらか（コイントス）
//
// 照明の演出・ミニゲーム・ランダム分配用。
// Math.random() を使うのでワールドシードとは無関係で、再現性は無い。
// ---------------------------------------------------------------------------

function updateRandomizer(block) {
  const { main } = readInputs(block);
  const perm = block.permutation;
  const armed = perm.getState("wr:armed") !== false;

  if (main <= 0) {
    // 入力が切れた → 次の立ち上がりを受け付ける。出力はそのまま保持する
    if (!armed) applyStates(block, { "wr:armed": true });
    return;
  }
  if (!armed) return; // 入りっぱなし。もう振った

  const binary = perm.getState("wr:binary") === true;
  const value = binary
    ? (Math.random() < 0.5 ? 0 : 15)
    : Math.floor(Math.random() * 16);

  applyStates(block, { "wr:power": clampPower(value), "wr:armed": false });
  scheduleNeighbors(block);
}
registerUpdater("wr:randomizer", updateRandomizer);

export const randomizerComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateRandomizer);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateRandomizer);
  },
  /** 右クリックで「0〜15」と「0 か 15」を切り替える。 */
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;
    const binary = e.block.permutation.getState("wr:binary") !== true;
    applyStates(e.block, { "wr:binary": binary });
    player.onScreenDisplay.setActionBar({
      translate: binary ? "wr.msg.random.binary" : "wr.msg.random.analog",
    });
  },
};

// ---------------------------------------------------------------------------
// 閾値ブロック (wr:threshold)
//
// 主入力（背面）が閾値以上のときだけ 15 を出す。
// アナログ信号を任意の強度で 2 値に切るためのブロックで、
// 「レッドストーンを N マス走らせて減衰させ、コンパレーターで比較する」
// という定番の配線を 1 ブロックに畳んだもの。
// 右クリックで 1〜15 を巡回（sneak+右クリックで逆回り）。
//
// ---------------------------------------------------------------------------
// シュミットトリガー化（v1.31.2）
// ---------------------------------------------------------------------------
//
// 元の実装は ON/OFF の判定に同じ 1 本の閾値を使っていた。
// 入力がその値ぴったりで揺れる配線（アナログ入力がノイズっぽい・
// 複数の信号源が足し合わさっている等）だと、境界で ON/OFF が細かく
// チャタリングする。ON にする閾値（rise）と OFF にする閾値（fall、
// rise 以下にするのが普通）を分ければ、rise と fall の間には
// 「今の状態を保つだけの遊び」ができてチャタリングが起きなくなる
// （アナログ回路のシュミットトリガーと同じ考え方）。
//
// **rise/fall はステートではなくワールド動的プロパティに持つ。**
// 見た目と出力はどちらも wr:on だけで決まり、rise/fall は見た目に
// 効かない設定値が 2 つになる。ステートのままだと 15 × 15 = 225 倍が
// そのまま状態数の予算に乗るところを、外して 120 → 8 状態（予算 -112）。
// 非対称リピーター（v1.31.1）と同じ理由・同じやり方。
//
// fall > rise（設定ミス）でも例外にはしない。ON 側は main >= rise、
// OFF 側は main < fall で判定するだけなので、fall > rise だと
// 「rise 以上 fall 未満」の範囲でどちらの向きにも切り替わらない
// （ON中に入ればON維持、OFF中に入ればOFF維持）だけで壊れはしない。

const LEVEL_MIN = 1;
const LEVEL_MAX = 15;
const LEVEL_PREFIX = "wr:th|"; // 値は rise * 16 + fall

export function thresholdLevelsOf(block) {
  const raw = world.getDynamicProperty(
    LEVEL_PREFIX + blockKey(block.dimension.id, block.location)
  );
  if (typeof raw !== "number") return { rise: LEVEL_MIN, fall: LEVEL_MIN };
  return { rise: Math.floor(raw / 16), fall: raw % 16 };
}

function writeThresholdLevels(block, rise, fall) {
  const clamp = (v) => Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, Math.round(v) || LEVEL_MIN));
  const r = clamp(rise);
  const f = clamp(fall);
  world.setDynamicProperty(
    LEVEL_PREFIX + blockKey(block.dimension.id, block.location),
    r === LEVEL_MIN && f === LEVEL_MIN ? undefined : r * 16 + f
  );
  return { rise: r, fall: f };
}

/** ブロックが無くなったときの後始末。放っておくと幽霊プロパティが残る。 */
export function clearThresholdLevels(dimensionId, location) {
  world.setDynamicProperty(LEVEL_PREFIX + blockKey(dimensionId, location), undefined);
}

function updateThreshold(block) {
  const { main } = readInputs(block);
  const { rise, fall } = thresholdLevelsOf(block);
  const wasOn = block.permutation.getState("wr:on") === true;
  const on = wasOn ? main >= fall : main >= rise;
  if (applyStates(block, { "wr:on": on })) scheduleNeighbors(block);
}
registerUpdater("wr:threshold", updateThreshold);

export const thresholdComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateThreshold);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateThreshold);
  },
  onPlayerDestroy(e) {
    clearThresholdLevels(e.block.dimension.id, e.block.location);
  },
  /**
   * 右クリックでスライダー 2 本（ON にする値 / OFF にする値）を開く。
   * スニーク + 右クリックは ON 側だけ +1 の微調整（15 の次は 1 に戻る、
   * OFF 側はそのまま）。ヒステリシスを使わないなら両方とも同じ値のままでよく、
   * その場合は元の「1 本の閾値」とまったく同じ挙動になる。
   */
  onPlayerInteract(e) {
    const block = e.block;
    const player = e.player;
    if (!player) return;

    const { rise, fall } = thresholdLevelsOf(block);

    if (player.isSneaking) {
      setThresholdLevels(block, stepValue(rise, LEVEL_MIN, LEVEL_MAX), fall, player);
      return;
    }
    openNumberSettings(player, block, {
      titleKey: "wr.ui.threshold.title",
      sliders: [
        { labelKey: "wr.ui.threshold.rise", min: LEVEL_MIN, max: LEVEL_MAX, value: rise },
        { labelKey: "wr.ui.threshold.fall", min: LEVEL_MIN, max: LEVEL_MAX, value: fall },
      ],
      apply: (fresh, [riseValue, fallValue]) =>
        setThresholdLevels(fresh, riseValue, fallValue, player),
    });
  },
};

function setThresholdLevels(block, rise, fall, player) {
  const { rise: r, fall: f } = writeThresholdLevels(block, rise, fall);
  scheduleUpdate(block, updateThreshold);
  player?.onScreenDisplay.setActionBar({
    translate: "wr.msg.threshold.level",
    with: [String(r), String(f)],
  });
}

registerDpSettings("wr:threshold", {
  read: (block) => {
    const { rise, fall } = thresholdLevelsOf(block);
    return { "wr:level": rise, "wr:fall": fall };
  },
  write: (block, values) => {
    const level = values["wr:level"];
    const fall = values["wr:fall"];
    if (typeof level !== "number" && typeof fall !== "number") return false;
    const current = thresholdLevelsOf(block);
    writeThresholdLevels(
      block,
      typeof level === "number" ? level : current.rise,
      typeof fall === "number" ? fall : current.fall
    );
    scheduleUpdate(block, updateThreshold);
    return true;
  },
});

/**
 * rise/fall は座標キーの動的プロパティなので、`onPlayerDestroy` だけでは
 * **爆破されたときに幽霊が残る**（次に同じ場所へ置いた閾値ブロックが
 * 前の設定を引き継いでしまう）。他のブロック（非対称リピーター等）と
 * 同じ理由で blockExplode でも消す。
 */
export function registerLogicCleanup() {
  world.afterEvents.blockExplode?.subscribe((e) => {
    if (e.explodedBlockPermutation?.type?.id === "wr:threshold") {
      clearThresholdLevels(e.dimension.id, e.block.location);
    }
  });
}
