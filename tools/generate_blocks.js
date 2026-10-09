/**
 * wr:wire 以外の 8 ブロックの JSON を生成する（ビルド時専用 / Node.js で実行）。
 *
 *   node tools/generate_blocks.js
 *
 * wire.json だけは仕様書の指定どおり
 * RedstoneExtBP/scripts/generate_wire_permutations.js が生成する。
 * このスクリプトはそれも合わせて呼び出すので、通常はこれ 1 本を実行すればよい。
 */

const fs = require("fs");
const path = require("path");
const {
  buildWireBlock,
  WIRE_COLORS,
} = require("../RedstoneExtBP/scripts/generate_wire_permutations.js");
const { SUPPORT_OF, selectionBox } = require("./generate_wire_geometry.js");

const BP_DIR = path.join(__dirname, "..", "RedstoneExtBP");
const BLOCKS_DIR = path.join(BP_DIR, "blocks");
const ITEMS_DIR = path.join(BP_DIR, "items");
const CATALOG_DIR = path.join(BP_DIR, "item_catalog");
const FORMAT = "1.26.20";

const CARDINALS = ["north", "south", "east", "west"];
const ALL_FACES = ["down", "up", "north", "south", "west", "east"];

/** cardinal_direction（前面＝出力方向）→ ブロック全体のY回転。
 *  上面テクスチャの矢印は「テクスチャ上方向＝北」を向いて描かれている。
 *  ※ 見た目だけの話で、通電ロジックは connected_faces 側で絶対方位を指定しているため
 *    この表が万一逆でも回路の動作は変わらない。 */
const Y_ROTATION = { north: 0, west: 90, south: 180, east: 270 };

const range = (n, from = 0) => Array.from({ length: n }, (_, i) => i + from);

/**
 * クリエイティブの並び。
 *
 * `group` を指定すると、バニラの原木や防具と同じ **折りたためる 1 枠**にまとまる。
 * 指定しないとブロックの数だけ枠を食うので、20 種を超えたあたりから
 * 「アイテムタブがこのアドオンで埋まる」状態になっていた。
 *
 * v1.17.0 では実機実績のあるバニラのグループ
 * （`minecraft:itemGroup.name_redstone`）に相乗りしていたが、
 * バニラのレッドストーン用品と混ざるので **独自グループに分けた**（v1.18.0）。
 *
 * グループ名は **lang の翻訳キーそのもの**でもある。翻訳が無いと
 * 生の文字列（`wr:itemGroup.name_...`）がそのまま見出しに出るので、
 * `tools/validate.js` が「バニラ以外のグループ名は ja/en 両方に訳があること」を
 * 静的に確かめている。
 *
 * ---------------------------------------------------------------------------
 * 独自グループには item_catalog の宣言が要る（v1.20.0）
 * ---------------------------------------------------------------------------
 * `menu_category.group` に独自の名前を書くだけでは効かない。
 * **`behavior_pack/item_catalog/crafting_item_catalog.json` でそのグループを
 * 宣言して初めて、折りたためるフォルダとして現れる。**
 *
 * これを知らずに 2 通り試して、どちらも失敗していた:
 *   v1.18.0 `wr:itemGroup.name_redstone_ext`（名前空間あり・カタログ無し）
 *     → ブロックは残るが **まとまらない**（指定ごと黙って無視される）
 *   v1.18.1 `itemGroup.name.wr_redstone_ext`（名前空間なし・カタログ無し）
 *     → **ブロックが全部クリエイティブから消えた**（定義ごと読み込み失敗）
 *
 * どちらもコンテンツログにエラーが出ないので、症状から原因を逆算できない。
 * カタログは `main()` の最後で **ブロック／アイテムを走査して自動生成**するので、
 * ブロックを足しても宣言漏れは起きない（validate.js が突き合わせも確認する）。
 *
 * 名前は `<名前空間>:itemGroup.name.<識別子>` の形にする（`name` の後は
 * アンダースコアではなくドット）。この文字列がそのまま lang の翻訳キーになる。
 */
const GROUP_REDSTONE = "wr:itemGroup.name.redstone_ext";
const GROUP_BUILD = "wr:itemGroup.name.build_ext";

const MENU_REDSTONE = { category: "items", group: GROUP_REDSTONE };
const MENU_BUILD = { category: "construction", group: GROUP_BUILD };

/** グループの見出しに使うアイコン（代表ブロック）。 */
const GROUP_ICON = {
  [GROUP_REDSTONE]: "wr:transmitter",
  [GROUP_BUILD]: "wr:glow_block",
};

/** write() が書いた順。クリエイティブでの並び順にそのまま使う。 */
const WRITTEN = [];

function base(identifier, langKey, extra = {}) {
  return {
    "minecraft:display_name": langKey,
    // geometry は必須。省略すると
    //   「Block needs both a "geometry" and "material_instances" component.」
    // でブロックごと読み込みに失敗する（昔は省略すると full_block 扱いだった）。
    "minecraft:geometry": "minecraft:geometry.full_block",
    "minecraft:destructible_by_mining": { seconds_to_destroy: 0.6 },
    "minecraft:destructible_by_explosion": { explosion_resistance: 1 },
    ...extra,
  };
}

/**
 * base 側の redstone_producer 宣言。
 *
 * format_version 1.26.20 以降は
 *   「the block cannot define 'minecraft:redstone_producer' in the 'permutations'
 *     array and not define it in the base 'components' object」
 * という制約があり、パーミュテーションで出力を切り替えるブロックは
 * base にも同じコンポーネントを置いておく必要がある。
 * 実際の値はパーミュテーション側が上書きするので、ここは無信号（power 0）でよい。
 */
function producerBase() {
  return { "minecraft:redstone_producer": { power: 0 } };
}

function cube(sideTex) {
  return {
    "minecraft:material_instances": {
      "*": { texture: sideTex, render_method: "opaque" },
    },
  };
}

function topSide(topTex, sideTex) {
  return {
    "minecraft:material_instances": {
      "*": { texture: sideTex, render_method: "opaque" },
      up: { texture: topTex, render_method: "opaque" },
    },
  };
}

/* 床置きの回路ブロックも他と同じ立方体。
 * 一度バニラのリピーターと同じ高さ 2px の薄板にしてみたが、
 * 薄すぎて種類の見分けがつきにくかったので立方体に戻した。 */

/** minecraft:tick。onTick でのポーリング（取りこぼし対策）に必要。 */
function tick(interval) {
  return { "minecraft:tick": { interval_range: [interval, interval], looping: true } };
}

/**
 * カスタムコンポーネントの宣言。
 *
 * 旧形式の `"minecraft:custom_components": ["wr:foo"]`（配列）は
 * format_version 1.21.90 以降のスキーマから**削除されている**。
 * 配列形式のまま書くと
 *   「minecraft:custom_components: this component was found in the input,
 *     but is not present in the Schema」
 * でブロックごと読み込みに失敗し、クリエイティブにもコマンドにも出てこなくなる。
 * 現在はアイテムと同じく components に直接 id を書く。
 */
function customComponent(name) {
  return { [name]: {} };
}

/** 前面のみに出力する redstone_producer。 */
function frontProducer(front, power) {
  return {
    "minecraft:redstone_producer": {
      power,
      connected_faces: [front],
      strongly_powered_face: front,
    },
  };
}

function write(name, json) {
  const out = path.join(BLOCKS_DIR, name + ".json");
  fs.writeFileSync(out, JSON.stringify(json, null, 2) + "\n", "utf8");
  const description = json["minecraft:block"].description;
  WRITTEN.push({
    identifier: description.identifier,
    group: description.menu_category?.group,
    category: description.menu_category?.category,
  });
  const n = json["minecraft:block"].permutations?.length ?? 0;
  console.log(`wrote ${path.basename(out)} (${n} permutations)`);
}

// ---------------------------------------------------------------------------
// A-1. ワイヤレス送信ブロック
// ---------------------------------------------------------------------------

function transmitter() {
  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:transmitter",
        menu_category: MENU_REDSTONE,
      },
      components: base("wr:transmitter", "tile.wr:transmitter.name", {
        ...cube("wr_transmitter"),
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        "minecraft:redstone_consumer": { min_power: 0, propagates_power: false },
        // 座標をキーにしたワールド動的プロパティを持つので、ピストンで動かされると
        // キーと実体がずれる。エンジン側で移動そのものを禁止する。
        "minecraft:movable": { movement_type: "immovable" },
        ...tick(4),
        ...customComponent("wr:transmitter"),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// A-2. ワイヤレス受信ブロック
// ---------------------------------------------------------------------------

function receiver() {
  const permutations = range(16).map((power) => ({
    condition: `q.block_state('wr:power') == ${power}`,
    components: {
      ...cube(power > 0 ? "wr_receiver_on" : "wr_receiver"),
      "minecraft:redstone_producer": {
        power,
        connected_faces: ALL_FACES,
        strongly_powered_face: "up",
      },
    },
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:receiver",
        menu_category: MENU_REDSTONE,
        states: { "wr:power": range(16) },
      },
      components: base("wr:receiver", "tile.wr:receiver.name", {
        ...cube("wr_receiver"),
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        "minecraft:movable": { movement_type: "immovable" },
        ...producerBase(),
        ...customComponent("wr:receiver"),
      }),
      permutations,
    },
  };
}

// ---------------------------------------------------------------------------
// B-2. 段差コーナーブロック
// ---------------------------------------------------------------------------

function cornerRiser() {
  const permutations = range(16).map((power) => ({
    condition: `q.block_state('wr:power') == ${power}`,
    components: {
      "minecraft:redstone_producer": {
        power,
        connected_faces: ALL_FACES,
      },
    },
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:corner_riser",
        menu_category: MENU_REDSTONE,
        states: { "wr:power": range(16) },
      },
      components: base("wr:corner_riser", "tile.wr:corner_riser.name", {
        ...cube("wr_corner_riser"),
        // 普通の立方体としてワイヤーの支持面になれるよう導体扱いにする。
        "minecraft:redstone_conductivity": {
          redstone_conductor: true,
          allows_wire_to_step_down: true,
        },
       
        ...tick(4),
        ...producerBase(),
        ...customComponent("wr:corner_riser"),
      }),
      permutations,
    },
  };
}

// ---------------------------------------------------------------------------
// C-2. パルス生成機
// ---------------------------------------------------------------------------

function pulseGenerator() {
  const permutations = [];
  // 周期は見た目に影響しないので、パーミュテーションは向き × ON/OFF だけでよい
  for (const dir of CARDINALS) {
    for (const on of [false, true]) {
      permutations.push({
        condition:
          `q.block_state('minecraft:cardinal_direction') == '${dir}' && ` +
          `q.block_state('wr:on') == ${on}`,
        components: {
          "minecraft:transformation": { rotation: [0, Y_ROTATION[dir], 0] },
          ...topSide(
            on ? "wr_pulse_generator_top_on" : "wr_pulse_generator_top",
            "wr_pulse_generator_side"
          ),
          ...frontProducer(dir, on ? 15 : 0),
        },
      });
    }
  }

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:pulse_generator",
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_direction": {
            enabled_states: ["minecraft:cardinal_direction"],
            y_rotation_offset: 0,
          },
        },
        // 周期（1〜2400 tick）はワールド動的プロパティ `wr:pulse|<座標>` に持つ。
        // v1.30.1 までは十の位（0-4）と一の位（0-9）の 2 ステートで 1〜50 を表していたが、
        // 1 ステートは 16 値が上限なので、それ以上広げるにはステートを足す＝
        // 掛け算で状態数が増えるしかなかった（400 → 8 状態、予算 -392）。
        // 周期は見た目に効かない＝条件式で一度も参照しないので、外しても
        // パーミュテーションは向き × ON/OFF の 8 個のまま変わらない。
        states: {
          "wr:on": [false, true],
        },
      },
      components: base("wr:pulse_generator", "tile.wr:pulse_generator.name", {
        ...topSide("wr_pulse_generator_top", "wr_pulse_generator_side"),
        "minecraft:placement_filter": { conditions: [{ allowed_faces: ["up"] }] },
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
       
        // 周期は座標キーの動的プロパティ → immovable。
        // popped だとピストンで壊れても onPlayerDestroy が来ず、元の座標に設定が残る。
        "minecraft:movable": { movement_type: "immovable" },
        ...tick(4),
        ...producerBase(),
        ...customComponent("wr:pulse_generator"),
      }),
      permutations,
    },
  };
}

// ---------------------------------------------------------------------------
// C-3. 可変ディレイリピーター
// ---------------------------------------------------------------------------

/**
 * 前面出力のバイナリブロックの見た目（向き × ON/OFF）だけを並べたパーミュテーション。
 *
 * **遅延の段数のような「見た目に効かないステート」は条件に書かない。**
 * 書くと段数のぶんだけエントリが増えるだけで、出てくる絵は同じものになる。
 * v1.30.0 まで可変ディレイリピーターは `wr:delay` まで条件に入れていて、
 * 8 段 × 4 向き × 2 = 64 エントリを、同じ絵のために持っていた。
 */
function directionalOnOff(texPrefix) {
  const permutations = [];
  for (const dir of CARDINALS) {
    for (const on of [false, true]) {
      permutations.push({
        condition:
          `q.block_state('minecraft:cardinal_direction') == '${dir}' && ` +
          `q.block_state('wr:on') == ${on}`,
        components: {
          "minecraft:transformation": { rotation: [0, Y_ROTATION[dir], 0] },
          ...topSide(on ? `${texPrefix}_top_on` : `${texPrefix}_top`, `${texPrefix}_side`),
          ...frontProducer(dir, on ? 15 : 0),
        },
      });
    }
  }
  return permutations;
}

function variableRepeater() {
  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:variable_repeater",
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_direction": {
            enabled_states: ["minecraft:cardinal_direction"],
            y_rotation_offset: 0,
          },
        },
        // 1 段 = 2 tick。16 段まで持てるので 2〜32 tick
        // （v1.30.0 で 8 段＝16 tick から広げた）。
        states: { "wr:delay": range(16, 1), "wr:on": [false, true] },
      },
      components: base("wr:variable_repeater", "tile.wr:variable_repeater.name", {
        ...topSide("wr_variable_repeater_top", "wr_variable_repeater_side"),
        "minecraft:placement_filter": { conditions: [{ allowed_faces: ["up"] }] },
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },

        "minecraft:movable": { movement_type: "popped" },
        ...tick(4),
        ...producerBase(),
        ...customComponent("wr:variable_repeater"),
      }),
      permutations: directionalOnOff("wr_variable_repeater"),
    },
  };
}

/**
 * C-7. 非対称ディレイリピーター。
 *
 * 可変ディレイリピーターは 1 つの遅延を立ち上がりにも立ち下がりにも使うので、
 * 「点くのは速く、消えるのはゆっくり」のような回路が組めなかった。
 * ここでは **ON になるときの遅延 (`wr:rise`) と OFF になるときの遅延 (`wr:fall`) を
 * 別々に**持つ。0 段にすればその向きだけ最速（1 tick）になる。
 *
 * 段数はどちらも 0〜15、1 段 = 2 tick なので 0〜30 tick。
 *
 * **2 つの遅延はブロックステートではなくワールド動的プロパティに持つ**
 * （`wr:asym|<座標>`、timing.js の `asymDelaysOf()`）。
 * どちらも見た目には効かないので条件式では一度も参照されず、
 * ステートに置くと `16 × 16 = 256 倍` が丸ごと状態数の予算に乗るだけだった
 * （v1.30.1 で外して 2,048 → 8。予算 65,536 に対して -2,040）。
 *
 * 「設定値は見た目に効かないから安い」という原則は **設定値が 1 つのときだけ** 成り立つ。
 * 2 つ以上あると掛け算になるので、その時点で動的プロパティ側が正しい。
 */
function asymRepeater() {
  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:asym_repeater",
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_direction": {
            enabled_states: ["minecraft:cardinal_direction"],
            y_rotation_offset: 0,
          },
        },
        // 遅延 2 本は動的プロパティ（上のコメント）。ここに戻すと予算が 256 倍になる
        states: {
          "wr:on": [false, true],
        },
      },
      components: base("wr:asym_repeater", "tile.wr:asym_repeater.name", {
        ...topSide("wr_asym_repeater_top", "wr_asym_repeater_side"),
        "minecraft:placement_filter": { conditions: [{ allowed_faces: ["up"] }] },
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        // 遅延は座標キーの動的プロパティ → immovable（理由はパルス生成機と同じ）。
        "minecraft:movable": { movement_type: "immovable" },
        ...tick(4),
        ...producerBase(),
        ...customComponent("wr:asym_repeater"),
      }),
      permutations: directionalOnOff("wr_asym_repeater"),
    },
  };
}

// ---------------------------------------------------------------------------
// D. 論理回路
// ---------------------------------------------------------------------------

/**
 * 出力が ON/OFF の 2 値しかない指向性ブロック（NOT/XOR/NAND/NOR/XNOR/閾値/
 * RSラッチ/Tフリップフロップ）の共通ひな型。
 * 見た目と出力は cardinal_direction と wr:on だけで決まるので、
 * 追加のステート（wr:level など）があってもパーミュテーションは 4 x 2 = 8 で足りる。
 */
function binaryDirectionalBlock(id, texPrefix, extraStates = {}, extraComponents = {}) {
  const permutations = [];
  for (const dir of CARDINALS) {
    for (const on of [false, true]) {
      permutations.push({
        condition:
          `q.block_state('minecraft:cardinal_direction') == '${dir}' && ` +
          `q.block_state('wr:on') == ${on}`,
        components: {
          "minecraft:transformation": { rotation: [0, Y_ROTATION[dir], 0] },
          ...topSide(on ? `${texPrefix}_top_on` : `${texPrefix}_top`, `${texPrefix}_side`),
          ...frontProducer(dir, on ? 15 : 0),
        },
      });
    }
  }

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: `wr:${id}`,
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_direction": {
            enabled_states: ["minecraft:cardinal_direction"],
            y_rotation_offset: 0,
          },
        },
        states: { "wr:on": [false, true], ...extraStates },
      },
      components: base(`wr:${id}`, `tile.wr:${id}.name`, {
        ...topSide(`${texPrefix}_top`, `${texPrefix}_side`),
        "minecraft:placement_filter": { conditions: [{ allowed_faces: ["up"] }] },
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        ...extraComponents,
        ...tick(4),
        ...producerBase(),
        ...customComponent(`wr:${id}`),
      }),
      permutations,
    },
  };
}

/**
 * 定数電源ブロック。入力を読まないので向きを持たず、全方向に出力する。
 * 右クリックで出力値を 0〜15 で巡回させる（sneak+右クリックで逆回り）。
 */
function constantSource() {
  const permutations = range(16).map((power) => ({
    condition: `q.block_state('wr:power') == ${power}`,
    components: {
      ...cube(power > 0 ? "wr_constant_on" : "wr_constant"),
      "minecraft:redstone_producer": {
        power,
        connected_faces: ALL_FACES,
        strongly_powered_face: "up",
      },
    },
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:constant",
        menu_category: MENU_REDSTONE,
        states: { "wr:power": range(16) },
      },
      components: base("wr:constant", "tile.wr:constant.name", {
        ...cube("wr_constant"),
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        ...producerBase(),
        ...customComponent("wr:constant"),
      }),
      permutations,
    },
  };
}

/**
 * チャンネル管理ブロック。
 * レッドストーンには一切関わらず、右クリックで管理UIを開くだけ。
 * 座標をキーにした記録も持たないのでピストンで動かされても問題ない。
 */
function channelHub() {
  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:channel_hub",
        menu_category: MENU_REDSTONE,
      },
      components: base("wr:channel_hub", "tile.wr:channel_hub.name", {
        ...topSide("wr_channel_hub_top", "wr_channel_hub_side"),
        // 普通の立方体としてワイヤーの支持面になれるよう導体扱いにする。
        "minecraft:redstone_conductivity": {
          redstone_conductor: true,
          allows_wire_to_step_down: true,
        },
        ...customComponent("wr:channel_hub"),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// E. 光源
// ---------------------------------------------------------------------------

/**
 * 明るさのパーミュテーション。
 * value 0 は base の light_emission 0 で足りるので 1 から作る。
 *
 * @param state 明るさを持つステート名
 */
function lightPermutations(state) {
  return range(15, 1).map((level) => ({
    condition: `q.block_state('${state}') == ${level}`,
    components: { "minecraft:light_emission": level },
  }));
}

/**
 * E-1. 調光レッドストーンランプ。
 *
 * 受けた電力の強さ（0〜15）をそのまま明るさにする。バニラのランプが ON/OFF の
 * 2 値しか持たないのに対して、可変リピーター・閾値・定数電源で作った
 * 「強さ」をそのまま光量として使える。染料で 16 色に染められる。
 *
 * 出力を持たないので redstone_consumer を付けられる（producer と同居できない）。
 * ただし wr: ブロックの出力はステート直読みでしか分からないため、
 * onRedstoneUpdate だけに頼らず minecraft:tick のポーリングも併用する。
 *
 * 現在の明るさを持つステートを **wr:power にしてはいけない**。
 * util.js の powerFrom() は wr: ブロックの wr:power を「出力」として読むので、
 * ランプが受電値をそのまま出力しているように見えてしまい、
 * 隣のワイヤーが自分で点けたランプから電力を読み返して消えなくなる。
 * 明るさは wr:light（出力ステートではない）に持たせること。
 */
function lamp() {
  const permutations = lightPermutations("wr:light");
  for (const [index, name] of WIRE_COLORS.entries()) {
    permutations.push({
      condition: `q.block_state('wr:color') == ${index} && q.block_state('wr:light') == 0`,
      components: cube(`wr_lamp_${name}`),
    });
    permutations.push({
      condition: `q.block_state('wr:color') == ${index} && q.block_state('wr:light') > 0`,
      components: cube(`wr_lamp_${name}_on`),
    });
  }

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:lamp",
        menu_category: MENU_REDSTONE,
        states: { "wr:light": range(16), "wr:color": range(16) },
      },
      components: base("wr:lamp", "tile.wr:lamp.name", {
        ...cube(`wr_lamp_${WIRE_COLORS[0]}`),
        "minecraft:light_emission": 0,
        // 普通の立方体としてワイヤーの支持面になれるよう導体扱いにする。
        "minecraft:redstone_conductivity": {
          redstone_conductor: true,
          allows_wire_to_step_down: true,
        },
        "minecraft:redstone_consumer": { min_power: 0, propagates_power: false },
        ...tick(4),
        ...customComponent("wr:lamp"),
      }),
      permutations,
    },
  };
}

/**
 * E-2. 発光建材ブロック。
 *
 * レッドストーンに一切関わらない建築用の光源。染料で 16 色、
 * 右クリックで明るさ 0〜15 を選べる（0 にすれば色つきの普通の建材になる）。
 * 設置直後の明るさは wr:glow_block の onPlace が 15 に揃える。
 */
function glowBlock() {
  const permutations = lightPermutations("wr:light");
  for (const [index, name] of WIRE_COLORS.entries()) {
    permutations.push({
      condition: `q.block_state('wr:color') == ${index}`,
      components: cube(`wr_glow_block_${name}`),
    });
  }

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:glow_block",
        menu_category: MENU_BUILD,
        states: { "wr:light": range(16), "wr:color": range(16) },
      },
      components: base("wr:glow_block", "tile.wr:glow_block.name", {
        ...cube(`wr_glow_block_${WIRE_COLORS[0]}`),
        "minecraft:light_emission": 0,
        "minecraft:redstone_conductivity": {
          redstone_conductor: true,
          allows_wire_to_step_down: true,
        },
        ...customComponent("wr:glow_block"),
      }),
      permutations,
    },
  };
}

/**
 * E-3. 隠し光源パネル。
 *
 * 6 面どこにでも貼れる 1px の板。ほぼ透明なので天井や壁の湧き潰しに使っても
 * 見た目を壊さない。向きの持ち方はワイヤーと同じ（block_face → 支持面）で、
 * ジオメトリ側に向きを焼き込んであるので transformation による回転は使わない。
 */
function lightPanel() {
  const permutations = lightPermutations("wr:light");
  for (const [blockFace, support] of Object.entries(SUPPORT_OF)) {
    permutations.push({
      condition: `q.block_state('minecraft:block_face') == '${blockFace}'`,
      components: {
        "minecraft:geometry": `geometry.wr_panel_${support}`,
        "minecraft:selection_box": selectionBox(support),
      },
    });
  }

  const material = {
    "minecraft:material_instances": {
      "*": {
        texture: "wr_light_panel",
        render_method: "alpha_test",
        face_dimming: false,
        // ambient_occlusion は bool ではなく数値（0 で無効）。
        ambient_occlusion: 0,
      },
    },
  };

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:light_panel",
        menu_category: MENU_BUILD,
        traits: {
          "minecraft:placement_position": {
            enabled_states: ["minecraft:block_face"],
          },
        },
        states: { "wr:light": range(16) },
      },
      components: base("wr:light_panel", "tile.wr:light_panel.name", {
        "minecraft:geometry": `geometry.wr_panel_${SUPPORT_OF.up}`,
        ...material,
        "minecraft:selection_box": selectionBox(SUPPORT_OF.up),
        "minecraft:collision_box": false,
        "minecraft:light_dampening": 0,
        "minecraft:light_emission": 0,
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        "minecraft:movable": { movement_type: "popped" },
        // 支持面の貼り直し（surface.js）を回すためのポーリング。
        // レッドストーンには関わらないので間隔は粗くてよい。
        ...tick(20),
        ...customComponent("wr:light_panel"),
      }),
      permutations,
    },
  };
}

// ---------------------------------------------------------------------------
// F. センサー・カウンター・表示
// ---------------------------------------------------------------------------

/**
 * F-1. エンティティセンサー。
 *
 * 半径内のエンティティ数を全方向に出力する。向きを持たないのは、
 * 「どちらを向いているか」に意味が無いうえに、
 * 向き 4 通りぶん状態数が増えるのが割に合わないため。
 *
 * tick は 20（1 秒）。getEntities() は範囲検索なので、
 * 他のブロックと同じ 4 tick で回すと並べたときの負荷が読めない。
 */
function entitySensor() {
  const permutations = range(16).map((power) => ({
    condition: `q.block_state('wr:power') == ${power}`,
    components: {
      ...topSide(power > 0 ? "wr_entity_sensor_top_on" : "wr_entity_sensor_top",
        "wr_entity_sensor_side"),
      "minecraft:redstone_producer": {
        power,
        connected_faces: ALL_FACES,
        strongly_powered_face: "up",
      },
    },
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:entity_sensor",
        menu_category: MENU_REDSTONE,
        states: {
          "wr:power": range(16),
          // 検知半径 1〜8 ブロック
          "wr:radius": range(8, 1),
          // 0=すべて 1=プレイヤー 2=モブ 3=アイテム（scripts/sensors.js と順番を合わせる）
          "wr:mode": range(4),
        },
      },
      components: base("wr:entity_sensor", "tile.wr:entity_sensor.name", {
        ...topSide("wr_entity_sensor_top", "wr_entity_sensor_side"),
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        // 指定プレイヤー名は座標キーの動的プロパティ → immovable。
        "minecraft:movable": { movement_type: "immovable" },
        ...tick(20),
        ...producerBase(),
        ...customComponent("wr:entity_sensor"),
      }),
      permutations,
    },
  };
}

/**
 * F-2. 時刻センサー。
 * バニラの日照センサーと違い「空が見えているか」は見ないので、地下でも効く。
 */
function daylightSensor() {
  const permutations = range(16).map((power) => ({
    condition: `q.block_state('wr:power') == ${power}`,
    components: {
      ...topSide(power > 0 ? "wr_daylight_sensor_top_on" : "wr_daylight_sensor_top",
        "wr_daylight_sensor_side"),
      "minecraft:redstone_producer": {
        power,
        connected_faces: ALL_FACES,
        strongly_powered_face: "up",
      },
    },
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:daylight_sensor",
        menu_category: MENU_REDSTONE,
        // wr:night は出力値の計算にしか効かないので、見た目のエントリは増えない
        states: { "wr:power": range(16), "wr:night": [false, true] },
      },
      components: base("wr:daylight_sensor", "tile.wr:daylight_sensor.name", {
        ...topSide("wr_daylight_sensor_top", "wr_daylight_sensor_side"),
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        ...tick(20),
        ...producerBase(),
        ...customComponent("wr:daylight_sensor"),
      }),
      permutations,
    },
  };
}

/**
 * F-3. 数値表示ブロック。
 *
 * 受電値を 16 進 1 桁で表示するだけで、電力は出さない。
 * 表示値のステートを **wr:power にしてはいけない**（powerFrom() が出力として
 * 読んでしまい、隣のワイヤーが電力を読み返して消えなくなる）。
 * 数字は全側面に出す。向きを気にせず置けるほうが実用的なため。
 */
function display() {
  const permutations = range(16).map((value) => ({
    condition: `q.block_state('wr:value') == ${value}`,
    components: {
      "minecraft:material_instances": {
        "*": { texture: `wr_display_${value.toString(16)}`, render_method: "opaque" },
        up: { texture: "wr_display_top", render_method: "opaque" },
        down: { texture: "wr_display_top", render_method: "opaque" },
      },
      "minecraft:light_emission": value > 0 ? 3 : 0,
    },
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:display",
        menu_category: MENU_REDSTONE,
        // wr:dec = 10 進 2 桁モード。見た目は wr:value だけで決まるので
        // パーミュテーションは 16 個のまま増えない。
        states: { "wr:value": range(16), "wr:dec": [false, true] },
      },
      components: base("wr:display", "tile.wr:display.name", {
        ...topSide("wr_display_top", "wr_display_0"),
        "minecraft:light_emission": 0,
        "minecraft:redstone_conductivity": {
          redstone_conductor: true,
          allows_wire_to_step_down: true,
        },
        "minecraft:redstone_consumer": { min_power: 0, propagates_power: false },
        ...tick(4),
        ...customComponent("wr:display"),
      }),
      permutations,
    },
  };
}

/**
 * F-4. カウンター。
 * 見た目は wr:power（現在のカウント）で決まる。wr:armed は見た目に効かないので
 * エントリは 4 向き × 16 値のまま。
 */
function counter() {
  const permutations = [];
  for (const dir of CARDINALS) {
    for (const power of range(16)) {
      permutations.push({
        condition:
          `q.block_state('minecraft:cardinal_direction') == '${dir}' && ` +
          `q.block_state('wr:power') == ${power}`,
        components: {
          "minecraft:transformation": { rotation: [0, Y_ROTATION[dir], 0] },
          ...topSide(power > 0 ? "wr_counter_top_on" : "wr_counter_top", "wr_counter_side"),
          ...frontProducer(dir, power),
        },
      });
    }
  }

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:counter",
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_direction": {
            enabled_states: ["minecraft:cardinal_direction"],
            y_rotation_offset: 0,
          },
        },
        states: { "wr:power": range(16), "wr:armed": [false, true] },
      },
      components: base("wr:counter", "tile.wr:counter.name", {
        ...topSide("wr_counter_top", "wr_counter_side"),
        "minecraft:placement_filter": { conditions: [{ allowed_faces: ["up"] }] },
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        ...tick(4),
        ...producerBase(),
        ...customComponent("wr:counter"),
      }),
      permutations,
    },
  };
}

/**
 * C-5. ワンショット。
 * 背面入力の立ち上がりで、決めた長さだけ前面に 15 を出す。
 * 長さ・残り時間はどちらもワールド動的プロパティに持つ（v1.31.2）。
 * リロードしても出しっぱなしにならない性質は変わらない（DPもステートと同じく永続化される）。
 */
function oneShot() {
  const permutations = [];
  for (const dir of CARDINALS) {
    for (const on of [false, true]) {
      permutations.push({
        condition:
          `q.block_state('minecraft:cardinal_direction') == '${dir}' && ` +
          `q.block_state('wr:on') == ${on}`,
        components: {
          "minecraft:transformation": { rotation: [0, Y_ROTATION[dir], 0] },
          ...topSide(on ? "wr_one_shot_top_on" : "wr_one_shot_top", "wr_one_shot_side"),
          ...frontProducer(dir, on ? 15 : 0),
        },
      });
    }
  }

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:one_shot",
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_direction": {
            enabled_states: ["minecraft:cardinal_direction"],
            y_rotation_offset: 0,
          },
        },
        states: {
          "wr:on": [false, true],
          // 立ち上がり待ちの印
          "wr:armed": [false, true],
        },
      },
      components: base("wr:one_shot", "tile.wr:one_shot.name", {
        ...topSide("wr_one_shot_top", "wr_one_shot_side"),
        "minecraft:placement_filter": { conditions: [{ allowed_faces: ["up"] }] },
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        // 長さ・残りは座標キーの動的プロパティ → immovable。
        "minecraft:movable": { movement_type: "immovable" },
        ...tick(4),
        ...producerBase(),
        ...customComponent("wr:one_shot"),
      }),
      permutations,
    },
  };
}

/**
 * C-8. クロックディバイダー。
 * 背面入力の立ち上がりを数え、divisor 回に 1 回だけ前面へパスする
 * （それ以外の回は入力が来ても 15 を出さない）。速い点滅を間引いて
 * 遅い点滅に変えるためのブロック（divisor 4 なら周期が 4 倍になる）。
 * divisor・カウンターはどちらもワールド動的プロパティに持つ（見た目に効かない
 * 設定値が 2 つになるため、非対称リピーター等と同じ理由）。
 */
function clockDivider() {
  const permutations = [];
  for (const dir of CARDINALS) {
    for (const on of [false, true]) {
      permutations.push({
        condition:
          `q.block_state('minecraft:cardinal_direction') == '${dir}' && ` +
          `q.block_state('wr:on') == ${on}`,
        components: {
          "minecraft:transformation": { rotation: [0, Y_ROTATION[dir], 0] },
          ...topSide(on ? "wr_clock_divider_top_on" : "wr_clock_divider_top", "wr_clock_divider_side"),
          ...frontProducer(dir, on ? 15 : 0),
        },
      });
    }
  }

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:clock_divider",
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_direction": {
            enabled_states: ["minecraft:cardinal_direction"],
            y_rotation_offset: 0,
          },
        },
        states: {
          "wr:on": [false, true],
          // 立ち上がり待ちの印（他の C パート同様、値そのものは動的プロパティ）
          "wr:armed": [false, true],
        },
      },
      components: base("wr:clock_divider", "tile.wr:clock_divider.name", {
        ...topSide("wr_clock_divider_top", "wr_clock_divider_side"),
        "minecraft:placement_filter": { conditions: [{ allowed_faces: ["up"] }] },
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        // divisor・カウンターは座標キーの動的プロパティ → immovable。
        "minecraft:movable": { movement_type: "immovable" },
        ...tick(4),
        ...producerBase(),
        ...customComponent("wr:clock_divider"),
      }),
      permutations,
    },
  };
}

/**
 * C-6. シーケンサー。
 * 出力先を北 → 東 → 南 → 西 と回す。**cardinal_direction 自体を書き換える**ので、
 * 見た目の矢印も一緒に回って今どこに出ているかが分かる。
 */
function sequencer() {
  const permutations = directionalOnOff("wr_sequencer");

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:sequencer",
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_direction": {
            enabled_states: ["minecraft:cardinal_direction"],
            y_rotation_offset: 0,
          },
        },
        states: {
          "wr:on": [false, true],
          // 1 段 = 4 tick（wr:slow なら 20 tick）
          "wr:period": range(15, 1),
          "wr:remain": range(16),
          // 粗いモード。**間隔の上限を広げるための唯一現実的な手**だった。
          // 残り時間 wr:remain は 0〜15 しか持てず（1 ステートに 16 値まで）、
          // その 16 値が上限を直接決めてしまう。段数を増やすと remain も
          // 増やすことになり、状態数が掛け算で爆発する。
          // 1 段あたりの重みを 5 倍にするフラグを 1 枚足すのが一番安い
          // （状態数は 2 倍で済み、上限は 60 → 300 tick になる）。
          "wr:slow": [false, true],
        },
      },
      components: base("wr:sequencer", "tile.wr:sequencer.name", {
        ...topSide("wr_sequencer_top", "wr_sequencer_side"),
        "minecraft:placement_filter": { conditions: [{ allowed_faces: ["up"] }] },
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        ...tick(4),
        ...producerBase(),
        ...customComponent("wr:sequencer"),
      }),
      permutations,
    },
  };
}

/**
 * F-4. 天候センサー。晴れ 0 / 雨 8 / 雷雨 15 を全方向に出す。
 * 反転フラグは時刻センサーと同じ `wr:night` を流用している（意味は「反転」）。
 */
function weatherSensor() {
  const permutations = range(16).map((power) => ({
    condition: `q.block_state('wr:power') == ${power}`,
    components: {
      ...topSide(power > 0 ? "wr_weather_sensor_top_on" : "wr_weather_sensor_top",
        "wr_weather_sensor_side"),
      "minecraft:redstone_producer": {
        power,
        connected_faces: ALL_FACES,
        strongly_powered_face: "up",
      },
    },
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:weather_sensor",
        menu_category: MENU_REDSTONE,
        states: { "wr:power": range(16), "wr:night": [false, true] },
      },
      components: base("wr:weather_sensor", "tile.wr:weather_sensor.name", {
        ...topSide("wr_weather_sensor_top", "wr_weather_sensor_side"),
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        ...tick(20),
        ...producerBase(),
        ...customComponent("wr:weather_sensor"),
      }),
      permutations,
    },
  };
}

/**
 * F-3. コンテナ計測器。
 * 隣接するチェスト等の中身を 0〜15 にして全方向へ出す。
 * 「指定アイテムの個数」モードの対象は座標キーの動的プロパティに持つので
 * ピストンで動かされると記録とずれる → immovable。
 */
function containerSensor() {
  const permutations = range(16).map((power) => ({
    condition: `q.block_state('wr:power') == ${power}`,
    components: {
      ...topSide(power > 0 ? "wr_container_sensor_top_on" : "wr_container_sensor_top",
        "wr_container_sensor_side"),
      "minecraft:redstone_producer": {
        power,
        connected_faces: ALL_FACES,
        strongly_powered_face: "up",
      },
    },
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:container_sensor",
        menu_category: MENU_REDSTONE,
        // 0=充填率 1=種類数 2=空きスロット 3=指定アイテム（scripts/sensors.js と順番を合わせる）
        states: { "wr:power": range(16), "wr:mode": range(4) },
      },
      components: base("wr:container_sensor", "tile.wr:container_sensor.name", {
        ...topSide("wr_container_sensor_top", "wr_container_sensor_side"),
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        "minecraft:movable": { movement_type: "immovable" },
        ...tick(20),
        ...producerBase(),
        ...customComponent("wr:container_sensor"),
      }),
      permutations,
    },
  };
}

/**
 * C-4. 時刻トリガー。
 * 指定時刻（または N 時間ごと）に 1 秒だけ全方向へ 15 を出す。
 * 設定はすべてステートなので、動かされても壊れない（movable の指定は不要）。
 */
function timer() {
  const permutations = [false, true].map((on) => ({
    condition: `q.block_state('wr:on') == ${on}`,
    components: {
      ...topSide(on ? "wr_timer_top_on" : "wr_timer_top", "wr_timer_side"),
      "minecraft:redstone_producer": {
        power: on ? 15 : 0,
        connected_faces: ALL_FACES,
        strongly_powered_face: "up",
      },
    },
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:timer",
        menu_category: MENU_REDSTONE,
        states: {
          "wr:on": [false, true],
          // 立ち上がり検出。同じ時間帯で何度も撃たないための印
          "wr:armed": [false, true],
          // false = その時刻ちょうど / true = N 時間ごと
          "wr:every": [false, true],
          // 0〜23 を十の位と一の位に分ける（1 ステートに 16 個までしか置けない）
          "wr:hour_tens": range(3),
          "wr:hour_ones": range(10),
        },
      },
      components: base("wr:timer", "tile.wr:timer.name", {
        ...topSide("wr_timer_top", "wr_timer_side"),
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },
        // 1 秒ごとに時刻を見る
        ...tick(20),
        ...producerBase(),
        ...customComponent("wr:timer"),
      }),
      permutations,
    },
  };
}

/**
 * H-3. アクセスログブロック。
 * レッドストーンには関わらず、右クリックで解錠・拒否の記録を見せるだけ。
 * 記録はワールド全体で 1 本なので、座標に紐づく情報は持たない。
 */
function accessLog() {
  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:access_log",
        menu_category: MENU_REDSTONE,
      },
      components: base("wr:access_log", "tile.wr:access_log.name", {
        ...topSide("wr_access_log_top", "wr_access_log_side"),
        "minecraft:redstone_conductivity": {
          redstone_conductor: true,
          allows_wire_to_step_down: true,
        },
        ...customComponent("wr:access_log"),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// H. 施錠
// ---------------------------------------------------------------------------

/**
 * H-1. 施錠ブロック。
 *
 * カードキーかパスワードで一定時間だけ全方向に 15 を出す。
 * 残り時間は wr:remain（秒）に持ち、tick(20) で 1 ずつ減らす
 * （リロードで開きっぱなしにならないようにするため。security_ui.js 参照）。
 *
 * 設定（鍵ID・パスワード）は座標をキーにしたワールド動的プロパティなので、
 * **ピストンで動かされると記録と実体がずれる**。送信機と同じく immovable にする。
 */
function lock() {
  const permutations = [false, true].map((on) => ({
    condition: `q.block_state('wr:on') == ${on}`,
    components: {
      ...topSide(on ? "wr_lock_top_on" : "wr_lock_top", "wr_lock_side"),
      "minecraft:redstone_producer": {
        power: on ? 15 : 0,
        connected_faces: ALL_FACES,
        strongly_powered_face: "up",
      },
    },
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:lock",
        menu_category: MENU_REDSTONE,
        states: {
          "wr:on": [false, true],
          // 残り時間（秒）。0 = 閉じている
          "wr:remain": range(16),
          // 開いている時間（秒）。見た目に影響しないのでエントリは増えない
          "wr:seconds": range(15, 1),
        },
      },
      components: base("wr:lock", "tile.wr:lock.name", {
        ...topSide("wr_lock_top", "wr_lock_side"),
        // 普通の立方体としてワイヤーの支持面になれるよう導体扱いにする。
        "minecraft:redstone_conductivity": {
          redstone_conductor: true,
          allows_wire_to_step_down: true,
        },
        "minecraft:movable": { movement_type: "immovable" },
        // 1 秒ごとに残り時間を減らす
        ...tick(20),
        ...producerBase(),
        ...customComponent("wr:lock"),
      }),
      permutations,
    },
  };
}

/**
 * H-2. カードキー発行機。
 * レッドストーンには関わらず、右クリックで管理UIを開くだけ（チャンネル管理と同じ）。
 * 記録はワールド全体で共有なので、座標に紐づく情報は持たない＝動かされても平気。
 */
function keyTerminal() {
  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:key_terminal",
        menu_category: MENU_REDSTONE,
      },
      components: base("wr:key_terminal", "tile.wr:key_terminal.name", {
        ...topSide("wr_key_terminal_top", "wr_key_terminal_side"),
        "minecraft:redstone_conductivity": {
          redstone_conductor: true,
          allows_wire_to_step_down: true,
        },
        ...customComponent("wr:key_terminal"),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// I. 加工
// ---------------------------------------------------------------------------

/**
 * I-1. 鉱石精錬機。
 * 上のチェストから吸って、下のチェストへ吐く。レッドストーン信号で停止する
 * （バニラのホッパーと同じ感覚）。出力は持たないので consumer を付けられる。
 * 変換先とためたポイントは座標キーの動的プロパティ → immovable。
 */
function oreRefiner() {
  const permutations = [false, true].map((on) => ({
    condition: `q.block_state('wr:busy') == ${on}`,
    components: topSide(
      on ? "wr_ore_refiner_top_on" : "wr_ore_refiner_top",
      "wr_ore_refiner_side"
    ),
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:ore_refiner",
        menu_category: MENU_REDSTONE,
        // wr:busy = 稼働中の見た目 / wr:disabled = レッドストーンで止められている。
        // **wr:on にしてはいけない**（powerFrom() が出力 15 として読んでしまう）。
        states: { "wr:busy": [false, true], "wr:disabled": [false, true] },
      },
      components: base("wr:ore_refiner", "tile.wr:ore_refiner.name", {
        ...topSide("wr_ore_refiner_top", "wr_ore_refiner_side"),
        "minecraft:redstone_conductivity": {
          redstone_conductor: true,
          allows_wire_to_step_down: true,
        },
        "minecraft:redstone_consumer": { min_power: 0, propagates_power: false },
        "minecraft:movable": { movement_type: "immovable" },
        ...tick(20),
        ...customComponent("wr:ore_refiner"),
      }),
      permutations,
    },
  };
}

/**
 * I-2. XPタンク。
 * たまっている量を 0〜15 で全方向に出す（満タン通知の配線が組める）。
 * 中身は座標キーの動的プロパティ → immovable。
 */
function xpTank() {
  const permutations = range(16).map((power) => ({
    condition: `q.block_state('wr:power') == ${power}`,
    components: {
      ...topSide(power > 0 ? "wr_xp_tank_top_on" : "wr_xp_tank_top", "wr_xp_tank_side"),
      "minecraft:redstone_producer": {
        power,
        connected_faces: ALL_FACES,
        strongly_powered_face: "up",
      },
      "minecraft:light_emission": power > 0 ? Math.min(7, power) : 0,
    },
  }));

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:xp_tank",
        menu_category: MENU_REDSTONE,
        states: { "wr:power": range(16) },
      },
      components: base("wr:xp_tank", "tile.wr:xp_tank.name", {
        ...topSide("wr_xp_tank_top", "wr_xp_tank_side"),
        "minecraft:light_emission": 0,
        "minecraft:redstone_conductivity": {
          redstone_conductor: true,
          allows_wire_to_step_down: true,
        },
        "minecraft:movable": { movement_type: "immovable" },
        ...tick(20),
        ...producerBase(),
        ...customComponent("wr:xp_tank"),
      }),
      permutations,
    },
  };
}

// ---------------------------------------------------------------------------
// J. 設置・排出・トラップ
// ---------------------------------------------------------------------------

/** レッドストーンで止まる機械の共通部分（出力は持たないので consumer を付けられる）。 */
function machineBase(id, texPrefix, extra = {}) {
  return base(`wr:${id}`, `tile.wr:${id}.name`, {
    ...topSide(`${texPrefix}_top`, `${texPrefix}_side`),
    "minecraft:redstone_conductivity": {
      redstone_conductor: true,
      allows_wire_to_step_down: true,
    },
    "minecraft:redstone_consumer": { min_power: 0, propagates_power: false },
    ...customComponent(`wr:${id}`),
    ...extra,
  });
}

/**
 * 稼働中かどうかで上面テクスチャだけ変えるパーミュテーション。
 *
 * ステート名は **wr:busy**。wr:on にすると util.js の powerFrom() が
 * 「このブロックは 15 を出している」と解釈して、隣のワイヤーが勝手に点く。
 */
function onOffTexture(texPrefix) {
  return [false, true].map((on) => ({
    condition: `q.block_state('wr:busy') == ${on}`,
    components: topSide(on ? `${texPrefix}_top_on` : `${texPrefix}_top`, `${texPrefix}_side`),
  }));
}

/**
 * J-1. ブロックディスペンサー。
 * 信号の立ち上がりごとに、上のチェストのブロックを前面へ 1 個置く。
 */
function blockDispenser() {
  const permutations = [];
  for (const dir of CARDINALS) {
    for (const on of [false, true]) {
      permutations.push({
        condition:
          `q.block_state('minecraft:cardinal_direction') == '${dir}' && ` +
          `q.block_state('wr:busy') == ${on}`,
        components: {
          "minecraft:transformation": { rotation: [0, Y_ROTATION[dir], 0] },
          ...topSide(
            on ? "wr_block_dispenser_top_on" : "wr_block_dispenser_top",
            "wr_block_dispenser_side"
          ),
        },
      });
    }
  }

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:block_dispenser",
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_direction": {
            enabled_states: ["minecraft:cardinal_direction"],
            y_rotation_offset: 0,
          },
        },
        states: {
          "wr:busy": [false, true],
          "wr:armed": [false, true],
          "wr:powered": [false, true],
        },
      },
      components: machineBase("block_dispenser", "wr_block_dispenser", tick(4)),
      permutations,
    },
  };
}

/**
 * J-2. ホッパードロッパー。
 * 上から下へ高速でアイテムを移す。下にコンテナが無ければ吐き出す。
 */
function hopperDropper() {
  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:hopper_dropper",
        menu_category: MENU_REDSTONE,
        states: { "wr:busy": [false, true], "wr:powered": [false, true] },
      },
      components: machineBase("hopper_dropper", "wr_hopper_dropper", tick(4)),
      permutations: onOffTexture("wr_hopper_dropper"),
    },
  };
}

/**
 * J-3. スパイク。
 * 真上のモブを刺す。倒すと経験値オーブを湧かせる（ブロック死では本来落ちないため）。
 * 加熱モード（wr:hot）では先に火をつけるので、バニラの仕組みで肉が焼ける。
 */
function spike() {
  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:spike",
        menu_category: MENU_REDSTONE,
        states: {
          "wr:busy": [false, true],
          "wr:hot": [false, true],
          "wr:powered": [false, true],
        },
      },
      components: machineBase("spike", "wr_spike", {
        // 上に乗ったモブを刺すので、判定はこまめに回す
        ...tick(10),
      }),
      // 加熱中かどうかも見た目に出す
      permutations: [
        ...onOffTexture("wr_spike"),
        {
          condition: "q.block_state('wr:hot') == true",
          components: topSide("wr_spike_top_hot", "wr_spike_side"),
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// G. 装飾建材
//
// レッドストーンにも明るさにも一切関わらない、置くだけのブロック。
// ステートも向きも持たないので、パーミュテーションは 0 個で済む。
// カスタムコンポーネントも要らない（validate.js はステートも
// レッドストーン系コンポーネントも持たないブロックを装飾扱いで見逃す）。
// ---------------------------------------------------------------------------

/**
 * K-1. ブロックブレイカー。
 * 信号の立ち上がりごとに、前面のブロックを 1 個壊して上のチェックへ入れる。
 * ブロックディスペンサーと同じ形（向き＋立ち上がり検出）。
 */
function blockBreaker() {
  const permutations = [];
  for (const dir of CARDINALS) {
    for (const on of [false, true]) {
      permutations.push({
        condition:
          `q.block_state('minecraft:cardinal_direction') == '${dir}' && ` +
          `q.block_state('wr:busy') == ${on}`,
        components: {
          "minecraft:transformation": { rotation: [0, Y_ROTATION[dir], 0] },
          ...topSide(
            on ? "wr_block_breaker_top_on" : "wr_block_breaker_top",
            "wr_block_breaker_side"
          ),
        },
      });
    }
  }

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:block_breaker",
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_direction": {
            enabled_states: ["minecraft:cardinal_direction"],
            y_rotation_offset: 0,
          },
        },
        states: {
          "wr:busy": [false, true],
          "wr:armed": [false, true],
          "wr:powered": [false, true],
        },
      },
      components: machineBase("block_breaker", "wr_block_breaker", tick(4)),
      permutations,
    },
  };
}

/**
 * K-2. サウンドブロック。
 * 信号の立ち上がりで、選んだ効果音を鳴らす。向きは持たない。
 * 音の種類は wr:sound（0〜15）で、右クリックで選ぶ。
 */
function soundBlock() {
  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: "wr:sound_block",
        menu_category: MENU_REDSTONE,
        // 出力を持たないので wr:on / wr:power は名乗らない（validate の 4c 参照）
        states: { "wr:sound": range(16), "wr:armed": [false, true] },
      },
      components: machineBase("sound_block", "wr_sound_block", tick(4)),
    },
  };
}

function decor(id, texture, { sides } = {}) {
  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: `wr:${id}`,
        menu_category: MENU_BUILD,
      },
      components: base(`wr:${id}`, `tile.wr:${id}.name`, {
        ...(sides ? topSide(sides.top, sides.side) : cube(texture)),
        // 建材なので普通の固体ブロックとして振る舞わせる。
        "minecraft:redstone_conductivity": {
          redstone_conductor: true,
          allows_wire_to_step_down: true,
        },
      }),
    },
  };
}

/**
 * アナログ 2 入力ブロックの共通ひな型。
 * 見た目と出力は cardinal_direction と wr:power だけで決まるので、
 * extraStates に何を足してもパーミュテーションは 4 x 16 のまま増えない。
 */
function analogGate(id, texPrefix, extraStates = {}) {
  const permutations = [];
  for (const dir of CARDINALS) {
    for (const power of range(16)) {
      permutations.push({
        condition:
          `q.block_state('minecraft:cardinal_direction') == '${dir}' && ` +
          `q.block_state('wr:power') == ${power}`,
        components: {
          "minecraft:transformation": { rotation: [0, Y_ROTATION[dir], 0] },
          ...topSide(
            power > 0 ? `${texPrefix}_top_on` : `${texPrefix}_top`,
            `${texPrefix}_side`
          ),
          ...frontProducer(dir, power),
        },
      });
    }
  }

  return {
    format_version: FORMAT,
    "minecraft:block": {
      description: {
        identifier: `wr:${id}`,
        menu_category: MENU_REDSTONE,
        traits: {
          "minecraft:placement_direction": {
            enabled_states: ["minecraft:cardinal_direction"],
            y_rotation_offset: 0,
          },
        },
        states: { "wr:power": range(16), ...extraStates },
      },
      components: base(`wr:${id}`, `tile.wr:${id}.name`, {
        ...topSide(`${texPrefix}_top`, `${texPrefix}_side`),
        "minecraft:placement_filter": { conditions: [{ allowed_faces: ["up"] }] },
        "minecraft:redstone_conductivity": {
          redstone_conductor: false,
          allows_wire_to_step_down: false,
        },

        ...tick(4),
        ...producerBase(),
        ...customComponent(`wr:${id}`),
      }),
      permutations,
    },
  };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// クリエイティブメニューのグループ宣言
// ---------------------------------------------------------------------------

/**
 * `item_catalog/crafting_item_catalog.json` を書き出す。
 *
 * **独自グループはここで宣言して初めて効く。** ブロック側の
 * `menu_category.group` だけでは黙って無視される（上の MENU_REDSTONE のコメント）。
 *
 * 中身は「今書いたブロック」＋「items/ にある手書きのアイテム」を走査して作るので、
 * ブロックを増やしても宣言漏れが起きない。並び順は
 *   ブロック … write() を呼んだ順（＝この生成器に書いてある論理的な順）
 *   アイテム … items/ の読み込み順のあとに続ける
 * とする。
 */
function writeCatalog() {
  const entries = [...WRITTEN];

  // 手書きのアイテム定義も同じグループに混ぜる
  for (const file of fs.readdirSync(ITEMS_DIR).sort()) {
    if (!file.endsWith(".json")) continue;
    const json = JSON.parse(fs.readFileSync(path.join(ITEMS_DIR, file), "utf8"));
    const description = json["minecraft:item"]?.description;
    if (!description) continue;
    entries.push({
      identifier: description.identifier,
      group: description.menu_category?.group,
      category: description.menu_category?.category,
    });
  }

  // カテゴリ → グループ → 識別子の一覧
  const byCategory = new Map();
  for (const entry of entries) {
    if (!entry.group) continue;
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, new Map());
    const groups = byCategory.get(entry.category);
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry.identifier);
  }

  const categories = [...byCategory].map(([category_name, groups]) => ({
    category_name,
    groups: [...groups].map(([name, items]) => ({
      group_identifier: { icon: GROUP_ICON[name] ?? items[0], name },
      items,
    })),
  }));

  const doc = {
    format_version: FORMAT,
    "minecraft:crafting_items_catalog": { categories },
  };

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  const out = path.join(CATALOG_DIR, "crafting_item_catalog.json");
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n", "utf8");

  const summary = categories
    .map((c) => c.groups.map((g) => `${c.category_name}/${g.items.length}`).join(" "))
    .join(" ");
  console.log(`wrote item_catalog/crafting_item_catalog.json (${summary})`);
}

function main() {
  fs.mkdirSync(BLOCKS_DIR, { recursive: true });
  write("transmitter", transmitter());
  write("receiver", receiver());
  write("wire", buildWireBlock());
  write("corner_riser", cornerRiser());
  write("pulse_generator", pulseGenerator());
  write("variable_repeater", variableRepeater());
  write("asym_repeater", asymRepeater());
  write("not_gate", binaryDirectionalBlock("not_gate", "wr_not_gate"));
  // 即時リピーター。反転しない NOT 回路（＝バッファ）なので同じひな型で足りる
  write("instant_repeater", binaryDirectionalBlock("instant_repeater", "wr_instant_repeater"));
  write("and_gate", analogGate("and_gate", "wr_and_gate"));
  write("or_gate", analogGate("or_gate", "wr_or_gate"));
  write("xor_gate", binaryDirectionalBlock("xor_gate", "wr_xor_gate"));
  write("nand_gate", binaryDirectionalBlock("nand_gate", "wr_nand_gate"));
  write("nor_gate", binaryDirectionalBlock("nor_gate", "wr_nor_gate"));
  write("xnor_gate", binaryDirectionalBlock("xnor_gate", "wr_xnor_gate"));
  // rise/fall(シュミットトリガー化、v1.31.2)は動的プロパティなので追加ステートなし
  // 閾値（rise/fall）は座標キーの動的プロパティ → immovable。
  write("threshold", binaryDirectionalBlock("threshold", "wr_threshold", {}, {
    "minecraft:movable": { movement_type: "immovable" },
  }));
  write("rs_latch", binaryDirectionalBlock("rs_latch", "wr_rs_latch"));
  // Tフリップフロップは「次の立ち上がりを待っているか」を wr:armed で持つ
  write("t_flipflop", binaryDirectionalBlock("t_flipflop", "wr_t_flipflop", {
    "wr:armed": [false, true],
  }));
  write("constant", constantSource());
  write("channel_hub", channelHub());
  write("lamp", lamp());
  write("glow_block", glowBlock());
  write("light_panel", lightPanel());
  // 算術回路。AND/OR と同じアナログ 2 入力ブロック
  write("adder", analogGate("adder", "wr_adder"));
  write("subtractor", analogGate("subtractor", "wr_subtractor"));
  write("counter", counter());
  write("display", display());
  write("entity_sensor", entitySensor());
  write("daylight_sensor", daylightSensor());
  write("container_sensor", containerSensor());
  write("timer", timer());
  write("one_shot", oneShot());
  write("clock_divider", clockDivider());
  write("sequencer", sequencer());
  write("randomizer", analogGate("randomizer", "wr_randomizer", { "wr:armed": [false, true], "wr:binary": [false, true] }));
  write("weather_sensor", weatherSensor());
  write("ore_refiner", oreRefiner());
  write("xp_tank", xpTank());
  write("block_dispenser", blockDispenser());
  write("hopper_dropper", hopperDropper());
  write("spike", spike());
  write("block_breaker", blockBreaker());
  // 比較ブロック。出力は 0/15 の二値なので binaryDirectionalBlock で足りる。
  // wr:mode = 0:「>」 1:「>=」 2:「=」
  write("compare", binaryDirectionalBlock("compare", "wr_compare", { "wr:mode": range(3) }));
  // レジスタ。副入力の立ち上がりで主入力を取り込み、その値を出し続ける
  write("register", analogGate("register", "wr_register", { "wr:armed": [false, true] }));
  write("sound_block", soundBlock());
  write("lock", lock());
  write("key_terminal", keyTerminal());
  write("access_log", accessLog());
  // 装飾建材
  write("circuit_board", decor("circuit_board", "wr_circuit_board"));
  write("cable_panel", decor("cable_panel", "wr_cable_panel"));
  write("polished_amethyst", decor("polished_amethyst", "wr_polished_amethyst"));
  write("machine_panel", decor("machine_panel", "wr_machine_panel"));
  write("hazard_stripe", decor("hazard_stripe", "wr_hazard_stripe"));
  // 最後に、今書いたブロックとアイテムからクリエイティブのグループ宣言を作る
  writeCatalog();
}

main();
