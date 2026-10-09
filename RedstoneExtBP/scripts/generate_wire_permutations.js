/**
 * wr:wire のパーミュテーション生成スクリプト（ビルド時専用 / Node.js で実行）
 *
 *   node RedstoneExtBP/scripts/generate_wire_permutations.js
 *
 * これは Minecraft のランタイムからは読み込まれない。BP/blocks/wire.json を
 * 出力するだけの CommonJS スクリプト（main.js とは無関係）。
 *
 * 状態空間: 支持面 6 × wr:power 16 × wr:color 16 × 腕 2^4 × wr:glow 2 = 49152 通り。
 *
 * ただしパーミュテーションの *エントリ* はその数だけ要らない。
 * Bedrock のパーミュテーションは「条件に合致したものが配列の順に累積適用され、
 * 同じコンポーネントは後のエントリが上書きする」仕様なので、
 * コンポーネントごとに依存するステートだけで条件を書けばよい:
 *
 *   minecraft:geometry            … block_face だけに依存        →  6 エントリ
 *   minecraft:redstone_producer   … wr:power だけに依存          → 16 エントリ
 *   minecraft:material_instances  … wr:color と 点灯有無に依存   → 32 エントリ
 *   minecraft:light_emission      … wr:glow と wr:power に依存   → 15 エントリ
 *                                                          合計    69 エントリ
 *
 * 支持面の持ち方について:
 *   仕様書では `wr:support` という独自ステートを使う想定になっていたが、
 *   独自ステートだと「どの面に設置されたか」をスクリプト側から知る手段が
 *   （onPlace イベントに面情報が無いため）存在しない。
 *   そのためエンジン標準の minecraft:placement_position トレイト
 *   （minecraft:block_face ステート）をそのまま支持面ステートとして使う。
 *   block_face は「プレイヤーがクリックした面」なので、
 *   ワイヤーを支えているブロックの方向は block_face の逆向きになる。
 */

const fs = require("fs");
const path = require("path");

const {
  SUPPORT_OF,
  selectionBox,
  WIRE_SELECT_INSET,
} = require("../../tools/generate_wire_geometry.js");

/**
 * クリエイティブの並び。generate_blocks.js の MENU_REDSTONE と同じ値にすること。
 * **ここだけ生成器が別ファイル**なので、片方だけ変えると wr:wire の扱いがずれる
 * （実際 v1.18.0 の作業中に wire だけグループから外れた）。
 * グループを付ける／付けないの経緯は generate_blocks.js のコメントを参照。
 */
const MENU_REDSTONE = { category: "items", group: "wr:itemGroup.name.redstone_ext" };

/**
 * wr:color の値 → 染料の色名。index 0 = red が既定（染色していない状態）。
 * 対応する染料アイテムは minecraft:<name>_dye。
 * この並び順は scripts/colors.js と必ず一致させること。
 */
const WIRE_COLORS = [
  "red",
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "black",
];

const FACES = Object.keys(SUPPORT_OF);
const POWERS = Array.from({ length: 16 }, (_, i) => i);
const COLOR_INDICES = WIRE_COLORS.map((_, i) => i);
const ARM_SLOTS = ["c0", "c1", "c2", "c3"];

/**
 * block_face ごとのジオメトリ指定。
 *
 * 板の向きも腕の向きもジオメトリ側に焼き込んであるので、
 * minecraft:transformation による回転は使わない。
 * 以前は回転で 1 種類のジオメトリを使い回していたが、
 * エンジンの回転規約に依存して壁のワイヤーの接続形状がズレていた。
 *
 * bone_visibility の値は Molang 文字列で書く。bool を書くと
 * geometry コンポーネントごと弾かれてブロックが読み込まれなくなる。
 * 常に見せたい core は書かない（既定で表示）。
 */
function geometryFor(blockFace) {
  const boneVisibility = {};
  for (const slot of ARM_SLOTS) {
    boneVisibility[`arm_${slot}`] = `q.block_state('wr:${slot}')`;
  }
  return {
    identifier: `geometry.wr_wire_${SUPPORT_OF[blockFace]}`,
    bone_visibility: boneVisibility,
  };
}

function materialInstances(colorName, on) {
  return {
    "*": {
      texture: on ? `wr_wire_${colorName}_on` : `wr_wire_${colorName}`,
      render_method: "alpha_test",
      face_dimming: false,
      // ambient_occlusion は bool ではなく数値（0 で無効、既定 1）。
      // false を渡すと「invalid numeric value」でブロックごと読み込みに失敗する。
      ambient_occlusion: 0,
    },
  };
}

function buildWireBlock() {
  const permutations = [];

  // (1) 向き — block_face だけで決まる。板と腕の向きが焼き込まれた
  //     ジオメトリを選び、当たり判定の枠もその面に合わせる。
  for (const face of FACES) {
    permutations.push({
      condition: `q.block_state('minecraft:block_face') == '${face}'`,
      components: {
        "minecraft:geometry": geometryFor(face),
        "minecraft:selection_box": selectionBox(SUPPORT_OF[face], WIRE_SELECT_INSET),
      },
    });
  }

  // (2) 出力 — wr:power だけで決まる。
  //     受電値そのものを弱い電力として全方向に出す。
  //     「受電値 - 1」の減衰はスクリプト側（wire.js）で行うため、
  //     ここでは wr:power をそのまま出力する。
  for (const power of POWERS) {
    permutations.push({
      condition: `q.block_state('wr:power') == ${power}`,
      components: {
        "minecraft:redstone_producer": {
          power,
          connected_faces: ["down", "up", "north", "south", "west", "east"],
        },
      },
    });
  }

  // (3) 発光モード — wr:glow が立っているときだけ、電力の強さで光る。
  //     ワイヤーは 1 マスごとに 1 減衰するので、伸ばすほど自然に暗くなる。
  //     power 0 は base の light_emission 0 のままでよいので 1 から。
  for (const power of POWERS) {
    if (power === 0) continue;
    permutations.push({
      condition:
        `q.block_state('wr:glow') == true && q.block_state('wr:power') == ${power}`,
      components: { "minecraft:light_emission": power },
    });
  }

  // (4) 見た目 — wr:color と「通電しているか」で決まる
  for (const color of COLOR_INDICES) {
    const name = WIRE_COLORS[color];
    permutations.push({
      condition: `q.block_state('wr:color') == ${color} && q.block_state('wr:power') == 0`,
      components: { "minecraft:material_instances": materialInstances(name, false) },
    });
    permutations.push({
      condition: `q.block_state('wr:color') == ${color} && q.block_state('wr:power') > 0`,
      components: { "minecraft:material_instances": materialInstances(name, true) },
    });
  }

  return {
    format_version: "1.26.20",
    "minecraft:block": {
      description: {
        identifier: "wr:wire",
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_position": {
            enabled_states: ["minecraft:block_face"],
          },
        },
        states: {
          "wr:power": POWERS,
          "wr:color": COLOR_INDICES,
          // 接続の腕。面内の 4 方向ぶんしかないので 4 つで足りる。
          // どのスロットがどのワールド方位かは板が貼りついている面で変わり、
          // その対応は scripts/wire_arms.js（自動生成）が持っている。
          "wr:c0": [false, true],
          "wr:c1": [false, true],
          "wr:c2": [false, true],
          "wr:c3": [false, true],
          // 発光モード。グロウストーンダストを持って右クリックで切り替える。
          "wr:glow": [false, true],
        },
      },
      components: {
        "minecraft:display_name": "tile.wr:wire.name",
        // base にも geometry が必須。実際の向きはパーミュテーション側で差し替える。
        "minecraft:geometry": geometryFor("up"),
        "minecraft:material_instances": materialInstances(WIRE_COLORS[0], false),
        "minecraft:collision_box": false,
        "minecraft:selection_box": selectionBox("down", WIRE_SELECT_INSET),
        "minecraft:light_dampening": 0,
        // 既定は光らない。発光モードのときだけパーミュテーションが上書きする。
        "minecraft:light_emission": 0,
        "minecraft:destructible_by_mining": { seconds_to_destroy: 0 },
        "minecraft:destructible_by_explosion": { explosion_resistance: 0 },
        // 自分自身は導体にならず、バニラのレッドストーンダストの段差降りも許可しない。
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        // redstone_consumer は付けられない。
        // エンジンが「1 つのブロックが redstone_producer と redstone_consumer の
        // 両方を持つこと」を禁止しているため（付けるとブロックごと読み込み失敗）。
        // 入力の検知は minecraft:tick のポーリング + wire.js の隣接連鎖で行う。
        //
        // format_version 1.26.20 以降は、パーミュテーションで redstone_producer を
        // 使うなら base 側にも宣言しておく必要がある
        // （「cannot define ... in the 'permutations' array and not define it in
        //   the base 'components' object」）。値はパーミュテーションが上書きする。
        "minecraft:redstone_producer": { power: 0 },
        // ピストンに押されると座標がずれるだけなので「押されたら壊れて落ちる」を選ぶ。
        "minecraft:movable": { movement_type: "popped" },
        // 支持面の消失チェックと、バニラ側の電力変化に気づくためのポーリング。
        // ここから先の伝播は隣接連鎖（scheduleNeighbors）が担うので、
        // この間隔は「レバーを倒してから反応が始まるまでの最大遅れ」でしかない。
        "minecraft:tick": { interval_range: [4, 4], looping: true },
        // カスタムコンポーネントは components に直接 id を書く形式。
        // 旧形式の `"minecraft:custom_components": ["wr:wire"]`（配列）は
        // format_version 1.21.90 以降のスキーマから削除されている。
        "wr:wire": {},
      },
      permutations,
    },
  };
}

function main() {
  const out = path.join(__dirname, "..", "blocks", "wire.json");
  const json = buildWireBlock();
  fs.writeFileSync(out, JSON.stringify(json, null, 2) + "\n", "utf8");
  console.log(`wrote ${out} (${json["minecraft:block"].permutations.length} permutations)`);
}

module.exports = { buildWireBlock, WIRE_COLORS, ARM_SLOTS };

if (require.main === module) main();
