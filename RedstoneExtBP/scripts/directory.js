/**
 * チャンネルのカテゴリー分けとパスワード保護
 *
 * チャンネルが増えてくると選択UIが一枚の長いボタン列になって探せなくなるので、
 * **カテゴリー（フォルダ）**でまとめられるようにした。
 * さらに、他人に触られたくないチャンネルは**パスワードで隠せる**。
 *
 * プロパティのキー体系（ワールド動的プロパティ）:
 *   wr:cat|<category>   → 1        カテゴリーの存在（中身が空でも残す）
 *   wr:chcat|<channel>  → string   そのチャンネルが属するカテゴリー
 *   wr:chpw|<channel>   → string   パスワード（設定されていれば非表示チャンネル）
 *
 * 解錠の記憶は**プレイヤー動的プロパティ**に持つ:
 *   wr:unlock|<channel> → true
 *
 * ワールド側に「誰が解錠したか」を持つとプレイヤーが増えるほどキーが増える上、
 * プレイヤー動的プロパティは本人のセーブデータに乗るので、
 * 一度入れたパスワードがワールドをまたいで消えない（＝「基本ずっと表示」）。
 *
 * カテゴリー未設定のチャンネルは従来どおり一枚目にまとめて出す。
 * 表示名は「デフォルト」。
 */

import { world } from "@minecraft/server";

const CAT_PREFIX = "wr:cat|";
const CHCAT_PREFIX = "wr:chcat|";
const PW_PREFIX = "wr:chpw|";
const UNLOCK_PREFIX = "wr:unlock|";

/** カテゴリー未設定を表す値。UI では「デフォルト」と表示する。 */
export const DEFAULT_CATEGORY = "";

/** カテゴリー名の集合。 */
const categories = new Set();
/** channel → category */
const channelCategory = new Map();
/** channel → password */
const channelPassword = new Map();

/**
 * 名前の正規化。キーの区切り文字 `|` を潰して長さを抑える。
 * チャンネル名（sanitizeChannel）と違い、空文字はそのまま空で返す
 * （カテゴリーの空文字＝「デフォルト」という意味を持たせているため）。
 */
export function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[|\r\n\t]/g, "_").trim().slice(0, 24);
}

// ---- 起動時スキャン ---------------------------------------------------------

/** 動的プロパティを一度舐めてメモリ上のインデックスを作り直す。 */
export function rebuildDirectory() {
  categories.clear();
  channelCategory.clear();
  channelPassword.clear();

  for (const id of world.getDynamicPropertyIds()) {
    const value = world.getDynamicProperty(id);
    if (id.startsWith(CAT_PREFIX)) {
      categories.add(id.slice(CAT_PREFIX.length));
    } else if (id.startsWith(CHCAT_PREFIX)) {
      if (typeof value === "string" && value.length > 0) {
        channelCategory.set(id.slice(CHCAT_PREFIX.length), value);
        categories.add(value); // 取りこぼし防止（カテゴリー本体の記録が消えていても拾う）
      }
    } else if (id.startsWith(PW_PREFIX)) {
      if (typeof value === "string" && value.length > 0) {
        channelPassword.set(id.slice(PW_PREFIX.length), value);
      }
    }
  }
}

// ---- カテゴリー -------------------------------------------------------------

/** 定義済みカテゴリーの一覧（デフォルトは含まない）。 */
export function listCategories() {
  return [...categories].sort();
}

/** カテゴリーを作る。既にあれば何もしない。@returns 正規化後の名前（空なら作らない） */
export function createCategory(raw) {
  const name = sanitizeName(raw);
  if (name.length === 0 || categories.has(name)) return name;
  categories.add(name);
  world.setDynamicProperty(CAT_PREFIX + name, 1);
  return name;
}

/**
 * カテゴリーを消す。中のチャンネルは「デフォルト」に戻るだけで、
 * チャンネル自体もその設定（パスワード）も消えない。
 */
export function deleteCategory(name) {
  if (!categories.has(name)) return 0;
  categories.delete(name);
  world.setDynamicProperty(CAT_PREFIX + name, undefined);

  let moved = 0;
  for (const [channel, category] of [...channelCategory]) {
    if (category !== name) continue;
    channelCategory.delete(channel);
    world.setDynamicProperty(CHCAT_PREFIX + channel, undefined);
    moved += 1;
  }
  return moved;
}

/** カテゴリー名を変える。中のチャンネルの所属も付け替える。 */
export function renameCategory(from, to) {
  const next = sanitizeName(to);
  if (!categories.has(from) || next.length === 0 || from === next) return 0;

  categories.delete(from);
  world.setDynamicProperty(CAT_PREFIX + from, undefined);
  categories.add(next);
  world.setDynamicProperty(CAT_PREFIX + next, 1);

  let moved = 0;
  for (const [channel, category] of channelCategory) {
    if (category !== from) continue;
    channelCategory.set(channel, next);
    world.setDynamicProperty(CHCAT_PREFIX + channel, next);
    moved += 1;
  }
  return moved;
}

/** そのチャンネルのカテゴリー。未設定なら DEFAULT_CATEGORY（空文字）。 */
export function categoryOf(channel) {
  return channelCategory.get(channel) ?? DEFAULT_CATEGORY;
}

/**
 * チャンネルをカテゴリーへ移す。
 * category に空文字を渡すと「デフォルト」に戻る。
 * 存在しないカテゴリー名を渡した場合はその場で作る
 * （UI から選ばせる以外の経路でも破綻しないように）。
 */
export function setChannelCategory(channel, category) {
  const name = sanitizeName(category);
  if (name.length === 0) {
    if (!channelCategory.has(channel)) return;
    channelCategory.delete(channel);
    world.setDynamicProperty(CHCAT_PREFIX + channel, undefined);
    return;
  }
  createCategory(name);
  if (channelCategory.get(channel) === name) return;
  channelCategory.set(channel, name);
  world.setDynamicProperty(CHCAT_PREFIX + channel, name);
}

/**
 * 設定だけ存在しているチャンネル名（まだ送受信機もリモコンも無いもの）。
 *
 * カテゴリーやパスワードは「これから使うチャンネル」にも先に設定できるようにしたいので、
 * 実際に使われているチャンネルの一覧（channels.js の listChannels）と
 * ここを合わせて 1 つの一覧にする。
 */
export function configuredChannels() {
  return [...new Set([...channelCategory.keys(), ...channelPassword.keys()])];
}

// ---- パスワード -------------------------------------------------------------

/** パスワードを設定する。空文字を渡すと解除。 */
export function setPassword(channel, password) {
  const pw = typeof password === "string" ? password.trim().slice(0, 24) : "";
  if (pw.length === 0) {
    channelPassword.delete(channel);
    world.setDynamicProperty(PW_PREFIX + channel, undefined);
    return false;
  }
  channelPassword.set(channel, pw);
  world.setDynamicProperty(PW_PREFIX + channel, pw);
  return true;
}

/** そのチャンネルは隠されているか。 */
export function hasPassword(channel) {
  return channelPassword.has(channel);
}

// ---- 解錠（プレイヤーごと） -------------------------------------------------

function unlockKey(channel) {
  return UNLOCK_PREFIX + channel;
}

/** そのプレイヤーは解錠済みか。 */
export function isUnlocked(player, channel) {
  try {
    return player.getDynamicProperty(unlockKey(channel)) === true;
  } catch {
    return false;
  }
}

/** 解錠を記録する。プレイヤーのセーブデータに乗るので入れ直しは要らない。 */
export function unlock(player, channel) {
  try {
    player.setDynamicProperty(unlockKey(channel), true);
  } catch (e) {
    console.warn(`[wr] unlock failed: ${e}`);
  }
}

/** 解錠を取り消す（パスワードを変更したときに使う）。 */
export function relock(player, channel) {
  try {
    player.setDynamicProperty(unlockKey(channel), undefined);
  } catch {
    // 取り消せなくても実害は無い
  }
}

/**
 * 入力されたパスワードに一致するチャンネルをすべて解錠する。
 *
 * 「どのチャンネルのパスワードか」を選ばせずに済むようにしている。
 * 隠してあるチャンネルは一覧に出ないので、名前を選ばせようがないため。
 *
 * @returns {string[]} 新たに解錠されたチャンネル名
 */
export function unlockByPassword(player, password) {
  const pw = typeof password === "string" ? password.trim() : "";
  if (pw.length === 0) return [];
  const opened = [];
  for (const [channel, secret] of channelPassword) {
    if (secret !== pw) continue;
    if (isUnlocked(player, channel)) continue;
    unlock(player, channel);
    opened.push(channel);
  }
  return opened.sort();
}

/** そのプレイヤーに見せてよいチャンネルか。 */
export function isVisible(player, channel) {
  if (!hasPassword(channel)) return true;
  return isUnlocked(player, channel);
}

/** 一覧から見えないチャンネルを落とす。 */
export function visibleOnly(player, channels) {
  return channels.filter((channel) => isVisible(player, channel));
}

// ---- チャンネル名の変更への追従 ---------------------------------------------

/**
 * チャンネル名を変えたときに、カテゴリー・パスワード・解錠の記録も付け替える。
 *
 * オフラインのプレイヤーの解錠記録までは触れないので、
 * その人は次に開いたときにもう一度パスワードを入れることになる
 * （パスワード自体は引き継がれているので入れ直せば済む）。
 */
export function renameChannelMeta(from, to) {
  if (from === to) return;

  const category = channelCategory.get(from);
  if (category !== undefined) {
    channelCategory.delete(from);
    world.setDynamicProperty(CHCAT_PREFIX + from, undefined);
    channelCategory.set(to, category);
    world.setDynamicProperty(CHCAT_PREFIX + to, category);
  }

  const password = channelPassword.get(from);
  if (password !== undefined) {
    channelPassword.delete(from);
    world.setDynamicProperty(PW_PREFIX + from, undefined);
    channelPassword.set(to, password);
    world.setDynamicProperty(PW_PREFIX + to, password);

    for (const player of world.getAllPlayers()) {
      if (!isUnlocked(player, from)) continue;
      relock(player, from);
      unlock(player, to);
    }
  }
}
