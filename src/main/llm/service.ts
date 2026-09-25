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

import {
  DEFAULT_LLM_PROMPT,
  LEGACY_LLM_PROMPTS,
  type LlmAnalyzeRequest,
  type LlmAnalyzeResult,
  type LlmProfile,
  type LlmSettings,
} from '../../shared/types';
import { readJson, writeJsonAtomic } from '../../core/util/atomic-json';

export interface LlmServiceOptions {
  /** 配置文件（`<userData>/llm.json`）。 */
  settingsFile: string;
  /** 注入 fetch（测试用）。默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
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

export class LlmService {
  constructor(private readonly options: LlmServiceOptions) {}

  /** 读设置。key 永远不返回，只返回 `hasApiKey`。 */
  settings(): LlmSettings {
    return toPublic(this.readStored());
  }

  /** 覆盖式写入 profiles / activeProfileId / prompt 中的任意部分。 */
  update(patch: { profiles?: LlmProfile[]; activeProfileId?: string | null; prompt?: string }): LlmSettings {
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
        normalized.apiKey = existing.get(normalized.id)?.apiKey ?? normalized.apiKey;
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
    try {
      const stored = this.readStored();
      const wanted = request.profileId ?? stored.activeProfileId;
      const profile = wanted === null ? undefined : stored.profiles.find((item) => item.id === wanted);
      if (profile === undefined) {
        return fail('还没有配置 LLM。到「设置 → LLM」里加一套。');
      }

      const key = profile.apiKey.trim();
      // 本地端点不校验 Authorization，所以「没 key」只有在远端才算错误。
      if (key.length === 0 && !isLocalBaseUrl(profile.baseUrl)) {
        return fail(`「${profile.name}」还没有填 API key。到「设置 → LLM」里补上。`);
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // 只在真有 key 时带 Authorization：多余的 `Bearer ` 会让某些本地服务直接 400。
      if (key.length > 0) headers['Authorization'] = `Bearer ${key}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await (this.options.fetchImpl ?? fetch)(`${profile.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: profile.model,
            messages: [
              { role: 'user', content: renderPrompt(stored.prompt, { word: request.word, context: request.context }) },
            ],
            temperature: profile.temperature,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      // 先读成文本再自己解析：JSON 坏掉时能把原文片段给用户看，而 `response.json()`
      // 只会扔一句没有上下文的 SyntaxError。
      const raw = await response.text();
      if (!response.ok) {
        return fail(`模型服务返回 HTTP ${response.status}：${truncate(raw, 300)}`);
      }

      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return fail(`模型返回的不是 JSON：${truncate(raw, 200)}`);
      }

      const content = extractContent(data);
      if (content === null || content.trim().length === 0) {
        // 模型名写错时很多服务正是这个形状（HTTP 200 但 choices 为空），
        // 所以这里必须把响应片段带上，否则用户完全无从下手。
        return fail(`模型没有返回内容，检查模型名是否正确。响应片段：${truncate(safeStringify(data), 200)}`);
      }

      return { ok: true, text: content, profileName: profile.name, model: profile.model };
    } catch (error) {
      return fail(describeError(error));
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
