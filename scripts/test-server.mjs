/** Isolated real-HTTP server + native client integration; never opens the user's library. */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { zipSync } from 'fflate';
await mkdir('.tmp/server-test',{recursive:true});
await build({entryPoints:['server/src/app.ts'],bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',outfile:'.tmp/server-test/app.mjs'});
const {createServer}=await import(resolve('.tmp/server-test/app.mjs')+'?'+Date.now());
const root=await mkdtemp(join(tmpdir(),'arale-server-'));
const library=join(root,'library'),data=join(root,'data'),engine=join(root,'engine');
await mkdir(join(library,'Sample'),{recursive:true});await mkdir(engine,{recursive:true});
const bytes=await readFile('samples/ocr-fixture.png');
await writeFile(join(library,'Sample','10.png'),bytes);await writeFile(join(library,'Sample','2.png'),bytes);
const token='isolated-server-test-token';
await writeFile(join(engine,'extension.json'),JSON.stringify({kind:'ocr-engine',provides:'arale_onnx_v1',version:'test',runner:{program:process.execPath,args:[join(engine,'runner.mjs'),'{pagesFile}']}}));
await writeFile(join(engine,'runner.mjs'),`import {readFile,appendFile} from 'node:fs/promises';
const {pages}=JSON.parse(await readFile(process.argv[2],'utf8'));
for(const p of pages){await new Promise(r=>setTimeout(r,300));console.log(JSON.stringify({kind:'page',file:p.rel,ok:true,width:p.width,height:p.height,lines:[{text:'猫と日本語',box:[10,10,70,150],vertical:true,confidence:1}]}));}
`);
const options={data,library,extractor:resolve('native/arale-native/target/release/arale-native'),token,ocrManifest:process.argv.includes('--real')?resolve('engines/arale_onnx_v1/build/dev-darwin-arm64/extension.json'):join(engine,'extension.json')};
let service;
let checks=0;
const ok=message=>{checks++;console.log('ok '+message);};
async function start(){service=await createServer(options);await service.waitForScan();await service.app.listen({host:'127.0.0.1',port:0});return service.app.listeningOrigin;}
let url;
async function api(path,method='GET',body,auth=token){const response=await fetch(url+path,{method,headers:{Authorization:'Bearer '+auth,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const text=await response.text();return {status:response.status,value:JSON.parse(text||'null')};}
async function until(predicate,timeout=240000){const start=Date.now();while(Date.now()-start<timeout){const result=await predicate();if(result)return result;await new Promise(r=>setTimeout(r,150));}throw new Error('Timed out');}
try{
  url=await start();
  assert.equal((await api('/api/v1/books','GET',undefined,'wrong')).status,401);ok('API rejects missing/incorrect credentials');
  const info=(await api('/api/v1/info')).value;assert.equal(info.apiVersion,1);assert.ok(info.serverId);ok('versioned API and stable server identity');
  let books=(await api('/api/v1/books')).value.books;assert.equal(books.length,1);const book=books[0];assert.equal(book.pageCount,2);assert.equal('dir' in book,false);
  assert.deepEqual(book.pages.map(p=>p.url),['pages/000001.png','pages/000002.png']);ok('image folders indexed into immutable, naturally sorted page manifests');
  const compact=(await api('/api/v1/catalog')).value;assert.equal(info.capabilities.catalog,true);assert.equal(compact.books[0].pages,undefined);assert.deepEqual(compact.books[0].coverPage,book.pages[0]);assert.equal(compact.books[0].pageCount,2);
  const unchanged=(await api('/api/v1/catalog?revision='+compact.revision)).value;assert.equal(unchanged.unchanged,true);assert.equal(unchanged.books,undefined);ok('compact conditional catalogue omits page manifests');
  const asset=await fetch(`${url}/api/v1/books/${book.id}/pages/${book.pages[0].id}?revision=${book.revision}`,{headers:{Authorization:'Bearer '+token}});assert.equal(asset.status,200);assert.deepEqual(Buffer.from(await asset.arrayBuffer()),bytes);ok('authenticated real HTTP image bytes match original');
  assert.equal((await api(`/api/v1/books/${book.id}/pages/${book.pages[0].id}?revision=stale`)).status,409);assert.equal((await api(`/api/v1/books/${book.id}/pages/not-a-page`)).status,404);ok('stale revisions and arbitrary image paths rejected');
  let layer=(await api(`/api/v1/books/${book.id}/ocr`)).value;assert.equal(layer.layer.pages[0].url,book.pages[0].url);ok('empty text layers use desktop manga parser schema');
  const progress={operationId:'first',deviceId:'device-A',baseRevision:0,contentRevision:book.revision,position:{bookId:book.id,pageIndex:1,updatedAt:1}};
  const saved=await api(`/api/v1/books/${book.id}/progress`,'PUT',progress);assert.equal(saved.status,200);assert.equal(saved.value.revision,1);
  assert.deepEqual((await api(`/api/v1/books/${book.id}/progress`,'PUT',progress)).value,saved.value);
  assert.equal((await api(`/api/v1/books/${book.id}/progress`,'PUT',{...progress,operationId:'same-position'})).value.revision,1);ok('progress writes are durable and idempotent');
  const changedProgress=(await api('/api/v1/catalog?revision='+compact.revision)).value;assert.equal(changedProgress.unchanged,true);assert.equal(changedProgress.progress[book.id].revision,1);ok('unchanged catalogue still carries latest progress');
  const stale=await api(`/api/v1/books/${book.id}/progress`,'PUT',{...progress,operationId:'second',deviceId:'device-B',position:{bookId:book.id,pageIndex:0}});assert.equal(stale.status,409);assert.equal(stale.value.current.position.pageIndex,1);ok('concurrent devices produce explicit conflict, including backwards reading');
  assert.equal((await api(`/api/v1/books/${book.id}/progress`,'PUT',{...progress,operationId:'invalid',baseRevision:1,position:{bookId:book.id,pageIndex:2}})).status,400);ok('out of range progress rejected');
  await assert.rejects(()=>createServer(options),/already used/);ok('exclusive data-directory lock rejects second server');
  // Submit via a short-lived HTTP client; the queue runs without any client/renderer.
  const queued=await new Promise((accept,reject)=>{
    const code="const response=await fetch(process.env.ARALE_TEST_URL+'/api/v1/books/'+process.env.ARALE_TEST_BOOK+'/ocr-jobs',{method:'POST',headers:{Authorization:'Bearer '+process.env.ARALE_TEST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({operationId:'ocr-one'})});const body=await response.text();process.stdout.write(body,()=>process.exit(response.ok?0:1));";
    const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,ARALE_TEST_URL:url,ARALE_TEST_BOOK:book.id,ARALE_TEST_TOKEN:token},stdio:['ignore','pipe','pipe']});
    let body='',error='';child.stdout.on('data',part=>body+=part);child.stderr.on('data',part=>error+=part);child.once('error',reject);child.once('close',status=>{if(status!==0)return reject(new Error(error||body));try{accept(JSON.parse(body));}catch(e){reject(e);}});
  });assert.ok(queued.job.id);
  assert.equal((await api(`/api/v1/books/${book.id}/ocr-jobs`,'POST',{operationId:'ocr-alias',force:true})).value.job.id,queued.job.id);
  if(!process.argv.includes('--real')){
    await until(()=>service.store.jobs().find(j=>j.id===queued.job.id&&j.done===1));
    await service.app.close();url=await start();assert.equal(service.info().serverId,info.serverId);
    ok('server restart restores interrupted job with successful page checkpoints');
  }
  const final=await until(()=>{const j=service.store.jobs().find(j=>j.id===queued.job.id);if(j?.state==='failed')throw new Error(j.error);return j?.state==='succeeded'?j:null;});assert.equal(final.done,2);
  layer=(await api(`/api/v1/books/${book.id}/ocr`)).value;assert.equal(layer.ocrRevision,1);assert.ok(layer.layer.pages.some(p=>p.blocks.length));ok((process.argv.includes('--real')?'real ONNX':'fixture runner')+' background OCR completes after submitting client has disconnected');
  assert.equal((await api(`/api/v1/books/${book.id}/ocr-jobs`,'POST',{operationId:'ocr-alias',force:true})).value.job.id,queued.job.id);ok('OCR retry aliases remain idempotent after original job completes');
  if(!process.argv.includes('--real')){const job=(await api(`/api/v1/books/${book.id}/ocr-jobs`,'POST',{operationId:'cancel-job',force:true})).value.job;await api(`/api/v1/jobs/${job.id}/cancel`,'POST',{});assert.equal(service.store.jobs().find(j=>j.id===job.id).state,'cancelled');assert.equal(service.store.book(book.id).ocrRevision,1);ok('cancelled replacement OCR retains previously published text');}
  if(process.argv.includes('--native')){
    const runNative=async(target,legacy)=>{
      const current=service.store.position(book.id);service.store.savePosition(book.id,{operationId:'native-reset-'+legacy,deviceId:'fixture',baseRevision:current.revision,contentRevision:book.revision,position:{bookId:book.id,pageIndex:1}});
      const env={...process.env,CARGO_HOME:resolve('.rust/cargo'),RUSTUP_HOME:resolve('.rust/rustup'),ARALE_TEST_SERVER_URL:target,ARALE_TEST_SERVER_TOKEN:token,ARALE_TEST_LEGACY:legacy?'1':'0'};
      await new Promise((accept,reject)=>{const child=spawn(resolve('.rust/cargo/bin/cargo'),['test','--manifest-path','src-tauri/Cargo.toml','--locked','remote_round_trip','--','--ignored','--nocapture'],{env,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?accept():reject(new Error('Native client test failed '+code)));});
    };
    await runNative(url,false);ok('two real Rust clients read/cache/sync/conflict/retry against live server');
    // An old-v1 gateway exposes the existing endpoints and omits the new capability.
    const legacy=createHttpServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const response=await fetch(url+req.url,{method:req.method,headers:{authorization:req.headers.authorization??'',...(chunks.length?{'content-type':'application/json'}:{})},body:chunks.length?Buffer.concat(chunks):undefined});let bytes=Buffer.from(await response.arrayBuffer());if(req.url==='/api/v1/info'){const info=JSON.parse(bytes);delete info.capabilities.catalog;bytes=Buffer.from(JSON.stringify(info));}res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/octet-stream'});res.end(bytes);}catch{res.writeHead(502);res.end('{}');}});
    await new Promise(resolve=>legacy.listen(0,'127.0.0.1',resolve));
    try {await runNative(`http://127.0.0.1:${legacy.address().port}`,true);ok('new clients retain progress and reading against legacy v1 endpoints');} finally {await new Promise(resolve=>legacy.close(resolve));}

  }
  const oldId=book.id;await rename(join(library,'Sample'),join(library,'Renamed'));await service.library.scan();assert.equal(service.store.books()[0].id,oldId);ok('renamed source keeps server book identity and progress');
  // An archive exercises the same native extractor deployed with the service.
  await writeFile(join(library,'Archive.cbz'),zipSync({'page.png':bytes}));const scan=await service.library.scan();assert.deepEqual(scan.errors,[]);assert.equal(service.store.books().length,2);ok('CBZ scanned through Rust extractor alongside image folder');
  await rm(join(library,'Archive.cbz'));await service.library.scan();assert.equal(service.store.books().length,1);ok('removed sources disappear without deleting progress or OCR artifacts');
  await service.app.close();service=null;url=await start();assert.equal(service.info().serverId,info.serverId);assert.equal(service.store.book(oldId).ocrRevision,1);assert.ok(service.store.position(oldId).revision>=1);ok('server identity, progress and text layers survive clean restart');
  const benchDir=join(root,'catalog-bench');await mkdir(benchDir);const bench=new service.store.constructor(benchDir);
  try {
    for(let i=0;i<15;i++){const pages=Array.from({length:200},(_,n)=>({...book.pages[0],id:'p'+n,url:`pages/${String(n).padStart(6,'0')}.png`}));bench.saveBook({...book,id:'bk_bench_'+i,pages,pageCount:pages.length},'fixture-'+i,'hash-'+i);}
    const fullBytes=Buffer.byteLength(JSON.stringify({books:bench.books()}));const compactBytes=Buffer.byteLength(JSON.stringify(bench.catalog()));
    assert.ok(compactBytes<fullBytes/20);console.log(`Catalogue fixture 15 books / 3000 pages: ${fullBytes} -> ${compactBytes} JSON bytes (${(100*(1-compactBytes/fullBytes)).toFixed(1)}% smaller; excludes images)`);ok('large catalogue payload scales with books instead of pages');
  } finally {bench.close();}
  console.log(`Server integration: ${checks}/${checks} passed (${process.platform} ${process.arch}, Node ${process.version})`);
}finally{if(service)await service.app.close();await rm(root,{recursive:true,force:true});}
