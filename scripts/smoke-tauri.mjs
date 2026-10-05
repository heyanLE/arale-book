import { createServer } from 'node:http';
/** Test the real Windows WebView2 shell through a debug-only native test entry. */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';
import { rm } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(root, 'src-tauri/target/debug/aralebook-tauri.exe');
if (process.platform !== 'win32') throw new Error('This smoke test currently targets Windows WebView2 only');
if (!existsSync(binary)) throw new Error('Build first: cargo build --manifest-path src-tauri/Cargo.toml');
if (process.env.ARALE_TAURI_SMOKE_OCR === '1' && !existsSync(join(root,'engines/arale_onnx_v1/build/dev-win32-x64/extension.json'))) throw new Error('Real ONNX smoke requires engines/arale_onnx_v1/build/dev-win32-x64');
if (!existsSync(join(root, 'dist/renderer/kuromoji/base.dat.gz'))) throw new Error('Build the Tauri renderer first: node scripts/tauri.mjs dev/build (ARALE_TAURI_BUILD=1)');
const tmpRoot = join(root, '.tmp'); mkdirSync(tmpRoot, { recursive: true });
const folder = mkdtempSync(join(tmpRoot, 'tauri-smoke-'));
const userdata = join(folder, 'userdata');
mkdirSync(userdata);
const externalName = '外部 [书];猫.cbz';
copyFileSync(join(root, 'samples/サンプル漫画 v01.cbz'), join(folder, externalName));
writeFileSync(join(userdata, 'smoke-dictionary.zip'), zipSync({
  'wrapper/index.json': strToU8(JSON.stringify({ title: 'Smoke 词典', format: 3 })),
  'wrapper/term_bank_1.json': strToU8(JSON.stringify([
    ['猫', 'ねこ', 'n', '', 10, ['猫（测试释义）<script>window.__dictInjected=1</script><img src="https://example.invalid/x" onerror="window.__dictInjected=1"><b>保留粗体</b>'], 1, ''],
    ['食べる', 'たべる', 'v1', 'v1', 5, [{ type: 'structured-content', content: { tag: 'span', content: '吃（结构化释义）' } }], 2, ''],
    ['神', 'かみ', 'n', '', 0, ['神明'], 3, ''],
    null,
  ])),
  'wrapper/term_bank_2.json': strToU8('invalid json'),
  'wrapper/media/ignored.png': new Uint8Array([0, 1, 2]),
}));
writeFileSync(join(userdata, 'smoke-frequency.zip'), zipSync({
  'index.json': strToU8(JSON.stringify({ title: 'Smoke 频率', format: 3 })),
  'term_meta_bank_1.json': strToU8(JSON.stringify([['猫', 'freq', 12], ['食べる', 'freq', { value: 25, displayValue: '25 位' }]])),
}));
writeFileSync(join(userdata, 'smoke-invalid.zip'), zipSync({ 'unrelated.json': strToU8('{}') }));
writeFileSync(join(userdata, 'smoke.epub'), zipSync({
  'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),
  'OPS/book.opf': strToU8('<package><metadata><title>Smoke EPUB</title><creator>作者</creator><language>ja</language></metadata><manifest><item id="one" href="正文%2525.xhtml" media-type="application/xhtml+xml"/><item id="two" href="chapter2.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine page-progression-direction="rtl"><itemref idref="one"/><itemref idref="two"/></spine></package>'),
  'OPS/nav.xhtml': strToU8('<html><body><nav epub:type="toc"><ol><li><a href="正文%2525.xhtml">第一章</a></li><li><a href="chapter2.xhtml">第二章</a></li></ol></nav></body></html>'),
  'OPS/正文%2525.xhtml': strToU8('<html><head><link rel="stylesheet" href="styles/main.css"/><script>window.__epubInjected=1;parent.postMessage({tag:"arale-epub-attack"},"*")</script><base href="https://example.invalid/"></head><body><p><span id="smoke-word" onclick="window.__epubInjected=1">猫</span>はここで食べました。これはテスト用の長い文章です。</p><img src="images/猫%2525.png"/><a id="smoke-link" href="chapter2.xhtml">次の章</a><iframe src="https://example.invalid/"></iframe></body></html>'),
  'OPS/chapter2.xhtml': strToU8('<html><body><p>第二章。猫と神が本を読みました。</p></body></html>'),
  'OPS/styles/main.css': strToU8('@font-face{font-family:SmokeEpub;src:url(../fonts/arial.ttf)} #smoke-word{font-family:SmokeEpub!important;background-color:rgb(1,2,3)}'),
  'OPS/images/猫%2525.png': readFileSync(join(root, 'samples/ocr-fixture.png')),
  'OPS/fonts/arial.ttf': readFileSync('C:/Windows/Fonts/arial.ttf'),
  'OPS/blocked.js': strToU8('window.__epubInjected=1'),
}));
const report = join(userdata, 'smoke-report.json');
for(const name of ['ocr-a','ocr-b','ocr-system']) writeFileSync(join(userdata,name+'.cbz'),zipSync(Object.fromEntries(Array.from({length:4},(_,i)=>[`${i}.png`,readFileSync(join(root,'samples/ocr-fixture.png'))]))));
const fakePackages=new Map();
const extensionEntry=(id,provider,delay=250)=>{
  const manifest={id,version:'1',kind:'ocr-engine',provides:provider,runner:{program:'runner.ps1',args:['{pagesFile}'],env:{}}};
  const program=`param($PagesFile)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$pages = (Get-Content -Raw -Encoding UTF8 $PagesFile | ConvertFrom-Json).pages
Write-Output '{"kind":"meta","engine":"smoke","languages":["ja-JP"],"requested":["ja-JP"]}'
foreach ($page in $pages) {
  $result = @{ kind='page'; file=$page.rel; ok=$true; width=$page.width; height=$page.height; lines=@(@{ text='猫'; box=@(10,20,40,100); confidence=1; vertical=$true },@{ text='テスト'; box=@(50,20,90,100); confidence=0.9; vertical=$true }) }
  Write-Output ($result | ConvertTo-Json -Depth 8 -Compress)
  Start-Sleep -Milliseconds ${delay}
}
`;
  const zip=zipSync({'extension.json':strToU8(JSON.stringify(manifest)),'runner.ps1':strToU8('\ufeff'+program)});
  fakePackages.set('/'+id+'.zip',zip);
  return {id,name:id,version:'1',kind:'ocr-engine',provides:provider,platforms:['win32'],arch:['x64'],urls:['https://tauri-smoke.invalid/'+id+'.zip'],bytes:zip.length,sha256:createHash('sha256').update(zip).digest('hex'),installedBytes:4000};
};
const fast=extensionEntry('ocr-smoke','arale_onnx_v1');
const slow=extensionEntry('ocr-slow','smoke_slow',5000);
const bad={...fast,id:'ocr-badhash',sha256:'0'.repeat(64)};
const wrong={...fast,id:'ocr-wrong'};
const downloadSlow={...fast,id:'ocr-download-slow',urls:['https://tauri-smoke.invalid/slow-extension.zip']};
const extensionCatalog=[fast,slow,bad,wrong,downloadSlow].map(v=>JSON.stringify(v)).join('\n');
const requests = [];
const server = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const url = new URL(req.url, 'http://localhost');
  let body; try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
  requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
  res.setHeader('Content-Type','application/json');
  const send = value => res.end(JSON.stringify(value));
  if(url.pathname==='/extension.jsonl')return res.end(extensionCatalog);
  if(fakePackages.has(url.pathname)){const bytes=fakePackages.get(url.pathname);res.setHeader('Content-Length',bytes.length);return res.end(bytes);}
  if(url.pathname==='/slow-extension.zip'){res.setHeader('Content-Length',100000);res.write('x');const timer=setTimeout(()=>res.end(),5000);res.on('close',()=>clearTimeout(timer));return;}
  if (url.pathname === '/translator') return res.end('IG:"SMOKE" data-iid="translator.5028" params_AbusePreventionHelper=[123,"temporary",600000]');
  if (url.pathname === '/ttranslatev3') return send([{translations:[{text:'Bing 测试译文'}]},{inputTransliteration:'Neko ga suki desu.'}]);
  if (url.pathname.startsWith('/microsoft/')) return send([{translations:[{text:'Microsoft 测试译文'}]}]);
  if (url.pathname.startsWith('/deepl/')) return send({translations:[{text:'DeepL 测试译文'}]});
  if (url.pathname.startsWith('/google/')) return send({data:{translations:[{translatedText:'Google &amp; 测试译文'}]}});
  if (url.pathname.startsWith('/baidu/')) return send({trans_result:[{dst:'百度测试译文'}]});
  if (url.pathname.startsWith('/libre/')) return send({translatedText:'Libre 测试译文'});
  if (url.pathname === '/v1/chat/completions') {
    if (body.model === 'slow') await delay(800);
    if (body.model === 'study-slow') await delay(3000);
    const system = body.messages?.[0]?.content ?? '';
    if (system.includes('候选筛选器') || system.includes('复核第一轮筛选') || system.includes('制作日语词卡')) {
      const input=JSON.parse(body.messages.at(-1).content), entries=Array.isArray(input)?input:input.items ?? input.candidates;
      const items=entries.map(row=> system.includes('筛选') ? {id:row.id,decision:'keep',reason:'测试保留'} :
        {id:row.id,meaning:'测试语境词义',sentenceTranslation:'测试整句译文',usage:'',nuance:'',evidenceIds:(row.dictionary ?? []).map(e=>e.id),issues:[]});
      const args=JSON.stringify({items}), name=body.tools?.[0]?.function?.name;
      const truncated=body.model==='study-truncate';
      const content=truncated?'{"items":['+JSON.stringify(items[0])+',{"id":"unfinished':args;
      return send({choices:[{message:name?{tool_calls:[{type:'function',function:{name,arguments:content}}]}:{content},finish_reason:truncated?'length':'stop'}],usage:{prompt_tokens:20,completion_tokens:10}});
    }
    return send({choices:[{message:{content:body.model === 'length' ? '{"items":[' : '### 猫\n测试词义'},finish_reason:body.model === 'length' ? 'length' : 'stop'}],usage:{prompt_tokens:20,completion_tokens:10,prompt_tokens_details:{cached_tokens:12}}});
  }
  res.statusCode=404; send({error:'Unknown test path'});
});
await new Promise(accept => server.listen(0,'127.0.0.1',accept));
const serviceUrl = 'http://127.0.0.1:' + server.address().port;
const smokeEnv = {
  ...process.env, ARALE_TAURI_USERDATA: userdata, ARALE_TAURI_SMOKE: '1', ARALE_TAURI_TEST_SERVER: serviceUrl, ARALE_TAURI_NO_DEV_ENGINE: process.env.ARALE_TAURI_SMOKE_OCR === '1' ? '0' : '1', WEBVIEW2_USER_DATA_FOLDER: join(folder, 'webview'),
};
const child = spawn(binary, [], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: smokeEnv });
let output = ''; let exited = false; let exitCode;
let second;
child.stdout.on('data', data => { output += data.toString(); });
child.stderr.on('data', data => { output += data.toString(); });
child.on('exit', code => { exited = true; exitCode = code; });
child.on('error', error => { output += String(error); exited = true; });
try {
  const deadline = Date.now() + 180000;
  while (!existsSync(report) && !exited && Date.now() < deadline) {
    if (!second && existsSync(join(userdata, 'system-ready.json'))) {
      // A real second process, from a different working directory, while reading.
      second = spawn(binary, [externalName], { cwd: folder, stdio: 'ignore', env: smokeEnv });
      second.on('error', error => { output += String(error); });
    }
    await delay(150);
  }
  if (!existsSync(report)) throw new Error(`Tauri did not produce a GUI report (exit=${exitCode}): ${output}`);
  const result = JSON.parse(readFileSync(report, 'utf8'));
  for (const row of result.results) console.log(`${row.ok ? 'ok' : 'FAIL'} ${row.name}`);
  if (!result.ok) throw new Error(`Tauri GUI assertion failed: ${JSON.stringify({ frame: result.evidence.failureFrame, message: result.evidence.lastFrameMessage, bridgeReady: result.evidence.readerBridgeReady })}\n${output}`);
  const index = JSON.parse(readFileSync(join(userdata, 'library/index.json'), 'utf8'));
  const id = index.books[0].id;
  const cards = JSON.parse(readFileSync(join(userdata, 'library', id, 'cards.json'), 'utf8'));
  if (cards.version !== 1 || cards.cards[0].note !== 'Tauri 保存验证') throw new Error('Incorrect word card disk format');
  console.log('ok real disk storage uses existing word card schema');
  const dictRoot = join(userdata, 'dictionaries');
  const meta = JSON.parse(readFileSync(join(dictRoot, result.dictionaryId, 'meta.json'), 'utf8'));
  const terms = JSON.parse(readFileSync(join(dictRoot, result.dictionaryId, 'terms.json'), 'utf8'));
  if (meta.termCount !== 3 || terms.length !== 3 || existsSync(join(dictRoot, result.dictionaryId, 'media'))) throw new Error('Incorrect dictionary disk layout');
  console.log('ok dictionary disk schema and media exclusion');
  const require = createRequire(import.meta.url);
  const SQL=await require('sql.js/dist/sql-asm-memory-growth.js')();
  const full=result.evidence.studyFull;
  const {buildAnkiPackage}=require(join(root,'dist-test/tests/support/study/apkg.js'));
  const chosen=full.candidates.find(c=>c.id===result.evidence.studyChosenId);
  const draft=full.workflow.cardRun.drafts.find(d=>d.candidateId===chosen.id);
  for(const exported of result.evidence.studyPackages){
    const archive=unzipSync(readFileSync(exported.path)), media=JSON.parse(strFromU8(archive.media));
    const checkedFile=join(folder,'native-package-fields.sqlite');
    writeFileSync(checkedFile,archive['collection.anki2']);
    const checkedDb=new DatabaseSync(checkedFile,{readOnly:true});
    const models=JSON.parse(checkedDb.prepare('SELECT models FROM col').get().models);
    for(const note of checkedDb.prepare('SELECT mid,CAST(flds AS BLOB) AS fields FROM notes').all()) {
      // Some SQLite JS bindings decode TEXT as a C string and stop at an embedded
      // NUL in the internal Key. Check the stored bytes, as the Anki Rust importer does.
      const fields=Buffer.from(note.fields).toString('utf8').split('\x1f');
      if(fields.length!==models[String(note.mid)].flds.length) throw Error(`Native Anki note has ${fields.length} fields; expected ${models[String(note.mid)].flds.length}`);
    }
    checkedDb.close();
    if(exported.mode==='none') writeFileSync(join(tmpRoot,'tauri-last-export.apkg'),readFileSync(exported.path));
    if(Object.keys(media).length!==(exported.mode==='none'?0:1))throw Error('Wrong native Anki media count');
    let imageName,image;
    if(exported.mode!=='none') {
      imageName=media['0'];image=archive['0'];
      if(!imageName.includes(createHash('sha256').update(image).digest('hex').slice(0,24)))throw Error('Unstable native image hash');
      if(exported.mode==='crop' && Buffer.from(image).toString('hex',0,8)!=='89504e470d0a1a0a')throw Error('Crop is not PNG');
      if(exported.mode==='page' && Buffer.from(image).toString('hex',0,2)!=='ffd8')throw Error('Page is not JPEG');
    }
    const expected=unzipSync(await buildAnkiPackage(full.bookId,result.evidence.studyBookTitle,full.workflow.cardRun.tier,[{candidate:chosen,draft,imageName,image}]));
    const a=new SQL.Database(archive['collection.anki2']),b=new SQL.Database(expected['collection.anki2']);
    if(a.exec('PRAGMA integrity_check')[0].values[0][0]!=='ok')throw Error('Native Anki SQLite corrupt');
    // Note contents and GUID/model/deck identities must match shared Node rules; timestamps differ.
    for(const query of ['SELECT guid,mid,tags,flds,sfld,csum,flags,data FROM notes','SELECT did,ord,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data FROM cards']){
      if(!isDeepStrictEqual(a.exec(query),b.exec(query)))throw Error('Native Anki content differs from Node: '+query);
    }
    a.close();b.close();
  }
  if(!readFileSync(result.evidence.studyText.path,'utf8').includes(chosen.expression))throw Error('Native TSV missing selected word');
  const md=readFileSync(join(result.evidence.studyManualDirectory,'task-001.md'),'utf8');
  if(!md.includes('sessionId') || !md.includes('这是 ARaLeBook') || !existsSync(join(result.evidence.studyManualDirectory,'prompts.md')))throw Error('Native manual AI files incomplete');
  console.log('ok native Anki SQLite integrity, all note/card fields and identities match Node for three image modes; TSV and manual MD exist');
  const { DictionaryStore } = require(join(root, 'dist/core/dict/store.js'));
  const { sanitizeGlossaryHtml } = require(join(root, 'dist/core/dict/glossary.js'));
  const dictionary = new DictionaryStore(dictRoot); await dictionary.load();
  const clean = value => typeof value === 'string' ? sanitizeGlossaryHtml(value) : Array.isArray(value) ? value.map(clean) : { ...value, content: clean(value.content) };
  for (const row of result.evidence.lookups) {
    const expected = dictionary.lookup(row.text, row.offset);
    expected.results = expected.results.map(hit => ({ ...hit, term: { ...hit.term, glossary: clean(hit.term.glossary) } }));
    if (!isDeepStrictEqual(row.result, expected)) throw new Error(`Worker and Node lookup differ: ${row.text}`);
  }
  console.log(`ok ${result.evidence.lookups.length} worker lookups match original Node rules`);
  const { parseMangaJson } = require(join(root, 'dist/core/comic/mokuro.js'));
  const { serializeMangaJson } = require(join(root, 'dist/core/comic/mokuro.js'));
  const { blocksFromLines } = require(join(root,'dist/core/ocr/blocks.js'));
  const { parseOcrStreamLine } = require(join(root,'dist/shared/ocr-protocol.js'));
  const ocrReports=readdirSync(userdata).filter(name=>name.startsWith('ocr-result-'));
  for(const name of ocrReports){
    const input=JSON.parse(readFileSync(join(userdata,name),'utf8'));
    const old=new Map(parseMangaJson(JSON.stringify(input.old)).map(page=>[page.url,page.blocks]));
    const pages=input.book.pages.map((page,i)=>{
      const event=parseOcrStreamLine(input.raw[i]??'');
      const fresh=event.kind==='page'&&event.page.ok?blocksFromLines(event.page.lines,input.book.direction):[];
      return {...page,blocks:fresh.length?fresh:old.get(page.url)??[]};
    });
    const expected=JSON.parse(serializeMangaJson(pages,{engine:input.provider,engineSignature:`${input.provider}:${input.provider==='arale_onnx_v1'?'v2':'v1'}`,schemaVersion:1}));
    if(!isDeepStrictEqual(input.layer,expected))throw new Error('OCR Worker and Node layer differ: '+name);
  }
  if(ocrReports.length<5)throw new Error('Missing OCR regression reports');
  console.log(`ok ${ocrReports.length} complete/cancelled/native OCR layers match original Node blocks and serialization`);
  const { tokenizeJapanese } = require(join(root, 'dist-test/tests/support/study/tokenizer.js'));
  const { morphologyToRecords } = require(join(root, 'dist/core/segment/morph.js'));
  const { segmentUnits, buildVocabulary, refForComicBlock } = require(join(root, 'dist/core/segment/index.js'));
  const actual = JSON.parse(readFileSync(join(userdata, 'library', id, 'segments.json'), 'utf8'));
  const {buildStudyCandidates}=require(join(root,'dist/core/study/candidates.js'));
  const {createJlptIndex}=require(join(root,'dist/core/study/jlpt.js'));
  const {chooseMeaning}=require(join(root,'dist/core/study/service.js'));
  const {zipfForCandidate}=require(join(root,'dist-test/tests/support/study/wordfreq.js'));
  const jlpt=JSON.parse(readFileSync(join(root,'data/jlpt-vocabulary.json'),'utf8'));
  const generated=buildStudyCandidates(actual.units,await Promise.all(actual.units.map(unit=>tokenizeJapanese(unit.text))),createJlptIndex(jlpt.entries));
  for(const candidate of generated){candidate.meaning=chooseMeaning(dictionary.lookup(candidate.expression,0).results,candidate.expression,candidate.reading);candidate.zipf=zipfForCandidate(candidate);}
  if(!isDeepStrictEqual(generated,result.evidence.studyGenerated.candidates))throw Error('Native study candidates differ from original Node Kuromoji/JLPT/Zipf/dictionary rules');
  console.log('ok all study candidates, readings, JLPT, Zipf and dictionary meanings match original Node');
  const manga = parseMangaJson(readFileSync(join(userdata, 'library', id, 'content/manga.json'), 'utf8'));
  const units = [];
  for (const [pageIndex, page] of index.books[0].pages.entries()) {
    const found = manga.find(item => item.url === page.url);
    for (const [blockIndex, block] of (found?.blocks ?? []).entries()) {
      const source = { ref: refForComicBlock(page.url, blockIndex), text: block.lines.join(''), label: `第 ${pageIndex + 1} 页 第 ${blockIndex + 1} 块` };
      const parsed = morphologyToRecords(source.text, await tokenizeJapanese(source.text), word => dictionary.hasExpression(word));
      units.push(...segmentUnits([source], { segmentText: () => parsed, dictionary: { count: 0, signature: '' }, engine: actual.engine }).units);
    }
  }
  if (!isDeepStrictEqual(actual.units, units) || !isDeepStrictEqual(actual.vocabulary, buildVocabulary(units))) throw new Error('Worker and original Node Kuromoji book segmentation differ');
  console.log('ok complete worker book segments and vocabulary match original Node Kuromoji');
  const { readZipFile } = require(join(root, 'dist/core/epub/zip-reader.js'));
  const { parseEpub, extractText } = require(join(root, 'dist/core/epub/parser.js'));
  const { refForChapter } = require(join(root, 'dist/core/segment/index.js'));
  const { findEntry } = require(join(root, 'dist/core/epub/zip-reader.js'));
  for (const imported of result.evidence.epubImports) {
    const entries = readZipFile(imported.source);
    const expected = parseEpub(entries);
    const book = index.books.find(book => book.id === imported.bookId);
    for (const key of ['title', 'author', 'language', 'publisher', 'description', 'spine', 'toc', 'opfRel', 'direction']) {
      if (!isDeepStrictEqual(book[key], expected[key])) throw new Error(`EPUB parser differs: ${key}`);
    }
    const cache = JSON.parse(readFileSync(join(book.dir, 'epub-reader.json'), 'utf8'));
    for (const item of book.spine) {
      const document = cache.documents.find(document => document.href === item.href);
      if (document.plainText !== extractText(findEntry(entries, item.href)?.text() ?? '')) throw new Error('EPUB chapter text differs from Node');
    }
  }
  console.log('ok all three EPUB metadata, navigation and chapter texts match original Node parser');
  const epubBook = index.books.find(book => book.id === result.evidence.epubId);
  const epubActual = JSON.parse(readFileSync(join(epubBook.dir, 'segments.json'), 'utf8'));
  const epubUnits = [];
  for (const [i, item] of epubBook.spine.entries()) {
    const source = { ref: refForChapter(i, item.href), text: extractText(readFileSync(join(epubBook.dir, 'content', item.href), 'utf8')), label: epubBook.toc.find(entry => entry.href === item.href)?.label.trim() ?? item.href.split('/').at(-1) };
    const parsed = morphologyToRecords(source.text, await tokenizeJapanese(source.text), word => dictionary.hasExpression(word));
    epubUnits.push(...segmentUnits([source], { segmentText: () => parsed, dictionary: { count: 0, signature: '' }, engine: epubActual.engine }).units);
  }
  if (!isDeepStrictEqual(epubActual.units, epubUnits) || !isDeepStrictEqual(epubActual.vocabulary, buildVocabulary(epubUnits))) throw new Error('Worker EPUB segmentation differs from Node');
  console.log('ok complete EPUB worker segments and vocabulary match original Node Kuromoji');
  console.log(`Real dictionary import/index time: ${result.evidence.realDictionaryImportMs} ms (test machine only)`);
  const providers = ['microsoft','deepl','google','baidu','libre'];
  for (const provider of providers) if (!requests.some(request => request.path.startsWith('/'+provider+'/'))) throw new Error('Missing real Rust HTTP for '+provider);
  if (requests.find(r=>r.path.startsWith('/microsoft/')).headers['ocp-apim-subscription-key'] !== 'test-secret') throw new Error('Microsoft credential not injected');
  if (requests.find(r=>r.path.startsWith('/deepl/')).headers.authorization !== 'DeepL-Auth-Key test-secret') throw new Error('DeepL credential not injected');
  if (requests.find(r=>r.path.startsWith('/google/')).query.key !== 'test-secret') throw new Error('Google credential not injected');
  const baidu = requests.find(r=>r.path.startsWith('/baidu/')).body;
  if (baidu.sign !== createHash('md5').update('123'+baidu.q+baidu.salt+'test-secret').digest('hex')) throw new Error('Baidu signature differs');
  if (requests.filter(r=>r.path.startsWith('/libre/') && r.body.q==='cache-test').length !== 1) throw new Error('Translation cache missed');
  const llm = requests.filter(r=>r.path === '/v1/chat/completions');
  if (!llm.every(r=>r.headers.authorization==='Bearer test-key') || !llm.some(r=>r.body.messages[0]?.content==='词语 猫；句子 猫が好きです。')) throw new Error('LLM prompt or native credential changed');
  console.log('ok six providers, native credentials, Baidu MD5, translation cache and exact LLM prompt');
  console.log(`Tauri smoke: ${result.results.length + 9}/${result.results.length + 9} passed`);
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  server.closeAllConnections(); await new Promise(accept => server.close(accept));
  if (second && second.exitCode === null && second.signalCode === null) {
    second.kill();
    await Promise.race([new Promise(accept => second.once('exit', accept)), delay(3000)]);
  }
  if (!exited) {
    await Promise.race([new Promise(accept => child.once('exit', accept)), delay(2000)]);
    if (!exited) child.kill();
    await Promise.race([new Promise(accept => child.once('exit', accept)), delay(3000)]);
  }
  const resolved = realpathSync(folder); const allowed = realpathSync(tmpRoot);
  if (!resolved.startsWith(allowed + sep)) throw new Error('Refusing cleanup outside test directory');
  if (process.env.ARALE_TAURI_SMOKE_KEEP === '1') console.log(`Retained isolated UI fixture: ${resolved}`);
  else await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
