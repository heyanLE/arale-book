/** 多提供商文本翻译。密钥只在主进程和 translation.json 中出现。 */

import { createHash, randomBytes } from 'node:crypto';
import { readJson, writeJsonAtomic } from '../../core/util/atomic-json';
import {
  BUILTIN_BING_PROFILE_ID,
  type TranslationProfile,
  type TranslationProviderId,
  type TranslationRequest,
  type TranslationResult,
  type TranslationSettings,
} from '../../shared/types';
interface StoredProfile extends Omit<TranslationProfile, 'hasSecret'> {
  secret: string;
}

interface StoredSettings {
  profiles: StoredProfile[];
  activeProfileId: string | null;
  targetLanguage: TranslationSettings['targetLanguage'];
}

export interface TranslationServiceOptions {
  settingsFile: string;
  fetchImpl?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 30_000;
const PROVIDERS = new Set<TranslationProviderId>([
  'bing', 'microsoft', 'deepl', 'google', 'baidu', 'libretranslate',
]);

function builtinBing(): StoredProfile {
  return {
    id: BUILTIN_BING_PROFILE_ID,
    name: 'Bing 网页翻译',
    provider: 'bing',
    baseUrl: '',
    region: '',
    appId: '',
    secret: '',
  };
}

const DEFAULT_URLS: Record<TranslationProviderId, string> = {
  bing: 'https://bing.com',
  microsoft: 'https://api.cognitive.microsofttranslator.com',
  deepl: 'https://api-free.deepl.com',
  google: 'https://translation.googleapis.com',
  baidu: 'https://fanyi-api.baidu.com',
  libretranslate: 'http://127.0.0.1:5000',
};

export class TranslationService {
  private readonly cache = new Map<string, TranslationResult>();
  private bingSession: BingSession | null = null;
  private bingSessionPromise: Promise<BingSession> | null = null;

  constructor(private readonly options: TranslationServiceOptions) {}

  settings(): TranslationSettings {
    return toPublic(this.readStored());
  }

  update(patch: {
    profiles?: TranslationProfile[];
    activeProfileId?: string | null;
    targetLanguage?: TranslationSettings['targetLanguage'];
  }): TranslationSettings {
    const stored = this.readStored();
    const next: StoredSettings = { ...stored };
    if (patch.profiles !== undefined) {
      const existing = new Map(stored.profiles.map((profile) => [profile.id, profile]));
      const seen = new Set<string>();
      next.profiles = [builtinBing()];
      seen.add(BUILTIN_BING_PROFILE_ID);
      for (const profile of patch.profiles) {
        const persisted = existing.get(profile.id);
        // 名称和提供商属于配置身份，保存后保持不变；其余端点参数可编辑。
        const normalized = normalizeProfile(persisted ? { ...profile, name: persisted.name, provider: persisted.provider } : profile);
        if (normalized === null || seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        normalized.secret = persisted?.secret ?? '';
        next.profiles.push(normalized);
      }
    }
    if (patch.activeProfileId !== undefined) next.activeProfileId = patch.activeProfileId;
    next.activeProfileId = resolveActive(next.profiles, next.activeProfileId);
    if (patch.targetLanguage === 'zh-Hans' || patch.targetLanguage === 'zh-Hant' || patch.targetLanguage === 'en') {
      next.targetLanguage = patch.targetLanguage;
    }
    this.cache.clear();
    writeJsonAtomic(this.options.settingsFile, next);
    return toPublic(next);
  }

  setSecret(profileId: string, secret: string | null): TranslationSettings {
    const stored = this.readStored();
    if (profileId === BUILTIN_BING_PROFILE_ID) return toPublic(stored);
    const profile = stored.profiles.find((item) => item.id === profileId);
    if (profile !== undefined) {
      profile.secret = (secret ?? '').trim();
      this.cache.clear();
      writeJsonAtomic(this.options.settingsFile, stored);
    }
    return toPublic(stored);
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    try {
      const stored = this.readStored();
      const wanted = request.profileId ?? stored.activeProfileId;
      const profile = wanted === null ? undefined : stored.profiles.find((item) => item.id === wanted);
      if (profile === undefined) return fail('还没有配置翻译引擎。到「设置 → 翻译」里添加一套。');
      const text = request.text.trim();
      if (text.length === 0) return fail('没有可翻译的文字。', profile);
      if (needsSecret(profile.provider) && profile.secret.length === 0) {
        return fail(`「${profile.name}」还没有填写密钥。`, profile);
      }
      if (profile.provider === 'baidu' && profile.appId.length === 0) {
        return fail(`「${profile.name}」还没有填写 App ID。`, profile);
      }

      const source = request.sourceLanguage?.trim() || 'ja';
      const target = request.targetLanguage ?? stored.targetLanguage;
      const cacheKey = `${profile.id}\0${source}\0${target}\0${text}`;
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) return { ...cached };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const translated = await this.request(profile, text, source, target, controller.signal);
        const result: TranslationResult = {
          ok: true,
          text: translated.text,
          sourceReading: translated.sourceReading,
          profileName: profile.name,
          provider: profile.provider,
          sourceLanguage: source,
          targetLanguage: target,
        };
        this.cache.set(cacheKey, result);
        return { ...result };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return fail(describeError(error));
    }
  }

  private async request(
    profile: StoredProfile,
    text: string,
    source: string,
    target: TranslationSettings['targetLanguage'],
    signal: AbortSignal,
  ): Promise<TranslatedPayload> {
    const fetcher = this.options.fetchImpl ?? fetch;
    const base = (profile.baseUrl || DEFAULT_URLS[profile.provider]).replace(/\/+$/, '');
    let response: Response;

    if (profile.provider === 'bing') {
      return this.requestBing(text, source, target, signal);
    }

    if (profile.provider === 'microsoft') {
      const url = new URL(`${base}/translate`);
      url.searchParams.set('api-version', '3.0');
      url.searchParams.set('from', microsoftLanguage(source));
      url.searchParams.set('to', microsoftLanguage(target));
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': profile.secret,
      };
      if (profile.region.length > 0) headers['Ocp-Apim-Subscription-Region'] = profile.region;
      response = await fetcher(url, {
        method: 'POST', headers, body: JSON.stringify([{ Text: text }]), signal,
      });
      const data = await responseJson(response);
      const value = arrayRecord(data)?.[0]?.['translations'];
      const translated = arrayRecord(value)?.[0]?.['text'];
      if (typeof translated === 'string') return translatedPayload(translated);
      throw badShape(data);
    }

    if (profile.provider === 'deepl') {
      response = await fetcher(`${base}/v2/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${profile.secret}` },
        body: JSON.stringify({ text: [text], source_lang: deeplLanguage(source), target_lang: deeplLanguage(target) }),
        signal,
      });
      const data = await responseJson(response);
      const translated = arrayRecord(record(data)?.['translations'])?.[0]?.['text'];
      if (typeof translated === 'string') return translatedPayload(translated);
      throw badShape(data);
    }

    if (profile.provider === 'google') {
      const url = new URL(`${base}/language/translate/v2`);
      url.searchParams.set('key', profile.secret);
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: googleLanguage(source), target: googleLanguage(target), format: 'text' }),
        signal,
      });
      const data = await responseJson(response);
      const translated = arrayRecord(record(record(data)?.['data'])?.['translations'])?.[0]?.['translatedText'];
      if (typeof translated === 'string') return translatedPayload(decodeEntities(translated));
      throw badShape(data);
    }

    if (profile.provider === 'baidu') {
      const salt = randomBytes(8).toString('hex');
      const sign = createHash('md5').update(`${profile.appId}${text}${salt}${profile.secret}`).digest('hex');
      const body = new URLSearchParams({
        q: text,
        from: baiduLanguage(source),
        to: baiduLanguage(target),
        appid: profile.appId,
        salt,
        sign,
      });
      response = await fetcher(`${base}/api/trans/vip/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      });
      const data = await responseJson(response);
      const parts = arrayRecord(record(data)?.['trans_result']);
      if (parts !== null) {
        const translated = parts.map((item) => item['dst']).filter((item): item is string => typeof item === 'string');
        if (translated.length > 0) return translatedPayload(translated.join('\n'));
      }
      const error = record(data)?.['error_msg'];
      if (typeof error === 'string') throw new Error(`百度翻译：${error}`);
      throw badShape(data);
    }

    const body: Record<string, string> = {
      q: text,
      source: libreLanguage(source),
      target: libreLanguage(target),
      format: 'text',
    };
    if (profile.secret.length > 0) body['api_key'] = profile.secret;
    response = await fetcher(`${base}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const data = await responseJson(response);
    const translated = record(data)?.['translatedText'];
    if (typeof translated === 'string') return translatedPayload(translated);
    throw badShape(data);
  }

  /** Bing 网页内部协议：先取临时防滥用参数，再请求 ttranslatev3。 */
  private async requestBing(
    text: string,
    source: string,
    target: TranslationSettings['targetLanguage'],
    signal: AbortSignal,
  ): Promise<TranslatedPayload> {
    const fetcher = this.options.fetchImpl ?? fetch;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.getBingSession(fetcher, signal);
      const useEpt = text.length <= 3_000;
      const maxLength = session.subdomain === 'cn' ? 5_000 : 1_000;
      if (!useEpt && text.length > maxLength) {
        throw new Error(`Bing 网页翻译最多支持 ${maxLength} 个字符。`);
      }

      const root = `https://${session.subdomain ? `${session.subdomain}.` : ''}bing.com`;
      const url = new URL(`${root}/ttranslatev3`);
      url.searchParams.set('isVertical', '1');
      url.searchParams.set('IG', session.ig);
      url.searchParams.set('IID', session.iid);
      if (useEpt) {
        session.count += 1;
        url.searchParams.set('SFX', String(session.count));
        url.searchParams.set('ref', 'TThis');
        url.searchParams.set('edgepdftranslator', '1');
      }

      const requestBody = new URLSearchParams({
        fromLang: bingLanguage(source),
        to: bingLanguage(target),
        text,
        token: session.token,
        key: String(session.key),
        tryFetchingGenderDebiasedTranslations: 'true',
      });
      const requestInit: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': BING_USER_AGENT,
          Referer: `${root}/translator`,
        },
        body: requestBody,
        signal,
      };
      const response = await fetcher(url, requestInit);
      const raw = await response.text();
      const data = parseJson(raw);
      const errorShape = record(data);
      const captcha = errorShape?.['ShowCaptcha'] === true;
      const limited = errorShape?.['StatusCode'] === 401 || response.status === 401;
      if (captcha || limited) {
        this.bingSession = null;
        this.bingSessionPromise = null;
        if (attempt === 0) continue;
        throw new Error(captcha ? 'Bing 要求验证码，请稍后再试。' : 'Bing 免费翻译额度已触发限制，请稍后再试。');
      }
      if (!response.ok) throw new Error(`Bing HTTP ${response.status}：${truncate(raw, 300)}`);
      const resultItems = arrayRecord(data);
      const translations = resultItems?.[0]?.['translations'];
      const translated = arrayRecord(translations)?.[0]?.['text'];
      const inputReading = resultItems?.[1]?.['inputTransliteration'];
      if (typeof translated === 'string') {
        return translatedPayload(translated, typeof inputReading === 'string' ? inputReading : '');
      }
      // 少数语言会先返回性别去偏页面，再要求带这个标记请求一次 JSON 结果。
      if (response.headers.has('isgenderdebiasedtranslation')) {
        requestBody.set('isGenderDebiasViewPresent', 'true');
        const genderResponse = await fetcher(url, requestInit);
        const genderData = await responseJson(genderResponse);
        const masculine = record(genderData)?.['masculineTranslation'];
        const feminine = record(genderData)?.['feminineTranslation'];
        if (typeof masculine === 'string') return translatedPayload(masculine);
        if (typeof feminine === 'string') return translatedPayload(feminine);
        throw badShape(genderData);
      }
      throw badShape(data ?? raw);
    }
    throw new Error('Bing 网页翻译暂时不可用。');
  }

  private getBingSession(fetcher: typeof fetch, signal: AbortSignal): Promise<BingSession> {
    if (this.bingSession !== null && Date.now() - this.bingSession.createdAt < this.bingSession.expiresIn) {
      return Promise.resolve(this.bingSession);
    }
    if (this.bingSessionPromise !== null) return this.bingSessionPromise;

    this.bingSessionPromise = (async () => {
      const response = await fetcher('https://bing.com/translator', {
        headers: { 'User-Agent': BING_USER_AGENT },
        signal,
      });
      const html = await response.text();
      if (!response.ok) throw new Error(`读取 Bing 翻译页面失败（HTTP ${response.status}）。`);
      const ig = /IG:"([^"]+)"/.exec(html)?.[1];
      const iid = /data-iid="([^"]+)"/.exec(html)?.[1];
      const abuse = /params_AbusePreventionHelper\s?=\s?(\[[^\]]+\])/.exec(html)?.[1];
      if (!ig || !iid || !abuse) throw new Error('Bing 页面格式已变化，无法取得临时翻译参数。');
      const values = JSON.parse(abuse) as unknown;
      if (!Array.isArray(values) || typeof values[0] !== 'number' || typeof values[1] !== 'string') {
        throw new Error('Bing 返回了无效的临时翻译参数。');
      }
      const host = response.url === '' ? '' : new URL(response.url).hostname;
      const session: BingSession = {
        ig,
        iid,
        key: values[0],
        token: values[1],
        expiresIn: typeof values[2] === 'number' ? values[2] : 600_000,
        createdAt: Date.now(),
        subdomain: /^(\w+)\.bing\.com$/i.exec(host)?.[1] ?? '',
        count: 0,
      };
      this.bingSession = session;
      return session;
    })().finally(() => {
      this.bingSessionPromise = null;
    });
    return this.bingSessionPromise;
  }

  private readStored(): StoredSettings {
    const raw = readJson<unknown>(this.options.settingsFile, null);
    const object = record(raw);
    const savedProfiles = Array.isArray(object?.['profiles'])
      ? object['profiles'].map(normalizeStoredProfile).filter((item): item is StoredProfile => item !== null)
      : [];
    const profiles = [builtinBing(), ...savedProfiles.filter((item) => item.id !== BUILTIN_BING_PROFILE_ID)];
    const active = typeof object?.['activeProfileId'] === 'string' ? object['activeProfileId'] : null;
    const target = object?.['targetLanguage'];
    return {
      profiles,
      activeProfileId: resolveActive(profiles, active),
      targetLanguage: target === 'zh-Hant' || target === 'en' ? target : 'zh-Hans',
    };
  }
}

function normalizeProfile(profile: TranslationProfile): StoredProfile | null {
  if (!profile || typeof profile.id !== 'string' || profile.id.trim().length === 0) return null;
  if (!PROVIDERS.has(profile.provider)) return null;
  return {
    id: profile.id.trim(),
    name: profile.name.trim() || providerName(profile.provider),
    provider: profile.provider,
    baseUrl: profile.baseUrl.trim().replace(/\/+$/, ''),
    region: profile.region.trim(),
    appId: profile.appId.trim(),
    secret: '',
  };
}

function normalizeStoredProfile(value: unknown): StoredProfile | null {
  const item = record(value);
  if (item === null) return null;
  const provider = item['provider'];
  if (typeof provider !== 'string' || !PROVIDERS.has(provider as TranslationProviderId)) return null;
  const normalized = normalizeProfile({
    id: string(item['id']), name: string(item['name']), provider: provider as TranslationProviderId,
    baseUrl: string(item['baseUrl']), region: string(item['region']), appId: string(item['appId']), hasSecret: false,
  });
  return normalized === null ? null : { ...normalized, secret: string(item['secret']).trim() };
}

function toPublic(stored: StoredSettings): TranslationSettings {
  return {
    profiles: stored.profiles.map(({ secret, ...profile }) => ({ ...profile, hasSecret: secret.length > 0 })),
    activeProfileId: stored.activeProfileId,
    targetLanguage: stored.targetLanguage,
  };
}

function resolveActive(profiles: readonly StoredProfile[], wanted: string | null): string | null {
  return profiles.some((item) => item.id === wanted) ? wanted : (profiles[0]?.id ?? null);
}

function needsSecret(provider: TranslationProviderId): boolean {
  return provider !== 'bing' && provider !== 'libretranslate';
}

function providerName(provider: TranslationProviderId): string {
  return ({ bing: 'Bing 网页翻译', microsoft: 'Microsoft Translator', deepl: 'DeepL', google: 'Google Translate', baidu: '百度翻译', libretranslate: 'LibreTranslate' })[provider];
}

function bingLanguage(value: string): string {
  if (value === 'zh-Hans' || value === 'zh-Hant') return value;
  return value === 'en' ? 'en' : 'ja';
}

function microsoftLanguage(value: string): string {
  if (value === 'zh-Hans' || value === 'zh-Hant') return value;
  return value === 'en' ? 'en' : 'ja';
}
function googleLanguage(value: string): string {
  if (value === 'zh-Hant') return 'zh-TW';
  if (value === 'zh-Hans') return 'zh-CN';
  return value === 'en' ? 'en' : 'ja';
}
function deeplLanguage(value: string): string {
  if (value === 'zh-Hant') return 'ZH-HANT';
  if (value === 'zh-Hans') return 'ZH-HANS';
  return value === 'en' ? 'EN' : 'JA';
}
function baiduLanguage(value: string): string {
  if (value === 'zh-Hant') return 'cht';
  if (value === 'zh-Hans') return 'zh';
  return value === 'en' ? 'en' : 'jp';
}
function libreLanguage(value: string): string {
  if (value === 'zh-Hant' || value === 'zh-Hans') return 'zh';
  return value === 'en' ? 'en' : 'ja';
}

async function responseJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}：${truncate(raw, 300)}`);
  try { return JSON.parse(raw) as unknown; } catch { throw new Error(`返回的不是 JSON：${truncate(raw, 200)}`); }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function arrayRecord(value: unknown): Array<Record<string, unknown>> | null {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => record(item) !== null) : null;
}
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function truncate(value: string, max: number): string { const one = value.replace(/\s+/g, ' ').trim(); return one.length <= max ? one : `${one.slice(0, max)}…`; }
function badShape(value: unknown): Error { return new Error(`响应里没有译文：${truncate(JSON.stringify(value), 220)}`); }
function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}
function decodeEntities(value: string): string { return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }

function fail(error: string, profile?: StoredProfile): TranslationResult {
  return { ok: false, text: '', sourceReading: '', profileName: profile?.name ?? '', provider: profile?.provider ?? '', sourceLanguage: '', targetLanguage: '', error };
}
function describeError(error: unknown): string {
  if (error instanceof Error) return error.name === 'AbortError' ? `翻译超时（${REQUEST_TIMEOUT_MS / 1000} 秒）。` : `翻译失败：${error.message}`;
  return `翻译失败：${String(error)}`;
}

interface BingSession {
  ig: string;
  iid: string;
  key: number;
  token: string;
  expiresIn: number;
  createdAt: number;
  subdomain: string;
  count: number;
}

const BING_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';

interface TranslatedPayload {
  text: string;
  sourceReading: string;
}

function translatedPayload(text: string, sourceReading = ''): TranslatedPayload {
  return { text, sourceReading };
}
