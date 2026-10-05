import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TranslationService } from './support/translation/service';
import type { TranslationProfile, TranslationProviderId } from '../src/shared/types';
import { BUILTIN_BING_PROFILE_ID } from '../src/shared/types';

const tempDirs: string[] = [];
after(() => tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

interface Captured { url: string; init?: RequestInit }

function makeService(handler?: (call: Captured) => Response | Promise<Response>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-translation-'));
  tempDirs.push(dir);
  const calls: Captured[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { url: String(input), ...(init === undefined ? {} : { init }) };
    calls.push(call);
    if (handler === undefined) throw new Error('不应联网');
    return handler(call);
  };
  return {
    service: new TranslationService({ settingsFile: path.join(dir, 'translation.json'), fetchImpl }),
    calls,
  };
}

function profile(provider: TranslationProviderId): TranslationProfile {
  return {
    id: provider,
    name: provider,
    provider,
    baseUrl: `https://${provider}.example.test`,
    region: provider === 'microsoft' ? 'eastasia' : '',
    appId: provider === 'baidu' ? 'app-1' : '',
    hasSecret: false,
  };
}

function seed(service: TranslationService, provider: TranslationProviderId, withSecret = true) {
  const item = profile(provider);
  service.update({ profiles: [item], activeProfileId: item.id });
  if (withSecret) service.setSecret(item.id, 'secret-1');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('settings: 已存名称与提供商固定，更新端点不会清掉密钥', () => {
  const { service } = makeService();
  const item = profile('microsoft');
  service.update({ profiles: [item], activeProfileId: item.id });
  service.setSecret(item.id, 'top-secret');
  const renamed = service.update({ profiles: [{ ...item, name: '微软翻译', provider: 'deepl', baseUrl: 'https://new.example.test' }] });
  const microsoft = renamed.profiles.find((profile) => profile.id === item.id)!;
  assert.equal(microsoft.hasSecret, true);
  assert.equal(microsoft.name, item.name);
  assert.equal(microsoft.provider, 'microsoft');
  assert.equal(microsoft.baseUrl, 'https://new.example.test');
  assert.equal(Object.hasOwn(microsoft, 'secret'), false);
  assert.equal(JSON.stringify(renamed).includes('top-secret'), false);
});

test('settings: 内置 Bing 首次即存在且为默认，删除其条目也会自动恢复', () => {
  const { service } = makeService();
  const initial = service.settings();
  assert.equal(initial.activeProfileId, BUILTIN_BING_PROFILE_ID);
  assert.equal(initial.profiles[0]?.provider, 'bing');
  const changed = service.update({ profiles: [] });
  assert.equal(changed.profiles.length, 1);
  assert.equal(changed.profiles[0]?.id, BUILTIN_BING_PROFILE_ID);
  assert.equal(changed.activeProfileId, BUILTIN_BING_PROFILE_ID);
});

test('translate: Microsoft 请求包含 key、region 和语言参数', async () => {
  const { service, calls } = makeService(() => json([{ translations: [{ text: '猫' }] }]));
  seed(service, 'microsoft');
  const result = await service.translate({ text: 'ねこ', sourceLanguage: 'ja', targetLanguage: 'zh-Hans' });
  assert.equal(result.text, '猫');
  const call = calls[0]!;
  assert.match(call.url, /\/translate\?/);
  assert.match(call.url, /to=zh-Hans/);
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get('Ocp-Apim-Subscription-Key'), 'secret-1');
  assert.equal(headers.get('Ocp-Apim-Subscription-Region'), 'eastasia');
});

test('translate: Bing 网页模式无需 key，自动取得临时参数并复用', async () => {
  const html = `
    <html data-iid="translator.5028.1">
      <script>var IG:"IG-123"; params_AbusePreventionHelper = [1700000000000,"token-abc",600000];</script>
    </html>`;
  const { service, calls } = makeService((call) => {
    if (call.init?.method !== 'POST') return new Response(html, { status: 200 });
    return json([
      { detectedLanguage: { language: 'ja' }, translations: [{ text: '猫', to: 'zh-Hans' }] },
      { inputTransliteration: 'Neko', script: 'Latn' },
    ]);
  });
  seed(service, 'bing', false);

  const first = await service.translate({ text: 'ねこ', sourceLanguage: 'ja', targetLanguage: 'zh-Hans' });
  const second = await service.translate({ text: 'ネコ', sourceLanguage: 'ja', targetLanguage: 'zh-Hans' });
  assert.equal(first.ok, true);
  assert.equal(first.text, '猫');
  assert.equal(first.sourceReading, 'Neko');
  assert.equal(second.ok, true);
  assert.equal(calls.length, 3, '一次页面参数 + 两次不同原文的翻译请求');
  assert.equal(calls.filter((call) => call.init?.method !== 'POST').length, 1, '临时参数应复用');

  const request = calls.find((call) => call.init?.method === 'POST')!;
  assert.match(request.url, /\/ttranslatev3\?/);
  assert.match(request.url, /IG=IG-123/);
  const body = request.init?.body as URLSearchParams;
  assert.equal(body.get('fromLang'), 'ja');
  assert.equal(body.get('to'), 'zh-Hans');
  assert.equal(body.get('token'), 'token-abc');
  assert.equal(body.get('key'), '1700000000000');
});

test('translate: DeepL、Google、百度和 LibreTranslate 都解析各自响应', async () => {
  const cases: Array<[TranslationProviderId, unknown, string]> = [
    ['deepl', { translations: [{ text: '深度' }] }, '深度'],
    ['google', { data: { translations: [{ translatedText: '猫 &amp; 狗' }] } }, '猫 & 狗'],
    ['baidu', { trans_result: [{ dst: '第一行' }, { dst: '第二行' }] }, '第一行\n第二行'],
    ['libretranslate', { translatedText: '自由' }, '自由'],
  ];
  for (const [provider, response, expected] of cases) {
    const { service, calls } = makeService(() => json(response));
    seed(service, provider, provider !== 'libretranslate');
    const result = await service.translate({ text: '日本語' });
    assert.equal(result.ok, true, provider);
    assert.equal(result.text, expected, provider);
    assert.equal(calls.length, 1, provider);
    if (provider === 'deepl') {
      assert.equal(new Headers(calls[0]!.init?.headers).get('Authorization'), 'DeepL-Auth-Key secret-1');
    }
    if (provider === 'google') assert.match(calls[0]!.url, /key=secret-1/);
    if (provider === 'baidu') {
      const body = calls[0]!.init?.body as URLSearchParams;
      assert.equal(body.get('appid'), 'app-1');
      assert.match(body.get('sign') ?? '', /^[a-f0-9]{32}$/);
    }
    if (provider === 'libretranslate') {
      assert.equal(JSON.parse(String(calls[0]!.init?.body)).api_key, undefined);
    }
  }
});

test('translate: 需要密钥的引擎缺 key 时给可操作错误且不联网', async () => {
  const { service, calls } = makeService();
  seed(service, 'deepl', false);
  const result = await service.translate({ text: '猫' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /密钥/);
  assert.equal(calls.length, 0);
});

test('translate: HTTP 错误转成结果，不向 IPC 抛异常', async () => {
  const { service } = makeService(() => json({ message: 'invalid key' }, 401));
  seed(service, 'google');
  const result = await service.translate({ text: '猫' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /HTTP 401/);
});

test('translate: 相同请求命中会话缓存，不重复计费', async () => {
  const { service, calls } = makeService(() => json({ translatedText: '缓存' }));
  seed(service, 'libretranslate', false);
  await service.translate({ text: '同じ' });
  await service.translate({ text: '同じ' });
  assert.equal(calls.length, 1);
});
