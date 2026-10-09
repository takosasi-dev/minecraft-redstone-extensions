/**
 * 記憶素子と定数電源
 *   wr:rs_latch    RSラッチ。セット（背面）で ON、リセット（右側面）で OFF、
 *                  どちらも 0 のときは直前の状態を保持する
 *   wr:t_flipflop  Tフリップフロップ。背面入力の **立ち上がり** ごとに出力が反転する
 *   wr:constant    定数電源。入力を読まず、右クリックで決めた強度を出し続ける
 *
 * ラッチ系の状態はスクリプト側のメモリではなく **ブロックステート** に持たせている
 * （wr:on / wr:armed）。こうしておくとワールドをリロードしても状態が失われない。
 */

import { OPPOSITE, RIGHT_OF, powerFrom, clampPower } from "./util.js";
import {
  scheduleUpdate,
  applyStates,
  registerUpdater,
  scheduleNeighbors,
} from "./propagation_helper.js";
import { openNumberSetting, stepValue } from "./block_ui.js";

function frontOf(block) {
  const front = block.permutation.getState("minecraft:cardinal_direction");
  return typeof front === "string" ? front : "north";
}

function inputs(block) {
  const front = frontOf(block);
  return {
    main: powerFrom(block, OPPOSITE[front]), // 背面
    sub: powerFrom(block, RIGHT_OF[front] ?? "east"), // 右側面
  };
}

// ---------------------------------------------------------------------------
// RSラッチ
// ---------------------------------------------------------------------------

function updateRsLatch(block) {
  const { main: set, sub: reset } = inputs(block);
  // リセット優先。両方入っているときは OFF に倒す（安全側）。
  if (reset > 0) {
    if (applyStates(block, { "wr:on": false })) scheduleNeighbors(block);
    return;
  }
  if (set > 0) {
    if (applyStates(block, { "wr:on": true })) scheduleNeighbors(block);
    return;
  }
  // どちらも 0 → 何もしない（保持）
}
registerUpdater("wr:rs_latch", updateRsLatch);

export const rsLatchComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateRsLatch);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateRsLatch);
  },
};

// ---------------------------------------------------------------------------
// Tフリップフロップ
// ---------------------------------------------------------------------------

function updateTFlipFlop(block) {
  const { main } = inputs(block);
  const perm = block.permutation;
  const armed = perm.getState("wr:armed") !== false; // 既定は「立ち上がり待ち」
  const on = perm.getState("wr:on") === true;

  if (main > 0) {
    if (!armed) return; // 入力が入りっぱなし。すでに反応済みなので何もしない
    applyStates(block, { "wr:on": !on, "wr:armed": false });
    scheduleNeighbors(block); // 出力が必ず反転するので無条件に伝える
    return;
  }
  // 入力が切れた → 次の立ち上がりを受け付ける（出力は変わらないので連鎖しない）
  if (!armed) applyStates(block, { "wr:armed": true });
}
registerUpdater("wr:t_flipflop", updateTFlipFlop);

export const tFlipFlopComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateTFlipFlop);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateTFlipFlop);
  },
};

// ---------------------------------------------------------------------------
// レジスタ（サンプル&ホールド）
//
// 副入力（右側面）の **立ち上がりの瞬間の主入力（背面）を取り込んで**、
// 次に取り込むまでその値を前面に出し続ける。
//
// RSラッチは 0/15 の 1 ビットしか覚えられない。
// 「センサーの値をその時点で固定したい」「計算の途中結果を置いておきたい」
// といったときに、**アナログ値を覚える**手段が無かったのでこれで埋まる。
//
// 立ち上がり検出は Tフリップフロップ・カウンターと同じ wr:armed 方式。
// 覚えた値はブロックステート（wr:power）に持つので、
// **ワールドをリロードしても消えない**。
// ---------------------------------------------------------------------------

function updateRegister(block) {
  const { main, sub: capture } = inputs(block);
  const armed = block.permutation.getState("wr:armed") !== false;

  if (capture > 0) {
    if (!armed) return; // 取り込み信号が入りっぱなし。もう取り込んである
    const held = clampPower(main);
    // 値が変わらなくても armed は必ず倒す（そうしないと毎 tick 取り込み直す）
    applyStates(block, { "wr:power": held, "wr:armed": false });
    scheduleNeighbors(block);
    return;
  }
  // 取り込み信号が切れた → 次の立ち上がりを受け付ける（出力は変えない＝保持）
  if (!armed) applyStates(block, { "wr:armed": true });
}
registerUpdater("wr:register", updateRegister);

export const registerComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateRegister);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateRegister);
  },
  /** 右クリックで中身を 0 に戻す。 */
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;
    applyStates(e.block, { "wr:power": 0 });
    scheduleNeighbors(e.block);
    player.onScreenDisplay.setActionBar({ translate: "wr.msg.register.cleared" });
  },
};

// ---------------------------------------------------------------------------
// カウンター
//
// Tフリップフロップと同じ立ち上がり検知だが、反転ではなく **数を +1 する**。
// 出力はその数そのもの（アナログ 0〜15）なので、
// 数値表示ブロックや閾値ブロックと繋げば「N 回目で発火」が作れる。
//
// 背面 = カウント入力（立ち上がりで +1、15 の次は 0 に戻る）
// 右側面 = リセット（入っている間は 0 に張りつく）
// ---------------------------------------------------------------------------

function updateCounter(block) {
  const { main, sub: reset } = inputs(block);
  const perm = block.permutation;
  const count = perm.getState("wr:power");
  const current = typeof count === "number" ? count : 0;

  // リセットが優先。入っている間はカウントを受け付けない
  // （リセット中に立ち上がりが来ても数えないよう armed も倒しておく）。
  if (reset > 0) {
    if (applyStates(block, { "wr:power": 0, "wr:armed": false })) scheduleNeighbors(block);
    return;
  }

  const armed = perm.getState("wr:armed") !== false; // 既定は「立ち上がり待ち」
  if (main > 0) {
    if (!armed) return; // 入力が入りっぱなし。すでに数え済み
    const next = current >= 15 ? 0 : current + 1;
    applyStates(block, { "wr:power": next, "wr:armed": false });
    scheduleNeighbors(block); // 値が必ず動くので無条件に伝える
    return;
  }
  // 入力が切れた → 次の立ち上がりを受け付ける（出力は変わらないので連鎖しない）
  if (!armed) applyStates(block, { "wr:armed": true });
}
registerUpdater("wr:counter", updateCounter);

export const counterComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateCounter);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateCounter);
  },
  /** 右クリックでカウントを 0 に戻す（リセット線を引かずに手で戻したいとき）。 */
  onPlayerInteract(e) {
    if (!e.player) return;
    if (applyStates(e.block, { "wr:power": 0 })) scheduleNeighbors(e.block);
    e.player.onScreenDisplay.setActionBar({ translate: "wr.msg.counter.reset" });
  },
};

// ---------------------------------------------------------------------------
// 定数電源
// ---------------------------------------------------------------------------

export const constantComponent = {
  /**
   * 右クリックでスライダーを開いて出力を直接指定。
   * スニーク + 右クリックは +1 の微調整（15 の次は 0 に戻る）。
   */
  onPlayerInteract(e) {
    const block = e.block;
    const player = e.player;
    if (!player) return;

    const current = block.permutation.getState("wr:power");
    const power = typeof current === "number" ? current : 0;

    if (player.isSneaking) {
      setConstantPower(block, stepValue(power, 0, 15), player);
      return;
    }
    openNumberSetting(player, block, {
      titleKey: "wr.ui.constant.title",
      labelKey: "wr.ui.constant.label",
      min: 0,
      max: 15,
      value: power,
      apply: (fresh, value) => setConstantPower(fresh, value, player),
    });
  },
};

function setConstantPower(block, power, player) {
  const next = clampPower(power);
  if (applyStates(block, { "wr:power": next })) scheduleNeighbors(block);
  player?.onScreenDisplay.setActionBar({
    translate: "wr.msg.constant.power",
    with: [String(next)],
  });
}
