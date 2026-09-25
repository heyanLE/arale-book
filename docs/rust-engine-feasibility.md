# manga-anki 引擎能不能做成 Rust 库？

结论先说：**能，而且关键的两个未知（模型能不能导出 ONNX、分词器会不会绑住 MeCab）已经用本机实测排除了**。
但收益主要在**体积与零依赖**，不在速度；而且真正的成本不在模型，在**检测器的后处理**——
那是 500 行 OpenCV 密集代码，Rust 侧没有等价的一行调用。

本文里每个数字都标了「实测」还是「估算」。实测都是在这台机器（Apple Silicon、4 线程 CPU）上跑出来的，
脚本在 `/tmp`（`export-onnx.py` / `onnx-parity.py` / `beam-parity.py` / `det-timing.py` / `tok-corpus.py`）。

---

## 1. 实测数据

### 1.1 两个模型都能导出 ONNX，而且数值一致（实测）

| 图 | PyTorch | ONNX fp32 | ONNX int8 动态量化 | 与 PyTorch 的最大差异 |
|---|---|---|---|---|
| ViT 编码器（manga-ocr） | 合在 `pytorch_model.bin` 444 MB 里 | **343.4 MB** | **86.9 MB** | `max|Δ| = 1.1e-05` |
| BERT 解码器（manga-ocr） | 同上 | **117.4 MB** | **29.6 MB** | 见下（整串文字一致） |
| 检测器（comictextdetector.pt） | 76 MB | **94.8 MB** | **53.6 MB** | `blks 1.8e-03`（原始 logits）/ `mask 5.6e-06` / `lines_map 1.9e-05` |
| **合计** | **520 MB** | **555.6 MB** | **170.1 MB** | |

导出本身**一秒钟**（`torch.onnx.export`，opset 17，legacy exporter），不是难点。
int8 用 `onnxruntime.quantization.quantize_dynamic`（权重动态量化，2 秒）。

### 1.2 识别结果与 PyTorch 逐字一致（实测，真实漫画裁剪）

拿真实页图裁了三块（两块竖排列、一块横排），跑「PyTorch 参考」vs「ONNX + 束搜索」：

| 裁剪 | PyTorch 参考 | ONNX fp32（束搜索） | ONNX int8 | 一致 |
|---|---|---|---|---|
| 022.jpg 竖列 40×222 | `この中だったら` | `この中だったら` | `この中だったら` | ✔ |
| 095.jpg 竖列 38×228 | `今めちゃくちゃ` | `今めちゃくちゃ` | `今めちゃくちゃ` | ✔ |
| 022.jpg 横排 132×66 | `．．．` | `．．．` | `．．．` | ✔ |

**一个必须照抄的细节：解码不是贪心。** `generation_config` 是
`num_beams=4, no_repeat_ngram_size=3, length_penalty=2.0, early_stopping=True, max_length=300`。
第一版探针用裸 argmax，同一块给出了 `いいのよ`（而参考是 `．．．`）——**难图会给出不同的文字**。
把束搜索照抄之后才 3/3 一致。所以「解码策略」也是移植内容，不是随手写的循环。

**一处不一致要老实说**：第四块是 358×126 的**多行区域**整块（正是新版桥已经不再产生的那种输入），
ONNX 给出 `あ．．．。そーつらえー…いいカノブラマまし！！`（int8）而参考是
`あ．．．。そーつらえー…うちゃいい`。长序列生成里束搜索的边界规则（长度归一化、早停、ngram 约束）只要有一点差别就会选到另一条假设。
**所以不能假设逐字节等价，必须用 golden 语料回归**（见 §4）。

### 1.3 分词器**不需要 MeCab**（实测，这一条最值钱）

`tokenizer_config.json` 写的是 `BertJapaneseTokenizer` + `mecab` + `unidic_lite`，看起来必须带 248 MiB 的
UniDic 辞书和 `fugashi`（C 扩展）。实测下来它等价于**「NFKC 归一化 + 逐字符查表」**：

```
'今日はいい天気ですね。' → [CLS] 今 日 は い い 天 気 で す ね 。 [SEP]   （与逐字符完全相同）
'髙神'   → [CLS] 髙 神 [SEP]        （NFKC 把兼容汉字归一化）
'ＡＢ１２３' → [CLS] A B 1 2 3 [SEP]    （NFKC 全角→半角）
'𝕏'    → [CLS] X [SEP]
```

在**真实语料 2241 条**（这本书 171 页的 2232 个文字块 + 9 条边界样本）上逐一比对 id 序列：

> **一致 2241 条，不一致 0 条。**

也就是说：`unidic_lite`(248 MiB) + `fugashi` 对这条管线是**纯冗余**，只要自己实现
`NFKC → char→id（vocab.txt 24 KB，6144 词表）→ [CLS]/[SEP]`（Rust 里是 `unicode-normalization` 的 NFKC + 一个 HashMap）。

> 这条**不需要等 Rust**：现在就能把归档里的 UniDic 删掉（约 -248 MiB，解包后体积从 1579 MiB 降到 ~1330 MiB）。
> 代价是要在桥里绕开 `MangaOcr` 内部构造的那个 tokenizer（自己造一个并替换 `recognizer.tokenizer`），
> 并且**必须**跑一遍整页回归（同一页在新旧两种分词下文字逐字一致）才算数。

### 1.4 速度（实测）：Rust 版**不会更快**

检测器单页（1024×1024，4 线程 CPU）：

| 实现 | 单页耗时 |
|---|---|
| PyTorch（现状） | **538 ms** |
| ONNX Runtime fp32 | **706 ms** |
| ONNX Runtime int8 | **624 ms** |

ORT 在这台机器上比 PyTorch 慢约 30%（torch 的 arm64 CPU kernel 很扎实）。
识别端我这次探针**没有 KV cache**（每步重跑整个前缀），所以数字偏慢（编码 ~97 ms，束搜索 63–906 ms）；
真正的移植要导出**带 `past_key_values` 的解码器**，否则解码是 O(n²)。

结论：**别用「更快」当理由**。收益是体积（741 MiB → 约 200 MB）、零 Python 依赖、
不再需要 500 MB 模型与 1.1 GB site-packages、启动不用加载 torch。

---

## 2. 要移植的到底是什么（估算 + 实测行数）

Python 侧推理路径（行数是实测的）：

| 模块 | 行 | 要移植的内容 |
|---|---|---|
| `utils/db_utils.py` | 700 | 分割图 → 行多边形的 representer（阈值、轮廓、取点、矩形化） |
| `utils/textblock.py` | 526 | `group_output`：YOLO 框 + 行多边形 + mask → 文字块；polygon 工具 |
| `basemodel.py` | 273 | 模型结构（Rust 里由 ONNX 图替代）+ letterbox 预处理 |
| `utils/textmask.py` | 267 | `refine_mask` / `refine_undetected_mask`（OpenCV 形态学 + inpainting） |
| `utils/yolov5_utils.py` | 242 | YOLO 头解码 + NMS |
| `inference.py` | 210 | 编排 + 坐标映射 |
| `utils/imgproc_utils.py` | 192 | letterbox / 多边形旋转 / 面积 |
| `manga_ocr/ocr.py` | 219 | 识别 + `post_process`（去空白、`…`→`...`、`[・.]+` 折叠、`jaconv.h2z` 半角→全角） |

约 **2,600 行 Python**，其中训练/标注/可视化占一部分（可丢）。Rust 侧大致：

- ONNX 前向：`ort`（ONNX Runtime 绑定，直接吃上面导出的图）——**几十行**；
- 图像预处理：`image`（灰度→RGB、bicubic 缩放到 224）+ 手写 letterbox ——**~100 行**；
- 检测后处理：**这是大头**，`~800–1,500 行`（连通域、轮廓→四边形、NMS、行分组、mask 细化）；
- 分词 + beam search（+ KV cache）+ 文本后处理：**~300 行**；
- 合计 **约 1.5–2.5k 行 Rust**，加一个 golden 回归工具。

**最大的技术不确定性（未实测）**：后处理重度依赖 OpenCV（`findContours` / `connectedComponentsWithStats` /
`fillPoly` / `morphologyEx` / `inpaint`）。Rust 有两条路：

1. `opencv` crate —— 能一一对应，但**重新引入系统依赖（libopencv）**，与「零依赖、单文件分发」的目标相冲；
2. 纯 Rust（`imageproc` + `geo` + 自写形态学/连通域）—— 体积干净，但工作量和「和 OpenCV 边界行为是否一致」都要自己扛。

---

## 3. 「打包成 Rust 库分发」的形态（推荐）

**不要**把 Rust 编译进 Electron（napi-rs cdylib）：现在「一个进程说一套 NDJSON」的边界本身就是优点
（模型崩了不拖垮应用、按书启停、可以换语言）。所以推荐：

```
arale-ocr            crate（lib）：recognize(image, config) -> Vec<Line>
                     ↑ 纯 Rust API，可被别的项目直接依赖
arale-ocr-cli        crate（bin）：说同一套 NDJSON 协议（--pages-file / stdout 逐行）
                     ↑ 应用侧 extension.json 只把 runner.program 换掉，**一行代码都不用改**
```

- 发布：`cargo publish` 两个 crate（crates.io 单包上限 10 MB，所以**模型不进 crate**）；
- 模型 + 二进制仍作为**扩展归档**（或 Release 资源）分发：int8 合计 170 MB + 静态链接的二进制（约 15–25 MB）≈ **~200 MB 归档**；
  也可以把模型改成首次运行下载（归档只剩二进制），但那就把「离线可用」这条丢了，需要权衡；
- 好处：iOS/Android/CLI 都能复用同一个库；`cargo` 生态直接拿到版本与许可信息。

---

## 4. 验收标准（可执行，且现在就有语料）

不要用「跑起来看着差不多」验收。**golden 语料已经躺在硬盘上**：这本书 171 页 / 2232 个文字块，
是当前 Python 管线（manga-anki 归档）的产物。移植后逐页比对：

| 指标 | 门槛 |
|---|---|
| 文字**逐字一致**率 | ≥ 99%（不一致的必须逐条看，且解释得清：多半是束搜索边界） |
| 框 IoU 中位数 | ≥ 0.90（检测器换了运行时，框不该漂） |
| 端到端页数 | 171 页全跑，不许「抽 5 页看看」 |
| 人工抽检 | 10 页目检（重叠框、竖排断列、每页耗时） |

做不到以上任何一条，就说明还不能替换归档——**允许不替换**（现在的归档能跑）。

---

## 5. 建议的推进顺序

1. **先吃掉 248 MiB（今天就能做，与 Rust 无关）**：把 UniDic 从归档里删掉，用自实现的
   `NFKC+逐字` 分词器，跑整页回归确认文字逐字一致。风险低、收益立竿见影。
2. 导出**带 KV cache** 的解码器 + 检测器 ONNX（本次已验证前向可用），把 ONNX 图纳入构建脚本。
3. Rust lib + CLI：先做**识别端**（识别端已经 3/3 对齐，风险最低），检测器仍走 Python？
   ——不行，那样等于两套运行时；所以顺序应该是「识别端 + 检测器前向 + 后处理」一起，按 §4 验收。
4. 后处理如果被 OpenCV 复现成本卡住，再决定是接受 `opencv` crate 的系统依赖，还是继续留在 Python
   （**保持现状是可接受的终局**：归档 741 MiB，用户按需下载）。

## 6. 一句话总结

模型、分词、解码这三块**都已经被实测证明可以脱离 PyTorch 与 MeCab**；
剩下的全部风险集中在检测器那 500 行 OpenCV 后处理。
所以「做成 Rust 库」是一个**工作量可控但收益只在体积/依赖**的项目，建议按 §5 分两步走——
第一步（删 UniDic）立刻见效，第二步（Rust）值得做但不紧急。
