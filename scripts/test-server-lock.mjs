import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile,utimes} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir,hostname} from 'node:os';
await mkdir('.tmp',{recursive:true});
await build({entryPoints:['server/src/lock.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:'.tmp/server-lock-test.mjs'});
const {acquireLock}=await import(resolve('.tmp/server-lock-test.mjs'));
const root=await mkdtemp(join(tmpdir(),'arale-lock-'));
try{
 let release=await acquireLock(root);await assert.rejects(()=>acquireLock(root),/already used/);await release();
 release=await acquireLock(root);await release();console.log('ok data lease rejects a second writer and releases cleanly');
 await mkdir(join(root,'runtime.lock'));await utimes(join(root,'runtime.lock'),new Date(0),new Date(0));release=await acquireLock(root);await release();console.log('ok stale empty lease recovers without relying on container hostname or PID');
 await mkdir(join(root,'runtime.lock'));await writeFile(join(root,'runtime.lock','owner.json'),JSON.stringify({pid:process.pid,host:hostname()}));await assert.rejects(()=>acquireLock(root),/legacy lock/);await rm(join(root,'runtime.lock'),{recursive:true});console.log('ok live legacy data lock is never removed');
 await mkdir(join(root,'runtime.lock'));await writeFile(join(root,'runtime.lock','owner.json'),JSON.stringify({pid:2147483647,host:hostname()}));release=await acquireLock(root);await release();console.log('ok provably dead legacy lock migrates to heartbeat lease');
 await mkdir(join(root,'runtime.lock'));await writeFile(join(root,'runtime.lock','owner.json'),JSON.stringify({pid:2147483647,host:hostname()}));
 const starts=await Promise.allSettled([acquireLock(root),acquireLock(root)]);assert.equal(starts.filter(r=>r.status==='fulfilled').length,1);for(const r of starts)if(r.status==='fulfilled')await r.value();console.log('ok concurrent legacy migrations retain exclusive ownership');
}finally{await rm(root,{recursive:true,force:true});}
