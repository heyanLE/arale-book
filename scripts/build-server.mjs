import {build} from 'esbuild';
await build({entryPoints:['server/src/main.ts'],outfile:'dist-server/main.mjs',bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',sourcemap:true});
