/** Exercise the browser-only service adapter and shared protocols without paid calls. */
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';

const bundle = await build({ entryPoints: ['src/renderer/lib/tauri-services.ts'], bundle: true,
  write: false, format: 'esm', platform: 'browser', target: 'chrome130',
  alias: { '@core': resolve('src/core'), '@shared': resolve('src/shared') } });
const { TauriServices } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const tool = { name: 'submit_cards', description: 'Submit', parameters: { type: 'object', properties: { items: { type: 'array' } } } };
function fixture(handler) {
  const profile = {id:'one',name:'test',baseUrl:'http://localhost:1234/v1',model:'test',temperature:0.3,apiKey:'__arale_native_credential__'};
  let records = {};
  const requests = [], cancelled = [];
  const native = async (channel, ...args) => {
    if (channel === 'service:load') return {settings:{profiles:[profile],activeProfileId:'one',prompt:'word {{word}} / {{context}}'},revision:'revision',signatures:{one:'signature'},capabilities:records};
    if (channel === 'service:capabilities') { records=structuredClone(args[1]); return; }
    if (channel === 'service:cancel') { cancelled.push(args[0]); return; }
    if (channel !== 'service:http') throw Error(channel);
    const request = args[0]; requests.push(request);
    return handler(request, requests.length, cancelled);
  };
  return { adapter:new TauriServices(native), requests, profile, cancelled, capabilities:()=>records };
}
const response = (data, status=200) => ({body:JSON.stringify(data),status,headers:{},url:'http://localhost:1234/v1/chat/completions'});
const content = (text, finish_reason='stop') => response({choices:[{message:{content:text},finish_reason}],usage:{prompt_tokens:20,completion_tokens:10,prompt_tokens_details:{cached_tokens:12}}});

{
  const f=fixture((_request,n)=>n===1?response({error:'tools unsupported'},400):content('{"items":[]}'));
  const result=await f.adapter.request('llm:complete',[{system:'system',user:'user',tool,maxOutputTokens:2000,tokenAllowance:10000}]);
  assert.equal(result.ok,true); assert.equal(result.responseMode,'json_object'); assert.equal(result.fallbackCount,1);
  assert.equal(result.httpAttempts,2); assert.equal(result.usage.cacheHitTokens,12);
  const first=JSON.parse(f.requests[0].body), second=JSON.parse(f.requests[1].body);
  assert.equal(first.max_tokens,2000); assert.equal(first.tool_choice.function.name,tool.name);
  assert.equal(second.response_format.type,'json_object'); assert.match(second.messages[0].content,/schema/);
  const again=await f.adapter.request('llm:complete',[{user:'another',tool}]);
  assert.equal(again.httpAttempts,1); assert.equal(JSON.parse(f.requests[2].body).response_format.type,'json_object');
  assert.equal(Object.values(f.capabilities())[0].mode,'json_object');
  console.log('ok Worker structured-output fallback, capability persistence, budget and cache usage');
}
{
  const f=fixture(()=>content('{"items":[','length'));
  const result=await f.adapter.request('llm:complete',[{user:'user',tool,maxOutputTokens:2000}]);
  assert.equal(result.ok,false); assert.equal(result.truncatedText,'{"items":['); assert.equal(result.budgetTokens,30);
  assert.match(result.error,/token limit/); assert.equal(result.usage.completionTokens,10);
  console.log('ok Worker preserves truncation, partial submission and actual usage');
}
{
  let active=0, peak=0;
  const f=fixture(async ()=>{active++;peak=Math.max(peak,active);await delay(30);active--;return content('ok');});
  const results=await Promise.all(Array.from({length:8},()=>f.adapter.request('llm:analyze',[{word:'猫',context:'猫です。'}])));
  assert.equal(peak,4); assert.equal(results.filter(r=>r.ok).length,8);
  assert.equal(JSON.parse(f.requests[0].body).messages[0].content,'word 猫 / 猫です。');
  console.log('ok one Worker semaphore limits eight calls to four in flight and retains prompt');
}
{
  const f=fixture(async (request,_n,cancelled)=>{while(!cancelled.includes(request.id))await delay(1);return {aborted:true};});
  const controller=new AbortController();
  const pending=f.adapter.request('llm:complete',[{user:'user',signal:controller.signal}]);
  while(!f.requests.length)await delay(1);controller.abort();
  const result=await pending;assert.equal(result.ok,false);assert.match(result.error,/已取消/);assert.equal(f.cancelled.length,1);
  console.log('ok Worker AbortSignal reaches native cancellation');
}
{
  const f=fixture(async ()=>{throw Error('network failed');});
  const result=await f.adapter.request('llm:analyze',[{word:'猫',context:''}]);
  assert.equal(result.ok,false);assert.match(result.error,/network failed/);
  console.log('ok Worker network failure stays a structured result');
}
{
  const f=fixture(()=>content('must not be called'));
  const result=await f.adapter.request('translation:translate',[{profileId:'one',text:'猫',expectedProfileSignature:'stale'}]);
  assert.equal(result.ok,false);assert.match(result.error,/配置已变化/);assert.equal(f.requests.length,0);
  console.log('ok stale study signature stops before translation HTTP');
}
console.log('Tauri service adapter: 6/6 passed');
