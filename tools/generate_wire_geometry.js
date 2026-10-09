/**
 * wr:wire のジオメトリと、腕の向き対応表を生成する（ビルド時専用 / Node.js）。
 *
 *   node tools/generate_wire_geometry.js
 *
 * 出力:
 *   RedstoneExtRP/models/blocks/wr_wire.geo.json   支持面ごとに 6 種類のジオメトリ
 *   RedstoneExtBP/scripts/wire_arms.js             ランタイムが使う対応表（自動生成）
 *
 * ---------------------------------------------------------------------------
 * なぜ 6 種類も作るのか
 * ---------------------------------------------------------------------------
 * 以前は「床に貼りついた板」1 種類だけを作り、minecraft:transformation の回転で
 * 壁・天井に向けていた。しかしこの方式だと
 *   ・板がどの面に行くか
 *   ・モデルの「北の腕」が実際にどのワールド方位を向くか
 * の両方がエンジンの回転規約（符号の向き）に依存する。
 * 実機では壁のワイヤーの接続形状がズレていた。
 *
 * そこで**支持面ごとに板と腕の向きを最初から作り分ける**ことにした。
 * 回転を一切使わないので規約の当たり外れが無くなり、
 * 「腕 c0 はこのワールド方位」という対応が定義そのものになる。
 *
 * 腕は面内の 4 方向しかないので、ステートは c0〜c3 の 4 つで足りる
 * （ワールド方位 6 つぶんのステートを持つと状態数が 4 倍になってしまう）。
 * どのスロットがどの方位かは支持面ごとに違い、それがこのファイルの
 * SUPPORT_LAYOUT であり、そのまま wire_arms.js に書き出される。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const GEO_OUT = path.join(ROOT, "RedstoneExtRP", "models", "blocks", "wr_wire.geo.json");
const PANEL_GEO_OUT = path.join(ROOT, "RedstoneExtRP", "models", "blocks", "wr_panel.geo.json");
const ARMS_OUT = path.join(ROOT, "RedstoneExtBP", "scripts", "wire_arms.js");

/** block_face（相手のどの面に接して置かれたか）→ 板が貼りつく側（支持面）。 */
const SUPPORT_OF = {
  up: "down",
  down: "up",
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

const THICK = 1; // 板の厚み（px）
const CORE = 4; // 中央ノードの一辺
const ARM = 6; // 腕の長さ

/**
 * 支持面ごとのレイアウト。
 *
 *   plane  … 板が広がっている 2 軸（large faces を決めるのに使う）
 *   slots  … c0〜c3 が向くワールド方位
 *
 * モデル座標は x = 東, y = 上, z = 南。ブロックは x,z ∈ [-8,8] / y ∈ [0,16]。
 */
const SUPPORT_LAYOUT = {
  // 床に貼りつく（真下が支持）。面内は水平 4 方向。
  down: { plane: "xz", offset: 0, slots: { c0: "north", c1: "south", c2: "east", c3: "west" } },
  // 天井に貼りつく。
  up: { plane: "xz", offset: 16 - THICK, slots: { c0: "north", c1: "south", c2: "east", c3: "west" } },
  // 北の壁に貼りつく。面内は上下と東西。
  north: { plane: "xy", offset: -8, slots: { c0: "up", c1: "down", c2: "east", c3: "west" } },
  south: { plane: "xy", offset: 8 - THICK, slots: { c0: "up", c1: "down", c2: "east", c3: "west" } },
  // 東の壁に貼りつく。面内は上下と南北。
  east: { plane: "yz", offset: 8 - THICK, slots: { c0: "up", c1: "down", c2: "north", c3: "south" } },
  west: { plane: "yz", offset: -8, slots: { c0: "up", c1: "down", c2: "north", c3: "south" } },
};

/** テクスチャ（16x16 の十字）のどこを各パーツに割り当てるか。 */
const UV = {
  core: { uv: [6, 6], uv_size: [CORE, CORE] },
  c0: { uv: [6, 0], uv_size: [CORE, ARM] }, // テクスチャの上方向
  c1: { uv: [6, 10], uv_size: [CORE, ARM] }, // 下方向
  c2: { uv: [10, 6], uv_size: [ARM, CORE] }, // 右方向
  c3: { uv: [0, 6], uv_size: [ARM, CORE] }, // 左方向
};

/** 板の厚み側（1px）の面に貼る細い帯。線の断面なのでどの面でも同じで構わない。 */
const EDGE_UV = { uv: [6, 7], uv_size: [CORE, 1] };

/** 板が広がっている 2 軸から、大きい面（テクスチャを貼る面）の組を返す。 */
const LARGE_FACES = {
  xz: ["up", "down"],
  xy: ["north", "south"],
  yz: ["east", "west"],
};

const ALL_FACES = ["north", "south", "east", "west", "up", "down"];

/** ワールド方位 → 単位ベクトル（モデル座標）。 */
const DIR_VEC = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
};

/**
 * 支持面レイアウトから 1 つのキューブ（origin / size）を組み立てる。
 *
 * @param plane   板の広がっている 2 軸
 * @param offset  板の位置（plane に含まれない軸の座標）
 * @param dir     腕の向き（null なら中央ノード）
 */
function cube(plane, offset, dir) {
  // 板の法線軸（plane に含まれない軸）
  const normalAxis = plane === "xz" ? 1 : plane === "xy" ? 2 : 0;
  /** 軸ごとのブロック中心。y だけ [0,16] なので 8、x/z は [-8,8] なので 0。 */
  const centerOf = (axis) => (axis === 1 ? 8 : 0);

  const origin = [0, 0, 0];
  const size = [0, 0, 0];

  // まず中央ノードの形にする
  for (let axis = 0; axis < 3; axis += 1) {
    if (axis === normalAxis) {
      origin[axis] = offset;
      size[axis] = THICK;
    } else {
      origin[axis] = centerOf(axis) - CORE / 2;
      size[axis] = CORE;
    }
  }

  if (!dir) return { origin, size };

  // 腕は向いている軸だけ、中央ノードの端から外側へ ARM ぶん伸ばす
  const vec = DIR_VEC[dir];
  const axis = vec.findIndex((v) => v !== 0);
  const center = centerOf(axis);
  origin[axis] = vec[axis] > 0 ? center + CORE / 2 : center - CORE / 2 - ARM;
  size[axis] = ARM;
  return { origin, size };
}

/** 1 つのキューブぶんの uv 定義。 */
function faceUv(plane, slot) {
  const large = LARGE_FACES[plane];
  const uv = {};
  for (const face of ALL_FACES) {
    uv[face] = large.includes(face) ? UV[slot] : EDGE_UV;
  }
  return uv;
}

function buildGeometry(support) {
  const layout = SUPPORT_LAYOUT[support];
  const bones = [];

  const add = (name, slot, dir) => {
    // X はモデル座標とワールド座標で左右が逆（上の mirrorX のコメント参照）
    const { origin, size } = mirrorX(cube(layout.plane, layout.offset, dir));
    bones.push({
      name,
      pivot: [0, 8, 0],
      cubes: [{ origin, size, uv: faceUv(layout.plane, slot) }],
    });
  };

  // core は常に表示（bone_visibility には書かない。書くとエンジンに弾かれる）
  add("core", "core", null);
  for (const slot of ["c0", "c1", "c2", "c3"]) {
    add(`arm_${slot}`, slot, layout.slots[slot]);
  }

  return {
    description: {
      identifier: `geometry.wr_wire_${support}`,
      texture_width: 16,
      texture_height: 16,
      visible_bounds_width: 2,
      visible_bounds_height: 2,
      visible_bounds_offset: [0, 0.5, 0],
    },
    bones,
  };
}

/**
 * wr:light_panel のジオメトリ。
 *
 * ワイヤーと違って接続の腕が無く、面いっぱいに広がる 1px の板 1 枚だけ。
 * 向きの持ち方（block_face → 支持面）はワイヤーと同じなので、
 * レイアウト表と selectionBox() をそのまま使い回している。
 */
function buildPanelGeometry(support) {
  const layout = SUPPORT_LAYOUT[support];
  // selectionBox() はすでに反転済みの座標系を返すのでそのまま使える
  const { origin, size } = selectionBox(support);
  const large = LARGE_FACES[layout.plane];

  // 大きい面はテクスチャ全体、厚み側の 1px はテクスチャ端の 1 行で済ませる。
  const uv = {};
  for (const face of ALL_FACES) {
    uv[face] = large.includes(face)
      ? { uv: [0, 0], uv_size: [16, 16] }
      : { uv: [0, 0], uv_size: [16, 1] };
  }

  return {
    description: {
      identifier: `geometry.wr_panel_${support}`,
      texture_width: 16,
      texture_height: 16,
      visible_bounds_width: 2,
      visible_bounds_height: 2,
      visible_bounds_offset: [0, 0.5, 0],
    },
    bones: [{ name: "panel", pivot: [0, 8, 0], cubes: [{ origin, size, uv }] }],
  };
}

/**
 * 支持面 → 板の占める箱。**X を反転した座標系**で返す（mirrorX 済み）。
 *
 * `minecraft:selection_box` もジオメトリと同じ反転座標系で解釈されるので、
 * 片方だけ反転させると **見た目は正しいのに当たり判定だけ反対側**になる。
 * 実機で「当たり判定の位置がおかしい」と出たのがこれ。
 * 両方この関数を通して、座標系を 1 つに揃えている。
 *
 * @param inset 面内の 2 軸を内側に詰める量（px）。
 *
 * ---------------------------------------------------------------------------
 * なぜ当たり判定を小さくするのか（ワイヤーは inset = 4）
 * ---------------------------------------------------------------------------
 * 面いっぱい（16x16）にすると、**ワイヤーが 2 枚以上並んだ時点で
 * その壁面が当たり判定で隙間なく覆われる**。すると隣の壁を狙ったつもりでも
 * 既存のワイヤーをクリックしてしまい、新しいブロックは
 * ワイヤーの手前（壁から 1 マス浮いた位置）に置かれる。
 * そこから支持面の自動吸着が別の面（反対側の壁や床）を掴むので、
 * **意図した壁から浮いたまま残る**。実機で出た症状がこれで、
 * 「同じブロックが上下左右に 2 個以上あると起こりやすい」という
 * 報告どおり、並べるほど当たり判定の面積が増えて踏みやすくなる。
 *
 * 中央 8x8 に詰めると板の周りに 4px の隙間ができ、そこから
 * 奥の壁を直接クリックできるようになる。
 * 見た目のジオメトリ（幅 4px の十字）より広いので、
 * 染色やクリックのしやすさは保たれる。
 */
function selectionBox(support, inset = 0) {
  const layout = SUPPORT_LAYOUT[support];
  const normalAxis = layout.plane === "xz" ? 1 : layout.plane === "xy" ? 2 : 0;
  const origin = [-8, 0, -8];
  const size = [16, 16, 16];
  for (let axis = 0; axis < 3; axis += 1) {
    if (axis === normalAxis) continue;
    origin[axis] += inset;
    size[axis] -= inset * 2;
  }
  origin[normalAxis] = layout.offset;
  size[normalAxis] = THICK;
  return mirrorX({ origin, size });
}

/**
 * ワイヤーの当たり判定の詰め量。
 *
 * v1.15.4 で「並べると壁がクリックできない」対策として 4 に縮めたが、
 * 実際の原因は下記の X 軸반転（板が反対側に描かれていた）だった。
 * 当たり判定を小さくすると染色や破壊がやりにくくなるだけなので 0 に戻した。
 */
const WIRE_SELECT_INSET = 0;

/**
 * ---------------------------------------------------------------------------
 * Bedrock のブロックモデルは X 軸が反転している
 * ---------------------------------------------------------------------------
 * `minecraft:geometry` に渡すモデル座標は、**X だけワールドと左右が逆**になる
 * （Z と Y はそのまま）。`minecraft:selection_box` などのブロック側の箱は
 * ワールド座標のままなので、両者は X について鏡像の関係になる。
 *
 * これに気づかず素直に「+X = 東」で組むと、
 *   ・north / south に貼る板 … Z 方向なので正しく出る
 *   ・east / west に貼る板   … **反対側の面に描かれる**
 * となり、東西の壁のワイヤーだけが壁から 1 マス離れて浮いて見える。
 * 実機で出た症状がこれで、「東と西のテクスチャが逆では」という指摘で判明した。
 *
 * 対処は、組み上がったキューブの X を最後にまとめて反転すること。
 * 板の位置だけでなく、床・天井の板の東西の腕（c2 / c3）も同時に正しくなるので、
 * SUPPORT_LAYOUT や ARM_WORLD の「意味」の側は素直なまま（+X = 東）で書ける。
 */
function mirrorX({ origin, size }) {
  return { origin: [-(origin[0] + size[0]), origin[1], origin[2]], size };
}

/** 数値だけの配列を 1 行に畳んで読めるサイズにする。 */
function compactJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /\[\s+(-?\d+(?:\.\d+)?(?:,\s+-?\d+(?:\.\d+)?)*)\s+\]/g,
    (_, body) => `[${body.split(/,\s+/).join(", ")}]`
  );
}

function main() {
  // ---- ジオメトリ ----
  const geo = {
    format_version: "1.16.0",
    "minecraft:geometry": Object.keys(SUPPORT_LAYOUT).map(buildGeometry),
  };
  fs.writeFileSync(GEO_OUT, compactJson(geo) + "\n", "utf8");

  // ---- 隠し光源パネルのジオメトリ（腕の無い板 1 枚） ----
  const panelGeo = {
    format_version: "1.16.0",
    "minecraft:geometry": Object.keys(SUPPORT_LAYOUT).map(buildPanelGeometry),
  };
  fs.writeFileSync(PANEL_GEO_OUT, compactJson(panelGeo) + "\n", "utf8");

  // 反転がどこかで二重にかかっていないかの自己チェック。
  // 東に貼る板は、X が反転しているモデル座標では **西寄り**（x = -8）に来るのが正しい。
  // ここが 7 になっていたら mirrorX が抜けているか二重にかかっている。
  for (const [support, expected] of [["east", -8], ["west", 16 - THICK - 8]]) {
    for (const doc of [geo, panelGeo]) {
      const model = doc["minecraft:geometry"].find((g) =>
        g.description.identifier.endsWith(`_${support}`)
      );
      const x = model.bones[0].cubes[0].origin[0];
      if (x !== expected) {
        throw new Error(
          `${model.description.identifier}: 板のモデル X が ${x}（${expected} のはず）。` +
            "mirrorX の掛け忘れか二重掛けを疑うこと。"
        );
      }
    }
  }

  // ---- ランタイム用の対応表 ----
  const armWorld = {};
  const geometryFor = {};
  const selection = {};
  for (const [blockFace, support] of Object.entries(SUPPORT_OF)) {
    armWorld[blockFace] = SUPPORT_LAYOUT[support].slots;
    geometryFor[blockFace] = `geometry.wr_wire_${support}`;
    selection[blockFace] = selectionBox(support);
  }

  const js = `/**
 * 自動生成ファイル — 直接編集しないこと。
 * 生成元: tools/generate_wire_geometry.js
 *
 * ワイヤーの腕（wr:c0〜wr:c3）がどのワールド方位を向くかの対応表。
 * ジオメトリ側に向きを焼き込んであるので、この表とモデルは必ず一致する。
 */

/** block_face → { c0: 方位, c1: 方位, c2: 方位, c3: 方位 } */
export const ARM_WORLD = ${JSON.stringify(armWorld, null, 2)};

/** 腕の反対側（1 本しか繋がっていないときに直線に見せるため）。 */
export const ARM_OPPOSITE = { c0: "c1", c1: "c0", c2: "c3", c3: "c2" };

/** 腕のステート名の一覧。 */
export const ARM_SLOTS = ["c0", "c1", "c2", "c3"];
`;
  fs.writeFileSync(ARMS_OUT, js, "utf8");

  console.log(`wrote ${path.relative(ROOT, GEO_OUT)} (6 geometries)`);
  console.log(`wrote ${path.relative(ROOT, PANEL_GEO_OUT)} (6 geometries)`);
  console.log(`wrote ${path.relative(ROOT, ARMS_OUT)}`);
}

module.exports = { SUPPORT_OF, SUPPORT_LAYOUT, selectionBox, WIRE_SELECT_INSET };

if (require.main === module) main();
