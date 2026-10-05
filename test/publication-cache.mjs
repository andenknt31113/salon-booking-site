import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { publicHtml } from '../tools/public-content.mjs';
import { parsePublishedMenus, serializePublishedMenus } from '../tools/publication-site.mjs';

const PAGES = ['index.html', 'menu.html', 'staff.html', 'gallery.html', 'reviews.html',
  'privacy.html', 'reserve.html', 'mypage.html', 'design-a.html'];
const source = await readFile(new URL('../assets/js/published-menus.js', import.meta.url), 'utf8');
const version = value => createHash('sha256').update(value).digest('hex');

for (const page of PAGES) {
  test(`${page}は初期HTMLと同じ公開データの内容hashを読込URLへ持つ`, async () => {
    const result = (await publicHtml(source)).find(file => file.name === page);
    assert.ok(result, page);
    const matches = Array.from(result.next.matchAll(/src="assets\/js\/published-menus\.js\?v=([a-f0-9]+)"/g));
    assert.equal(matches.length, 1);
    assert.equal(matches[0][1], version(source));
  });
}

test('料金の変更時は全ての読込先を変更し、同じ内容では再生成のURLを変えない', async () => {
  const data = parsePublishedMenus(source);
  data.coupons[0].price += 1;
  const changed = serializePublishedMenus(data);
  const before = await publicHtml(source);
  const after = await publicHtml(changed);
  assert.notEqual(version(source), version(changed));
  assert.deepEqual(after, await publicHtml(changed));
  for (const file of after) {
    const old = before.find(previous => previous.name === file.name);
    assert.ok(old);
    assert.equal(file.next.includes('published-menus.js?v=' + version(changed)), true, file.name);
    assert.equal(file.next.includes('published-menus.js?v=' + version(source)), false, file.name);
  }
});
