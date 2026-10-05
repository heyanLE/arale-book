import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/core/cards/markdown';

test('LLM Markdown renders headings, emphasis, lists, tables and code blocks', () => {
  const html = renderMarkdown('## 用法\n\n**强调**和 *语气*\n\n- 例句一\n- 例句二\n\n| 词 | 义 |\n| --- | --- |\n| 猫 | cat |\n\n```js\nconst x = 1 < 2;\n```');
  for (const tag of ['h2', 'strong', 'em', 'ul', 'li', 'table', 'thead', 'td', 'pre', 'code']) assert.match(html, new RegExp(`<${tag}[ >]`));
  assert.match(html, /1 &lt; 2/);
});

test('LLM Markdown preserves plain newlines and treats HTML/resources as text', () => {
  const html = renderMarkdown('第一行\n第二行\n\n<script>alert(1)</script>\n\n<img src="https://example.invalid/a" onerror="alert(1)">\n\n![图片说明](https://example.invalid/a)\n\n[安全标题](javascript:alert(1))');
  assert.match(html, /第一行<br>\s*第二行/);
  assert.doesNotMatch(html, /<script\b|<img\b|<iframe\b|href\s*=|onerror\s*="/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /图片说明/);
  assert.match(html, /安全标题/);
});
