/**
 * **系统 OCR** 引擎：用操作系统自带的文字识别。
 *
 * - macOS：`/usr/bin/Vision` 框架（`VNRecognizeTextRequest`），本仓库里的
 *   `native/arale-vision-ocr` Swift 小工具把它包成流式命令行。
 * - Windows：`Windows.Media.Ocr`（WinRT），由 `system-winrt.ps1` 通过 PowerShell 调用。
 *
 * ## 为什么是「小工具 + spawn」而不是原生绑定
 *
 * 两个系统的 OCR 都在系统框架里，Node 没有绑定。写原生 N-API 插件要多背一套
 * Electron ABI 维护成本（每次升 Electron 都要重编），而我们**已经有**成熟模式：
 * spawn 原生二进制 + 按行读 JSON（Rust 解包器、Python 桥都是这样）。复用它更简单，
 * 也更抗崩——子进程挂了不会带走主进程，用户还能继续翻页。
 *
 * ## 为什么它值得当默认引擎
 *
 * 零下载、零额外依赖、随包走。质量上它对**横排**日文很好，竖排弱于扩展引擎，
 * 但它是唯一「新装就能用」的引擎——不装任何东西就能点出词典，这件事本身就是价值。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { OcrEngineStatus } from '../../../shared/types';
import { runOcrProcess } from '../runner';
import type { OcrBookJob, OcrEngine, OcrPageOut, OcrSink } from '../provider';

export const SYSTEM_ENGINE_ID = 'system';

/** 一次传给小工具的页数。 */
const PAGES_PER_INVOCATION = 40;

export interface SystemOcrEngineOptions {
  /**
   * 小工具的候选目录，按顺序找第一个存在的（打包布局 → 开发布局 → cwd）。
   * 引擎自己知道本平台的文件名，所以只接目录列表，不接具体路径。
   */
  toolDirs: string[];
}

export class SystemOcrEngine implements OcrEngine {
  readonly id = SYSTEM_ENGINE_ID;

  constructor(private readonly options: SystemOcrEngineOptions) {}

  /**
   * 找出这台机器上真正能用的那个小工具。
   *
   * 顺序：平台专属文件名 → 额外搜索目录。返回 null 表示这台机器没有可用的系统 OCR
   * （Linux 就是这样——它没有统一的系统 OCR API）。
   */
  private resolveTool(): string | null {
    const names =
      process.platform === 'darwin'
        ? ['arale-vision-ocr']
        : process.platform === 'win32'
          ? ['arale-winrt-ocr.ps1']
          : [];
    if (names.length === 0) return null;

    for (const dir of this.options.toolDirs) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          /* 找不到继续 */
        }
      }
    }
    return null;
  }

  /**
   * 自检结果缓存。
   *
   * 一个进程只探一次：自检要 spawn 一个进程（约 50 ms），而 `status()` 在设置页
   * 每次打开、书详情每次刷新都会被调到。缓存的是**失败**也缓存——系统资源不会在
   * 应用运行期间凭空出现（真出现了，重启应用即可）。
   */
  private probeCache: { ok: boolean; error: string | null } | null = null;

  /**
   * 真的跑一次识别，确认这套系统 OCR 在这台机器上能用。
   *
   * 为什么不只看「文件在不在」：前面已经实测到一种非常具体的情况——macOS 的
   * `.accurate` 依赖系统按需下载的文字识别资源，资源缺失时 `perform` 直接抛错，
   * 而引擎看起来完全「可用」。不探测的话用户会点「识别文字」，然后 171 页**每一页**
   * 都失败。这个自检把那种失败提前到用户点按钮之前。
   */
  private async probe(): Promise<{ ok: boolean; error: string | null }> {
    if (this.probeCache !== null) return this.probeCache;
    const tool = this.resolveTool();
    if (tool === null) {
      this.probeCache = { ok: false, error: '没有找到系统 OCR 组件' };
      return this.probeCache;
    }
    const command = buildCommand(tool, { probe: true });
    const result = await runOcrProcess({ program: command.program, args: command.args });
    this.probeCache =
      result.probe ??
      {
        ok: false,
        error:
          result.stderr.split('\n').slice(-2).join(' ').trim() ||
          '系统 OCR 组件没有回应自检',
      };
    return this.probeCache;
  }

  async status(): Promise<OcrEngineStatus> {
    const tool = this.resolveTool();
    const label = process.platform === 'darwin' ? '系统 OCR（macOS Vision）' : '系统 OCR（Windows.Media.Ocr）';
    if (tool === null) {
      return {
        id: this.id,
        label,
        available: false,
        ready: false,
        reason:
          process.platform === 'linux'
            ? '系统 OCR 只支持 macOS 与 Windows——Linux 没有统一的系统文字识别接口'
            : `没找到系统 OCR 组件（找过：${this.options.toolDirs.join('、')}）。开发时先运行 \`npm run build:vision-ocr\``,
        requirement: '随应用分发，无需安装',
        downloadSizeMb: 0,
        extension: null,
      };
    }
    // 自检失败时**判为不可用**，而不是「可用但会失败」——后者会让用户白等一场。
    const probe = await this.probe();
    if (!probe.ok) {
      return {
        id: this.id,
        label,
        available: false,
        ready: false,
        reason:
          `这台机器的系统 OCR 用不了：${probe.error ?? '原因未知'}。` +
          (process.platform === 'darwin'
            ? 'macOS 的文字识别资源是按需下载的：打开一次「预览」或「照片」里的实况文本，' +
              '或者换个浏览器用一次「从图片提取文字」，系统就会把资源装上。' +
              '也可以装 arale_onnx_v1 扩展（质量更好，但要下百来 MB）。'
            : '请在系统设置里确认已安装所需的 OCR 语言包。'),
        requirement: '使用操作系统自带的识别引擎，离线、无需下载',
        downloadSizeMb: 0,
        extension: null,
      };
    }

    return {
      id: this.id,
      label,
      available: true,
      ready: true,
      reason: null,
      requirement: '使用操作系统自带的识别引擎，离线、无需下载',
      downloadSizeMb: 0,
      extension: null,
    };
  }

  async recognize(job: OcrBookJob, sink: OcrSink): Promise<OcrPageOut[]> {
    const tool = this.resolveTool();
    if (tool === null) throw new Error('系统 OCR 组件不可用');

    const pages = job.pages;
    // 只装行；阅读顺序与成块由服务层统一做（`blocksFromLines`）。
    const results: OcrPageOut[] = pages.map((_page, index) => ({ index, ok: true, lines: [] }));

    // 分批：一次几百个路径会让 argv 过长，也让「取消」要等很久才生效。
    for (let start = 0; start < pages.length; start += PAGES_PER_INVOCATION) {
      if (job.isCancelled()) break;
      const batch = pages.slice(start, start + PAGES_PER_INVOCATION);
      // 小工具回传的是**我们自己传进去的路径**（原样回显），所以用它反查页号。
      // 不靠顺序反查：单页失败、并发回调都会让顺序不可靠。
      const byAbs = new Map(batch.map((page, offset) => [page.absPath, start + offset] as const));

      const command = buildCommand(tool);
      const result = await runOcrProcess({
        program: command.program,
        args: [...command.args, ...batch.map((page) => page.absPath)],
        onMeta: (meta) => {
          // 系统不支持日语时会降级成默认语言，那时识别质量会明显下降。
          // 这是**必须告诉用户**的事实，否则他只会觉得「这个 OCR 很差」。
          if (meta.requested.length > 0 && meta.languages.length === 0) {
            sink.message('这台机器的系统 OCR 不支持指定的识别语言，已退回系统默认语言');
          } else if (meta.languages.length > 0 && !meta.languages.includes('ja-JP')) {
            sink.message(`系统 OCR 未提供日语模型（实际语言：${meta.languages.join('、')}）`);
          }
        },
        onPage: (page) => {
          const index = byAbs.get(page.file);
          if (index === undefined) return;
          const target = results[index];
          if (target === undefined) return;
          target.ok = page.ok !== false;
          target.lines = page.lines;
          if (page.ok === false) target.error = page.error ?? '这一页识别失败';
          // ★ 进度与结果是同一个对象：服务层拿到的就是最终结果里的那一份。
          sink.page(target);
        },
        isCancelled: job.isCancelled,
      });

      if (result.cancelled) break;
      // 整批一个进程都没起来 / 一个工具都找不到：报出来，别让用户对着空文字层发呆。
      if (result.pages === 0 && result.failedPages === 0) {
        const detail = result.stderr.split('\n').slice(-3).join(' ').trim();
        throw new Error(
          result.code === null
            ? `系统 OCR 进程异常退出${detail === '' ? '' : `：${detail}`}`
            : `系统 OCR 没有产出任何结果（退出码 ${result.code}）${detail === '' ? '' : `：${detail}`}`,
        );
      }
    }

    return results;
  }

  async dispose(): Promise<void> {
    // 每次调用都是独立进程，没有常驻资源要放。
  }
}

/**
 * 平台相关的启动方式（Windows 要用 PowerShell 跑脚本）。
 *
 * 两个平台都支持 `--probe`：**「怎么自检」是协议的一部分**，不是 macOS 专属的
 * 便利功能。否则扩展/移植到新平台时，主进程会因为拿不到自检结果而误判「可用」。
 */
function buildCommand(tool: string, mode: { probe?: boolean } = {}): { program: string; args: string[] } {
  const probeArgs = mode.probe === true ? ['--probe'] : [];
  if (tool.toLowerCase().endsWith('.ps1')) {
    return {
      program: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        tool,
        ...probeArgs,
        // `--` 之后的都当图片路径，与 macOS 小工具保持一致。
        ...(mode.probe === true ? [] : ['--']),
      ],
    };
  }
  return {
    program: tool,
    args: mode.probe === true ? ['--probe'] : ['--lang', 'ja-JP,en-US', '--'],
  };
}

