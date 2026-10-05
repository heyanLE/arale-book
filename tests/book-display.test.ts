import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookDisplay } from '../src/core/books/display';
test('display separates filename author and volume without changing metadata', () => {
  const book = {title:'[久住太陽] ウマ娘 シンデレラグレイ 第01巻', author:'',volume:null};
  assert.deepEqual(bookDisplay(book), {title:'ウマ娘 シンデレラグレイ 第01巻',author:'久住太陽',volume:1,needsMetadata:true});
  assert.equal(book.author, '');
  assert.equal(bookDisplay({...book, author:'已录入作者',volume:2}).author, '已录入作者');
  assert.equal(bookDisplay({title:'壊れた�タイトル',author:'',volume:null}).title,'壊れた�タイトル');
});
