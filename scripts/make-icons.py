"""Draws the app icons: the default C, and one set per letter A-Z (used when a baby's name is set).

    pip install pillow
    python3 scripts/make-icons.py public/icons [/path/to/serif-bold.ttf]

The server picks the letter from the baby's first initial (see iconLetter in server.js).
"""
import os
import string
import sys

from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1] if len(sys.argv) > 1 else 'public/icons'
FONT = sys.argv[2] if len(sys.argv) > 2 else '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
BG, AMBER, PINK = (20, 18, 26), (242, 166, 90), (232, 143, 168)
SIZES = [('icon-512', 512, False), ('icon-512-maskable', 512, True), ('icon-192', 192, False), ('icon-180', 180, False)]


def make(letter, size, maskable, flat):
    big = size * 4
    k = big / 512
    if maskable or flat:  # full-bleed square: maskable crops it, iOS rounds it
        im = Image.new('RGBA', (big, big), BG + (255,))
    else:
        im = Image.new('RGBA', (big, big), (0, 0, 0, 0))
        ImageDraw.Draw(im).rounded_rectangle([0, 0, big - 1, big - 1], radius=112 * k, fill=BG + (255,))
    d = ImageDraw.Draw(im)
    d.ellipse([(256 - 150) * k, (256 - 150) * k, (256 + 150) * k, (256 + 150) * k], fill=AMBER + (255,))
    d.ellipse([(370 - 22) * k, (150 - 22) * k, (370 + 22) * k, (150 + 22) * k], fill=PINK + (255,))
    d.text((256 * k, 318 * k), letter, font=ImageFont.truetype(FONT, int(190 * k)), fill=BG + (255,), anchor='ms')
    im = im.resize((size, size), Image.LANCZOS)
    return im.convert('RGB') if flat else im


os.makedirs(os.path.join(out, 'letters'), exist_ok=True)
for letter in 'C' + string.ascii_uppercase:
    for name, size, maskable in SIZES:
        img = make(letter, size, maskable, flat=(name == 'icon-180'))
        if letter == 'C':
            path = os.path.join(out, name + '.png')
        else:
            path = os.path.join(out, 'letters', f'{name}-{letter}.png')
        if letter == 'C' and path.endswith('.png') or letter != 'C':
            img.save(path, optimize=True)
