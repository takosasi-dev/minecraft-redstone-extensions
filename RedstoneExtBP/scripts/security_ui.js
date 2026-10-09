/**
 * パートH: 施錠ブロックとカードキー発行機
 *
 *   wr:lock          カードキーかパスワードで一定時間だけ電力を出す
 *   wr:key_terminal  カードキーの書き込み・失効・一覧
 *   wr:card_key      鍵IDを持つカード（使うと自分の鍵IDと状態を表示）
 *
 * ---------------------------------------------------------------------------
 * 開いている時間の持ち方
 * ---------------------------------------------------------------------------
 * 残り時間を **ブロックステート `wr:remain`（秒）** に持ち、
 * `minecraft:tick`（20 tick = 1 秒）で 1 ずつ減らす。
 *
 * `system.runTimeout` で閉じる方式にしなかったのは、
 * **ワールドをリロードするとタイマーが消えて開きっぱなしになる**ため
 * （可変ディレイリピーターで既知の制約になっている）。
 * 施錠ブロックでそれが起きると鍵の意味が無くなるので、
 * リロードしても勝手に閉まる作りにしてある。
 *
 * ---------------------------------------------------------------------------
 * 操作
 * ---------------------------------------------------------------------------
 *   カードキーを持って右クリック … 鍵IDが一致し、失効していなければ開く
 *   素手など で右クリック        … パスワード入力
 *   スニーク + 右クリック        … 設定（鍵ID・パスワード・開いている時間）
 *
 * 権限は持たせていない（このアドオンの他のブロックと同じ方針）。
 * **設定を開ける＝実質的に鍵を持っているのと同じ**なので、
 * 守りたい場所ではロック本体を触れないところに埋めること。
 */

import { ItemStack } from "@minecraft/server";
import { ModalFormData, ActionFormData } from "@minecraft/server-ui";
import { clampPower } from "./util.js";
import { scheduleUpdate, applyStates, registerUpdater, scheduleNeighbors } from "./propagation_helper.js";
import { openLater } from "./channel_ui.js";
import { heldItem } from "./wire.js";
import { recordAccess } from "./access_log.js";
import {
  MAX_LOCK_KEYS,
  sanitizeKeyId,
  listKeys,
  issueKey,
  setKeyRevoked,
  isKeyRevoked,
  isKeyValid,
  isKeyIssued,
  deleteKey,
  hasKeyPassword,
  setKeyPassword,
  canReissue,
  lockKeysOf,
  lockKeyText,
  lockPasswordOf,
  setLockKeys,
  setLockPassword,
  toggleLockKey,
  clearLock,
} from "./security.js";

/** 開いている時間の既定値（秒）。 */
const DEFAULT_SECONDS = 5;
const MIN_SECONDS = 1;
const MAX_SECONDS = 15;

const CARD_KEY = "wr:card_key";

function actionBar(player, translate, withValues) {
  player.onScreenDisplay.setActionBar(
    withValues ? { translate, with: withValues } : { translate }
  );
}

function stateNumber(block, name, fallback) {
  const value = block.permutation.getState(name);
  return typeof value === "number" ? value : fallback;
}

// ---------------------------------------------------------------------------
// H-1. 施錠ブロック
// ---------------------------------------------------------------------------

/** 開ける。残り時間を設定値に戻して出力を入れる。 */
function openLock(block, player, detail) {
  const seconds = stateNumber(block, "wr:seconds", DEFAULT_SECONDS);
  applyStates(block, { "wr:remain": clampPower(seconds), "wr:on": true });
  scheduleNeighbors(block);
  recordAccess("ok", player?.name, detail, block.location);
  actionBar(player, "wr.msg.lock.opened", [String(seconds)]);
}

/** 開けられなかったことを記録して伝える。 */
function denyLock(block, player, messageKey, detail) {
  recordAccess("ng", player?.name, detail, block.location);
  actionBar(player, messageKey);
}

/**
 * 1 秒ごとに残り時間を減らす。0 になったら出力を切る。
 * リロードしても状態はステートに残っているので、そのまま続きから閉まる。
 */
function updateLock(block) {
  const remain = stateNumber(block, "wr:remain", 0);
  if (remain <= 0) {
    // 何かの拍子に on だけ残っていたら閉じる（整合性の保険）
    if (applyStates(block, { "wr:on": false })) scheduleNeighbors(block);
    return;
  }
  const next = remain - 1;
  applyStates(block, next > 0 ? { "wr:remain": next } : { "wr:remain": 0, "wr:on": false });
  if (next === 0) scheduleNeighbors(block);
}
registerUpdater("wr:lock", updateLock);

/** カードキーで開けようとする。@returns 処理したか */
function tryCardKey(block, player, item) {
  const id = String(item.nameTag ?? "").trim();
  // 1 つのロックに複数の鍵IDを登録できる（管理者用と職員用、など）
  const accepted = lockKeysOf(block);

  if (id.length === 0) {
    actionBar(player, "wr.msg.lock.blankcard");
    return true;
  }
  if (!accepted.includes(id)) {
    denyLock(block, player, "wr.msg.lock.denied", id);
    return true;
  }
  if (!isKeyValid(id)) {
    // 発行記録が無い（名前を変えただけの合鍵）か、失効させられている
    denyLock(
      block,
      player,
      isKeyRevoked(id) ? "wr.msg.lock.revoked" : "wr.msg.lock.unknown",
      id
    );
    return true;
  }
  openLock(block, player, id);
  return true;
}

/** スニーク + カードキーで、その鍵IDをロックに登録／解除する。 */
function registerCardOnLock(block, player, item) {
  const id = String(item.nameTag ?? "").trim();
  if (id.length === 0) {
    actionBar(player, "wr.msg.lock.blankcard");
    return;
  }

  const { added, full, keys } = toggleLockKey(block, id);
  if (full) {
    actionBar(player, "wr.msg.lock.keyfull", [String(MAX_LOCK_KEYS)]);
    return;
  }
  actionBar(player, added ? "wr.msg.lock.keyadded" : "wr.msg.lock.keyremoved", [
    id,
    String(keys.length),
  ]);
}

function openPasswordPrompt(player, block) {
  const dimension = block.dimension;
  const location = { ...block.location };

  const form = new ModalFormData()
    .title({ translate: "wr.ui.lock.title" })
    .textField({ translate: "wr.ui.lock.password" }, "");

  form.show(player).then((res) => {
    if (res.canceled) return;
    // 入力中に壊されている可能性があるので取り直す
    let fresh;
    try {
      fresh = dimension.getBlock(location);
    } catch {
      return;
    }
    if (!fresh || fresh.typeId !== "wr:lock") return;

    const want = lockPasswordOf(fresh);
    const given = String(res.formValues?.[0] ?? "").trim();
    if (want.length > 0 && given === want) openLock(fresh, player, "password");
    else denyLock(fresh, player, "wr.msg.lock.denied", "password");
  });
}

function openLockSettings(player, block) {
  const dimension = block.dimension;
  const location = { ...block.location };
  const seconds = stateNumber(block, "wr:seconds", DEFAULT_SECONDS);

  const form = new ModalFormData()
    .title({ translate: "wr.ui.lock.settings" })
    .textField({ translate: "wr.ui.lock.keyid" }, "GATE1, ADMIN", {
      defaultValue: lockKeyText(block),
    })
    .textField({ translate: "wr.ui.lock.setpw" }, "", { defaultValue: lockPasswordOf(block) })
    .slider({ translate: "wr.ui.lock.seconds" }, MIN_SECONDS, MAX_SECONDS, {
      valueStep: 1,
      defaultValue: seconds,
    });

  form.show(player).then((res) => {
    if (res.canceled) return;
    let fresh;
    try {
      fresh = dimension.getBlock(location);
    } catch {
      return;
    }
    if (!fresh || fresh.typeId !== "wr:lock") return;

    const keyIds = setLockKeys(fresh, String(res.formValues?.[0] ?? ""));
    const password = setLockPassword(fresh, String(res.formValues?.[1] ?? ""));
    const next = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Number(res.formValues?.[2]) || DEFAULT_SECONDS));
    applyStates(fresh, { "wr:seconds": next });

    // どちらも空だと誰にも開けられない。事故なので必ず伝える。
    if (keyIds.length === 0 && password.length === 0) {
      actionBar(player, "wr.msg.lock.noway");
      return;
    }
    actionBar(player, "wr.msg.lock.configured", [
      keyIds.length > 0 ? keyIds.join(", ") : "-",
      password.length > 0 ? "○" : "-",
      String(next),
    ]);
  });
}

export const lockComponent = {
  onTick(e) {
    scheduleUpdate(e.block, updateLock);
  },
  onPlayerDestroy(e) {
    clearLock(e.block.dimension.id, e.block.location);
  },
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;

    const item = heldItem(player);
    const block = e.block;

    if (player.isSneaking) {
      // カードを持ったままスニークすれば、**そのカードの鍵IDをその場で登録**する。
      // 設定画面を開いて鍵IDを打ち直さずに済ませるための近道。
      // もう一度かざせば外れる（登録／解除のトグル）。
      if (item?.typeId === CARD_KEY) {
        registerCardOnLock(block, player, item);
        return;
      }
      openLater(() => openLockSettings(player, block));
      return;
    }

    if (item?.typeId === CARD_KEY) {
      tryCardKey(block, player, item);
      return;
    }

    openLater(() => openPasswordPrompt(player, block));
  },
};

// ---------------------------------------------------------------------------
// H-2. カードキー発行機
// ---------------------------------------------------------------------------

/**
 * カードを 1 枚渡す。持ち物が満杯なら足元に落とす（黙って消さない）。
 * @returns 渡せたか
 */
function giveCard(player, id) {
  let card;
  try {
    card = new ItemStack(CARD_KEY, 1);
    card.nameTag = id;
  } catch (err) {
    console.warn(`[wr] card create failed: ${err}`);
    return false;
  }

  try {
    const container = player.getComponent("minecraft:inventory")?.container;
    const leftover = container?.addItem(card);
    if (!container) return false;
    if (leftover) {
      // 満杯だった。足元に落とす
      player.dimension.spawnItem(leftover, player.location);
    }
    return true;
  } catch (err) {
    console.warn(`[wr] card give failed: ${err}`);
    return false;
  }
}

/**
 * 新しい鍵IDを作ってカードを 1 枚受け取る。
 *
 * 既にある鍵IDは**ここでは受け付けない**（再発行メニューに誘導する）。
 * 同じ画面で「新規作成」と「合鍵の複製」を兼ねると、
 * 再発行パスワードの欄が「設定するのか入力するのか」曖昧になるため。
 */
function openIssueCard(player, back) {
  const form = new ModalFormData()
    .title({ translate: "wr.ui.key.write.title" })
    .textField({ translate: "wr.ui.key.write.label" }, "GATE1")
    .textField({ translate: "wr.ui.key.write.pw" }, "");

  form.show(player).then((res) => {
    if (res.canceled) return back();

    // issueKey() は既存IDを有効に戻してしまうので、**登録する前に**既存か調べる。
    const id = sanitizeKeyId(String(res.formValues?.[0] ?? ""));
    if (id.length === 0) {
      actionBar(player, "wr.msg.key.badname");
      return back();
    }
    if (isKeyIssued(id)) {
      actionBar(player, "wr.msg.key.exists", [id]);
      return back();
    }

    issueKey(id);
    setKeyPassword(id, String(res.formValues?.[1] ?? ""));
    if (!giveCard(player, id)) {
      actionBar(player, "wr.msg.key.givefail");
      return back();
    }
    actionBar(player, "wr.msg.key.written", [id]);
    back();
  });
}

/**
 * 発行済みの鍵から選んでカードを再発行する（合鍵の複製）。
 *
 * 鍵IDを打ち直さずに済むのが主目的。
 * 再発行パスワードが設定されている鍵は、正しく入れないと複製できない。
 */
function openReissueCard(player, back) {
  const keys = listKeys();
  if (keys.length === 0) {
    actionBar(player, "wr.msg.key.none");
    return back();
  }
  const labels = keys.map((id) => {
    const marks = `${hasKeyPassword(id) ? "🔑 " : ""}${isKeyRevoked(id) ? "（失効中）" : ""}`;
    return `${id} ${marks}`.trim();
  });

  const form = new ModalFormData()
    .title({ translate: "wr.ui.key.reissue.title" })
    .dropdown({ translate: "wr.ui.key.reissue.target" }, labels, { defaultValueIndex: 0 })
    .textField({ translate: "wr.ui.key.reissue.pw" }, "")
    .textField({ translate: "wr.ui.key.reissue.newpw" }, "");

  form.show(player).then((res) => {
    if (res.canceled) return back();
    const id = keys[Number(res.formValues?.[0]) || 0];
    if (!id) return back();

    if (!canReissue(id, res.formValues?.[1])) {
      actionBar(player, "wr.msg.key.wrongpw", [id]);
      return back();
    }
    // 認証を通ったときだけパスワードの掛け替えを許す
    const newPw = String(res.formValues?.[2] ?? "").trim();
    if (newPw.length > 0) setKeyPassword(id, newPw);

    if (!giveCard(player, id)) {
      actionBar(player, "wr.msg.key.givefail");
      return back();
    }
    actionBar(player, "wr.msg.key.reissued", [id]);
    back();
  });
}

function openRevokeKey(player, back) {
  const keys = listKeys();
  if (keys.length === 0) {
    actionBar(player, "wr.msg.key.none");
    return back();
  }
  const labels = keys.map((id) => (isKeyRevoked(id) ? `${id}（失効中）` : id));

  const form = new ModalFormData()
    .title({ translate: "wr.ui.key.revoke.title" })
    .dropdown({ translate: "wr.ui.key.revoke.target" }, labels, { defaultValueIndex: 0 })
    .dropdown({ translate: "wr.ui.key.revoke.action" }, ["失効させる", "有効に戻す", "記録ごと削除"], {
      defaultValueIndex: 0,
    });

  form.show(player).then((res) => {
    if (res.canceled) return back();
    const id = keys[Number(res.formValues?.[0]) || 0];
    const action = Number(res.formValues?.[1]) || 0;
    if (!id) return back();

    if (action === 2) {
      deleteKey(id);
      actionBar(player, "wr.msg.key.deleted", [id]);
    } else {
      setKeyRevoked(id, action === 0);
      actionBar(player, action === 0 ? "wr.msg.key.revoked" : "wr.msg.key.restored", [id]);
    }
    back();
  });
}

function openKeyList(player, back) {
  const keys = listKeys();
  const lines =
    keys.length === 0
      ? ["§7(まだ発行されていません)§r"]
      : keys.map((id) => {
          const mark = isKeyRevoked(id) ? `§c✖ ${id}§r` : `§a✔ ${id}§r`;
          // 🔑 = 再発行にパスワードが要る鍵
          return hasKeyPassword(id) ? `${mark} §e🔑§r` : mark;
        });

  const form = new ActionFormData()
    .title({ translate: "wr.ui.key.list.title" })
    .body(lines.join("\n"))
    .button({ translate: "wr.ui.category.back" });

  form.show(player).then(() => back());
}

function openTerminal(player) {
  const entries = [
    { label: { translate: "wr.ui.key.write" }, run: () => openIssueCard(player, reopen) },
    { label: { translate: "wr.ui.key.reissue" }, run: () => openReissueCard(player, reopen) },
    { label: { translate: "wr.ui.key.revoke" }, run: () => openRevokeKey(player, reopen) },
    { label: { translate: "wr.ui.key.list" }, run: () => openKeyList(player, reopen) },
  ];

  function reopen() {
    openTerminal(player);
  }

  const keys = listKeys();
  const form = new ActionFormData()
    .title({ translate: "wr.ui.key.title" })
    .body({
      translate: "wr.ui.key.body",
      with: [String(keys.length), String(keys.filter((id) => isKeyRevoked(id)).length)],
    });
  for (const entry of entries) form.button(entry.label);

  form.show(player).then((res) => {
    if (res.canceled) return;
    entries[res.selection ?? -1]?.run();
  });
}

export const keyTerminalComponent = {
  onPlayerInteract(e) {
    if (!e.player) return;
    openLater(() => openTerminal(e.player));
  },
};

// ---------------------------------------------------------------------------
// H-3. カードキー（アイテム）
// ---------------------------------------------------------------------------

export const cardKeyComponent = {
  /** 使うと自分の鍵IDと有効／失効を表示するだけ。 */
  onUse(e) {
    const player = e.source;
    if (!player) return;
    const id = String(e.itemStack?.nameTag ?? "").trim();
    if (id.length === 0) {
      actionBar(player, "wr.msg.key.blank");
      return;
    }
    if (isKeyValid(id)) actionBar(player, "wr.msg.key.valid", [id]);
    else actionBar(player, isKeyRevoked(id) ? "wr.msg.key.revoked" : "wr.msg.key.unknown", [id]);
  },
};
