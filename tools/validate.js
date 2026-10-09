/**
 * パックの静的チェック（ビルド前に流す）。
 *
 *   node tools/validate.js
 *
 * 確認すること:
 *   1. すべての JSON がパースできる
 *   2. ブロック/アイテムが参照しているテクスチャ名が
 *      terrain_texture.json / item_texture.json に存在する
 *   3. テクスチャ定義が指す PNG が実在する
 *   4. ブロック/アイテムの表示名キーが ja_JP.lang と en_US.lang の両方にある
 *   5. スクリプトに登録されたカスタムコンポーネント名と
 *      ブロック JSON の minecraft:custom_components が一致している
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BP = path.join(ROOT, "RedstoneExtBP");
const RP = path.join(ROOT, "RedstoneExtRP");

const problems = [];
const fail = (msg) => problems.push(msg);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`JSON parse error: ${path.relative(ROOT, file)} — ${e.message}`);
    return undefined;
  }
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, onFile);
    } else {
      onFile(full);
    }
  }
}

// ---- 1. 全 JSON のパース ----------------------------------------------------

let jsonCount = 0;
for (const base of [BP, RP]) {
  walk(base, (file) => {
    if (!file.endsWith(".json")) return;
    jsonCount += 1;
    readJson(file);
  });
}

// ---- 2/3. テクスチャ参照 ----------------------------------------------------

const terrain = readJson(path.join(RP, "textures", "terrain_texture.json"))?.texture_data ?? {};
const itemTex = readJson(path.join(RP, "textures", "item_texture.json"))?.texture_data ?? {};

function collectTextureRefs(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const v of node) collectTextureRefs(v, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "texture" && typeof value === "string") out.add(value);
    else collectTextureRefs(value, out);
  }
}

for (const file of fs.readdirSync(path.join(BP, "blocks"))) {
  const json = readJson(path.join(BP, "blocks", file));
  if (!json) continue;
  const refs = new Set();
  collectTextureRefs(json, refs);
  for (const ref of refs) {
    if (!terrain[ref]) fail(`blocks/${file}: terrain_texture に "${ref}" が無い`);
  }
}

for (const file of fs.readdirSync(path.join(BP, "items"))) {
  const json = readJson(path.join(BP, "items", file));
  const icon = json?.["minecraft:item"]?.components?.["minecraft:icon"];
  if (typeof icon === "string" && !itemTex[icon]) {
    fail(`items/${file}: item_texture に "${icon}" が無い`);
  }
}

for (const [name, def] of Object.entries({ ...terrain, ...itemTex })) {
  const rel = typeof def.textures === "string" ? def.textures : undefined;
  if (!rel) continue;
  if (!fs.existsSync(path.join(RP, rel + ".png"))) {
    fail(`テクスチャ定義 "${name}" が指す ${rel}.png が無い`);
  }
}

// ---- 4. 表示名の翻訳キー ----------------------------------------------------

function langKeys(file) {
  const keys = new Set();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0 && !line.startsWith("#")) keys.add(line.slice(0, at).trim());
  }
  return keys;
}

const ja = langKeys(path.join(RP, "texts", "ja_JP.lang"));
const en = langKeys(path.join(RP, "texts", "en_US.lang"));

for (const file of fs.readdirSync(path.join(BP, "blocks"))) {
  const json = readJson(path.join(BP, "blocks", file));
  const key = json?.["minecraft:block"]?.components?.["minecraft:display_name"];
  if (typeof key !== "string") continue;
  if (!ja.has(key)) fail(`ja_JP.lang に ${key} が無い`);
  if (!en.has(key)) fail(`en_US.lang に ${key} が無い`);
}

for (const file of fs.readdirSync(path.join(BP, "items"))) {
  const json = readJson(path.join(BP, "items", file));
  const key = json?.["minecraft:item"]?.components?.["minecraft:display_name"]?.value;
  if (typeof key !== "string") continue;
  if (!ja.has(key)) fail(`ja_JP.lang に ${key} が無い`);
  if (!en.has(key)) fail(`en_US.lang に ${key} が無い`);
}

// ---- 4-2. クリエイティブのグループ ------------------------------------------
//
// **独自グループは item_catalog/crafting_item_catalog.json で宣言して初めて効く。**
// ブロック側の menu_category.group だけでは足りない。実機で 2 回外して確定した:
//
//   `wr:itemGroup.name_redstone_ext`（名前空間あり・カタログ無し）
//     → ブロックは残るが指定ごと黙って無視され、まとまらない
//   `itemGroup.name.wr_redstone_ext`（名前空間なし・カタログ無し）
//     → **ブロックが全部クリエイティブから消えた**（定義ごと読み込み失敗）
//
// どちらもコンテンツログにエラーが出ないので、症状から原因を逆算できない。
// 「ブロックの宣言」「カタログの宣言」「翻訳」の 3 つが揃っているかを機械的に見る。

{
  /** group 名 → { files, category } */
  const groups = new Map();

  const collect = (kind, root) => {
    for (const file of fs.readdirSync(path.join(BP, kind))) {
      const json = readJson(path.join(BP, kind, file));
      const menu = json?.[root]?.description?.menu_category;
      const id = json?.[root]?.description?.identifier;
      const group = menu?.group;
      if (typeof group !== "string") continue; // グループ無しは許容
      if (!groups.has(group)) groups.set(group, { ids: [], category: menu.category });
      groups.get(group).ids.push(id);
      if (groups.get(group).category !== menu.category) {
        fail(`グループ ${group} が複数のカテゴリにまたがっている（${file}）`);
      }
    }
  };
  collect("blocks", "minecraft:block");
  collect("items", "minecraft:item");

  // カタログ側の宣言を読む
  const catalogFile = path.join(BP, "item_catalog", "crafting_item_catalog.json");
  const declared = new Map(); // group 名 → items 配列
  if (fs.existsSync(catalogFile)) {
    const catalog = readJson(catalogFile)?.["minecraft:crafting_items_catalog"];
    for (const category of catalog?.categories ?? []) {
      for (const group of category.groups ?? []) {
        const name = group.group_identifier?.name;
        if (name) declared.set(name, group.items ?? []);
      }
    }
  }

  for (const [group, { ids }] of groups) {
    if (group.startsWith("minecraft:")) continue; // バニラのグループは宣言も翻訳も不要

    if (!declared.has(group)) {
      fail(
        `グループ "${group}" が item_catalog/crafting_item_catalog.json に無い。` +
          "宣言しないと指定が無視される（最悪ブロックが消える）。"
      );
      continue;
    }
    // 宣言と実体がずれていると、載っていないブロックだけ枠の外に出る
    const listed = new Set(declared.get(group));
    for (const id of ids) {
      if (!listed.has(id)) fail(`${id} が カタログの ${group} に載っていない`);
    }
    for (const id of listed) {
      if (!ids.includes(id)) fail(`カタログの ${group} に載っている ${id} が実在しない`);
    }
    if (!ja.has(group)) fail(`ja_JP.lang にグループ名 ${group} の訳が無い`);
    if (!en.has(group)) fail(`en_US.lang にグループ名 ${group} の訳が無い`);
  }

  // カタログにだけあって誰も使っていないグループ
  for (const group of declared.keys()) {
    if (!groups.has(group)) fail(`カタログの ${group} を使っているブロックが無い`);
  }
}

// ---- 5. カスタムコンポーネントの登録漏れ ------------------------------------

const mainJs = fs.readFileSync(path.join(BP, "scripts", "main.js"), "utf8");
// ブロックは registerBlock()（設定コピー機を挟むためのラッパー）、
// アイテムは registerCustomComponent() を直に呼んでいる。両方拾う。
const registered = new Set([
  ...[...mainJs.matchAll(/registerCustomComponent\(\s*"([^"]+)"/g)].map((m) => m[1]),
  ...[...mainJs.matchAll(/registerBlock\(\s*"([^"]+)"/g)].map((m) => m[1]),
]);

for (const file of fs.readdirSync(path.join(BP, "blocks"))) {
  const json = readJson(path.join(BP, "blocks", file));
  const components = json?.["minecraft:block"]?.components ?? {};

  // 旧形式の配列宣言は format_version 1.21.90 以降のスキーマから削除されている。
  // 残っているとブロックごと読み込みに失敗して、クリエイティブにも出てこなくなる。
  if (components["minecraft:custom_components"]) {
    fail(`blocks/${file}: 旧形式の minecraft:custom_components が残っている（components に直接 id を書く）`);
  }

  let declared = 0;
  for (const name of Object.keys(components)) {
    if (!name.startsWith("wr:")) continue;
    declared += 1;
    if (!registered.has(name)) fail(`blocks/${file}: "${name}" が main.js で登録されていない`);
  }
  // 装飾建材（ステートもレッドストーン系コンポーネントも tick も持たない、置くだけの
  // ブロック）はスクリプトが要らないので、カスタムコンポーネントが無くてよい。
  // 逆に「動くはずのブロックが登録漏れで沈黙する」のを見逃さないよう、
  // 何か 1 つでも動きの気配があれば従来どおり必須にする。
  const states = Object.keys(json?.["minecraft:block"]?.description?.states ?? {});
  const isDecorative =
    states.length === 0 &&
    !components["minecraft:tick"] &&
    !components["minecraft:redstone_producer"] &&
    !components["minecraft:redstone_consumer"];
  if (declared === 0 && !isDecorative) {
    fail(`blocks/${file}: カスタムコンポーネントが 1 つも宣言されていない`);
  }
}

// material_instances の ambient_occlusion は数値。bool を書くと読み込みに失敗する。
for (const file of fs.readdirSync(path.join(BP, "blocks"))) {
  const text = fs.readFileSync(path.join(BP, "blocks", file), "utf8");
  if (/"ambient_occlusion"\s*:\s*(true|false)/.test(text)) {
    fail(`blocks/${file}: ambient_occlusion が bool になっている（数値で指定する）`);
  }
}

// ---- 5-2. ブロック定義の必須事項 --------------------------------------------
//
// エンジンが読み込み時に弾く条件。どれも「ブロックごと消える」ので、
// 症状（クリエイティブに出てこない）から原因を逆算するのが難しい。

/** リソースパックに入っているジオメトリ識別子の一覧。 */
const knownGeometries = new Set();
{
  const modelsDir = path.join(RP, "models");
  if (fs.existsSync(modelsDir)) {
    walk(modelsDir, (file) => {
      if (!file.endsWith(".json")) return;
      const json = readJson(file);
      for (const geo of json?.["minecraft:geometry"] ?? []) {
        const id = geo?.description?.identifier;
        if (id) knownGeometries.add(id);
      }
    });
  }
}

for (const file of fs.readdirSync(path.join(BP, "blocks"))) {
  const json = readJson(path.join(BP, "blocks", file));
  const block = json?.["minecraft:block"];
  if (!block) continue;
  const components = block.components ?? {};
  const permutations = block.permutations ?? [];

  // (1) geometry と material_instances は両方必須
  //     「Block needs both a "geometry" and "material_instances" component.」
  if (!components["minecraft:geometry"]) {
    fail(`blocks/${file}: minecraft:geometry が base components に無い`);
  }

  // (1b) 参照しているジオメトリ識別子がリソースパックに存在すること。
  //      綴り違いはブロックごと読み込み失敗になるので静的に潰す。
  for (const source of [components, ...permutations.map((p) => p.components ?? {})]) {
    const geo = source["minecraft:geometry"];
    if (!geo) continue;
    const id = typeof geo === "string" ? geo : geo.identifier;
    if (!id || id.startsWith("minecraft:")) continue; // バニラ提供のものは対象外
    if (!knownGeometries.has(id)) {
      fail(`blocks/${file}: ジオメトリ "${id}" がリソースパックに無い`);
    }
  }
  if (!components["minecraft:material_instances"]) {
    fail(`blocks/${file}: minecraft:material_instances が base components に無い`);
  }

  // (2) permutations で redstone_producer を使うなら base にも宣言が必要
  //     「cannot define 'minecraft:redstone_producer' in the 'permutations' array
  //       and not define it in the base 'components' object」
  const usedInPermutations = permutations.some(
    (p) => p.components?.["minecraft:redstone_producer"]
  );
  if (usedInPermutations && !components["minecraft:redstone_producer"]) {
    fail(`blocks/${file}: redstone_producer を permutations で使うなら base にも宣言が要る`);
  }

  // (3) redstone_consumer は permutations に置けない
  if (permutations.some((p) => p.components?.["minecraft:redstone_consumer"])) {
    fail(`blocks/${file}: redstone_consumer は permutations に置けない`);
  }

  // (4) producer と consumer は同居できない
  //     「Block cannot have both "minecraft:redstone_producer" and
  //       "minecraft:redstone_consumer" components.」
  //     出力を持つブロックは onRedstoneUpdate を受け取れないので、
  //     入力検知は minecraft:tick + scheduleNeighbors() で行うこと。
  if (components["minecraft:redstone_producer"] && components["minecraft:redstone_consumer"]) {
    fail(`blocks/${file}: redstone_producer と redstone_consumer は同居できない`);
  }

  // (4b) 出力を持つブロックは、その強さを表すステートを必ず持つこと。
  //      scripts/util.js の powerFrom() は wr: ブロックの出力を
  //      wr:power / wr:on ステートから読む（getRedstonePower() は使わない）。
  //      出力があるのにステートが無いと、隣のブロックからは常に 0 に見えてしまう。
  //      逆にステートが無いブロック（送信機）は出力を持たないのが前提。
  {
    const producesInPermutations = permutations.some(
      (p) => p.components?.["minecraft:redstone_producer"]
    );
    const produces = !!components["minecraft:redstone_producer"] || producesInPermutations;
    const states = Object.keys(block.description?.states ?? {});
    const hasOutputState = states.includes("wr:power") || states.includes("wr:on");
    if (produces && !hasOutputState) {
      fail(`blocks/${file}: 出力を持つのに wr:power / wr:on のどちらも無い`);
    }

    // (4c) 逆も要る。**出力を持たないブロックが wr:power / wr:on を名乗ってはいけない。**
    //      powerFrom() はこの 2 つを「出力」として読むので、
    //      内部の都合（稼働中フラグなど）で使うと隣のワイヤーが勝手に点く。
    //      v1.28.1 まで精錬機・ディスペンサー・ホッパードロッパー・スパイクが
    //      これを踏んでいて、「アイテムを運んでいる間だけ隣のワイヤーが光る」
    //      状態だった（向きを持たないブロックは全方向に漏れる）。
    //      稼働中の見た目には wr:busy のような別名を使うこと。
    if (!produces && hasOutputState) {
      const leaked = states.filter((s) => s === "wr:power" || s === "wr:on");
      fail(
        `blocks/${file}: 出力を持たないのに ${leaked.join(" / ")} を宣言している` +
          `（powerFrom() が出力として読むので隣のワイヤーが点く。wr:busy 等に改名すること）`
      );
    }
  }

  // (5) 出力を持つ = onRedstoneUpdate が来ないので、minecraft:tick が無いと
  //     バニラ側の電力変化に永久に気づけない
  if (components["minecraft:redstone_producer"] && !components["minecraft:tick"]) {
    const readsInput = Object.keys(components).some((n) => n.startsWith("wr:"));
    const isSourceOnly = file === "receiver.json" || file === "constant.json";
    if (readsInput && !isSourceOnly) {
      fail(`blocks/${file}: producer を持つのに minecraft:tick が無い（入力変化に気づけない）`);
    }
  }
}

for (const file of fs.readdirSync(path.join(BP, "items"))) {
  const json = readJson(path.join(BP, "items", file));
  const components = json?.["minecraft:item"]?.components ?? {};
  for (const name of Object.keys(components)) {
    if (!name.startsWith("wr:")) continue;
    if (!registered.has(name)) fail(`items/${file}: "${name}" が main.js で登録されていない`);
  }
}

// ---- 5-3. ワールドを書き換えたらキャッシュを捨てているか --------------------
//
// util.js の factsCache は「1 回の再計算のあいだ typeId とステートを覚える」
// 仕組みで、正しさは **書き込んだら捨てる** の 1 点だけで守られている。
// applyStates は自分で invalidateFacts() を呼ぶが、`setType()` を直に叩く
// コードは自分で呼ばないといけない。忘れても**その場では症状が出ず**、
// あとから setType の後ろに読み取りを足した人が踏む形になる。
// テストでは捕まえられない（今は setType の後に読み直しが無いため）ので、
// ここで静的に縛っておく。

{
  const scriptsDir = path.join(BP, "scripts");
  for (const file of fs.readdirSync(scriptsDir)) {
    if (!file.endsWith(".js") || file.startsWith("generate_")) continue;
    const lines = fs.readFileSync(path.join(scriptsDir, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/\.setType\(/.test(line)) return;
      // 直後の数行に invalidateFacts() があること（離れていると読む人に伝わらない）
      const near = lines.slice(i + 1, i + 4).join("\n");
      if (/invalidateFacts\s*\(/.test(near)) return;
      fail(
        `scripts/${file}:${i + 1}: setType() の直後に invalidateFacts() が無い` +
          `（util.js の factsCache が古い typeId を返すおそれがある）`
      );
    });
  }
}

// ---- 5-4. 設定コピー機の対応表が実在のステートを指しているか ----------------
//
// config_tool.js の SETTINGS は「ブロック種別 → コピーする設定ステート」の表。
// ステート名を打ち間違えても、**その項目が黙ってコピーされないだけ**で
// エラーにならない（実機で「なぜかこの設定だけ写らない」になる）。
// ブロック定義と突き合わせておく。

const settingsTypeIds = new Set();

{
  const src = fs.readFileSync(path.join(BP, "scripts", "config_tool.js"), "utf8");
  const body = src.slice(src.indexOf("const SETTINGS = {"), src.indexOf("const dpSettings = new Map();"));
  const entries = [...body.matchAll(/"(wr:[a-z_]+)":\s*\[([^\]]*)\]/g)];
  if (entries.length === 0) fail("scripts/config_tool.js: SETTINGS を読み取れない");

  for (const [, typeId, list] of entries) {
    settingsTypeIds.add(typeId);
    const file = typeId.replace("wr:", "") + ".json";
    const full = path.join(BP, "blocks", file);
    if (!fs.existsSync(full)) {
      fail(`config_tool.js: SETTINGS の "${typeId}" に対応するブロック定義が無い`);
      continue;
    }
    const desc = readJson(full)?.["minecraft:block"]?.description ?? {};
    const declared = new Set(Object.keys(desc.states ?? {}));
    for (const raw of list.split(",")) {
      const name = raw.trim().replace(/^"|"$/g, "");
      if (!name) continue;
      if (!declared.has(name)) {
        fail(`config_tool.js: "${typeId}" に "${name}" というステートは無い（コピーしても効かない）`);
      }
    }
  }
}

// ---- 5-4b. 動的プロパティに逃がした設定が二重管理になっていないか ------------
//
// 見た目に効かない設定値が 2 つ以上あるブロックは、ステートに置くと掛け算で
// 状態数の予算を食うので `registerDpSettings()` で動的プロパティへ逃がしている。
// このとき **SETTINGS 側にも残っていると**、コピー機が同じ値を 2 経路で読み書きして
// 片方だけ効く（= 貼り付けたのに変わらない）状態になる。

{
  const registered = new Set();
  for (const file of fs.readdirSync(path.join(BP, "scripts"))) {
    if (!file.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(BP, "scripts", file), "utf8");
    for (const [, typeId] of src.matchAll(/registerDpSettings\(\s*"(wr:[a-z_]+)"/g)) {
      registered.add(typeId);
      const full = path.join(BP, "blocks", typeId.replace("wr:", "") + ".json");
      if (!fs.existsSync(full)) {
        fail(`${file}: registerDpSettings の "${typeId}" に対応するブロック定義が無い`);
        continue;
      }
      if (settingsTypeIds.has(typeId)) {
        fail(
          `config_tool.js: "${typeId}" が SETTINGS と registerDpSettings の両方にある` +
            `（コピー機が同じ設定を 2 経路で扱うので、貼り付けても片方しか効かない）`
        );
      }
    }
  }
}

// ---- 5-4c. 座標キーの動的プロパティを持つブロックはピストンで動かさない --------
//
// blockExplode で後始末しているブロック＝座標をキーに設定を持つブロック。
// 押されて動くと記録と実体がずれる。popped も不可（ピストンで壊れても
// onPlayerDestroy が来ないので、元の座標に設定が残る）。v1.31.3 で 6 種が漏れていた。

{
  for (const file of fs.readdirSync(path.join(BP, "scripts"))) {
    if (!file.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(BP, "scripts", file), "utf8");
    for (const m of src.matchAll(/blockExplode\??\.subscribe\(/g)) {
      const body = src.slice(m.index, src.indexOf("\n  });", m.index));
      for (const [, typeId] of body.matchAll(/"(wr:[a-z_]+)"/g)) {
        const full = path.join(BP, "blocks", typeId.replace("wr:", "") + ".json");
        if (!fs.existsSync(full)) continue;
        const mt = readJson(full)?.["minecraft:block"]?.components?.["minecraft:movable"]?.movement_type;
        if (mt !== "immovable") {
          fail(`${file}: "${typeId}" は座標キーの設定を持つのに movable が "${mt ?? "未指定"}"（immovable にすること）`);
        }
      }
    }
  }
}

// ---- 5-5. ブロックステートの組み合わせ数 ------------------------------------
//
// **ワールド全体で 65,536 が上限。超えるとブロックが読み込まれず、
// クリエイティブから丸ごと消える。** しかも「増やしたブロック」ではなく
// 無関係なブロックが消えることもあるので、原因にたどり着きにくい。
//
// 危ないのは総量より **1 ブロックの内訳**。トレイト（block_face は ×6、
// cardinal_direction は ×4）とステートの積なので、うっかり掛け算が育つ。
// wr:wire だけで 49,152 を占めているので、同じ形のブロックをもう 1 つ作ると即死する。

{
  const TOTAL_LIMIT = 65536;
  const PER_BLOCK_WARN = 8192; // ワイヤー級のものを気づかず増やさないための線
  const TRAIT_SIZE = {
    "minecraft:cardinal_direction": 4,
    "minecraft:facing_direction": 6,
    "minecraft:block_face": 6,
    "minecraft:vertical_half": 2,
  };

  let total = 0;
  for (const file of fs.readdirSync(path.join(BP, "blocks"))) {
    const desc = readJson(path.join(BP, "blocks", file))?.["minecraft:block"]?.description ?? {};
    let combos = 1;
    for (const values of Object.values(desc.states ?? {})) combos *= values.length;
    for (const cfg of Object.values(desc.traits ?? {})) {
      for (const s of cfg.enabled_states ?? []) combos *= TRAIT_SIZE[s] ?? 1;
    }
    total += combos;
    if (combos > PER_BLOCK_WARN && file !== "wire.json") {
      fail(
        `blocks/${file}: ステートの組み合わせが ${combos.toLocaleString()} で大きすぎる` +
          `（1 ブロック ${PER_BLOCK_WARN.toLocaleString()} まで。ステートを減らすか動的プロパティへ）`
      );
    }
  }

  const pct = Math.round((total / TOTAL_LIMIT) * 100);
  if (total > TOTAL_LIMIT) {
    fail(`ステートの組み合わせ合計が ${total.toLocaleString()} / ${TOTAL_LIMIT.toLocaleString()} で上限超過（ブロックが消える）`);
  } else {
    console.log(`  ステート組み合わせ: ${total.toLocaleString()} / ${TOTAL_LIMIT.toLocaleString()} (${pct}%)`);
  }
}

// ---- 6. バージョンの整合 ----------------------------------------------------
//
// BP は RP の header.version を固定値で参照しているので、片方だけ上げると
// 依存が解決できなくなる。全部同じ値であることを機械的に確かめる。

{
  const bpManifest = readJson(path.join(BP, "manifest.json"));
  const rpManifest = readJson(path.join(RP, "manifest.json"));
  const versions = new Map();

  const record = (label, v) => versions.set(label, JSON.stringify(v));

  if (bpManifest) {
    record("BP header", bpManifest.header?.version);
    for (const mod of bpManifest.modules ?? []) record(`BP module(${mod.type})`, mod.version);
    for (const dep of bpManifest.dependencies ?? []) {
      if (dep.uuid) record("BP dependency(RP)", dep.version);
    }
  }
  if (rpManifest) {
    record("RP header", rpManifest.header?.version);
    for (const mod of rpManifest.modules ?? []) record(`RP module(${mod.type})`, mod.version);
  }

  const distinct = new Set(versions.values());
  if (distinct.size > 1) {
    fail(`manifest のバージョンが揃っていない: ${[...versions].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }

  // lang の pack.name に書いた表記も合わせる
  const expected = (bpManifest?.header?.version ?? []).join(".");
  for (const pack of [BP, RP]) {
    for (const file of fs.readdirSync(path.join(pack, "texts"))) {
      if (!file.endsWith(".lang")) continue;
      const text = fs.readFileSync(path.join(pack, "texts", file), "utf8");
      const m = text.match(/^pack\.name=.*?v(\d+\.\d+\.\d+)/m);
      if (m && m[1] !== expected) {
        fail(`${path.basename(pack)}/texts/${file}: pack.name の v${m[1]} が manifest の ${expected} と違う`);
      }
    }
  }
}

// ---- 結果 -------------------------------------------------------------------

console.log(`checked ${jsonCount} json files`);
if (problems.length === 0) {
  console.log("OK: 静的チェックはすべて通過");
} else {
  for (const p of problems) console.error("  x " + p);
  console.error(`${problems.length} problem(s)`);
  process.exit(1);
}
