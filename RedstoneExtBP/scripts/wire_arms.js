/**
 * 自動生成ファイル — 直接編集しないこと。
 * 生成元: tools/generate_wire_geometry.js
 *
 * ワイヤーの腕（wr:c0〜wr:c3）がどのワールド方位を向くかの対応表。
 * ジオメトリ側に向きを焼き込んであるので、この表とモデルは必ず一致する。
 */

/** block_face → { c0: 方位, c1: 方位, c2: 方位, c3: 方位 } */
export const ARM_WORLD = {
  "up": {
    "c0": "north",
    "c1": "south",
    "c2": "east",
    "c3": "west"
  },
  "down": {
    "c0": "north",
    "c1": "south",
    "c2": "east",
    "c3": "west"
  },
  "north": {
    "c0": "up",
    "c1": "down",
    "c2": "east",
    "c3": "west"
  },
  "south": {
    "c0": "up",
    "c1": "down",
    "c2": "east",
    "c3": "west"
  },
  "east": {
    "c0": "up",
    "c1": "down",
    "c2": "north",
    "c3": "south"
  },
  "west": {
    "c0": "up",
    "c1": "down",
    "c2": "north",
    "c3": "south"
  }
};

/** 腕の反対側（1 本しか繋がっていないときに直線に見せるため）。 */
export const ARM_OPPOSITE = { c0: "c1", c1: "c0", c2: "c3", c3: "c2" };

/** 腕のステート名の一覧。 */
export const ARM_SLOTS = ["c0", "c1", "c2", "c3"];
