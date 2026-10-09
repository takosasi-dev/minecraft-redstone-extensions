/**
 * 設定コピー機 (wr:config_tool)
 *
 *   設定を持つブロックを **右クリック**            … 設定をコピー
 *   設定を持つブロックを **スニーク + 右クリック** … コピーした設定を貼り付け
 *
 * ---------------------------------------------------------------------------
 * なぜ要るのか
 * ---------------------------------------------------------------------------
 * パルス周期・遅延・閾値・施錠の秒数・ワンショットの長さ…を
 * **1 個ずつスライダーで合わせるのが面倒**だった。
 * 同じ設定のブロックを並べたい場面（照明の同期、複数の扉）で特に効く。
 *
 * ---------------------------------------------------------------------------
 * 実装の方針
 * ---------------------------------------------------------------------------
 * **アイテム側ではなくブロック側で「何を持っているか」を見る。**
 * このアドオンでは染料でワイヤーを染めるのも同じ形にしてある。
 * アイテムの onUseOn とブロックの onPlayerInteract の両方が走ると
 * 「設定UIも開くしコピーもされる」という読めない挙動になるため、
 * ブロックの入口 1 つに寄せて、そこで分岐させる。
 *
 * **コピーできるのは同じ種類のブロックどうしだけ。**
 * ブロックごとに「設定とみなすステート」を明示的に並べてある（下の SETTINGS）。
 * 全ステートを丸ごと写すと、出力値や稼働中フラグまで持っていってしまう。
 *
 * コピーした内容はワールドの動的プロパティに 1 件だけ持つ。
 * プレイヤーごとに分けていないのは、
 * 「持ち替えたら消えた」より「誰かが上書きした」のほうが分かりやすいため。
 */

import { world } from "@minecraft/server";
import { applyStates } from "./propagation_helper.js";

export const CONFIG_TOOL_ID = "wr:config_tool";

/**
 * ブロック種別 → コピーする設定ステート。
 *
 * **ここに書いたものだけがコピーされる。**
 * 出力（wr:power / wr:on）・稼働中（wr:busy）・カウントダウン（wr:remain）・
 * 立ち上がり待ち（wr:armed）は「今の状態」であって設定ではないので入れない。
 */
const SETTINGS = {
  // wr:pulse_generator は周期を、wr:asym_repeater は遅延 2 本を、
  // wr:one_shot は長さを、wr:threshold は rise/fall 2 本を
  // 動的プロパティに持つので下の dpSettings 側
  "wr:variable_repeater": ["wr:delay"],
  "wr:constant": ["wr:power"], // 定数電源だけは出力値そのものが設定
  "wr:sequencer": ["wr:period", "wr:slow"],
  "wr:lock": ["wr:seconds"],
  "wr:timer": ["wr:hour_tens", "wr:hour_ones", "wr:every"],
  "wr:entity_sensor": ["wr:radius", "wr:mode"],
  "wr:container_sensor": ["wr:mode"],
  "wr:compare": ["wr:mode"],
  "wr:sound_block": ["wr:sound"],
  "wr:randomizer": ["wr:binary"],
  "wr:display": ["wr:dec"],
  "wr:spike": ["wr:hot"],
  "wr:lamp": ["wr:color"], // 明るさは電力で決まるので設定ではない
  "wr:glow_block": ["wr:light", "wr:color"],
  "wr:light_panel": ["wr:light"], // パネルは染色を持たない
};

/**
 * ブロックステートではなく**ワールド動的プロパティ**に設定を持つブロックの受け口。
 *
 * 見た目に効かない設定値が 2 つ以上あるブロックは、ステートに置くと掛け算で
 * 状態数の予算（65,536）を食うので動的プロパティへ逃がしている
 * （最初の例は `wr:asym_repeater` の ON 遅延 / OFF 遅延）。
 * コピー機から見ると読み書きの仕方が違うだけなので、
 * その 2 つだけを持ち主のモジュールから登録してもらう。
 *
 * クリップボードに入る形（`{ "wr:rise": 3, ... }`）はステート組と同じにしてあるので、
 * 保存形式は変わらず、古いクリップボードもそのまま読める。
 */
const dpSettings = new Map();

/**
 * @param typeId  ブロック種別
 * @param read    (block) => 値の組。設定が無ければ既定値を返すこと
 * @param write   (block, values) => void。知らないキーは黙って捨てること
 */
export function registerDpSettings(typeId, { read, write }) {
  dpSettings.set(typeId, { read, write });
}

/** そのブロックはコピーに対応しているか。 */
export function hasSettings(typeId) {
  return Object.prototype.hasOwnProperty.call(SETTINGS, typeId) || dpSettings.has(typeId);
}

const CLIP_KEY = "wr:clipboard";

function readClipboard() {
  const raw = world.getDynamicProperty(CLIP_KEY);
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.typeId === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** テスト・デバッグ用。 */
export function clipboardOf() {
  return readClipboard();
}

export function clearClipboard() {
  world.setDynamicProperty(CLIP_KEY, undefined);
}

function actionBar(player, translate, withValues) {
  try {
    player.onScreenDisplay.setActionBar(
      withValues ? { translate, with: withValues } : { translate }
    );
  } catch {
    /* 表示できなくても処理は続ける */
  }
}

/** 短い名前（"wr:threshold" → "threshold"）。メッセージ用。 */
const shortName = (typeId) => typeId.replace("wr:", "");

/**
 * 設定コピー機を持っているときの処理。
 *
 * @returns true なら処理した（呼び出し元は通常の右クリック処理をしないこと）
 */
export function tryConfigTool(block, player, heldTypeId) {
  if (heldTypeId !== CONFIG_TOOL_ID) return false;

  const typeId = block.typeId;
  const names = SETTINGS[typeId] ?? [];
  const dp = dpSettings.get(typeId);
  if (names.length === 0 && !dp) {
    actionBar(player, "wr.msg.config.unsupported");
    return true; // 対応外でも「持っている間は設定UIを開かない」を守る
  }

  if (!player.isSneaking) {
    // コピー
    const values = { ...(dp?.read(block) ?? {}) };
    const perm = block.permutation;
    for (const name of names) {
      const value = perm.getState(name);
      if (value !== undefined) values[name] = value;
    }
    world.setDynamicProperty(CLIP_KEY, JSON.stringify({ typeId, values }));
    actionBar(player, "wr.msg.config.copied", [shortName(typeId)]);
    return true;
  }

  // 貼り付け
  const clip = readClipboard();
  if (!clip) {
    actionBar(player, "wr.msg.config.empty");
    return true;
  }
  if (clip.typeId !== typeId) {
    // 種類が違うと、そもそも同じステートを持っていない
    actionBar(player, "wr.msg.config.mismatch", [shortName(clip.typeId), shortName(typeId)]);
    return true;
  }
  // 貼り付け側で **今の定義に存在するステートだけ**に絞る。
  // 古いワールドからのクリップボードや、改名したステートで落ちないように。
  const patch = {};
  for (const name of names) {
    if (clip.values?.[name] !== undefined) patch[name] = clip.values[name];
  }
  const wroteDp = dp ? dp.write(block, clip.values ?? {}) !== false : false;
  if (Object.keys(patch).length === 0 && !wroteDp) {
    actionBar(player, "wr.msg.config.empty");
    return true;
  }
  if (Object.keys(patch).length > 0) applyStates(block, patch);
  actionBar(player, "wr.msg.config.pasted", [shortName(typeId)]);
  return true;
}

/**
 * テスト用。対応しているブロックの一覧。
 *
 * 動的プロパティ組は他のモジュールから登録されるので、**定数にしてはいけない**
 * （このファイルが読まれた時点ではまだ空で、登録前の一覧が焼き付く）。
 */
export function configurableIds() {
  return [...new Set([...Object.keys(SETTINGS), ...dpSettings.keys()])];
}
