/**
 * ワイヤーの染色 16 色。
 *
 * この並び順は wr:color ステートの値そのもの。
 * `scripts/generate_wire_permutations.js` の WIRE_COLORS と
 * `tools/generate_textures.py` の WIRE_COLORS と **必ず同じ順番**にすること。
 * index 0 = red が既定色（クラフト直後・染色していない状態）。
 */
export const WIRE_COLORS = [
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

/** 染料アイテムの identifier → wr:color の値。 */
const DYE_TO_COLOR = new Map(
  WIRE_COLORS.map((name, index) => [`minecraft:${name}_dye`, index])
);
// イカスミも黒染料として扱う（バニラの羊の染色と同じ感覚で使えるように）
DYE_TO_COLOR.set("minecraft:ink_sac", WIRE_COLORS.indexOf("black"));

/** 染料アイテムなら wr:color の値、そうでなければ undefined。 */
export function colorFromDye(typeId) {
  if (typeof typeId !== "string") return undefined;
  return DYE_TO_COLOR.get(typeId);
}

/** wr:color → 表示用の翻訳キー。 */
export function colorNameKey(index) {
  const name = WIRE_COLORS[index] ?? WIRE_COLORS[0];
  return `wr.color.${name}`;
}
