#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""aralebook 的 manga-anki OCR 桥接脚本。

为什么需要这一层：识别本身必须跑在**用户本机那套 Python 环境**里
（`comic_text_detector` + `manga_ocr`，见 manga_anki 的
`factory/skills/manga-anki/scripts/ocr.py`），而应用是 Node/Electron。
两边只能靠一个进程边界对接，于是这里把「一本书」压成**一次进程启动**：
模型只加载一次，逐页吐结果。

为什么不复用他们那个 `ocr.py`：它绑死在他们的 `projectlib`（workspace/project/
volume 概念）和按页断点缓存上，还依赖 `importlib.metadata` 的版本断言。我们只需要
它中间那 15 行核心循环，所以这里把核心循环照抄过来（检测 → 整块裁剪 → manga-ocr），
但输入输出协议换成我们自己的 NDJSON。**`factory/skills/manga-anki/` 下的东西是只读的，
一个字都不改。**

用法（用 venv 里的 python 跑）：

    <root>/factory/.ocr-venv/bin/python scripts/ocr-bridge.py \\
        --manga-anki-root <root> --pages-file /tmp/pages.json

`--pages-file` 是引擎实际用的形式：JSON，`{"pages":[{"rel","absPath","width","height"}]}`
（也接受裸数组）。为什么不用 `--pages a b c`：一卷两三百页的绝对路径拼进 argv 有撞
`ARG_MAX` 的风险，而且清单里带上 `rel` 便于和书目录对齐。手工调试时仍可用

    ... scripts/ocr-bridge.py --manga-anki-root <root> --pages /abs/p1.png /abs/p2.png

stdout 是**纯 NDJSON 流**（一行一个 JSON 对象，逐行 flush），stderr 是人类日志。

输出遵循应用里的**统一 OCR 页面协议**（`src/shared/ocr-protocol.ts`）：

    {"kind":"meta","engine":"comictextdetector+manga-ocr","languages":["ja-JP"],"requested":["ja-JP"]}
    {"kind":"page","file":"/abs/001.jpg","ok":true,"width":1441,"height":2048,
     "lines":[{"text":"…","confidence":1.0,"box":[x1,y1,x2,y2],"vertical":true}]}
    {"kind":"page","file":"/abs/003.jpg","ok":false,"error":"RuntimeError: …"}   # 单页失败不影响整本
    {"kind":"fatal","error":"…"}                                                  # 整本没法跑

为什么不再用自己那套 `type/ready/done`：应用现在有**三种** OCR 来源（macOS Vision、
Windows.Media.Ocr、这个扩展），各说一套 JSON 就要在主进程里为每种写一份解析器。
统一之后 `main/ocr/runner.ts` 一个解析器吃全部，加引擎不必碰解析代码。

`lines` 而不是 `blocks`：mokuro 的「块」在这里降级成**一个块 = 一行**，排序与成块交给
应用侧的 `core/ocr/reading-order.ts` + `blocks.ts`。这样三个引擎的阅读顺序规则是同一份
实现——而不是各写一份、各自有各自的 bug。

坐标一律是**原图像素**（阅读器按 `page.width/height` 缩放文字层，中途缩放过就会错位）。
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# 离线开关：必须在 import torch / transformers / huggingface_hub **之前**设好，
# 否则它们在 import 期就会去探网。`ocr.py` 只设 HF_HUB_*，这里补上 transformers
# 自己的开关——目的相同：用户没网时不能因为「检查更新」卡住或报错。
# ---------------------------------------------------------------------------
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

# --- 相对「factory 目录」的固定布局（与 provider 的 status() 检查必须一致）---
PYTHON_REL = Path(".ocr-venv/bin/python")
DETECTOR_REL = Path(".models/mokuro-cache/manga-ocr/comictextdetector.pt")
MODEL_DIR_REL = Path(".models/manga-ocr-base")
RECOGNIZER_REL = MODEL_DIR_REL / "pytorch_model.bin"

ENGINE_NAME = "comictextdetector+manga-ocr"
ROOT_ENV = "ARALE_MANGA_ANKI_ROOT"


# ---------------------------------------------------------------------------
# stdout 纯净性
# ---------------------------------------------------------------------------


class NdjsonWriter:
    """只往真正的 stdout 写一行一个 JSON，其他一切走 stderr。

    `main()` 会先把 fd 1 复制出来、再把 fd 1 指向 fd 2，于是**任何**库的
    `print()`/进度条都落到 stderr，永远不会污染 NDJSON 流。这不是洁癖：
    Node 端是逐行 `JSON.parse` 的，混进一行「Loading model…」就整本书失败。
    """

    def __init__(self, fd: int) -> None:
        self._stream = os.fdopen(fd, "w", encoding="utf-8", buffering=1)

    def send(self, payload: Dict[str, Any]) -> None:
        try:
            self._stream.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self._stream.flush()
        except BrokenPipeError:
            # 父进程（Node）已经死了：再写也没人收，安静退出，别刷 traceback。
            os._exit(0)
        except ValueError:
            # 流被关闭（解释器收尾阶段）——同样没什么可做的。
            os._exit(0)

    def flush(self) -> None:
        try:
            self._stream.flush()
        except Exception:
            pass


def _make_writer() -> NdjsonWriter:
    original_stdout = os.dup(1)
    os.dup2(2, 1)  # fd1 → stderr；sys.stdout 从此只能污染 stderr
    return NdjsonWriter(original_stdout)


def _log(message: str) -> None:
    print(f"[arale-ocr] {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# 参数 / 路径
# ---------------------------------------------------------------------------


def _parse_args(argv: Optional[List[str]]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="aralebook × manga-anki OCR 桥（NDJSON over stdout）",
    )
    parser.add_argument(
        "--manga-anki-root",
        default=None,
        help=f"manga_anki 仓库根；缺省时读环境变量 {ROOT_ENV}",
    )
    parser.add_argument(
        "--pages",
        nargs="*",
        default=[],
        help="手工调试用：一串页图绝对路径（与 --pages-file 二选一）",
    )
    parser.add_argument(
        "--pages-file",
        default=None,
        help='页清单 JSON：{"pages":[{"rel","absPath","width","height"}]}（引擎走这条）',
    )
    parser.add_argument("--detector-size", type=int, default=1024)
    args = parser.parse_args(argv)
    if args.pages and args.pages_file:
        parser.error("--pages 与 --pages-file 只能给一个")
    if not args.pages and not args.pages_file:
        parser.error("必须给 --pages 或 --pages-file")
    return args


def _resolve_root(explicit: Optional[str]) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    from_env = os.environ.get(ROOT_ENV)
    if from_env:
        return Path(from_env).expanduser().resolve()
    _log(f"缺少 --manga-anki-root，且环境变量 {ROOT_ENV} 也没设")
    raise SystemExit(2)


def factory_dir(root: Path) -> Path:
    """把 root 归一成「factory 目录」。

    正常传的是 manga_anki 仓库根（`<root>/factory/.ocr-venv/...`），但用户也可能
    直接把 `--manga-anki-root` 指到 `factory/`，甚至指向一份布局不同的检出。
    先看两个候选里哪个真的有 `.ocr-venv`/`.models`，都没有时按规范布局报错。
    """
    candidates = [root / "factory", root]
    for candidate in candidates:
        if (candidate / ".ocr-venv").exists() or (candidate / ".models").exists():
            return candidate
    return root / "factory"


def _load_pages(args: argparse.Namespace) -> List[Dict[str, Any]]:
    if args.pages:
        return [{"rel": "", "absPath": str(Path(p).expanduser().resolve())} for p in args.pages]

    try:
        raw = json.loads(Path(args.pages_file).read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 —— 这是启动期，报错要直达人眼
        _log(f"读不了页清单 {args.pages_file}：{exc!r}")
        raise SystemExit(2)

    items = raw.get("pages") if isinstance(raw, dict) else raw
    if not isinstance(items, list) or not items:
        _log(f"页清单里没有 pages 数组：{args.pages_file}")
        raise SystemExit(2)

    pages: List[Dict[str, Any]] = []
    for position, item in enumerate(items):
        if not isinstance(item, dict):
            _log(f"页清单第 {position} 项不是对象")
            raise SystemExit(2)
        abs_path = item.get("absPath")
        if not isinstance(abs_path, str) or not abs_path:
            _log(f"页清单第 {position} 项缺少 absPath")
            raise SystemExit(2)
        pages.append(
            {
                "rel": str(item.get("rel", "")),
                "absPath": abs_path,
                "width": item.get("width"),
                "height": item.get("height"),
            }
        )
    return pages


# ---------------------------------------------------------------------------
# 模型
# ---------------------------------------------------------------------------


def _load_models(detector_path: Path, model_dir: Path, detector_size: int) -> Tuple[Any, Any]:
    """加载检测器 + 识别器。**整本书只调一次**——这是书级接口的全部意义。"""
    import torch  # noqa: PLC0415 —— 延迟 import，让 stdout 重定向先生效
    from comic_text_detector.inference import TextDetector  # noqa: PLC0415
    from manga_ocr import MangaOcr  # noqa: PLC0415

    # 与他们 ocr.py 一致：CPU 上固定 4 线程。给太多线程反而因为争抢变慢。
    torch.set_num_threads(4)
    detector = TextDetector(
        model_path=str(detector_path),
        input_size=detector_size,
        device="cpu",
        act="leaky",
    )
    recognizer = MangaOcr(str(model_dir), force_cpu=True)
    return detector, recognizer


def _process_page(
    detector: Any,
    recognizer: Any,
    abs_path: str,
    detector_size: int,
) -> Tuple[List[Dict[str, Any]], int, int]:
    """识别一页，返回（块列表, 宽, 高）。块坐标是原图像素。"""
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    with Image.open(abs_path) as src:
        src.load()
        im = src.convert("RGB")
    width, height = im.size

    # 检测器吃 BGR（与他们 ocr.py 的转换方向一致：PIL 是 RGB，cv2 要 BGR）。
    bgr = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
    _, _, blocks = detector(bgr, refine_mode=1, keep_undetected_mask=True)

    results: List[Dict[str, Any]] = []
    for block_index, block in enumerate(blocks):
        vertical = bool(block.vertical)
        # **一行/一列一条**，每条用自己的框。
        #
        # 这里曾经是「整块裁、整块识别，一块一条」，也就是「划词总偏一个字」的根因。
        # 改动前请读完这段：
        #
        # `comictextdetector` 的 `block` 是**区域级**的——一个对话气泡、一段旁白，
        # 内部还有多行（横排）或多列（竖排）。而 `manga_ocr.post_process()` 里有
        # `"".join(text.split())`，把识别结果里的**换行和空格全吃掉了**，所以
        # 「整块喂一次识别」只能拿到一坨没有分隔符的文本，行列结构彻底丢失。
        #
        # 阅读器拿到的是 `{box: 整个区域, lines: [一整段文字]}`，只能靠
        # `sqrt(W·H/N)` 去**猜**这段文字排成了几行几列。实测 14 个真实方块里有 6 个
        # 猜错（竖排 36×98 字高 30 共 5 字：真值「2 列」，面积法算出「1 列」），猜错
        # 的行列数 ⇒ 字符下标到像素的映射非线性 ⇒ 划词高亮和看到的字对不上。
        #
        # 检测器其实**已经给了**每行每列的多边形（`block.lines`；实测竖排块 3 列就是
        # 3 个 34×216 这样的窄高矩形）。按列裁、按列识别、一列一条，几何就是精确的：
        # 块的框 = 这段文字真正占的矩形，`lines` 里只有一段文字，阅读器 `layoutOf`
        # 算出 `count=1`，映射退化成线性，不需要任何猜测。
        #
        # 按列裁是安全的：manga-ocr 是**单行/单列**模型，按列裁正是它的训练口径
        # （mokuro 自己也是这么切的）。会切坏的是「把一列切成一个个单字」——那是按字
        # 切，不是按 `block.lines` 切，`block.lines` 给的是整列。
        for box in _line_boxes(block, width, height):
            text = recognizer(im.crop((box[0], box[1], box[2], box[3])))
            if not isinstance(text, str) or not text.strip():
                continue
            results.append(
                {
                    "box": box,
                    "vertical": vertical,
                    # 与排版方向垂直的那条边就是字格边长（竖排看宽度、横排看高度）。
                    "fontSize": float(box[2] - box[0] if vertical else box[3] - box[1]),
                    "text": text,
                    "block": block_index,
                }
            )
    return _drop_containers(results), width, height


def _drop_containers(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """丢掉「粗框包住若干细框、且文字正好是细框拼接」的重复条目。

    `refine_mode=1` + `keep_undetected_mask=True` 会同时给出**细化后的列**和**粗的
    原始块**，两者覆盖同一片像素。实测 171 页里有 23 页出现（40 个粗框）：第 022 页
    一个 111×272 的粗框文字「現実はどうだかわかんなくて怖い」，正好等于它内部两个细列
    「現実はどうだか」(40×230) +「わかんなくて怖い」(34×254) 的拼接。

    留着它们不只是「多一份文字」：粗框内部仍有两列，阅读器还得靠面积去猜列数，
    **于是那一片区域照旧偏移**——用户划到那里会觉得「修了个寂寞」。

    三条判据同时成立才丢，避免误删真实文本：
    1. 至少 **2 个别的块**的行框被它包住（只包住一个不算）；
    2. 细框文字总字数 ≈ 粗框字数（0.75～1.35 倍）——这是「同一段文字被拆细了」的
       直接证据，真实嵌套（注音、旁批）凑不出这个字数比；
    3. 粗框自身在别处不被当成细框。

    文字**不会因此丢失**：细框认的是同一片像素，而且按列认比整块认更准。
    """
    kept: List[Dict[str, Any]] = []
    for index, entry in enumerate(entries):
        inner = [
            other
            for other_index, other in enumerate(entries)
            if other_index != index
            and other["block"] != entry["block"]
            and _contains(entry["box"], other["box"])
        ]
        if len(inner) >= 2:
            inner_chars = sum(len(other["text"]) for other in inner)
            outer_chars = len(entry["text"])
            if inner_chars > 0 and 0.75 <= outer_chars / inner_chars <= 1.35:
                continue  # 粗框 = 细框的拼接，丢掉粗的那份
        kept.append(entry)
    for entry in kept:
        entry.pop("block", None)
    return kept


def _contains(outer: List[int], inner: List[int]) -> bool:
    """`inner` 是否基本被 `outer` 包住（交叠 ≥ inner 面积的 85%）。"""
    overlap_x = max(0, min(outer[2], inner[2]) - max(outer[0], inner[0]))
    overlap_y = max(0, min(outer[3], inner[3]) - max(outer[1], inner[1]))
    inner_area = max(1, (inner[2] - inner[0]) * (inner[3] - inner[1]))
    return overlap_x * overlap_y >= 0.85 * inner_area


def _line_boxes(block: Any, width: int, height: int) -> List[List[int]]:
    """把一个检测块的 `lines` 多边形转成整数框（原图像素，已外扩、已夹取）。

    多边形在 `comictextdetector` 里是 8 个数的四点矩形（有些版本给 4 个数的 xyxy），
    两种都认。取不到 `lines` 时**退回整块**——宁可退化成旧的「一坨文字」行为，
    也不能把这块文字整个丢掉。
    """
    import numpy as np  # noqa: PLC0415

    raw = getattr(block, "lines", None)
    if raw is None or len(raw) == 0:
        return [_block_box(block, width, height)]

    array = np.asarray(raw, dtype=np.float64)
    if array.ndim == 1:
        array = array.reshape(1, -1)
    elif array.ndim > 2:
        # 实测这一版给的是 `list[ndarray[(4,2)]]` → (n,4,2)，**不是** (n,8)。
        # 曾经因为只认 (n,8) 而整页退回整块框（表现：一页 33 行只出 14 行，
        # 划词照旧偏移）。多边形统一摊平成 `x0,y0,x1,y1,…`，比按维度分支稳。
        array = array.reshape(array.shape[0], -1)
    if array.ndim != 2 or array.shape[1] < 4:
        return [_block_box(block, width, height)]
    if array.shape[1] >= 8:
        xs = array[:, 0::2]
        ys = array[:, 1::2]
    else:
        xs = array[:, [0, 2]]
        ys = array[:, [1, 3]]

    # 行/列框比块框更紧，外扩要更小：外扩太多会把相邻的列一起吃进来，
    # 而这里的全部意义就是「一列就是一个列，一个字都不多」。
    pad = max(2, int(float(block.font_size) * 0.10))
    boxes: List[List[int]] = []
    for index in range(array.shape[0]):
        box = [
            max(0, int(xs[index].min()) - pad),
            max(0, int(ys[index].min()) - pad),
            min(width, int(xs[index].max()) + pad),
            min(height, int(ys[index].max()) + pad),
        ]
        if box[2] > box[0] and box[3] > box[1]:
            boxes.append(box)
    return boxes if boxes else [_block_box(block, width, height)]


def _block_box(block: Any, width: int, height: int) -> List[int]:
    """整块框（`block.xyxy` 外扩）——`lines` 拿不到时的兜底，也就是旧行为。"""
    x1, y1, x2, y2 = [int(v) for v in block.xyxy]
    pad = max(3, int(float(block.font_size) * 0.12))
    return [
        max(0, x1 - pad),
        max(0, y1 - pad),
        min(width, x2 + pad),
        min(height, y2 + pad),
    ]


# ---------------------------------------------------------------------------
# 信号
# ---------------------------------------------------------------------------


def _install_signal_handlers(writer: NdjsonWriter) -> None:
    """Ctrl-C / SIGTERM（Node 取消时就是这个）要干净退出。

    torch 的推理卡在 C 层时信号处理会被推迟到当前算子返回，所以这里用
    `os._exit` 立即走人——父进程已经不要结果了，多等一秒都是浪费。
    退出码按 128+signum 给（130/143），Node 侧靠 signal 判断是取消而不是崩溃。
    """

    def handler(signum: int, _frame: Any) -> None:
        _log(f"收到信号 {signum}，退出")
        writer.flush()
        os._exit(128 + signum)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, handler)
        except (ValueError, OSError):
            # 非主线程或不支持该信号时忽略——取消路径不是必须的。
            pass


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main(argv: Optional[List[str]] = None) -> int:
    args = _parse_args(argv)
    writer = _make_writer()
    _install_signal_handlers(writer)

    root = _resolve_root(args.manga_anki_root)
    pages = _load_pages(args)
    factory = factory_dir(root)
    detector_path = factory / DETECTOR_REL
    model_dir = factory / MODEL_DIR_REL

    missing = [str(p) for p in (detector_path, model_dir / "pytorch_model.bin") if not p.is_file()]
    if missing:
        message = f"manga_anki 环境不完整，缺少：{'、'.join(missing)}"
        _log(message)
        writer.send({"kind": "fatal", "error": message})
        return 1

    _log(f"正在加载 manga-anki 模型（{factory}）…")
    try:
        detector, recognizer = _load_models(detector_path, model_dir, args.detector_size)
    except Exception as exc:  # noqa: BLE001 —— 加载失败必须把 traceback 留给 stderr
        import traceback  # noqa: PLC0415

        traceback.print_exc(file=sys.stderr)
        writer.send({"kind": "fatal", "error": f"{type(exc).__name__}: {exc}"})
        return 1

    writer.send(
        {
            "kind": "meta",
            "engine": ENGINE_NAME,
            # manga-ocr 是日语模型，没有别的语言可选。写上是为了和 Vision 那边
            # 的「实际生效语言」字段对齐，主进程不必按引擎分支。
            "languages": ["ja-JP"],
            "requested": ["ja-JP"],
        }
    )

    failed = 0
    for index, page in enumerate(pages):
        started = time.monotonic()
        try:
            blocks, width, height = _process_page(
                detector, recognizer, page["absPath"], args.detector_size
            )
        except Exception as exc:  # noqa: BLE001 —— 单页失败不能毁掉整本
            import traceback  # noqa: PLC0415

            failed += 1
            _log(f"第 {index} 页失败（{page['absPath']}）：{exc!r}")
            traceback.print_exc(file=sys.stderr)
            writer.send(
                {
                    "kind": "page",
                    "file": page["absPath"],
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
            continue
        writer.send(
            {
                "kind": "page",
                "file": page["absPath"],
                "ok": True,
                "width": width,
                "height": height,
                # 一个 mokuro **行/列** → 一行（`_process_page` 里已经按 `block.lines`
                # 拆开了）。每一条都带着自己那一列的框，所以下游不需要猜排版。
                # `confidence` 填 1.0：检测器不给置信度，而协议要求它是 0..1 的数，
                # 填 0 会让下游以为这行不可信。
                "lines": [
                    {
                        "text": block["text"],
                        "confidence": 1.0,
                        "box": block["box"],
                        "vertical": block["vertical"],
                    }
                    for block in blocks
                    if str(block.get("text", "")).strip() != ""
                ],
            }
        )

    _log(f"完成：{len(pages)} 页，失败 {failed} 页")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
