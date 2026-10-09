/**
 * チャンネル管理ブロック（wr:channel_hub）のUI
 *
 * カテゴリーの作成・編集と、チャンネルの振り分け・パスワード設定をここに集約する。
 * 「作る・整理する」操作はチャンネル選択のたびに要るものではないので、
 * リモコンや送受信機の画面には出さず、専用ブロックに寄せている。
 *
 * 権限は持たせていない（このブロックをクラフトして置ける人は誰でも操作できる）。
 * ただし**伏せられているチャンネルはここにも出てこない**ので、
 * 解錠していないチャンネルのパスワードを勝手に変えることはできない。
 *
 * ドロップダウンの項目は翻訳キーではなく素の文字列にしている
 * （チャンネル名・カテゴリー名は元々ユーザーが付けた文字列で、
 *   翻訳できるのは「デフォルト」の 1 項目だけなので割に合わない）。
 */

import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { allChannels, openRenameForm, openLater } from "./channel_ui.js";
import {
  DEFAULT_CATEGORY,
  listCategories,
  createCategory,
  deleteCategory,
  renameCategory,
  categoryOf,
  setChannelCategory,
  setPassword,
  hasPassword,
  isVisible,
  unlock,
} from "./directory.js";

/** カテゴリー選択ドロップダウンの先頭に置く「未分類」。 */
const DEFAULT_LABEL = "— デフォルト —";

function visibleChannels(player) {
  return allChannels().filter((c) => isVisible(player, c));
}

function actionBar(player, translate, withValues) {
  player.onScreenDisplay.setActionBar(
    withValues ? { translate, with: withValues } : { translate }
  );
}

// ---- 個別のフォーム ---------------------------------------------------------

function openNewCategory(player, back) {
  const form = new ModalFormData()
    .title({ translate: "wr.ui.hub.newcat.title" })
    .textField({ translate: "wr.ui.hub.newcat.label" }, "拠点");

  form.show(player).then((res) => {
    if (res.canceled) return back();
    const name = createCategory(String(res.formValues?.[0] ?? ""));
    if (name.length > 0) actionBar(player, "wr.msg.category.created", [name]);
    back();
  });
}

function openMoveChannel(player, back) {
  const channels = visibleChannels(player);
  if (channels.length === 0) {
    actionBar(player, "wr.msg.category.nochannel");
    return back();
  }
  const categories = listCategories();
  const options = [DEFAULT_LABEL, ...categories];

  // 選んだチャンネルの現在のカテゴリーを既定値にしたいところだが、
  // ドロップダウンは開いた時点で固定なので既定値は先頭のままにしておく。
  const form = new ModalFormData()
    .title({ translate: "wr.ui.hub.move.title" })
    .dropdown({ translate: "wr.ui.hub.move.channel" }, channels, { defaultValueIndex: 0 })
    .dropdown({ translate: "wr.ui.hub.move.category" }, options, { defaultValueIndex: 0 });

  form.show(player).then((res) => {
    if (res.canceled) return back();
    const channel = channels[Number(res.formValues?.[0]) || 0];
    const index = Number(res.formValues?.[1]) || 0;
    const category = index === 0 ? DEFAULT_CATEGORY : categories[index - 1];
    if (!channel) return back();
    setChannelCategory(channel, category);
    actionBar(player, "wr.msg.category.moved", [
      channel,
      category.length > 0 ? category : DEFAULT_LABEL,
    ]);
    back();
  });
}

function openPassword(player, back) {
  const channels = visibleChannels(player);
  if (channels.length === 0) {
    actionBar(player, "wr.msg.category.nochannel");
    return back();
  }

  const form = new ModalFormData()
    .title({ translate: "wr.ui.hub.password.title" })
    .dropdown({ translate: "wr.ui.hub.password.channel" }, channels, { defaultValueIndex: 0 })
    .textField({ translate: "wr.ui.hub.password.label" }, "");

  form.show(player).then((res) => {
    if (res.canceled) return back();
    const channel = channels[Number(res.formValues?.[0]) || 0];
    if (!channel) return back();
    const set = setPassword(channel, String(res.formValues?.[1] ?? ""));
    // 設定した本人が締め出されないように、その場で解錠しておく。
    // 既に解錠している他のプレイヤーはそのまま（入れ直しは要らない）。
    if (set) unlock(player, channel);
    actionBar(player, set ? "wr.msg.password.set" : "wr.msg.password.cleared", [channel]);
    back();
  });
}

function openEditCategory(player, back) {
  const categories = listCategories();
  if (categories.length === 0) {
    actionBar(player, "wr.msg.category.none");
    return back();
  }

  const form = new ModalFormData()
    .title({ translate: "wr.ui.hub.editcat.title" })
    .dropdown({ translate: "wr.ui.hub.editcat.target" }, categories, { defaultValueIndex: 0 })
    .textField({ translate: "wr.ui.hub.editcat.label" }, "");

  form.show(player).then((res) => {
    if (res.canceled) return back();
    const from = categories[Number(res.formValues?.[0]) || 0];
    const to = String(res.formValues?.[1] ?? "").trim();
    if (!from) return back();

    if (to.length === 0) {
      // 空欄 = 削除。中のチャンネルはデフォルトに戻るだけで消えない。
      const moved = deleteCategory(from);
      actionBar(player, "wr.msg.category.deleted", [from, String(moved)]);
    } else {
      const moved = renameCategory(from, to);
      actionBar(player, "wr.msg.category.renamed", [from, to, String(moved)]);
    }
    back();
  });
}

/** 今の割り当てを一覧で見せるだけの画面。 */
function openOverview(player, back) {
  const channels = visibleChannels(player);
  const lines = [];

  const inDefault = channels.filter((c) => categoryOf(c) === DEFAULT_CATEGORY);
  lines.push(`§l${DEFAULT_LABEL}§r`);
  lines.push(inDefault.length > 0 ? formatChannels(inDefault) : "  §7(なし)§r");

  for (const category of listCategories()) {
    const inside = channels.filter((c) => categoryOf(c) === category);
    lines.push("");
    lines.push(`§l📁 ${category}§r`);
    lines.push(inside.length > 0 ? formatChannels(inside) : "  §7(なし)§r");
  }

  const form = new ActionFormData()
    .title({ translate: "wr.ui.hub.list.title" })
    .body(lines.join("\n"))
    .button({ translate: "wr.ui.category.back" });

  form.show(player).then(() => back());
}

function formatChannels(channels) {
  return channels.map((c) => `  ${hasPassword(c) ? "🔒 " : ""}${c}`).join("\n");
}

// ---- メニュー ---------------------------------------------------------------

function openMenu(player) {
  const channels = visibleChannels(player);
  const entries = [
    { label: { translate: "wr.ui.hub.newcat" }, run: () => openNewCategory(player, reopen) },
    { label: { translate: "wr.ui.hub.move" }, run: () => openMoveChannel(player, reopen) },
    { label: { translate: "wr.ui.hub.password" }, run: () => openPassword(player, reopen) },
    { label: { translate: "wr.ui.hub.editcat" }, run: () => openEditCategory(player, reopen) },
    { label: { translate: "wr.ui.channel.rename" }, run: () => openRenameForm(player) },
    { label: { translate: "wr.ui.hub.list" }, run: () => openOverview(player, reopen) },
  ];

  function reopen() {
    openMenu(player);
  }

  const form = new ActionFormData()
    .title({ translate: "wr.ui.hub.title" })
    .body({
      translate: "wr.ui.hub.body",
      with: [String(listCategories().length), String(channels.length)],
    });
  for (const entry of entries) form.button(entry.label);

  form.show(player).then((res) => {
    if (res.canceled) return;
    entries[res.selection ?? -1]?.run();
  });
}

export const channelHubComponent = {
  onPlayerInteract(e) {
    if (!e.player) return;
    openLater(() => openMenu(e.player));
  },
};
