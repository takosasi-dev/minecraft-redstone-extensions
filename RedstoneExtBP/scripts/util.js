/**
 * 共通ユーティリティ — 方位計算・ブロックキー・電力読み取り。
 *
 * 名前空間はすべて `wr:` で統一している（identifier・カスタムコンポーネント名・
 * 動的プロパティのプレフィックスすべて）。
 */

/** 全 6 面。 */
export const FACES = ["down", "up", "north", "south", "west", "east"];

/** 各面の反対側。 */
export const OPPOSITE = {
  down: "up",
  up: "down",
  north: "south",
  south: "north",
  west: "east",
  east: "west",
};

/** 面 → 相対座標。Minecraft の north は -Z、west は -X。 */
export const OFFSET = {
  down: { x: 0, y: -1, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  west: { x: -1, y: 0, z: 0 },
  east: { x: 1, y: 0, z: 0 },
};

/**
 * 「前面（出力方向）を向いて立ったときの右側面」。
 * 例: 前面が north なら右は east。設置方向を変えるだけで副入力の面が
 * 自動的に追従するよう、cardinal_direction からこの表で引く。
 */
export const RIGHT_OF = { north: "east", east: "south", south: "west", west: "north" };

/** ブロックを一意に指すキー（動的プロパティ・重複予約防止用 Set の両方で使う）。 */
export function blockKey(dimensionId, loc) {
  return `${dimensionId}|${loc.x}|${loc.y}|${loc.z}`;
}

/** blockKey() の逆変換。壊れたキーは undefined を返す。 */
export function parseBlockKey(key) {
  const parts = key.split("|");
  if (parts.length !== 4) return undefined;
  const [dimensionId, x, y, z] = parts;
  const loc = { x: Number(x), y: Number(y), z: Number(z) };
  if (!Number.isFinite(loc.x) || !Number.isFinite(loc.y) || !Number.isFinite(loc.z)) {
    return undefined;
  }
  return { dimensionId, location: loc };
}

// ---------------------------------------------------------------------------
// 隣接ブロックのキャッシュ（1 回の再計算のあいだだけ有効）
// ---------------------------------------------------------------------------
//
// 1 回の再計算の中で、**まったく同じ隣を何度も取り直していた**。
// ワイヤー 1 本ぶんの updateWire だけでも
//   ensureSupport → armStates → externalPower → 減衰ループ
// が独立に 6 面走査していて、同じ 6 個を 4 回 offset() していた。
// offset() は JS↔ネイティブの往復なので、これが tick 予算を食う。
// 実測: 静止した回路でも **ブロック 1 個あたり 62 回/ポーリング**。
//
// **キャッシュするのは Block ハンドルだけで、ステートは絶対に持たない。**
// Bedrock の Block は「その座標を指す生きたビュー」なので、
// ハンドルを使い回してもステート読み取りは常に最新になる。
// 逆にステートを覚えると、再計算の途中の setPermutation を見落として壊れる。
//
// 有効範囲を「1 回の同期的な再計算」に限っているので、
// その間に隣が別のブロックに変わることはありえない＝動作は変わらない。
// tick をまたぐキャッシュではないことが安全性の肝。

/** face → 0〜5。配列で持つと文字列キーを作らずに済む。 */
const FACE_INDEX = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };

/** 「まだ引いていない」を undefined（＝隣が無い）と区別するための番人。 */
const MISS = Symbol("miss");

/** 再計算スコープの中だけ Map<Block, Array(6)>。外では null。 */
let neighborCache = null;

// 隣ハンドルに加えて、そこから **導出した事実**（typeId・ステート）も覚える。
// 実測では typeId 41% / getState 24% / permutation 21% で、
// 合わせて全ネイティブ往復の 86% がこの再導出だった。
// 例: linked(a, b) は colorOf(a) を呼ぶが、6 面ループで毎回同じ a を読み直していた。
//
// **安全性は「書き込みが起きたら導出した事実を全部捨てる」という 1 本の規則だけで守る。**
// 部分的に無効化しようとすると必ず抜けが出るし、
// 静止した回路（＝ラグが問題になる場面）では書き込み自体が起きないので、
// 全捨てでも取りこぼす利得はほとんど無い。
// 隣ハンドルのほうは「その座標を指す生きたビュー」なので捨てなくてよい。
let factsCache = null;

/**
 * 隣接取得と導出結果をキャッシュしながら fn を実行する。
 * 入れ子で呼ばれたときは外側のスコープに任せる（勝手に破棄しない）。
 */
export function withNeighborCache(fn) {
  if (neighborCache) return fn();
  neighborCache = new Map();
  factsCache = new Map();
  try {
    return fn();
  } finally {
    neighborCache = null;
    factsCache = null;
  }
}

/**
 * ワールドを書き換えたときに呼ぶ。導出した事実をすべて捨てる。
 * **setPermutation / setType をするコードは必ずこれを呼ぶこと。**
 */
export function invalidateFacts() {
  if (factsCache) factsCache.clear();
}

/** テスト用。スコープ外に漏れていないかを確かめる。 */
export function neighborCacheActive() {
  return neighborCache !== null;
}

function factsOf(block) {
  let f = factsCache.get(block);
  if (f === undefined) {
    f = { typeId: MISS, states: undefined };
    factsCache.set(block, f);
  }
  return f;
}

/** block.typeId（スコープ内ではキャッシュする）。 */
export function typeIdOf(block) {
  if (!block) return undefined;
  if (factsCache === null) return block.typeId;
  const f = factsOf(block);
  if (f.typeId === MISS) f.typeId = block.typeId;
  return f.typeId;
}

/** ステート 1 つ（スコープ内ではキャッシュする）。 */
export function stateOf(block, name) {
  if (!block) return undefined;
  if (factsCache === null) return block.permutation.getState(name);
  const f = factsOf(block);
  if (f.states === undefined) f.states = new Map();
  else if (f.states.has(name)) return f.states.get(name);
  const value = block.permutation.getState(name);
  f.states.set(name, value);
  return value;
}

/** 隣接ブロック。ワールド外・未ロードチャンクでは undefined。 */
export function neighborBlock(block, face) {
  const index = FACE_INDEX[face];
  if (neighborCache === null || index === undefined) {
    try {
      return block.offset(OFFSET[face]);
    } catch {
      return undefined;
    }
  }

  let slots = neighborCache.get(block);
  if (slots === undefined) {
    slots = new Array(6).fill(MISS);
    neighborCache.set(block, slots);
  } else if (slots[index] !== MISS) {
    return slots[index];
  }

  let result;
  try {
    result = block.offset(OFFSET[face]);
  } catch {
    result = undefined;
  }
  slots[index] = result;
  return result;
}

/** wr: 名前空間のブロックか。 */
export function isOurs(block) {
  if (!block) return false;
  const id = typeIdOf(block);
  return typeof id === "string" && id.startsWith("wr:");
}

/**
 * 隣接ブロックからこのブロックに届いている電力を読む（仕様書 パートD の共通ヘルパー）。
 *
 * @param block      基準ブロック
 * @param face       block から見た隣接ブロックの方向
 * @param accept     省略可。隣接ブロックを受け取って false を返すと、その面からは
 *                   電力を受け取らない（染色ワイヤーの同色判定などに使う）
 *
 * - 隣が wr: 名前空間で `wr:power` ステートを持つ場合はその値。
 * - `wr:on`（ON/OFF 二値）しか持たない場合は ON=15 / OFF=0。
 * - どちらも持たない wr: ブロック（送信機）は出力を持たないので 0。
 * - wr: 以外は隣接ブロック自身の getRedstonePower()。
 *
 * さらに、隣が `minecraft:cardinal_direction` を持つ指向性ブロック
 * （論理回路・リピーター・パルス生成機）の場合は、その前面がこちらを
 * 向いているときだけ電力を受け取る。前面以外には出力していないので、
 * 横や背後から値を読んでしまわないようにするための判定。
 */
export function powerFrom(block, face, accept) {
  const nb = neighborBlock(block, face);
  if (!nb) return 0;
  if (accept && !accept(nb)) return 0;

  if (isOurs(nb)) {
    const front = stateOf(nb, "minecraft:cardinal_direction");
    if (typeof front === "string" && front !== OPPOSITE[face]) return 0;

    const power = stateOf(nb, "wr:power");
    if (typeof power === "number") return power;

    const on = stateOf(nb, "wr:on");
    if (typeof on === "boolean") return on ? 15 : 0;

    // 出力ステートを持たない wr: ブロック（= wr:transmitter）は電力を出さない。
    // ここで getRedstonePower() にフォールバックしてはいけない。
    // 送信機は redstone_consumer なので、こちらが与えた電力をそのまま返してくる。
    // それを入力として読むと、電源を切っても自分の電力を読み返し続けて
    // ワイヤーが永久に点いたままになる（実機で発生）。
    return 0;
  }

  try {
    return nb.getRedstonePower() ?? 0;
  } catch {
    return 0;
  }
}

/** 全 6 面から届いている電力の最大値。 */
export function maxIncomingPower(block, accept) {
  let best = 0;
  for (const face of FACES) {
    const p = powerFrom(block, face, accept);
    if (p > best) best = p;
  }
  return best;
}

// ---------------------------------------------------------------------------
// ワールド時刻
// ---------------------------------------------------------------------------
//
// getTimeOfDay() は 0〜23999 で、**0 が朝 6 時**（日の出）。
// 6000 が正午、18000 が真夜中。時計の見た目に直すには 6 時間ぶんずらす。

const DAY_LENGTH = 24000;

/** ワールド時刻 → 時（0〜23）。 */
export function worldHour(timeOfDay) {
  const time = ((timeOfDay % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH;
  return (Math.floor(time / 1000) + 6) % 24;
}

/** ワールド時刻 → "HH:MM"。ログの表示に使う。 */
export function formatClock(timeOfDay) {
  const time = ((timeOfDay % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH;
  const minute = Math.floor(((time % 1000) * 60) / 1000);
  return `${String(worldHour(time)).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 0〜15 に丸める。 */
export function clampPower(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(15, Math.trunc(value)));
}
