/**
 * LLM 服务（主进程侧）：拿一套 chat completions 兼容的端点解释一个词。
 *
 * 三条约定，都是为了让上层（IPC / 设置页 / 阅读器）不用替它操心：
 * - **key 不出主进程**。磁盘上存明文 `apiKey`，但返回渲染进程的只有 `hasApiKey`，
 *   所以这里有一份内部存储类型 `StoredProfile`，公共契约 `LlmProfile` 保持无 key。
 * - **`analyze` 永不抛**。断网、DNS、超时、HTTP 4xx、返回不是 JSON——全部变成
 *   `ok:false` 加一句能让人知道下一步怎么办的中文。主进程里抛异常，用户看到的是整页白屏。
 * - **本地服务不要 key**。llama.cpp / Ollama 的默认端点不校验 `Authorization`，
 *   硬要 key 只会把「本机跑模型」这条最省钱的路径堵掉。
 *
 * 不做流式：一次分析就是一段 Markdown，几十秒内必然结束，为它维护 SSE 解析 +
 * 增量渲染不划算（超时给了 120 秒兜底）。
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  DEFAULT_LLM_PROMPT,
  LEGACY_LLM_PROMPTS,
  type LlmAnalyzeRequest,
  type LlmAnalyzeResult,
  type LlmProfile,
  type LlmProfileInput,
  type LlmSettings,
} from '../../shared/types';
import { readJson, writeJsonAtomic } from '../../core/util/atomic-json';

export interface LlmServiceOptions {
  /** 配置文件（`<userData>/llm.json`）。 */
  settingsFile: string;
  /** 注入 fetch（测试用）。默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 内部 Harness 调用；密钥和网络请求仍由同一主进程服务管理。 */
export interface LlmCompletionRequest {
  profileId?: string;
  system?: string;
  user: string;
  /** 筛选/制卡用低温度，覆盖词卡交互分析的用户温度。 */
  temperature?: number;
  signal?: AbortSignal;
  /** 主进程任务启动时锁定配置身份；设置被修改后停止，避免一本书混用模型。 */
  expectedProfileSignature?: string;
  /** 单一提交工具：模型通过 function.arguments 返回结构化结果。 */
  tool?: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 磁盘上的形状。**只在主进程内出现**，多出来的 `apiKey` 绝不进公共契约。 */
interface StoredProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  temperature: number;
  apiKey: string;
}

interface StoredShape {
  profiles: StoredProfile[];
  activeProfileId: string | null;
  prompt: string;
}

/** 用户没填温度时的默认值。解释词义这种事，温度高只会让答案每次都不一样。 */
const DEFAULT_TEMPERATURE = 0.3;

/** 一次分析的硬上限。本地大模型冷启动 + 长上下文也可能跑掉一分多钟。 */
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_GLOBAL_LLM_REQUESTS = 4;
const CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type HarnessMode = NonNullable<LlmAnalyzeResult['responseMode']>;
type CapabilityRecord = Record<string, { mode: HarnessMode; checkedAt: number }>;

export class LlmService {
  private activeRequests = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly options: LlmServiceOptions) {}

  /** 读设置。key 永远不返回，只返回 `hasApiKey`。 */
  settings(): LlmSettings {
    return toPublic(this.readStored());
  }

  profileSignature(profileId: string): string | null {
    const profile = this.readStored().profiles.find((item) => item.id === profileId);
    return profile ? createHash('sha256').update(JSON.stringify(profile)).digest('hex') : null;
  }

  /** 覆盖式写入 profiles / activeProfileId / prompt 中的任意部分。 */
  update(patch: { profiles?: LlmProfileInput[]; activeProfileId?: string | null; prompt?: string }): LlmSettings {
    const stored = this.readStored();
    const next: StoredShape = { ...stored };

    if (patch.profiles !== undefined) {
      const existing = new Map(stored.profiles.map((profile) => [profile.id, profile]));
      const kept: StoredProfile[] = [];
      const seen = new Set<string>();
      for (const incoming of patch.profiles) {
        const normalized = normalizeProfile(incoming);
        // 没有 id 的配置存下来也没法被选中或删 key，直接丢；同 id 只留第一条。
        if (normalized === null || seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        // 继承已存的 key：渲染进程只拿到 `hasApiKey`，拿不到明文，不继承的话
        // 用户每改一次名字/模型就得重新贴一次 key。
        const persisted = existing.get(normalized.id);
        // 配置名称是创建时确定的身份；编辑模型或端点不能顺带改名。
        normalized.name = persisted?.name ?? normalized.name;
        // apiKey 仅在显式传入时替换；未传时保留已存密钥。
        normalized.apiKey = Object.prototype.hasOwnProperty.call(incoming, 'apiKey')
          ? (typeof incoming.apiKey === 'string' ? incoming.apiKey.trim() : '')
          : (persisted?.apiKey ?? '');
        kept.push(normalized);
      }
      next.profiles = kept;
    }

    if (patch.activeProfileId !== undefined) next.activeProfileId = patch.activeProfileId;
    // 悬空指向必须落回真实存在的配置：否则 UI 显示「没选」，而 analyze 又按 id 找不到。
    next.activeProfileId = resolveActive(next.profiles, next.activeProfileId);

    // 空白提示词等于没有提示词，回退到默认——否则模型收到一个空消息，报的错没法解释。
    if (patch.prompt !== undefined) {
      next.prompt = patch.prompt.trim().length > 0 ? patch.prompt : DEFAULT_LLM_PROMPT;
    }

    writeJsonAtomic(this.options.settingsFile, next);
    // 端点/模型可能已变化；能力结果不含密钥，单独落盘并在配置更新后重探。
    writeJsonAtomic(this.capabilityFile(), {});
    return toPublic(next);
  }

  /** 存/删某套配置的 API key。传 null 或空串就是删除。 */
  setApiKey(profileId: string, apiKey: string | null): LlmSettings {
    const stored = this.readStored();
    const key = (apiKey ?? '').trim();
    const index = stored.profiles.findIndex((profile) => profile.id === profileId);
    if (index >= 0) {
      const profile = stored.profiles[index];
      // 空串即「删除」：与其存一个空字符串占位，不如让 `hasApiKey` 直接是 false。
      if (profile !== undefined) profile.apiKey = key;
      writeJsonAtomic(this.options.settingsFile, stored);
    }
    // 找不到这套配置就什么都不写，把当前真实状态原样返回——比悄悄新建一套可预期。
    return toPublic(stored);
  }

  /** 跑一次分析。**永不抛**，失败也返回 `ok:false`。 */
  async analyze(request: LlmAnalyzeRequest): Promise<LlmAnalyzeResult> {
    const stored = this.readStored();
    return this.complete({
      profileId: request.profileId,
      user: renderPrompt(stored.prompt, { word: request.word, context: request.context }),
    });
  }

  /** 版本化 Harness 的底层调用。失败返回结构化错误，不把密钥交给渲染进程。 */
  async complete(request: LlmCompletionRequest): Promise<LlmAnalyzeResult> {
    let httpAttempts = 0;
    let fallbackCount = 0;
    let mode: HarnessMode = 'plain';
    let usageTotals: LlmAnalyzeResult['usage'] | undefined;
    try {
      const stored = this.readStored();
      const wanted = request.profileId ?? stored.activeProfileId;
      const profile = wanted === null ? undefined : stored.profiles.find((item) => item.id === wanted);
      if (profile === undefined) {
        return { ...fail('还没有配置 LLM。到「设置 → LLM」里加一套。'), httpAttempts, fallbackCount };
      }
      if (request.expectedProfileSignature && this.profileSignature(profile.id) !== request.expectedProfileSignature) {
        return { ...fail('任务运行期间 LLM 配置已变化，请用当前配置重新提交任务'), httpAttempts, fallbackCount };
      }

      const key = profile.apiKey.trim();
      // 本地端点不校验 Authorization，所以「没 key」只有在远端才算错误。
      if (key.length === 0 && !isLocalBaseUrl(profile.baseUrl)) {
        return { ...fail(`「${profile.name}」还没有填 API key。到「设置 → LLM」里补上。`), httpAttempts, fallbackCount };
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // 只在真有 key 时带 Authorization：多余的 `Bearer ` 会让某些本地服务直接 400。
      if (key.length > 0) headers['Authorization'] = `Bearer ${key}`;

      mode = request.tool ? this.savedMode(profile, request.tool) ?? initialHarnessMode(profile.baseUrl) : 'plain';
      const result = (text: string, actualMode: HarnessMode): LlmAnalyzeResult => ({
        ok: true, text, profileName: profile.name, model: profile.model,
        ...(request.tool ? { responseMode: actualMode } : {}), httpAttempts, fallbackCount,
        ...(usageTotals ? { usage: usageTotals } : {}),
      });
      const failed = (error: string): LlmAnalyzeResult => ({
        ...fail(error), httpAttempts, fallbackCount,
        ...(request.tool ? { responseMode: mode } : {}),
        ...(usageTotals ? { usage: usageTotals } : {}),
      });
      const send = async (selectedMode: HarnessMode): Promise<{ response: Response; raw: string }> => this.withRequestSlot(request.signal, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
        try {
          const body: Record<string, unknown> = {
            model: profile.model,
            messages: [
              ...(request.system ? [{ role: 'system', content: request.system }] : []),
              { role: 'user', content: request.user },
            ],
            temperature: request.temperature ?? profile.temperature,
          };
          if (selectedMode === 'tool' && request.tool) {
            body['tools'] = [{ type: 'function', function: { ...request.tool, strict: true } }];
            body['tool_choice'] = { type: 'function', function: { name: request.tool.name } };
            body['parallel_tool_calls'] = false;
          } else if (selectedMode === 'json_schema' && request.tool) {
            body['response_format'] = { type: 'json_schema', json_schema: {
              name: request.tool.name, strict: true, schema: request.tool.parameters,
            } };
          } else if (selectedMode === 'json_object') {
            body['response_format'] = { type: 'json_object' };
          }
          httpAttempts += 1;
          const response = await (this.options.fetchImpl ?? fetch)(`${profile.baseUrl}/chat/completions`, {
            method: 'POST', headers, body: JSON.stringify(body), signal,
          });
          return { response, raw: await response.text() };
        } finally { clearTimeout(timer); }
      });

      let emptyRetry = false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const { response, raw } = await send(mode);
        if (!response.ok) {
          const next = request.tool && formatNotSupported(mode, response.status, raw) ? nextHarnessMode(mode) : null;
          if (next) {
            mode = next; fallbackCount += 1; emptyRetry = false;
            this.rememberMode(profile, request.tool!, mode);
            continue;
          }
          return failed(`模型服务返回 HTTP ${response.status}：${truncate(raw, 300)}`);
        }

        let data: unknown;
        try { data = JSON.parse(raw) as unknown; }
        catch { return failed(`模型返回的不是 JSON：${truncate(raw, 200)}`); }
        usageTotals = mergeUsage(usageTotals, extractUsage(data));
        if (finishReason(data) === 'length') return failed('输出 token limit：模型答案被截断');
        if (request.tool && mode === 'tool') {
          const toolResult = extractToolArguments(data, request.tool.name);
          if (toolResult.status === 'invalid') return failed(toolResult.error);
          if (toolResult.status === 'called') {
            this.rememberMode(profile, request.tool, mode);
            return result(toolResult.arguments, mode);
          }
          const content = extractContent(data);
          if (content?.trim()) {
            // 端点忽略了强制工具，但返回了可用正文；本次接受，后续尝试 JSON Output。
            this.rememberMode(profile, request.tool, 'json_object');
            fallbackCount += 1;
            return result(content, 'plain');
          }
          mode = 'json_object'; fallbackCount += 1; emptyRetry = false;
          this.rememberMode(profile, request.tool, mode);
          continue;
        }
        const content = extractContent(data);
        if (request.tool && mode !== 'plain' && (!content?.trim() || !isJsonText(content))) {
          if (!emptyRetry) { emptyRetry = true; continue; }
          // 交给 Harness 的 ID/字段校验与缩批机制处理；不能把空答案当成成功批次。
          return result(content ?? '', mode);
        }
        if (content === null || !content.trim()) {
          return request.tool ? result('', mode)
            : failed(`模型没有返回内容，检查模型名。响应片段：${truncate(safeStringify(data), 200)}`);
        }
        if (request.tool) this.rememberMode(profile, request.tool, mode);
        return result(content, mode);
      }
      return failed('模型响应格式协商失败，请检查端点的结构化输出支持');
    } catch (error) {
      const reason = request.signal?.aborted ? '已取消 LLM 请求' : describeError(error);
      return { ...fail(reason), httpAttempts, fallbackCount, ...(request.tool ? { responseMode: mode } : {}),
        ...(usageTotals ? { usage: usageTotals } : {}) };
    }
  }

  /**
   * 读磁盘并归一化。
   *
   * 不缓存：设置页改完立刻要生效，而 analyze 是低频操作，多读一次文件比维护
   * 一致性要便宜。文件缺失/损坏时 `readJson` 给回退值，这里再补默认。
   */
  private readStored(): StoredShape {
    return normalizeStored(readJson<unknown>(this.options.settingsFile, null));
  }

  private capabilityFile(): string {
    return path.join(path.dirname(this.options.settingsFile), 'llm-output-capabilities.json');
  }

  private capabilityKey(profile: StoredProfile, tool: NonNullable<LlmCompletionRequest['tool']>): string {
    return createHash('sha256').update(JSON.stringify([profile.id, profile.baseUrl, profile.model, tool.parameters])).digest('hex');
  }

  private savedMode(profile: StoredProfile, tool: NonNullable<LlmCompletionRequest['tool']>): HarnessMode | null {
    const raw = readJson<unknown>(this.capabilityFile(), {});
    const entry = isRecord(raw) ? raw[this.capabilityKey(profile, tool)] : null;
    return isRecord(entry) && typeof entry['checkedAt'] === 'number' &&
      Date.now() - entry['checkedAt'] < CAPABILITY_TTL_MS && isHarnessMode(entry['mode']) ? entry['mode'] : null;
  }

  private rememberMode(profile: StoredProfile, tool: NonNullable<LlmCompletionRequest['tool']>, mode: HarnessMode): void {
    const file = this.capabilityFile();
    const raw = readJson<unknown>(file, {});
    const record = (isRecord(raw) ? raw : {}) as CapabilityRecord;
    const key = this.capabilityKey(profile, tool);
    if (record[key]?.mode === mode && Date.now() - record[key]!.checkedAt < CAPABILITY_TTL_MS / 2) return;
    const now = Date.now();
    const kept = Object.fromEntries(Object.entries(record).filter(([, entry]) =>
      entry && typeof entry.checkedAt === 'number' && now - entry.checkedAt < CAPABILITY_TTL_MS).slice(-99));
    writeJsonAtomic(file, { ...kept, [key]: { mode, checkedAt: now } });
  }

  /** 全局最多四个在途请求，避免多本书并跑绕开每个 Harness 的并发上限。 */
  private async withRequestSlot<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.activeRequests < MAX_GLOBAL_LLM_REQUESTS) {
      this.activeRequests += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => { signal?.removeEventListener('abort', abort); resolve(); };
        const abort = (): void => {
          const index = this.waiting.indexOf(wake);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        this.waiting.push(wake);
        signal?.addEventListener('abort', abort, { once: true });
      });
      if (signal?.aborted) {
        this.releaseRequestSlot();
        throw new DOMException('Aborted', 'AbortError');
      }
    }
    try { return await task(); }
    finally { this.releaseRequestSlot(); }
  }

  private releaseRequestSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.activeRequests -= 1;
  }
}

/** 纯函数，单独导出以便单测。 */
export function renderPrompt(template: string, vars: { word: string; context: string }): string {
  // split/join 而不是 `String.replace(str, ...)`：后者只换第一处，而模板里
  // `{{word}}` 完全可能出现多次（默认提示词就用了两次 `{{context}}` 之外的自定义模板）。
  // 入参来自 IPC，按「可能不是字符串」处理，别让一个坏请求变成抛异常。
  const word = typeof vars.word === 'string' ? vars.word : '';
  const context =
    typeof vars.context === 'string' && vars.context.trim().length > 0 ? vars.context : '（无上下文）';
  return template.split('{{word}}').join(word).split('{{context}}').join(context);
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

function normalizeStored(raw: unknown): StoredShape {
  const record = isRecord(raw) ? raw : {};
  const list = Array.isArray(record['profiles']) ? record['profiles'] : [];

  const profiles: StoredProfile[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const profile = normalizeProfile(entry);
    if (profile === null || seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }

  const prompt = typeof record['prompt'] === 'string' ? record['prompt'] : '';
  const active = typeof record['activeProfileId'] === 'string' ? record['activeProfileId'] : null;

  return {
    profiles,
    activeProfileId: resolveActive(profiles, active),
    // 缺失或空白都算「没设过」。空提示词发出去只会换回一句模型抱怨。
    prompt: upgradePrompt(prompt),
  };
}

/**
 * 把「从没编辑过的旧默认」升级成新默认。
 *
 * 老用户的 `llm.json` 里存着一份 prompt。如果只认「有就不动」，改代码里的默认对他就
 * **完全无效**，而界面上看不出任何区别——他只会觉得「我让你加了舶来语条款怎么没有」。
 *
 * 判据是**逐字等于**某个历史默认：只有用户从没动过才替换。真改过的一个字符都不动。
 */
function upgradePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return DEFAULT_LLM_PROMPT;
  if (trimmed === DEFAULT_LLM_PROMPT) return prompt;
  return LEGACY_LLM_PROMPTS.some((legacy) => legacy.trim() === trimmed) ? DEFAULT_LLM_PROMPT : prompt;
}

/** 单个配置的清洗。`null` = 这条不能用（没有 id），调用方负责丢。 */
function normalizeProfile(raw: unknown): StoredProfile | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw['id']).trim();
  if (id.length === 0) return null;

  return {
    id,
    name: asString(raw['name']).trim() || id,
    // 末尾斜杠必须去掉：`${baseUrl}/chat/completions` 拼出 `//chat/completions`，
    // 有些网关会当成不同路径直接 404。
    baseUrl: asString(raw['baseUrl']).trim().replace(/\/+$/, ''),
    model: asString(raw['model']).trim(),
    temperature:
      typeof raw['temperature'] === 'number' && Number.isFinite(raw['temperature'])
        ? raw['temperature']
        : DEFAULT_TEMPERATURE,
    apiKey: asString(raw['apiKey']).trim(),
  };
}

/** 把选中的 id 夹到真实存在的配置上；没有配置就是 null。 */
function resolveActive(profiles: StoredProfile[], wanted: string | null): string | null {
  if (wanted === null) return null;
  if (profiles.some((profile) => profile.id === wanted)) return wanted;
  return profiles[0]?.id ?? null;
}

function toPublic(stored: StoredShape): LlmSettings {
  return {
    profiles: stored.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      temperature: profile.temperature,
      // 唯一的 key 出口：只报「有没有」，明文到此为止。
      hasApiKey: profile.apiKey.length > 0,
    })),
    activeProfileId: stored.activeProfileId,
    prompt: stored.prompt,
  };
}

// ---------------------------------------------------------------------------
// 请求/响应
// ---------------------------------------------------------------------------

/** `localhost` / `127.0.0.1`（含 `::1`）视为本地，不要求 key。 */
function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    // 解析不了的地址按远端处理：宁可多要一个 key，也不对不明地址裸发请求。
    return false;
  }
}

function extractContent(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const choices = data['choices'];
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first['message'];
  if (!isRecord(message)) return null;
  const content = message['content'];
  return typeof content === 'string' ? content : null;
}

function isHarnessMode(value: unknown): value is HarnessMode {
  return value === 'tool' || value === 'json_schema' || value === 'json_object' || value === 'plain';
}

function initialHarnessMode(baseUrl: string): HarnessMode {
  let host = '';
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { /* 配置校验另行处理。 */ }
  if (host === 'api.deepseek.com') return 'json_object';
  if (host === 'api.openai.com') return 'json_schema';
  return 'tool';
}

function nextHarnessMode(mode: HarnessMode): HarnessMode | null {
  if (mode === 'json_schema') return 'tool';
  if (mode === 'tool') return 'json_object';
  if (mode === 'json_object') return 'plain';
  return null;
}

/** 只对格式参数本身被拒的 400/422/501 降级；鉴权、限流、网络错误不能降级。 */
function formatNotSupported(mode: HarnessMode, status: number, body: string): boolean {
  if (![400, 422, 501].includes(status)) return false;
  if (mode === 'tool') return /tools?|tool_choice|function.call|parallel_tool_calls|strict/i.test(body);
  if (mode === 'json_schema') return /response_format|json_schema|schema|strict/i.test(body);
  if (mode === 'json_object') return /response_format|json_object|json mode/i.test(body);
  return false;
}

function isJsonText(value: string): boolean {
  try { return isRecord(JSON.parse(value)); } catch { return false; }
}

function finishReason(data: unknown): string | null {
  if (!isRecord(data) || !Array.isArray(data['choices'])) return null;
  const first = data['choices'][0];
  return isRecord(first) && typeof first['finish_reason'] === 'string' ? first['finish_reason'] : null;
}

function extractUsage(data: unknown): LlmAnalyzeResult['usage'] | undefined {
  if (!isRecord(data) || !isRecord(data['usage'])) return undefined;
  const usage = data['usage'];
  const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const promptTokens = number(usage['prompt_tokens']);
  const completionTokens = number(usage['completion_tokens']);
  const detail = isRecord(usage['prompt_tokens_details']) ? usage['prompt_tokens_details'] : {};
  const cacheHitTokens = number(usage['prompt_cache_hit_tokens']) ?? number(detail['cached_tokens']);
  const cacheMissTokens = number(usage['prompt_cache_miss_tokens']) ??
    (promptTokens !== undefined && cacheHitTokens !== undefined ? Math.max(0, promptTokens - cacheHitTokens) : undefined);
  if (promptTokens === undefined && completionTokens === undefined && cacheHitTokens === undefined) return undefined;
  return { promptTokens, completionTokens, cacheHitTokens, cacheMissTokens };
}

function mergeUsage(
  total: LlmAnalyzeResult['usage'] | undefined,
  current: LlmAnalyzeResult['usage'] | undefined,
): LlmAnalyzeResult['usage'] | undefined {
  if (!current) return total;
  const sum = (key: keyof NonNullable<LlmAnalyzeResult['usage']>): number | undefined =>
    current[key] === undefined ? total?.[key] : (total?.[key] ?? 0) + current[key]!;
  return {
    promptTokens: sum('promptTokens'), completionTokens: sum('completionTokens'),
    cacheHitTokens: sum('cacheHitTokens'), cacheMissTokens: sum('cacheMissTokens'),
  };
}

type ToolExtraction =
  | { status: 'called'; arguments: string }
  | { status: 'not_called' }
  | { status: 'invalid'; error: string };

function extractToolArguments(data: unknown, expectedName: string): ToolExtraction {
  if (!isRecord(data) || !Array.isArray(data['choices'])) return { status: 'not_called' };
  const first = data['choices'][0];
  const message = isRecord(first) ? first['message'] : null;
  if (!isRecord(message)) return { status: 'not_called' };
  const calls = message['tool_calls'];
  if (Array.isArray(calls) && calls.length > 0) {
    if (calls.length !== 1) return { status: 'invalid', error: '模型一次返回了多个提交工具调用' };
    return parseToolCall(calls[0], expectedName);
  }
  // 部分旧兼容端点沿用 function_call；仍只接受指定提交工具。
  if (isRecord(message['function_call'])) {
    return parseToolCall({ type: 'function', function: message['function_call'] }, expectedName);
  }
  return { status: 'not_called' };
}

function parseToolCall(call: unknown, expectedName: string): ToolExtraction {
  if (!isRecord(call) || call['type'] !== 'function' || !isRecord(call['function']) || call['function']['name'] !== expectedName) {
    return { status: 'invalid', error: '模型调用了未知工具，拒绝把结果当作学习卡数据' };
  }
  const args = call['function']['arguments'];
  if (typeof args === 'string') return { status: 'called', arguments: args };
  if (isRecord(args)) return { status: 'called', arguments: JSON.stringify(args) };
  return { status: 'invalid', error: '模型提交工具缺少 JSON 参数' };
}

function fail(error: string): LlmAnalyzeResult {
  return { ok: false, text: '', profileName: '', model: '', error };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return `模型响应超时（${REQUEST_TIMEOUT_MS / 1000} 秒）。到「设置 → LLM」里换成更快的模型或本地服务。`;
    }
    return `请求失败：${error.message}`;
  }
  return `请求失败：${String(error)}`;
}

/** 压成一行再截断：多行响应片段塞进提示条会看不出重点。 */
function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
