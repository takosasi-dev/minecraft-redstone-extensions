/**
 * ワイヤレスチャンネルの記録（ワールド動的プロパティ）
 *
 * プロパティのキー体系（すべて `wr:` プレフィックス）:
 *   wr:ch:<channel>|tx|<dim>|<x>|<y>|<z>  → number  送信ブロックの出力値
 *   wr:ch:<channel>|remote                → number  リモコンのトグル値（0 / 15）
 *   wr:rx|<dim>|<x>|<y>|<z>               → string  受信ブロックのチャンネル
 *
 * 動的プロパティは永続層で、実際の集計は起動時に一度スキャンして作る
 * メモリ上のインデックス（下の 3 つの Map）で行う。
 * 毎回 getDynamicPropertyIds() を舐めると受信ブロックのポーリング
 * （4 tick ごと）がワールド全体のプロパティ数に比例して重くなるため。
 */

import { world } from "@minecraft/server";
import { blockKey, parseBlockKey } from "./util.js";
import { renameChannelMeta } from "./directory.js";

const TX_PREFIX = "wr:ch:";
const RX_PREFIX = "wr:rx|";
const TX_MARK = "|tx|";
const REMOTE_MARK = "|remote";

/** blockKey → { channel, power } */
const txIndex = new Map();
/** blockKey → channel */
const rxIndex = new Map();
/** channel → power */
const remoteIndex = new Map();

/**
 * チャンネルの値が変わったときに呼ばれる通知先（wireless.js が登録する）。
 *
 * 受信ブロックを 4 tick ごとのポーリングだけで更新すると、
 * 送信側が即座に反応していても最大 4 tick 遅れて点灯する。
 * 値が動いた瞬間に該当チャンネルだけ押し込めるようにしておく。
 */
let channelListener;

export function setChannelListener(fn) {
  channelListener = fn;
}

function notifyChannel(channel) {
  if (channelListener) channelListener(channel);
}

/**
 * チャンネル名の正規化。アンビルのリネームは任意文字列なので、
 * キーの区切り文字 `|` と空白を潰し、長さも抑える。
 */
export function sanitizeChannel(raw) {
  if (typeof raw !== "string") return "default";
  const cleaned = raw.replace(/[|\r\n\t]/g, "_").trim().slice(0, 24);
  return cleaned.length > 0 ? cleaned : "default";
}

function txKey(channel, key) {
  return `${TX_PREFIX}${channel}${TX_MARK}${key}`;
}

function remoteKey(channel) {
  return `${TX_PREFIX}${channel}${REMOTE_MARK}`;
}

// ---- 起動時スキャン ---------------------------------------------------------

/** 動的プロパティを一度だけ舐めてメモリ上のインデックスを作り直す。 */
export function rebuildIndex() {
  txIndex.clear();
  rxIndex.clear();
  remoteIndex.clear();

  for (const id of world.getDynamicPropertyIds()) {
    const value = world.getDynamicProperty(id);

    if (id.startsWith(RX_PREFIX)) {
      if (typeof value === "string") rxIndex.set(id.slice(RX_PREFIX.length), value);
      continue;
    }
    if (!id.startsWith(TX_PREFIX)) continue;
    if (typeof value !== "number") continue;

    const rest = id.slice(TX_PREFIX.length);
    const txAt = rest.indexOf(TX_MARK);
    if (txAt >= 0) {
      txIndex.set(rest.slice(txAt + TX_MARK.length), {
        channel: rest.slice(0, txAt),
        power: value,
      });
      continue;
    }
    if (rest.endsWith(REMOTE_MARK)) {
      remoteIndex.set(rest.slice(0, rest.length - REMOTE_MARK.length), value);
    }
  }
}

// ---- 送信ブロック -----------------------------------------------------------

export function getTransmitterChannel(key) {
  return txIndex.get(key)?.channel;
}

/** 送信ブロックのチャンネルを（再）登録する。出力値は据え置き。 */
export function setTransmitterChannel(key, channel) {
  const prev = txIndex.get(key);
  if (prev) {
    if (prev.channel === channel) return;
    world.setDynamicProperty(txKey(prev.channel, key), undefined);
    notifyChannel(prev.channel);
  }
  const power = prev?.power ?? 0;
  txIndex.set(key, { channel, power });
  world.setDynamicProperty(txKey(channel, key), power);
  notifyChannel(channel);
}

/** 送信ブロックの出力値を更新する。変化がなければ書き込まない。 */
export function setTransmitterPower(key, channel, power) {
  const prev = txIndex.get(key);
  if (prev && prev.channel === channel && prev.power === power) return;
  if (prev && prev.channel !== channel) {
    world.setDynamicProperty(txKey(prev.channel, key), undefined);
    notifyChannel(prev.channel);
  }
  txIndex.set(key, { channel, power });
  world.setDynamicProperty(txKey(channel, key), power);
  notifyChannel(channel);
}

/** 送信ブロックの記録を消す（破壊・爆発・整合性チェックの共通口）。 */
export function clearTransmitter(key) {
  const prev = txIndex.get(key);
  if (prev) {
    txIndex.delete(key);
    world.setDynamicProperty(txKey(prev.channel, key), undefined);
    notifyChannel(prev.channel);
    return;
  }
  // インデックスに無い場合の保険。実プロパティを走査して落とす。
  const suffix = `${TX_MARK}${key}`;
  for (const id of world.getDynamicPropertyIds()) {
    if (id.startsWith(TX_PREFIX) && id.endsWith(suffix)) {
      world.setDynamicProperty(id, undefined);
    }
  }
}

// ---- 受信ブロック -----------------------------------------------------------

export function getReceiverChannel(key) {
  return rxIndex.get(key);
}

export function setReceiverChannel(key, channel) {
  if (rxIndex.get(key) === channel) return;
  rxIndex.set(key, channel);
  world.setDynamicProperty(RX_PREFIX + key, channel);
  // 置いたばかりの受信ブロックにも、いま流れている値をすぐ届ける。
  // これが無いと「チャンネルの値が動くまで暗いまま」になり、
  // 同じチャンネルの 2 台目以降が反応しないように見える。
  notifyChannel(channel);
}

export function clearReceiver(key) {
  if (!rxIndex.has(key)) {
    world.setDynamicProperty(RX_PREFIX + key, undefined);
    return;
  }
  rxIndex.delete(key);
  world.setDynamicProperty(RX_PREFIX + key, undefined);
}

/** 登録済み受信ブロックの [key, channel] を列挙する。 */
export function receiverEntries() {
  return [...rxIndex.entries()];
}

// ---- リモコン ---------------------------------------------------------------

export function getRemote(channel) {
  return remoteIndex.get(channel) ?? 0;
}

export function setRemote(channel, power) {
  remoteIndex.set(channel, power);
  world.setDynamicProperty(remoteKey(channel), power);
  notifyChannel(channel);
}

/**
 * チャンネル名を一括で変更する。
 *
 * そのチャンネルを使っている送信ブロック・受信ブロック・リモコンの記録を
 * まとめて付け替える。既存のチャンネル名に変更した場合は「合流」になる
 * （リモコンの値は大きい方を残す）。
 *
 * 手持ち／インベントリのリモコンはアイテム名がチャンネルIDそのものなので、
 * ここでは扱わない（channel_ui.js 側でアイテムの名前も書き換える）。
 *
 * @returns {{transmitters: number, receivers: number, remote: boolean}}
 */
export function renameChannel(from, to) {
  const result = { transmitters: 0, receivers: 0, remote: false };
  if (from === to) return result;

  for (const [key, entry] of txIndex) {
    if (entry.channel !== from) continue;
    world.setDynamicProperty(txKey(from, key), undefined);
    entry.channel = to;
    world.setDynamicProperty(txKey(to, key), entry.power);
    result.transmitters += 1;
  }

  for (const [key, channel] of rxIndex) {
    if (channel !== from) continue;
    rxIndex.set(key, to);
    world.setDynamicProperty(RX_PREFIX + key, to);
    result.receivers += 1;
  }

  if (remoteIndex.has(from)) {
    const power = remoteIndex.get(from) ?? 0;
    remoteIndex.delete(from);
    world.setDynamicProperty(remoteKey(from), undefined);
    const merged = Math.max(power, remoteIndex.get(to) ?? 0);
    remoteIndex.set(to, merged);
    world.setDynamicProperty(remoteKey(to), merged);
    result.remote = true;
  }

  // カテゴリー・パスワード・解錠の記録も一緒に付け替える
  renameChannelMeta(from, to);

  // 旧チャンネルは電源が消えた扱い、新チャンネルは値が入った扱いで両方更新する
  notifyChannel(from);
  notifyChannel(to);
  return result;
}

/** これまでに使われたチャンネル名の一覧（送信・受信・リモコンの和集合）。 */
export function listChannels() {
  const set = new Set();
  for (const { channel } of txIndex.values()) set.add(channel);
  for (const channel of rxIndex.values()) set.add(channel);
  for (const channel of remoteIndex.keys()) set.add(channel);
  return [...set].sort();
}

// ---- 集計 -------------------------------------------------------------------

/**
 * チャンネルごとの最大値表を作る（送信ブロック + リモコン）。
 * 受信ブロックのポーリング 1 回につき 1 度だけ呼ぶ。
 * @returns {Map<string, number>}
 */
export function channelMaxima() {
  const out = new Map();
  for (const { channel, power } of txIndex.values()) {
    const cur = out.get(channel) ?? 0;
    if (power > cur) out.set(channel, power);
  }
  for (const [channel, power] of remoteIndex) {
    const cur = out.get(channel) ?? 0;
    if (power > cur) out.set(channel, power);
  }
  return out;
}

// ---- 整合性チェック（ピストン・その他の想定外移動への保険） -----------------

/**
 * 記録されている座標に本当に該当ブロックがあるかを確認し、無ければ記録を消す。
 * チャンクが未ロードの場合は「判定できない」ので触らない。
 *
 * `minecraft:movable: immovable` でピストン移動は禁止しているが、
 * それでも取りこぼしがあった場合に幽霊チャンネルが残り続けないようにする保険。
 */
export function reconcile() {
  for (const key of [...txIndex.keys()]) {
    if (blockLooksWrong(key, "wr:transmitter")) clearTransmitter(key);
  }
  for (const key of [...rxIndex.keys()]) {
    if (blockLooksWrong(key, "wr:receiver")) clearReceiver(key);
  }
}

function blockLooksWrong(key, typeId) {
  const parsed = parseBlockKey(key);
  if (!parsed) return true; // 壊れたキーは消してよい
  let block;
  try {
    const dim = world.getDimension(parsed.dimensionId);
    block = dim.getBlock(parsed.location);
  } catch {
    return false; // 次元が取れない＝判定不能
  }
  if (!block) return false; // 未ロードチャンク＝判定不能
  return block.typeId !== typeId;
}

/** blockKey をこのモジュール利用側にも見せておく（import 元を 1 つに揃えるため）。 */
export { blockKey };
