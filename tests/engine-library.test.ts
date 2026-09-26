/**
 * 引擎库（submodule `engines/`）的**结构**测试。
 *
 * 引擎库支持多个引擎，**发不发由清单决定**；应用只认协议与 `extension.json`，所以
 * 「库里有哪些引擎、发布的是哪一个」必须能在仓库里一眼看出来，而不是散在文档里。
 *
 * 这里钉三件事：
 * 1. 引擎库 README 真的有引擎清单（多引擎库的入口），并且列着当前发布的引擎；
 * 2. 当前引擎是包内 Python + ONNX Runtime，且旧 Rust/PyTorch 引擎源码已删除；
 *
 * submodule 没初始化时（`git clone` 忘了 `--recursive`）跳过并打印原因——不假装验证过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const LIBRARY = path.join(ROOT, 'engines');
/** 当前发布的引擎（改名字时这里要一起改——它是应用侧 provider id 的来源）。 */
const ENGINE = 'arale_onnx_v1';

test('引擎库 README 有引擎清单，且列着当前发布的引擎', (t) => {
  const readme = path.join(LIBRARY, 'README.md');
  if (!fs.existsSync(readme)) {
    t.skip('submodule 没初始化：git submodule update --init --recursive');
    return;
  }
  const text = fs.readFileSync(readme, 'utf8');
  assert.match(text, /##\s*引擎清单/, 'README 要有「引擎清单」小节');
  assert.ok(text.includes(ENGINE), `清单里要列着引擎 ${ENGINE}`);
  // 协议与自描述是引擎与应用之间唯一的契约，漏了它等于没写「怎么接一个新引擎」。
  assert.match(text, /NDJSON/, 'README 要写清 NDJSON 协议');
  assert.match(text, /extension\.json/, 'README 要写清 extension.json');
});

test('发布的引擎是无 PyTorch 的 Python/ONNX 实现，旧引擎源码已删除', (t) => {
  if (!fs.existsSync(LIBRARY)) {
    t.skip('submodule 没初始化');
    return;
  }
  assert.ok(fs.existsSync(path.join(LIBRARY, ENGINE, 'python', 'ocr_run.py')));
  assert.ok(fs.existsSync(path.join(LIBRARY, ENGINE, 'prepare-runtime.mjs')));
  assert.ok(!fs.existsSync(path.join(LIBRARY, ENGINE, 'Cargo.toml')));
  assert.ok(!fs.existsSync(path.join(LIBRARY, 'legacy', 'python-manga-anki')));
  const rootDirs = fs
    .readdirSync(LIBRARY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
  for (const shared of ['tools', 'docs']) {
    assert.ok(rootDirs.includes(shared), `库根应有 ${shared}/`);
  }
  assert.ok(!rootDirs.includes('manga-anki'), 'manga-anki 不该再作为引擎目录存在（已弃用）');
  const dev = path.join(LIBRARY, ENGINE, 'build', `dev-${process.platform}-${process.arch}`);
  if (fs.existsSync(path.join(dev, 'extension.json'))) {
    assert.ok(!fs.existsSync(path.join(dev, 'engine', 'torch')), '调试包不能带 PyTorch');
    assert.ok(fs.existsSync(path.join(dev, 'engine', 'onnxruntime')));
  }
});

test('OCR 仓库 JSONL 在 submodule 中生成，且包按平台给', () => {
  const repoPath = path.join(LIBRARY, 'repositories', 'default.jsonl');
  const entries = fs.readFileSync(repoPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line)) as
    Array<{ id: string; provides: string; release?: { repo: string; tag: string; assets: Record<string, { asset: string; sha256: string }> } }>;
  const ids = entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复：解析器会把整份清单判成坏的');
  const entry = entries.find((item) => item.provides === ENGINE);
  assert.ok(entry, `清单里要有 provides = ${ENGINE} 的条目`);
  assert.equal(entry.id, 'ocr-arale_onnx_v1', '扩展 id = ocr- + provider id');
  assert.ok(entry.release, '清单用 release{repo,tag,assets} 表达下载地址');
  assert.deepEqual(Object.keys(entry.release.assets).sort(), ['darwin-arm64', 'win32-x64'], '两平台都有构建记录');
  for (const [key, asset] of Object.entries(entry.release.assets)) {
    assert.ok(asset.asset.length > 0, `${key} 要有包名`);
    assert.ok(!asset.asset.includes('/'), `${key} 的包名只能是文件名`);
    assert.ok(asset.sha256 === '' || /^[0-9a-f]{64}$/.test(asset.sha256), `${key} 的 sha256 形状不对`);
  }
});
