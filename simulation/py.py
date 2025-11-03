from PIL import Image, ImageDraw

def add_rounded_corners(image_path, radius):
    img = Image.open(image_path).convert("RGBA")
    mask = Image.new("L", img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, img.width, img.height), radius, fill=255)
    img.putalpha(mask)
    img.save("rounded_icon.png")

add_rounded_corners("icon.ico", radius=40)
