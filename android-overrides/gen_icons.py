#!/usr/bin/env python3
# 生成正式图标：深色底 + 「>_」字形（> 用强调蓝，下划线用近白），输出到 res/ 覆盖目录。
# 用法：python3 gen_icons.py  （产物在同目录 res/mipmap-* 与 res/values/）
from PIL import Image, ImageDraw, ImageFont
import math, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'res')
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
BG_TOP = (27, 35, 51)      # #1b2333
BG_BOT = (13, 16, 22)      # #0d1016
ACC = (79, 140, 255)       # #4f8cff
FG = (232, 234, 240)       # #e8eaf0

def gradient(size):
    img = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(size - 1, 1)
        c = tuple(round(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=c)
    # 中央轻微高光
    glow = Image.new('L', (size, size), 0)
    gd = ImageDraw.Draw(glow)
    r = size * 0.55
    gd.ellipse([size/2 - r, size*0.28 - r, size/2 + r, size*0.28 + r], fill=36)
    img = Image.composite(Image.new('RGB', (size, size), (70, 95, 140)), img, glow.point(lambda v: v // 3))
    return img

def draw_glyph(base, scale):
    """在 base（RGBA）上居中画 >_ ：两段同基线绘制（anchor='ls'），scale=总宽占画布比例。"""
    size = base.width
    d = ImageDraw.Draw(base)
    gap_ratio = 0.10  # > 与 _ 的间距（相对 > 字宽）
    def widths(fs):
        f = ImageFont.truetype(FONT, fs)
        return f, d.textlength('>', font=f), d.textlength('_', font=f)
    lo, hi = 10, size
    target = size * scale
    while lo < hi:
        mid = (lo + hi) // 2
        _, wg, wu = widths(mid)
        if wg + wg * gap_ratio + wu < target: lo = mid + 1
        else: hi = mid
    font, wg, wu = widths(max(lo - 1, 8))
    total = wg + wg * gap_ratio + wu
    x = (size - total) / 2
    baseline = size * 0.60  # > 的视觉中心约在基线上方 0.35em，配合字号居中
    d.text((x, baseline), '>', font=font, fill=ACC + (255,), anchor='ls')
    # DejaVu 的 > 字形悬在基线上方，下划线按基线画会显得掉下去，往上提一点贴齐
    d.text((x + wg + wg * gap_ratio, baseline - size * 0.055), '_', font=font, fill=FG + (255,), anchor='ls')
    return base

def make_full(size, round_icon=False):
    SS = 4
    big = gradient(size * SS).convert('RGBA')
    draw_glyph(big, 0.52)
    if round_icon:
        mask = Image.new('L', (size * SS, size * SS), 0)
        md = ImageDraw.Draw(mask)
        md.ellipse([0, 0, size * SS, size * SS], fill=255)
        out = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
        out.paste(big, (0, 0), mask)
        big = out
    return big.resize((size, size), Image.LANCZOS)

def make_foreground(size):
    SS = 4
    big = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    draw_glyph(big, 0.40)  # 自适应图标安全区内留足边
    return big.resize((size, size), Image.LANCZOS)

LAUNCHER = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
FOREGROUND = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
for dpi, s in LAUNCHER.items():
    d = os.path.join(OUT, 'mipmap-' + dpi)
    os.makedirs(d, exist_ok=True)
    make_full(s).save(os.path.join(d, 'ic_launcher.png'))
    make_full(s, round_icon=True).save(os.path.join(d, 'ic_launcher_round.png'))
for dpi, s in FOREGROUND.items():
    d = os.path.join(OUT, 'mipmap-' + dpi)
    make_foreground(s).save(os.path.join(d, 'ic_launcher_foreground.png'))
os.makedirs(os.path.join(OUT, 'values'), exist_ok=True)
with open(os.path.join(OUT, 'values', 'ic_launcher_background.xml'), 'w') as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0d1016</color>\n</resources>\n')
print('icons written to', OUT)
