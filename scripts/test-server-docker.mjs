/** Complete isolated Compose acceptance. No user library, default project or volume is touched. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { zipSync } from 'fflate';

function arg(name, fallback) { const index=process.argv.indexOf('--'+name);return index<0?fallback:process.argv[index+1]; }
function command(program,args,{env=process.env,inherit=false}={}) {
  return new Promise((accept,reject)=>{
    const child=spawn(program,args,{env,stdio:inherit?'inherit':['ignore','pipe','pipe']});
    let output='',error='';child.stdout?.on('data',data=>output+=data);child.stderr?.on('data',data=>error+=data);
    child.once('error',reject);child.once('close',code=>code===0?accept(output):reject(new Error(`${program} ${args.slice(0,5).join(' ')} exited ${code}\n${error}\n${output}`)));
  });
}
const info=JSON.parse(await command('docker',['info','--format','{{json .}}']));
const platform=arg('platform',info.Architecture==='aarch64'?'linux/arm64':'linux/amd64');
if(!['linux/amd64','linux/arm64'].includes(platform))throw new Error('Supported platforms: linux/amd64, linux/arm64');
const arch=platform.split('/')[1];const image=arg('image','arale-server:linux-'+arch);
const project='arale-e2e-'+process.pid+'-'+randomUUID().slice(0,6);
await mkdir('.tmp/docker-validation',{recursive:true});
const root=await mkdtemp(resolve('.tmp/docker-validation/run-'+arch+'-'));
const library=join(root,'library');await mkdir(library);
const bytes=await readFile('samples/ocr-fixture.png');const checksum=createHash('sha256').update(bytes).digest('hex');
const archive=zipSync(Object.fromEntries(Array.from({length:4},(_,i)=>[`nested/${i+1}.png`,bytes])));
await writeFile(join(library,'Docker OCR sample.cbz'),archive);
const env={...process.env,ARALE_PLATFORM:platform,ARALE_IMAGE:image,ARALE_LIBRARY_DIR:library,ARALE_PORT:'0',ARALE_BIND_ADDRESS:'127.0.0.1',ARALE_UID:'1000',ARALE_GID:'1000',ARALE_OCR_THREADS:'2',ARALE_SERVER_NAME:'Isolated Docker test'};
// Never load server/.env from a user's deployment during acceptance.
const compose=['compose','--env-file','/dev/null','-p',project,'-f','server/compose.yaml'];
const dc=(...args)=>command('docker',[...compose,...args],{env});
const checks=[];const started=Date.now();let url,token,book;
const ok=name=>{checks.push(name);console.log('ok '+name);};
async function until(predicate,timeout=240000){const start=Date.now();while(Date.now()-start<timeout){try{const value=await predicate();if(value)return value;}catch(error){if(error.fatal)throw error;}await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for container workflow');}
async function endpoint(path,method='GET',body,auth=token){const response=await fetch(url+path,{method,headers:{...(auth?{Authorization:'Bearer '+auth}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});return {status:response.status,value:await response.json()};}
async function connect(){const address=(await dc('port','arale','3737')).trim().split('\n')[0];url='http://'+address;token=(await dc('exec','-T','arale','node','-e',"process.stdout.write(require('fs').readFileSync('/data/access-token','utf8'))")).trim();await until(async()=>{const state=await endpoint('/api/v1/state');return state.status===200&&!state.value.scan.running;});}
async function nativeClients(){
  const local=resolve('.rust/cargo/bin/cargo');const nativeEnv={...process.env,ARALE_TEST_SERVER_URL:url,ARALE_TEST_SERVER_TOKEN:token};
  if(existsSync(local)){nativeEnv.CARGO_HOME=resolve('.rust/cargo');nativeEnv.RUSTUP_HOME=resolve('.rust/rustup');nativeEnv.PATH=resolve('.rust/cargo/bin')+delimiter+process.env.PATH;}
  await command(existsSync(local)?local:'cargo',['test','--manifest-path','src-tauri/Cargo.toml','--locked','remote_round_trip','--','--ignored','--nocapture'],{env:nativeEnv,inherit:true});
}
try{
  if(process.argv.includes('--build'))await command('docker',['build','--platform',platform,'-t',image,'-f','server/Dockerfile','.'],{inherit:true});
  await dc('up','-d','--no-build','--wait','--wait-timeout','180');await connect();
  const runtime=(await dc('logs','--no-color','arale')).split('\n').map(line=>line.slice(line.indexOf('{'))).map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(value=>value?.kind==='runtime');
  assert.ok(runtime?.ok);assert.equal(runtime.platform,'Linux');assert.equal(runtime.arch,arch==='amd64'?'x86_64':'aarch64');assert.equal(runtime.provider,'CPUExecutionProvider');assert.equal(runtime.models,5);ok('real Linux '+arch+' Python/ONNX probe and five verified models');
  const identity=(await endpoint('/api/v1/info')).value;assert.equal(identity.capabilities.ocr,true);assert.equal((await endpoint('/api/v1/books','GET',undefined,'wrong')).status,401);ok('healthy authenticated server with OCR capability');
  book=(await endpoint('/api/v1/books')).value.books[0];assert.equal(book.pageCount,4);assert.equal(book.format,'comic');assert.ok(!('dir' in book));ok('read-only CBZ library scanned by container Linux Rust extractor');
  const response=await fetch(`${url}/api/v1/books/${book.id}/pages/${book.pages[0].id}?revision=${book.revision}`,{headers:{Authorization:'Bearer '+token}});assert.equal(response.status,200);assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),checksum);ok('remote page bytes match the original fixture');
  const progress={operationId:randomUUID(),deviceId:'docker-client-A',baseRevision:0,contentRevision:book.revision,position:{bookId:book.id,pageIndex:3}};
  const saved=await endpoint(`/api/v1/books/${book.id}/progress`,'PUT',progress);assert.equal(saved.status,200);assert.equal(saved.value.revision,1);assert.deepEqual((await endpoint(`/api/v1/books/${book.id}/progress`,'PUT',progress)).value,saved.value);
  const conflicting=await endpoint(`/api/v1/books/${book.id}/progress`,'PUT',{...progress,operationId:randomUUID(),deviceId:'docker-client-B',position:{bookId:book.id,pageIndex:0}});assert.equal(conflicting.status,409);ok('two-device progress CAS, backwards-reading conflict and idempotency');
  await dc('exec','-T','arale','node','-e',"require('proper-lockfile').lock('/data',{lockfilePath:'/data/runtime.lock',stale:15000,update:5000}).then(()=>process.exit(1)).catch(e=>process.exit(e.code==='ELOCKED'?0:2))");ok('active data directory excludes a second writer');
  const clientCode="const r=await fetch(process.env.ARALE_TEST_URL+'/api/v1/books/'+process.env.ARALE_TEST_BOOK+'/ocr-jobs',{method:'POST',headers:{Authorization:'Bearer '+process.env.ARALE_TEST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({operationId:'docker-ocr'})});process.stdout.write(await r.text(),()=>process.exit(r.ok?0:1));";
  const queued=JSON.parse(await command(process.execPath,['--input-type=module','-e',clientCode],{env:{...process.env,ARALE_TEST_URL:url,ARALE_TEST_BOOK:book.id,ARALE_TEST_TOKEN:token}}));assert.ok(queued.job.id);ok('submitting client process exits while server OCR continues');
  const checkpoint=await until(async()=>{const state=await endpoint('/api/v1/state');const job=state.value.jobs?.find(j=>j.id===queued.job.id);if(job?.state==='failed')throw Object.assign(new Error(job.error),{fatal:true});return job?.state==='running'&&job.done>0&&job.done<job.total?job:null;},600000);
  const oldContainer=(await dc('ps','-q','arale')).trim();
  await command('docker',['update','--restart=no',oldContainer]);
  await dc('kill','--signal','SIGKILL','arale');
  const stopped=JSON.parse(await command('docker',['inspect',oldContainer]))[0];assert.equal(stopped.State.ExitCode,137);
  const dataVolume=stopped.Mounts.find(m=>m.Destination==='/data').Name;assert.ok(dataVolume.startsWith(project+'_'));
  await command('docker',['run','--rm','--user','1000:1000','--mount','type=volume,source='+dataVolume+',target=/data','--entrypoint','node',image,'-e',"if(!require('fs').statSync('/data/runtime.lock').isDirectory())process.exit(1)"]);
  await dc('up','-d','--no-build','--force-recreate','--wait','--wait-timeout','180');await connect();
  assert.notEqual((await dc('ps','-q','arale')).trim(),oldContainer);assert.equal((await endpoint('/api/v1/info')).value.serverId,identity.serverId);ok('SIGKILL and container recreation retain identity, token and recover stale lease');
  const final=await until(async()=>{const state=await endpoint('/api/v1/state');const job=state.value.jobs?.find(j=>j.id===queued.job.id);if(job?.state==='failed')throw Object.assign(new Error(job.error),{fatal:true});return job?.state==='succeeded'?job:null;},900000);
  assert.ok(final.attempt>=2);assert.equal(final.done,4);assert.ok(final.blocks>0);ok('real ONNX OCR resumes persisted page checkpoints after container crash');
  const layer=(await endpoint(`/api/v1/books/${book.id}/ocr`)).value;assert.equal(layer.ocrRevision,1);assert.equal(layer.layer.pages.length,4);assert.ok(layer.layer.pages.every(p=>p.blocks.length>0));ok('completed text layer is readable through the remote API');
  assert.equal((await endpoint(`/api/v1/books/${book.id}/progress`)).value.position.pageIndex,3);ok('reading progress survives container crash');
  if(process.argv.includes('--native')){await nativeClients();ok('two existing Rust desktop clients read, sync, resolve conflicts and preserve local data');}
  const stable=await endpoint(`/api/v1/books/${book.id}/progress`);
  await dc('up','-d','--no-build','--force-recreate','--wait','--wait-timeout','180');await connect();assert.deepEqual((await endpoint(`/api/v1/books/${book.id}/progress`)).value,stable.value);assert.equal((await endpoint(`/api/v1/books/${book.id}/ocr`)).value.ocrRevision,1);assert.equal((await endpoint('/api/v1/info')).value.serverId,identity.serverId);ok('clean recreation retains library, OCR and progress');
  const autoToken=token;const secretToken='docker-secret-'+randomUUID();const secretFile=join(root,'access-token');await writeFile(secretFile,secretToken+'\n',{mode:0o444});
  const secretEnv={...env,ARALE_TOKEN_FILE:secretFile};
  await command('docker',[...compose,'-f','server/compose.secret.yaml','up','-d','--no-build','--force-recreate','--wait','--wait-timeout','180'],{env:secretEnv});
  url='http://'+(await dc('port','arale','3737')).trim().split('\n')[0];token=secretToken;
  assert.equal((await endpoint('/api/v1/info')).status,200);assert.equal((await endpoint('/api/v1/info','GET',undefined,autoToken)).status,401);
  const containerId=(await dc('ps','-q','arale')).trim();const inspect=JSON.parse(await command('docker',['inspect',containerId]));assert.ok(!JSON.stringify(inspect[0].Config.Env).includes(secretToken));ok('external Compose secret supplies the token without embedding it in image or environment');
  assert.deepEqual(await readFile(join(library,'Docker OCR sample.cbz')),Buffer.from(archive));ok('original host comic archive remains byte-for-byte unchanged');
  const report={date:new Date().toISOString(),platform,host:process.platform+'/'+process.arch,image,runtime,checkpointDone:checkpoint.done,crashExitCode:stopped.State.ExitCode,leaseVerifiedAfterCrash:true,finalAttempt:final.attempt,blocks:final.blocks,checks,elapsedSeconds:Math.round((Date.now()-started)/1000),imageInspect:JSON.parse(await command('docker',['image','inspect',image,'--format','{{json .}}'])).Id};
  await writeFile(resolve('.tmp/docker-validation/report-'+arch+'.json'),JSON.stringify(report,null,2)+'\n');console.log(`Docker integration: ${checks.length}/${checks.length} passed (${platform})`);
}catch(error){console.error(await dc('logs','--no-color','--tail','80').catch(()=>''));throw error;}
finally{await dc('down','--volumes','--remove-orphans').catch(error=>console.error(error.message));await rm(root,{recursive:true,force:true});}
