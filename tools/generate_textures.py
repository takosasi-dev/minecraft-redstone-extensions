# -*- coding: utf-8 -*-
"""
レッドストーン拡張アドオン — テクスチャ生成スクリプト

外部素材を一切使わずに、16x16 のブロック／アイテムテクスチャと pack_icon を
プログラム的に生成する。バニラのテクスチャは一切コピーしていない。

使い方:
    python tools/generate_textures.py

依存: Pillow
"""

import json
import os
import random
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RP = os.path.join(ROOT, "RedstoneExtRP")
BLOCK_DIR = os.path.join(RP, "textures", "blocks")
ITEM_DIR = os.path.join(RP, "textures", "items")

S = 16  # テクスチャ1辺

# ---- パレット ---------------------------------------------------------------

STONE_D = (78, 78, 80, 255)
STONE_M = (100, 100, 103, 255)
STONE_L = (124, 124, 128, 255)
IRON = (196, 198, 202, 255)
GOLD = (235, 190, 74, 255)
RED_OFF = (108, 24, 24, 255)
RED_ON = (232, 44, 44, 255)
AMETHYST = (162, 108, 224, 255)
AMETHYST_D = (112, 66, 168, 255)
LAMP = (236, 176, 92, 255)
GLASS = (168, 214, 226, 255)
WOOD = (142, 106, 62, 255)
BLACK = (26, 26, 28, 255)
PAPER = (232, 226, 200, 255)
TEAL = (110, 200, 200, 255)
CLEAR = (0, 0, 0, 0)

# ワイヤーの染色 16 色。index 0 = レッド（染色していない既定色）。
# 名前は染料アイテムの識別子（minecraft:<name>_dye）に対応させている。
WIRE_COLORS = [
    ("red", (232, 44, 44)),
    ("white", (238, 238, 238)),
    ("orange", (240, 140, 50)),
    ("magenta", (214, 80, 200)),
    ("light_blue", (90, 175, 235)),
    ("yellow", (238, 214, 70)),
    ("lime", (120, 214, 60)),
    ("pink", (240, 150, 180)),
    ("gray", (90, 94, 98)),
    ("light_gray", (168, 172, 176)),
    ("cyan", (40, 165, 175)),
    ("purple", (140, 70, 200)),
    ("blue", (66, 88, 210)),
    ("brown", (126, 86, 56)),
    ("green", (92, 152, 52)),
    ("black", (40, 40, 44)),
]


def shade(rgb, factor):
    return (
        max(0, min(255, int(rgb[0] * factor))),
        max(0, min(255, int(rgb[1] * factor))),
        max(0, min(255, int(rgb[2] * factor))),
        255,
    )


def new(fill=CLEAR):
    return Image.new("RGBA", (S, S), fill)


def noise(img, base, variants, seed):
    """石っぽいざらつきを載せる。seed 固定なので実行結果は毎回同じ。"""
    rnd = random.Random(seed)
    px = img.load()
    for y in range(S):
        for x in range(S):
            if px[x, y] == base:
                if rnd.random() < 0.28:
                    px[x, y] = variants[rnd.randrange(len(variants))]
    return img


def border(d, color):
    d.rectangle([0, 0, S - 1, S - 1], outline=color)


# ---- ブロックテクスチャ -----------------------------------------------------


def tex_stone_base(seed, base=STONE_M):
    img = new(base)
    noise(img, base, (STONE_D, STONE_L), seed)
    d = ImageDraw.Draw(img)
    border(d, STONE_D)
    return img, d


def transmitter():
    img, d = tex_stone_base(11)
    # 中央のアメジストコア
    d.rectangle([5, 5, 10, 10], fill=AMETHYST_D)
    d.rectangle([6, 6, 9, 9], fill=AMETHYST)
    # 四隅の鉄枠
    for (x, y) in ((1, 1), (13, 1), (1, 13), (13, 13)):
        d.rectangle([x, y, x + 1, y + 1], fill=IRON)
    # 電波を表す破線
    for x in range(2, 14, 3):
        d.point((x, 3), fill=AMETHYST)
        d.point((x, 12), fill=AMETHYST)
    return img


def receiver(on=False):
    img, d = tex_stone_base(12)
    d.rectangle([4, 4, 11, 11], fill=AMETHYST_D)
    d.rectangle([5, 5, 10, 10], fill=LAMP if on else (128, 96, 52, 255))
    d.rectangle([7, 7, 8, 8], fill=(255, 232, 176, 255) if on else (168, 132, 76, 255))
    for (x, y) in ((1, 1), (13, 1), (1, 13), (13, 13)):
        d.rectangle([x, y, x + 1, y + 1], fill=IRON)
    return img


def wire(rgb=(232, 44, 44), on=False):
    """薄板ジオメトリに貼る。背景は透過（alpha_test）。

    バニラのレッドストーンダストに寄せて、
      ・太さ 2px の十字ライン（端に向かって 1px に細る）
      ・中央のノードは少し膨らませる
      ・ラインの縁に暗い影、芯に明るいハイライト
      ・粉っぽさを出すための微妙なざらつき
    で描く。ON では芯を光らせて、消灯時は全体を暗く落とす。
    """
    lit = shade(rgb, 1.0 if on else 0.40)          # ライン本体
    edge = shade(rgb, 0.55 if on else 0.24)        # 縁の影
    core = shade(rgb, 1.45 if on else 0.30)        # 芯のハイライト

    img = new()
    d = ImageDraw.Draw(img)

    # --- 縁（本体より 1px 外側）。先に描いて本体で上書きする ---
    d.rectangle([0, 6, 15, 9], fill=edge)
    d.rectangle([6, 0, 9, 15], fill=edge)

    # --- 本体の十字。端 3px は 1px 幅に細らせる ---
    d.rectangle([3, 7, 12, 8], fill=lit)
    d.rectangle([7, 3, 8, 12], fill=lit)
    for x in range(0, 3):
        d.point((x, 7 + (x % 2)), fill=lit)
        d.point((15 - x, 7 + (x % 2)), fill=lit)
    for y in range(0, 3):
        d.point((7 + (y % 2), y), fill=lit)
        d.point((7 + (y % 2), 15 - y), fill=lit)

    # --- 中央のノード ---
    d.rectangle([6, 6, 9, 9], fill=lit)
    d.rectangle([7, 7, 8, 8], fill=core)

    # --- 芯のハイライト（点灯時のみ、細い線を 1px 走らせる） ---
    if on:
        for x in range(4, 12):
            if x % 3:
                d.point((x, 7), fill=core)
        for y in range(4, 12):
            if y % 3:
                d.point((7, y), fill=core)

    # --- 粉っぽいざらつき ---
    rnd = random.Random(77)
    px = img.load()
    for y in range(S):
        for x in range(S):
            if px[x, y] == lit and rnd.random() < 0.18:
                px[x, y] = edge
    return img


def corner_riser():
    img, d = tex_stone_base(13, STONE_L)
    # レッドストーンダストの粒
    rnd = random.Random(31)
    for _ in range(22):
        x, y = rnd.randrange(2, 14), rnd.randrange(2, 14)
        d.point((x, y), fill=RED_ON if rnd.random() < 0.4 else RED_OFF)
    # 段差を示す斜めの縁
    d.line([0, 15, 15, 0], fill=STONE_D)
    return img


def _gate_side(accent):
    img, d = tex_stone_base(21)
    d.rectangle([0, 10, 15, 15], fill=STONE_D)
    d.rectangle([2, 12, 13, 13], fill=accent)
    return img


def _gate_top(accent, arrow=True, sub_input=True, on=False, bubble=False, glyph=None):
    """上面。矢印はテクスチャ上方向＝出力方向（前面）を指す。

    bubble=True で矢印の先に「否定のマル」を描く（NOT/NAND/NOR/XNOR 用）。
    glyph に点のリストを渡すと、矢印の軸あたりに小さな記号を重ねられる。
    """
    img, d = tex_stone_base(22)
    mark = RED_ON if on else RED_OFF
    if arrow:
        top = 4 if bubble else 2
        d.polygon([(8, top), (3, top + 6), (13, top + 6)], fill=accent)
        d.rectangle([6, top + 6, 9, 13], fill=accent)
        d.rectangle([7, top + 7, 8, 12], fill=mark)
    if bubble:
        d.ellipse([6, 0, 10, 4], outline=accent, fill=mark)
    if glyph:
        for (x, y) in glyph:
            d.point((x, y), fill=STONE_D)
    # 主入力（背面＝テクスチャ下辺）マーカー
    d.rectangle([6, 14, 9, 15], fill=mark)
    if sub_input:
        # 副入力（前面から見て右側面＝テクスチャ右辺）マーカー
        d.rectangle([14, 6, 15, 9], fill=mark)
    return img


def pulse_top(on=False):
    img, d = tex_stone_base(31)
    # 矩形波
    pts = [(1, 11), (1, 5), (5, 5), (5, 11), (9, 11), (9, 5), (14, 5)]
    d.line(pts, fill=RED_ON if on else RED_OFF)
    # 出力方向（テクスチャ上＝前面）
    d.polygon([(8, 0), (5, 3), (11, 3)], fill=IRON)
    return img


def pulse_side():
    img, d = tex_stone_base(32)
    d.rectangle([0, 10, 15, 15], fill=STONE_D)
    d.rectangle([3, 3, 4, 8], fill=RED_ON)
    d.rectangle([11, 3, 12, 8], fill=RED_ON)
    d.rectangle([2, 12, 13, 13], fill=IRON)
    return img


def repeater_top(on=False):
    img, d = tex_stone_base(41)
    d.rectangle([7, 1, 8, 14], fill=AMETHYST_D)
    # 出力方向（テクスチャ上＝前面）
    d.polygon([(8, 0), (4, 4), (12, 4)], fill=AMETHYST)
    # ディレイ段数を示す目盛
    for y in (6, 9, 12):
        d.rectangle([4, y, 11, y], fill=RED_ON if on else IRON)
    return img


def instant_repeater_top(on=False):
    """即時リピーター。可変リピーターと並べたとき一目で違うよう、
    目盛（ディレイ段数）の代わりに二重の矢羽根「≫」を描く。"""
    img, d = tex_stone_base(43)
    accent = TEAL
    # 出力方向（テクスチャ上＝前面）
    d.polygon([(8, 0), (4, 4), (12, 4)], fill=accent)
    d.rectangle([7, 4, 8, 14], fill=accent)
    # 二重の矢羽根＝「遅延なし」の印
    for top in (6, 9):
        d.line([(4, top + 2), (8, top), (12, top + 2)], fill=RED_ON if on else RED_OFF)
    d.rectangle([6, 14, 9, 15], fill=RED_ON if on else RED_OFF)
    return img


def repeater_side():
    img, d = tex_stone_base(42)
    d.rectangle([0, 10, 15, 15], fill=STONE_D)
    d.rectangle([2, 12, 13, 13], fill=AMETHYST)
    return img


def asym_repeater_top(on=False):
    """非対称ディレイリピーター。可変リピーターは目盛が左右対称なのに対して、
    こちらは **左右で長さの違う目盛**を描いて「立ち上がりと立ち下がりで
    遅延が別」であることを一目で分かるようにする。"""
    img, d = tex_stone_base(44)
    d.rectangle([7, 1, 8, 14], fill=AMETHYST_D)
    d.polygon([(8, 0), (4, 4), (12, 4)], fill=GOLD)   # 出力方向
    mark = RED_ON if on else IRON
    # 左半分 = ON 遅延（細かい目盛 3 本）
    for y in (6, 9, 12):
        d.rectangle([2, y, 5, y], fill=mark)
    # 右半分 = OFF 遅延（粗い目盛 2 本）
    for y in (7, 11):
        d.rectangle([10, y, 14, y], fill=mark)
    d.rectangle([6, 14, 9, 15], fill=RED_ON if on else RED_OFF)  # 背面入力
    return img


def asym_repeater_side():
    """側面の帯も左右で色を変えて、可変リピーターと並べたとき区別できるようにする。"""
    img, d = tex_stone_base(45)
    d.rectangle([0, 10, 15, 15], fill=STONE_D)
    d.rectangle([2, 12, 7, 13], fill=AMETHYST)
    d.rectangle([9, 12, 13, 13], fill=GOLD)
    return img


# ---- アイテムテクスチャ -----------------------------------------------------


def threshold_top(on=False):
    """閾値ブロック。上面に「≧」を描く。"""
    img, d = tex_stone_base(51)
    accent = TEAL
    d.polygon([(8, 0), (5, 3), (11, 3)], fill=accent)
    d.rectangle([4, 5, 11, 6], fill=accent)
    d.rectangle([4, 8, 11, 9], fill=accent)
    d.rectangle([4, 12, 11, 13], fill=RED_ON if on else RED_OFF)
    d.rectangle([6, 14, 9, 15], fill=RED_ON if on else RED_OFF)
    return img


def constant_tex(on=False):
    """定数電源ブロック。向きを持たない立方体。"""
    img, d = tex_stone_base(52)
    d.rectangle([3, 3, 12, 12], fill=STONE_D)
    d.rectangle([4, 4, 11, 11], fill=RED_ON if on else RED_OFF)
    for x in (5, 7, 9):
        d.rectangle([x, 6, x, 9], fill=IRON)
    return img


def latch_top(on=False):
    """RSラッチ。上面に S（背面＝セット）と R（右側面＝リセット）を示す。"""
    img, d = tex_stone_base(53)
    d.polygon([(8, 0), (5, 3), (11, 3)], fill=IRON)
    d.rectangle([5, 5, 10, 10], fill=RED_ON if on else RED_OFF)
    d.rectangle([6, 14, 9, 15], fill=(120, 220, 120, 255))  # S = 背面
    d.rectangle([14, 6, 15, 9], fill=(220, 110, 110, 255))  # R = 右側面
    return img


def tff_top(on=False):
    """Tフリップフロップ。上面に T を描く。"""
    img, d = tex_stone_base(54)
    d.polygon([(8, 0), (5, 3), (11, 3)], fill=AMETHYST)
    d.rectangle([4, 5, 11, 6], fill=AMETHYST)
    d.rectangle([7, 6, 8, 11], fill=AMETHYST)
    d.rectangle([6, 14, 9, 15], fill=RED_ON if on else RED_OFF)
    d.rectangle([2, 12, 13, 13], fill=RED_ON if on else RED_OFF)
    return img


def hub_top():
    """チャンネル管理ブロックの上面。フォルダのタブを 3 枚重ねて置く。"""
    img, d = tex_stone_base(61)
    # 奥から手前へ、少しずつずらしたフォルダ
    for i, tint in enumerate((0.55, 0.75, 1.0)):
        y = 3 + i * 4
        d.rectangle([2, y, 13, y + 2], fill=shade(AMETHYST, tint))
        d.rectangle([2, y, 5, y], fill=shade(AMETHYST, tint + 0.2))  # タブ
    d.rectangle([2, 2, 13, 2], fill=IRON)
    return img


def hub_side():
    """側面。引き出し 3 段の書類棚に見せる。"""
    img, d = tex_stone_base(62)
    for y in (2, 7, 12):
        d.rectangle([2, y, 13, y + 2], fill=STONE_D)
        d.rectangle([6, y + 1, 9, y + 1], fill=IRON)  # 取っ手
    d.rectangle([2, 2, 13, 2], fill=AMETHYST)
    return img


# LED パネルの筐体色。ON でも OFF でも変えない
# （実機で色が違って見えるのは、消灯中は暗いところに置かれているだけ）。
LED_HOUSING = (94, 94, 100, 255)
LED_RIM = (40, 40, 44, 255)

# 点灯した LED の明るさの下限（輝度 0〜1）。これを下回る色は白に寄せて持ち上げる。
LED_MIN_LUMA = 0.42
# 色を持ち上げる倍率の上限。無制限にすると黒・灰がほぼ白になって色が分からなくなる。
LED_MAX_GAIN = 2.2


def _luma(rgb):
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255


def led_on(rgb):
    """点灯した LED の発光面の色。

    単純に定数倍すると、黒や灰のように元が暗い色が「点いていない」ように見える。
    かといって白に寄せるだけだと、赤がピンクになって色の判別がつかなくなる。
    そこで 2 段構えにしてある:

      1. **色の比率を保ったまま**、一番強いチャンネルが 255 になるまで持ち上げる
         （赤 → 純度の高い赤のまま明るくなる）。ただし倍率は LED_MAX_GAIN で頭打ち。
      2. それでも暗い（黒・灰）場合だけ、輝度が LED_MIN_LUMA に届くまで白に寄せる。

    白色 LED は 1 段目で純白になるので、実機のスクリーンショットと一致する。
    黒色 LED だけは元が暗すぎて「薄暗く光る灰色」にしかならないが、
    消灯時（ほぼ真っ黒）とは十分に見分けがつく。
    """
    gain = min(255 / max(max(rgb), 1), LED_MAX_GAIN)
    lit = [min(255, c * gain) for c in rgb]

    luma = _luma(lit)
    if luma < LED_MIN_LUMA:
        t = (LED_MIN_LUMA - luma) / (1 - luma)
        lit = [c + (255 - c) * t for c in lit]

    return tuple(int(round(c)) for c in lit) + (255,)


def lamp(rgb=(232, 44, 44), on=False):
    """調光レッドストーンランプ。

    LED パネルの見た目にしてある。灰色の筐体 → 暗い内枠 → 大きな発光面、の 3 層。
    発光面は **べた塗り**（グラデーションもハイライトも入れない）。
    実機のスクリーンショットに合わせた形で、点いているときは面全体が均一に光り、
    消えているときはほぼ真っ黒に落ちる。

    実際の明るさは電力（light_emission）で連続的に変わるので、
    テクスチャは ON / OFF の 2 枚で足りる。
    点灯色の作り方は led_on() のコメントを参照。
    """
    img = new(LED_HOUSING)
    d = ImageDraw.Draw(img)
    # 筐体だけ軽くざらつかせる（発光面は後から塗りつぶすので影響しない）
    noise(img, LED_HOUSING, ((84, 84, 90, 255), (106, 106, 112, 255)), 71)

    # 内枠。発光面が一段奥まって見えるように筐体より暗くする
    d.rectangle([1, 1, S - 2, S - 2], fill=LED_RIM)

    # 発光面。12x12 のべた塗り（グラデーションもハイライトも入れない）
    face = led_on(rgb) if on else shade(rgb, 0.13)
    d.rectangle([2, 2, S - 3, S - 3], fill=face)
    # 発光面のふちだけわずかに沈ませて、平面が浮いて見えないようにする
    d.rectangle([2, 2, S - 3, S - 3], outline=shade(face[:3], 0.82))
    return img


def glow_block(rgb=(232, 44, 44)):
    """発光建材ブロック。

    レッドストーンに関わらない建築用。色つきの結晶が詰まった塊に見せる。
    明るさは右クリックで変えられるが、テクスチャは 1 色 1 枚で済ませている
    （光量はブロックの light_emission 側が担当する）。
    """
    base_rgb = shade(rgb, 0.85)
    img = new(base_rgb)
    d = ImageDraw.Draw(img)

    # 大小の結晶片をばらまく。seed 固定なので毎回同じ模様になる。
    # seed は色から決める（hash() は文字列と違い int タプルなら再現するが、明示する）
    rnd = random.Random(rgb[0] * 65536 + rgb[1] * 256 + rgb[2])
    for _ in range(26):
        x, y = rnd.randrange(1, 14), rnd.randrange(1, 14)
        size = rnd.choice((0, 0, 1))
        d.rectangle([x, y, x + size, y + size], fill=shade(rgb, rnd.uniform(1.15, 1.6)))
    for _ in range(14):
        x, y = rnd.randrange(1, 15), rnd.randrange(1, 15)
        d.point((x, y), fill=shade(rgb, 0.6))

    border(d, shade(rgb, 0.5))
    return img


def light_panel():
    """隠し光源パネル。

    天井や壁に貼っても見た目を壊さないよう、ほぼ透明にしてある。
    まったくの透明だと置いた場所を見失うので、四隅にだけ薄い印を残す。
    """
    img = new()
    d = ImageDraw.Draw(img)
    # うっすらとした膜（アルファ 28/255）
    d.rectangle([0, 0, S - 1, S - 1], fill=(255, 248, 214, 28))
    # 四隅の目印だけ少し濃く
    for (x, y) in ((0, 0), (S - 1, 0), (0, S - 1), (S - 1, S - 1)):
        d.point((x, y), fill=(255, 240, 180, 110))
    return img


# ---- 数値表示・センサー・カウンター ----------------------------------------

# 7 セグメントの点灯パターン（a b c d e f g）。0〜F の 16 進 1 桁ぶん。
#     a
#   f   b
#     g
#   e   c
#     d
SEVEN_SEG = {
    0x0: "abcdef", 0x1: "bc",     0x2: "abdeg",  0x3: "abcdg",
    0x4: "bcfg",   0x5: "acdfg",  0x6: "acdefg", 0x7: "abc",
    0x8: "abcdefg", 0x9: "abcdfg", 0xA: "abcefg", 0xB: "cdefg",
    0xC: "adef",   0xD: "bcdeg",  0xE: "adefg",  0xF: "aefg",
}

# 各セグメントの矩形（16x16 のうち中央 10x14 を使う）。
SEG_RECT = {
    "a": (4, 1, 11, 2),    # 上
    "b": (11, 2, 12, 7),   # 右上
    "c": (11, 8, 12, 13),  # 右下
    "d": (4, 13, 11, 14),  # 下
    "e": (3, 8, 4, 13),    # 左下
    "f": (3, 2, 4, 7),     # 左上
    "g": (4, 7, 11, 8),    # 中央
}

SEG_ON = (255, 96, 72, 255)
SEG_OFF = (58, 30, 30, 255)


def display_digit(value):
    """数値表示ブロックの側面。7 セグ風に 16 進 1 桁を描く。

    消灯セグメントも薄く残す（本物の 7 セグと同じで、
    消えている棒がうっすら見えたほうが数字として読みやすい）。
    """
    img = new(BLACK)
    d = ImageDraw.Draw(img)
    lit = SEVEN_SEG[value]
    for name, (x0, y0, x1, y1) in SEG_RECT.items():
        d.rectangle([x0, y0, x1, y1], fill=SEG_ON if name in lit else SEG_OFF)
    border(d, STONE_D)
    return img


def display_top():
    """上下面。数字は側面だけなので、こちらは筐体の見た目にする。"""
    img, d = tex_stone_base(81)
    d.rectangle([3, 3, 12, 12], fill=BLACK)
    for x in (5, 8, 11):
        d.rectangle([x, 5, x, 10], fill=SEG_OFF)
    return img


def counter_top(on=False):
    """カウンター。上面に「+1」と、たまっている量を示す目盛を描く。"""
    img, d = tex_stone_base(82)
    accent = GOLD
    d.polygon([(8, 0), (5, 3), (11, 3)], fill=accent)   # 出力方向
    # 「+」
    d.rectangle([4, 7, 8, 8], fill=accent)
    d.rectangle([5, 5, 6, 10], fill=accent)
    # 「1」
    d.rectangle([11, 5, 11, 10], fill=accent)
    d.point((10, 6), fill=accent)
    # 入力マーカー（背面 = 下辺、リセット = 右辺）
    d.rectangle([6, 14, 9, 15], fill=RED_ON if on else RED_OFF)
    d.rectangle([14, 6, 15, 9], fill=(220, 110, 110, 255))
    return img


def sensor_top(on=False, night=False):
    """センサーの上面。同心円で「検知範囲」を表す。"""
    img, d = tex_stone_base(83)
    accent = AMETHYST if not night else TEAL
    mark = RED_ON if on else RED_OFF
    for r in (6, 4, 2):
        d.ellipse([8 - r, 8 - r, 7 + r, 7 + r], outline=accent)
    d.rectangle([7, 7, 8, 8], fill=mark)
    return img


def daylight_top(on=False):
    """時刻センサーの上面。太陽（左）と月（右）を並べる。"""
    img, d = tex_stone_base(84)
    d.ellipse([1, 5, 6, 10], fill=GOLD if on else shade(GOLD, 0.4))
    d.ellipse([9, 5, 14, 10], fill=GLASS if not on else shade(GLASS, 0.5))
    d.ellipse([11, 5, 15, 10], fill=STONE_M)  # 月を欠けさせる
    d.rectangle([0, 14, 15, 15], fill=RED_ON if on else RED_OFF)
    return img


# ---- 装飾建材 ---------------------------------------------------------------


def circuit_board():
    """プリント基板。緑地に金の配線とランド（丸い接点）。"""
    green = (26, 92, 54, 255)
    trace = (206, 168, 72, 255)
    img = new(green)
    d = ImageDraw.Draw(img)
    noise(img, green, ((20, 76, 44, 255), (32, 106, 62, 255)), 91)

    # L 字に折れる配線を数本
    for (x0, y0, x1, y1) in ((2, 3, 9, 3), (9, 3, 9, 8), (4, 11, 13, 11),
                             (4, 6, 4, 13), (11, 1, 11, 6)):
        d.rectangle([x0, y0, x1, y1], fill=trace)
    # ランド（穴あきの接点）
    for (x, y) in ((2, 3), (9, 8), (13, 11), (4, 13), (11, 1)):
        d.rectangle([x - 1, y - 1, x + 1, y + 1], fill=trace)
        d.point((x, y), fill=green)
    border(d, (18, 64, 38, 255))
    return img


def cable_panel():
    """配線パネル。太さの違うケーブルを束ねて縦に走らせる。

    向きステートを持たせていないので、どの面から見ても
    「ケーブルが走っている」ように見える柄にしてある。
    """
    img = new(STONE_D)
    d = ImageDraw.Draw(img)
    noise(img, STONE_D, (BLACK, STONE_M), 92)
    # 縦に走るケーブル。色を変えて束に見せる
    cables = ((1, 2, RED_ON), (4, 3, (90, 120, 200, 255)), (8, 2, GOLD),
              (11, 3, (110, 190, 110, 255)))
    for (x, w, color) in cables:
        d.rectangle([x, 0, x + w - 1, 15], fill=color)
        d.rectangle([x, 0, x, 15], fill=shade(color[:3], 0.6))       # 影
        d.rectangle([x + w - 1, 0, x + w - 1, 15], fill=shade(color[:3], 1.3))  # ハイライト
    # 束ねる金具
    for y in (3, 12):
        d.rectangle([0, y, 15, y + 1], fill=IRON)
        d.rectangle([0, y, 15, y], fill=shade(IRON, 0.7))
    return img


def polished_amethyst():
    """研磨アメジストブロック。斜めの面取りで磨いた感じを出す。"""
    img = new(AMETHYST)
    d = ImageDraw.Draw(img)
    noise(img, AMETHYST, (AMETHYST_D, shade(AMETHYST, 1.2)), 93)
    # 面取り（左上を明るく、右下を暗く）
    d.line([0, 0, 15, 0], fill=shade(AMETHYST, 1.35))
    d.line([0, 0, 0, 15], fill=shade(AMETHYST, 1.35))
    d.line([15, 0, 15, 15], fill=shade(AMETHYST, 0.6))
    d.line([0, 15, 15, 15], fill=shade(AMETHYST, 0.6))
    # 中央のひし形
    d.polygon([(8, 3), (13, 8), (8, 13), (3, 8)], outline=shade(AMETHYST, 1.5))
    d.polygon([(8, 6), (10, 8), (8, 10), (6, 8)], fill=shade(AMETHYST, 1.25))
    return img


def machine_panel():
    """機械パネル。通気口とリベットのある工場っぽい面。"""
    img, d = tex_stone_base(94, STONE_M)
    # 中央の通気スリット
    d.rectangle([3, 3, 12, 12], fill=STONE_D)
    for y in range(5, 12, 2):
        d.rectangle([4, y, 11, y], fill=BLACK)
        d.rectangle([4, y + 1, 11, y + 1], fill=shade(STONE_L[:3], 1.0))
    # 四隅のリベット
    for (x, y) in ((1, 1), (14, 1), (1, 14), (14, 14)):
        d.rectangle([x - 1, y - 1, x + 1, y + 1], fill=IRON)
        d.point((x, y), fill=shade(IRON, 0.65))
    return img


def hazard_stripe():
    """警告ストライプ。黄黒の斜め縞。危険区域の床・壁用。"""
    yellow = (232, 196, 56, 255)
    img = new(yellow)
    d = ImageDraw.Draw(img)
    # 斜め 45 度の縞。x + y を 8 で割った余りで塗り分けるとタイルが繋がる
    px = img.load()
    for y in range(S):
        for x in range(S):
            if ((x + y) % 8) < 4:
                px[x, y] = BLACK
    # 上下に金属の縁を入れて「テープ」らしく
    d.rectangle([0, 0, 15, 0], fill=shade(IRON[:3], 0.8))
    d.rectangle([0, 15, 15, 15], fill=shade(IRON[:3], 0.8))
    noise(img, yellow, (shade(yellow[:3], 0.85), shade(yellow[:3], 1.1)), 95)
    return img


def guide_book():
    img = new()
    d = ImageDraw.Draw(img)
    d.rectangle([2, 2, 13, 14], fill=WOOD)
    d.rectangle([3, 3, 12, 13], fill=PAPER)
    d.rectangle([7, 2, 8, 14], fill=shade(WOOD, 0.7))
    d.rectangle([4, 5, 6, 5], fill=RED_ON)
    d.rectangle([4, 7, 6, 7], fill=STONE_D)
    d.rectangle([9, 5, 11, 5], fill=AMETHYST)
    d.rectangle([9, 7, 11, 7], fill=STONE_D)
    d.rectangle([4, 10, 11, 10], fill=RED_ON)
    return img


def remote():
    img = new()
    d = ImageDraw.Draw(img)
    d.rectangle([6, 8, 9, 15], fill=WOOD)          # 棒
    d.rectangle([4, 3, 11, 8], fill=IRON)          # 本体
    d.rectangle([5, 4, 10, 5], fill=AMETHYST)      # アメジスト窓
    d.rectangle([7, 1, 8, 3], fill=RED_ON)         # トーチ先端
    d.point((7, 6), fill=RED_ON)
    d.point((9, 6), fill=BLACK)
    return img


def probe():
    img = new()
    d = ImageDraw.Draw(img)
    d.rectangle([6, 9, 9, 15], fill=WOOD)          # 棒
    d.ellipse([3, 1, 12, 10], fill=GLASS, outline=IRON)
    d.rectangle([6, 4, 9, 7], fill=RED_ON)         # 計測値表示部
    d.point((5, 3), fill=(255, 255, 255, 255))
    return img


def block_dispenser_top(on=False):
    """ブロックディスペンサー。射出口と、押し出されるブロック。"""
    img, d = tex_stone_base(103)
    d.polygon([(8, 0), (4, 4), (12, 4)], fill=IRON)      # 設置方向
    d.rectangle([3, 6, 12, 13], fill=STONE_D)
    d.rectangle([5, 8, 10, 11], fill=WOOD if on else STONE_L)   # 出てくるブロック
    d.rectangle([5, 8, 10, 8], fill=shade(WOOD if on else STONE_L, 1.2))
    return img


def hopper_dropper_top(on=False):
    """ホッパードロッパー。大きく開いた口。"""
    img, d = tex_stone_base(104)
    d.rectangle([1, 1, 14, 14], fill=STONE_D)
    d.polygon([(2, 2), (13, 2), (9, 10), (6, 10)], fill=BLACK)  # 漏斗
    if on:
        d.rectangle([6, 4, 9, 8], fill=GOLD)
    d.rectangle([6, 11, 9, 14], fill=STONE_M)
    return img


def hopper_dropper_side():
    img, d = tex_stone_base(105, STONE_M)
    d.rectangle([0, 2, 15, 6], fill=STONE_D)     # 広い受け口
    d.rectangle([5, 7, 10, 15], fill=STONE_D)    # 首
    d.rectangle([6, 9, 9, 13], fill=BLACK)
    return img


def spike_top(on=False, hot=False):
    """スパイク。上面から突き出た釘。加熱中は赤熱させる。"""
    img, d = tex_stone_base(106, STONE_D)
    tip = IRON
    if hot:
        tip = (240, 120, 50, 255)
    elif on:
        tip = (200, 60, 60, 255)
    # 4 本の釘（中心が明るい＝尖って見える）
    for (x, y) in ((3, 3), (10, 3), (3, 10), (10, 10)):
        d.rectangle([x, y, x + 2, y + 2], fill=shade(tip[:3], 0.6))
        d.rectangle([x + 1, y + 1, x + 1, y + 1], fill=tip)
    d.rectangle([7, 7, 8, 8], fill=shade(tip[:3], 0.8))
    return img


def spike_side():
    img, d = tex_stone_base(107, STONE_D)
    d.rectangle([0, 0, 15, 2], fill=IRON)
    for x in range(1, 15, 4):
        d.polygon([(x, 0), (x + 2, 0), (x + 1, 4)], fill=shade(IRON, 0.75))
    return img


def block_breaker_top(on=False):
    """ブロックブレイカー。前を向いたツルハシの刃。

    ディスペンサーと **左右対称の見た目**にして、並べたときに
    「置く側／壊す側」が一目で分かるようにしてある。
    """
    img, d = tex_stone_base(120)
    d.polygon([(8, 0), (4, 4), (12, 4)], fill=IRON)      # 設置方向（＝壊す方向）
    d.rectangle([3, 6, 12, 13], fill=STONE_D)
    # ツルハシの刃を 2 枚。稼働中は火花の色にする
    edge = GOLD if on else STONE_L
    d.polygon([(4, 12), (7, 7), (8, 8)], fill=edge)
    d.polygon([(11, 12), (8, 7), (7, 8)], fill=edge)
    d.rectangle([7, 9, 8, 12], fill=shade(WOOD, 0.9))    # 柄
    return img


def block_breaker_side():
    img, d = tex_stone_base(121, STONE_M)
    d.rectangle([2, 4, 13, 11], fill=STONE_D)
    d.polygon([(4, 10), (8, 5), (9, 6), (5, 11)], fill=IRON)
    return img


def sound_block_top(on=False):
    """サウンドブロック。中央のスピーカーコーン。"""
    img, d = tex_stone_base(122, STONE_M)
    d.ellipse([2, 2, 13, 13], fill=STONE_D)
    d.ellipse([4, 4, 11, 11], fill=shade(BLACK[:3], 1.4) if not on else GOLD)
    d.ellipse([6, 6, 9, 9], fill=BLACK)
    return img


def sound_block_side():
    """側面。音が広がる様子を同心の弧で表す。"""
    img, d = tex_stone_base(123, STONE_M)
    d.rectangle([1, 5, 5, 10], fill=STONE_D)   # スピーカー
    d.rectangle([2, 6, 4, 9], fill=BLACK)
    for i, x in enumerate((7, 10, 13)):        # 広がる音
        c = shade(IRON, 1.0 - i * 0.2)
        d.arc([x - 4, 3, x + 2, 12], start=300, end=60, fill=c)
    return img


def compare_glyph():
    """比較ブロックの上面に描く「>」。"""
    return [(6, 6), (7, 7), (8, 8), (7, 9), (6, 10), (9, 8)]


def register_glyph():
    """レジスタの上面に描く「H」（Hold）。"""
    return [(6, 6), (6, 7), (6, 8), (6, 9), (6, 10),
            (10, 6), (10, 7), (10, 8), (10, 9), (10, 10),
            (7, 8), (8, 8), (9, 8)]


def config_tool():
    """設定コピー機。クリップボード。"""
    img = new()
    d = ImageDraw.Draw(img)
    d.rectangle([3, 2, 12, 14], fill=shade(WOOD, 0.8))     # 板
    d.rectangle([4, 4, 11, 13], fill=(236, 232, 220, 255))  # 紙
    d.rectangle([6, 1, 9, 3], fill=IRON)                    # クリップ
    for y in (6, 8, 10):                                    # 設定の行
        d.rectangle([5, y, 10, y], fill=shade(STONE_D[:3], 0.9))
    return img


def ore_refiner_top(on=False):
    """鉱石精錬機。上から入って下から出る漏斗と、変換を表す矢印。"""
    img, d = tex_stone_base(99)
    d.polygon([(2, 2), (13, 2), (9, 9), (6, 9)], fill=STONE_D)   # 漏斗
    d.rectangle([6, 9, 9, 13], fill=BLACK)
    core = GOLD if on else STONE_L
    d.rectangle([6, 10, 9, 12], fill=core)
    # 変換の矢印（左右から中央へ）
    d.polygon([(0, 6), (3, 4), (3, 8)], fill=core)
    d.polygon([(15, 6), (12, 4), (12, 8)], fill=core)
    return img


def ore_refiner_side():
    img, d = tex_stone_base(100, STONE_M)
    d.rectangle([2, 1, 13, 5], fill=STONE_D)     # 入口
    d.rectangle([5, 6, 10, 11], fill=BLACK)      # 炉
    d.rectangle([6, 7, 9, 10], fill=GOLD)
    d.rectangle([2, 13, 13, 14], fill=STONE_D)   # 出口
    return img


def xp_tank_top(on=False):
    """XPタンク。上から覗いた液面。"""
    img, d = tex_stone_base(101)
    d.rectangle([2, 2, 13, 13], fill=BLACK)
    fluid = (140, 230, 90, 255) if on else (40, 60, 35, 255)
    d.rectangle([3, 3, 12, 12], fill=fluid)
    # 経験値オーブっぽい粒
    if on:
        for (x, y) in ((5, 5), (9, 6), (6, 10), (10, 10)):
            d.rectangle([x, y, x + 1, y + 1], fill=(220, 255, 170, 255))
    d.rectangle([2, 2, 13, 2], fill=IRON)
    return img


def xp_tank_side():
    """側面。ガラス窓から中の液体が見えるタンク。"""
    img, d = tex_stone_base(102, STONE_M)
    d.rectangle([2, 2, 13, 13], fill=IRON)
    d.rectangle([4, 4, 11, 12], fill=BLACK)
    d.rectangle([5, 7, 10, 11], fill=(140, 230, 90, 255))   # 液面
    d.rectangle([5, 7, 10, 7], fill=(200, 255, 150, 255))
    for y in (4, 12):
        d.rectangle([2, y, 13, y], fill=shade(IRON, 0.7))
    return img


def one_shot_top(on=False):
    """ワンショット。矢印の先に「1発ぶんの短い矩形」を描く。"""
    img, d = tex_stone_base(95)
    accent = GOLD
    d.polygon([(8, 0), (4, 4), (12, 4)], fill=accent)   # 出力方向
    # 単発パルスの波形（立ち上がって、少し続いて、落ちる）
    pts = [(2, 12), (5, 12), (5, 7), (10, 7), (10, 12), (13, 12)]
    d.line(pts, fill=RED_ON if on else RED_OFF)
    d.rectangle([6, 14, 9, 15], fill=RED_ON if on else RED_OFF)  # 背面入力
    return img


def clock_divider_top(on=False):
    """クロックディバイダー。パルス列のうち 1 本だけ濃く描いて「間引き」を表す。"""
    img, d = tex_stone_base(124)
    accent = TEAL
    d.polygon([(8, 0), (4, 4), (12, 4)], fill=accent)   # 出力方向
    mark = RED_ON if on else RED_OFF
    xs = [2, 5, 8, 11]
    for i, x in enumerate(xs):
        color = mark if i == len(xs) - 1 else STONE_L
        d.rectangle([x, 9, x + 2, 14], fill=color)
    d.rectangle([6, 14, 9, 15], fill=mark)  # 背面入力
    return img


def sequencer_top(on=False):
    """シーケンサー。4 方向へ回る矢を描く。"""
    img, d = tex_stone_base(96)
    accent = AMETHYST
    d.polygon([(8, 0), (4, 4), (12, 4)], fill=accent)   # 今の出力方向
    # 回転を表す弧（四隅に点を打つ）
    for (x, y) in ((3, 3), (12, 3), (12, 12), (3, 12)):
        d.rectangle([x - 1, y - 1, x + 1, y + 1], fill=RED_ON if on else RED_OFF)
    d.ellipse([5, 5, 10, 10], outline=accent)
    d.rectangle([7, 7, 8, 8], fill=accent)
    return img


def randomizer_top(on=False):
    """ランダマイザー。サイコロの目。"""
    img, d = tex_stone_base(97)
    d.polygon([(8, 0), (5, 3), (11, 3)], fill=TEAL)     # 出力方向
    d.rectangle([3, 5, 12, 14], fill=PAPER)
    # 5 の目
    for (x, y) in ((5, 7), (10, 7), (7, 9), (5, 12), (10, 12)):
        d.rectangle([x, y, x + 1, y + 1], fill=RED_ON if on else BLACK)
    return img


def weather_sensor_top(on=False):
    """天候センサー。雲と雨粒。"""
    img, d = tex_stone_base(98)
    cloud = STONE_L if not on else (200, 205, 215, 255)
    d.ellipse([2, 3, 8, 8], fill=cloud)
    d.ellipse([6, 2, 13, 8], fill=cloud)
    d.rectangle([3, 6, 12, 8], fill=cloud)
    drop = (110, 170, 235, 255) if on else STONE_D
    for x in (4, 7, 10):
        d.rectangle([x, 10, x, 12], fill=drop)
    return img


def container_sensor_top(on=False):
    """コンテナ計測器の上面。チェストを覗き込む目盛付きの窓。"""
    img, d = tex_stone_base(89)
    d.rectangle([2, 2, 13, 8], fill=BLACK)
    # 中身の量を示すバー
    d.rectangle([3, 4, 8, 6], fill=(GOLD if on else RED_OFF))
    d.rectangle([9, 4, 12, 6], fill=STONE_D)
    # 目盛
    for x in range(3, 13, 3):
        d.rectangle([x, 9, x, 11], fill=IRON)
    d.rectangle([2, 12, 13, 13], fill=WOOD)   # 下に見えるチェスト
    return img


def container_sensor_side():
    img, d = tex_stone_base(90, STONE_M)
    d.rectangle([0, 9, 15, 15], fill=WOOD)
    d.rectangle([6, 11, 9, 12], fill=IRON)    # チェストの金具
    d.rectangle([2, 2, 13, 6], fill=BLACK)
    d.rectangle([3, 3, 7, 5], fill=GOLD)
    return img


def timer_top(on=False):
    """時刻トリガーの上面。時計の文字盤。"""
    img, d = tex_stone_base(91)
    d.ellipse([2, 2, 13, 13], fill=BLACK, outline=IRON)
    # 12/3/6/9 の目盛
    for (x, y) in ((7, 3), (12, 7), (7, 12), (3, 7)):
        d.rectangle([x, y, x + 1, y + 1], fill=IRON)
    hand = GOLD if on else STONE_L
    d.line([(8, 8), (8, 4)], fill=hand)       # 長針
    d.line([(8, 8), (11, 10)], fill=hand)     # 短針
    d.point((8, 8), fill=RED_ON if on else RED_OFF)
    return img


def timer_side():
    img, d = tex_stone_base(92, STONE_M)
    d.rectangle([2, 2, 13, 13], fill=STONE_D)
    d.ellipse([4, 4, 11, 11], outline=GOLD)
    d.line([(8, 8), (8, 5)], fill=GOLD)
    return img


def access_log_top():
    """アクセスログの上面。めくれた記録用紙。"""
    img, d = tex_stone_base(93)
    d.rectangle([2, 1, 13, 14], fill=PAPER)
    for y in range(3, 14, 3):
        d.rectangle([4, y, 11, y], fill=STONE_D)
        d.rectangle([3, y, 3, y], fill=(120, 200, 120, 255) if y % 6 == 3 else (210, 110, 110, 255))
    d.polygon([(13, 1), (13, 4), (10, 1)], fill=STONE_L)   # 折れた角
    return img


def access_log_side():
    img, d = tex_stone_base(94, STONE_D)
    # 積まれた紙の束
    for y in (3, 6, 9, 12):
        d.rectangle([2, y, 13, y + 1], fill=PAPER)
        d.rectangle([2, y + 1, 13, y + 1], fill=shade(PAPER, 0.75))
    d.rectangle([2, 2, 13, 2], fill=IRON)
    return img


def lock_top(on=False):
    """施錠ブロックの上面。カードの差込口とテンキーを描く。"""
    img, d = tex_stone_base(85)
    # 差込口（横長のスリット）
    d.rectangle([2, 2, 13, 4], fill=BLACK)
    d.rectangle([3, 3, 12, 3], fill=shade(IRON, 0.55))
    # テンキー 3x3
    for row in range(3):
        for col in range(3):
            x, y = 3 + col * 4, 6 + row * 3
            d.rectangle([x, y, x + 2, y + 1], fill=IRON if not on else GOLD)
    # 状態ランプ
    d.rectangle([13, 13, 14, 14], fill=(120, 230, 120, 255) if on else RED_OFF)
    return img


def lock_side():
    """側面。鋼板にリベット、中央に鍵穴のシルエット。"""
    img, d = tex_stone_base(86, STONE_D)
    d.rectangle([2, 2, 13, 13], fill=STONE_M)
    # 鍵穴
    d.ellipse([6, 5, 9, 8], fill=BLACK)
    d.polygon([(7, 8), (8, 8), (9, 12), (6, 12)], fill=BLACK)
    for (x, y) in ((1, 1), (14, 1), (1, 14), (14, 14)):
        d.point((x, y), fill=IRON)
    return img


def key_terminal_top():
    """カードキー発行機の上面。カードが1枚出ている排出口。"""
    img, d = tex_stone_base(87)
    d.rectangle([2, 2, 13, 13], fill=STONE_D)
    # 排出口から覗くカード
    d.rectangle([4, 4, 11, 9], fill=AMETHYST)
    d.rectangle([4, 5, 11, 6], fill=GOLD)          # 磁気ストライプ
    d.rectangle([3, 10, 12, 11], fill=BLACK)       # スロット
    return img


def key_terminal_side():
    """側面。カード在庫の窓と操作パネル。"""
    img, d = tex_stone_base(88, STONE_M)
    d.rectangle([2, 2, 13, 7], fill=BLACK)
    d.rectangle([3, 3, 12, 6], fill=shade(AMETHYST, 0.75))
    for y in (9, 12):
        d.rectangle([3, y, 12, y + 1], fill=IRON)
    return img


def card_key():
    """カードキー。角丸っぽく見せた板に磁気ストライプとICチップ。"""
    img = new()
    d = ImageDraw.Draw(img)
    body = AMETHYST
    d.rectangle([2, 4, 13, 12], fill=body)
    # 角を1pxずつ落として丸く見せる
    for (x, y) in ((2, 4), (13, 4), (2, 12), (13, 12)):
        d.point((x, y), fill=CLEAR)
    d.rectangle([2, 6, 13, 7], fill=BLACK)         # 磁気ストライプ
    d.rectangle([4, 9, 6, 11], fill=GOLD)          # IC チップ
    d.rectangle([8, 10, 11, 10], fill=shade(body, 1.4))
    d.rectangle([2, 4, 13, 4], fill=shade(body, 1.3))
    d.rectangle([2, 12, 13, 12], fill=shade(body, 0.7))
    return img


def wrench():
    """配線レンチ。斜めに構えたモンキーレンチ。

    計測器（虫めがね）と並べたときに一目で違うよう、
    金属の輪郭とアメジストのグリップで描き分けている。
    """
    img = new()
    d = ImageDraw.Draw(img)
    steel = IRON
    dark = shade(IRON, 0.62)

    # 柄（左下 → 右上の斜め）
    for i in range(9):
        x, y = 3 + i, 12 - i
        d.rectangle([x, y, x + 1, y + 1], fill=steel)
        d.point((x, y + 1), fill=dark)
    # グリップ
    for i in range(4):
        d.point((3 + i, 12 - i), fill=AMETHYST)

    # 開口部（右上の顎）
    d.rectangle([10, 1, 14, 5], fill=steel)
    d.rectangle([12, 1, 13, 3], fill=CLEAR)   # 口を開ける
    d.rectangle([10, 1, 10, 2], fill=dark)
    d.point((14, 5), fill=dark)
    return img


def pack_icon():
    n = 128
    img = Image.new("RGBA", (n, n), (38, 38, 42, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, n - 1, n - 1], outline=(20, 20, 22, 255), width=4)
    # レッドストーン回路っぽい線
    d.line([16, 64, 112, 64], fill=RED_ON, width=6)
    d.line([64, 16, 64, 112], fill=RED_ON, width=6)
    d.ellipse([48, 48, 80, 80], fill=AMETHYST, outline=AMETHYST_D, width=3)
    for (x, y) in ((16, 64), (112, 64), (64, 16), (64, 112)):
        d.ellipse([x - 9, y - 9, x + 9, y + 9], fill=RED_OFF, outline=IRON, width=2)
    return img


# ---- 出力 -------------------------------------------------------------------

BLOCKS = {
    "wr_transmitter": transmitter,
    "wr_receiver": lambda: receiver(False),
    "wr_receiver_on": lambda: receiver(True),
    "wr_corner_riser": corner_riser,
    "wr_channel_hub_top": hub_top,
    "wr_channel_hub_side": hub_side,
    "wr_pulse_generator_top": lambda: pulse_top(False),
    "wr_pulse_generator_top_on": lambda: pulse_top(True),
    "wr_pulse_generator_side": pulse_side,
    "wr_variable_repeater_top": lambda: repeater_top(False),
    "wr_variable_repeater_top_on": lambda: repeater_top(True),
    "wr_variable_repeater_side": repeater_side,
    "wr_asym_repeater_top": lambda: asym_repeater_top(False),
    "wr_asym_repeater_top_on": lambda: asym_repeater_top(True),
    "wr_asym_repeater_side": asym_repeater_side,
    "wr_instant_repeater_top": lambda: instant_repeater_top(False),
    "wr_instant_repeater_top_on": lambda: instant_repeater_top(True),
    "wr_instant_repeater_side": lambda: _gate_side(TEAL),
    "wr_not_gate_top": lambda: _gate_top(RED_ON, sub_input=False),
    "wr_not_gate_top_on": lambda: _gate_top(RED_ON, sub_input=False, on=True),
    "wr_not_gate_side": lambda: _gate_side(RED_ON),
    "wr_and_gate_top": lambda: _gate_top(IRON),
    "wr_and_gate_top_on": lambda: _gate_top(IRON, on=True),
    "wr_and_gate_side": lambda: _gate_side(IRON),
    "wr_or_gate_top": lambda: _gate_top(GOLD),
    "wr_or_gate_top_on": lambda: _gate_top(GOLD, on=True),
    "wr_or_gate_side": lambda: _gate_side(GOLD),
    # 追加の論理回路
    "wr_xor_gate_top": lambda: _gate_top(AMETHYST),
    "wr_xor_gate_top_on": lambda: _gate_top(AMETHYST, on=True),
    "wr_xor_gate_side": lambda: _gate_side(AMETHYST),
    "wr_nand_gate_top": lambda: _gate_top(IRON, bubble=True),
    "wr_nand_gate_top_on": lambda: _gate_top(IRON, on=True, bubble=True),
    "wr_nand_gate_side": lambda: _gate_side(IRON),
    "wr_nor_gate_top": lambda: _gate_top(GOLD, bubble=True),
    "wr_nor_gate_top_on": lambda: _gate_top(GOLD, on=True, bubble=True),
    "wr_nor_gate_side": lambda: _gate_side(GOLD),
    "wr_xnor_gate_top": lambda: _gate_top(TEAL, bubble=True),
    "wr_xnor_gate_top_on": lambda: _gate_top(TEAL, on=True, bubble=True),
    "wr_xnor_gate_side": lambda: _gate_side(TEAL),
    # 閾値・定数・記憶素子
    "wr_threshold_top": lambda: threshold_top(False),
    "wr_threshold_top_on": lambda: threshold_top(True),
    "wr_threshold_side": lambda: _gate_side(TEAL),
    "wr_constant": lambda: constant_tex(False),
    "wr_constant_on": lambda: constant_tex(True),
    "wr_rs_latch_top": lambda: latch_top(False),
    "wr_rs_latch_top_on": lambda: latch_top(True),
    "wr_rs_latch_side": lambda: _gate_side(IRON),
    "wr_t_flipflop_top": lambda: tff_top(False),
    "wr_t_flipflop_top_on": lambda: tff_top(True),
    "wr_t_flipflop_side": lambda: _gate_side(AMETHYST),
    # 光源
    "wr_light_panel": light_panel,
    # 算術回路（AND/OR と同じ 2 入力のアナログ回路なので同じ絵柄を使う）
    "wr_adder_top": lambda: _gate_top(GOLD, glyph=[(6, 9), (7, 9), (8, 9), (9, 9),
                                                   (7, 8), (7, 10)]),
    "wr_adder_top_on": lambda: _gate_top(GOLD, on=True, glyph=[(6, 9), (7, 9), (8, 9), (9, 9),
                                                              (7, 8), (7, 10)]),
    "wr_adder_side": lambda: _gate_side(GOLD),
    "wr_subtractor_top": lambda: _gate_top(TEAL, glyph=[(6, 9), (7, 9), (8, 9), (9, 9)]),
    "wr_subtractor_top_on": lambda: _gate_top(TEAL, on=True,
                                              glyph=[(6, 9), (7, 9), (8, 9), (9, 9)]),
    "wr_subtractor_side": lambda: _gate_side(TEAL),
    # カウンター・数値表示・センサー
    "wr_counter_top": lambda: counter_top(False),
    "wr_counter_top_on": lambda: counter_top(True),
    "wr_counter_side": lambda: _gate_side(GOLD),
    "wr_display_top": display_top,
    "wr_entity_sensor_top": lambda: sensor_top(False),
    "wr_entity_sensor_top_on": lambda: sensor_top(True),
    "wr_entity_sensor_side": lambda: _gate_side(AMETHYST),
    "wr_daylight_sensor_top": lambda: daylight_top(False),
    "wr_daylight_sensor_top_on": lambda: daylight_top(True),
    "wr_daylight_sensor_side": lambda: _gate_side(GOLD),
    # 設置・排出・トラップ
    "wr_block_dispenser_top": lambda: block_dispenser_top(False),
    "wr_block_dispenser_top_on": lambda: block_dispenser_top(True),
    "wr_block_dispenser_side": lambda: _gate_side(IRON),
    "wr_hopper_dropper_top": lambda: hopper_dropper_top(False),
    "wr_hopper_dropper_top_on": lambda: hopper_dropper_top(True),
    "wr_hopper_dropper_side": hopper_dropper_side,
    "wr_spike_top": lambda: spike_top(False),
    "wr_spike_top_on": lambda: spike_top(True),
    "wr_spike_top_hot": lambda: spike_top(True, True),
    "wr_spike_side": spike_side,
    "wr_block_breaker_top": lambda: block_breaker_top(False),
    "wr_block_breaker_top_on": lambda: block_breaker_top(True),
    "wr_block_breaker_side": block_breaker_side,
    "wr_sound_block_top": lambda: sound_block_top(False),
    "wr_sound_block_top_on": lambda: sound_block_top(True),
    "wr_sound_block_side": sound_block_side,
    # 比較・レジスタ（論理回路と同じひな型。記号で見分ける）
    "wr_compare_top": lambda: _gate_top(TEAL, glyph=compare_glyph()),
    "wr_compare_top_on": lambda: _gate_top(TEAL, on=True, glyph=compare_glyph()),
    "wr_compare_side": lambda: _gate_side(TEAL),
    "wr_register_top": lambda: _gate_top(AMETHYST, glyph=register_glyph()),
    "wr_register_top_on": lambda: _gate_top(AMETHYST, on=True, glyph=register_glyph()),
    "wr_register_side": lambda: _gate_side(AMETHYST),
    # 加工
    "wr_ore_refiner_top": lambda: ore_refiner_top(False),
    "wr_ore_refiner_top_on": lambda: ore_refiner_top(True),
    "wr_ore_refiner_side": ore_refiner_side,
    "wr_xp_tank_top": lambda: xp_tank_top(False),
    "wr_xp_tank_top_on": lambda: xp_tank_top(True),
    "wr_xp_tank_side": xp_tank_side,
    # ワンショット・シーケンサー・ランダマイザー・天候センサー
    "wr_one_shot_top": lambda: one_shot_top(False),
    "wr_one_shot_top_on": lambda: one_shot_top(True),
    "wr_one_shot_side": lambda: _gate_side(GOLD),
    "wr_clock_divider_top": lambda: clock_divider_top(False),
    "wr_clock_divider_top_on": lambda: clock_divider_top(True),
    "wr_clock_divider_side": lambda: _gate_side(TEAL),
    "wr_sequencer_top": lambda: sequencer_top(False),
    "wr_sequencer_top_on": lambda: sequencer_top(True),
    "wr_sequencer_side": lambda: _gate_side(AMETHYST),
    "wr_randomizer_top": lambda: randomizer_top(False),
    "wr_randomizer_top_on": lambda: randomizer_top(True),
    "wr_randomizer_side": lambda: _gate_side(TEAL),
    "wr_weather_sensor_top": lambda: weather_sensor_top(False),
    "wr_weather_sensor_top_on": lambda: weather_sensor_top(True),
    "wr_weather_sensor_side": lambda: _gate_side(GLASS),
    # コンテナ計測器・時刻トリガー・アクセスログ
    "wr_container_sensor_top": lambda: container_sensor_top(False),
    "wr_container_sensor_top_on": lambda: container_sensor_top(True),
    "wr_container_sensor_side": container_sensor_side,
    "wr_timer_top": lambda: timer_top(False),
    "wr_timer_top_on": lambda: timer_top(True),
    "wr_timer_side": timer_side,
    "wr_access_log_top": access_log_top,
    "wr_access_log_side": access_log_side,
    # 施錠
    "wr_lock_top": lambda: lock_top(False),
    "wr_lock_top_on": lambda: lock_top(True),
    "wr_lock_side": lock_side,
    "wr_key_terminal_top": key_terminal_top,
    "wr_key_terminal_side": key_terminal_side,
    # 装飾建材
    "wr_circuit_board": circuit_board,
    "wr_cable_panel": cable_panel,
    "wr_polished_amethyst": polished_amethyst,
    "wr_machine_panel": machine_panel,
    "wr_hazard_stripe": hazard_stripe,
}

# 数値表示ブロックの側面 16 枚（0〜F の 16 進 1 桁）
for _value in range(16):
    BLOCKS["wr_display_%x" % _value] = (lambda v=_value: display_digit(v))

# 染色ワイヤー 16 色 × ON/OFF
for _name, _rgb in WIRE_COLORS:
    BLOCKS[f"wr_wire_{_name}"] = (lambda c=_rgb: wire(c, False))
    BLOCKS[f"wr_wire_{_name}_on"] = (lambda c=_rgb: wire(c, True))

# 調光ランプ 16 色 × ON/OFF と、発光建材 16 色
for _name, _rgb in WIRE_COLORS:
    BLOCKS[f"wr_lamp_{_name}"] = (lambda c=_rgb: lamp(c, False))
    BLOCKS[f"wr_lamp_{_name}_on"] = (lambda c=_rgb: lamp(c, True))
    BLOCKS[f"wr_glow_block_{_name}"] = (lambda c=_rgb: glow_block(c))

ITEMS = {
    "wr_remote": remote,
    "wr_probe": probe,
    "wr_guide_book": guide_book,
    "wr_wrench": wrench,
    "wr_card_key": card_key,
    "wr_config_tool": config_tool,
}


def write_atlas(path, atlas_name, names, folder, extra=None):
    """terrain_texture.json / item_texture.json を書き出す。

    どのエントリも「名前 → textures/<folder>/<名前>」の 1 対 1 対応なので、
    生成したテクスチャの一覧からそのまま作れる。手で足すのを忘れると
    ブロックが読み込まれずクリエイティブから消えるだけなので、機械的に作る。
    """
    data = {name: {"textures": "textures/%s/%s" % (folder, name)}
            for name in sorted(names)}
    doc = {"resource_pack_name": "RedstoneExtRP", "texture_name": atlas_name}
    if extra:
        doc.update(extra)
    doc["texture_data"] = data
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return len(data)


def main():
    os.makedirs(BLOCK_DIR, exist_ok=True)
    os.makedirs(ITEM_DIR, exist_ok=True)
    for name, fn in BLOCKS.items():
        fn().save(os.path.join(BLOCK_DIR, name + ".png"))
    for name, fn in ITEMS.items():
        fn().save(os.path.join(ITEM_DIR, name + ".png"))
    icon = pack_icon()
    icon.save(os.path.join(RP, "pack_icon.png"))
    icon.save(os.path.join(ROOT, "RedstoneExtBP", "pack_icon.png"))

    tex_dir = os.path.join(RP, "textures")
    n_terrain = write_atlas(
        os.path.join(tex_dir, "terrain_texture.json"), "atlas.terrain",
        BLOCKS.keys(), "blocks", {"padding": 8, "num_mip_levels": 4})
    n_item = write_atlas(
        os.path.join(tex_dir, "item_texture.json"), "atlas.items",
        ITEMS.keys(), "items")

    print("generated %d block textures, %d item textures, 2 pack icons"
          % (len(BLOCKS), len(ITEMS)))
    print("wrote terrain_texture.json (%d) / item_texture.json (%d)"
          % (n_terrain, n_item))


if __name__ == "__main__":
    main()
