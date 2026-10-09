/**
 * パートH: 施錠（カードキー / パスワード）の永続化
 *
 *   wr:lock          … カードキーかパスワードで一定時間だけ電力を出すブロック
 *   wr:key_terminal  … カードキーを書き込む・失効させる管理ブロック
 *   wr:card_key      … 鍵IDを持つカード（アイテム）
 *
 * ---------------------------------------------------------------------------
 * 鍵IDの持たせ方
 * ---------------------------------------------------------------------------
 * カードキーは **アイテムの nameTag に鍵IDを持つ**。
 * ワイヤレスリモコンがチャンネル名を nameTag に持っているのと同じ作りで、
 * 「金床で名前を変えれば鍵になる」ことを利用者が推測できるのが利点。
 *
 * ただしそれだけだと **金床で名前を書き換えるだけで合鍵が作れてしまう**ので、
 * 発行済みの鍵IDをワールド側にも記録し、**発行された鍵IDでなければ開かない**
 * ようにしてある。失効させれば出回っているカードを無効化できる。
 *
 * ---------------------------------------------------------------------------
 * 動的プロパティ
 * ---------------------------------------------------------------------------
 *   wr:key|<鍵ID>          "1" = 有効 / "0" = 失効
 *   wr:lockkey|<blockKey>  そのロックが受け付ける鍵ID（空文字ならカードは不可）
 *   wr:lockpw|<blockKey>   そのロックのパスワード（空文字ならパスワードは不可）
 *
 * ロックの設定は座標をキーにしているので、ブロック側で
 * `movable: immovable` を指定してピストンで動かせないようにしてある
 * （動かされると記録と実体がずれるため。送信機と同じ扱い）。
 */

import { world } from "@minecraft/server";
import { blockKey } from "./util.js";
import { sanitizeName } from "./directory.js";

const KEY_PREFIX = "wr:key|";
const KEY_PW_PREFIX = "wr:keypw|";
const LOCK_KEY_PREFIX = "wr:lockkey|";
const LOCK_PW_PREFIX = "wr:lockpw|";

/** 1 つのロックが受け付けられる鍵IDの数。 */
export const MAX_LOCK_KEYS = 8;

/**
 * 鍵IDの正規化。
 *
 * ロックは受け付ける鍵IDを **カンマ区切りの 1 本の文字列**で持つので、
 * 鍵ID自体にカンマが入ると区切りが壊れる。
 * `sanitizeName` はカンマを通してしまうため、ここで潰しておく。
 * 発行時にも通すので、**カンマを含む鍵IDはそもそも存在しない**。
 */
export function sanitizeKeyId(raw) {
  return sanitizeName(String(raw ?? "").replace(/,/g, "_"));
}

function readProperty(id) {
  const value = world.getDynamicProperty(id);
  return typeof value === "string" ? value : undefined;
}

function writeProperty(id, value) {
  world.setDynamicProperty(id, value === undefined || value === "" ? undefined : value);
}

// ---------------------------------------------------------------------------
// 鍵の発行と失効
// ---------------------------------------------------------------------------

/** 発行済みの鍵ID一覧（失効しているものも含む）。 */
export function listKeys() {
  const keys = [];
  for (const id of world.getDynamicPropertyIds()) {
    if (!id.startsWith(KEY_PREFIX)) continue;
    keys.push(id.slice(KEY_PREFIX.length));
  }
  return keys.sort();
}

/** 鍵IDを発行する。既にあれば有効に戻す。@returns 正規化した鍵ID（空なら失敗） */
export function issueKey(rawId) {
  const id = sanitizeKeyId(rawId);
  if (id.length === 0) return "";
  writeProperty(KEY_PREFIX + id, "1");
  return id;
}

/** 失効させる／戻す。 */
export function setKeyRevoked(id, revoked) {
  if (readProperty(KEY_PREFIX + id) === undefined) return false;
  writeProperty(KEY_PREFIX + id, revoked ? "0" : "1");
  return true;
}

export function isKeyRevoked(id) {
  return readProperty(KEY_PREFIX + id) === "0";
}

/**
 * そのカードが本物か。
 * **発行記録が無い鍵IDは通さない**（金床で名前を変えただけの合鍵よけ）。
 */
export function isKeyValid(id) {
  return readProperty(KEY_PREFIX + id) === "1";
}

/** 発行されたことがあるか（失効中でも true）。 */
export function isKeyIssued(id) {
  return readProperty(KEY_PREFIX + id) !== undefined;
}

/** 発行記録ごと消す。出回っているカードは以後どのロックも開けなくなる。 */
export function deleteKey(id) {
  writeProperty(KEY_PREFIX + id, undefined);
  writeProperty(KEY_PW_PREFIX + id, undefined);
}

// ---------------------------------------------------------------------------
// 再発行パスワード
// ---------------------------------------------------------------------------
//
// **合鍵を刷れるのは発行機を触れる人全員**なので、それだけだと
// 管理者カードを誰でも増やせてしまう。鍵IDごとに再発行パスワードを持たせ、
// 設定されている鍵は正しいパスワードを入れないと再発行できないようにする。
//
// 新規発行のときに設定する。空文字なら誰でも再発行できる（従来どおり）。

/** その鍵の再発行パスワード。空文字なら制限なし。 */
export function keyPasswordOf(id) {
  return readProperty(KEY_PW_PREFIX + id) ?? "";
}

export function hasKeyPassword(id) {
  return keyPasswordOf(id).length > 0;
}

export function setKeyPassword(id, password) {
  const value = String(password ?? "").trim();
  writeProperty(KEY_PW_PREFIX + id, value);
  return value;
}

/** 再発行してよいか。未発行なら新規なので常に true。 */
export function canReissue(id, given) {
  if (!isKeyIssued(id)) return true;
  const want = keyPasswordOf(id);
  return want.length === 0 || String(given ?? "").trim() === want;
}

// ---------------------------------------------------------------------------
// ロックごとの設定
// ---------------------------------------------------------------------------

function lockId(block) {
  return blockKey(block.dimension.id, block.location);
}

/**
 * そのロックが受け付ける鍵IDの一覧。空配列ならカードキーでは開かない。
 *
 * 保存はカンマ区切りの 1 本の文字列。v1.21.0 では鍵ID 1 つだけだったが、
 * その値もそのまま 1 要素として読めるので、古いワールドでも壊れない。
 */
export function lockKeysOf(block) {
  const raw = readProperty(LOCK_KEY_PREFIX + lockId(block)) ?? "";
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** 表示・編集用に「A, B, C」の形にして返す。 */
export function lockKeyText(block) {
  return lockKeysOf(block).join(", ");
}

/** そのロックのパスワード。空文字ならパスワードでは開かない。 */
export function lockPasswordOf(block) {
  return readProperty(LOCK_PW_PREFIX + lockId(block)) ?? "";
}

/**
 * 受け付ける鍵IDを設定する。カンマ区切りで複数指定できる。
 * 重複は畳み、MAX_LOCK_KEYS 個で打ち切る。
 *
 * @returns 実際に保存した鍵IDの配列
 */
export function setLockKeys(block, raw) {
  const ids = [];
  for (const part of String(raw ?? "").split(",")) {
    const id = sanitizeKeyId(part);
    if (id.length === 0 || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_LOCK_KEYS) break;
  }
  writeProperty(LOCK_KEY_PREFIX + lockId(block), ids.join(","));
  return ids;
}

export function setLockPassword(block, password) {
  const value = String(password ?? "").trim();
  writeProperty(LOCK_PW_PREFIX + lockId(block), value);
  return value;
}

/**
 * 鍵IDを 1 件だけ足す／外す（カードをかざしての登録用）。
 *
 * 既に登録されていれば外す。登録されていなければ足す。
 * 「かざすたびに登録／解除が切り替わる」ので、設定画面を開かずに運用できる。
 *
 * @returns {{ added: boolean, full: boolean, keys: string[] }}
 *          full = 上限に達していて足せなかった
 */
export function toggleLockKey(block, rawId) {
  const id = sanitizeKeyId(rawId);
  const keys = lockKeysOf(block);
  if (id.length === 0) return { added: false, full: false, keys };

  const at = keys.indexOf(id);
  if (at >= 0) {
    keys.splice(at, 1);
    writeProperty(LOCK_KEY_PREFIX + lockId(block), keys.join(","));
    return { added: false, full: false, keys };
  }
  if (keys.length >= MAX_LOCK_KEYS) return { added: false, full: true, keys };

  keys.push(id);
  writeProperty(LOCK_KEY_PREFIX + lockId(block), keys.join(","));
  return { added: true, full: false, keys };
}

/** ブロックが壊れたときの後始末。記録を残しても害は無いが溜まるので消す。 */
export function clearLock(dimensionId, location) {
  const id = blockKey(dimensionId, location);
  writeProperty(LOCK_KEY_PREFIX + id, undefined);
  writeProperty(LOCK_PW_PREFIX + id, undefined);
}

/** 爆発で壊れた場合も同じ後始末をする。 */
export function registerSecurityEvents() {
  world.afterEvents.blockExplode?.subscribe((e) => {
    if (e.explodedBlockPermutation?.type?.id !== "wr:lock") return;
    clearLock(e.dimension.id, e.block.location);
  });
}
