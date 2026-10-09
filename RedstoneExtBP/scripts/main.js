/**
 * レッドストーン拡張アドオン — エントリポイント
 *
 * 使用API: @minecraft/server 2.0.0 / @minecraft/server-ui 2.0.0
 *          （いずれも安定版のみ。ベータAPIは一切使用していない）
 * 名前空間: すべて `wr:`
 *
 * 実装している内容:
 *   パートA ワイヤレス送受信 + リモコン      … wireless.js
 *   パートB 壁天井対応ワイヤー + 段差コーナー … wire.js
 *   パートC 計測アイテム / パルス生成機 / 可変ディレイリピーター … probe.js, timing.js
 *   パートD 論理回路（NOT/AND/OR/XOR/NAND/NOR/XNOR）+ 閾値 … logic.js
 *   記憶素子（RSラッチ・Tフリップフロップ）と定数電源 … memory.js
 *   パートE 調光ランプ / 発光建材 / 隠し光源パネル … lighting.js
 *   パートF エンティティ / 時刻センサー          … sensors.js
 *   数値表示ブロック（7セグ）                    … display.js
 *   算術回路（加算・減算）は logic.js、カウンターは memory.js
 *   装飾建材 5 種はスクリプト不要（ブロック定義だけ）
 *   薄板ブロックの支持面の自動吸着               … surface.js
 *   配線レンチ（貼りつく面を後から変える）       … wrench.js
 *   パートH 施錠 / カードキー                    … security.js, security_ui.js
 *   共通伝播ロジック（1 tick 遅延方式）      … propagation_helper.js
 *   ワイヤレスチャンネルの永続化             … channels.js
 *   チャンネルのカテゴリー分け / パスワード  … directory.js, hub_ui.js
 *   ガイドブック / リモコンのUI              … book.js, remote_ui.js
 *
 * 安定性の考え方は propagation_helper.js の先頭コメントを参照。
 * 即時性より安定性を優先し、すべての即時反応型ブロックは
 * 「次 tick にまとめて 1 回だけ再計算する」方式で統一している。
 */

import { world, system } from "@minecraft/server";

import { rebuildIndex } from "./channels.js";
import { rebuildDirectory } from "./directory.js";
import { channelHubComponent } from "./hub_ui.js";
import {
  transmitterComponent,
  receiverComponent,
  remoteComponent,
  registerWirelessEvents,
} from "./wireless.js";
import { wireComponent, cornerRiserComponent } from "./wire.js";
import { probeComponent, registerProbeLoop } from "./probe.js";
import {
  pulseGeneratorComponent,
  variableRepeaterComponent,
  asymRepeaterComponent,
  timerComponent,
  oneShotComponent,
  clockDividerComponent,
  sequencerComponent,
  registerTimingLoops,
} from "./timing.js";
import {
  notGateComponent,
  andGateComponent,
  orGateComponent,
  xorGateComponent,
  nandGateComponent,
  norGateComponent,
  xnorGateComponent,
  thresholdComponent,
  adderComponent,
  subtractorComponent,
  instantRepeaterComponent,
  randomizerComponent,
  compareComponent,
  registerLogicCleanup,
} from "./logic.js";
import {
  rsLatchComponent,
  tFlipFlopComponent,
  constantComponent,
  counterComponent,
  registerComponent,
} from "./memory.js";
import { lampComponent, glowBlockComponent, lightPanelComponent } from "./lighting.js";
import {
  entitySensorComponent,
  daylightSensorComponent,
  containerSensorComponent,
  weatherSensorComponent,
  registerWeatherEvents,
  registerSensorCleanup,
} from "./sensors.js";
import { accessLogComponent } from "./access_log.js";
import { oreRefinerComponent, registerRefinerCleanup } from "./refiner.js";
import { xpTankComponent, registerXpTankCleanup } from "./xp_tank.js";
import {
  blockDispenserComponent,
  hopperDropperComponent,
  spikeComponent,
  blockBreakerComponent,
  soundBlockComponent,
} from "./machines.js";
import { registerPlacementTracking } from "./surface.js";
import { lockComponent, keyTerminalComponent, cardKeyComponent } from "./security_ui.js";
import { registerSecurityEvents } from "./security.js";
import { displayComponent } from "./display.js";
import { guideBookComponent } from "./book.js";
import { wrenchComponent } from "./wrench.js";
import { registerDevCommands } from "./dev.js";
import { heldItem } from "./wire.js";
import { tryConfigTool, hasSettings } from "./config_tool.js";

/**
 * 設定コピー機を全ブロック共通で差し込む。
 *
 * **アイテム側ではなくブロック側で判定する。** アイテムの onUseOn と
 * ブロックの onPlayerInteract が両方走ると「設定UIも開くしコピーもされる」
 * という読めない挙動になるため、入口をブロック 1 つに寄せている
 * （染料でワイヤーを染めるのと同じ形）。
 *
 * ここで包んでおけば、各ブロックの実装に手を入れなくても全部に効く。
 * 設定を持たないブロックは素通しなので、包んでも害はない。
 */
function withConfigTool(typeId, component) {
  if (!hasSettings(typeId)) return component;
  const original = component.onPlayerInteract;
  return {
    ...component,
    onPlayerInteract(e) {
      const player = e.player;
      if (player && tryConfigTool(e.block, player, heldItem(player)?.typeId)) return;
      if (original) original.call(component, e);
    },
  };
}

system.beforeEvents.startup.subscribe(({ blockComponentRegistry, itemComponentRegistry }) => {
  // 設定コピー機を挟めるように、登録は必ずこの関数を通す
  const registerBlock = (typeId, component) =>
    blockComponentRegistry.registerCustomComponent(typeId, withConfigTool(typeId, component));
  registerBlock("wr:transmitter", transmitterComponent);
  registerBlock("wr:receiver", receiverComponent);
  registerBlock("wr:wire", wireComponent);
  registerBlock("wr:corner_riser", cornerRiserComponent);
  registerBlock("wr:pulse_generator", pulseGeneratorComponent);
  registerBlock("wr:variable_repeater", variableRepeaterComponent);
  registerBlock("wr:asym_repeater", asymRepeaterComponent);
  registerBlock("wr:not_gate", notGateComponent);
  registerBlock("wr:and_gate", andGateComponent);
  registerBlock("wr:or_gate", orGateComponent);
  registerBlock("wr:xor_gate", xorGateComponent);
  registerBlock("wr:nand_gate", nandGateComponent);
  registerBlock("wr:nor_gate", norGateComponent);
  registerBlock("wr:xnor_gate", xnorGateComponent);
  registerBlock("wr:threshold", thresholdComponent);
  registerBlock("wr:rs_latch", rsLatchComponent);
  registerBlock("wr:t_flipflop", tFlipFlopComponent);
  registerBlock("wr:constant", constantComponent);
  registerBlock("wr:channel_hub", channelHubComponent);
  registerBlock("wr:lamp", lampComponent);
  registerBlock("wr:glow_block", glowBlockComponent);
  registerBlock("wr:light_panel", lightPanelComponent);
  registerBlock("wr:adder", adderComponent);
  registerBlock("wr:subtractor", subtractorComponent);
  registerBlock("wr:instant_repeater", instantRepeaterComponent);
  registerBlock("wr:counter", counterComponent);
  registerBlock("wr:display", displayComponent);
  registerBlock("wr:entity_sensor", entitySensorComponent);
  registerBlock("wr:daylight_sensor", daylightSensorComponent);
  registerBlock("wr:lock", lockComponent);
  registerBlock("wr:key_terminal", keyTerminalComponent);
  registerBlock("wr:access_log", accessLogComponent);
  registerBlock("wr:container_sensor", containerSensorComponent);
  registerBlock("wr:timer", timerComponent);
  registerBlock("wr:one_shot", oneShotComponent);
  registerBlock("wr:clock_divider", clockDividerComponent);
  registerBlock("wr:sequencer", sequencerComponent);
  registerBlock("wr:randomizer", randomizerComponent);
  registerBlock("wr:weather_sensor", weatherSensorComponent);
  registerBlock("wr:ore_refiner", oreRefinerComponent);
  registerBlock("wr:xp_tank", xpTankComponent);
  registerBlock("wr:block_dispenser", blockDispenserComponent);
  registerBlock("wr:hopper_dropper", hopperDropperComponent);
  registerBlock("wr:spike", spikeComponent);
  registerBlock("wr:block_breaker", blockBreakerComponent);
  registerBlock("wr:sound_block", soundBlockComponent);
  registerBlock("wr:compare", compareComponent);
  registerBlock("wr:register", registerComponent);

  itemComponentRegistry.registerCustomComponent("wr:remote", remoteComponent);
  itemComponentRegistry.registerCustomComponent("wr:probe", probeComponent);
  itemComponentRegistry.registerCustomComponent("wr:guide_book", guideBookComponent);
  itemComponentRegistry.registerCustomComponent("wr:wrench", wrenchComponent);
  itemComponentRegistry.registerCustomComponent("wr:card_key", cardKeyComponent);
});

function boot() {
  // 動的プロパティ → メモリ上インデックスの復元。以降の集計はこれを使う。
  rebuildIndex();
  // カテゴリー・パスワードの索引も同じタイミングで復元する。
  rebuildDirectory();
  registerWirelessEvents();
  // 薄板（ワイヤー・光源パネル）の設置向きを、クリックした面から決める。
  registerPlacementTracking();
  // 爆発で壊れた施錠ブロックの記録を掃除する
  registerSecurityEvents();
  // 天候の変化を控えておく（getWeather が使えない版のための保険）
  registerWeatherEvents();
  // 爆発で壊れたセンサー・精錬機・XPタンクの記録を掃除する
  registerSensorCleanup();
  registerRefinerCleanup();
  registerXpTankCleanup();
  registerLogicCleanup();
  registerTimingLoops();
  registerProbeLoop();
  registerDevCommands();
}

// worldLoad が来ればそれで、来ない環境では次 tick で起動する（二重起動はしない）。
let booted = false;
function bootOnce() {
  if (booted) return;
  booted = true;
  try {
    boot();
  } catch (e) {
    console.error(`[wr] boot failed: ${e}`);
  }
}

world.afterEvents.worldLoad?.subscribe(bootOnce);
system.run(bootOnce);
