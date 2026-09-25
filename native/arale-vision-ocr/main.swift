// arale-vision-ocr —— 把 macOS 自带的 Vision 文字识别包成一个流式命令行工具。
//
// 为什么是「一个小工具 + spawn」而不是原生 Node 模块：Vision 是 Objective-C/Swift API，
// Node 侧没有绑定（`node-gyp` 编一个 N-API 插件要多背一套 Electron ABI 维护成本）。
// 而我们已经有一个成熟的「spawn 原生二进制、按行读 JSON」模式（Rust 解包器 + Python 桥），
// 复用它比重造一套绑定简单得多，也更容易在崩溃时兜住（子进程死了不会带走主进程）。
//
// 用法：
//   arale-vision-ocr [--lang ja-JP,en-US] [--min-confidence 0] -- <image> [<image> ...]
//
// 输出：**NDJSON**，一行一个 JSON 对象，写一行 flush 一行。这样主进程能边收边报进度，
// 也能在用户点「停止识别」时直接 kill 掉进程，不必等整本跑完。
//
//   {"kind":"meta","engine":"vision","languages":["ja-JP"],"requested":["ja-JP","en-US"]}
//   {"kind":"page","file":"…","ok":true,"width":1441,"height":2048,"lines":[{"text":"…","confidence":0.98,"box":[x1,y1,x2,y2],"vertical":true}]}
//   {"kind":"page","file":"…","ok":false,"error":"…"}
//   {"kind":"fatal","error":"…"}
//   {"kind":"probe","ok":true}                                   ← `--probe` 模式，只跑这一行
//
// 首行永远是 `meta`：主进程靠它知道**实际**用了哪些语言（系统可能不支持日语，
// 那时会降级），从而在界面上提示「这台机器的 OCR 不支持日文」而不是让用户对着
// 一堆识别不出的页发呆。
//
// `kind` 字段是显式的，不靠位置判断——协议以后要加 `progress` 之类的新行时，
// 老主进程会干净地忽略未知 kind，而不是把新行当成页结果解析出一堆 undefined。
//
// 退出码：0 = 跑完（个别页失败算跑完，逐行报错）；1 = 参数/环境问题；2 = 一页都没处理。

import Foundation
import Vision
import ImageIO
import CoreGraphics

// MARK: - 参数

struct Options {
    var languages: [String] = ["ja-JP", "en-US"]
    var minConfidence: Double = 0
    var files: [String] = []
    /// 只做自检，不识别任何文件。
    var probe = false
}

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(("arale-vision-ocr: " + message + "\n").data(using: .utf8)!)
    exit(code)
}

func parseOptions() -> Options {
    var options = Options()
    let rest = Array(CommandLine.arguments.dropFirst())
    var index = 0
    var reachedSeparator = false

    while index < rest.count {
        let arg = rest[index]
        if arg == "--" {
            reachedSeparator = true
            index += 1
            continue
        }
        if !reachedSeparator {
            switch arg {
            case "--lang":
                guard index + 1 < rest.count else { fail("--lang 缺少值", code: 1) }
                options.languages = rest[index + 1]
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
                index += 2
                continue
            case "--min-confidence":
                guard index + 1 < rest.count, let value = Double(rest[index + 1]) else {
                    fail("--min-confidence 需要一个小数", code: 1)
                }
                options.minConfidence = value
                index += 2
                continue
            case "--probe":
                options.probe = true
                index += 1
                continue
            case "--help", "-h":
                print("用法: arale-vision-ocr [--lang ja-JP,en-US] [--min-confidence 0] -- <image> ...")
                exit(0)
            default:
                // 未知选项直接报错，而不是当成文件名——打错的选项必须立刻可见。
                if arg.hasPrefix("-") { fail("未知选项 \(arg)", code: 1) }
            }
        }
        options.files.append(arg)
        index += 1
    }

    if !options.probe && options.files.isEmpty { fail("没有给图片路径", code: 1) }
    return options
}

// MARK: - 输出

/// 一页的识别结果。
struct Line: Encodable {
    let text: String
    let confidence: Double
    /// 原图像素坐标 `[x1, y1, x2, y2]`，左上原点（Vision 给的是左下原点的归一化坐标）。
    let box: [Double]
    /// Vision 不告诉我们文字方向，所以按框的宽高比推。见 `isVertical`。
    let vertical: Bool
}

/// 首行元信息：实际生效的识别语言。
struct MetaLine: Encodable {
    let kind = "meta"
    let engine = "vision"
    /// 实际生效的语言（系统不支持请求的语言时会降级）。
    let languages: [String]
    /// 请求的语言（原样回显，便于主进程对比并提示）。
    let requested: [String]
}

struct PageResult: Encodable {
    let kind = "page"
    let file: String
    let ok: Bool
    var width: Int? = nil
    var height: Int? = nil
    var lines: [Line]? = nil
    var error: String? = nil
}

/// 自检结果。
struct ProbeLine: Encodable {
    let kind = "probe"
    let ok: Bool
    var error: String? = nil
}

/// 致命错误行（主进程据此给出可操作提示）。
struct FatalLine: Encodable {
    let kind = "fatal"
    let error: String
}

/// NDJSON 写一行、flush 一行。
///
/// 必须显式 flush：stdout 接的是管道（不是 tty）时默认是**全缓冲**的，不 flush 的话
/// 主进程要等缓冲区满（几十 KB）才收得到第一页，进度条会一直停着。
let stdoutHandle = FileHandle.standardOutput
let jsonEncoder = JSONEncoder()

func emit<T: Encodable>(_ value: T) {
    // 日文文本不转义成 \uXXXX：日志里直接可读，也省字节。
    jsonEncoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? jsonEncoder.encode(value) else { return }
    stdoutHandle.write(data)
    stdoutHandle.write("\n".data(using: .utf8)!)
    try? stdoutHandle.synchronize()
}

// MARK: - 自检

/// 在内存里造一张 32×32 的灰图，用它跑一次 accurate 请求。
///
/// 为什么需要这个：`.accurate` 走的是系统里的 `TextRecognition` 框架，它依赖系统
/// **按需下载**的识别资源。资源缺失时 `perform` 抛的是一句毫无信息量的
/// `Foundation._GenericObjCError 0` / `CRImageReaderError 9`，而 `.fast` 仍然"能用"
/// （只是识别质量形同虚设）。
///
/// 没有自检的话，用户会看到引擎「可用」，然后点「识别文字」，接着整本 171 页
/// **每一页**都失败——半小时的等待换一本空文字层。自检把这件事提前到 50 毫秒内
/// 说清楚。
///
/// 用空白图：失败发生在解码/加载资源阶段，与图上有没有文字无关（已实测：
/// 16×16 空白图与 1441×2048 真实漫画页给出完全相同的错误）。
func selfCheck() -> ProbeLine {
    let width = 32
    let height = 32
    let bytesPerRow = width * 4
    var pixels = [UInt8](repeating: 0xff, count: bytesPerRow * height)

    guard let provider = CGDataProvider(data: Data(pixels) as CFData),
          let image = CGImage(
            width: width, height: height,
            bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
          )
    else {
        return ProbeLine(ok: false, error: "无法构造自检用的测试图")
    }
    pixels.removeAll()

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    do {
        try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
        return ProbeLine(ok: true)
    } catch {
        let nsError = error as NSError
        return ProbeLine(
            ok: false,
            error: "\(nsError.domain) \(nsError.code)：系统文字识别资源不可用"
        )
    }
}

// MARK: - 识别

/// 竖排判定。
///
/// Vision 的 `VNRecognizedTextObservation` **不提供文字方向**（这不是漏看文档：
/// 公开 API 里确实没有），所以只能按框的宽高比推断。阈值 1.25 与
/// `src/core/ocr/types.ts` 的 `VERTICAL_ASPECT_THRESHOLD` 保持一致——两处不一致会导致
/// 「同一页在 TS 侧算横排、在 Swift 侧算竖排」这种极难查的错。
///
/// 已知局限：只有一个字的竖排短句（「は？」）框接近方形，会被判成横排。
/// 影响面很小——`vertical` 只用于文字层里块的书写模式，不参与查词。
func isVertical(boxWidth: Double, boxHeight: Double) -> Bool {
    let width = max(1, boxWidth)
    let height = max(1, boxHeight)
    return height / width >= 1.25
}

/// 实际生效的识别语言。第一页跑完就定下来，之后不再变。
///
/// 为什么不预先查「系统支持哪些语言」：那个 API
/// （`supportedRecognitionLanguages(for:revision:)`）在 macOS 12 起就被标记为弃用，
/// 而替代品在各版本上行为不一致。这里改成**乐观传入 + 失败重试**：先按请求的语言跑，
/// 抛错就去掉语言设置再跑一次（用系统默认）。跨版本稳定，也不依赖弃用 API。
var effectiveLanguages: [String] = []

func recognize(file: String, options: Options) -> (PageResult, [String]) {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        let page = PageResult(file: file, ok: false, error: "读不出这张图（格式不支持或文件损坏）")
        return (page, options.languages)
    }

    let width = image.width
    let height = image.height
    guard width > 0, height > 0 else {
        let page = PageResult(file: file, ok: false, error: "图片尺寸为 0")
        return (page, options.languages)
    }

    func makeRequest(languages: [String]?) -> VNRecognizeTextRequest {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        // 语言校正会利用词典修正字形相近的字，对漫画的拟声词/专有名词偶有副作用，
        // 但整体收益明显（尤其假名）。保留默认开启。
        request.usesLanguageCorrection = true
        if let languages, !languages.isEmpty { request.recognitionLanguages = languages }
        return request
    }

    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    let requested = options.languages
    var request = makeRequest(languages: requested)
    var languages = requested
    do {
        try handler.perform([request])
    } catch {
        // 这台机器不支持请求的语言（没装语言包）。退回系统默认再试一次——
        // 能识别总比整本报错好，`meta` 行会把降级事实告诉用户。
        request = makeRequest(languages: nil)
        languages = []
        do {
            try handler.perform([request])
        } catch {
            let page = PageResult(
                file: file, ok: false,
                error: "Vision 识别失败：\(error.localizedDescription)"
            )
            return (page, requested)
        }
    }

    let observations = request.results ?? []
    var lines: [Line] = []
    lines.reserveCapacity(observations.count)

    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
        if Double(candidate.confidence) < options.minConfidence { continue }

        // Vision 的 boundingBox 是**归一化 + 左下原点**；阅读器要的是原图像素 + 左上原点。
        let bb = observation.boundingBox
        let x1 = Double(bb.minX) * Double(width)
        let y1 = (1 - Double(bb.maxY)) * Double(height)
        let x2 = Double(bb.maxX) * Double(width)
        let y2 = (1 - Double(bb.minY)) * Double(height)

        lines.append(Line(
            text: text,
            confidence: Double(candidate.confidence),
            box: [x1, y1, x2, y2],
            vertical: isVertical(boxWidth: x2 - x1, boxHeight: y2 - y1)
        ))
    }

    let page = PageResult(file: file, ok: true, width: width, height: height, lines: lines)
    return (page, languages)
}

// MARK: - main

let options = parseOptions()

if options.probe {
    let result = selfCheck()
    emit(result)
    exit(result.ok ? 0 : 3)
}

// 先占位：真正的语言要等第一页跑出来才知道。
emit(MetaLine(languages: [], requested: options.languages))

var succeeded = 0
for (index, file) in options.files.enumerated() {
    let (result, languages) = recognize(file: file, options: options)
    if result.ok { succeeded += 1 }
    emit(result)
    if index == 0 {
        effectiveLanguages = languages
        emit(MetaLine(languages: languages, requested: options.languages))
    }
}

if succeeded == 0 { exit(2) }
exit(0)
