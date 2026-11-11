import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assetUrls, EXTRA_PAGES, MAX_ATTEMPTS, PRIVATE_PATHS, runMonitor, sitemapUrls } from '../tools/monitor-site.mjs';

const BASE = 'https://monitor.invalid/site/';
const ENDPOINT = 'https://script.google.com/macros/s/FIXTURE_MONITOR/exec';
const SITEMAP = `<urlset><url><loc>${BASE}</loc></url><url><loc>${BASE}reserve.html</loc></url></urlset>`;
const PAGE = '<!doctype html><html><head><link rel="stylesheet" href="assets/css/style.css?v=1">'
  + '<link rel="icon" href="favicon.svg"><script src="https://other.invalid/x.js"></script></head><body>'
  + 'x'.repeat(600) + '<script src="assets/js/data.js?v=2"></script></body></html>\n';
const DATA = `const SALON = { reservationEndpoint: '${ENDPOINT}' };`;
const wait = async () => {};

function site(overrides = {}) {
  const calls = [];
  const routes = { [BASE]: [200, PAGE], [BASE + 'reserve.html']: [200, PAGE],
    [BASE + 'assets/css/style.css?v=1']: [200, 'body{}'], [BASE + 'assets/js/data.js?v=2']: [200, DATA],
    [ENDPOINT]: [200, JSON.stringify({ ok: true, coupons: [] })], ...overrides };
  for (const name of EXTRA_PAGES) routes[BASE + name] ??= [200, PAGE];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    const route = routes[url] || [404, 'not found'];
    if (route instanceof Error) throw route;
    return { status: route[0], text: async () => route[1] };
  };
  return { calls, fetchImpl };
}

test('サイトマップの全ページ・追加ページ・参照ファイル・非公開の境界を読取だけで確認する', async () => {
  const { calls, fetchImpl } = site();
  const summary = await runMonitor({ fetchImpl, sitemapXml: SITEMAP, wait });
  assert.deepEqual(summary, { ok: true, pages: 2 + EXTRA_PAGES.length, assets: 2,
    privatePaths: PRIVATE_PATHS.length, backend: 'skipped', failures: [] });
  assert.ok(calls.every(call => call.method === 'GET'), '既定では受け口へ送信しない');
  assert.ok(!calls.some(call => call.url === ENDPOINT));
  assert.ok(!calls.some(call => call.url.startsWith('https://other.invalid')), '外部のファイルは取得しない');
});

test('ページの障害・壊れたHTML・参照ファイルの欠落を失敗として報告する', async () => {
  const { fetchImpl } = site({ [BASE + 'reserve.html']: [503, 'unavailable'],
    [BASE + EXTRA_PAGES[0]]: [200, '<html>short</html>'], [BASE + 'assets/css/style.css?v=1']: [404, ''] });
  const summary = await runMonitor({ fetchImpl, sitemapXml: SITEMAP, wait });
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failures, [{ target: BASE + 'reserve.html', reason: 'http-503' },
    { target: BASE + EXTRA_PAGES[0], reason: 'incomplete-html' },
    { target: BASE + 'assets/css/style.css?v=1', reason: 'http-404' }]);
});

test('一時的な失敗は上限まで再試行し、回復すれば成功にする', async () => {
  let failuresLeft = MAX_ATTEMPTS - 1;
  const { fetchImpl } = site();
  const flaky = async (url, options) => {
    if (url === BASE && failuresLeft-- > 0) throw new TypeError('fetch failed');
    return fetchImpl(url, options);
  };
  assert.equal((await runMonitor({ fetchImpl: flaky, sitemapXml: SITEMAP, wait })).ok, true);
  const down = async (url, options) => {
    if (url === BASE) throw Object.assign(new Error('late'), { name: 'TimeoutError' });
    return fetchImpl(url, options);
  };
  assert.deepEqual((await runMonitor({ fetchImpl: down, sitemapXml: SITEMAP, wait })).failures,
    [{ target: BASE, reason: 'timeout' }]);
});

test('内部ファイルが配信されていたら検出する', async () => {
  const { fetchImpl } = site({ [BASE + PRIVATE_PATHS[0]]: [200, '# 内部記録'] });
  const summary = await runMonitor({ fetchImpl, sitemapXml: SITEMAP, wait });
  assert.deepEqual(summary.failures, [{ target: BASE + PRIVATE_PATHS[0], reason: 'private-file-exposed' }]);
});

test('受け口の確認は指定した場合だけ、予約画面と同じ読取を一種類送る', async () => {
  const { calls, fetchImpl } = site();
  const summary = await runMonitor({ fetchImpl, sitemapXml: SITEMAP, wait, checkBackend: true });
  assert.equal(summary.ok, true);
  assert.equal(summary.backend, 'ok');
  const posts = calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, ENDPOINT);
  assert.deepEqual(JSON.parse(posts[0].body), { type: 'menu', booking: true, initialAvailability: false });
  assert.ok(!JSON.stringify(summary).includes('FIXTURE_MONITOR'), '接続先を結果に出さない');
});

test('受け口の拒否・不正な応答・接続先の欠落を失敗にする', async () => {
  for (const [override, reason] of [
    [{ [ENDPOINT]: [200, JSON.stringify({ ok: false, error: '台帳を確認できません' })] }, 'invalid-response'],
    [{ [ENDPOINT]: [200, '<html>error</html>'] }, 'invalid-response'],
    [{ [ENDPOINT]: [500, ''] }, 'http-500'],
    [{ [BASE + 'assets/js/data.js?v=2']: [200, 'const SALON = {};'] }, 'endpoint-not-found']]) {
    const summary = await runMonitor({ ...site(override), sitemapXml: SITEMAP, wait, checkBackend: true });
    assert.deepEqual(summary.failures, [{ target: 'booking-backend', reason }]);
    assert.equal(summary.backend, 'failed');
    assert.ok(!JSON.stringify(summary).includes('台帳'), '応答本文を結果に出さない');
  }
});

test('空のサイトマップは確認対象なしの成功にしない', async () => {
  const summary = await runMonitor({ ...site(), sitemapXml: '<urlset></urlset>', wait });
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failures, [{ target: 'sitemap.xml', reason: 'no-pages' }]);
});

test('実際のサイトマップと公開ページから確認対象を取り出せる', async () => {
  const urls = sitemapUrls(await readFile(new URL('../sitemap.xml', import.meta.url), 'utf8'));
  assert.ok(urls.length >= 7 && urls.every(url => url.startsWith('https://')));
  const html = await readFile(new URL('../reserve.html', import.meta.url), 'utf8');
  const assets = assetUrls(html, urls[0]);
  assert.ok(assets.some(url => new URL(url).pathname.endsWith('/assets/js/data.js')));
  assert.ok(assets.some(url => new URL(url).pathname.endsWith('/assets/js/reserve.js')));
});

test('監視workflowは読取権限だけで、受け口の確認を既定で送らない', async () => {
  const workflow = await readFile(new URL('../.github/workflows/monitor-site.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /contents: write|pages: write|write-all/);
  assert.match(workflow, /^    - cron: /m);
  assert.match(workflow, /MONITOR_BACKEND_READ: \$\{\{ vars\.MONITOR_BACKEND_READ }}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /uses: [^\n@]+@v\d/, 'actionは他のworkflowと同じく固定の版を使う');
});
