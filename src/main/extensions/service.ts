/**
 * 扩展服务：**多个 JSONL 仓库 + 下载器 + 安装记录**。
 *
 * 目录布局（`<userData>/extensions/`）：
 * ```
 *   repositories.json     ← 用户登记的仓库（缺省当前引擎库）
 *   repositories/*.jsonl  ← 各仓库的已校验缓存
 *   catalog.json          ← 旧版缓存，仅迁移期回退
 *   installed.json        ← 本机装了什么（真相源）
 *   <extId>/              ← 解包后的扩展
 *     extension.json      ← 扩展自描述（必须存在）
 *   .staging/             ← 下载与解包过程中的临时文件
 * ```
 *
 * ## 安装是「先落到一边，再改名」
 *
 * 下载、校验、解包全部在 `.staging/` 里做，**最后一步才 rename 到 `<extId>/`**。
 * 中间任何一步失败（网络断、sha256 不符、归档里少了 self-description）都不会在扩展目录
 * 里留下半成品——那种半成品最糟：`status()` 会看到目录存在于是报告「已安装」，
 * 而启动 runner 时才发现缺文件，用户看到的是一句莫名其妙的 spawn ENOENT。
 *
 * rename 是原子的（同一个文件系统内），所以「要么完全没有，要么完整」。
 *
 * ## 随包 JSONL 是离线回退，不是第二真相源
 *
 * 远端仓库拿不到时用从 submodule 打进包里的 JSONL。它不是「备份」，而是**新装应用的第一次体验**：
 * 第一次打开就得看得见有什么可装，不能因为 GitHub 不可达而让扩展页面一片空白。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';

import type {
  ExtensionAsset,
  ExtensionCatalog,
  ExtensionRelease,
  ExtensionEntry,
  ExtensionManifest,
  ExtensionProgress,
  ExtensionStatus,
  InstalledExtension,
  OcrRepository,
} from '../../shared/extensions';
import { EXTENSION_MANIFEST_FILE, resolveDownload } from '../../shared/extensions';
import { NativeCommandError, extractArchive, isNativeAvailable } from '../native/sidecar';
import { DownloadCancelledError, DownloadError, downloadToFile } from './download';

/**
 * 默认清单地址。
 *
 * 指向**引擎库仓库**里的 JSONL 文件（`repositories/default.jsonl`）：
 * 清单由引擎的构建脚本生成（`node engines/arale_onnx_v1/build.mjs --target all`），
 * 每个引擎一条、按平台分条目；归档本身放在 GitHub Release 里，清单只写
 * 「哪个 release、哪个包」（`release: {repo, tag, asset}`），地址由应用拼。
 *
 * 换地址的办法有两条，按优先级：构造参数 `catalogUrl` > 环境变量
 * `ARALE_EXTENSIONS_CATALOG_URL`。后者是给开发和自建镜像用的。
 */
export const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/heyanLE/arale-book-ocr-manga/main/repositories/default.jsonl';

export const DEFAULT_REPOSITORY: OcrRepository = { name: '官方 OCR 引擎', url: DEFAULT_CATALOG_URL };

/** 应用认得的清单格式版本。不认就拒绝加载，而不是半懂不懂地解析。 */
export const EXTENSION_SCHEMA_VERSION = 1;

export interface ExtensionServiceOptions {
  /** 扩展根目录（`<userData>/extensions`）。 */
  root: string;
  /** 随包带的清单（`<resources>/extensions/catalog.json`）。 */
  bundledCatalogFile?: string;
  /** 来自 submodule 的本地 JSONL：开发态直接读，发布态只带这份小索引。 */
  localRepositoryFile?: string;
  /** 有本地调试引擎时，本地索引必须盖过旧远端缓存。正式包让远端缓存优先。 */
  preferLocalRepository?: boolean;
  /** 开发态直接加载的归档根目录；发布版不传。 */
  debugExtensionDir?: string;
  /** 远端清单地址覆盖。 */
  catalogUrl?: string;
  /** 进度广播。 */
  onProgress?: (progress: ExtensionProgress) => void;
  /** 安装/卸载完成后回调（UI 刷新 + 引擎重新探测）。 */
  onChanged?: () => void;
}

export class ExtensionService {
  /** 正在安装的扩展：同一时刻只允许一个（并发下 700 MB 只会互相拖慢）。 */
  private readonly installing = new Set<string>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly options: ExtensionServiceOptions) {}

  // -------------------------------------------------------------------------
  // 路径
  // -------------------------------------------------------------------------

  root(): string {
    return this.options.root;
  }

  catalogCacheFile(): string {
    return path.join(this.options.root, 'catalog.json');
  }

  repositoryFile(): string { return path.join(this.options.root, 'repositories.json'); }

  repositories(): OcrRepository[] {
    const raw = readJson<unknown>(this.repositoryFile(), null);
    if (raw === null) return [DEFAULT_REPOSITORY];
    if (!Array.isArray(raw)) return [DEFAULT_REPOSITORY];
    return raw.filter((item): item is OcrRepository =>
      typeof item === 'object' && item !== null &&
      typeof item.name === 'string' && item.name.trim() !== '' &&
      typeof item.url === 'string' && /^https:\/\//.test(item.url));
  }

  addRepository(name: string, url: string): { ok: boolean; error: string | null } {
    if (name.trim() === '' || !/^https:\/\/[^\s]+\.jsonl(?:\?[^\s]*)?$/.test(url)) {
      return { ok: false, error: '仓库需要名称和 HTTPS JSONL 地址' };
    }
    const all = this.repositories();
    if (all.some((item) => item.url === url)) return { ok: false, error: '仓库已存在' };
    this.writeRepositories([...all, { name: name.trim(), url }]);
    this.options.onChanged?.();
    return { ok: true, error: null };
  }

  removeRepository(url: string): { ok: boolean; error: string | null } {
    const all = this.repositories();
    if (!all.some((item) => item.url === url)) return { ok: false, error: '找不到仓库' };
    this.writeRepositories(all.filter((item) => item.url !== url));
    this.options.onChanged?.();
    return { ok: true, error: null };
  }

  private writeRepositories(items: OcrRepository[]): void {
    fs.mkdirSync(this.options.root, { recursive: true });
    fs.writeFileSync(this.repositoryFile(), `${JSON.stringify(items, null, 2)}\n`);
  }

  private repositoryCache(url: string): string {
    return path.join(this.options.root, 'repositories', `${crypto.createHash('sha256').update(url).digest('hex')}.jsonl`);
  }

  installedFile(): string {
    return path.join(this.options.root, 'installed.json');
  }

  stagingDir(): string {
    return path.join(this.options.root, '.staging');
  }

  /** 某个扩展的安装目录（**不保证存在**）。 */
  installDir(id: string): string {
    if (id === 'ocr-arale_onnx_v1' && this.options.debugExtensionDir &&
        fs.existsSync(path.join(this.options.debugExtensionDir, EXTENSION_MANIFEST_FILE))) {
      return this.options.debugExtensionDir;
    }
    return path.join(this.options.root, safeId(id));
  }

  isInstalling(id: string): boolean {
    return this.installing.has(id);
  }

  // -------------------------------------------------------------------------
  // 清单
  // -------------------------------------------------------------------------

  /**
   * 当前可用的清单：正式包用远端缓存，离线退回随包索引；调试包优先本地索引。
   *
   * 读不到任何清单时返回**空清单**而不是抛：扩展功能整体失效不该让应用起不来。
   */
  loadCatalog(): { catalog: ExtensionCatalog; source: 'cache' | 'bundled' | 'none'; error: string | null } {
    const entries = new Map<string, ExtensionEntry>();
    let source: 'cache' | 'bundled' | 'none' = 'none';
    for (const repo of this.repositories()) {
      const cached = readRepositoryFile(this.repositoryCache(repo.url));
      const local = repo.url === DEFAULT_CATALOG_URL && this.options.localRepositoryFile
        ? readRepositoryFile(this.options.localRepositoryFile) : null;
      const localIsNewer = local?.ok && cached.ok && local.catalog.extensions.some((entry) => {
        const remote = cached.catalog.extensions.find((item) => item.id === entry.id);
        return remote === undefined || compareVersion(entry.version, remote.version) > 0;
      });
      const fromLocal = local?.ok && (this.options.preferLocalRepository === true || !cached.ok || localIsNewer);
      const found = (fromLocal && local?.ok) ? local : cached.ok ? cached : null;
      if (!found) continue;
      if (fromLocal && source === 'none') source = 'bundled';
      else if (cached.ok) source = 'cache';
      for (const entry of found.catalog.extensions) if (!entries.has(entry.id)) entries.set(entry.id, entry);
    }
    if (entries.size > 0) return {
      catalog: { schemaVersion: EXTENSION_SCHEMA_VERSION, generatedAt: '', extensions: [...entries.values()] },
      source, error: null,
    };
    // 旧安装的 catalog.json 只用于迁移期离线兜底。
    const legacy = readCatalogFile(this.catalogCacheFile());
    if (legacy.ok) return { catalog: legacy.catalog, source: 'cache', error: null };
    const bundled = this.options.bundledCatalogFile ? readCatalogFile(this.options.bundledCatalogFile) : null;
    if (bundled?.ok) return { catalog: bundled.catalog, source: 'bundled', error: null };
    return {
      catalog: { schemaVersion: EXTENSION_SCHEMA_VERSION, generatedAt: '', extensions: [] },
      source: 'none',
      error: '尚未取得仓库索引，请刷新仓库',
    };
  }

  /**
   * 从远端拉一份新清单并缓存。
   *
   * 拉不到**不抛**：离线是常态，缓存 + 内置清单足够用。返回值里说明结果，UI 显示一行
   * 「清单更新失败（用本地缓存）」比弹一个错误框合适。
   */
  async refreshCatalog(): Promise<{ ok: boolean; count: number; error: string | null; source: 'remote' | 'cache' }> {
    const repos = this.repositories();
    const override = this.options.catalogUrl ?? process.env['ARALE_EXTENSIONS_CATALOG_URL'];
    if (override && repos.some((item) => item.url === DEFAULT_CATALOG_URL)) {
      repos.splice(repos.findIndex((item) => item.url === DEFAULT_CATALOG_URL), 1, { ...DEFAULT_REPOSITORY, url: override });
    }
    fs.mkdirSync(this.stagingDir(), { recursive: true });
    let updated = 0;
    const errors: string[] = [];
    for (const repo of repos) {
      const dest = path.join(this.stagingDir(), `${crypto.createHash('sha256').update(repo.url).digest('hex')}.jsonl`);
      try {
        await downloadToFile({ url: repo.url, dest, throttleMs: 1000 });
        const parsed = parseRepository(fs.readFileSync(dest, 'utf8'));
        if (!parsed.ok) throw new Error(parsed.error);
        fs.mkdirSync(path.dirname(this.repositoryCache(repo.url)), { recursive: true });
        fs.renameSync(dest, this.repositoryCache(repo.url));
        updated += parsed.catalog.extensions.length;
      } catch (error) {
        errors.push(`${repo.name}: ${error instanceof Error ? error.message : String(error)}`);
        fs.rmSync(dest, { force: true });
      }
    }
    return { ok: errors.length === 0, count: updated, error: errors.length ? errors.join('；') : null, source: updated ? 'remote' : 'cache' };
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  installed(): InstalledExtension[] {
    const raw = readJson<unknown>(this.installedFile(), []);
    if (!Array.isArray(raw)) return [];
    const out: InstalledExtension[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const id = record['id'];
      const version = record['version'];
      if (typeof id !== 'string' || typeof version !== 'string') continue;
      out.push({
        id,
        version,
        installedAt: typeof record['installedAt'] === 'number' ? record['installedAt'] : 0,
        dir: this.installDir(id),
        sha256: typeof record['sha256'] === 'string' ? record['sha256'] : '',
        bytes: typeof record['bytes'] === 'number' ? record['bytes'] : 0,
      });
    }
    const debug = this.options.debugExtensionDir;
    if (debug && fs.existsSync(path.join(debug, EXTENSION_MANIFEST_FILE))) {
      const parsed = parseManifest(readJson<unknown>(path.join(debug, EXTENSION_MANIFEST_FILE), null));
      if (parsed.ok && parsed.manifest.id === 'ocr-arale_onnx_v1') {
        return [...out.filter((item) => item.id !== parsed.manifest.id), {
          id: parsed.manifest.id, version: parsed.manifest.version, installedAt: 0,
          dir: debug, sha256: '', bytes: 0, local: true,
        }];
      }
    }
    return out;
  }

  /** 清单 + 本机状态拼成 UI 直接渲染的行。 */
  list(): { statuses: ExtensionStatus[]; repositories: OcrRepository[]; source: 'cache' | 'bundled' | 'none'; error: string | null } {
    const { catalog, source, error } = this.loadCatalog();
    const byId = new Map(this.installed().map((item) => [item.id, item]));

    const statuses = catalog.extensions.map<ExtensionStatus>((item) => {
      const download = resolveDownload(item, process.platform, process.arch);
      const entry = { ...item, bytes: download.bytes || item.bytes, installedBytes: download.installedBytes || item.installedBytes };
      const installed = byId.get(entry.id) ?? null;
      const support = this.supportOf(entry);
      return {
        entry,
        installed,
        // 「有新版」只比字符串相等，不比语义版本高低：清单里出现一个更低的版本号
        // 时也提示，因为那通常意味着上游在回滚，用户应该跟上。
        updateAvailable: installed !== null && !installed.local && installed.version !== entry.version,
        supported: support.supported,
        unsupportedReason: support.reason,
      };
    });
    return { statuses, repositories: this.repositories(), source, error };
  }

  private supportOf(entry: ExtensionEntry): { supported: boolean; reason: string | null } {
    const platform = currentPlatform();
    const arch = currentArch();
    if (platform === null) {
      return { supported: false, reason: `不支持的平台：${process.platform}` };
    }
    if (entry.platforms.length > 0 && !entry.platforms.includes(platform)) {
      return { supported: false, reason: `这个扩展只支持：${entry.platforms.join(' / ')}` };
    }
    if (entry.arch.length > 0 && (arch === null || !entry.arch.includes(arch))) {
      return {
        supported: false,
        reason: `这个扩展只支持：${entry.arch.join(' / ')}（当前 ${process.arch}）`,
      };
    }
    if (platform === 'darwin' && entry.minMacOS && Number.parseInt(os.release(), 10) - 9 < entry.minMacOS) {
      return { supported: false, reason: `需要 macOS ${entry.minMacOS} 或更高版本` };
    }
    return { supported: true, reason: null };
  }

  /** 已安装扩展的自描述（runner 靠它启动）。 */
  readManifest(id: string): ExtensionManifest | null {
    const file = path.join(this.installDir(id), EXTENSION_MANIFEST_FILE);
    const raw = readJson<unknown>(file, null);
    if (raw === null) return null;
    const parsed = parseManifest(raw);
    return parsed.ok ? parsed.manifest : null;
  }

  // -------------------------------------------------------------------------
  // 安装 / 卸载
  // -------------------------------------------------------------------------

  cancel(id: string): void {
    this.cancelled.add(id);
  }

  /**
   * 安装（或升级）一个扩展。
   *
   * **永不抛**：所有失败都变成 `{ ok:false, error }`，UI 直接显示。抛出去的话中间
   * 那几十次进度事件之后用户只会看到一个 `Error: ...`，而哪一步失败了看不出来。
   */
  async install(id: string): Promise<{ ok: boolean; error: string | null }> {
    if (id === 'ocr-arale_onnx_v1' && this.options.debugExtensionDir &&
        fs.existsSync(path.join(this.options.debugExtensionDir, EXTENSION_MANIFEST_FILE))) {
      return { ok: false, error: '开发包已直接加载，无需安装' };
    }
    if (this.installing.has(id)) return { ok: false, error: '这个扩展正在安装中' };
    this.installing.add(id);
    this.cancelled.delete(id);

    const staging = path.join(this.stagingDir(), safeId(id));
    try {
      const { catalog } = this.loadCatalog();
      const entry = catalog.extensions.find((item) => item.id === id);
      if (entry === undefined) return { ok: false, error: `清单里没有这个扩展：${id}` };

      const support = this.supportOf(entry);
      if (!support.supported) return { ok: false, error: support.reason ?? '当前平台不支持这个扩展' };

      // ★ 一个能力一条条目，包按平台选：这里才决定「mac 下哪个 zip、win 下哪个 zip」。
      const download = resolveDownload(entry, process.platform, process.arch);
      if (download.urls.length === 0) {
        return { ok: false, error: `清单里这个扩展没有 ${process.platform}-${process.arch} 的包` };
      }
      if (download.sha256 === '' || !/^[0-9a-f]{64}$/.test(download.sha256)) {
        return {
          ok: false,
          error: `清单里这个扩展的 ${process.platform}-${process.arch} 包还没有发布（sha256 为空），拒绝安装`,
        };
      }
      if (!isNativeAvailable()) {
        return {
          ok: false,
          error: '缺少原生解包组件，无法解压扩展（先运行 `npm run build:native`）',
        };
      }

      // 依赖先装。深度 1 就够——扩展之间不该形成依赖树。
      for (const dep of entry.requires) {
        if (this.installed().some((item) => item.id === dep)) continue;
        const nested = await this.install(dep);
        if (!nested.ok) return { ok: false, error: `依赖 ${dep} 安装失败：${nested.error}` };
      }

      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });

      const archive = path.join(staging, 'download.zip');
      this.progress(id, 'downloading', 0, download.bytes);

      let lastError: string | null = null;
      let downloaded: { bytes: number; sha256: string } | null = null;
      for (const url of download.urls) {
        try {
          downloaded = await downloadToFile({
            url,
            dest: archive,
            onProgress: (received, total) =>
              this.progress(id, 'downloading', received, total > 0 ? total : download.bytes),
            isCancelled: () => this.cancelled.has(id),
          });
          break;
        } catch (error) {
          if (error instanceof DownloadCancelledError) {
            return { ok: false, error: '已取消' };
          }
          lastError =
            error instanceof DownloadError
              ? `${error.message} @ ${url}`
              : error instanceof Error
                ? `${error.message} @ ${url}`
                : String(error);
          // 换下一个镜像继续试。
        }
      }
      if (downloaded === null) {
        return { ok: false, error: `下载失败：${lastError ?? '没有可用的下载地址'}` };
      }

      this.progress(id, 'verifying', downloaded.bytes, downloaded.bytes);
      if (downloaded.sha256 !== download.sha256) {
        return {
          ok: false,
          error: [
            '下载内容的 sha256 与清单不一致，已丢弃。',
            `期望 ${download.sha256}`,
            `实际 ${downloaded.sha256}`,
          ].join(' '),
        };
      }

      this.progress(id, 'extracting', downloaded.bytes, downloaded.bytes);
      const unpacked = path.join(staging, 'unpacked');
      fs.mkdirSync(unpacked, { recursive: true });
      try {
        await extractArchive(archive, unpacked, false);
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof NativeCommandError
              ? `解压失败：${error.message}`
              : `解压失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      fs.rmSync(archive, { force: true });

      const validated = validateUnpacked(unpacked, { ...entry, bytes: download.bytes });
      if (!validated.ok) return { ok: false, error: validated.error };

      // 可执行位：归档里不保证有（zip 的权限位各家工具写法不一），显式补上。
      // 少了它 runner 会以 EACCES 失败，而错误信息里看不出是权限问题。
      chmodExecutable(unpacked, validated.manifest);

      // 最后一步：原子换入。
      const target = this.installDir(id);
      const backup = `${target}.old`;
      fs.rmSync(backup, { recursive: true, force: true });
      if (fs.existsSync(target)) fs.renameSync(target, backup);
      fs.renameSync(unpacked, target);
      fs.rmSync(backup, { recursive: true, force: true });

      this.recordInstalled({
        id,
        version: entry.version,
        installedAt: Date.now(),
        dir: target,
        sha256: downloaded.sha256,
        bytes: downloaded.bytes,
      });

      this.progress(id, 'done', downloaded.bytes, downloaded.bytes);
      this.options.onChanged?.();
      return { ok: true, error: null };
    } catch (error) {
      this.progress(id, 'failed', 0, 0, error instanceof Error ? error.message : String(error));
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.installing.delete(id);
      this.cancelled.delete(id);
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** 卸载。目录删掉、记录删掉——不保留「卸载残留」。 */
  remove(id: string): { ok: boolean; error: string | null } {
    if (id === 'ocr-arale_onnx_v1' && this.options.debugExtensionDir &&
        fs.existsSync(path.join(this.options.debugExtensionDir, EXTENSION_MANIFEST_FILE))) {
      return { ok: false, error: '开发包由 submodule 提供，不能从应用里删除' };
    }
    if (this.installing.has(id)) return { ok: false, error: '正在安装中，先等它结束' };
    const target = this.installDir(id);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      return { ok: false, error: `删除失败：${error instanceof Error ? error.message : String(error)}` };
    }
    this.recordInstalled(null, id);
    this.options.onChanged?.();
    return { ok: true, error: null };
  }

  private progress(
    id: string,
    phase: ExtensionProgress['phase'],
    received: number,
    total: number,
    message = '',
  ): void {
    this.options.onProgress?.({ id, phase, received, total, message });
  }

  /** 写安装记录。`record` 为 null 时删除该 id。 */
  private recordInstalled(record: InstalledExtension | null, removeId?: string): void {
    const all = this.installed().filter((item) => item.id !== (record?.id ?? removeId));
    if (record !== null) all.push(record);
    fs.mkdirSync(this.options.root, { recursive: true });
    // 直接覆写：这份记录坏了最多是「扩展看起来没装」，重装一次就好，
    // 不值得为它引入更复杂的恢复逻辑。
    fs.writeFileSync(this.installedFile(), JSON.stringify(all, null, 2), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 解析 `release: {repo, tag, assets: {"darwin-arm64": {asset, sha256, bytes}}}`。
 *
 * 严格：`asset` 只能是**文件名**（带 `/`、`\` 或 `..` 一律拒绝——清单是远端来的，
 * 不能让它在地址里塞路径）；`repo` 必须是 `owner/repo` 形状；`tag` 不能空；
 * `assets` 至少一条，键必须是 `<platform>-<arch>` 形状。
 */
export function parseRelease(
  value: unknown,
  id: string,
): ExtensionRelease | null | { error: string } {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { error: `${id} 的 release 不是对象` };
  }
  const record = value as Record<string, unknown>;
  const repo = str(record['repo']);
  const tag = str(record['tag']);
  if (repo === null || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { error: `${id} 的 release.repo 必须是 owner/repo 形状` };
  }
  if (tag === null) return { error: `${id} 的 release 缺 tag（release 名）` };

  const rawAssets = record['assets'];
  if (typeof rawAssets !== 'object' || rawAssets === null || Array.isArray(rawAssets)) {
    return { error: `${id} 的 release 缺 assets（每个平台一个包）` };
  }
  const assets: Record<string, ExtensionAsset> = {};
  for (const [key, item] of Object.entries(rawAssets as Record<string, unknown>)) {
    if (!/^[a-z0-9]+-[a-z0-9_]+$/.test(key)) {
      return { error: `${id} 的 release.assets 键必须是 <platform>-<arch> 形状：${key}` };
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { error: `${id} 的 release.assets.${key} 不是对象` };
    }
    const assetRecord = item as Record<string, unknown>;
    const asset = str(assetRecord['asset']);
    if (asset === null) return { error: `${id} 的 release.assets.${key} 缺 asset（包名）` };
    if (asset.includes('/') || asset.includes('\\') || asset.includes('..')) {
      return { error: `${id} 的 release.assets.${key}.asset 只能是文件名，不能带路径：${asset}` };
    }
    const sha256 = str(assetRecord['sha256']) ?? '';
    if (sha256 !== '' && !/^[0-9a-f]{64}$/.test(sha256)) {
      return { error: `${id} 的 release.assets.${key}.sha256 不是 64 位十六进制` };
    }
    const installedBytes = num(assetRecord['installedBytes']);
    assets[key] = {
      asset,
      sha256,
      bytes: num(assetRecord['bytes']),
      ...(installedBytes > 0 ? { installedBytes } : {}),
    };
  }
  if (Object.keys(assets).length === 0) return { error: `${id} 的 release.assets 是空的` };
  return { repo, tag, assets };
}

export function parseCatalog(text: string): { ok: true; catalog: ExtensionCatalog } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return { ok: false, error: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '顶层不是对象' };
  const record = raw as Record<string, unknown>;
  if (record['schemaVersion'] !== EXTENSION_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `schemaVersion 是 ${String(record['schemaVersion'])}，本应用只认 ${EXTENSION_SCHEMA_VERSION}`,
    };
  }
  const list = record['extensions'];
  if (!Array.isArray(list)) return { ok: false, error: 'extensions 不是数组' };

  const extensions: ExtensionEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of list.entries()) {
    if (typeof item !== 'object' || item === null) return { ok: false, error: `第 ${index} 项不是对象` };
    const entry = item as Record<string, unknown>;
    const id = str(entry['id']);
    if (id === null) return { ok: false, error: `第 ${index} 项缺 id` };
    if (seen.has(id)) return { ok: false, error: `id 重复：${id}` };
    seen.add(id);
    const name = str(entry['name']);
    const version = str(entry['version']);
    const provides = str(entry['provides']);
    const kind = str(entry['kind']);
    if (name === null || version === null || provides === null || kind === null) {
      return { ok: false, error: `${id} 缺 name / version / provides / kind` };
    }
    const urls = strArray(entry['urls']);
    const release = parseRelease(entry['release'], id);
    if (release instanceof Object && 'error' in release) return { ok: false, error: release.error };
    if (urls.length === 0 && release === null) {
      return { ok: false, error: `${id} 既没有 urls 也没有 release{repo,tag,assets}，没有下载地址` };
    }

    extensions.push({
      id,
      name,
      version,
      kind: kind === 'ocr-engine' ? 'ocr-engine' : 'ocr-engine',
      provides,
      ...(release !== null ? { release } : {}),
      summary: str(entry['summary']) ?? '',
      platforms: strArray(entry['platforms']) as ExtensionEntry['platforms'],
      arch: strArray(entry['arch']) as ExtensionEntry['arch'],
      ...(num(entry['minMacOS']) > 0 ? { minMacOS: num(entry['minMacOS']) } : {}),
      urls,
      bytes: num(entry['bytes']),
      sha256: str(entry['sha256']) ?? '',
      installedBytes: num(entry['installedBytes']),
      license: str(entry['license']) ?? '',
      homepage: str(entry['homepage']) ?? '',
      requires: strArray(entry['requires']),
      notes: str(entry['notes']) ?? '',
    });
  }
  return {
    ok: true,
    catalog: {
      schemaVersion: EXTENSION_SCHEMA_VERSION,
      generatedAt: str(record['generatedAt']) ?? '',
      extensions,
    },
  };
}

/** JSONL 仓库：每行一条扩展；借用清单校验以保持安装安全边界一致。 */
export function parseRepository(text: string): { ok: true; catalog: ExtensionCatalog } | { ok: false; error: string } {
  const entries: unknown[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    try { entries.push(JSON.parse(line) as unknown); }
    catch { return { ok: false, error: `第 ${index + 1} 行不是合法 JSON` }; }
  }
  return parseCatalog(JSON.stringify({ schemaVersion: EXTENSION_SCHEMA_VERSION, extensions: entries }));
}

export function parseManifest(
  raw: unknown,
): { ok: true; manifest: ExtensionManifest } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '不是对象' };
  const record = raw as Record<string, unknown>;
  const id = str(record['id']);
  const version = str(record['version']);
  const provides = str(record['provides']);
  if (id === null || version === null || provides === null) {
    return { ok: false, error: '缺 id / version / provides' };
  }

  let engine: ExtensionManifest['engine'];
  const rawEngine = record['engine'];
  if (typeof rawEngine === 'object' && rawEngine !== null) {
    const item = rawEngine as Record<string, unknown>;
    engine = {
      label: str(item['label']) ?? id,
      requirement: str(item['requirement']) ?? '',
      downloadSizeMb: num(item['downloadSizeMb']),
    };
  }

  let runner: ExtensionManifest['runner'];
  const rawRunner = record['runner'];
  if (typeof rawRunner === 'object' && rawRunner !== null) {
    const item = rawRunner as Record<string, unknown>;
    const program = str(item['program']);
    if (program === null) return { ok: false, error: 'runner 缺 program' };
    runner = {
      program,
      args: strArray(item['args']),
      env: strRecord(item['env']),
    };
  }

  return {
    ok: true,
    manifest: {
      id,
      version,
      kind: 'ocr-engine',
      provides,
      engine,
      runner,
      license: str(record['license']) ?? undefined,
      homepage: str(record['homepage']) ?? undefined,
    },
  };
}

/** 解包结果校验：自描述必须在、id/version 必须与清单一致、runner 不能指向目录外。 */
function validateUnpacked(
  unpacked: string,
  entry: ExtensionEntry,
): { ok: true; manifest: ExtensionManifest } | { ok: false; error: string } {
  const manifestFile = path.join(unpacked, EXTENSION_MANIFEST_FILE);
  if (!fs.existsSync(manifestFile)) {
    return { ok: false, error: `归档里缺 ${EXTENSION_MANIFEST_FILE}，这不是一个扩展包` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: `${EXTENSION_MANIFEST_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = parseManifest(raw);
  if (!parsed.ok) return { ok: false, error: `${EXTENSION_MANIFEST_FILE} 不合格：${parsed.error}` };
  if (parsed.manifest.id !== entry.id) {
    return { ok: false, error: `归档自报 id 是 ${parsed.manifest.id}，清单里是 ${entry.id}` };
  }
  if (parsed.manifest.version !== entry.version) {
    return {
      ok: false,
      error: `归档自报 version 是 ${parsed.manifest.version}，清单里是 ${entry.version}`,
    };
  }
  if (parsed.manifest.runner !== undefined) {
    const program = resolveInside(unpacked, parsed.manifest.runner.program);
    if (program === null) {
      return { ok: false, error: `runner 路径越出扩展目录：${parsed.manifest.runner.program}` };
    }
    if (!fs.existsSync(program)) {
      return { ok: false, error: `runner 不存在：${parsed.manifest.runner.program}` };
    }
  }
  return { ok: true, manifest: parsed.manifest };
}

/**
 * 把一个相对路径解析到 `root` 内；越界返回 null。
 *
 * 这是**安全边界**：`extension.json` 来自下载的归档，如果它能写
 * `"program": "../../../../bin/sh"`，那么清单被篡改就能让应用执行系统上的任意程序。
 * 校验用 `path.resolve` 之后的前缀比较（而不是字符串查找 `..`），因为符号链接与
 * 混合分隔符都能绕过朴素的字符串检查。
 */
export function resolveInside(root: string, rel: string): string | null {
  if (rel === '' || path.isAbsolute(rel)) return null;
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, rel);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null;
  return target;
}

/** 补上可执行位。Windows 不需要（也是不支持的模式位）。 */
function chmodExecutable(unpacked: string, manifest: ExtensionManifest): void {
  if (process.platform === 'win32') return;
  const program = manifest.runner?.program;
  if (program === undefined) return;
  const abs = resolveInside(unpacked, program);
  if (abs === null) return;
  try {
    fs.chmodSync(abs, 0o755);
  } catch {
    /* 补不上就让 runner 报 EACCES——那时用户至少能看到权限错误 */
  }
}

function currentPlatform(): ExtensionEntry['platforms'][number] | null {
  const value = process.platform;
  return value === 'darwin' || value === 'win32' || value === 'linux' ? value : null;
}

function currentArch(): ExtensionEntry['arch'][number] | null {
  const value = process.arch;
  return value === 'arm64' || value === 'x64' ? value : null;
}

/** 扩展 id 会成为目录名，所以只允许保守的字符集（防止 `../x` 之类）。 */
function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned === '' || cleaned.startsWith('.') ? `ext_${cleaned.replace(/\./g, '_')}` : cleaned;
}

function readCatalogFile(
  file: string,
): { ok: true; catalog: ExtensionCatalog } | { ok: false; error: string } {
  try {
    return parseCatalog(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, error: `读不到清单：${file}` };
  }
}

function readRepositoryFile(file: string): ReturnType<typeof parseRepository> {
  try { return parseRepository(fs.readFileSync(file, 'utf8')); }
  catch { return { ok: false, error: `读不到仓库：${file}` }; }
}

function compareVersion(a: string, b: string): number {
  const parts = (value: string) => value.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0);
  }
  return 0;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function strRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
