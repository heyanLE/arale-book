/** Worker adapter failure/ordering tests. No GUI, credentials or network required. */
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { strict as assert } from 'node:assert';
import { gzipSync, strToU8 } from 'fflate';
import { setTimeout as delay } from 'node:timers/promises';
const frequency=Buffer.from(gzipSync(strToU8(JSON.stringify({source:'wordfreq',version:'3.1.1',language:'ja',wordlist:'large',entries:{猫:5}})))).toString('base64');
const bundle=await build({entryPoints:['src/renderer/lib/tauri-study.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'chrome130',
  alias:{'@core':resolve('src/core'),'@shared':resolve('src/shared')},plugins:[{
    name:'test-fixture-assets',setup(build){
      build.onResolve({filter:/tauri-tokenizer$/},()=>({path:'tokenizer',namespace:'fixture'}));
      build.onResolve({filter:/\.gz\?url$/},()=>({path:'frequency',namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='frequency'?`export default 'data:application/gzip;base64,${frequency}'`:
        `export async function tokenizeJapanese(){return [{surface:'猫',lemma:'猫',reading:'ネコ',pos:'名詞',posDetail:'一般',known:true},{surface:'です',lemma:'です',pos:'助動詞',known:true},{surface:'。',lemma:'。',pos:'記号',known:true}]}`,loader:'js'}));
    },
  }]});
mkdirSync('.tmp',{recursive:true});const modulePath=resolve('.tmp/tauri-study-test.mjs');writeFileSync(modulePath,bundle.outputFiles[0].text);
const {TauriStudy}=await import(pathToFileURL(modulePath));
function fixture(){
  let owner,revision=0,list=null,queue={active:null,pending:[],recent:[]},failWrite=false,failCommit=false;
  const calls=[],leases=new Set(),cancelled=new Set();
  const profile={id:'one',name:'test',baseUrl:'http://localhost:1234/v1',model:'test',temperature:0.3,apiKey:'__arale_native_credential__'};
  const native=async (channel,...args)=>{
    calls.push({channel,args});
    if(channel==='service:load')return {settings:{profiles:[profile],activeProfileId:'one',prompt:''},revision:'service',signatures:{one:'signature'},capabilities:{}};
    if(channel==='dict:studyEvidence')return {'猫':[{expression:'猫',reading:'ねこ',glossary:['猫'],dictionaryId:'dict',dictionaryTitle:'dict',sequence:1,score:0,rules:[],termTags:[],definitionTags:[]}]};
    if(channel==='service:capabilities')return;
    if(channel==='service:cancel'){cancelled.add(args[0]);return;}
    if(channel==='service:http'){
      while(!cancelled.has(args[0].id))await delay(1);return {aborted:true};
    }
    if(channel==='study:initialize'){owner=args[0];return structuredClone(queue);}
    assert.equal(args[0],owner,'all native operations must belong to current Worker');
    switch(channel){
      case 'study:lease': if(args[2]){assert(!leases.has(args[1]));leases.add(args[1]);}else leases.delete(args[1]);return;
      case 'study:snapshot':return {book:{id:'book',format:'comic',readerMode:'comic',title:'test'},segments:{bookId:'book',generatedAt:1,units:[{ref:'page:p.png#0',text:'猫です。',label:'page',tokens:[]}],vocabulary:[]},list:structuredClone(list),revision:String(revision),source:'source',dictionary:'dict'};
      case 'study:commit':
        if(failCommit)throw Error('disk commit failed');
        assert.equal(args[2].revision,String(revision),'commits must be serialized with updated revisions');
        list=structuredClone(args[3]);return {revision:String(++revision)};
      case 'study:publish': if(args[1]==='study:queue')queue=structuredClone(args[2]);return;
      case 'study:select':return {token:'grant',path:'C:/isolated/selected.tsv'};
      case 'study:writeExport':if(failWrite)throw Error('export disk failed');return;
      case 'study:releaseExport':return;
      default:throw Error(channel);
    }
  };
  return {adapter:new TauriStudy(native),calls,leases,list:()=>structuredClone(list),queue:()=>queue,failExport:()=>{failWrite=true;},failCommit:()=>{failCommit=true;}};
}
async function until(fn){const end=Date.now()+5000;while(Date.now()<end){if(await fn())return;await delay(2);}throw Error('test timed out');}
async function generate(f) {const list=await f.adapter.request('study:generate',['book']);await f.adapter.request('study:patchMany',['book',list.candidates.map(c=>c.id),{selected:true}]);return list;}
{
  const f=fixture();const generated=await generate(f);
  assert.equal(generated.candidates[0].zipf,5);assert.equal(f.leases.size,0);
  const first=await f.adapter.request('study:runCards',['book',{tier:'A0',fields:['reading','meaning','sentence','lemma']}]);
  await until(() => f.queue().recent.some(task=>task.id===first.id));
  const list=await f.adapter.request('study:read',['book']);
  assert.equal(list.workflow.cardRun.stats.llmCalls,0);assert.equal(list.workflow.cardRun.drafts[0].meaning,'猫');
  assert.equal(f.calls.filter(c=>c.channel==='service:http').length,0);
  assert(f.calls.findIndex(c=>c.channel==='study:commit')<f.calls.findIndex(c=>c.channel==='study:publish'&&c.args[1]==='study:done'));
  console.log('ok Worker candidate/Zipf and A0 share rules; checkpoints precede done event');
}
{
  const f=fixture();await generate(f);f.failExport();
  await assert.rejects(f.adapter.request('study:export',['book']),/export disk failed/);
  assert.equal(f.list().candidates[0].exportedAt,null);assert.equal(f.leases.size,0);
  assert.equal(f.calls.filter(c=>c.channel==='study:releaseExport').length,1);
  console.log('ok failed native export preserves exportedAt and releases file/book grants');
}
{
  const f=fixture();await generate(f);f.failCommit();
  await assert.rejects(f.adapter.request('study:patch',['book',f.list().candidates[0].id,{meaning:'new'}]),/disk commit failed/);
  assert.equal(f.list().candidates[0].meaning,'猫');assert.equal(f.leases.size,0);
  console.log('ok failed checkpoint cannot expose an unpersisted edit as success');
}
{
  const f=fixture();await generate(f);await f.adapter.request('study:directFilter',['book',[1,2,3,4,5],true]);
  const request={tier:'F1',profileId:'one'},task=await f.adapter.request('study:runFilter',['book',request]);
  const same=await f.adapter.request('study:runFilter',['book',request]);assert.equal(same.id,task.id);
  await assert.rejects(f.adapter.request('study:patch',['book',f.list().candidates[0].id,{meaning:'x'}]),/已有学习任务/);
  await until(()=>f.calls.some(c=>c.channel==='service:http'));
  await f.adapter.request('study:taskCancel',[task.id]);
  await until(()=>f.queue().recent.some(t=>t.id===task.id));
  await f.adapter.request('study:taskQueue',[]);
  assert.equal(f.queue().recent[0].status,'cancelled');assert(f.calls.some(c=>c.channel==='service:cancel'));assert.equal(f.leases.size,0);
  await f.adapter.request('study:patch',['book',f.list().candidates[0].id,{meaning:'after cancel'}]);
  assert.equal(f.list().candidates[0].meaning,'after cancel');
  console.log('ok duplicate enqueue shares task; edits blocked until native HTTP cancellation and lease release');
}
{
  const f=fixture();await generate(f);
  const result=await f.adapter.request('study:manualAiExport',['book',{kind:'cards',tasksPerFile:1,fields:['reading','meaning','sentence','lemma']}]);
  const commits=f.calls.filter(c=>c.channel==='study:commit'&&c.args[3].workflow?.manualAi?.cards);
  assert.equal(commits.length,1);assert(!commits[0].args[3].workflow.manualAi.cards.directory.startsWith('export/'));
  assert.equal(result.workflow.manualAi.cards.directory,f.list().workflow.manualAi.cards.directory);
  console.log('ok manual MD session stores actual directory in its first checkpoint');
}
console.log('Tauri study adapter: 5/5 passed');
