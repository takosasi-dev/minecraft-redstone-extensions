/**
 * パートF: センサー
 *   F-1 wr:entity_sensor    半径内のエンティティ数を電力に変える
 *   F-2 wr:daylight_sensor  時刻（昼夜）を電力に変える
 *
 * ---------------------------------------------------------------------------
 * このアドオンに足りていなかったもの
 * ---------------------------------------------------------------------------
 * 論理回路も記憶素子も揃っているのに、**回路の入口がリモコンと手動しか無かった**。
 * 「ワールドの状態を読んで電力にする」ブロックが 1 つも無かったので、
 * 自動で動く仕掛けが作れなかった。この 2 種がその穴を埋める。
 *
 * ---------------------------------------------------------------------------
 * 更新間隔について
 * ---------------------------------------------------------------------------
 * getEntities() は範囲検索なので、他のブロックと同じ 4 tick で回すと
 * センサーを並べたときの負荷が読めない。センサーだけ **20 tick（1 秒）** に
 * している（ブロック JSON 側の minecraft:tick）。
 * 反応が 1 秒遅れて困る用途には向かないが、
 * 「誰かが近づいたら明かりを点ける」程度なら十分。
 */

import { world } from "@minecraft/server";
import { FACES, clampPower, neighborBlock, blockKey } from "./util.js";
import { scheduleUpdate, applyStates, registerUpdater, scheduleNeighbors } from "./propagation_helper.js";
import { ModalFormData } from "@minecraft/server-ui";
import { openNumberSetting, stepValue } from "./block_ui.js";
import { heldItem } from "./wire.js";

// ---------------------------------------------------------------------------
// F-1. エンティティセンサー
// ---------------------------------------------------------------------------

/** wr:mode の値 → 数えるものの種類。ブロック JSON の states と順番を合わせること。 */
const SENSOR_MODES = ["all", "player", "mob", "item", "named"];

const MODE_LABEL = {
  all: "wr.msg.sensor.mode.all",
  player: "wr.msg.sensor.mode.player",
  mob: "wr.msg.sensor.mode.mob",
  item: "wr.msg.sensor.mode.item",
  named: "wr.msg.sensor.mode.named",
};

/** 「指定プレイヤー」モードで探す名前。座標キーのワールド動的プロパティ。 */
const NAME_PREFIX = "wr:sensorname|";

function sensorNameOf(block) {
  const value = world.getDynamicProperty(
    NAME_PREFIX + blockKey(block.dimension.id, block.location)
  );
  return typeof value === "string" ? value : "";
}

function setSensorName(block, name) {
  const value = String(name ?? "").trim().slice(0, 24);
  world.setDynamicProperty(
    NAME_PREFIX + blockKey(block.dimension.id, block.location),
    value === "" ? undefined : value
  );
  return value;
}

export function clearSensorName(dimensionId, location) {
  world.setDynamicProperty(NAME_PREFIX + blockKey(dimensionId, location), undefined);
}

function modeOf(block) {
  const mode = block.permutation.getState("wr:mode");
  return SENSOR_MODES[typeof mode === "number" ? mode : 0] ?? "all";
}

function radiusOf(block) {
  const radius = block.permutation.getState("wr:radius");
  return typeof radius === "number" && radius >= 1 ? radius : 4;
}

/**
 * 半径内のエンティティを数える。
 *
 * EntityQueryOptions の絞り込みはモードによって変える:
 *   player … type を minecraft:player に限定
 *   item   … type を minecraft:item に限定（ドロップアイテム）
 *   mob    … player と item を除いた残り
 *   all    … 何も除かない
 *
 * 数えたそのままではなく **0〜15 に丸めて** 出力する。
 * 16 体以上いても 15 で頭打ちになるが、電力の上限がそこなので仕方がない。
 */
function countEntities(block) {
  const mode = modeOf(block);
  const radius = radiusOf(block);
  const location = {
    x: block.location.x + 0.5,
    y: block.location.y + 0.5,
    z: block.location.z + 0.5,
  };

  const options = { location, maxDistance: radius };
  if (mode === "player" || mode === "named") options.type = "minecraft:player";
  else if (mode === "item") options.type = "minecraft:item";
  else if (mode === "mob") options.excludeTypes = ["minecraft:player", "minecraft:item"];

  try {
    const found = block.dimension.getEntities(options);
    if (mode !== "named") return found.length;
    // 指定した名前の人だけ数える。名前が未設定なら誰も通さない
    // （空欄で全員一致にすると「設定し忘れ」が検知しっぱなしになって危ない）
    const want = sensorNameOf(block);
    if (want.length === 0) return 0;
    return found.filter((entity) => entity.name === want).length;
  } catch (e) {
    // 未ロードチャンク・API が使えない環境では 0 扱いにして落とさない
    console.warn(`[wr] entity sensor failed: ${e}`);
    return 0;
  }
}

function updateEntitySensor(block) {
  const power = clampPower(countEntities(block));
  if (applyStates(block, { "wr:power": power })) scheduleNeighbors(block);
}
registerUpdater("wr:entity_sensor", updateEntitySensor);

const RADIUS_MIN = 1;
const RADIUS_MAX = 8;

export const entitySensorComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateEntitySensor);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateEntitySensor);
  },
  /**
   * 右クリックで検知半径のスライダー。
   * スニーク + 右クリックは **検知対象の切り替え**（すべて → プレイヤー → モブ → アイテム）。
   * 他のブロックの「スニーク = +1 の微調整」とは意味が違うが、
   * 設定が 2 つあるブロックはこれだけなので、片方をスニークに割り当てている。
   */
  onPlayerInteract(e) {
    const block = e.block;
    const player = e.player;
    if (!player) return;

    if (player.isSneaking) {
      const current = block.permutation.getState("wr:mode");
      const next = stepValue(typeof current === "number" ? current : 0, 0, SENSOR_MODES.length - 1);
      if (applyStates(block, { "wr:mode": next })) scheduleUpdate(block, updateEntitySensor);
      player.onScreenDisplay.setActionBar({
        translate: "wr.msg.sensor.mode",
        with: { rawtext: [{ translate: MODE_LABEL[SENSOR_MODES[next]] }] },
      });
      return;
    }

    // 「指定プレイヤー」モードのときだけ、半径と名前を一緒に決める
    if (modeOf(block) === "named") {
      openNamedSensorForm(player, block);
      return;
    }

    openNumberSetting(player, block, {
      titleKey: "wr.ui.sensor.title",
      labelKey: "wr.ui.sensor.label",
      min: RADIUS_MIN,
      max: RADIUS_MAX,
      value: radiusOf(block),
      apply: (fresh, value) => {
        const radius = Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, value));
        applyStates(fresh, { "wr:radius": radius });
        scheduleUpdate(fresh, updateEntitySensor);
        player.onScreenDisplay.setActionBar({
          translate: "wr.msg.sensor.radius",
          with: [String(radius)],
        });
      },
    });
  },
  onPlayerDestroy(e) {
    clearSensorName(e.block.dimension.id, e.block.location);
  },
};

/** 半径とプレイヤー名を一緒に決めるフォーム。 */
function openNamedSensorForm(player, block) {
  const dimension = block.dimension;
  const location = { ...block.location };

  const form = new ModalFormData()
    .title({ translate: "wr.ui.sensor.named.title" })
    .textField({ translate: "wr.ui.sensor.named.label" }, player.name ?? "", {
      defaultValue: sensorNameOf(block),
    })
    .slider({ translate: "wr.ui.sensor.label" }, RADIUS_MIN, RADIUS_MAX, {
      valueStep: 1,
      defaultValue: radiusOf(block),
    });

  form.show(player).then((res) => {
    if (res.canceled) return;
    let fresh;
    try {
      fresh = dimension.getBlock(location);
    } catch {
      return;
    }
    if (!fresh || fresh.typeId !== "wr:entity_sensor") return;

    const name = setSensorName(fresh, String(res.formValues?.[0] ?? ""));
    const radius = Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, Number(res.formValues?.[1]) || 4));
    applyStates(fresh, { "wr:radius": radius });
    scheduleUpdate(fresh, updateEntitySensor);
    player.onScreenDisplay.setActionBar({
      translate: name.length > 0 ? "wr.msg.sensor.named" : "wr.msg.sensor.noname",
      with: [name],
    });
  });
}

// ---------------------------------------------------------------------------
// F-4. 天候センサー
// ---------------------------------------------------------------------------
//
// 「ワールドの状態を読む」系で天候だけ抜けていたので埋める。
// 晴れ 0 / 雨 8 / 雷雨 15 を全方向に出す（右クリックで反転）。
//
// dimension.getWeather() が使えるかは版によるので、
// **weatherChange イベントで拾った値をキャッシュしておく**二段構えにしてある。
// どちらも取れない環境では 0（晴れ）扱いになるだけで、例外にはしない。

/** dimensionId → "Clear" | "Rain" | "Thunder" */
const weatherCache = new Map();

export function registerWeatherEvents() {
  world.afterEvents.weatherChange?.subscribe((e) => {
    // 版によってプロパティ名が違う可能性があるので両方見る
    const value = e.newWeather ?? e.weather;
    if (typeof value === "string") weatherCache.set(e.dimension?.id ?? "minecraft:overworld", value);
  });
}

/** 0 = 晴れ / 8 = 雨 / 15 = 雷雨。 */
function weatherLevel(block) {
  let weather;
  try {
    weather = block.dimension.getWeather?.();
  } catch {
    weather = undefined;
  }
  if (typeof weather !== "string") weather = weatherCache.get(block.dimension.id);
  if (typeof weather !== "string") return 0;

  const name = weather.toLowerCase();
  if (name.includes("thunder")) return 15;
  if (name.includes("rain")) return 8;
  return 0;
}

function updateWeatherSensor(block) {
  const level = weatherLevel(block);
  const inverted = block.permutation.getState("wr:night") === true;
  const power = clampPower(inverted ? 15 - level : level);
  if (applyStates(block, { "wr:power": power })) scheduleNeighbors(block);
}
registerUpdater("wr:weather_sensor", updateWeatherSensor);

export const weatherSensorComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateWeatherSensor);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateWeatherSensor);
  },
  /** 右クリックで反転（晴れのときに強くする）。 */
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;
    const inverted = e.block.permutation.getState("wr:night") !== true;
    applyStates(e.block, { "wr:night": inverted });
    scheduleUpdate(e.block, updateWeatherSensor);
    player.onScreenDisplay.setActionBar({
      translate: inverted ? "wr.msg.weather.inverted" : "wr.msg.weather.normal",
    });
  },
};

// ---------------------------------------------------------------------------
// F-2. 時刻センサー
// ---------------------------------------------------------------------------

/**
 * ワールドの時刻を 0〜15 の電力にする。
 *
 * バニラの日照センサーは「空が見えているか」まで見るが、こちらは
 * **時刻だけ**を見る（屋内・地下でも同じ値が出る）。
 * 地下の拠点で昼夜に合わせて明かりを切り替える、といった用途を想定している。
 *
 * wr:night が false（既定）… 昼にかけて強くなる
 * wr:night が true          … 夜にかけて強くなる（反転）
 *
 * 時刻は 0〜23999。6000 が正午、18000 が真夜中。
 * 正午からの距離を 0〜15 に写して、正午 = 15 / 真夜中 = 0 とする。
 */
const DAY_LENGTH = 24000;
const NOON = 6000;

export function powerForTime(timeOfDay, night) {
  const time = ((timeOfDay % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH;
  // 正午からの差（0〜12000）。12000 が真夜中。
  let distance = Math.abs(time - NOON);
  if (distance > DAY_LENGTH / 2) distance = DAY_LENGTH - distance;
  const day = 1 - distance / (DAY_LENGTH / 2); // 正午 1.0 → 真夜中 0.0
  const ratio = night ? 1 - day : day;
  return clampPower(Math.round(ratio * 15));
}

function updateDaylightSensor(block) {
  let time = 0;
  try {
    time = world.getTimeOfDay?.() ?? 0;
  } catch (e) {
    console.warn(`[wr] time read failed: ${e}`);
    return;
  }
  const night = block.permutation.getState("wr:night") === true;
  if (applyStates(block, { "wr:power": powerForTime(time, night) })) scheduleNeighbors(block);
}
registerUpdater("wr:daylight_sensor", updateDaylightSensor);

export const daylightSensorComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateDaylightSensor);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateDaylightSensor);
  },
  /** 右クリックで昼／夜を反転する（バニラの日照センサーと同じ操作感）。 */
  onPlayerInteract(e) {
    const player = e.player;
    if (!player) return;
    const night = e.block.permutation.getState("wr:night") !== true;
    applyStates(e.block, { "wr:night": night });
    scheduleUpdate(e.block, updateDaylightSensor);
    player.onScreenDisplay.setActionBar({
      translate: night ? "wr.msg.daylight.night" : "wr.msg.daylight.day",
    });
  },
};

// ---------------------------------------------------------------------------
// F-3. コンテナ計測器
// ---------------------------------------------------------------------------
//
// **このアドオンにはチェストの中身を読む手段が無かった。**
// バニラのコンパレーターに相当するものが欠けていて、
// レッドストーン自動化の半分（搬入・搬出の監視）が組めない状態だった。
//
// 隣接する 6 面を順に見て、最初に見つけたコンテナを読む。
// 向きを持たせなかったのは、チェストが上下にも来るため。
// 複数隣接しているときは FACES の順（下・上・北・南・西・東）で先勝ち。

/** wr:mode の値 → 何を測るか。ブロック JSON の states と順番を合わせること。 */
const CONTAINER_MODES = ["fill", "kinds", "empty", "item"];

const CONTAINER_MODE_LABEL = {
  fill: "wr.msg.container.mode.fill",
  kinds: "wr.msg.container.mode.kinds",
  empty: "wr.msg.container.mode.empty",
  item: "wr.msg.container.mode.item",
};

/** 「指定アイテムの個数」モードで数える対象。座標キーのワールド動的プロパティ。 */
const FILTER_PREFIX = "wr:cfilter|";

function filterOf(block) {
  const value = world.getDynamicProperty(FILTER_PREFIX + blockKey(block.dimension.id, block.location));
  return typeof value === "string" ? value : "";
}

function setFilter(block, typeId) {
  world.setDynamicProperty(
    FILTER_PREFIX + blockKey(block.dimension.id, block.location),
    typeId === undefined || typeId === "" ? undefined : typeId
  );
}

export function clearContainerFilter(dimensionId, location) {
  world.setDynamicProperty(FILTER_PREFIX + blockKey(dimensionId, location), undefined);
}

function containerModeOf(block) {
  const mode = block.permutation.getState("wr:mode");
  return CONTAINER_MODES[typeof mode === "number" ? mode : 0] ?? "fill";
}

/** 隣接する 6 面から最初に見つかったコンテナ。 */
function adjacentContainer(block) {
  for (const face of FACES) {
    const nb = neighborBlock(block, face);
    if (!nb) continue;
    try {
      const container = nb.getComponent("minecraft:inventory")?.container;
      if (container) return container;
    } catch {
      // インベントリを持たないブロックはここに来る。次の面へ
    }
  }
  return undefined;
}

/**
 * コンテナの中身を 0〜15 にする。
 *
 * fill は**バニラのコンパレーターと同じ考え方**で、
 * 「スタック上限に対する割合」を足し合わせて割る（64 個入るスロットに 32 個なら 0.5）。
 * 1 個でも入っていれば最低 1 を返すので、「空でない」がそのまま拾える。
 */
function measure(container, mode, filterId) {
  const size = container.size ?? 0;
  if (size <= 0) return 0;

  let ratio = 0;
  let used = 0;
  let filtered = 0;
  const kinds = new Set();

  for (let slot = 0; slot < size; slot += 1) {
    let item;
    try {
      item = container.getItem(slot);
    } catch {
      continue;
    }
    if (!item) continue;
    used += 1;
    kinds.add(item.typeId);
    if (filterId && item.typeId === filterId) filtered += item.amount ?? 1;
    const max = item.maxAmount ?? 64;
    ratio += (item.amount ?? 1) / (max > 0 ? max : 64);
  }

  if (mode === "kinds") return clampPower(kinds.size);
  if (mode === "empty") return clampPower(size - used);
  if (mode === "item") return clampPower(filtered);

  if (used === 0) return 0;
  return clampPower(Math.max(1, Math.round((ratio / size) * 15)));
}

function updateContainerSensor(block) {
  const container = adjacentContainer(block);
  const power = container
    ? measure(container, containerModeOf(block), filterOf(block))
    : 0;
  if (applyStates(block, { "wr:power": power })) scheduleNeighbors(block);
}
registerUpdater("wr:container_sensor", updateContainerSensor);

export const containerSensorComponent = {
  onPlace(e) {
    scheduleUpdate(e.block, updateContainerSensor);
  },
  onTick(e) {
    scheduleUpdate(e.block, updateContainerSensor);
  },
  onPlayerDestroy(e) {
    clearContainerFilter(e.block.dimension.id, e.block.location);
  },
  /**
   * 右クリック … 測る内容を切り替える
   * スニーク + 右クリック … 手に持っているアイテムを「数える対象」に設定
   *   （施錠ブロックにカードをかざすのと同じ、持ち物で設定する操作感）
   */
  onPlayerInteract(e) {
    const block = e.block;
    const player = e.player;
    if (!player) return;

    if (player.isSneaking) {
      const item = heldItem(player);
      if (!item) {
        setFilter(block, "");
        player.onScreenDisplay.setActionBar({ translate: "wr.msg.container.nofilter" });
      } else {
        setFilter(block, item.typeId);
        player.onScreenDisplay.setActionBar({
          translate: "wr.msg.container.filter",
          with: [item.typeId.replace("minecraft:", "")],
        });
      }
      scheduleUpdate(block, updateContainerSensor);
      return;
    }

    const current = block.permutation.getState("wr:mode");
    const next = stepValue(typeof current === "number" ? current : 0, 0, CONTAINER_MODES.length - 1);
    if (applyStates(block, { "wr:mode": next })) scheduleUpdate(block, updateContainerSensor);
    player.onScreenDisplay.setActionBar({
      translate: "wr.msg.container.mode",
      with: { rawtext: [{ translate: CONTAINER_MODE_LABEL[CONTAINER_MODES[next]] }] },
    });
  },
};

/**
 * エンティティセンサーの指定プレイヤー名・コンテナ計測器のフィルタは
 * どちらも座標キーの動的プロパティなので、`onPlayerDestroy` だけでは
 * **爆破されたときに幽霊が残る**（次に同じ場所へ置いたブロックが前の設定を引き継ぐ）。
 * 他のブロック（非対称リピーター等）と同じ理由で blockExplode でも消す。
 */
export function registerSensorCleanup() {
  world.afterEvents.blockExplode?.subscribe((e) => {
    const typeId = e.explodedBlockPermutation?.type?.id;
    if (typeId === "wr:entity_sensor") {
      clearSensorName(e.dimension.id, e.block.location);
    } else if (typeId === "wr:container_sensor") {
      clearContainerFilter(e.dimension.id, e.block.location);
    }
  });
}
