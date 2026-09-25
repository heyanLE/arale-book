/**
 * 引擎库（submodule `engines/`）的**一致性**测试。
 *
 * ## 为什么需要
 *
 * OCR 引擎的真相源在 submodule 里（`engines/manga-anki/ocr-bridge.py`），但应用仓库里
 * 还留着一份历史副本 `scripts/ocr-bridge.py`（当初应用自己跑引擎时留下的）。两份并存本身
 * 没问题，**悄悄分叉**才是问题：改了一份、另一份没改，下次构建出来的归档和仓库里读到的
 * 源码就对不上，而没有任何东西会报错。
 *
 * 所以这里把「两份必须逐字节相同」写成断言。等哪天把应用仓库那份删掉，这条测试也一起删。
 *
 * submodule **没初始化**时（`git clone` 忘了 `--recursive`）跳过并打印原因——不假装验证过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const LIBRARY_BRIDGE = path.join(ROOT, 'engines', 'manga-anki', 'ocr-bridge.py');
const APP_BRIDGE = path.join(ROOT, 'scripts', 'ocr-bridge.py');
const LIBRARY_README = path.join(ROOT, 'engines', 'README.md');

test('引擎库 submodule 的两份桥逐字节一致（防止悄悄分叉）', (t) => {
  if (!fs.existsSync(LIBRARY_BRIDGE)) {
    t.skip(`submodule 没初始化（${path.relative(ROOT, LIBRARY_BRIDGE)} 不存在）：git submodule update --init`);
    return;
  }
  assert.ok(fs.existsSync(APP_BRIDGE), '应用仓库里的历史副本不见了——如果是有意删掉的，请一并删掉这条测试');
  const library = fs.readFileSync(LIBRARY_BRIDGE);
  const app = fs.readFileSync(APP_BRIDGE);
  assert.ok(
    library.equals(app),
    'engines/manga-anki/ocr-bridge.py 与 scripts/ocr-bridge.py 不一致：改了一份就要同步另一份' +
      '（真相源在引擎库，应用仓库那份只是历史副本）',
  );
});

test('引擎库 README 里有引擎清单，且列着 manga-anki', (t) => {
  if (!fs.existsSync(LIBRARY_README)) {
    t.skip('submodule 没初始化');
    return;
  }
  const readme = fs.readFileSync(LIBRARY_README, 'utf8');
  assert.match(readme, /##\s*引擎清单/, 'README 要有「引擎清单」小节（多引擎库的入口）');
  assert.match(readme, /manga-anki/, '清单里要列着当前唯一的引擎 manga-anki');
  // 协议是引擎与应用之间唯一的契约，漏了它等于没写「怎么接一个新引擎」。
  assert.match(readme, /kind":"page|kind":"meta|NDJSON/, 'README 要写清 NDJSON 协议');
  assert.match(readme, /extension\.json/, 'README 要写清 extension.json');
});
