/**
 * 数値表示ブロック (wr:display)
 *
 * 受けている電力を 7 セグ風の数字で表示する。0〜15 なので 16 進 1 桁
 * （0〜9 と A〜F）で出す。
 *
 * ---------------------------------------------------------------------------
 * なぜ要るのか
 * ---------------------------------------------------------------------------
 * ここまで「今いくつ流れているか」を知る手段が **計測器アイテムしか無かった**。
 * 手に持って覗き込まないと分からないので、回路の横に置いて常に見える表示が要る。
 * カウンターと組み合わせると、そのまま数取器になる。
 *
 * ---------------------------------------------------------------------------
 * ステート名の注意
 * ---------------------------------------------------------------------------
 * 表示している値は **wr:value** に持つ。wr:power にしてはいけない。
 * util.js の powerFrom() は wr: ブロックの wr:power を「出力」として読むため、
 * 表示ブロックが電源として振る舞ってしまい、
 * 隣のワイヤーが自分で光らせた表示から電力を読み返して消えなくなる
 * （光源で踏んだのと同じ罠。lighting.js の先頭コメントを参照）。
 */

// ---------------------------------------------------------------------------
// 2 桁 10 進モード（wr:dec）
// ---------------------------------------------------------------------------
//
// 既定は今までどおり 16 進 1 桁（0〜F）。**スニーク + 右クリック**で
// 「10 進モード」に切り替わり、**西隣の表示ブロックと組んで 2 桁**になる。
//
//   [十の位] [一の位]   ← 一の位が電力を読み、十の位へ書き込む
//     西        東
//
// 電力は 0〜15 なので十の位は 0 か 1 にしかならないが、
// カウンターと繋いだときに "F" ではなく "15" と読めるのは実用上おおきい。
//
// **なぜ既定を変えないのか**: 表示ブロックを 2 個並べている既存の配線が、
// アドオンを更新しただけで勝手に 2 桁表示に化けると困る。
// だから 10 進は明示的に切り替えたときだけ効く。
//
// 役割は座標から決まるのでステートに持たせない:
//   東隣に 10 進モードの表示ブロックがある → 自分は上位桁（電力を読まない）
//   無い                                  → 自分は一の位（電力を読む）

import { maxIncomingPower, clampPower, neighborBlock, typeIdOf, stateOf } from "./util.js";
import { scheduleUpdate, applyStates, registerUpdater } from "./propagation_helper.js";

const isDisplay = (b) => !!b && typeIdOf(b) === "wr:display";
const isDecimal = (b) => isDisplay(b) && stateOf(b, "wr:dec") === true;

function updateDisplay(block) {
  if (stateOf(block, "wr:dec") !== true) {
    // 16 進 1 桁（従来どおり）
    applyStates(block, { "wr:value": clampPower(maxIncomingPower(block)) });
    return;
  }

  // 10 進モード。東隣にも 10 進の表示があるなら、自分は上位桁なので
  // 電力は読まずに待つ（一の位の側が書き込んでくれる）。
  if (isDecimal(neighborBlock(block, "east"))) return;

  // 自分が一の位。値を読んで、桁ごとに西へ配っていく。
  let rest = clampPower(maxIncomingPower(block));
  applyStates(block, { "wr:value": rest % 10 });
  rest = Math.floor(rest / 10);

  let next = neighborBlock(block, "west");
  // 桁が尽きても、繋がっている上位桁は 0 で埋める（"5" の左に前回の "1" が残らないように）
  while (isDecimal(next)) {
    applyStates(next, { "wr:value": rest % 10 });
    rest = Math.floor(rest / 10);
    next = neighborBlock(next, "west");
  }
}
registerUpdater("wr:display", updateDisplay);

export const displayComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateDisplay);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateDisplay);
  },
  // 出力を持たないので redstone_consumer が付けられ、onRedstoneUpdate が使える。
  // ただし wr: ブロックの出力はステート直読みでしか分からないので tick も併用する。
  onRedstoneUpdate(e) {
    scheduleUpdate(e.block, updateDisplay);
  },
  /**
   * 右クリック            … 今の値を読み上げる（遠くて数字が読めないとき用）
   * スニーク + 右クリック … 16 進 1 桁 / 10 進 2 桁 を切り替える
   */
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;

    if (player.isSneaking) {
      const dec = stateOf(e.block, "wr:dec") !== true;
      applyStates(e.block, { "wr:dec": dec });
      scheduleUpdate(e.block, updateDisplay);
      // 隣の桁も出し直させる（役割が入れ替わることがあるため）
      for (const face of ["east", "west"]) {
        const nb = neighborBlock(e.block, face);
        if (isDisplay(nb)) scheduleUpdate(nb, updateDisplay);
      }
      player.onScreenDisplay.setActionBar({
        translate: dec ? "wr.msg.display.decimal" : "wr.msg.display.hex",
      });
      return;
    }

    const value = stateOf(e.block, "wr:value");
    player.onScreenDisplay.setActionBar({
      translate: "wr.msg.display.value",
      with: [String(typeof value === "number" ? value : 0)],
    });
  },
};
