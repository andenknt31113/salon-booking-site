import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/js/pages.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../reviews.html', import.meta.url), 'utf8');
const homeHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const render = source.match(/^function renderGoogleReviewLink\([^]*?^}/m)[0];
const host = { hidden: true, innerHTML: '' };
const salon = { name: '試験店舗', nameSub: '理容室', address: '試験住所', googleReviewUrl: 'https://g.page/r/example/review' };
const context = vm.createContext({
  URL, SALON: salon, $: () => host,
  esc: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
});
vm.runInContext(render, context);
context.renderGoogleReviewLink();
assert.equal(host.hidden, false, '投稿前からGoogleへの導線が出る');
assert.ok(host.innerHTML.includes(salon.googleReviewUrl), '設定された投稿先を使う');
assert.ok(host.innerHTML.includes('noopener noreferrer'), '別タブの安全属性がある');
assert.ok(host.innerHTML.includes('口コミを収集・掲載しません'), '自社口コミとGoogle口コミの違いを案内する');
assert.ok(host.innerHTML.includes(encodeURIComponent('試験店舗 理容室 試験住所')), '店舗名と住所でGoogleマップを開く');
for (const invalid of ['', undefined, 'javascript:alert(1)', 'http://example.com', '不正なURL',
  'https://www.google.com/search?q=ZER01#lrd=unverified', 'https://g.page.evil.example/r/example/review']) {
  salon.googleReviewUrl = invalid;
  context.renderGoogleReviewLink();
  assert.equal(host.hidden, false, '投稿URL未設定でも閲覧導線は残す');
  assert.ok(!host.innerHTML.includes('Googleに口コミを書く（別タブ）'), 'URL未設定・不正の場合は投稿ボタンを隠す');
  assert.ok(!host.innerHTML.includes('https://g.page/r/example/review'), '以前の投稿リンクを残さない');
}
salon.googleReviewUrl = 'https://g.page/r/changed/review';
context.renderGoogleReviewLink();
assert.ok(host.innerHTML.includes(salon.googleReviewUrl), '設定の再読込でリンクが更新される');
assert.equal((html.match(/id="google-review"/g) || []).length, 1, '投稿リンクの領域は一つだけ');
assert.ok(!html.includes('id="review-form"'), '自社の口コミフォームを設けない');
assert.ok(!html.includes('id="review-list"'), '自社の口コミ一覧を設けない');
assert.ok(!html.includes('id="review-summary"'), '自社の評価集計を設けない');
assert.ok(homeHtml.includes('>Googleの口コミを見る・書く</a>'), 'トップの口コミ導線は初期HTMLからGoogle案内にする');
assert.ok(!homeHtml.includes('口コミをすべて見る'), '初期HTMLに古い案内を残さない');
assert.ok(!homeHtml.includes('class="hero-rating"'), '初期HTMLから使わない評価欄を外す');
assert.ok(html.includes('href="reserve.html"'), '口コミページから予約案内へ戻れる');
assert.match(source, /function initReviewsPage\(\)\s*\{\s*renderGoogleReviewLink\(\);/, 'ページ初期化時に表示する');
console.log('Google口コミ導線：全項目成功');
