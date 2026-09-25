/**
 * **扩展提供的 OCR 引擎**（目前是 manga-anki，将来可能是任何东西）。
 *
 * ## 这个文件刻意不知道 Python 的存在
 *
 * 扩展在它自己的 `extension.json` 里声明：
 *
 * ```json
 * {
 *   "id": "ocr-manga-anki", "version": "1.0.0", "kind": "ocr-engine",
 *   "provides": "manga-anki",
 *   "engine": { "label": "manga-anki（mokuro 管线）", "requirement": "…", "downloadSizeMb": 0 },
 *   "runner": { "program": "bin/ocr-run", "args": ["--manga-anki-root", ".", "--pages-file", "{pagesFile}"] }
 * }
 * ```
 *
 * 应用只做三件事：把页清单写成一个文件、按 `runner` spawn、按统一协议读 NDJSON。
 * **它不知道 runner 是 shell 脚本、是 Python、还是 Rust 二进制。**
 *
 * 这一点是刻意的：manga-anki 今天是一个 1.6 GB 的 Python 运行时（实测：site-packages
 * 1077 MiB + 模型 500 MiB + 精简解释器 47 MiB，gzip 后 734 MiB），而它的两个模型
 * （comic-text-detector 的检测器 + manga-ocr 的 ViT/BERT 编解码器）都是标准
 * PyTorch 结构，理论上可以导出成 ONNX 用 Rust 直接跑。那样扩展会缩到「模型 + 一个
 * 二进制」，并且没有 Python。届时**只需要换一个归档、改一份 `extension.json`**，
 * 这个文件一行都不用动。把 Python 知识写进来的话，那次替换就变成了重写。
 *
 * ## 页清单走文件而不是 argv
 *
 * 两三百页的绝对路径拼进命令行有撞 `ARG_MAX` 的风险，而且清单里还要带 `rel` 与
 * 尺寸，runner 端不必回头猜。清单文件放在临时目录，跑完就删。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { OcrEngineStatus, OcrProviderId, PageText } from '../../../shared/types';
import type { ExtensionManifest } from '../../../shared/extensions';
import { buildBlocks } from '../../../core/ocr/blocks';
import { computeReadingOrder } from '../../../core/ocr/reading-order';
import type { OcrBox } from '../../../core/ocr/types';
import { isVerticalBox } from '../../../core/ocr/types';
import type { ExtensionService } from '../../extensions/service';
import { resolveInside } from '../../extensions/service';
import { runOcrProcess } from '../runner';
import type { OcrBookContext, OcrEngine } from '../provider';

export interface ExtensionOcrEngineOptions {
  /** 提供这个引擎的扩展 id。 */
  extensionId: string;
  /** 引擎标识（= 扩展的 `provides`）。 */
  engineId: OcrProviderId;
  extensions: ExtensionService;
}

/** 页清单里的一条。runner 端**必须**按 `rel` 回填 `file` 字段，否则结果对不上页号。 */
export interface PageSpecEntry {
  rel: string;
  absPath: string;
  width: number;
  height: number;
}

export class ExtensionOcrEngine implements OcrEngine {
  constructor(private readonly options: ExtensionOcrEngineOptions) {}

  get id(): OcrProviderId {
    return this.options.engineId;
  }

  /** 读到的自描述；没装或坏了就是 null。 */
  private manifest(): ExtensionManifest | null {
    return this.options.extensions.readManifest(this.options.extensionId);
  }

  async status(): Promise<OcrEngineStatus> {
    // `?? null` 不可省：`Array.find` 找不到时返回 `undefined`，而 `undefined === null`
    // 是 false，于是「没装」会被错判成「装了但坏了」，给出完全误导的提示。
    const installed =
      this.options.extensions.installed().find((item) => item.id === this.options.extensionId) ??
      null;
    const entry = this.options.extensions
      .list()
      .statuses.find((item) => item.entry.id === this.options.extensionId)?.entry;

    const label = this.manifest()?.engine?.label ?? entry?.name ?? this.options.engineId;
    const bytes = entry?.bytes ?? 0;

    if (installed === null) {
      return {
        id: this.id,
        label,
        available: false,
        ready: false,
        reason:
          entry === undefined
            ? '扩展清单里没有这个引擎；到「设置 → 扩展」刷新一下清单'
            : `还没有安装这个扩展（${describeSize(bytes)}）。到「设置 → 扩展」里安装。`,
        requirement: this.manifest()?.engine?.requirement ?? '需要先安装扩展',
        downloadSizeMb: Math.round(bytes / (1024 * 1024)),
        extension: { id: this.options.extensionId, bytes, installed: false },
      };
    }

    const manifest = this.manifest();
    if (manifest === null) {
      return {
        id: this.id,
        label,
        available: false,
        ready: false,
        reason: `扩展已安装但读不到 extension.json（${this.options.extensions.installDir(this.options.extensionId)}）。重装一次。`,
        requirement: '扩展损坏',
        downloadSizeMb: 0,
        extension: { id: this.options.extensionId, bytes, installed: true },
      };
    }
    if (manifest.runner === undefined) {
      return {
        id: this.id,
        label,
        available: false,
        ready: false,
        reason: '扩展的 extension.json 里没有声明 runner，无法启动',
        requirement: '扩展格式不对',
        downloadSizeMb: 0,
        extension: { id: this.options.extensionId, bytes, installed: true },
      };
    }

    const program = resolveInside(
      this.options.extensions.installDir(this.options.extensionId),
      manifest.runner.program,
    );
    if (program === null || !fs.existsSync(program)) {
      return {
        id: this.id,
        label,
        available: false,
        ready: false,
        reason: `扩展声明的 runner 不存在：${manifest.runner.program}`,
        requirement: '扩展损坏',
        downloadSizeMb: 0,
        extension: { id: this.options.extensionId, bytes, installed: true },
      };
    }

    return {
      id: this.id,
      label,
      available: true,
      ready: true,
      reason: null,
      requirement: manifest.engine?.requirement ?? `来自扩展 ${this.options.extensionId}`,
      downloadSizeMb: 0,
      extension: { id: this.options.extensionId, bytes, installed: true },
    };
  }

  async recognizeBook(context: OcrBookContext): Promise<PageText[]> {
    const pages = context.pages;
    const results: PageText[] = pages.map((page) => ({ url: page.rel, blocks: [] }));
    if (pages.length === 0) return results;

    const manifest = this.manifest();
    if (manifest?.runner === undefined) throw new Error('扩展没有声明 runner，无法启动 OCR');

    const installDir = this.options.extensions.installDir(this.options.extensionId);
    const program = resolveInside(installDir, manifest.runner.program);
    if (program === null) throw new Error(`扩展的 runner 路径越界：${manifest.runner.program}`);

    const specPath = writePageSpec(pages);
    try {
      // `file` 回显的是**我们写进清单的 rel**，所以按 rel 反查页号——
      // 比按到达顺序反查可靠：单页失败、runner 乱序都会让顺序不可信。
      const byRel = new Map(pages.map((page, index) => [page.rel, index] as const));

      const result = await runOcrProcess({
        program,
        args: manifest.runner.args.map((arg) => arg.replace('{pagesFile}', specPath)),
        cwd: installDir,
        env: {
          ...process.env,
          // runner 是自己带的运行时，别让它去联网找东西。
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          ...(manifest.runner.env ?? {}),
        },
        onPage: (page) => {
          // 有些 runner 回显 rel，有些回显 absPath —— 两种都认，因为扩展作者
          // 习惯不同，而这是纯粹的路径口径分歧，不该让扩展装不上。
          const index =
            byRel.get(page.file) ??
            byRel.get(path.basename(page.file)) ??
            findIndexByAbsPath(pages, page.file);
          if (index === undefined || index < 0) return;
          const target = results[index];
          if (target === undefined) return;
          target.blocks = page.ok
            ? toBlocks(page.lines, context.direction)
            : [];
          context.onPage(index, target.blocks);
        },
        isCancelled: context.isCancelled,
      });

      if (result.cancelled) return results;

      if (result.fatal !== null) {
        // 整本没跑起来（环境不完整、模型损坏）。报出来，别让用户看到一本空文字层。
        throw new Error(withStderr(result.fatal, result.stderr));
      }
      if (result.pages === 0 && result.failedPages === 0) {
        throw new Error(
          withStderr(
            result.code === null
              ? 'OCR 运行进程异常退出'
              : `OCR 运行进程没有产出任何结果（退出码 ${result.code}）`,
            result.stderr,
          ),
        );
      }
      return results;
    } finally {
      fs.rmSync(specPath, { force: true });
    }
  }

  async dispose(): Promise<void> {
    // runner 每次都是独立进程，没有常驻资源。
  }
}

/** 把引擎给的行整理成 mokuro 块（与系统引擎共用同一套排序/成块）。 */
function toBlocks(
  lines: readonly { text: string; confidence: number; box: [number, number, number, number]; vertical: boolean }[],
  direction: 'ltr' | 'rtl',
): PageText['blocks'] {
  if (lines.length === 0) return [];
  const boxes: OcrBox[] = lines.map((line) => ({
    box: line.box,
    text: line.text,
    confidence: line.confidence,
    vertical: line.vertical || isVerticalBox(line.box),
  }));
  const order = computeReadingOrder(
    boxes.map((item) => item.box),
    { rightToLeft: direction === 'rtl' },
  );
  return buildBlocks(order.map((index) => boxes[index]).filter((item): item is OcrBox => item !== undefined));
}

function findIndexByAbsPath(pages: readonly { absPath: string }[], file: string): number | undefined {
  const index = pages.findIndex((page) => page.absPath === file);
  return index < 0 ? undefined : index;
}

/**
 * 写页清单。runner 端接受 `{"pages":[…]}` 或裸数组（两种都支持是历史原因：
 * 旧的桥接脚本两种都认，新扩展沿用即可）。
 */
function writePageSpec(pages: readonly PageSpecEntry[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-ocr-pages-'));
  const file = path.join(dir, 'pages.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      { pages: pages.map((page) => ({ rel: page.rel, absPath: page.absPath, width: page.width, height: page.height })) },
      null,
      2,
    ),
    'utf8',
  );
  return file;
}

/** 把 stderr 尾部附到错误信息里——只报「失败」的话用户完全不知道该改什么。 */
function withStderr(message: string, stderr: string): string {
  const tail = stderr.split('\n').slice(-4).join(' ').trim();
  return tail === '' ? message : `${message}：${tail}`;
}

/**
 * 「多大」的说明。
 *
 * `bytes: 0` 要如实说「大小未知」，不能凑成「约 1 MB」——那会让用户以为点一下就下完，
 * 结果下 700 MB。清单里的 `bytes` 是可选字段（`parseCatalog` 缺失时填 0）。
 */
function describeSize(bytes: number): string {
  if (bytes <= 0) return '大小未知';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `需要下载约 ${(mb / 1024).toFixed(1)} GB` : `需要下载约 ${Math.round(mb)} MB`;
}
