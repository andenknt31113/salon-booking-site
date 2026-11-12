import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { publicHtml } from '../tools/public-content.mjs';

const pages = await readFile(new URL('../assets/js/pages.js', import.meta.url), 'utf8');
const source = pages.match(/function directionsLines\(text\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(source, '道案内の整形処理が必要です');
const directionsLines = vm.runInNewContext('(' + source + ')');

test('行き方の記号の前で改行し、文言は一文字も変えない', () => {
  const text = '◯お車でお越しの方 建物内です。※駐車場あり。◯ 公共機関ご利用の方 バスです。';
  const lines = directionsLines(text);
  assert.equal(lines, '◯お車でお越しの方 建物内です。\n※駐車場あり。\n◯ 公共機関ご利用の方 バスです。');
  assert.equal(lines.replaceAll('\n', ''), text);
});

test('記号がない道案内・店主が入れた改行・空欄はそのまま扱う', () => {
  assert.equal(directionsLines('駅から徒歩3分です。'), '駅から徒歩3分です。');
  assert.equal(directionsLines('一行目\n二行目'), '一行目\n二行目');
  assert.equal(directionsLines(''), '');
  assert.equal(directionsLines(undefined), '');
});

test('公開トップの初期HTMLにも同じ改行が入り、元の道案内を全て含む', async () => {
  const catalog = await readFile(new URL('../assets/js/published-menus.js', import.meta.url), 'utf8');
  const index = (await publicHtml(catalog)).find(file => file.name === 'index.html');
  assert.equal(index.next, index.previous, 'node tools/publish-menus.mjs --write-local で初期HTMLを揃えてください');
  const cell = index.next.match(/<th>道案内<\/th><td>([\s\S]*?)<\/td>/)?.[1];
  assert.ok(cell);
  assert.ok(cell.split('<br />').length >= 3, '行き方ごとに行を分ける');
  assert.ok(cell.split('<br />').every(line => line && !/^\s/.test(line)));
});
