#!/usr/bin/env python
"""Draws the CostHub assets that Cognito managed login needs.

The managed login branding API takes image *files* (base64 blobs), not
CSS, so the app's look has to be baked into pixels. These outputs are
committed next to this script -- see branding/README.md for why -- so
running this is only necessary when the palette or the wordmark change.

    python branding/make-assets.py

Palette and typeface are taken from the frontend, not invented here:
  frontend/src/app/globals.css  -- the HSL custom properties
  frontend/tailwind.config.ts   -- font families (slab = Roboto Slab)
"""
from __future__ import annotations

import os
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent

# frontend/src/app/globals.css, converted from HSL. Keep in step with it.
ATENEO = (0, 69, 103, 255)        # --sidebar / --primary  #004567
CREAM = (242, 238, 227, 255)      # --sidebar-foreground   #f2eee3
BRONZE = (201, 139, 39, 255)      # --sidebar-accent       #c98b27
CLEAR = (0, 0, 0, 0)

# Supersample, then downscale: PIL has no anti-aliased drawing.
SS = 4

# Roboto Slab Bold -- the frontend's `font-slab` display face. Apache-2.0.
# Not committed: the committed PNG is the artifact, this is only needed to
# redraw it. Falls back to Georgia Bold, which is the family's own fallback
# in tailwind.config.ts.
FONT_URL = ("https://fonts.gstatic.com/s/robotoslab/v36/"
            "BngbUXZYTXPIvIBgJJSb6s3BzlRRfKOFbvjoa4OWaA.ttf")
FONT_CACHE = HERE / ".fonts" / "RobotoSlab-Bold.ttf"


def slab_font(size: int) -> ImageFont.FreeTypeFont:
    if not FONT_CACHE.exists():
        try:
            FONT_CACHE.parent.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(FONT_URL, FONT_CACHE)
        except Exception as exc:  # offline, proxy, whatever
            print(f"warning: could not fetch Roboto Slab ({exc});"
                  " falling back to Georgia Bold", file=sys.stderr)
            georgia = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "georgiab.ttf"
            return ImageFont.truetype(str(georgia), size)
    return ImageFont.truetype(str(FONT_CACHE), size)


def cloud(draw: ImageDraw.ImageDraw, x: float, y: float, s: float, fill) -> None:
    """A filled cloud in the s-by-s box at (x, y)."""
    def box(cx, cy, r):
        return [x + (cx - r) * s, y + (cy - r) * s,
                x + (cx + r) * s, y + (cy + r) * s]

    draw.ellipse(box(0.46, 0.50, 0.25), fill=fill)
    draw.ellipse(box(0.24, 0.60, 0.18), fill=fill)
    draw.ellipse(box(0.72, 0.59, 0.20), fill=fill)
    draw.rounded_rectangle(
        [x + 0.06 * s, y + 0.56 * s, x + 0.92 * s, y + 0.79 * s],
        radius=0.11 * s, fill=fill)


def bars(draw: ImageDraw.ImageDraw, x: float, y: float, s: float, fill) -> None:
    """Three ascending bars -- the cost reading inside the cloud."""
    base = y + 0.745 * s
    for i, height in enumerate((0.15, 0.24, 0.33)):
        left = x + (0.28 + i * 0.165) * s
        draw.rounded_rectangle(
            [left, base - height * s, left + 0.105 * s, base],
            radius=0.022 * s, fill=fill)


def mark(size: int, disc: bool) -> Image.Image:
    """The glyph alone. `disc` puts it on a rounded ateneo tile (favicon)."""
    n = size * SS
    img = Image.new("RGBA", (n, n), CLEAR)
    d = ImageDraw.Draw(img)
    if disc:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=0.22 * n, fill=ATENEO)
        pad, body, holes = 0.11 * n, CREAM, ATENEO
    else:
        pad, body, holes = 0.02 * n, CREAM, CLEAR
    inner = n - 2 * pad
    cloud(d, pad, pad, inner, body)
    bars(d, pad, pad, inner, holes)
    return img.resize((size, size), Image.LANCZOS)


def header_logo(w: int = 480, h: int = 120) -> Image.Image:
    """Mark plus wordmark, cream on transparent, for the ateneo header bar.

    2x the 240x60 box Cognito's own default header logo declares, so it
    stays sharp on a HiDPI screen; managed login scales it to the bar.
    """
    img = Image.new("RGBA", (w * SS, h * SS), CLEAR)
    d = ImageDraw.Draw(img)

    glyph = h * 0.80 * SS
    gx, gy = h * 0.10 * SS, h * 0.10 * SS
    cloud(d, gx, gy, glyph, CREAM)
    bars(d, gx, gy, glyph, CLEAR)

    font = slab_font(int(h * 0.50 * SS))
    tx = gx + glyph + h * 0.16 * SS
    # Centre the x-height on the glyph rather than the full ascent/descent,
    # or a slab's deep descenders push the word visibly high.
    top, bottom = font.getbbox("CostHub")[1], font.getbbox("CostHub")[3]
    ty = (h * SS - (top + bottom)) / 2
    d.text((tx, ty), "Cost", font=font, fill=CREAM)
    d.text((tx + d.textlength("Cost", font=font), ty), "Hub", font=font, fill=BRONZE)

    img = img.resize((w, h), Image.LANCZOS)

    # Trim the unused right-hand canvas. Managed login fits the logo to its
    # header box, so trailing transparent pixels would shrink the wordmark.
    left, top, right, bottom = img.getbbox()
    pad = round(h * 0.10)
    return img.crop((0, 0, min(w, right + pad), h))


def main() -> None:
    logo = HERE / "costhub-header-logo.png"
    header_logo().save(logo, optimize=True)
    print(f"wrote {logo.name} ({logo.stat().st_size} bytes)")

    # .ico carries every size it may be asked for; browsers pick one.
    ico = HERE / "costhub-favicon.ico"
    mark(48, disc=True).save(ico, sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"wrote {ico.name} ({ico.stat().st_size} bytes)")

    # A 1x preview on the real header colour, to eyeball the result.
    bar = header_logo()
    preview = Image.new("RGBA", bar.size, ATENEO)
    preview.alpha_composite(bar)
    preview.save(HERE / "preview-header.png")

    icons = mark(48, disc=True)
    icons.resize((96, 96), Image.NEAREST).save(HERE / "preview-favicon.png")
    print("wrote preview-header.png, preview-favicon.png"
          " (not uploaded; for review only)")


if __name__ == "__main__":
    main()
