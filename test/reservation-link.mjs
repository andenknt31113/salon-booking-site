import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const gas = await read('gas/Code.gs');
const mypage = await read('assets/js/mypage.js');
const common = await read('assets/js/common.js');
const html = await read('mypage.html');

const SITE = 'https://example.invalid/site/';
const urlSource = gas.match(/function reservationPageUrl_\(code\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(urlSource, 'メールのリンクを作る処理が必要です');
const reservationPageUrl = vm.runInNewContext('const SITE_URL = ' + JSON.stringify(SITE) + ';(' + urlSource + ')');

const pattern = mypage.match(/const LINKED_CODE_PATTERN = .*;/)?.[0];
const linkedSource = mypage.match(/function linkedCode\(search\) \{[\s\S]*?\n\}/)?.[0];
const halfWidth = common.match(/function toHalfWidth\(v\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(pattern && linkedSource && halfWidth, 'URLの予約番号を読む処理が必要です');
const linkedCode = vm.runInNewContext(halfWidth + ';' + pattern + ';(' + linkedSource + ')', { URLSearchParams });

test('メールのリンクは予約番号だけを付け、電話番号は付けない', () => {
  assert.equal(reservationPageUrl('LM-8F3K2'), SITE + 'mypage.html?code=LM-8F3K2');
  assert.doesNotMatch(reservationPageUrl('LM-8F3K2'), /tel|phone/);
});

test('番号として読めない値は、リンクへ付けずにページだけ開く', () => {
  for (const value of ['', null, undefined, '---', 'LM 8F3K2', 'LM-8F3K2&tel=090', '<script>', 'A'.repeat(21)]) {
    assert.equal(reservationPageUrl(value), SITE + 'mypage.html', String(value));
  }
});

test('予約完了と日時変更の両方のメールが、番号付きのリンクを使う', () => {
  assert.equal(gas.match(/reservationPageUrl_\(/g).length, 3, '定義1・予約完了1・日時変更1');
  assert.doesNotMatch(gas, /\$\{SITE_URL\}mypage\.html/);
});

test('ページはメールが作ったリンクの番号をそのまま読める', () => {
  const url = new URL(reservationPageUrl('LM-8F3K2'));
  assert.equal(linkedCode(url.search), 'LM-8F3K2');
  assert.equal(linkedCode('?code=lm-8f3k2'), 'LM-8F3K2', '小文字は大文字へ');
  assert.equal(linkedCode('?code=%EF%BC%AC%EF%BC%AD-8F3K2'), 'LM-8F3K2', '全角は半角へ');
});

test('番号が無い・番号として読めないURLでは、欄へ何も入れない', () => {
  for (const search of ['', '?', '?code=', '?code=---', '?code=%3Cscript%3E', '?code=LM%208F3K2&x=1',
    '?code=' + 'A'.repeat(21), '?tel=09012345678']) {
    assert.equal(linkedCode(search), '', search);
  }
});

test('電話番号はURLから読まず、読んだ番号はアドレス欄に残さない', () => {
  assert.doesNotMatch(mypage, /get\('(tel|phone)'\)/);
  assert.match(mypage, /history\.replaceState\(null, '', location\.pathname \+ location\.hash\)/);
});

test('確認の欄はお客様の言葉で書き、記録が無いときに隠す欄がある', () => {
  assert.match(html, /id="lookup-title"[^>]*>予約番号で予約を確認する</);
  assert.match(html, /確認のあと、そのまま変更・キャンセルもできます。/);
  assert.match(html, /id="lookup-prefill-note"[^>]*hidden/);
  assert.match(html, /<div id="past-bookings">[\s\S]*id="past-list"/);
  assert.match(html, /id="saved-bookings-note"/);
  assert.match(mypage, /pastSection\.hidden = noRecords/);
});
