/**
 * 開発者用のダンプコマンド。
 *
 *   /scriptevent wr:dump           … wr: の動的プロパティを全部出す
 *   /scriptevent wr:dump <channel> … そのチャンネルぶんだけ出す
 *   /scriptevent wr:inputs         … 視線の先のブロックの 6 面ぶんの入力を出す
 *   /scriptevent wr:wires          … 周囲にある薄板の貼りつき面を一覧で出す
 *   /scriptevent wr:wires <半径>   … 半径を指定（既定 5・最大 12）
 *   /scriptevent wr:version        … 読み込まれているスクリプトの版
 *   /scriptevent wr:load [半径]    … 周囲の wr: ブロック数を数える
 *   /scriptevent wr:profile        … 1 回目で計測開始、2 回目で ms/tick の実測結果
 *
 * dump は「爆発やピストンで壊した送信ブロックの記録がちゃんと消えているか」、
 * inputs は「切ったのに ON のままのとき、どの面から電力が回り込んでいるか」、
 * wires は「ワイヤーが狙った面に貼りついているか」の確認用。
 *
 * wires を足したのは、**ワイヤーは 1px の板で当たり判定が薄く、
 * inputs で狙うと後ろの壁に当たってしまう**ため。
 * 立っているだけで周囲のワイヤーを全部出せるようにしてある。
 *
 * 出力はコンテンツログと実行者のチャットの両方に出る。
 */

import { world, system } from "@minecraft/server";
import { startProfiling, stopProfiling, isProfiling } from "./propagation_helper.js";
import { FACES, OPPOSITE, neighborBlock, powerFrom, isOurs } from "./util.js";
import { ARM_WORLD, ARM_SLOTS } from "./wire_arms.js";
import { isThinPlate } from "./surface.js";

/**
 * `/scriptevent wr:inputs`
 *
 * 視線の先のブロックについて、6 面それぞれから何がどれだけ入力されているかを出す。
 * 「切ったのに ON のまま」のような症状で、どの面から電力が回り込んでいるのかを
 * 特定するための診断コマンド。
 */
function dumpInputs(player) {
  if (!player?.getBlockFromViewDirection) return;

  let hit;
  try {
    hit = player.getBlockFromViewDirection({
      maxDistance: 10,
      includePassableBlocks: true,
      includeLiquidBlocks: false,
    });
  } catch {
    hit = undefined;
  }
  if (!hit?.block) {
    player.sendMessage("§7[wr] 視線の先にブロックがありません§r");
    return;
  }

  const block = hit.block;
  const perm = block.permutation;
  const own = [];
  for (const name of ["wr:power", "wr:on", "wr:color", "wr:level", "wr:armed",
                      "minecraft:block_face", "minecraft:cardinal_direction"]) {
    const v = perm.getState(name);
    if (v !== undefined) own.push(`${name}=${v}`);
  }

  const lines = [];
  lines.push(`§e${block.typeId}§r  (${block.location.x}, ${block.location.y}, ${block.location.z})`);
  if (own.length) lines.push("  states: " + own.join(" "));

  // ワイヤーは支持面がどこかも出す（block_face の逆向き）
  const face = perm.getState("minecraft:block_face");
  if (typeof face === "string") {
    const support = OPPOSITE[face];
    const sup = neighborBlock(block, support);
    lines.push(
      `  支持面: §b${support}§r (block_face=${face})  ${sup ? sup.typeId : "§7(取得不可)§r"}`
    );
    // 腕がどのワールド方位を向いているか。見た目の形が合わないときの決め手になる。
    const map = ARM_WORLD[face];
    if (map) {
      const arms = ARM_SLOTS.map((slot) => {
        const on = perm.getState(`wr:${slot}`) === true;
        return `${on ? "§c" : "§7"}${map[slot]}${on ? "有" : "無"}§r`;
      });
      lines.push("  腕: " + arms.join(" "));
    }
  }

  for (const f of FACES) {
    const nb = neighborBlock(block, f);
    if (!nb) {
      lines.push(`  ${f.padEnd(6)} : §7(取得不可)§r`);
      continue;
    }
    let raw = "?";
    try {
      raw = String(nb.getRedstonePower() ?? 0);
    } catch {
      raw = "err";
    }
    const state =
      nb.permutation.getState("wr:power") ?? nb.permutation.getState("wr:on") ?? "-";
    const used = powerFrom(block, f);
    const mark = used > 0 ? "§c" : "§7";
    lines.push(
      `  ${f.padEnd(6)} : ${mark}採用=${used}§r  raw=${raw} state=${state}  ${nb.typeId}`
    );
  }

  // 狙ったのがこのアドオンのブロックでなければ、隣に wr: ブロックが無いか見る。
  // ワイヤーは 1px の板なので、狙ったつもりでも後ろの壁に当たりやすい。
  if (!isOurs(block)) {
    const near = [];
    for (const f of FACES) {
      const nb = neighborBlock(block, f);
      if (isOurs(nb)) near.push(`${f}: §e${nb.typeId}§r ${describePlate(nb)}`);
    }
    if (near.length) {
      lines.push("§7  ※ wr: のブロックではありません。隣にあるもの:§r");
      for (const l of near) lines.push("  " + l);
    } else {
      lines.push("§7  ※ wr: のブロックではありません。§r");
      lines.push("§7    ワイヤーの向きを見るなら /scriptevent wr:wires のほうが確実です。§r");
    }
  }

  const header = "§6[wr] 入力ダンプ§r";
  console.warn(header);
  for (const l of lines) console.warn("  " + l.replace(/§./g, ""));
  player.sendMessage(header);
  for (const l of lines) player.sendMessage(l);
}

/** そのブロックが板を支えられるか（surface.js の canSupport と同じ条件）。 */
function supports(nb) {
  return !!nb && !nb.isAir && !nb.isLiquid && !isThinPlate(nb);
}

/** typeId を短く（minecraft: は省く）。行が長くなりすぎるのを防ぐ。 */
function shortId(block) {
  if (!block) return "?";
  return block.typeId.replace(/^minecraft:/, "");
}

/**
 * 薄板 1 枚ぶんの状態を 1 行にまとめる。
 *
 * 支え側だけでなく **反対側（板が向いている側）** も出すのが肝。
 *   支えが有り・反対側が空気 … 正常（壁に貼ってこちらを向いている）
 *   支えが無い               … 浮いている（面の選択が逆）
 *   両側とも壁               … 通路の中。どちらの壁に貼るかが曖昧で、
 *                              意図と逆の壁に貼られていても支えは有効に見える
 */
function describePlate(block) {
  const face = block.permutation.getState("minecraft:block_face");
  if (typeof face !== "string") return "";
  const support = OPPOSITE[face] ?? "?";
  const back = neighborBlock(block, support);
  const front = neighborBlock(block, face);

  const ok = supports(back);
  let note = "";
  if (!ok) note = " §c← 浮いています§r";
  else if (supports(front)) note = " §e← 両側が壁（通路）§r";

  return (
    `貼りつき面=§b${support}§r (block_face=${face}) ` +
    `支え=${ok ? "§a" : "§c"}${shortId(back)}§r 反対側=${shortId(front)}${note}`
  );
}

/**
 * `/scriptevent wr:wires [半径]`
 *
 * プレイヤーの周りにある薄板（ワイヤー・光源パネル）を全部出し、
 * 貼りついている面ごとの数も集計する。
 *
 * 「壁に貼ろうとしたのに全部同じ向きを向く」のような症状は、
 * **集計行がひとつの面に偏っているか**を見るのが一番早い。
 */
function dumpWires(player, arg) {
  if (!player?.location || !player?.dimension) return;

  const parsed = Number.parseInt(arg ?? "", 10);
  const radius = Number.isFinite(parsed) ? Math.max(1, Math.min(12, parsed)) : 5;

  const origin = {
    x: Math.floor(player.location.x),
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z),
  };

  const found = [];
  const byFace = new Map();
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        let block;
        try {
          block = player.dimension.getBlock({
            x: origin.x + dx,
            y: origin.y + dy,
            z: origin.z + dz,
          });
        } catch {
          continue;
        }
        if (!isThinPlate(block)) continue;
        const face = block.permutation.getState("minecraft:block_face");
        const support = typeof face === "string" ? OPPOSITE[face] ?? "?" : "?";
        byFace.set(support, (byFace.get(support) ?? 0) + 1);
        found.push(
          `  (${block.location.x}, ${block.location.y}, ${block.location.z}) ` +
            `§e${block.typeId}§r ${describePlate(block)}`
        );
      }
    }
  }

  const lines = [];
  lines.push(`§6[wr] 薄板ダンプ§r 半径 ${radius} / ${found.length} 枚`);
  if (found.length === 0) {
    lines.push("§7  周囲にワイヤー・光源パネルがありません§r");
  } else {
    const summary = [...byFace.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([face, n]) => `${face}=${n}`)
      .join("  ");
    lines.push("  貼りつき面の集計: " + summary);
    // 壁一面に並べただけでも 1 面に揃うので、これ自体は異常ではない。
    // 「別々の面に貼ったつもりなのに揃っている」ときだけが問題。
    if (byFace.size === 1 && found.length > 1) {
      lines.push("§e  すべて同じ面に貼りついています。§r");
      lines.push("§e  別々の面に貼ったつもりなら、向きが固定されています。§r");
    }
  }

  for (const l of lines) console.warn(l.replace(/§./g, ""));
  for (const l of found) console.warn(l.replace(/§./g, ""));
  for (const l of lines) player.sendMessage(l);
  // チャットが流れきらないよう、詳細は先頭 20 枚まで
  for (const l of found.slice(0, 20)) player.sendMessage(l);
  if (found.length > 20) {
    player.sendMessage(`§7  ... 残り ${found.length - 20} 枚はコンテンツログへ§r`);
  }
}

/**
 * `/scriptevent wr:version`
 *
 * **いま実際に読み込まれているスクリプトの版を出す。**
 *
 * .mcaddon を入れ直しても、ワールドが古い版のパックを掴んだままになることがある
 * （Minecraft はパックを UUID + バージョンで管理していて、
 *   ワールド側にどの版を使うかが記録されている）。
 * そうなると「直したはずの不具合がまだ出る」「追加したブロックが出てこない」が
 * 同時に起きるが、見た目には原因が分からない。
 *
 * ここで出るのは **BP のスクリプトに焼き込んだ定数** なので、
 * パックの表示名ではなく「本当に動いているコード」の版が分かる。
 */
const SCRIPT_VERSION = "1.31.3";

function dumpVersion(player) {
  if (!player) return;
  player.sendMessage(`§a[wr] 読み込まれているスクリプト: v${SCRIPT_VERSION}§r`);
  player.sendMessage(
    "§7  ここが期待した版より古いなら、ワールドが古いパックを掴んでいます。§r"
  );
  player.sendMessage(
    "§7  設定 → ワールド → ビヘイビアーパック から古い版を外し、入れ直してください。§r"
  );
}

/**
 * `/scriptevent wr:load [半径]`
 *
 * 周囲にある wr: ブロックを数えて、**スクリプトの負荷を見積もる**。
 *
 * 「重い」という感覚だけでは、原因がこのアドオンなのか他のアドオンなのか
 * 分からない。このアドオンのコストは **ブロック数にほぼ比例する**
 * （活動量ではなく、置いてある数で決まる）ので、数えれば見当がつく。
 *
 * 1 ブロックあたりの実測（tools/harness/profile*.mjs）:
 *   静止した回路       約 13.5 回/tick
 *   信号が動いている   約 19.6 回/tick
 * ここで言う「回」は JS↔ネイティブの往復で、スクリプトで一番効くコスト。
 */
const CALLS_PER_BLOCK_IDLE = 13.5;
const CALLS_PER_BLOCK_ACTIVE = 19.6;

function dumpLoad(player, arg) {
  if (!player?.location || !player?.dimension) return;

  const parsed = Number.parseInt(arg ?? "", 10);
  const radius = Number.isFinite(parsed) ? Math.max(4, Math.min(24, parsed)) : 12;

  const origin = {
    x: Math.floor(player.location.x),
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z),
  };

  const byType = new Map();
  let total = 0;
  let ticking = 0;
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        let block;
        try {
          block = player.dimension.getBlock({
            x: origin.x + dx,
            y: origin.y + dy,
            z: origin.z + dz,
          });
        } catch {
          continue;
        }
        if (!isOurs(block)) continue;
        total += 1;
        byType.set(block.typeId, (byType.get(block.typeId) ?? 0) + 1);
        // 装飾建材はポーリングしないので負荷に数えない
        if (!DECOR.has(block.typeId)) ticking += 1;
      }
    }
  }

  const lines = [];
  lines.push(`§6[wr] ブロック数§r 半径 ${radius}`);
  lines.push(`  wr: ブロック ${total} 個（うち毎 tick 動くもの ${ticking} 個）`);
  if (ticking > 0) {
    const idle = Math.round(ticking * CALLS_PER_BLOCK_IDLE);
    const active = Math.round(ticking * CALLS_PER_BLOCK_ACTIVE);
    lines.push(`  ネイティブ往復の目安: 静止 §b${idle}§r / 稼働 §b${active}§r 回/tick`);
  }
  const top = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [id, n] of top) lines.push(`    ${String(n).padStart(5)}  ${id}`);
  // **これは「プレイヤーの周り半径 N」でしかない。**
  // 実際にスクリプトが走るのは動作チャンクぶん全部（既定 4 チャンク = 64 ブロック相当）
  // なので、1 か所での数字だけで重い / 軽いを判断してはいけない。
  lines.push("§7  ※ここに出るのはこの地点の周りだけ。動作チャンク全体の負荷は§r");
  lines.push("§7    §b/scriptevent wr:profile§r§7 で実測してください。§r");

  for (const l of lines) console.warn(l.replace(/§./g, ""));
  for (const l of lines) player.sendMessage(l);
}

/**
 * `/scriptevent wr:profile`
 *
 * **このアドオンが 1 tick に何 ms 使っているかを実測する。**
 *
 * 1 回目で計測開始、2 回目で結果。ブロックを数えて見積もるのと違い、
 * 動作チャンク全体・全ブロック種別を丸ごと含んだ本当の値が出る。
 *
 * 1 tick の予算は 50ms（20 TPS）。ここが 1ms 台なら主因ではないし、
 * 10ms を超えているなら間違いなく効いている、と事実で言い切れる。
 */
function dumpProfile(player) {
  if (!player) return;

  if (!isProfiling()) {
    startProfiling();
    player.sendMessage("§6[wr] 計測を開始しました§r");
    player.sendMessage("§7  ふだんどおり遊んで、重いと感じたらもう一度同じコマンドを。§r");
    player.sendMessage("§7  10 秒以上まわすと数字が安定します。§r");
    return;
  }

  const s = stopProfiling();
  const pct = (s.msPerTick / 50) * 100; // 1 tick の予算は 50ms
  const lines = [];
  lines.push("§6[wr] 実測結果§r");
  lines.push(`  計測時間: ${s.ticks} tick（約 ${(s.ticks / 20).toFixed(1)} 秒）`);
  lines.push(`  再計算した回数: ${s.runs}（${s.runsPerTick.toFixed(1)} 回/tick）`);
  lines.push(
    `  §bスクリプトの所要時間: ${s.msPerTick.toFixed(2)} ms/tick§r  （1 tick の予算 50ms の ${pct.toFixed(1)}%）`
  );

  if (pct >= 20) {
    lines.push("§c  重さの主因はこのアドオンです。§r");
    lines.push("§7  ブロック数を減らすか、ポーリング間隔を伸ばす改修が要ります。§r");
  } else if (pct >= 5) {
    lines.push("§e  無視できない量です。一因にはなっています。§r");
  } else {
    lines.push("§a  このアドオンは主因ではありません。§r");
    lines.push("§7  他のアドオン・エンティティ数・描画距離のほうを疑ってください。§r");
  }

  for (const l of lines) console.warn(l.replace(/§./g, ""));
  for (const l of lines) player.sendMessage(l);
}

/** ポーリングを持たない置くだけのブロック（負荷に数えない）。 */
const DECOR = new Set([
  "wr:circuit_board",
  "wr:cable_panel",
  "wr:polished_amethyst",
  "wr:machine_panel",
  "wr:hazard_stripe",
]);

export function registerDevCommands() {
  system.afterEvents.scriptEventReceive.subscribe((e) => {
    if (e.id === "wr:version") {
      dumpVersion(e.sourceEntity);
      return;
    }
    if (e.id === "wr:load") {
      dumpLoad(e.sourceEntity, e.message?.trim());
      return;
    }
    if (e.id === "wr:profile") {
      dumpProfile(e.sourceEntity);
      return;
    }
    if (e.id === "wr:inputs") {
      dumpInputs(e.sourceEntity);
      return;
    }
    if (e.id === "wr:wires") {
      dumpWires(e.sourceEntity, e.message?.trim());
      return;
    }
    if (e.id !== "wr:dump") return;

    const filter = e.message?.trim();
    const lines = [];
    for (const id of world.getDynamicPropertyIds()) {
      if (!id.startsWith("wr:")) continue;
      if (filter && !id.includes(filter)) continue;
      lines.push(`${id} = ${world.getDynamicProperty(id)}`);
    }
    lines.sort();

    const header = `[wr] dynamic properties: ${lines.length}${filter ? ` (filter: ${filter})` : ""}`;
    console.warn(header);
    for (const line of lines) console.warn("  " + line);

    const player = e.sourceEntity;
    if (player?.sendMessage) {
      player.sendMessage(header);
      for (const line of lines.slice(0, 30)) player.sendMessage("  " + line);
      if (lines.length > 30) player.sendMessage(`  ... 残り ${lines.length - 30} 件はコンテンツログへ`);
    }
  });
}
