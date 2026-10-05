import { sha256 } from '@noble/hashes/sha2.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
/** The same SHA digests on Node and in workers; no platform IO. */
export function createHash(algorithm: 'sha256' | 'sha1') {
  const chunks: Uint8Array[] = [];
  return {
    update(value: string | Uint8Array) { chunks.push(typeof value === 'string' ? new TextEncoder().encode(value) : value); return this; },
    digest(encoding: 'hex' | 'base64url'): string {
      const input=new Uint8Array(chunks.reduce((size,value)=>size+value.length,0));let offset=0;
      for(const chunk of chunks){input.set(chunk,offset);offset+=chunk.length;}
      const bytes=(algorithm==='sha256'?sha256:sha1)(input);
      return encoding==='hex'?bytesToHex(bytes):btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    },
  };
}
export const randomUUID = () => globalThis.crypto.randomUUID();
