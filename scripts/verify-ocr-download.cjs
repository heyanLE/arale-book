// 使用真实 ExtensionService 下载/校验/解包和 OCR provider；不加载开发引擎。
// node_modules/electron/dist/electron.exe scripts/verify-ocr-download.cjs
// 可选 ARALE_VERIFY_PROXY=http://127.0.0.1:8400，仅作用于此验收进程。
const { app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ExtensionService } = require('../dist/main/extensions/service');
const { ExtensionOcrEngine } = require('../dist/main/ocr/providers/extension');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const verifyRoot = fs.mkdtempSync(path.join(root, '.tmp', 'release-download-'));
app.setPath('userData', path.join(verifyRoot, 'electron'));
app.whenReady().then(async () => {
  if (process.env.ARALE_VERIFY_PROXY) {
    await session.defaultSession.setProxy({ proxyRules: process.env.ARALE_VERIFY_PROXY });
  }
  let lastLog = 0;
  const service = new ExtensionService({
    root: path.join(verifyRoot, 'extensions'),
    localRepositoryFile: path.join(root, 'engines/repositories/default.jsonl'),
    onProgress(progress) {
      if (progress.phase !== 'downloading' || Date.now() - lastLog > 10_000) {
        console.log(JSON.stringify(progress)); lastLog = Date.now();
      }
    },
  });
  console.log(`Isolated verification: ${verifyRoot}`);
  console.log('Repository refresh:', await service.refreshCatalog());
  const installed = await service.install('ocr-arale_onnx_v1');
  if (!installed.ok) throw new Error(installed.error);
  const engine = new ExtensionOcrEngine({ extensionId: 'ocr-arale_onnx_v1', engineId: 'arale_onnx_v1', extensions: service });
  const status = await engine.status();
  if (!status.ready) throw new Error(status.reason);
  const result = await engine.recognize({
    book: { id: 'release-verification' }, contentDir: path.join(root, 'samples'), direction: 'rtl',
    pages: [{ rel: 'ocr-fixture.png', absPath: path.join(root, 'samples/ocr-fixture.png'), width: 800, height: 1200 }],
    isCancelled: () => false,
  }, { page: () => {}, message: () => {} });
  if (!result[0]?.ok || !result[0].lines.length) throw new Error('Downloaded engine produced no OCR lines');
  const report = { verifiedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, installed: service.installed(), status, result };
  fs.writeFileSync(path.join(verifyRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS: ${result[0].lines.length} OCR lines; report: ${verifyRoot}/report.json`);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
