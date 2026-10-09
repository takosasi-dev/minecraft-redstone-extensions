/**
 * 配線レンチ (wr:wrench)
 *
 * 設置済みの薄板（ワイヤー・光源パネル）の **貼りつく面を後から変える** 道具。
 *
 * ---------------------------------------------------------------------------
 * なぜ要るのか
 * ---------------------------------------------------------------------------
 * 板の向きは設置時のクリック面で決まるが、狙った壁と別の面に付いてしまうことが
 * どうしても起きる。壁のすぐ下に床があれば床の上面を、通路なら反対側の壁を、
 * といった具合に「クリックできてしまう面」が複数あるためで、
 * 当たり判定を小さくしても皆無にはできない。
 *
 * これまでは **壊して置き直すしか直す手段が無かった**。長い配線でこれをやると
 * 網の再計算が走るうえ、置き直しでまた別の面に付くこともある。
 * そこで「置いたあとに向きだけ変える」道具を用意した。
 *
 * ---------------------------------------------------------------------------
 * 操作
 * ---------------------------------------------------------------------------
 *   右クリック            … その板の貼りつく面を次の候補へ送る
 *   スニーク + 右クリック … その板の面を、繋がっている板すべてに揃える
 *
 * 候補は **支えのある面だけ**（surface.js の placeableFaces）。
 * 支えの無い面を書き込んでも次の tick に ensureSupport() が引き戻すので、
 * 選ばせないほうが混乱がない。
 */

import { FACES, neighborBlock, blockKey } from "./util.js";
import { applyStates, scheduleByType } from "./propagation_helper.js";
import { isThinPlate, faceOf, placeableFaces } from "./surface.js";

/** 一度に揃える板の最大数（暴走よけ）。ワイヤー網の上限と揃えてある。 */
const ALIGN_LIMIT = 512;

/** 板の向きを変えて、見た目（腕）を計算し直させる。 */
function setFace(block, face) {
  if (!applyStates(block, { "minecraft:block_face": face })) return false;
  // 腕の向きは貼りつく面で変わるので、自分と隣を計算し直す
  scheduleByType(block);
  for (const f of FACES) {
    const nb = neighborBlock(block, f);
    if (isThinPlate(nb)) scheduleByType(nb);
  }
  return true;
}

/** 右クリック: 支えのある面を順に送る。 */
function cycleFace(block, player) {
  const faces = placeableFaces(block);
  if (faces.length === 0) {
    player.onScreenDisplay.setActionBar({ translate: "wr.msg.wrench.nosupport" });
    return;
  }
  if (faces.length === 1) {
    // 送り先が無いことを黙って無視すると「壊れている」ように見えるので伝える
    player.onScreenDisplay.setActionBar({ translate: "wr.msg.wrench.only" });
    setFace(block, faces[0]);
    return;
  }

  const current = faceOf(block);
  const at = faces.indexOf(current);
  const next = faces[(at + 1) % faces.length];
  setFace(block, next);
  player.onScreenDisplay.setActionBar({
    translate: "wr.msg.wrench.face",
    with: [next],
  });
}

/**
 * スニーク + 右クリック: 繋がっている同種の板を、この板と同じ面に揃える。
 *
 * 「配線の途中だけ床に寝てしまった」を 1 回で直すためのもの。
 * 支えの無い板は飛ばす（揃えると落ちてしまうため）。
 */
function alignRun(block, player) {
  const face = faceOf(block);
  const typeId = block.typeId;

  const seen = new Set([blockKey(block.dimension.id, block.location)]);
  const stack = [block];
  let changed = 0;
  let skipped = 0;

  while (stack.length > 0 && seen.size < ALIGN_LIMIT) {
    const current = stack.pop();
    if (placeableFaces(current).includes(face)) {
      if (setFace(current, face)) changed += 1;
    } else if (current !== block) {
      skipped += 1; // その位置にはその面の支えが無い
    }

    for (const f of FACES) {
      const nb = neighborBlock(current, f);
      if (!nb || nb.typeId !== typeId) continue;
      const key = blockKey(nb.dimension.id, nb.location);
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push(nb);
    }
  }

  player.onScreenDisplay.setActionBar({
    translate: "wr.msg.wrench.aligned",
    with: [String(changed), face, String(skipped)],
  });
}

export const wrenchComponent = {
  onUseOn(e) {
    const player = e.source;
    const block = e.block;
    if (!player || !block) return;

    if (!isThinPlate(block)) {
      player.onScreenDisplay.setActionBar({ translate: "wr.msg.wrench.target" });
      return;
    }

    if (player.isSneaking) alignRun(block, player);
    else cycleFace(block, player);
  },
};
