/**
 * 設定値を持つブロック共通の設定UI（スライダー1本のフォーム）
 *
 * パルス生成機・可変ディレイリピーター・閾値ブロック・定数電源はどれも
 * 「数値を 1 つ決めるだけ」なので、フォームの組み立てをここに寄せている。
 *
 * 操作の割り当ては 4 種類で統一:
 *   右クリック            … このフォームを開いて直接指定
 *   スニーク + 右クリック … +1（上限で最小値に戻る）の微調整
 *
 * 以前は右クリックで 1 ずつ巡回させていたが、
 * パルス生成機の 1〜50 のように範囲が広いと連打が必要で実用的でなかった。
 *
 * ---------------------------------------------------------------------------
 * UserBusy について
 * ---------------------------------------------------------------------------
 * 右クリックの処理中にフォームを開こうとすると、エンジンから
 * FormCancelationReason.UserBusy で即座に閉じられることがある。
 * 何も考えずに開き直すと、押しっぱなしのときに開閉を繰り返して
 * 「押しても反応しない」ように見える。そのため
 *   ・プレイヤーごとに同時に 1 枚だけ
 *   ・右クリック自体にもクールダウン
 *   ・UserBusy のときだけ数 tick 待って数回まで再試行
 * という作りにしてある。
 */

import { system } from "@minecraft/server";
import { ModalFormData, FormCancelationReason } from "@minecraft/server-ui";

/** 同じプレイヤーが連続でフォームを開けるようになるまでの間隔（tick）。 */
const REOPEN_COOLDOWN = 10;
/** UserBusy で弾かれたときの再試行の間隔と回数。 */
const RETRY_DELAY = 5;
const MAX_RETRIES = 4;

/** player.id → 次に開けるようになる tick */
const cooldownUntil = new Map();
/** いまフォームを開いているプレイヤー */
const showing = new Set();

function release(playerId) {
  showing.delete(playerId);
  cooldownUntil.set(playerId, system.currentTick + REOPEN_COOLDOWN);
}

function showWithRetry(player, form, attempt, onValues) {
  form.show(player).then((res) => {
    if (res.canceled) {
      // 右クリックの処理中は UserBusy で弾かれることがあるので少し待って開き直す
      if (res.cancelationReason === FormCancelationReason.UserBusy && attempt < MAX_RETRIES) {
        system.runTimeout(() => showWithRetry(player, form, attempt + 1, onValues), RETRY_DELAY);
        return;
      }
      release(player.id);
      return;
    }
    release(player.id);
    const values = (res.formValues ?? []).map(Number);
    if (values.every((v) => Number.isFinite(v))) onValues(values);
  });
}

/**
 * スライダーを何本か並べた設定フォームを開く。
 *
 * 1 本で足りる場合は下の openNumberSetting() を使うこと（こちらは
 * 非対称ディレイリピーターのように「独立した数値を 2 つ決める」ブロック用）。
 *
 * @param player  操作しているプレイヤー
 * @param block   対象ブロック（決定時に取り直して存在確認する）
 * @param options {titleKey, sliders: [{labelKey, min, max, step, value}], apply(freshBlock, values)}
 */
export function openNumberSettings(player, block, options) {
  const now = system.currentTick;
  if (showing.has(player.id)) return;
  if ((cooldownUntil.get(player.id) ?? 0) > now) return;
  showing.add(player.id);

  const dimension = block.dimension;
  const location = { x: block.location.x, y: block.location.y, z: block.location.z };
  const typeId = block.typeId;
  const { titleKey, sliders, apply } = options;

  // フォームはイベントハンドラの中（読み取り専用コンテキスト）から直接開けないので次 tick に回す
  system.run(() => {
    let form;
    try {
      form = new ModalFormData().title({ translate: titleKey });
      for (const { labelKey, min, max, step = 1, value } of sliders) {
        form = form.slider({ translate: labelKey }, min, max, {
          valueStep: step,
          defaultValue: Math.max(min, Math.min(max, value)),
        });
      }
    } catch (e) {
      console.warn(`[wr] settings form failed: ${e}`);
      release(player.id);
      return;
    }

    showWithRetry(player, form, 0, (chosen) => {
      // 開いている間に壊されている可能性があるので、書き込む前に取り直す
      let fresh;
      try {
        fresh = dimension.getBlock(location);
      } catch {
        return;
      }
      if (!fresh || fresh.typeId !== typeId) return;
      apply(fresh, chosen);
    });
  });
}

/**
 * スライダー 1 本の設定フォームを開く。
 *
 * @param player  操作しているプレイヤー
 * @param block   対象ブロック（決定時に取り直して存在確認する）
 * @param options {titleKey, labelKey, min, max, step, value, apply(freshBlock, value)}
 */
export function openNumberSetting(player, block, options) {
  const { titleKey, labelKey, min, max, step = 1, value, apply } = options;
  openNumberSettings(player, block, {
    titleKey,
    sliders: [{ labelKey, min, max, step, value }],
    apply: (fresh, values) => apply(fresh, values[0]),
  });
}

/** 値を 1 段上げて、上限を超えたら最小値に戻す（スニーク+右クリック用）。 */
export function stepValue(value, min, max, step = 1) {
  const next = value + step;
  return next > max ? min : next;
}
