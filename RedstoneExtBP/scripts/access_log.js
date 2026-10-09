/**
 * アクセスログブロック (wr:access_log)
 *
 * 施錠ブロックの解錠・拒否を記録して、右クリックで読み返せるようにする。
 *
 * ---------------------------------------------------------------------------
 * なぜ要るのか
 * ---------------------------------------------------------------------------
 * カードキーを配れて失効もできるのに、**誰がいつ開けたかを知る手段が無かった**。
 * 鍵を配る仕組みは「後から辿れる」ことで初めて意味が出るので、その片割れ。
 *
 * ---------------------------------------------------------------------------
 * 記録の持ち方
 * ---------------------------------------------------------------------------
 * ワールド全体で 1 本のリングバッファ（`wr:log|0` 〜 `wr:log|LIMIT-1` と
 * 書き込み位置 `wr:logseq`）。ログブロックを何個置いても同じ内容が見える。
 *
 * **ブロックごとのログにはしていない**。施錠ブロックとログブロックを
 * 紐づける操作（どのロックのログを見るか選ぶ）が増えるわりに、
 * 実際に知りたいのは「誰が入ったか」で、場所は行に書けば足りるため。
 *
 * 1 件を 1 つの動的プロパティに入れているのは、まとめて 1 本の文字列にすると
 * 上限に当たったときに**全部消える**から。分けておけば古い行から順に
 * 上書きされるだけで済む。
 */

import { world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { formatClock } from "./util.js";
import { openLater } from "./channel_ui.js";

const LOG_PREFIX = "wr:log|";
const SEQ_KEY = "wr:logseq";

/** 残す件数。これを超えると古いものから上書きされる。 */
export const LOG_LIMIT = 50;

/** 1 画面に出す件数（新しい順）。 */
const SHOW_LIMIT = 30;

/**
 * 行の中の区切り。プレイヤー名や鍵IDに出てこない制御文字を使う。
 * `|` は blockKey が使っていて紛らわしく、`,` は鍵IDの区切りと衝突する。
 */
const FIELD = "";

function readSeq() {
  const value = world.getDynamicProperty(SEQ_KEY);
  return typeof value === "number" ? value : 0;
}

/**
 * 1 件記録する。
 *
 * @param result     "ok" = 解錠 / "ng" = 拒否
 * @param playerName 操作した人
 * @param detail     鍵IDや "password" など、何で開けようとしたか
 * @param location   施錠ブロックの座標
 */
export function recordAccess(result, playerName, detail, location) {
  let clock = "";
  try {
    clock = formatClock(world.getTimeOfDay?.() ?? 0);
  } catch {
    clock = "";
  }

  const seq = readSeq();
  const row = [
    result,
    String(playerName ?? "?"),
    String(detail ?? ""),
    `${location.x},${location.y},${location.z}`,
    clock,
  ].join(FIELD);

  try {
    world.setDynamicProperty(LOG_PREFIX + (seq % LOG_LIMIT), row);
    world.setDynamicProperty(SEQ_KEY, seq + 1);
  } catch (e) {
    // 記録できなくても解錠自体は続けたいので握り潰す
    console.warn(`[wr] access log failed: ${e}`);
  }
}

/** 新しい順に読み出す。 */
export function readAccessLog() {
  const seq = readSeq();
  const rows = [];
  for (let back = 1; back <= Math.min(seq, LOG_LIMIT); back += 1) {
    const value = world.getDynamicProperty(LOG_PREFIX + ((seq - back + LOG_LIMIT) % LOG_LIMIT));
    if (typeof value !== "string") continue;
    const [result, player, detail, position, clock] = value.split(FIELD);
    rows.push({ result, player, detail, position, clock });
  }
  return rows;
}

export function clearAccessLog() {
  for (let i = 0; i < LOG_LIMIT; i += 1) {
    world.setDynamicProperty(LOG_PREFIX + i, undefined);
  }
  world.setDynamicProperty(SEQ_KEY, undefined);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function formatRow(row) {
  const mark = row.result === "ok" ? "§a✔§r" : "§c✖§r";
  const detail = row.detail === "password" ? "パスワード" : row.detail;
  return `${mark} §7${row.clock}§r ${row.player} §e${detail}§r §8(${row.position})§r`;
}

function openLog(player) {
  const rows = readAccessLog();
  const body =
    rows.length === 0
      ? "§7(まだ記録がありません)§r"
      : rows.slice(0, SHOW_LIMIT).map(formatRow).join("\n");

  const form = new ActionFormData()
    .title({ translate: "wr.ui.log.title" })
    .body(body)
    .button({ translate: "wr.ui.log.clear" })
    .button({ translate: "wr.ui.category.back" });

  form.show(player).then((res) => {
    if (res.canceled) return;
    if (res.selection === 0) {
      clearAccessLog();
      player.onScreenDisplay.setActionBar({ translate: "wr.msg.log.cleared" });
    }
  });
}

export const accessLogComponent = {
  onPlayerInteract(e) {
    if (!e.player) return;
    openLater(() => openLog(e.player));
  },
};
