/**
 * 准备一份「开箱可体验」的演示数据。
 *
 * 做两件事：
 * 1. 把 `samples/` 里的三本样书导入一个指定的数据目录；
 * 2. 生成并导入一本**小词典**，覆盖样书里真正出现的词 —— 否则点词查义只会显示
 *    「未找到释义」，那个功能就没法体验。
 *
 * 这本词典是**演示用**的：手工挑的词 + 简短的日中释义，不是真实词典的替代品。
 * 真实使用请去装一本 Jitendex / JMdict（见 README 的词典一节）。
 *
 * 用法：`node scripts/seed-demo.mjs [数据目录]`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

import { setUserDataRootForTesting } from '../dist/main/paths.js';
import { LibraryStore } from '../dist/main/library/store.js';
import { importPath } from '../dist/main/library/importer.js';
import { DictionaryStore } from '../dist/core/dict/store.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, '.arale-demo');

/**
 * 演示词典词条：`[词形, 读音, 词性, 释义]`。
 *
 * 挑选依据是**样书里真的出现的词**（《吾輩は猫である》前三章 + サンプル漫画的台词），
 * 这样随便点哪里都有释义。低频词刻意不收 —— 它只是让人能体验「点词 → 弹释义 →
 * 看到活用还原」这条链路，不是给人查词用的。
 */
const WORDS = [
  ['吾輩', 'わがはい', 'pn', '我；吾辈（明治时期男性自称，带书卷气）'],
  ['猫', 'ねこ', 'n', '猫'],
  ['名前', 'なまえ', 'n', '名字；姓名'],
  ['無い', 'ない', 'adj-i', '没有；不存在'],
  ['どこ', 'どこ', 'pn', '哪里；何处'],
  ['生れる', 'うまれる', 'v1', '出生；诞生'],
  ['見当', 'けんとう', 'n', '估计；判断；大致方向'],
  ['薄暗い', 'うすぐらい', 'adj-i', '微暗的；昏暗的'],
  ['じめじめ', 'じめじめ', 'adv', '潮湿的；阴湿的'],
  ['泣く', 'なく', 'v5', '哭；哭泣'],
  ['記憶', 'きおく', 'n', '记忆'],
  ['人間', 'にんげん', 'n', '人；人类'],
  ['書生', 'しょせい', 'n', '书生；寄宿求学的学生'],
  ['獰悪', 'どうあく', 'adj-na', '凶恶；狰狞'],
  ['種族', 'しゅぞく', 'n', '种族'],
  ['捕える', 'つかまえる', 'v1', '抓住；捉住'],
  ['煮る', 'にる', 'v1', '煮；炖'],
  ['食う', 'くう', 'v5', '吃（比「食べる」粗俗）'],
  ['話', 'はなし', 'n', '话；谈话；故事'],
  ['当時', 'とうじ', 'n', '当时；那时候'],
  ['考', 'かんがえ', 'n', '想法；考虑'],
  ['別段', 'べつだん', 'adv', '特别；格外（多与否定呼应）'],
  ['恐しい', 'おそろしい', 'adj-i', '可怕的；恐怖的'],
  ['掌', 'てのひら', 'n', '手掌'],
  ['載せる', 'のせる', 'v1', '放上去；载上'],
  ['持ち上げる', 'もちあげる', 'v1', '举起；抬起；抬举'],
  ['感じ', 'かんじ', 'n', '感觉；感受'],
  ['今日', 'きょう', 'n', '今天'],
  ['天気', 'てんき', 'n', '天气'],
  ['いい', 'いい', 'adj-i', '好的'],
  ['ちょっと', 'ちょっと', 'adv', '一下；稍微；（招呼）喂'],
  ['待つ', 'まつ', 'v5', '等；等待'],
  ['学校', 'がっこう', 'n', '学校'],
  ['行く', 'いく', 'v5', '去；前往'],
  ['毎日', 'まいにち', 'n', '每天'],
  ['縁側', 'えんがわ', 'n', '日式房屋的檐廊'],
  ['眺める', 'ながめる', 'v1', '眺望；凝视'],
  ['音', 'おと', 'n', '声音'],
  ['妙', 'みょう', 'adj-na', '奇妙；不可思议'],
  ['心地よい', 'ここちよい', 'adj-i', '舒服的；惬意的'],
  ['難しい', 'むずかしい', 'adj-i', '难的；困难的'],
  ['顔', 'かお', 'n', '脸；表情'],
  ['本', 'ほん', 'n', '书'],
  ['読む', 'よむ', 'v5', '读；阅读'],
  ['読書', 'どくしょ', 'n', '读书'],
  ['役に立つ', 'やくにたつ', 'exp', '有用；起作用'],
  ['皆目', 'かいもく', 'adv', '完全（不）；丝毫（不）'],
  ['笑う', 'わらう', 'v5', '笑'],
  ['頃', 'ころ', 'n', '时候；时期'],
  ['太陽', 'たいよう', 'n', '太阳'],
  ['当たる', 'あたる', 'v5', '照射到；碰上；命中'],
  ['場所', 'ばしょ', 'n', '地方；场所'],
  ['ご飯', 'ごはん', 'n', '米饭；饭'],
  ['十分', 'じゅうぶん', 'adj-na', '充分；足够'],
  ['寿司', 'すし', 'n', '寿司'],
  ['食べる', 'たべる', 'v1', '吃'],
  ['私', 'わたし', 'pn', '我'],
  ['呼ぶ', 'よぶ', 'v5', '叫；称呼；呼唤'],
  ['主人', 'しゅじん', 'n', '主人；丈夫'],
  ['女中', 'じょちゅう', 'n', '女佣；女服务员'],
  ['決める', 'きめる', 'v1', '决定'],
  ['勝手', 'かって', 'adj-na', '任性的；自作主张的；方便'],
  ['構わない', 'かまわない', 'exp', '没关系；不在乎'],
  ['明日', 'あした', 'n', '明天'],
  ['塩', 'しお', 'n', '盐'],
  ['鳴く', 'なく', 'v5', '（鸟兽）叫；鸣'],
  ['名前', 'なまえ', 'n', '名字'],
  ['まだ', 'まだ', 'adv', '还；仍然'],
  ['いる', 'いる', 'v1', '在；有（生物）'],
  ['ある', 'ある', 'v5', '在；有（无生物）'],
  ['する', 'する', 'vs', '做；干'],
  ['来る', 'くる', 'vk', '来'],
  ['見る', 'みる', 'v1', '看；看见'],
  ['思う', 'おもう', 'v5', '想；认为'],
  ['言う', 'いう', 'v5', '说'],
  ['いい天気', 'いいてんき', 'exp', '好天气'],
  ['おはよう', 'おはよう', 'int', '早上好'],
  ['おやすみ', 'おやすみ', 'int', '晚安'],
  ['フリル', 'ふりる', 'n', '褶边；花边'],
  ['かわいい', 'かわいい', 'adj-i', '可爱的'],
  ['鈴木', 'すずき', 'n', '铃木（姓氏）'],
  ['夏目', 'なつめ', 'n', '夏目（姓氏）'],
  ['顔', 'かお', 'n', '脸'],
  ['赤い', 'あかい', 'adj-i', '红的'],
  ['暑い', 'あつい', 'adj-i', '热的（天气）'],
  ['忘れる', 'わすれる', 'v1', '忘记'],
  ['バイト', 'ばいと', 'n', '打工；兼职'],
  ['放課後', 'ほうかご', 'n', '放学后'],
  ['一緒', 'いっしょ', 'n', '一起'],
  ['シンプル', 'しんぷる', 'adj-na', '简单的；朴素的'],
  ['可愛い', 'かわいい', 'adj-i', '可爱的'],
  ['気分', 'きぶん', 'n', '心情；情绪'],
  ['彼氏', 'かれし', 'n', '男朋友'],
  ['部活', 'ぶかつ', 'n', '社团活动'],
  ['ドア', 'どあ', 'n', '门'],
  ['開く', 'あく', 'v5', '开；打开'],
  ['注意', 'ちゅうい', 'n', '注意；小心'],
  ['お客様', 'おきゃくさま', 'n', '客人；乘客'],
  ['乗り換え', 'のりかえ', 'n', '换乘；转乘'],
];

function buildDictionaryZip() {
  const index = { title: '演示词典（あられブックサンプル）', format: 3, revision: '1' };
  // Yomitan term bank 一行：`[expression, reading, definitionTags, rules, score, glossary, sequence, termTags]`
  const rows = WORDS.map((word, i) => [
    word[0],
    word[1],
    word[2],
    // `rules` 决定这条词能不能被变形查询命中（如 食べる 的 v1 → 食べました）。
    word[2] === 'v1' || word[2] === 'v5' || word[2] === 'vk' || word[2] === 'vs' ? word[2] : '',
    100,
    [word[3]],
    i + 1,
    '',
  ]);
  return Buffer.from(
    zipSync({
      'index.json': strToU8(JSON.stringify(index)),
      'term_bank_1.json': strToU8(JSON.stringify(rows)),
    }),
  );
}

// ---------------------------------------------------------------------------

fs.mkdirSync(dataDir, { recursive: true });
setUserDataRootForTesting(dataDir);

// 0) 先清空书库与词典。
// **必须清**：seed 是「把这份数据目录变成演示状态」，不是「往里再加一份」。
// 之前没清，重复跑一次就多出 4 本同名的书、词典词条数也会翻倍 —— 界面上看起来
// 像导入坏了。`--keep` 可以保留（用于只想补一份词典的场合）。
if (!process.argv.includes('--keep')) {
  const libraryDir = path.join(dataDir, 'library');
  if (fs.existsSync(libraryDir)) fs.rmSync(libraryDir, { recursive: true, force: true });
  const dictDir = path.join(dataDir, 'dictionaries');
  if (fs.existsSync(dictDir)) fs.rmSync(dictDir, { recursive: true, force: true });
  const positions = path.join(dataDir, 'positions.json');
  if (fs.existsSync(positions)) fs.rmSync(positions, { force: true });
}

// 1) 词典
const zipPath = path.join(dataDir, 'demo-dictionary.zip');
fs.writeFileSync(zipPath, buildDictionaryZip());
const dictStore = new DictionaryStore(path.join(dataDir, 'dictionaries'));
const imported = await dictStore.importZip(zipPath);
await dictStore.load();
const status = dictStore.status();
console.log(`词典：${imported.title} · ${status.termCount} 条 · ${status.dictionaries.length} 部`);

// 2) 样书
const store = new LibraryStore();
store.load();
const samples = fs
  .readdirSync(path.join(root, 'samples'))
  .filter((name) => name.endsWith('.epub') || name.endsWith('.cbz'));
if (samples.length === 0) {
  console.error('samples/ 是空的，先跑 `npm run samples`');
  process.exit(1);
}
for (const name of samples) {
  // importPath 返回数组：套娃包（一个压缩包里装多个分卷）会一次产出多本。
  for (const outcome of await importPath(path.join(root, 'samples', name), store)) {
    const book = outcome.bookId ? store.get(outcome.bookId) : null;
    const mode = book?.readerMode ? `${book.readerMode}（覆盖）` : '跟随 format';
    console.log(
      outcome.ok
        ? `书：${book?.title} [${book?.format} / 阅读方式 ${mode} / ${book?.pageCount} 页]`
        : `书：${outcome.source} 失败 — ${outcome.error}`,
    );
  }
}

console.log(`\n演示数据就绪：${dataDir}`);
console.log(`书库 ${store.info().bookCount} 本 · 词典 ${status.termCount} 条`);
