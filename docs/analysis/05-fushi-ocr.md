# 05 · Fushi 自研漫画 OCR 实现剖析

> **证据基线**：只读仓库 `/Users/heyanle/Desktop/project/Fushi`（未改动），`path:line` 相对该仓库根。
> **约定**：**事实** = 有 `path:line` 支撑；**外部证据** = 仓库外 URL；**推断** = 外推、非 Fushi 行为描述；未找到写 **not found**。
>
> **一句话结论**：Fushi 的漫画 OCR = 一个 11 MB 的 RT-DETR-v2 三类检测器（文字 + 气泡）
> ＋「竖排整块喂 manga-ocr（343 MB encoder + 117 MB decoder）／横排切行喂 PP-OCRv6 small」的路由双通道。
> macOS 真机 **2.7 s/页（M 系列，纯 CPU）**，本地 OCR 在 macOS **可用**（`packages/fushi_engine/lib/ocr/manga_ocr_service_impl.dart:617-627`）。

## 0. TL;DR

| 项 | 结论 / 精确数字 | 出处 |
|---|---|---|
| 检测器 | `detector-v4-s_int8.onnx`，RT-DETR-v2，3 类：0=bubble / 1=text_bubble / 2=text_free | `manga_ocr_model_manifest.dart:55-61`、`text_detector.dart:19-20`、`:34-37` |
| 检测器字节 | `11120765` B（≈10.6 MiB），Apache-2.0 | manifest:59、manifest:5 |
| 竖排识别器 | encoder `343454249` + decoder `117480262` + `vocab.txt` `30216` B，Apache-2.0 | manifest:62-82、manifest:8 |
| 横排识别器 | PP-OCRv6 small det `9880512` + rec `21159378` + 字典 `150579` B，Apache-2.0；URL 钉 commit sha | manifest:83-103、`:111-113` |
| 全套磁盘 | `503275961` B ≈ 480 MiB；旧四件套 `472085492` B ≈ 450 MiB | 计算自 manifest（旧和见 `docs/bugs/BUG-1732-...md:9`） |
| 检测输入 | 640×640 **squish**（`do_pad=false`）、`/255`、**无 mean/std**、RGB CHW | `text_detector.dart:6-9` |
| 检测输出 | `logits[1,300,3]`+`pred_boxes[1,300,4]`(cxcywh 归一化) **或** 图内后处理 `scores/labels/boxes`(xyxy) | `text_detector.dart:10-14` |
| 识别预处理 | `convert("L")→RGB` + **squish 224×224（无 padding）** + `(x/255-0.5)/0.5` | `manga_ocr_recognizer.dart:10-12`、`:84-89` |
| 解码 | beam `num_beams=4 / length_penalty=2.0 / no_repeat_ngram=3 / max_length=300 / early_stopping=true`；贪心仅 ~97.8% | `beam_search.dart:3-20`、`:34-64` |
| 路由判据 | 唯一一条：`width >= height → 横排路径` | `routing_ocr_recognizer.dart:35` |
| 竖排判定 | `height > width * 1.25`（展示口径，**故意**≠路由的 1.0） | `manga_ocr_pipeline.dart:51-59` |
| 缓存指纹 | 全模型流式 sha256 折 12 hex，签名 `local-onnx-v2-oriented-<fp>` | `manga_ocr_model_fingerprint.dart:98-116` |
| 并发 | **无并行**：逐页串行、页内逐块串行、无全局并发闸门 | `manga_ocr_pipeline.dart:91-110`、`:129-143` |
| macOS 加速 | 不用 CoreML：macOS 上更慢（建会话 4248ms vs CPU 79ms），iOS 上 int8 静默算空 | `ocr_inference.dart:115-134`、`docs/bugs/BUG-1613-...md:36-43` |

### 0.1 任务问题的答案索引

| 问题 | 结论一句话 | 详见 |
|---|---|---|
| 1 模型选型与理由 | 检测器 11 MB 三类（含气泡），识别器竖排 manga-ocr / 横排 PP-OCRv6 small；三上游全 Apache-2.0，体积是唯一障碍 | §1 |
| 2 检测器 IO | 640 squish·`/255`·无归一化；两种导出（`logits[1,300,3]`+`pred_boxes` 或图内后处理）；sigmoid+0.3 阈值+cxcywh→xyxy+按「气泡/文字」两组 NMS(0.7) | §2 |
| 3 识别器机制 | `convert("L")→RGB` + **squish 224×224（无 padding）**；encoder 一次 + beam4 自回归（无 KV cache）；词表行长即 id；beam 默认 `early_stopping=true` | §3 |
| 4 路由判据 | 只有 `width >= height`；与 `isVerticalBlock`(1.25) 刻意不同；振假名过滤 p75×0.6；行 padding 4px；空串回落整块 | §4 |
| 5 阅读顺序 | 面板 union-find → 行带（纵向重叠）→ 面板内列（横向重叠）+ RTL；纯几何、**方向盲** | §5 |
| 6 1.25 vs 1.0 | 1.25 = 渲染竖排口径（轴对齐框把倾斜竖排拉宽，1.5 会误判）；1.0 = 「肯定不是一列竖排」的路由口径 | §6 |
| 7 整卷/断点续传 | 页名键 + (size,mtime) 失效 + 原子写；`_pages/<engineSignature>/`；签名 = 口径常量 + 全模型 sha256 前 12 hex | §7 |
| 8 EXIF/坐标 | `local-onnx-v2-oriented` = 检测前 `bakeOrientation`；v1 按编码像素矩阵测坐标而 Chromium 显示已定向页 → 错位 | §8 |
| 9 推理后端 | 五平台偏好表全空（纯 CPU）；Apple 实测 CoreML 更慢、iOS 上 int8 静默算空；**macOS 本地 OCR 可用，2.7s/页** | §9 |
| 10 服务层与并发 | 后台 isolate、逐页串行、每任务建 5 个会话并加载约 480 MiB 权重、无全局并发闸门；进度逐页热替换 | §10 |
| 11 给我们的启示 | 抄几何/缓存/路由/指纹；抄不动 manga-ocr 的 460 MB；替代 = PP-OCR + 竖排旋转（+ 可选 11 MB RT-DETR 检测器） | §11 |

---

## 1. 模型选型与清单

### 1.1 清单全表（`manga_ocr_model_manifest.dart`，纯数据零 IO，`:19-20`）

| # | 落盘名 | URL（原文） | `expectedBytes` | 角色 | 许可证 |
|---|---|---|---|---|---|
| 1 | `detector-v4-s_int8.onnx` | `https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector-v4-s_int8.onnx` | `11120765` | detector | Apache-2.0 |
| 2 | `encoder_model.onnx` | `https://huggingface.co/mayocream/manga-ocr-onnx/resolve/main/encoder_model.onnx` | `343454249` | recognizer | Apache-2.0 |
| 3 | `decoder_model.onnx` | `https://huggingface.co/mayocream/manga-ocr-onnx/resolve/main/decoder_model.onnx` | `117480262` | recognizer | Apache-2.0 |
| 4 | `vocab.txt` | `https://huggingface.co/mayocream/manga-ocr-onnx/resolve/main/vocab.txt` | `30216` | recognizer | Apache-2.0 |
| 5 | `ppocrv6_small_det.onnx` | `https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/<sha>/inference.onnx` | `9880512` | recognizer | Apache-2.0 |
| 6 | `ppocrv6_small_rec.onnx` | `https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/<sha>/inference.onnx` | `21159378` | recognizer | Apache-2.0 |
| 7 | `ppocrv6_small_rec.yml` | `https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/<sha>/inference.yml` | `150579` | recognizer | Apache-2.0 |

整表 `:54-104`；许可证在头注释 `:5`（检测器）、`:8`（manga-ocr）、`:12`（PP-OCRv6）。要点：

- 角色仅 `detector`/`recognizer`（`:27`），两个就绪位分别聚合（`manga_ocr_service.dart:48-49`）；PP-OCR 落盘名带 `ppocrv6_small_` 前缀，因远端 basename 都叫 `inference.*`（`:16-17`、`:106-109`）。
- **PP-OCR 两条 URL 钉 commit sha**：`28fe5895c24fd108c19eb3e8479f4ab385fbfc62`、`b8f84f0b80c529de40b4fbb3544b84fa7233a513`（`:111-113`）；动机原文 `:14-17`：「上游重新导出时旧装机与新装机拿到的必须是同一份权重（`main` 可变 ref 曾让缓存指纹形同虚设，BUG-1173）」。
- **就绪判定只查「存在且非空」**，不校验长度（`:115-125`）：校验已在下载器 rename 前做过；清单若因上游更新过期，强校验会把用户**已可用的旧模型**误判为缺失、无限重下（`:117-119`）。
- 下载候选 = 主源 + hf-mirror，由 `defaultHuggingFaceUrlCandidates` 派生（`:127-140`）。`:7` 明确 fp32 全量档 `detector.onnx`（168MB）**刻意不下**。
- **残余风险**：7 条里只有 PP-OCR 3 条钉 revision；检测器与 manga-ocr 的 4 条仍是 `resolve/main/...`（`:57-58`、`:64-65`、`:70-71`、`:78-79`）。补偿是**下载后算内容指纹**（§7.4）：检测漂移，不阻止漂移。

### 1.2 为什么不是通用 PP-OCR / JMdict 式模型

- **竖排是硬约束**：`ppocr_line_recognizer.dart:3-5`——竖排行 manga-ocr 更准（「小假名、中日异体字、`『』「」` 都是查词的生死线，PP 在这些上会『读对了字读错了形』」）；横排行 manga-ocr 幻觉 95%+ 而 PP 只有 5%（2026-09-11 对拍 + 09-13 用户真实页复测）。
- **识别引擎被设计阶段收敛成唯一解**：`docs/specs/2026-07-24-manga-ocr-design.md:87-97` 逐条淘汰 PaddleOCR-VL-For-Manga（1B VLM「太重、无定位、手写照样差」）、`manga-ocr-base-2025`（**无 license**）、平台 OCR（Apple Vision/OneOCR/ML Kit/Tesseract「竖排+艺术字全不及格」）；云端 VLM 整页直喂被基准钉死（同文件 `:189`：MangaVQA/MangaLMM arXiv:2505.20298 端到端 Hmean **全部 0.0**，输出无意义重复）。
- **检测器：块级框就够，只要 11 MB**：`design.md:122` 选 ogkalu RT-DETR-v2（Apache-2.0、int8 11MB），mokuro 现用 `comic-text-detector` 是 **GPL** 且定性更差；只给块级框不给行级坐标被判「可接受」（manga-ocr 本就整块多行识别，查词命中目标是块级 `<p>`）。
- **许可证矩阵是分发前提**：`design.md:139-147` —— manga-ocr/ogkalu/ONNX Runtime 可随包或按需下载；mokuro 系 GPL-3.0 只能作外部子进程；无 license 与非商用一律出局。三上游都是 Apache-2.0，**许可证不是障碍，体积才是**（§11.5）。

### 1.3 检测器 3 类与 `insideBubble`

`text_detector.dart:34-37`：`0=bubble`（气泡整体）/ `1=text_bubble`（气泡内文字）/ `2=text_free`（气泡外）；`:19-20`：**文字块 = {1,2}；0 仅用于内/外判定**。

`buildPageDetections`（`:300-321`）把 0 类收成 `bubbles`，对每个 1/2 类框判断**框中心点**是否在任一气泡框内（`:311-312` `containsPoint(centerX, centerY)`），写入 `DetectedTextRegion.insideBubble`（`ocr_types.dart:100-101`）。它买到三件事：①**0 类必须穿过 NMS**（气泡与其中文字天然套叠，同组会抑制文字，故分组 `气泡=0/文字=1`，`:274`、`:287-291`）；②让「同块文字被两条类目重复检出」可解释并去重（§2.4）；③内/外属性进 `OcrPageResult.toJson()`（`ocr_types.dart:121`、`:134`、`:141`），续传后仍在。

**必须说清**：`insideBubble` 目前**没有消费方**——`buildMangaPayloadFromResults`（`manga_ocr_folder_job.dart:267-285`）只搬 `box/vertical/fontSize/zIndex/lines`，`MokuroBlock` 也没有该字段（`mokuro_payload.dart:78-128`）；全仓 grep 命中全在 `packages/fushi_engine/lib/ocr/`（`ocr_types.dart`、`manga_ocr_pipeline.dart:141`、`text_detector.dart:317`）。它是**已算好、已缓存、留给将来 UI、今天未被读**的属性；今天的价值是它逼出的 NMS 分组决策。

---

## 2. 检测器 IO 规格（`text_detector.dart`）

### 2.1 输入与预处理

`:1-24` 头注释（来源：HF 模型卡 + `preprocessor_config.json`/`config.json` + 作者 comic-translate 的 `modules/detection/rtdetr_v2.py`）：resize 到 **640×640**、`do_pad=false`（**不保持长宽比的 squish，不是 YOLO letterbox**，`:6-7`）；`rescale 1/255`；`do_normalize=false`（**无 mean/std**，`:8`）；输入 `pixel_values` float32 `[1,3,640,640]`、**RGB CHW**（`:9`）；`kDetInputSize = 640`（`:40`）。
`rtdetrPreprocess`（`:113-154`）：按 `transform` 算 `scaledW/scaledH` → `copyResize`(linear)（`:122-127`）→ 未铺满则新建画布填 **114 灰**居中合成（`:131-138`，squish 下填充色无效）→ 逐像素 `chw=r/255`、`plane=g/255`、`2*plane=b/255`（`:146-151`）。**没有减均值除方差**。

### 2.2 两种导出、两套输出张量

`:10-14`：原始导出输入 `pixel_values`，输出 `logits [1,300,3]`（300 = num_queries，3 类）+ `pred_boxes [1,300,4]`，**cxcywh、相对输入图归一化 0..1**；当前 int8 导出把 HF 后处理**包含在图内**，输入 `images` + `orig_target_sizes`，输出 `scores`/`labels`/`boxes`（**xyxy**）。算法层两种都吃，不依赖某份模型文件的临时命名。

### 2.3 query → box

原始导出 `decodeRtdetrOutputs`（`:178-212`）：①`score = sigmoid(logit)`（`:191`；`:15-16` 说明 focal-loss 训练用 **sigmoid 而非 softmax**）；②过阈值（`:192-194`）；③`cx/cy/w/h` 乘回**画布**尺寸（`:195-198`）；④转 xyxy 并 `inverseX/inverseY` 回原图 + `clamp`（`:199-204`）；⑤`area<=0` 丢弃（`:205-207`）。`numQueries`/`numClasses` 不硬编码：`detect()` 从 `logits.shape[1]`/`[2]` 读（`:372-382`），签名上的 300/3 只是默认值（`:182-183`）。

int8 导出 `decodeProcessedRtdetrOutputs`（`:227-265`）：直接读三输出，先形状自检（`:234-239`：`scores.length==labels.length && boxes.length==scores.length*4`，不符即抛）、过阈值（`:243-245`）、xyxy 经 `inverseX/Y` 回原图（`:247-252`）。
**`labels` 类型是真实坑**：`_labelValues`（`:217-224`）float32/int64/int32 三种都吃，读不出就抛——`flutter_onnxruntime` 插件把一切输出读成 float（app 侧没炸），而服务端 `asr_onnx_ffi` 会话**按 ORT 元素类型原样返回 int64** → 只认 `floatData` 会空指针（`:214-216`、`docs/bugs/BUG-2518-...md:3`）。

### 2.4 分数阈值与 NMS

阈值默认 **0.3**（`:327`、`:336-337`，注释「参考实现（comic-translate）默认置信度阈值 0.3」）。`:17-18`：**「DETR 家族查询间本不需要 NMS，这里保留一个轻量 NMS 兜底去重（同类 IoU 过高只留高分）」**。`nmsGroupOf(classId) = classId==0 ? 0 : 1`（`:274`）；`applyClassAwareNms(..., iouThreshold=0.7)` 是贪心 NMS（`:277-298`）。分组理由（`:267-274`）：解码按 (query, class) 对过阈值，**同一 query 在两个文字类上都过线时会产出两个 rect 完全相同的检测**；按 `classId` 分组会让两者互不抑制、同一块文字被识别两次并写进 manga.json 两次（实测 mihon 扉页人物名栏）。「内/外只是同一块文字的属性，不是两种物体」。

### 2.5 resize / letterbox 与坐标回映射

`LetterboxTransform`（`:46-71`）把「原图→模型输入」表达为 `dst = src*scale + pad`，正反变换 `forwardX/Y` / `inverseX/Y`（`:67-70`）。`computeLetterbox`（`:74-107`）：**squish（默认）** `scaleX=dstW/srcW`、`scaleY=dstH/srcH`、`pad=0`（`:84-94`）；**letterbox（`preserveAspect=true`）** `scale=min(dstW/srcW,dstH/srcH)`、`padX=(dstW-srcW*scale)/2`（`:96-106`），此时 `scaleX==scaleY`（`:45`）。回映射唯一出口 `inverseX/inverseY`，两处调用（`:200-203`、`:248-251`）都以 `clamp(srcWidth, srcHeight)` 收尾（`OcrRect.clamp` 见 `ocr_types.dart:57-62`）。

**不显眼但重要**：`detect()` 传给图的 `orig_target_sizes` 是 `[transform.dstHeight, transform.dstWidth]`（`:358-364`，int64 `[1,2]`，**H 在前**），即 **640×640 网络画布尺寸而非原始页尺寸**；图内后处理输出的是**画布坐标系** xyxy，「画布→页面」由 Dart 侧 `transform.inverseX/Y` 完成。默认 squish 下恒为 640 看似常量，打开 `preserveAspect` 后依然正确（两边共用同一个 `transform`）。

`detect()` 编排（`:347-397`）：`computeLetterbox` → `rtdetrPreprocess` → `run({inputName: pixel_values[1,3,H,W], 'orig_target_sizes': int64[1,2]})`（`:354-365`）→ 先试 `logits+pred_boxes`（`:366-382`），否则试 `scores+labels+boxes`（`:383-390`），都没有就抛并带实际 key 列表（`:392-394`）→ `buildPageDetections(applyClassAwareNms(raw))`（`:396`）。输入名可覆盖（默认 `'pixel_values'`，`:329`）。

---

## 3. 识别器（manga-ocr）机制

### 3.1 预处理：squish 到 224×224，**没有 padding**

IO 规格（`manga_ocr_recognizer.dart:3-16`）：encoder（ViT）输入 `pixel_values` float32 `[1,3,224,224]`，输出 `last_hidden_state [1,196,768]`（`:4-5`）；decoder（BERT 自回归）输入 `input_ids` int64 `[beams,seqLen]` + `encoder_hidden_states` float32 `[beams,196,768]`，输出 `logits [beams,seqLen,vocab]`，**无 KV cache，每步全序列重跑**（`:6-8`）；预处理对齐原版 manga_ocr：PIL `convert("L").convert("RGB")`（ITU-R 601-2 亮度灰度化后三通道复制）→ **squish resize 到 224×224** → `(x/255-0.5)/0.5`（mean=std=0.5，逐通道同值）（`:10-12`）。

代码：常量 `kRecInputSize=224`/`kRecEncoderTokens=196`/`kRecHiddenSize=768`（`:29-34`，注释 `224/16=14, 14*14=196`）；`cropAndResizeForRecognition`（`:60-90`）按 `marginRatio`（**默认 0**）外扩 → `clamp` 到页（`:65-72`）→ `copyCrop`（`:77-83`）→ **`copyResize(crop, 224, 224, linear)`**（`:84-89`）——**无保持比例的 padding、无 letterbox、无分块**；`mangaOcrNormalize`（`:38-56`）断言输入已 224×224（`:39`），`luma=(299r+587g+114b)/1000`（`:46-47`，与 PIL `convert("L")` 同系数），`value=(luma/255-0.5)/0.5`（`:48`），三 plane 同值（`:49-51`）。

**所以路由注释里「224×224 squish 导致幻觉」指的就是这条路径本身。** Fushi 的应对**不是**改 manga-ocr 预处理，而是**把横排块从这条路径移走**（§4）；竖排块仍原样 squish 224×224，这是刻意的：`routing_ocr_recognizer.dart:13-14`「竖排块的路径与本类出现前逐字节等价，存量表现零变化」。生产调用点 `marginRatio` 全为 0（`:52-54`、`:59`），唯一例外是横排块内**竖排子行**回炉时按页面坐标外扩 4 px（`:84-97`）。

### 3.2 encoder / decoder 切分

`recognize()`（`:129-171`）：裁+resize+归一化 → encoder 跑**一次**（`:134-138`）→ 从 shape 读 `encTokens`/`hiddenSize`（`:139-146`）→ **沿 beam 维 tile 一份 encoder_hidden_states 整轮复用**（`:148-155`）→ beam search（`startTokenId=clsId`、`eosTokenId=sepId`，`:159-160`）→ 解码（`:170`）。每步 `_decoderStep`（`:173-205`）把 beams×seqLen 打成 `Int64List`，`input_ids[beams,seqLen]` + `encoder_hidden_states[beams,196,768]` 一起喂（`:186-190`），**只取每条 beam 最后位置的 logits**（`:198-203`，offset `(b*seqLen+(seqLen-1))*vocabSize`）。无 KV cache 意味着每个新 token 都要重跑整段——长文本线性变慢的直接原因。输入/输出名可注入，默认即 mayocream 导出名（`:103-107`）；跨导出改名由 `resolveOcrSessionInputs`（`ocr_inference.dart:220-246`）兜：**单输入模型按 session 元数据对齐**（`:224-228`），多输入 decoder 仍要求精确按名匹配（`:229-241`）。

### 3.3 tokenizer（`manga_ocr_tokenizer.dart`）

词表来自模型仓库 `vocab.txt`，**每行一个 token，行号即 id**（`:3-4`、`:16-19`）；构建时剥 `\r`、去尾部空行（`:17-23`），`require` 特殊符号 `[CLS]/[SEP]/[PAD]/[UNK]`（缺任一抛 `FormatException`，`:27`），`[MASK]` 存在才入特殊集（`:24-41`）；`vocabSize=_idToToken.length`（`:52`）；`decode` 跳过越界与特殊 id（`:58-60`），`##` 前缀剥掉（`:62`）；`postProcess`（`:69-77`）＝原版 manga-ocr 后处理：删掉所有 `\s+`（`:70`）→ `…`→`...`（`:71`）→ 连续 2+ 个 `[・.]` 归一为等长 `.`（`:72-75`）。token 总数 = 行数，代码未打印，**not found**（只有文件字节 30,216）。

### 3.4 beam search（`beam_search.dart`）

语义对齐 HuggingFace `transformers` 的 `generate`（BeamSearchScorer + NoRepeatNGramLogitsProcessor，`:3-4`）。配置默认（`manga_ocr_recognizer.dart:98-102` → `beam_search.dart:38-42`）：`numBeams=4`、`lengthPenalty=2.0`、`noRepeatNgramSize=3`、`maxLength=300`、**`earlyStopping=true`**。后两者都对齐原版 `generation_config`（`recognizer:14-16`、`beam_search:5-8`）；**没有贪心模式**，贪心只是对照：`:8`「已实测该配置与原版输出逐字一致（贪心解码只有 ~97.8%）」。

关键实现（`:10-20` 清单逐条对应）：序列长度**含起始 token**（`:136`、`:62-63`）；首步除 beam0 全 `-inf`（`:138-141`）；每步取 top `2*numBeams`（`:195`）；`logSoftmax`（`:85-102`）+ no-repeat-ngram 屏蔽（`:183-187`、`:106-126`）+ 累加 beam 分（`:188-190`）；rank ≥ numBeams 的 EOS 丢弃（`:230-234`），rank < numBeams 的 EOS 收编且分数含 EOS 步 logprob（`:233`）；长度惩罚 `sumLogProbs / tokens.length ** lengthPenalty`，**len 不含 EOS**（`:145-147`、`:13-14`）；终止判据 `:260-274`；到 `max_length` 把存活 beam 按同公式收编（`:277-285`）；返回时去起始 token（`:295-299`）。

**`early_stopping` 不是形式主义，它就是 BUG-2457 的修复**：`docs/bugs/BUG-2457-...md:3` —— 原按 `false` 实现，而原版 `kha-white/manga-ocr-base/config.json` 顶层与 `mayocream/manga-ocr-onnx/generation_config.json` **都是 `true`**。正常裁块上两者逐字相同；**退化图**（横幅、噪声框、整气泡大裁块）上 `false` 跑满 `max_length=300`：实测 **299 步 / 10.6 s**（int8 4.6 s）输出整段编造文字，`true` 语义 **21 步 / 126 ms**；5 张样本均值 **2398 → 269 ms/张**。→ **beam search 不是可选装饰，`early_stopping=true` 是正确性的一部分。**

---

## 4. 两条路径的路由判据（`routing_ocr_recognizer.dart`）

### 4.1 判据

```dart
bool routesToHorizontalPath(OcrRect box) => box.width >= box.height;  // :35
```

`recognize`（`:50-60`）：竖排 → 整块 `mangaOcr.recognize`；横排 → `_recognizeHorizontalBlock`；**横排返回非空串直接用，否则回落整块 manga-ocr**。`:13`：「路由判据只有一条：**块比它高还宽 → 横排路径**，其余原样」。

### 4.2 为什么与 `isVerticalBlock` 不同

`:32-34` 原话：

> 横排路径判据：宽 ≥ 高。与 `isVerticalBlock`（1.25）**刻意不同**——那是 manga.json
> 的展示口径；这里要的是「肯定不是一列竖排」的保守判定，1.0~1.25 之间的近方块
> （「は？」「宮城！」这类短句）继续走 manga-ocr。

即 **1.25 是「渲染成竖排文字层」的判定，1.0 是「送哪条识别链路」的判定**；把 1.0~1.25 近方块送横排会被 PP det 当段落切碎短句。

### 4.3 注释记录的实测证据（两个具体失败例）

`:3-11`：2026-09-13 用**用户真实页**复测——「週に一度クラスメイトを買う話」（mihon 下载 844×1200）+「幼なじみが絶対に結ばれる百合アンソロジー」（1444×2048），**共 100+ 块**。

1. **竖排正文块走 PP det 会把一列切断**：`「えっそれ私が食べていいの？」→「食べて、いつ、いいの？」`（`:7-8`）。
2. **横排块（扉页简介、人物介绍、作者栏）manga-ocr 整段幻觉**：`manga-ocr 把 800×190 的段落 squish 进 224×224 后整段幻觉`；`即使切好行再喂 manga-ocr 照样幻觉（方案 E）`；`PP det+rec 逐字全对`（`:9-11`）。

同一结论另见 `docs/bugs/BUG-2516-...md:3`（第 2 页简介识别成「当たりは交際の初めにフルーキングを…」）；修复后验收（`:4`）：**真实模型复跑第 1 章 28 页 26 秒**，简介整段/人物介绍/作者栏/倾斜标题 logo 逐字全对，竖排正文与修前一致。

### 4.4 横排路径流程与三个常量

`_recognizeHorizontalBlock`（`:62-111`）：`clamp` 块到页内算 `x/y/w/h`（`:63-73`）→ 从**页**裁整块（`:74`）→ `filterThinLines(await _lineDetector.detect(crop))` 后 `orderLinesForReading(...)`（`:75-77`）→ 逐行（`:79-109`）：行框 `clamp` 到 crop、`<1px` 跳过（`:80-83`）；**竖排行换回页面坐标 + 四周各扩 `kRoutingLinePadding` 后仍由 manga-ocr 识别**（`:84-97`）；横排行从 crop 再裁后交 `PpOcrLineRecognizer.recognizeLine`（`:99-108`）；`StringBuffer` 顺序拼接、**无分隔符**（`:78`、`:110`）。

| 常量 | 值 | 作用与出处 |
|---|---|---|
| `kRoutingLinePadding` | **4** px | 横排块内竖排子行回炉时的四周外扩（`:30`，注释「对拍脚本同值」）；**不作用于整块竖排**（那条 marginRatio=0） |
| `kPpLineVerticalRatio` | **1.5** | 行级竖排判定 `height >= width*1.5`，与 PaddleOCR `get_rotate_crop_image` 同口径（`ppocr_line_detector.dart:44`、`:104`） |
| `filterThinLines` ratio | **0.6** | 振假名过滤（下） |

**振假名（ふりがな）过滤** `filterThinLines`（`ppocr_line_detector.dart:189-203`）：取块内行「厚度」升序取 **p75**，丢掉 `thickness < 0.6*p75`（`:191-202`）；厚度 = `vertical ? rect.width : rect.height`（`:106-107`）。分量见 `:190-191`：**「是 PP-OCR 在日漫上的生死线：过滤前 CER 41%~92%」**——假名是主线文字的 1/3~1/2，不过滤会被当正文行，一行正文被拆两半、假名混进查询结果。行内顺序 `orderLinesForReading`（`:205-221`）：竖排行占多数（`verticalCount*2 >= lines.length`）按列**从右到左**（`left+right` 降序，`:209-213`），否则**从上到下、左到右**（`:214-219`）。
**回落**（`:17-18`、`:55-60`）：PP 什么都没检到 / 拼出来是空串 → 回落整块 manga-ocr（「宁可幻觉也不丢块」）；粒度是**整块**而非逐行。
**未复测**：`BUG-2516:6` 备注「真机 app 侧（flutter_onnxruntime 插件会话）未复测，纯 Dart FFI 会话已复测」——横排路径的服务端 FFI 路径有实测，**app 插件路径当时没跑**。

---

## 5. 阅读顺序（`reading_order.dart`）

纯函数、无 IO、无模型（`:1`），三步启发式（`:3-10`）。

**第 0 层 · union-find** `_clusterBy(count, related)`（`:18-47`）：带路径压缩（`:23-29`），O(n²) 两两判（`:31-41`），返回每簇原始下标（`:42-46`）。**没有递归、没有 R 树。**

**第 1 层 · 面板聚类** `clusterPanels(boxes, gapRatio=0.75)`（`:56-72`）：

```dart
threshold = gapRatio * math.min(minDim(a), minDim(b));
return _gapX(a,b) <= threshold && _gapY(a,b) <= threshold;   // :66-71
```

`_gapX/_gapY` 是**轴向间距**、相交为 0（`:50-54`）；直觉 `:59-60`：同格气泡间距通常小于一个气泡尺度，跨格间距（含格线/留白）更大。

**第 2 层 · 包围盒 → 行带**（`computeReadingOrder`，`:127-160`）：空输入返回 `[]`（`:132-134`）→ `clusterPanels` → `panelBounds`（`:135-138`，实现 `:75-87`）→ 用 **panel 包围盒的 `verticalOverlaps`** 做第二层 union-find → 行带（`:141-144`）→ 行带按 `bandTop`（带内最小 top）**从上到下**（`:145-148`）→ 带内按 `bounds.centerX` 排（RTL 时降序即右先，`:152-154`）→ 逐面板展开（`:155-158`）。`verticalOverlaps` 定义 `ocr_types.dart:50-51`：`min(bottom)>max(top)`，**严格重叠**（共边不算）。

**第 3 层 · 面板内列主序** `orderWithinPanel`（`:89-121`）：用 `horizontalOverlaps`（`ocr_types.dart:54-55`：`min(right)>max(left)`）做 union-find → **列**（`:96-99`）——即题目问的「column clustering by x-overlap」：**是**，判据是**区间重叠**而非 IoU/中心距；列按 `colCenter`（列内 `centerX` 算术平均，`:104-110`）排序（RTL 降序/LTR 升序，`:112-114`）；列内按 `box.top` 升序（`:117`）；顺序拼接（`:115-120`）。`rightToLeft` 默认 `true`（`:129`；`manga_ocr_pipeline.dart:75-76`），整卷入口不覆盖它，**生产恒为 RTL**（`manga_ocr_folder_job.dart:356-360`）。

**混合横竖排 / 重叠框**（前半事实、后半**推断**）：**这一层完全不知道 `vertical` 存在**——入参只有 `List<OcrRect>` 与一个 bool（`:127-131`），`processPage` 传的也只是 `region.rect`（`manga_ocr_pipeline.dart:120-126`）。

- 横排段落无特殊对待：横跨整页的宽矮块若与上下面板不纵向重叠会被分到不同行带、强制按 top 排（单栏日漫页上通常正确）。倾斜竖排被拉宽成横排形状（推断）：仍参与列聚类，只是更易与左右邻居 `horizontalOverlaps` 而并进同列；代码不区分方向。
- 重叠框（事实）：`related` 两两判定 + 传递闭包，A∩B、B∩C 得 `{A,B,C}` 一簇（即使 A∩C 为空）；簇内无序，随后被列/带排序覆盖（`:100-119`、`:150-158`）。
- 同簇列序平局未定义（事实）：`colCenter` 相等时 `compareTo` 返回 0，`List.sort` 非稳定排序；密集等宽气泡页上是低概率真实抖动来源（推断）。
- 整页并成一簇（间距都 < 0.75×短边，如密集四格）就退化为「单面板 + 内部列主序」，丢掉行带；设计文档风险 R5 承认「复杂版式会错序（只影响整页导出/上下文，不影响单块查词）」（`docs/specs/2026-07-24-manga-ocr-design.md:176`）。

---

## 6. 竖排判定阈值：1.25 vs 1.0

### 6.1 1.25（展示/几何口径）

`manga_ocr_pipeline.dart:51-59`：

```dart
/// 竖排判定的长宽比阈值：高 > 宽 * 阈值 视为竖排。
///
/// 检测器返回的是轴对齐框，倾斜竖排会被横向外接矩形拉宽；1.5 会把真实封面上
/// 约 1.4:1 的竖排误判为横排。1.25 仍让接近方形（≤1.2:1）的块保持横排，同时
/// 覆盖这类倾斜竖排。
const double kVerticalAspectThreshold = 1.25;
bool isVerticalBlock(OcrRect box) => box.height > box.width * kVerticalAspectThreshold;
```

题目要求引用的「倾斜竖排 + 外接矩形」原话即 `:53-54`：**「检测器返回的是轴对齐框，倾斜竖排会被横向外接矩形拉宽」**——`TextDetector` 只产 AABB（`text_detector.dart:199-204` 用 `left/top/right/bottom` 表达），无旋转角，所以倾斜列的 `width` 被外接矩形撑大、`height/width` 被压低；1.5 会把 1.4:1 真竖排判成横排，1.25 既覆盖倾斜竖排又让 ≤1.2:1 近方形保持横排。

### 6.2 三个阈值不是同一层

| 阈值 | 判据 | 语义 | 谁用 |
|---|---|---|---|
| **1.25** | `height > width*1.25` | 「这块文字**渲染时应是竖排**」 | `manga.json` 的 `blocks[].vertical`（`manga_ocr_pipeline.dart:138`） |
| **1.0** | `width >= height` | 「这块**肯定不是一列竖排**，可按段落切行」 | 识别路径路由（`routing_ocr_recognizer.dart:35`） |
| **1.5** | `height >= width*1.5` | 「这一**行**是竖行」 | 块内行方向（`ppocr_line_detector.dart:44`、`:104`） |

第三个 1.5 属 PP-OCR DB 后处理，与上面两个不同层，混用会出 bug。

### 6.3 1.25 的追溯修复用途

`manga_ocr_folder_job.dart:277-282`：

```dart
// Re-evaluate cached local blocks so pages produced by the older,
// overly strict 1.5 ratio threshold gain queryable vertical regions
// without rerunning OCR.
isVertical: block.vertical || isVerticalBlock(block.box),
```

即使缓存里存的是**旧阈值 1.5 算出的 `vertical=false`**，**组装 manga.json 时**用当前 1.25 重算并 `||` 合并——已缓存页不必重跑就能拿到正确的竖排文字层。这是「阈值口径变更不触发全量重算」的可抄模式。

---

## 7. 整卷编排 / 断点续传

### 7.1 输出目录布局

| 路径 | 内容 | 出处 |
|---|---|---|
| `<imageDir>/manga_ocr_out/manga.json` | 最终 mokuro 风格产物（原子写） | `manga_ocr_folder_job.dart:22`、`:38`、`:380-390` |
| `<imageDir>/manga_ocr_out/_pages/<engineSignature>/<页名>.json` | **逐页断点缓存**，一页一文件 | `:24-25`、`:162-163`、`:339-347` |
| `<imageDir>/manga_ocr_out/manga.json.tmp` | 写中转（`.tmp`+`flush`+rename） | `:381-389` |

页缓存文件名 = 相对 url 的 `/` 折成 `__` 再补 `.json`（`:162-163`）；病态输入（原名含 `__`）两页同名时后写覆盖，被接受为权衡（`:160-161`）。`manga_ocr_out/` 在枚举时**必须排除自己**（`:21`、`:145-148`）。

### 7.2 `OcrPageCache` 语义（对齐 mokuro 的 `_ocr/`）

接口（`manga_ocr_pipeline.dart:14-18`）：`read(bookId,pageIndex)` / `write(bookId,result)`。语义（`:1-6`）：**一页一条结果，页子任务完成即落缓存；中断重跑只补未完成页**，显式对齐 mokuro `_ocr/`。文件实现三个设计点（`manga_ocr_folder_job.dart:165-242`）：①**键按页名而非页号**（`:165-166`：「目录内容变化（增删页）后页号漂移，页名缓存仍能命中」；`_fileFor` 只做 `pageIndex→pageNames[pageIndex]`，`:180-181`）；②**失效三元组** `source_path`/`source_size`/`source_modified_ms`（`:196-199`），任一不符当 miss；③**原子写** `.tmp`+`flush`+删旧+rename（`:227-240`），损坏缓存当 miss 让该页重跑覆盖写（`:213-215`），写时重算 `stat`（`:225-226`）。

### 7.3 取消令牌与进度回调

**取消** `OcrCancelToken`（`manga_ocr_pipeline.dart:22-36`）：一个 bool + `throwIfCancelled()`；检查点只有**页边界**（`:92`）与**块边界**（`:130`）；置位后抛 `OcrCancelledException`（`:38-43`）。语义（`:20-21`、`:79-81`）：**已完成页缓存不回滚，重跑续传**。这是协作式取消、**非抢占式**——`detect()` 与单块 `recognize()` 一旦开始必须跑完（推断：这些 await 内无检查点）。
**进度** `OcrProgressCallback = void Function(int,int)`（`:45-46`），注释「completedPages **含缓存命中页**」——缓存命中页也 `completed++` 并回调（`:93-98`），续跑进度从上次位置继续，不归零。

`processBook`（`:82-112`）：严格 `for`，命中缓存 → add + 回调 + `continue`（`:93-99`）；未命中 → 解码 → `processPage` → 写缓存 → add + 回调（`:100-109`）。**无并发、无 batched 前向、无预取。**
`processPage`（`:115-150`）：`detect` → 取 rect → `computeReadingOrder` → 按序逐块 `recognize` → 空串跳过（`:133-135`）→ 组装 `OcrBlock`（`vertical: isVerticalBlock(rect)`、`score`、`insideBubble`，`:136-142`）→ 带 `imageWidth/imageHeight` 的 `OcrPageResult`（`:144-149`）；`zIndex` 在产物组装时按顺序赋 `b`（`manga_ocr_folder_job.dart:282`）。

### 7.4 引擎签名 / 内容指纹（BUG-1173）

**问题**：目录名曾只有手维护常量 `local-onnx-v2-oriented`，而下载直链指向 HF **`main` 可变 ref** 且清单无 sha256。后果三条（`docs/bugs/BUG-1173-...md:3`）：①断点续跑把新旧模型结果混进同一卷；②向导「整卷已缓存→直接产出」**跳过 OCR** 输出旧结果；③重开恢复把旧结果贴回当前 payload；全程无信号。`manifest:16`：「`main` 可变 ref 曾让缓存指纹形同虚设」。

**修复**（`manga_ocr_model_fingerprint.dart`）：①对清单全部文件**流式 sha256**（`:44-47`，「不把 343MB 的 encoder 读进内存」），折成 `'${fileName}:${sha256}'` 逐行拼接后再 sha256，取**前 12 hex**（`:98-99`；`kMangaOcrModelFingerprintLength=12`，`:34-35`）；②**签名 = 基线常量 + `-` + 指纹**（`:106-116`）→ `local-onnx-v2-oriented-<fp>`；模型不完整返回 `null`、退回裸基线常量（`:112-114`），理由 `:104-105`「那时本地 OCR 根本跑不起来，只可能读到本修复之前的旧缓存目录」；③**按 (size,mtime) 记忆化**到 sidecar `model_fingerprint.json`（`:32`、`:57-97`），理由 `:28-31`：与 git/rsync/ninja 同一套判定，11MB~343MB 整文件下载「同尺寸+同毫秒但内容不同」不可能；mtime 只决定是否重算，**同内容重下算出同一 sha256** 不误伤；命中时只 4 次 `stat` + 一次小 JSON（`:12-13`）；④sidecar **损坏当空**（`:147-150`）、只读目录写失败可容忍（`:165-167`）、原子写（`:156-164`）；⑤**`runMangaOcrFolderJob` 的 `engineSignature` required 且无默认值**（`manga_ocr_folder_job.dart:318-325`）：「免得新调用方漏传一个手维护常量又把不同模型的结果混进同一卷」；⑥三个消费方统一走同一解析：isolate（`manga_ocr_service_impl.dart:403-406`）、向导/整卷快路径探测与重开恢复（`fushi/lib/src/media/manga/manga_ocr_job_stream.dart`），只读版本 `resolveInstalledLocalMangaOcrEngineSignature`（`:118-131`）在无 platform channel 的纯 Dart 测试环境捕获异常退回基线常量；⑦产物元数据记录签名（`manga_ocr_folder_job.dart:372-379`；`mokuro_payload.dart:33-43`）。

**「整卷已缓存 → 直接产出」快路径**（`manga_ocr_job_stream.dart`）：逐页读签名目录缓存，**全部命中**才组装 payload 并原子写 `manga.json`、逐页补发 progress、最后 finished；任一页 miss 就清空列表走真实任务。`onlyMissing=false`（用户点「重新识别」）时先**只删本签名的目录**（`discardMangaOcrPageCache`），别的引擎/版本的缓存保留。

**残余风险**：指纹是**下载后**的内容身份，不是**下载前**的版本约束；4/7 URL 仍是 `main`，上游换权重时新旧用户各有缓存目录、**不会串**，但**没有机制阻止上游换权重**、也无法下载前校验。

### 7.5 页枚举与自然序

- **递归下钻到 `kMangaPageScanMaxDepth=6` 层**（`:110`、`:145-149`）；理由 `:114-120`：旧实现只认「顶层 + 一层子目录」，而 mokuro.moe 卷 CBZ 顶层带 `<卷名>/`，页图落在 `images/<卷名>/001.jpg`（第 2 层）→ 一页都扫不到。「页图深度取决于源压缩包怎么打的，不是常数，扫描就不该把它当常数。」
- 扩展名白名单 = 共享基集 `kImageExtensionsBase`（`:40-47`；`media_extensions.dart:17-24`，含 `.jpg/.jpeg/.png/.webp/.gif/.bmp`）。这是 BUG-1121 的修复：整卷 OCR 曾手写 4 项、比导入白名单少 `.bmp/.gif`，bmp 页被**静默跳过**、产物缺页无提示（`docs/bugs/BUG-1121-...md:3`）。
- 自写 `naturalCompare`（`:61-103`）让 `p2.jpg < p10.jpg`，数值相等（`001` vs `1`）时位数少的在前以保证全序稳定（`:71-93`）。
- `listSync` 失败跳过该目录（`:136-141`）；无页抛 `StateError`（`:335-337`）；目录不存在抛 `ArgumentError`（`:331-333`）。

### 7.6 产物组装

`buildMangaPayloadFromResults`（`:259-296`）：逐页逐块转 `MokuroBlock`，`fontSize = sqrt(box.area / charCount)`（`estimateMangaFontSize`，`:247-254`，无字符或零面积返回 0），`zIndex = b`，`isVertical = block.vertical || isVerticalBlock(block.box)`（§6.3），`size` 取自解码时记录的 `imageWidth/imageHeight`（`:286-293`）；`lines` 对 manga-ocr 整块恒为单元素（`ocr_types.dart:129-131`）。

---

## 8. EXIF / 坐标口径

`manga_ocr_folder_job.dart:35`：`const String kLocalMangaOcrEngineSignature = 'local-onnx-v2-oriented';`；注释 `:27-34`：

```text
// Separates local ONNX cache entries from network/CLI engines.
// v2 bakes EXIF orientation before detection. v1 coordinates were measured
// against the encoded pixel matrix while Chromium displayed the oriented page,
// so portrait pages with orientation metadata had a shifted lookup layer.
//
// 这只是坐标口径基线，不代表模型身份：实际落盘的目录名要再接一段已安装模型
// 的内容指纹（manga_ocr_model_fingerprint.dart），否则上游换模型后旧缓存被静默
// 复用（BUG-1173）。
```

**v2 改了什么**：`decodeMangaPageFile`（`:299-308`）在 `img.decodeImage` 之后 `return img.bakeOrientation(decoded);`，注释 `:304-306`：「Browser image rendering honors EXIF orientation. OCR must use the same oriented pixel space, otherwise the percentage overlay and click target are rotated/translated relative to the visible page.」即 **v2 = 检测前把 EXIF 方向烘焙进像素**；v1 坐标相对**编码像素矩阵**测量，而 Chromium 显示的是**应用 EXIF 后**的页面 → 带 orientation 元数据的竖版页文字层整体错位。

**口径一致性链条**：检测输入已定向（`:307`）→ 检测框 clamp 到 `page.width/height`（`text_detector.dart:204`）→ `manga.json` 的 `width/height` 来自 `image.width/height`（`manga_ocr_pipeline.dart:146-147`）→ 阅读顺序、缓存尺寸、覆盖层渲染全在同一空间。所以它必须进签名：`local-onnx-v1-*` 与 `local-onnx-v2-oriented-*` 是**物理隔离的两个目录**。给复刻者：Electron 的 `nativeImage`/`<img>` 同样自动应用 EXIF（Chromium 行为），Node 侧解码是否应用 EXIF 必须与渲染侧一致且进签名——**这是已发生过一次的坐标错位 bug，不是理论风险**。

---

## 9. 推理后端（ONNX Runtime 故事）

### 9.1 抽象层与真实实现

`packages/fushi_engine/lib/ocr/ocr_inference.dart` 只是**别名层**：`OcrTensor`/`OcrSession`/`OcrSessionFactory`/`OcrExecutionProvider`/`OcrProviderResolution` 都是 `fushi_asr_core` 里 `Onnx*` 的 typedef（`:1-9`、`:30-46`）；`export ... show` 白名单在 `:18-28`，注释 `:14-17` 说明不能整份 re-export（会与 Fushi 同名符号撞成 ambiguous import）。OCR 特有：`OcrModelKind {detection, recognition}`（`:49`）、`OcrPlatform {windows, macos, ios, linux, android}`（`:52`）、平台偏好表（`:135-151`）、选择函数（`:166-180`）、输入名对齐（`:220-246`）。真实会话实现在 `fushi/lib/src/onnx/onnx_inference_ort.dart`，OCR 薄封装在 `fushi/lib/src/ocr/ocr_inference_ort.dart`。

### 9.2 可用的执行后端

`OcrExecutionProvider` 只有 4 值 `cuda/directml/coreml/cpu`（由 `_toOrtProvider` 反推）。插件枚举里还有更多（`third_party/flutter_onnxruntime/lib/src/ort_provider.dart:13-32`：ACL/ARM_NN/AZURE/CORE_ML/CPU/CUDA/DIRECT_ML/DNNL/NNAPI/OPEN_VINO/QNN/ROCM/TENSOR_RT/**XNNPACK**/WEB_*），但映射表只列三个加速 EP，其余**落 null 被滤掉**（`onnx_inference_ort.dart:45-49`，注释 `:44`「运行时回报的其他 EP（TensorRT、XNNPACK…）两个子系统都不选」）；`availableAcceleratedProviders()` 即 `getAvailableProviders()` 过表（`:136-143`）。**XNNPACK 在 Fushi 里等于不存在。**

### 9.3 平台偏好表：五平台全是「空表 = 纯 CPU」

`acceleratedProviderPreference`（`ocr_inference.dart:135-151`）**五个平台全返回空列表**，理由 `:140-149`：**Windows** 不要任何加速 EP——检测器是 **int8** RT-DETR-v2，在 ORT 1.22.0 DML EP 上**根本建不出会话**（挂 `MLOperatorAuthorImpl.cpp(2851)`、`E_INVALIDARG (0x80070057)`、`ORT_RUNTIME_EXCEPTION`，`:64-68`）；2026-09-02 实测（`:72-76`）int8 DML **建会话失败、白付 1547ms** 而 CPU 稳态 **81.5ms**，fp32 同架构对照 DML 建会话 2957ms/稳态 21.6ms、CPU 1461ms/419.4ms——「变量精确就是 int8 量化」（`:77-80`）；识别侧 DirectML 对自回归逐步解码是负优化（`:88-89`）；CUDA **没随包**（CMakeLists 钉 DirectML NuGet，逐字节扫 `onnxruntime.dll`：CUDA 符号 0 命中、`DmlExecutionProvider` 109 命中，`:91-103`）。**macOS/iOS** 见 §9.4；**Linux/Android** 同档（`:134`）。「空表」本身也是结论（`:105-109`）：留一个恒不可满足的 CUDA 会制造**用户消不掉的假告警**（每卷产出 `cuda not built into this ONNX Runtime -> cpu`），能力却与写空表逐字相同；所以 `wanted.isEmpty` 正是「该平台本来就该走 CPU」的静默判据（`manga_ocr_service_impl.dart:231-233`）。

### 9.4 Apple 实测（macOS 结论的核心证据）

`ocr_inference.dart:118-126`（同表 `docs/bugs/BUG-1613-...md:36-43`）：

| 平台 | EP | 检出 | 建会话 | 稳态/页 |
|---|---|---|---|---|
| macOS 26.6 (M 系列) | CoreML | 4/4 | 4248ms | 237ms |
| macOS 26.6 (M 系列) | **CPU** | 4/4 | **79ms** | **148ms** |
| iOS (A13) | CoreML | **0/0 ❌** | 9269ms | 1491ms |
| iOS (A13) | **CPU** | **4/4 ✅** | **174ms** | **381ms** |

结论（`:127-133`）：ORT 的 CoreML EP 把 int8 RT-DETR-v2 交给 ANE 后，iOS 上**静默算出空结果**——不抛异常、不触发 provider 回退，`onProviderResolved` 照报 `effective=coreml, fallback=null`，所以 BUG-1163 的降级可观测性**完全照不到它**；「CPU 两端都又快又对，CoreML 在任何页数下都追不平」。macOS 上 CoreML **结果正确但更慢**（`BUG-1613:30`），总耗时 `4248+237N` vs `79+148N`，N≥1 恒负（`:43`）。`coreml` 枚举与映射**保留**但生产不选（`:47-49`；`manga_ocr_apple_native_itest.dart:201-229` 有条非生产用例作为将来重新评估入口）。

### 9.5 macOS 上本地 OCR 到底能不能跑：**能**

①**闸门定义包含 macOS**：`fushi_asr_core`（git `d6acf83`）`packages/asr_core/lib/src/onnx/onnx_inference.dart:182-187` 返回 `isWindows || isLinux || isAndroid || isMacOS || isIOS`；经 `ocr_inference.dart:185-192` 转发，是 `MangaOcrServiceImpl.defaultPlatformSupport` 的唯一真相源（`manga_ocr_service_impl.dart:629`）。
②**宿主装配在 app 侧**：`fushi/lib/src/engine_bindings.dart:84-88` 写入 `ocrSessionFactoryBuilder = buildOrtOcrFactory`、`ocrIsolateBootstrap = fushiOcrIsolateBootstrap`、`ocrIsolateBootstrapArg = RootIsolateToken.instance`；`ocr_inference_ort.dart:43-60` 是插件工厂 + `BackgroundIsolateBinaryMessenger.ensureInitialized(token)` 引导。
③**Apple native 真机冒烟测试断言闸门为真**：`manga_ocr_apple_native_itest.dart:136-139`（`isLocalOnnxRuntimeAvailable` isTrue）、`:141-153`（`getPlatformVersion` 不抛 `MissingPluginException`，macOS 返回以 `macOS` 开头）、`:169-199`（真建会话 + 真跑 `Add` 推理，断言 `11.5/22.5` 且回调报 `effective=cpu, didFallBack=false`）；文件头 `:1-16` 说明理由：2026-08-14 前 fork 把 ios/macos 从 `flutter.plugin.platforms` 删掉，Apple 上任何会话构造都抛 `MissingPluginException`，而**纯 Dart 单测完全看不见**。
④**vendored fork 声明了 ios/macos 且原生树在**：`third_party/flutter_onnxruntime/pubspec.yaml:28-45` 的 `flutter.plugin.platforms` 同时列 android/ios/linux/macos/web/windows；`ios/`、`macos/` 下有 podspec + `Sources/`（Swift/ObjC++）；`PATCHES.md:9-12`「All five native platforms … are enabled — Hibiki's built-in manga OCR runs locally on every one of them.」；fork 的改动是**删 `Package.swift` 改走 CocoaPods**，把 Apple 部署下限从上游宣称的 iOS 16/macOS 14 降到 `onnxruntime-objc` 1.23.0 的真实下限 **iOS 15.1 / macOS 13.4**（`PATCHES.md:14-35`、`:44-45`、`:172-184`），**原生树一字节未动**（`:155-157`）。
⑤**端到端真机数字**（`manga_ocr_service_impl.dart:617-627`；测试 `fushi/integration_test/manga_ocr_volume_e2e_itest.dart`，断言每句字符重合率 `>= 0.75` 并打印耗时）：macOS 26.6（M 系列）**2.7s/页**（检测 148ms + 识别 4 块）；iPhone SE 2（A13, iOS 26.6）13.9s/页（检测 381ms + 识别 4 块）；识别耗时**随页内文字块数线性增长**，A13 上真实漫画 10~15 块/页折合 **35~50s/页**，新机型（A17/A18）大致快 3~4 倍（`:625-627`）。

### 9.6 ⚠️ 一处必须点名的仓库自相矛盾

根 `pubspec.yaml:131-138` 的 override 注释称：

> **Vendored fork drops the ios/macos plugin-platform declarations (+ deletes the Apple native trees)** so Flutter never registers it into the macOS Swift package; … **Apple's manga OCR degrades to interconnect-host / Gemini cloud (isLocalOnnxRuntimeAvailable).**

**这与仓库实际状态和代码都不符**：①fork 的 `pubspec.yaml:34-40` **声明了** ios/macos，`ios/`、`macos/` 原生树**存在**，`PATCHES.md:9-12`、`:155-157` 明确五平台全启用、Apple 原生树未动；②`isLocalOnnxRuntimeAvailable` 在 macOS/iOS 为 **true**（`asr_core .../onnx_inference.dart:182-187`），Apple **不会**降级到云端；③有 macOS 2.7s/页真机数字与 Apple native 冒烟测试。**结论：`pubspec.yaml:131-138` 是过期注释（描述更早一版 fork），不要据此判断平台能力**——只看它会得出「macOS 不能跑本地 OCR」的**错误结论**；应以 `PATCHES.md` + fork `pubspec.yaml` + `engine_bindings.dart` + 真机测试为准。

### 9.7 服务端后端不同源，行为也不同

`packages/fushi_server/lib/src/host_bindings.dart:35-40` 装配另一套：`buildServerOcrSessionFactory`（`asr_onnx_ffi` 纯 Dart FFI 会话）+ `serverOcrIsolateBootstrap`，`ocrIsolateBootstrapArg = ortPath`（运行库路径）。`ocr_host_bindings.dart:5-8`：两者都必须是顶层函数（只有顶层/静态函数能穿 `Isolate.spawn` 消息边界，闭包不行）；未装配就启动整卷任务是编程错误，`IsolateMangaOcrVolumeJobRunner.start` 直接抛 `StateError`（`manga_ocr_service_impl.dart:451-458`）。差异的真实后果就是 BUG-2518 的 int64 labels（§2.3）——**同一算法层、两个后端、元素类型契约不同**。

---

## 10. 服务层与并发（`manga_ocr_service_impl.dart`）

### 10.1 接口面

`MangaOcrService`（`manga_ocr_service.dart:11-36`）：`isSupportedPlatform` / `modelStatus()` / `downloadModels()` / `deleteModels()` / `ocrFolder({imageDirPath, volumeTitle})`；取消语义 `:9-10`「取消 Stream 订阅即请求中止；实现方须在页边界尽快停止并保留逐页断点缓存」。承载可观测性的返回类型：`MangaOcrModelStatus`（`:39-83`）的 `diskBytes`（目录**真实递归占用**）与 `obtainedBytes`（已就绪 + `.part` 攒下的）分工见 BUG-1732（`docs/bugs/BUG-1732-...md:9`、`:21-27`）——前者答「删掉能腾出多少」，后者答「还差多少下完」；还有 `allReady`/`hasResumableDownload`/`hasAnyFiles`。`MangaOcrAcceleration`（`:102-137`）：`detection`/`recognition` 实际生效 EP + `degradeReasons`，`degraded => degradeReasons.isNotEmpty`（BUG-1163「降级不允许静默」）。`MangaOcrVolumeEvent`（`:140-164`）：`.page(pagesDone, pagesTotal, acceleration)` 与 `.finished(pagesTotal, mangaJsonPath, acceleration)`。

### 10.2 isolate 结构与取消

头注释 `:1-19`：`flutter_onnxruntime` 是 MethodChannel 插件（native 注册在 root engine）；整卷任务把**全部 Dart 侧重活**（图片解码、预处理像素循环、beam search 记账）放进 `Isolate.spawn` 后台 isolate，靠 `BackgroundIsolateBinaryMessenger.ensureInitialized(RootIsolateToken)` 让插件调用直达 root engine 的 platform 线程——ORT native 推理本就跑在 native 线程，**UI isolate 全程零负担**；取消经 control SendPort 置位 `OcrCancelToken`，页/块边界停。实现：`_volumeJobIsolateMain`（`:274-439`）建 `ReceivePort`+`OcrCancelToken`（`:275-276`），收 `'cancel'` 即 `cancel()`（`:277-281`），回发 `SendPort`（`:282`）；主 isolate `_IsolateVolumeJob`（`:465-563`）持 `_events`/`_control`/`_cancelRequested`，`cancel()` 幂等（`:558-562`），**若取消早于 control port 到达则在 `_onMessage` 补发**（`:505-510`）。消息协议 `:122-151`（同代码库可直接发实例，`:120`）；`Isolate.spawn(..., onError: _events.sendPort, debugName: 'manga_ocr_volume_job')`（`:485-497`），未捕获错误走 `List<Object?>` 双元素通道（`:542-548`）。

### 10.3 每个任务的装配（内存开销的关键）

isolate 内按序（`:290-416`）：①`args.bootstrap?.call(...)`（Apple 上即 `BackgroundIsolateBinaryMessenger.ensureInitialized`，`:290-293`）；②`factoryBuilder()`（`:294`）；③**探测可用加速 EP**，抛异常也留痕并假定纯 CPU（`:295-310`，BUG-1163）；④`resolveOcrPlatform(...)` → `planOcrAcceleration(...)`（`:311-316`）产出 `OcrAccelerationPlan`（`:186-220`）；⑤**建 5 个会话**：`detector`←`TextDetector`（`:333-340`）、`encoder`（`:341-348`）、`decoder`（`:349-356`）、`lineDetector`←`PpOcrLineDetector`（`:377-382`）、`lineRecognizer`←`PpOcrLineRecognizer`（`:383-393`，词表由 `parsePpOcrCharacterDict(inference.yml)`+`buildPpOcrCtcVocab` 构造）——**注意**类头 `:3` 与 isolate 注释 `:273` 仍写「建三个 ORT 会话」，是**过期注释**，实际 5 个；⑥上报加速状态，只一次（`:357-366`）；⑦读 `vocab.txt` 构造 tokenizer（`:367-369`）、组装 `MangaOcrRecognizer`（`:370-374`）；⑧组装 `RoutingOcrRecognizer`（`:394-398`）；⑨**解析引擎签名**（`:400-406`）`resolveLocalMangaOcrEngineSignature(Directory(dirname(detectorPath)))`；⑩`runMangaOcrFolderJob`，`onProgress` 转发 `_JobProgressMessage`（`:407-416`）；⑪`finally` 里**逐个 close** detector、mangaOcr(encoder+decoder)、lineDetector、lineRecognizer（`:422-438`）——注释 `:430-432`：建到一半抛异常时 recognizer 还是 null，只关它会漏掉已建好的 det/rec。

### 10.4 「是否并行」「是否每任务重载 343MB」

- **页面不并行**：`processBook` 顺序 `for`（`manga_ocr_pipeline.dart:91-110`），页内块也顺序 `await`（`:129-143`）；**无 isolate pool / 无 batch / 无预取**。
- **343MB encoder 每任务加载一次、不是每页**：会话在装配阶段建一次（`:341-356`）整轮复用，`finally` 关闭（`:422-438`）。常驻约 detector 10.6 + encoder 327.5 + decoder 112.0 + PP det 9.4 + PP rec 20.2 ≈ **480 MiB 权重**，外加 ORT 运行时、激活、解码后整页位图与 beam 记账。每次 `ocrFolder` 都 `Isolate.spawn` 新 isolate 并重建 5 个会话（`:485-497`、`:333-393`），**没有跨任务会话池/预热**。
- **无全局并发闸门**（读完全文件 + 在 `fushi/lib/src/media/manga/` grep `Semaphore/_activeJob/singleFlight/_runningJob` 无命中；`manga_ocr_background_job.dart` 只是 54 行值对象）。**推断**：两卷同时启动会各起一个 isolate、各加载约 480 MiB 权重、内存近似翻倍；代码未禁止，只是没有 UI 入口主动这么干。复刻者应在主进程侧自己加**全局单任务队列**。

### 10.5 模型下载 / 续传 / 删除

`MangaOcrModelDownloader` 只是共享 `ModelFileDownloader` 的**薄适配**（`manga_ocr_model_downloader.dart:1-8`）：`.part` 临时名 + 原子 rename、HTTP Range 断点续传、主源失败换镜像、系统代理、进度节流全部住在 `lib/src/onnx/model_file_downloader.dart`（OCR/ASR 共用）；本文件只把清单交给共享下载器、把 `ModelDownloadEvent` 转成 `MangaOcrDownloadEvent`（`:50-68`）。进度按**文件粒度**报字节（`manga_ocr_service.dart:19`），节流间隔 `kMangaOcrDownloadProgressInterval`（`:16`）；候选 URL 可注入（测试指向本地 HttpServer，`:19-28`、`:39-46`）。
`modelStatus()`（`:647-681`）：逐文件就绪则 `obtainedBytes += lengthSync()`（`:656-659`）；未就绪但有 `.part` 也把 `.part` 大小计入（`:660-665`）——否则「用户取消或断网后回到设置页只看到一个『下载模型』按钮，会以为那 176 MB 白下了」（`manga_ocr_service.dart:67-70`）；按 role 置 ready 位（`:666-670`）；`diskBytes` 按**目录实际大小**而非清单累加（`:675-677`，BUG-1732）。`deleteModels()`（`:690-699`）：**先量后删**，返回真实释放量；注释 `:695`「删完再量只会得到 0」。
`ocrFolder` 闸门（`:736-752`）：`isSupportedPlatform` 为假直接抛；否则 `_manifestComplete()`（只 stat 清单文件，`:638-644`）为假抛 `'manga OCR models are not downloaded'`；注释 `:743-744` 说明不用 `modelStatus()` 的原因（占用统计要递归遍历目录，不该压在开跑路径上）。**订阅在模型检查期间已被取消则任务不启动**（`:749-752`）；`onCancel` 置标志并 `job?.cancel()`（`:796-799`）；`OcrCancelledException` 静默收流（`:783-784`）。

### 10.6 UI 如何拿到进度

逐跳链路：①isolate → `_JobProgressMessage`（`:413-415`）；②主 isolate `_onMessage` → `_onProgress`（`:518-523`），加速状态另走一条只报一次的消息（`:512-517`）；③`ocrFolder` 的 `onProgress` → `MangaOcrVolumeEvent.page`，每次带当时的 `acceleration`（`:759-770`；可能先为 null，`:734`、`:771-773`）；④服务层产 `finished` 带 `mangaJsonPath` 与 `lastTotal`（`:775-782`）；⑤app 侧 `mangaOcrLocalEvents`（`fushi/lib/src/media/manga/manga_ocr_job_stream.dart`）把 page 事件转成 `MangaOcrBackgroundEvent.progress(..., pageIndex, page, acceleration)`，其中**逐页从同一签名缓存读回该页结果**并组装 `MokuroImage`——阅读器据此**立即热替换该页文字层**，不必等整卷；⑥模型**下载**进度是独立通道：设置页按文件名覆盖式记录（`manga_ocr_settings_section.dart`：`_receivedByFile[event.fileName] = event.receivedBytes`，注释「同名文件取最新值而不是累加：同一文件会连发多条递增进度事件」），再求和得总体进度（`_downloadReceivedBytes` / `_downloadProgressValue = received/total`）——这正是 BUG-1732 症状 3 的修复（「一根进度条来回跑四趟（11 MB + 343 MB + 117 MB + 30 KB）」，见 `docs/bugs/BUG-1732-...md:9`）。加速状态上层消费（BUG-1163 文档 `:4`）：顶栏常驻后端标签（降级标黄）、tooltip 一行加速状态、首次降级弹一次 toast；i18n 键 `manga_ocr_acceleration_status` / `manga_ocr_acceleration_degraded`。

---

## 11. 给 fushi_lite 的启示

前提：Electron + TS + `onnxruntime-node`，目标 macOS，依赖已含 `onnxruntime-node@^1.30.0` 与 `ppu-paddle-ocr@^6.6.0`（`fushi_lite/package.json:35-36`）；`fushi_lite/src/core/ocr/` 下已有 `types.ts`/`geometry.ts`/`reading-order.ts`/`blocks.ts`/`pipeline.ts`/`png.ts`，`src/main/ocr/service.ts:33` 仍 import 尚不存在的 `paddle-recognizer`。

### 11.1 该抄的（全在纯逻辑层，零模型成本）

| # | 选择 | 为什么 | 位置 |
|---|---|---|---|
| 1 | **双阈值分离**：展示 1.25 / 路由 1.0 | 合并会让 1.0~1.25 近方块（「は？」「宮城！」）被切碎 | `manga_ocr_pipeline.dart:56`、`routing_ocr_recognizer.dart:35` |
| 2 | **路由＝宽高比一条判据** | 100+ 真实块结论：竖排整块给竖排引擎、横排切行给横排引擎，无第三种 | `routing_ocr_recognizer.dart:13` |
| 3 | **回落宁可幻觉不丢块** | 块在产物里消失，用户连点都点不到 | `:17-18`、`:55-60` |
| 4 | **逐页缓存按页名键 + (size,mtime) 失效 + 原子写** | 目录增删页后页号漂移；三元组是零成本脏检查 | `manga_ocr_folder_job.dart:165-166`、`:196-199`、`:227-240` |
| 5 | **引擎签名 required 且含模型内容指纹** | 上游换权重真实发生；不编进目录名就会新旧混卷 | `:318-325`、`manga_ocr_model_fingerprint.dart:98-116` |
| 6 | **记忆化 sidecar 用 (size,mtime)** | 480 MB 全量哈希不能每次开机重算 | `manga_ocr_model_fingerprint.dart:28-31`、`:57-97` |
| 7 | **检测前烘焙 EXIF 方向** | 渲染侧 Chromium 自动应用 EXIF，Node 侧不烘焙就错位（已踩过一次） | `manga_ocr_folder_job.dart:27-34`、`:299-308` |
| 8 | **进度含缓存命中页** | 续跑进度从上次位置继续，不归零 | `manga_ocr_pipeline.dart:45-46`、`:93-98` |
| 9 | **取消幂等 + 只在页/块边界检查** | TS/Dart 都只能协作式取消，检查点写循环头是唯一诚实做法 | `:22-36`、`manga_ocr_service_impl.dart:558-562` |
| 10 | **`diskBytes` 与 `obtainedBytes` 分开** | 「删掉能腾多少」与「还差多少下完」是两个问题；`.part` 两侧都算 | `manga_ocr_service.dart:51-82`、`manga_ocr_service_impl.dart:653-680` |
| 11 | **删除先量后删并返回释放量** | 删完再量恒为 0 | `manga_ocr_service_impl.dart:690-699` |
| 12 | **beam search 的 `early_stopping=true` + no-repeat-ngram + 长度惩罚** | 退化图上 `false` 跑满 300 步/10.6s/编小作文，是正确性问题 | `beam_search.dart:5-20`、`:260-274` |
| 13 | **振假名按厚度 p75 × 0.6 过滤** | 不过滤时 PP-OCR 在日漫上 CER 41%~92% | `ppocr_line_detector.dart:189-203` |
| 14 | **DB unclip 用连通域真实像素数算偏移量** | 倾斜行外接矩形面积虚大会吞邻行、识别串行（12° 实测 d 58→101） | `ppocr_line_detector.dart:170-173` |
| 15 | **几何阅读顺序三层**（面板 union-find → 行带 → 列 RTL） | 纯几何、无模型、可单测，远优于机械 (y,x) | `reading_order.dart:127-160` |
| 16 | **`vertical` 组装产物时按当前阈值重算并 `\|\|`** | 阈值口径变更不必全量重跑 OCR | `manga_ocr_folder_job.dart:277-282` |
| 17 | **`fontSize = sqrt(box.area / charCount)`** | 覆盖层渲染的经典估计，横竖排通用 | `:247-254` |
| 18 | **扩展名白名单单一真相源** | BUG-1121：两处手写白名单漂移导致 bmp 页静默跳过 | `:40-47`、`media_extensions.dart:17-24` |
| 19 | **自然序排序（p2 < p10）** | 纯字典序把 p10 排到 p2 前面 | `:61-103` |
| 20 | **NMS 按「气泡/文字」分组而非按 classId** | 同一 query 同时过两类会产出相同 rect，按 class 分组会重复识别两次 | `text_detector.dart:267-274` |

### 11.2 抄不动 / 不能抄

| Fushi 的东西 | 为什么抄不动 | 替代 |
|---|---|---|
| **manga-ocr encoder `343454249` B** | 单文件 327.5 MiB | 不引入；PP-OCR rec（`ppu-paddle-ocr` / PP-OCRv6 small rec `21159378` B） |
| **manga-ocr decoder `117480262` B** | 自回归 4-beam、无 KV cache，每步全序列重跑 | 不引入；CTC 贪心解码（`ppocr_line_recognizer.dart:105-131` 等价逻辑） |
| **双模型合计 460,934,511 B（≈439.6 MiB）** | 这就是「不能现实地随包发 manga-ocr」的原因（§11.5） | **PP-OCR + 竖排旋转**：竖排块旋转 90° 送 PP rec、结果逐字回正（`fushi_lite/src/core/ocr/types.ts` 的 `OcrRecognizer.recognizeCrop` 契约已按此写：`vertical=true` 时必须先顺时针旋转 90°） |
| **`Isolate.spawn` + `BackgroundIsolateBinaryMessenger`** | Dart/Flutter 专属；Electron 主进程本就是独立 Node 进程 | 主进程异步 + `worker_threads`（预处理像素循环）；不需要 isolate |
| **`flutter_onnxruntime` MethodChannel 插件** | Flutter 专属 | `onnxruntime-node`（已是依赖） |
| **Dart `package:image` 的 `bakeOrientation`/`copyResize`** | 语言不同 | `nativeImage` 或纯 TS 图像库；**关键不是库，而是 EXIF 口径与渲染侧一致并进签名** |
| **清单里的 HF `main` ref** | 可抄，但要把 4 条 `main` 全换成 revision sha（Fushi 只对 PP-OCR 做了） | 3 个 PP-OCR 文件 + 可选检测器全部钉 sha256 或 HF commit |
| **本地 ORT native 五平台随包** | 我们只要 macOS | `onnxruntime-node` 预编译二进制自带 darwin-arm64/x64 |

### 11.3 comic-text-and-bubble-detector 风格的 ONNX 检测器能在 Node 里跑吗？

**结论：能，且是当前性价比最高的增强项；但必须用 CPU EP，并接受两个已知风险。**

**(a) 它是普通 ONNX 文件。** 清单把它当**单个 `.onnx`** 下载（`manga_ocr_model_manifest.dart:55-61`：无 `.data` 分片、无自定义 op 库、无 Python 依赖）；Fushi 用 `factory.createSession(path, providers)` 直接按路径建会话（`manga_ocr_service_impl.dart:333-340`），`onnxruntime-node` 的 `InferenceSession.create(path)` 是同一件事。模型自带的 `preprocessor_config.json`/`config.json` 只是预处理参数，Fushi 已把手写预处理放在 `rtdetrPreprocess`（`text_detector.dart:113-154`），不依赖任何 HF 运行时。

**(b) 需要的算子与风险。** 仓库内 **not found**（Fushi 不检查也不打印算子表，模型未入库）。**外部证据**：RT-DETR 家族的可变形注意力在 ONNX 导出里落成 **`GridSample`**——ORT 有专门的正确性 issue，标题即「**[WebGPU EP] GridSample kernel produces incorrect output in deformable-attention decoders (RT-DETR-family)**」（[onnxruntime#32275](https://github.com/microsoft/onnxruntime/issues/32275)），更老版本还有 `NOT_IMPLEMENTED GridSample(16)`（[onnxruntime#15137](https://github.com/microsoft/onnxruntime/issues/15137)）。含义：**CPU EP 上 GridSample 久经使用；WebGPU/其它 EP 有已知正确性/覆盖问题，不要用。** int8 量化导出会带 `QuantizeLinear`/`DequantizeLinear`/`DynamicQuantizeLinear` 等标准量化算子（推断自「int8 量化」这一事实，`ocr_inference.dart:64-66`、`manifest:4-7`），CPU EP 都支持；图内后处理（输出 `scores/labels/boxes`，`text_detector.dart:12-13`）还有 top-k/NMS/concat 之类，同为标准算子。

**(c) `onnxruntime-node` 在 macOS 的 EP 现实**（[ORT Node.js Binding README](https://raw.githubusercontent.com/microsoft/onnxruntime/main/js/node/README.md)）：CPU ✔️（macOS x64/arm64）、WebGPU ✔️（experimental）、CoreML ✔️、DirectML/CUDA ❌。即 **macOS 上用 CPU EP**；CoreML 可枚举但按 BUG-1613 对 int8 检测器不值得冒险；WebGPU 正好踩在 #32275 上，明确避开。

**(d) 必须照抄的三个解码细节**：①**两种输出布局都吃**（`text_detector.dart:366-395`）；②**`labels` 不要假设是 float**，可能 int64/int32（`:217-224`，BUG-2518）；③**NMS 按「气泡/文字」分组，不能按 classId 分组**（`:267-274`）。

**(e) 最小工作量（推断）**：把 `text_detector.dart:26-321` 的 `computeLetterbox`/`rtdetrPreprocess`/`decodeRtdetrOutputs`/`decodeProcessedRtdetrOutputs`/`nmsGroupOf`/`applyClassAwareNms`/`buildPageDetections` 逐函数翻成 TS——全是纯函数、零 ONNX 依赖（该文件只 import `ocr_inference` 与 `ocr_types`），约 300 行有效逻辑，喂 `InferenceSession.run({pixel_values, orig_target_sizes})`。

### 11.4 最该先做的三件事

1. **把 `ppu-paddle-ocr` + 竖排旋转跑通**——唯一能让「日漫整卷」可用且体积可控的路径。几何侧（旋转/回正、列 RTL、1.25 阈值）已在 `src/core/ocr/` 就位，缺的是 `paddle-recognizer`（`src/main/ocr/service.ts:33` 已 import 但文件不存在）。
2. **若 PP-OCR 的竖排补偿质量不够，再上 11 MB 的 RT-DETR 检测器**——它补的正是「框从哪来、气泡在哪、横竖块怎么分」，体积只 +10.6 MiB。**本报告最高确定性的建议。**
3. **最后才考虑 manga-ocr**：只在「体积不是约束 + 竖排质量是硬指标」时引入；一旦引入，encoder/decoder **必须按需下载而非随包**（Fushi 也如此：`design.md:118-121`「模型按需下载（设置里显式触发，不随包，走用户代理配置）」）。

### 11.5 关于体积，把话说直白

| 组合 | 磁盘 | 说明 |
|---|---|---|
| PP-OCRv6 small det + rec + 字典 | **31,190,469 B ≈ 29.7 MiB** | Fushi 横排路径的量；`ppu-paddle-ocr` 预置 tiny 档约 6 MB |
| + RT-DETR-v2 检测器 | **+11,120,765 B ≈ +10.6 MiB** → 约 40 MiB | 换来气泡/文字三分类与更好的漫画框 |
| + manga-ocr encoder | **+343,454,249 B ≈ +327.5 MiB** | 单文件就比前两项之和多一个数量级 |
| + manga-ocr decoder | **+117,480,262 B ≈ +112.0 MiB** | 自回归解码还需逐步 ORT 往返 |
| Fushi 全套 7 文件 | **503,275,961 B ≈ 480 MiB** | **460,934,511 B（439.6 MiB，91.6%）是 manga-ocr 双模型** |

**结论：`fushi_lite` 不可能现实地随包或默认可选地使用 manga-ocr。** 它的两个模型占全套 91.6%，且 encoder 343 MB 每次任务都要进内存驻留（§10.4）。对一个 lean Electron/TS clone 来说，这是唯一一个**从量级上**就不成立的选项。**PP-OCR + 竖排旋转是唯一现实的识别回退**；而 11 MB 的 `comic-text-and-bubble-detector` **可以也应该**用 `onnxruntime-node`（CPU EP）吃进来——它是 RT-DETR，但文件是普通 ONNX、预处理/后处理都能纯 TS 复刻（§11.3），风险集中在 `GridSample` 的 EP 覆盖，而 CPU EP 正是我们唯一要用的那个。

---

## 附录 · 证据索引与缺口

**源码**（`packages/fushi_engine/lib/ocr/`，括号行数）：`manga_ocr_model_manifest.dart`(140)、`manga_ocr_model_downloader.dart`(69)、`manga_ocr_model_fingerprint.dart`(168)、`manga_ocr_service.dart`(164)、`manga_ocr_service_impl.dart`(802)、`manga_ocr_pipeline.dart`(151)、`manga_ocr_recognizer.dart`(211)、`manga_ocr_tokenizer.dart`(78)、`manga_ocr_folder_job.dart`(391)、`routing_ocr_recognizer.dart`(112)、`ocr_inference.dart`(254)、`ocr_types.dart`(192)、`ocr_host_bindings.dart`(27)、`text_detector.dart`(400)、`ppocr_line_detector.dart`(274)、`ppocr_line_recognizer.dart`(180)、`reading_order.dart`(161)、`beam_search.dart`(300)；另 `media/manga/mokuro_payload.dart`、`media/media_extensions.dart`。
**宿主/后端**：`fushi/lib/src/onnx/onnx_inference_ort.dart`、`fushi/lib/src/ocr/ocr_inference_ort.dart`、`fushi/lib/src/engine_bindings.dart:84-88`、`packages/fushi_server/lib/src/host_bindings.dart:35-40`、`fushi_asr_core`（git `d6acf83`）`packages/asr_core/lib/src/onnx/onnx_inference.dart:120-187`。
**fork / pubspec**：`third_party/flutter_onnxruntime/PATCHES.md`、同目录 `pubspec.yaml:1-45`、`lib/src/ort_provider.dart:13-32`、根 `pubspec.yaml:131-140`（**与实际不符，§9.6**）。
**测试**：`fushi/integration_test/manga_ocr_volume_e2e_itest.dart`、`manga_ocr_apple_native_itest.dart:117-230`。
**文档**：`docs/bugs/BUG-1121/1163/1173/1613/1732/1780/2050/2457/2516/2518`；`docs/specs/2026-07-24-manga-ocr-design.md:87-147`、`:176`、`:189`。
**外部证据（仅 §11.3）**：[ORT Node.js Binding 支持矩阵](https://raw.githubusercontent.com/microsoft/onnxruntime/main/js/node/README.md)、[#32275](https://github.com/microsoft/onnxruntime/issues/32275)、[#15137](https://github.com/microsoft/onnxruntime/issues/15137)、本地 `fushi_lite/node_modules/ppu-paddle-ocr/README.md:79,90,118,220`。

**未找到 / 未验证（不作承诺）**：`vocab.txt` token 总数（只有文件字节 30,216）；`detector-v4-s_int8.onnx` 的实际算子表/opset（仓库内 not found，§11.3 的 `GridSample` 来自外部 issue）；CoreML 在 **macOS** 上对 int8 检测器是否偶发算错（Fushi 的 macOS 实测是「正确但更慢」，无错误样本）；Android/Linux 整卷本地 OCR 真机数字（BUG-1780 明确「安卓真机从未跑过 ORT」）；同时跑两卷本地 OCR 的实际内存上限（代码无全局闸门也无实测，§10.4 的翻倍是推断）。
