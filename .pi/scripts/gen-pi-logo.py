"""Generate Pi Browser Bridge logos: rounded-square indigo badge with white pi glyph."""
import math
from PIL import Image, ImageDraw

INDIGO = (79, 70, 229, 255)      # #4F46E5
WHITE = (255, 255, 255, 255)

def rounded_rect_mask(size: int, radius_ratio: float) -> Image.Image:
    scale = 4  # supersample for smooth corners
    s = size * scale
    img = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(img)
    r = int(s * radius_ratio)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=255)
    return img.resize((size, size), Image.LANCZOS)

def draw_pi(draw: ImageDraw.ImageDraw, size: int, color):
    """Simple bold pi glyph: horizontal bar + two legs (right leg curves out)."""
    s = size
    w = s * 0.56        # glyph width
    x0 = (s - w) / 2
    y0 = s * 0.26       # top bar y
    bar_h = s * 0.11
    # top bar with slight overhangs
    draw.rounded_rectangle([x0 - s*0.03, y0, x0 + w + s*0.03, y0 + bar_h],
                           radius=bar_h / 2, fill=color)
    leg_w = bar_h
    y_top = y0 + bar_h * 0.8
    y_bot = s * 0.78
    # left leg (straight)
    draw.rounded_rectangle([x0 + s*0.02, y_top, x0 + s*0.02 + leg_w, y_bot],
                           radius=leg_w / 2, fill=color)
    # right leg (straight)
    xr = x0 + w - s*0.02 - leg_w
    draw.rounded_rectangle([xr, y_top, xr + leg_w, y_bot],
                           radius=leg_w / 2, fill=color)

def make_icon(size: int, with_bg: bool) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if with_bg:
        mask = rounded_rect_mask(size, 0.22)
        badge = Image.new("RGBA", (size, size), INDIGO)
        img.paste(badge, (0, 0), mask)
    draw_pi(d, size, WHITE if with_bg else INDIGO)
    return img

if __name__ == "__main__":
    for size in (16, 48, 128):
        make_icon(size, with_bg=True).save(f"icons/icon-{size}.png")
        print(f"icons/icon-{size}.png")
    # popup logo: transparent bg, indigo pi (popup has its own card)
    make_icon(256, with_bg=True).save("pi-logo.png")
    print("pi-logo.png")
