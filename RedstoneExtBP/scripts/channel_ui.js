/**
 * チャンネル選択UI
 *
 *   - リモコン: スニーク + 使用で開く。選択の実体は「手持ちのリモコンをリネームする」
 *   - 送信機 / 受信機: 素手で右クリックして開く。設置後でもチャンネルを変えられる
 *
 * 送信機・受信機のチャンネルは動的プロパティに座標キーで持っているので、
 * リモコンと違って**アイテム名に依存しない**。
 * 設置時にアンビルでリネームしておく方法はそのまま使えるが、
 * 置いたあとに気が変わってもここから変更できる。
 *
 * ---------------------------------------------------------------------------
 * カテゴリーとパスワード（v1.13.0〜）
 * ---------------------------------------------------------------------------
 *
 * チャンネルが増えると一枚の長いボタン列になって探せなくなるので、
 * **カテゴリー**でまとめられるようにした（作成は `wr:channel_hub`）。
 *
 * 一覧の見せ方は「デフォルト（未分類）のチャンネルは今までどおりそのまま並べ、
 * カテゴリーは同じ列にフォルダとして混ぜる」。
 * カテゴリーを 1 つも作っていなければ表示は以前と完全に同じで、
 * 使い始めた人にだけ画面が増える。
 *
 * パスワードが設定されたチャンネルは、解錠していないプレイヤーの一覧には出ない。
 * 解錠はこの画面の「🔒 パスワードを入力」から行い、
 * 記録はプレイヤー動的プロパティなので一度入れれば入れ直しは要らない。
 */

import { world, system, EquipmentSlot } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import {
  sanitizeChannel,
  listChannels,
  blockKey,
  setTransmitterChannel,
  setReceiverChannel,
  renameChannel,
} from "./channels.js";
import {
  DEFAULT_CATEGORY,
  listCategories,
  categoryOf,
  setChannelCategory,
  configuredChannels,
  isVisible,
  unlockByPassword,
} from "./directory.js";

function notify(player, channel) {
  player.onScreenDisplay.setActionBar({
    translate: "wr.msg.channel.set",
    with: [channel],
  });
}

/**
 * 一覧に出すチャンネル名。
 * 実際に使われているもの（送受信機・リモコン）に加えて、
 * 「カテゴリーやパスワードだけ先に設定したチャンネル」も含める。
 */
export function allChannels() {
  return [...new Set([...listChannels(), ...configuredChannels()])].sort();
}

/** 解錠していないチャンネルの名前は伏せる。 */
export function displayName(player, channel) {
  return isVisible(player, channel) ? channel : "???";
}

/**
 * インベントリにあるリモコンの名前を付け替える。
 *
 * リモコンはアイテム名がチャンネルIDそのものなので、
 * チャンネル名を変えるときはアイテム側も一緒に直さないと取り残される。
 * オンラインのプレイヤー全員ぶんを見る（人数は多くないので十分速い）。
 */
function renameRemotesInInventories(from, to) {
  let count = 0;
  for (const player of world.getAllPlayers()) {
    let container;
    try {
      container = player.getComponent("minecraft:inventory")?.container;
    } catch {
      continue;
    }
    if (!container) continue;
    for (let slot = 0; slot < container.size; slot += 1) {
      let item;
      try {
        item = container.getItem(slot);
      } catch {
        continue;
      }
      if (item?.typeId !== "wr:remote" || item.nameTag !== from) continue;
      item.nameTag = to;
      container.setItem(slot, item);
      count += 1;
    }
  }
  return count;
}

/**
 * チャンネル名の一括変更フォーム。
 * 伏せられているチャンネルは選べない（名前が読めてしまうため）。
 */
export function openRenameForm(player) {
  const channels = allChannels().filter((c) => isVisible(player, c));
  if (channels.length === 0) return;

  const form = new ModalFormData()
    .title({ translate: "wr.ui.rename.title" })
    .dropdown({ translate: "wr.ui.rename.target" }, channels, { defaultValueIndex: 0 })
    .textField({ translate: "wr.ui.rename.label" }, "BETA");

  form.show(player).then((res) => {
    if (res.canceled) return;
    const from = channels[Number(res.formValues?.[0]) || 0];
    const to = sanitizeChannel(res.formValues?.[1]);
    if (!from || from === to) return;

    // カテゴリー・パスワード・解錠の付け替えは channels.js の renameChannel が行う
    const moved = renameChannel(from, to);
    const remotes = renameRemotesInInventories(from, to);
    player.onScreenDisplay.setActionBar({
      translate: "wr.msg.channel.renamed",
      with: [from, to, String(moved.transmitters), String(moved.receivers), String(remotes)],
    });
  });
}

/** パスワード入力フォーム。一致したチャンネルをまとめて解錠する。 */
function openUnlockForm(player, reopen) {
  const form = new ModalFormData()
    .title({ translate: "wr.ui.unlock.title" })
    .textField({ translate: "wr.ui.unlock.label" }, "");

  form.show(player).then((res) => {
    if (res.canceled) return;
    const opened = unlockByPassword(player, String(res.formValues?.[0] ?? ""));
    if (opened.length > 0) {
      player.onScreenDisplay.setActionBar({
        translate: "wr.msg.unlock.ok",
        with: [String(opened.length), opened.join(", ")],
      });
      if (reopen) reopen();
    } else {
      player.onScreenDisplay.setActionBar({ translate: "wr.msg.unlock.ng" });
    }
  });
}

/** 新しいチャンネル名を入力させる。カテゴリー画面から呼ぶとそのカテゴリーに入る。 */
function openNewChannelForm(player, category, apply) {
  const form = new ModalFormData()
    .title({ translate: "wr.ui.channel.new.title" })
    .textField({ translate: "wr.ui.channel.new.label" }, "ALPHA");

  form.show(player).then((res) => {
    if (res.canceled) return;
    const channel = sanitizeChannel(res.formValues?.[0]);
    if (category !== DEFAULT_CATEGORY) setChannelCategory(channel, category);
    apply(channel);
  });
}

/**
 * チャンネル一覧のフォームを出して、選ばれたチャンネルを apply に渡す。
 *
 * ボタンの並びとその動作は `entries` に組み立ててから一括で描く。
 * 「一覧の n 番目より後ろは新規入力」のような添字計算を書くと、
 * 項目を足すたびに壊れるため。
 *
 * @param {string} titleKey  翻訳キー（リモコン用とブロック用で出し分ける）
 * @param {string} category  表示中のカテゴリー。DEFAULT_CATEGORY なら一枚目
 */
function showChannelList(player, currentChannel, titleKey, apply, category) {
  const top = category === DEFAULT_CATEGORY;
  const visible = allChannels().filter((c) => isVisible(player, c));
  const here = visible.filter((c) => categoryOf(c) === category);

  // 一枚目では現在のチャンネルを先頭に固定して見つけやすくする。
  // 伏せられている場合は出さない（名前が読めてしまうため）。
  const channels =
    top && isVisible(player, currentChannel)
      ? [currentChannel, ...here.filter((c) => c !== currentChannel)]
      : here;

  const entries = [];
  for (const channel of channels) {
    entries.push({ label: channel, run: () => apply(channel) });
  }

  if (top) {
    // カテゴリーは同じ列にフォルダとして混ぜる
    for (const name of listCategories()) {
      const count = visible.filter((c) => categoryOf(c) === name).length;
      entries.push({
        label: { translate: "wr.ui.category.entry", with: [name, String(count)] },
        run: () => showChannelList(player, currentChannel, titleKey, apply, name),
      });
    }
  }

  entries.push({
    label: { translate: "wr.ui.channel.new" },
    run: () => openNewChannelForm(player, category, apply),
  });

  if (top) {
    entries.push({
      label: { translate: "wr.ui.channel.unlock" },
      run: () =>
        openUnlockForm(player, () =>
          showChannelList(player, currentChannel, titleKey, apply, category)
        ),
    });
    entries.push({
      label: { translate: "wr.ui.channel.rename" },
      run: () => openRenameForm(player),
    });
  } else {
    entries.push({
      label: { translate: "wr.ui.category.back" },
      run: () => showChannelList(player, currentChannel, titleKey, apply, DEFAULT_CATEGORY),
    });
  }

  const form = new ActionFormData().title({ translate: titleKey });
  form.body(
    top
      ? { translate: "wr.ui.channel.body", with: [displayName(player, currentChannel)] }
      : { translate: "wr.ui.category.body", with: [category] }
  );
  for (const entry of entries) form.button(entry.label);

  form.show(player).then((res) => {
    if (res.canceled) return;
    entries[res.selection ?? -1]?.run();
  });
}

function pickChannel(player, currentChannel, titleKey, apply) {
  showChannelList(player, currentChannel, titleKey, apply, DEFAULT_CATEGORY);
}

/**
 * フォームはイベントハンドラの中（読み取り専用コンテキスト）から直接開くと
 * 弾かれることがあるので、必ず次 tick に回してから開く。
 */
export function openLater(fn) {
  system.run(() => {
    try {
      fn();
    } catch (e) {
      console.warn(`[wr] channel picker failed: ${e}`);
    }
  });
}

// ---------------------------------------------------------------------------
// リモコン
// ---------------------------------------------------------------------------

/** 手持ちのリモコンの名前を書き換える。 */
function renameHeldRemote(player, channel) {
  try {
    const equippable = player.getComponent("minecraft:equippable");
    const item = equippable?.getEquipment(EquipmentSlot.Mainhand);
    if (!item || item.typeId !== "wr:remote") return false;
    item.nameTag = channel;
    equippable.setEquipment(EquipmentSlot.Mainhand, item);
    return true;
  } catch (e) {
    console.warn(`[wr] remote rename failed: ${e}`);
    return false;
  }
}

export function openRemoteChannelPicker(player, currentChannel) {
  openLater(() => {
    pickChannel(player, currentChannel, "wr.ui.remote.title", (channel) => {
      if (renameHeldRemote(player, channel)) notify(player, channel);
    });
  });
}

// ---------------------------------------------------------------------------
// 設置済みの送信機 / 受信機
// ---------------------------------------------------------------------------

/**
 * 設置済みブロックのチャンネルを変更する。
 *
 * 現在のチャンネルが伏せられている（＝パスワード付きで未解錠）場合でも
 * 画面自体は開く。名前は「???」と出るが、別のチャンネルへの変更はできる。
 * ブロックはその場に見えていて壊せてしまう以上、
 * ここで操作を止めても隠せるのは名前だけなので、名前だけを隠す。
 *
 * @param {"wr:transmitter"|"wr:receiver"} typeId  開いた時点のブロック種別
 */
export function openBlockChannelPicker(player, block, typeId, currentChannel) {
  const dimension = block.dimension;
  const location = { x: block.location.x, y: block.location.y, z: block.location.z };
  const key = blockKey(dimension.id, location);

  openLater(() => {
    pickChannel(player, currentChannel, "wr.ui.block.title", (channel) => {
      // フォームを開いてから決定するまでの間にブロックが壊されている可能性があるので、
      // 書き込む前に「まだ同じブロックがそこにあるか」を確かめる。
      let fresh;
      try {
        fresh = dimension.getBlock(location);
      } catch {
        return;
      }
      if (!fresh || fresh.typeId !== typeId) {
        player.onScreenDisplay.setActionBar({ translate: "wr.msg.channel.gone" });
        return;
      }

      if (typeId === "wr:transmitter") setTransmitterChannel(key, channel);
      else setReceiverChannel(key, channel);
      notify(player, channel);
    });
  });
}
