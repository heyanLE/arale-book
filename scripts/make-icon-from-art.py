#!/usr/bin/env python3
"""
**【已停用，保留仅为留档】** 从 `build/icon-source.webp` 生成 `build/icon.png`。

图标已经换成素材包 `assets/arale-icons-v2/`（用户绘制 / 生成的阿拉蕾图标，带自己的
README、提示词与 `export.mjs`）。这个脚本生成的旧「あ」字图标既不是当前的品牌图，
继续跑还会把 `build/icon.png` 覆盖成它 —— 所以它现在**直接拒绝执行**，而不是留在
那里等人误跑。要同步图标请用：

    node scripts/make-icon.mjs            # 从素材包同步到 build/ 与渲染进程
    node scripts/make-icon.mjs --export   # 需要重导尺寸时（macOS，sips/iconutil）

下面的实现完整留着：万一以后要回到「代码生成图标」这条路，它记录着怎么抠背景、
怎么裁头像。但它不再被任何 npm script 调用。

用法：`python3 scripts/make-icon-from-art.py`（现在只会打印这段话并以 1 退出）
"""

import sys

print(
    "scripts/make-icon-from-art.py 已停用：图标改用素材包 assets/arale-icons-v2/。\n"
    "请运行 `node scripts/make-icon.mjs`（或 `npm run icon`）同步图标。",
    file=sys.stderr,
)
raise SystemExit(1)

# ---------------------------------------------------------------------------
# 以下是旧实现，保留留档（不可达）。
# ---------------------------------------------------------------------------
from collections import deque  # noqa: E402,F401
from pathlib import Path  # noqa: E402,F401

from PIL import Image, ImageDraw, ImageFilter  # noqa: E402,F401

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "build" / "icon-source.webp"
OUTPUT = ROOT / "build" / "icon.png"

SIZE = 1024
INSET = round(SIZE * 0.08)
RADIUS = round(SIZE * 0.225)
# 近白判定：三个通道都 >= 这个值就算「可能是背景」。
WHITE = 236
# 洪水填充的容差：与种子像素的差在这个范围内才算同色。
TOLERANCE = 30
# 保留的连通块面积下限（相对最大块的占比）。角色的部件都是连在一起的，
# 所以严格的"只留最大块"就够了；留一点点余量是为了防止某个配饰恰好断开。
KEEP_RATIO = 0.02
# 只留正面角色：x 超过这个比例的部分切掉。
FRONT_ONLY_X = 0.52
# 头像占角色包围盒高度的比例（从头往下截）。
PORTRAIT_HEIGHT_RATIO = 0.52


def transparent_background(image: Image.Image) -> Image.Image:
    """从四条边界洪水填充，把与边界连通的近白像素变透明。"""
    image = image.convert("RGBA")
    width, height = image.size
    pixels = image.load()

    def is_background(x: int, y: int) -> bool:
        r, g, b, a = pixels[x, y]
        return a > 0 and r >= WHITE and g >= WHITE and b >= WHITE

    visited = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        for y in (0, height - 1):
            if is_background(x, y) and not visited[y * width + x]:
                visited[y * width + x] = 1
                queue.append((x, y))
    for y in range(height):
        for x in (0, width - 1):
            if is_background(x, y) and not visited[y * width + x]:
                visited[y * width + x] = 1
                queue.append((x, y))

    seeds = list(queue)
    while queue:
        x, y = queue.popleft()
        seed = pixels[x, y][:3]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if nx < 0 or ny < 0 or nx >= width or ny >= height:
                continue
            index = ny * width + nx
            if visited[index]:
                continue
            r, g, b, a = pixels[nx, ny]
            if a == 0:
                visited[index] = 1
                continue
            # 与**种子**比较而不是相邻像素：相邻比较会沿着渐变一路渗进角色内部。
            if (
                r >= WHITE
                and g >= WHITE
                and b >= WHITE
                and abs(r - seed[0]) <= TOLERANCE
                and abs(g - seed[1]) <= TOLERANCE
                and abs(b - seed[2]) <= TOLERANCE
            ):
                visited[index] = 1
                queue.append((nx, ny))

    for y in range(height):
        for x in range(width):
            if visited[y * width + x]:
                r, g, b, _ = pixels[x, y]
                pixels[x, y] = (r, g, b, 0)
    del seeds
    return image


def keep_character(image: Image.Image) -> Image.Image:
    """
    只保留最大的不透明连通块。

    **注意**：单靠这一步去不掉那块粉色背景——它画在角色背后、与轮廓相邻，
    连通性上属于同一块。它的作用是清掉散落的彩点与星星。
    真正的"简洁"靠后面的圆形头像裁切。
    """
    width, height = image.size
    alpha = image.getchannel("A").load()
    seen = bytearray(width * height)
    blobs: list[list[tuple[int, int]]] = []
    for start_y in range(height):
        for start_x in range(width):
            start = start_y * width + start_x
            if seen[start] or alpha[start_x, start_y] == 0:
                continue
            blob: list[tuple[int, int]] = []
            queue = deque([(start_x, start_y)])
            seen[start] = 1
            while queue:
                x, y = queue.popleft()
                blob.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    index = ny * width + nx
                    if seen[index] or alpha[nx, ny] == 0:
                        continue
                    seen[index] = 1
                    queue.append((nx, ny))
            blobs.append(blob)

    if not blobs:
        return image
    largest = max(len(blob) for blob in blobs)
    threshold = largest * KEEP_RATIO
    for blob in blobs:
        if len(blob) >= threshold:
            continue
        for x, y in blob:
            r, g, b, _ = image.getpixel((x, y))
            image.putpixel((x, y), (r, g, b, 0))
    return image


def main() -> int:
    if not SOURCE.exists():
        print(f"找不到源图：{SOURCE}", file=sys.stderr)
        return 1

    art = Image.open(SOURCE).convert("RGBA")
    art = transparent_background(art)
    art = keep_character(art)

    # 只留正面角色。
    cut = int(art.width * FRONT_ONLY_X)
    art = art.crop((0, 0, cut, art.height))
    bbox = art.getbbox()
    if bbox is None:
        print("抠完之后什么都没剩下——检查 WHITE 阈值是不是太激进", file=sys.stderr)
        return 1

    # 头像：从角色包围盒顶部取一个正方形。宽度用包围盒宽度，高度按比例，
    # 然后居中——这样取到的是「头 + 肩」，不是整条人。
    left, top, right, bottom = bbox
    body_h = bottom - top
    side = min(right - left, round(body_h * PORTRAIT_HEIGHT_RATIO))
    center_x = (left + right) // 2
    portrait_box = (center_x - side // 2, top, center_x + side // 2, top + side)
    art = art.crop(portrait_box)

    # 圆角方块底：品牌朱色 → 深一点的同色系，纵向渐变。
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    plate = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(plate)
    top = (232, 116, 90, 255)
    bottom = (150, 46, 32, 255)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        draw.line(
            [(0, y), (SIZE, y)],
            fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(4)),
        )
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [INSET, INSET, SIZE - INSET, SIZE - INSET], radius=RADIUS, fill=255
    )
    plate.putalpha(mask)
    canvas.alpha_composite(plate)

    # 头像居中，占可用区域的 ~82%。
    inner = SIZE - INSET * 2
    side = round(inner * 0.82)
    art = art.resize((side, side), Image.LANCZOS)

    # 圆形遮罩：头像之外全是品牌底色，边缘就不会有粉色块的直边。
    circle = Image.new("L", (side, side), 0)
    ImageDraw.Draw(circle).ellipse([0, 0, side - 1, side - 1], fill=255)
    art.putalpha(Image.composite(art.getchannel("A"), Image.new("L", (side, side), 0), circle))
    # 1px 羽化，免得圆边有锯齿。
    art.putalpha(art.getchannel("A").filter(ImageFilter.GaussianBlur(0.6)))

    offset = (SIZE - side) // 2
    canvas.alpha_composite(art, (offset, offset))

    # 再按圆角裁一次：不能越过方块的圆角。
    final_mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(final_mask).rounded_rectangle(
        [INSET, INSET, SIZE - INSET, SIZE - INSET], radius=RADIUS, fill=255
    )
    canvas.putalpha(Image.composite(canvas.getchannel("A"), Image.new("L", (SIZE, SIZE), 0), final_mask))

    canvas.save(OUTPUT)
    print(f"已生成 {OUTPUT.relative_to(ROOT)}（{SIZE}×{SIZE}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
