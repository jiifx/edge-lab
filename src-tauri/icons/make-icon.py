# Generates the Edge Lab source icon (1024px PNG) that `npx tauri icon` fans out
# into every platform size. Concept: a lab beaker whose liquid surface IS an
# equity curve breaking above a dashed break-even line - "edge" + "lab" in one
# mark. Palette is the app's own dark panel + go-green so the icon reads as the
# product. Layers are alpha-composited (never Image.paste with a mask, which
# copies source alpha and punches holes in what is underneath).
from PIL import Image, ImageDraw, ImageChops
import math

S = 1024
SS = 4                              # supersample for clean curves
W = S * SS

PANEL = (30, 34, 27, 255)           # --panel dark
GRID = (48, 55, 44, 255)
GO = (99, 177, 130, 255)            # --go dark
GO_FILL = (74, 132, 99, 190)
INK = (231, 233, 223, 255)          # --ink dark
STOP = (217, 108, 91, 205)          # --stop dark


def layer():
    return Image.new("RGBA", (W, W), (0, 0, 0, 0))


def clip(src, shape_mask):
    """Restrict a layer to a shape by multiplying its alpha."""
    out = src.copy()
    out.putalpha(ImageChops.multiply(src.getchannel("A"), shape_mask))
    return out


# ---------- rounded tile ----------
pad, rad = int(W * 0.045), int(W * 0.215)
tile_mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(tile_mask).rounded_rectangle([pad, pad, W - pad, W - pad], radius=rad, fill=255)

base = layer()
ImageDraw.Draw(base).rounded_rectangle([pad, pad, W - pad, W - pad], radius=rad, fill=PANEL)

# ---------- grid paper, clipped to the tile ----------
grid = layer()
gd = ImageDraw.Draw(grid)
step = int(W * 0.062)
for i in range(0, W, step):
    gd.line([(i, 0), (i, W)], fill=GRID, width=max(1, int(W * 0.0022)))
    gd.line([(0, i), (W, i)], fill=GRID, width=max(1, int(W * 0.0022)))
base = Image.alpha_composite(base, clip(grid, tile_mask))

# ---------- beaker geometry ----------
cx = W // 2
neck, body = int(W * 0.150), int(W * 0.310)
top_y, shoulder_y, base_y = int(W * 0.230), int(W * 0.400), int(W * 0.780)
foot = int(W * 0.050)
lw = max(2, int(W * 0.026))

silhouette = [
    (cx - neck, top_y), (cx - neck, shoulder_y),
    (cx - body, base_y - foot), (cx - body + foot, base_y),
    (cx + body - foot, base_y), (cx + body, base_y - foot),
    (cx + neck, shoulder_y), (cx + neck, top_y),
]
inner_mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(inner_mask).polygon(silhouette, fill=255)

# ---------- equity curve = the liquid surface ----------
surface_y = int(W * 0.560)
pts = []
N = 320
for i in range(N + 1):
    t = i / N
    x = (cx - body) + t * (2 * body)
    y = surface_y - (t ** 1.5) * (W * 0.175) + math.sin(t * math.pi * 2.4) * (W * 0.020)
    pts.append((x, y))

# filled liquid under the curve
liquid = layer()
ImageDraw.Draw(liquid).polygon(
    [(cx - body, base_y)] + pts + [(cx + body, base_y)], fill=GO_FILL)
base = Image.alpha_composite(base, clip(liquid, inner_mask))

# dashed break-even line, sitting just under the curve's start
dash = layer()
dd = ImageDraw.Draw(dash)
y0 = surface_y + int(W * 0.026)
x, seg, gap = cx - body, int(W * 0.034), int(W * 0.024)
while x < cx + body:
    dd.line([(x, y0), (min(x + seg, cx + body), y0)], fill=STOP, width=int(W * 0.011))
    x += seg + gap
base = Image.alpha_composite(base, clip(dash, inner_mask))

# the curve itself, bright on top of its own fill
curve = layer()
ImageDraw.Draw(curve).line(pts, fill=GO, width=int(W * 0.024), joint="curve")
base = Image.alpha_composite(base, clip(curve, inner_mask))

# ---------- beaker outline ----------
out = layer()
od = ImageDraw.Draw(out)
rim = int(W * 0.042)
# one continuous stroke rim -> neck -> body -> base -> neck -> rim; drawing this
# as separate segments left mitre gaps at the shoulders
od.line([(cx - neck - rim, top_y)] + silhouette + [(cx + neck + rim, top_y)],
        fill=INK, width=lw, joint="curve")
for i, fy in enumerate((0.42, 0.60, 0.78)):                 # graduation ticks
    yy = top_y + (shoulder_y - top_y) * fy
    t_len = int(W * (0.046 if i == 1 else 0.030))
    od.line([(cx + neck - t_len, yy), (cx + neck - int(W * 0.005), yy)],
            fill=INK, width=max(1, int(W * 0.008)))
base = Image.alpha_composite(base, clip(out, tile_mask))

base = base.resize((S, S), Image.LANCZOS)
base.save("icon-source.png")
print("wrote icon-source.png", base.size)
