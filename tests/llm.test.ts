/**
 * LLM 服务的单测。
 *
 * 这一层两边都是外部依赖：磁盘上的设置文件、远端 HTTP。所以两边都换掉——设置文件写临时
 * 目录，HTTP 用注入的假 fetch，完全不联网。重点不是「正常情况能跑」，而是三件会真伤人
 * 的事：
 * - key 会不会从 `settings()` 漏出去（漏了就等于把用户的密钥交给渲染进程和日志）；
 * - 失败路径会不会抛（抛了就穿过 IPC 把主进程带崩）；
 * - 「本地没 key」和「远端没 key」有没有被区别对待（本地端点本来就不校验 Authorization）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LlmService, renderPrompt } from './support/llm/service';
import { HARNESS_TOOL_NAME, harnessSubmissionTool } from '../src/core/study/harness-tool';
import { DEFAULT_LLM_PROMPT, LEGACY_LLM_PROMPTS, type LlmProfile } from '../src/shared/types';

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeService(fetchImpl?: typeof fetch): { service: LlmService; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-llm-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'llm.json');
  const service =
    fetchImpl === undefined
      ? new LlmService({ settingsFile: file })
      : new LlmService({ settingsFile: file, fetchImpl });
  return { service, file };
}

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** 假 fetch：记下每次请求，响应由调用方给。 */
function captureFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 造一套配置并设为默认。 */
function seed(service: LlmService, overrides: Partial<LlmProfile> = {}): LlmProfile {
  const profile: LlmProfile = {
    id: 'p1',
    name: '本地 Qwen',
    baseUrl: 'https://api.example.com/v1',
    model: 'qwen2.5',
    temperature: 0.3,
    hasApiKey: false,
    ...overrides,
  };
  service.update({ profiles: [profile], activeProfileId: profile.id });
  return profile;
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

test('settings: 首次运行给空 profiles + 默认提示词', () => {
  const { service } = makeService();
  const settings = service.settings();
  assert.deepEqual(settings.profiles, []);
  assert.equal(settings.activeProfileId, null);
  assert.equal(settings.prompt, DEFAULT_LLM_PROMPT);
});

test('制卡预算限制格式重试，未知用量保守记账且发送输出上限', async () => {
  const captured = captureFetch(async () => new Response(JSON.stringify({ error: { message: 'tools unsupported' } }), { status: 400 }));
  const { service } = makeService(captured.fetchImpl);
  seed(service);
  service.setApiKey('p1', 'sk-test');
  const result = await service.complete({ profileId: 'p1', system: '只输出 JSON', user: '[]',
    tool: harnessSubmissionTool('card'), maxOutputTokens: 600, tokenAllowance: 2000 });
  assert.equal(captured.calls.length, 1);
  assert.equal(result.ok, false); assert.match(result.error ?? '', /token budget/);
  assert.ok((result.budgetTokens ?? 0) > 0);
  const body = JSON.parse(String(captured.calls[0]?.init?.body));
  assert.equal(body.max_tokens, 600);
});

test('官方 OpenAI 制卡请求使用 max_completion_tokens，usage 计入预算', async () => {
  const captured = captureFetch(async () => jsonResponse({ choices: [{ message: { content: '{"items":[]}' } }], usage: { prompt_tokens: 90, completion_tokens: 10 } }));
  const { service } = makeService(captured.fetchImpl);
  seed(service, { baseUrl: 'https://api.openai.com/v1' });
  service.setApiKey('p1', 'sk-test');
  const result = await service.complete({ profileId: 'p1', user: 'JSON', tool: harnessSubmissionTool('card'), maxOutputTokens: 800, tokenAllowance: 10000 });
  assert.equal(result.ok, true); assert.equal(result.budgetTokens, 100);
  assert.equal(JSON.parse(String(captured.calls[0]?.init?.body)).max_completion_tokens, 800);
});

test('length 响应保留最终答案片段和实际用量，不把推理内容当作卡片', async () => {
  const partial = '{"items":[{"id":"猫","meaning":"猫"},{"id":';
  const captured = captureFetch(async () => jsonResponse({ choices: [{ finish_reason: 'length', message: { content: partial, reasoning_content: 'private reasoning' } }],
    usage: { prompt_tokens: 100, completion_tokens: 32768 } }));
  const { service } = makeService(captured.fetchImpl); seed(service, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }); service.setApiKey('p1', 'sk-test');
  const result = await service.complete({ profileId: 'p1', system: '只输出 JSON', user: '[]', tool: harnessSubmissionTool('card'), maxOutputTokens: 32768 });
  assert.equal(result.ok, false); assert.equal(result.truncatedText, partial); assert.equal(result.usage!.completionTokens, 32768);
  const body = JSON.parse(String(captured.calls[0]!.init!.body));
  assert.match(body.messages[0].content, /schema/); assert.match(body.messages[0].content, /"properties"/);
});

test('工具响应截断仅恢复指定工具参数，未知工具不泄漏成有效片段', async () => {
  let name: string = HARNESS_TOOL_NAME;
  const captured = captureFetch(async () => jsonResponse({ choices: [{ finish_reason: 'length', message: {
    content: '{"items":[{"id":"伪造"}]}', tool_calls: [{ type: 'function', function: { name, arguments: '{"items":[' } }] } }] }));
  const { service } = makeService(captured.fetchImpl); seed(service); service.setApiKey('p1', 'sk-test');
  const request = { profileId: 'p1', system: 'JSON', user: '[]', tool: harnessSubmissionTool('card'), maxOutputTokens: 32768 };
  assert.equal((await service.complete(request)).truncatedText, '{"items":[');
  name = 'unknown' as typeof name;
  assert.equal((await service.complete(request)).truncatedText, '');
});

test('settings: 读盘时去掉 baseUrl 末尾斜杠，空白 prompt 回退默认', () => {
  // 手写文件而不是走 update：这条测的是「用户/旧版本写下的文件」怎么被解读。
  const { service, file } = makeService();
  fs.writeFileSync(
    file,
    JSON.stringify({
      profiles: [
        { id: 'a', name: 'A', baseUrl: 'http://127.0.0.1:8080/v1/', model: 'm', temperature: 0.2, apiKey: 'k' },
      ],
      activeProfileId: 'a',
      prompt: '   ',
    }),
    'utf8',
  );
  const settings = service.settings();
  assert.equal(settings.profiles[0]?.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(settings.prompt, DEFAULT_LLM_PROMPT);
});

test('settings: 永远不返回 apiKey（只给 hasApiKey）', () => {
  const { service } = makeService();
  seed(service);
  service.setApiKey('p1', 'sk-secret-123');
  const settings = service.settings();
  assert.equal(settings.profiles[0]?.hasApiKey, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(settings.profiles[0], 'apiKey'),
    false,
    '公共形状里不许有 apiKey 字段',
  );
  assert.ok(!JSON.stringify(settings).includes('sk-secret-123'), '序列化后也不许出现明文 key');
});

test('setApiKey: 存 key 后 hasApiKey 为 true，传 null / 空串就删掉', () => {
  const { service } = makeService();
  seed(service);

  assert.equal(service.setApiKey('p1', '  sk-abc  ').profiles[0]?.hasApiKey, true, '存 key 时要去空白');
  assert.equal(service.setApiKey('p1', null).profiles[0]?.hasApiKey, false);
  assert.equal(service.setApiKey('p1', 'sk-abc').profiles[0]?.hasApiKey, true);
  assert.equal(service.setApiKey('p1', '   ').profiles[0]?.hasApiKey, false, '纯空白等于删除');
  // 重启后再读一遍：删掉的状态必须真的落盘，而不是只在内存里。
  assert.equal(service.settings().profiles[0]?.hasApiKey, false);
});

test('update: LLM 配置与 Key 一次保存；后续未传 Key 时保留，显式 null 时清除', () => {
  const { service } = makeService();
  const profile: LlmProfile = {
    id: 'atomic', name: '原子配置', baseUrl: 'https://api.example.com/v1',
    model: 'model-1', temperature: 0.5, hasApiKey: false,
  };
  const created = service.update({ profiles: [{ ...profile, apiKey: 'sk-once' }] });
  assert.equal(created.profiles[0]?.hasApiKey, true);
  assert.ok(!JSON.stringify(created).includes('sk-once'));

  const edited = service.update({ profiles: [{ ...profile, model: 'model-2' }] });
  assert.equal(edited.profiles[0]?.hasApiKey, true);
  assert.equal(edited.profiles[0]?.model, 'model-2');
  const cleared = service.update({ profiles: [{ ...profile, apiKey: null }] });
  assert.equal(cleared.profiles[0]?.hasApiKey, false);
});

test('update: 已存配置名称固定，改模型不会把已存的 key 冲掉', () => {
  const { service } = makeService();
  const profile = seed(service);
  service.setApiKey('p1', 'sk-keep');
  // 渲染进程手里的 profile 没有 apiKey（只有 hasApiKey），覆盖式写入不能因此丢掉它。
  service.update({ profiles: [{ ...profile, name: '新名字', model: 'qwen3' }] });
  const settings = service.settings();
  assert.equal(settings.profiles[0]?.name, profile.name);
  assert.equal(settings.profiles[0]?.model, 'qwen3');
  assert.equal(settings.profiles[0]?.hasApiKey, true);
});

test('update: 丢掉没有 id 的配置，同 id 只留第一条', () => {
  const { service } = makeService();
  const base: LlmProfile = {
    id: 'x',
    name: '一',
    baseUrl: 'https://a/v1',
    model: 'm',
    temperature: 0.3,
    hasApiKey: false,
  };
  const settings = service.update({
    profiles: [{ ...base, id: '   ' }, base, { ...base, name: '二' }],
  });
  assert.equal(settings.profiles.length, 1);
  assert.equal(settings.profiles[0]?.name, '一');
});

test('update: activeProfileId 指向已删除的配置 → 落到第一套；全删光就是 null', () => {
  const { service } = makeService();
  const p1: LlmProfile = {
    id: 'p1',
    name: '一',
    baseUrl: 'https://a/v1',
    model: 'm1',
    temperature: 0.3,
    hasApiKey: false,
  };
  const p2: LlmProfile = { ...p1, id: 'p2', name: '二', model: 'm2' };
  service.update({ profiles: [p1, p2], activeProfileId: 'p2' });

  const pruned = service.update({ profiles: [p1] });
  assert.equal(pruned.activeProfileId, 'p1', '选中的那套没了就要落到还存在的第一套');

  assert.equal(service.update({ profiles: [] }).activeProfileId, null);
});

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

test('renderPrompt: 每一处 {{word}} 都被替换（不是只换第一个）', () => {
  const rendered = renderPrompt('查 {{word}}，再看 {{word}}。', { word: '猫', context: '' });
  assert.equal(rendered, '查 猫，再看 猫。');
});

test('renderPrompt: 空 context 变成（无上下文），不留悬空占位符', () => {
  const rendered = renderPrompt('上下文：{{context}}', { word: '猫', context: '' });
  assert.equal(rendered, '上下文：（无上下文）');
  assert.ok(!rendered.includes('{{context}}'));
});

test('renderPrompt: word 与 context 都给了之后没有任何占位符残留', () => {
  const rendered = renderPrompt(DEFAULT_LLM_PROMPT, { word: '猫', context: '猫が好き' });
  assert.ok(rendered.includes('猫が好き'));
  assert.ok(!/\{\{|\}\}/.test(rendered), `不该残留占位符：${rendered}`);
});

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

test('analyze: 没有任何配置 → 失败并告诉用户去哪加一套', async () => {
  const { service } = makeService();
  const result = await service.analyze({ word: '猫', context: '' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /设置 → LLM/);
});

test('analyze: 正常路径的 URL / 方法 / 头 / body 都对', async () => {
  const captured = captureFetch(async () => jsonResponse({ choices: [{ message: { content: '# 猫\nねこ' } }] }));
  const { service } = makeService(captured.fetchImpl);
  seed(service);
  service.setApiKey('p1', 'sk-test');

  const result = await service.analyze({ word: '猫', context: '猫がいる' });
  assert.equal(result.ok, true);
  assert.equal(result.text, '# 猫\nねこ');
  assert.equal(result.profileName, '本地 Qwen');
  assert.equal(result.model, 'qwen2.5');

  assert.equal(captured.calls.length, 1);
  const call = captured.calls[0]!;
  assert.equal(call.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(call.init?.method, 'POST');
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get('Authorization'), 'Bearer sk-test');
  assert.equal(headers.get('Content-Type'), 'application/json');

  const body = JSON.parse(String(call.init?.body)) as {
    model: string;
    temperature: number;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, 'qwen2.5');
  assert.equal(body.temperature, 0.3);
  assert.equal(body.messages[0]?.role, 'user');
  assert.ok(body.messages[0]?.content.includes('猫'), '提示词里要带上要查的词');
  assert.ok(body.messages[0]?.content.includes('猫がいる'), '上下文也要进提示词');
});

test('complete: Harness 使用指定配置、系统提示和低温度，密钥不进入返回值', async () => {
  const captured = captureFetch(async () => jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }));
  const { service } = makeService(captured.fetchImpl);
  seed(service);
  service.setApiKey('p1', 'sk-harness');
  const result = await service.complete({ profileId: 'p1', system: '只返回 JSON', user: '猫がいる', temperature: 0.1 });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes('sk-harness'), false);
  const body = JSON.parse(String(captured.calls[0]?.init?.body)) as { temperature: number; messages: Array<{ role: string; content: string }> };
  assert.equal(body.temperature, 0.1);
  assert.deepEqual(body.messages.map((item) => item.role), ['system', 'user']);
  assert.equal(body.messages[1]?.content, '猫がいる');
});

test('complete: 强制调用提交工具，读取 tool_calls 的参数作为 Harness 结果', async () => {
  const args = JSON.stringify({ items: [{ id: '猫', decision: 'keep', reason: '常见词' }] });
  const captured = captureFetch(async () => jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: HARNESS_TOOL_NAME, arguments: args } }] } }] }));
  const { service } = makeService(captured.fetchImpl);
  seed(service, { baseUrl: 'http://127.0.0.1:8080/v1' });
  const result = await service.complete({ system: '筛选', user: '猫', tool: harnessSubmissionTool('filter') });
  assert.equal(result.ok, true);
  assert.equal(result.text, args);
  const body = JSON.parse(String(captured.calls[0]?.init?.body)) as Record<string, any>;
  assert.equal(body.tools[0].function.name, HARNESS_TOOL_NAME);
  assert.equal(body.tools[0].function.strict, true);
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: HARNESS_TOOL_NAME } });
});

test('complete: DeepSeek 标准地址直接使用 JSON Output，保留默认 thinking 并记录缓存 token', async () => {
  const captured = captureFetch(async () => jsonResponse({
    choices: [{ finish_reason: 'stop', message: { content: '{"items":[]}' } }],
    usage: { prompt_tokens: 120, completion_tokens: 18, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 56 },
  }));
  const { service } = makeService(captured.fetchImpl);
  seed(service, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  service.setApiKey('p1', 'sk-test');
  const result = await service.complete({ user: '[]', system: '只输出 JSON', tool: harnessSubmissionTool('filter') });
  const body = JSON.parse(String(captured.calls[0]?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(body['response_format'], { type: 'json_object' });
  assert.equal(body['tools'], undefined);
  assert.equal(body['thinking'], undefined, '不应为迁就工具而关闭 DeepSeek 默认 thinking');
  assert.equal(result.responseMode, 'json_object');
  assert.equal(result.httpAttempts, 1);
  assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 18, cacheHitTokens: 64, cacheMissTokens: 56 });
});

test('complete: OpenAI 官方地址优先使用严格 JSON Schema', async () => {
  const captured = captureFetch(async () => jsonResponse({ choices: [{ message: { content: '{"items":[]}' } }] }));
  const { service } = makeService(captured.fetchImpl);
  seed(service, { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' });
  service.setApiKey('p1', 'sk-test');
  const tool = harnessSubmissionTool('filter');
  const result = await service.complete({ user: '[]', system: 'JSON', tool });
  const body = JSON.parse(String(captured.calls[0]?.init?.body)) as Record<string, any>;
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema, tool.parameters);
  assert.equal(result.responseMode, 'json_schema');
});

test('complete: JSON Schema 被拒后可降到工具协议', async () => {
  const args = '{"items":[]}';
  const captured = captureFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body['response_format']) return new Response('{"error":"response_format json_schema unsupported"}', { status: 400 });
    return jsonResponse({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: HARNESS_TOOL_NAME, arguments: args } }] } }] });
  });
  const { service } = makeService(captured.fetchImpl);
  seed(service, { baseUrl: 'https://api.openai.com/v1', model: 'legacy-model' });
  service.setApiKey('p1', 'sk-test');
  const result = await service.complete({ user: '[]', tool: harnessSubmissionTool('filter') });
  assert.equal(result.text, args);
  assert.equal(result.responseMode, 'tool');
  assert.equal(result.httpAttempts, 2);
  assert.equal(result.fallbackCount, 1);
});

test('complete: 兼容端点拒绝工具后改用 JSON Output，后续沿用并持久记住能力', async () => {
  const captured = captureFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return body['tools']
      ? new Response('{"error":"tool_choice unsupported"}', { status: 400 })
      : jsonResponse({ choices: [{ message: { content: '{"items":[]}' } }] });
  });
  const { service, file } = makeService(captured.fetchImpl);
  seed(service, { baseUrl: 'http://127.0.0.1:8080/v1' });
  service.setApiKey('p1', 'sk-capability-secret');
  const tool = harnessSubmissionTool('filter');
  assert.equal((await service.complete({ user: 'a', tool })).text, '{"items":[]}');
  const restarted = new LlmService({ settingsFile: file, fetchImpl: captured.fetchImpl });
  assert.equal((await restarted.complete({ user: 'b', tool })).text, '{"items":[]}');
  assert.equal(captured.calls.length, 3);
  assert.ok(JSON.parse(String(captured.calls[0]?.init?.body)).tools);
  assert.deepEqual(JSON.parse(String(captured.calls[1]?.init?.body)).response_format, { type: 'json_object' });
  assert.deepEqual(JSON.parse(String(captured.calls[2]?.init?.body)).response_format, { type: 'json_object' });
  const capabilities = fs.readFileSync(path.join(path.dirname(file), 'llm-output-capabilities.json'), 'utf8');
  assert.ok(!capabilities.includes('sk-capability-secret') && !capabilities.includes('127.0.0.1'), '能力缓存只存指纹与模式');
});

test('complete: 端点连 JSON Output 也不支持时才退到提示词 JSON；401 不回退', async () => {
  const captured = captureFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body['tools']) return new Response('{"error":"tool_choice unsupported"}', { status: 400 });
    if (body['response_format']) return new Response('{"error":"response_format unsupported"}', { status: 400 });
    return jsonResponse({ choices: [{ message: { content: '{"items":[]}' } }] });
  });
  const { service } = makeService(captured.fetchImpl);
  seed(service, { baseUrl: 'http://127.0.0.1:8080/v1' });
  const result = await service.complete({ user: '[]', tool: harnessSubmissionTool('filter') });
  assert.equal(result.ok, true);
  assert.equal(result.responseMode, 'plain');
  assert.equal(result.httpAttempts, 3);
  assert.equal(result.fallbackCount, 2);
  const unauthorized = captureFetch(async () => new Response('{"error":"invalid key"}', { status: 401 }));
  const other = makeService(unauthorized.fetchImpl).service;
  seed(other, { baseUrl: 'http://127.0.0.1:8080/v1' });
  const denied = await other.complete({ user: '[]', tool: harnessSubmissionTool('filter') });
  assert.equal(denied.ok, false);
  assert.equal(denied.httpAttempts, 1);
  assert.equal(unauthorized.calls.length, 1);
});

test('complete: JSON Output 偶发空内容只重试一次，不把空批次当成成功', async () => {
  let count = 0;
  const captured = captureFetch(async () => {
    count += 1;
    return jsonResponse({ choices: [{ message: { content: count === 1 ? '' : '{"items":[]}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: count === 1 ? 0 : 5, prompt_cache_miss_tokens: count === 1 ? 10 : 5 } });
  });
  const { service } = makeService(captured.fetchImpl);
  seed(service, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  service.setApiKey('p1', 'sk-test');
  const result = await service.complete({ user: '[]', tool: harnessSubmissionTool('filter') });
  assert.equal(result.text, '{"items":[]}');
  assert.equal(result.httpAttempts, 2);
  assert.equal(result.fallbackCount, 0);
  assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 4, cacheHitTokens: 5, cacheMissTokens: 15 });
});

test('complete: 后台任务锁定的模型配置变化后停止，不混用新模型', async () => {
  const captured = captureFetch(async () => jsonResponse({ choices: [{ message: { content: '{"items":[]}' } }] }));
  const { service } = makeService(captured.fetchImpl);
  const profile = seed(service, { baseUrl: 'http://127.0.0.1:8080/v1' });
  const signature = service.profileSignature(profile.id);
  service.update({ profiles: [{ ...profile, model: 'another-model' }] });
  const result = await service.complete({ user: '[]', tool: harnessSubmissionTool('filter'), expectedProfileSignature: signature ?? undefined });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /配置已变化/);
  assert.equal(captured.calls.length, 0);
});

test('complete: 其它工具名不会被当作制卡结果', async () => {
  const captured = captureFetch(async () => jsonResponse({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'delete_files', arguments: '{"items":[]}' } }] } }] }));
  const { service } = makeService(captured.fetchImpl);
  seed(service, { baseUrl: 'http://127.0.0.1:8080/v1' });
  const result = await service.complete({ user: 'a', tool: harnessSubmissionTool('filter') });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /未知工具/);
});

test('complete: 多任务共用服务时全局最多四个在途请求', async () => {
  let active = 0;
  let peak = 0;
  const captured = captureFetch(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });
  const { service } = makeService(captured.fetchImpl);
  seed(service, { baseUrl: 'http://127.0.0.1:8080/v1' });
  const results = await Promise.all(Array.from({ length: 8 }, () => service.complete({ user: 'test' })));
  assert.ok(results.every((item) => item.ok));
  assert.equal(peak, 4);
});

test('complete: 取消信号会终止进行中的 Harness 请求', async () => {
  const captured = captureFetch(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const { service } = makeService(captured.fetchImpl);
  seed(service);
  service.setApiKey('p1', 'sk-test');
  const controller = new AbortController();
  const pending = service.complete({ system: 'JSON', user: '猫', signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(captured.calls.length, 1);
});

test('analyze: 远端地址没 key → 失败且说明缺 key，不发请求', async () => {
  const captured = captureFetch(async () => {
    throw new Error('不该发出请求');
  });
  const { service } = makeService(captured.fetchImpl);
  seed(service);

  const result = await service.analyze({ word: '猫', context: '' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /API key/);
  assert.equal(captured.calls.length, 0, '缺 key 时不该联网');
});

test('analyze: 本地地址没 key 也能成功，且不带 Authorization', async () => {
  const captured = captureFetch(async () => jsonResponse({ choices: [{ message: { content: '本地答案' } }] }));
  const { service } = makeService(captured.fetchImpl);
  seed(service, { id: 'local', name: 'Llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' });

  const result = await service.analyze({ word: '猫', context: '' });
  assert.equal(result.ok, true);
  assert.equal(result.text, '本地答案');
  assert.equal(captured.calls[0]?.url, 'http://127.0.0.1:8080/v1/chat/completions');
  const headers = new Headers(captured.calls[0]?.init?.headers);
  assert.equal(headers.get('Authorization'), null, '本地服务不该被塞一个空的 Bearer');
});

test('analyze: HTTP 401 → 失败里带状态码与响应片段', async () => {
  const captured = captureFetch(async () => new Response('{"error":"invalid api key"}', { status: 401 }));
  const { service } = makeService(captured.fetchImpl);
  seed(service);
  service.setApiKey('p1', 'sk-bad');

  const result = await service.analyze({ word: '猫', context: '' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /401/);
  assert.match(result.error ?? '', /invalid api key/, '响应片段要带上，否则用户查不出模型名写错');
});

test('analyze: choices[0].message.content 缺失 → 失败并带上响应片段', async () => {
  const captured = captureFetch(async () => jsonResponse({ error: { message: 'model not found' } }));
  const { service } = makeService(captured.fetchImpl);
  seed(service);
  service.setApiKey('p1', 'sk-test');

  const result = await service.analyze({ word: '猫', context: '' });
  assert.equal(result.ok, false);
  assert.ok((result.error ?? '').length > 0);
  assert.match(result.error ?? '', /model not found/);
});

test('analyze: fetch 直接拒绝（断网）→ ok:false 而不是抛', async () => {
  const captured = captureFetch(async () => {
    throw new TypeError('fetch failed');
  });
  const { service } = makeService(captured.fetchImpl);
  seed(service);
  service.setApiKey('p1', 'sk-test');

  // 先拿到 promise 再断言「不拒绝」：直接 await 的话，这里挂了就是未捕获拒绝，
  // 断言反而看不到真正的失败原因。
  const pending = service.analyze({ word: '猫', context: '' });
  await assert.doesNotReject(() => pending);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /fetch failed/);
});

test('默认提示词要求舶来语给出语源', () => {
  // 这条是需求：外来語（舶来语）光给中文释义不够，必须说明来自哪种语言、原词是什么。
  // 钉住它是为了防止以后有人「顺手精简提示词」把这条删掉——那是个功能性的回归。
  assert.match(DEFAULT_LLM_PROMPT, /舶来语|外来語/);
  assert.match(DEFAULT_LLM_PROMPT, /哪种语言|原词/);
  // 两个占位符都还得在，否则渲染出来会缺信息。
  assert.ok(DEFAULT_LLM_PROMPT.includes('{{word}}'));
  assert.ok(DEFAULT_LLM_PROMPT.includes('{{context}}'));
});

test('没编辑过的旧默认提示词会升级到新默认（否则改默认对老用户完全无效）', () => {
  // 这是用户实际遇到的问题：演示实例里存着一份旧 prompt，代码里的舶来语条款
  // 永远到不了他那儿，而界面上看不出任何区别。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-llm-upgrade-'));
  const file = path.join(dir, 'llm.json');
  try {
    // 手工写一份「旧默认」——必须与 LEGACY_LLM_PROMPTS 里的那份逐字一致。
    fs.writeFileSync(
      file,
      JSON.stringify({ profiles: [], activeProfileId: null, prompt: LEGACY_LLM_PROMPTS[0] }),
      'utf8',
    );
    const service = new LlmService({ settingsFile: file });
    assert.equal(service.settings().prompt, DEFAULT_LLM_PROMPT, '没编辑过 → 应升级');

    // 用户真改过的不能被覆盖。
    fs.writeFileSync(
      file,
      JSON.stringify({ profiles: [], activeProfileId: null, prompt: '我自己写的提示词' }),
      'utf8',
    );
    const kept = new LlmService({ settingsFile: file });
    assert.equal(kept.settings().prompt, '我自己写的提示词', '编辑过 → 一个字符都不能动');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
