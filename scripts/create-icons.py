from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent / 'public' / 'icons'
root.mkdir(parents=True, exist_ok=True)
for size in (16, 48, 128):
    scale = 4
    im = Image.new('RGBA', (size * scale, size * scale), (246, 244, 238, 255))
    d = ImageDraw.Draw(im)
    n = size * scale
    d.rounded_rectangle((1, 1, n - 2, n - 2), radius=n * .22, fill='#9b4c35')
    d.line((n * .25, n * .24, n * .25, n * .77), fill='#e3d4ad', width=max(1, int(n * .025)))
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/georgiai.ttf', int(n * .58))
    except OSError:
        font = ImageFont.load_default(size=int(n * .55))
    d.text((n * .38, n * .08), 'm', font=font, fill='#fffdf8')
    im.resize((size, size), Image.Resampling.LANCZOS).save(root / f'{size}.png')
print('已生成 DS Margin 图标')
