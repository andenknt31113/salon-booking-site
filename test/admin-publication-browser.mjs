import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const CATALOG = { categories: [{ id: 'cat0', name: '試験カット', items: [
  { id: 'sm0', name: '掲載の試験', price: 4000, priceFrom: false, minutes: 60, note: '', image: '' }
] }], coupons: [] };
const SEED = { ok: true, reservations: [], closedDates: [], styles: [], reviews: [],
  menus: [{ 区分: '試験カット', メニュー名: '掲載の試験', 価格: 4000, '所要(分)': 60, 説明: '', 画像: '', 表示: '○' }],
  coupons: [], settings: { '準備中の帯': '出さない' }, stamps: { menus: 'fixture-menu', coupons: 'fixture-coupon',
    closed: 'fixture-closed', settings: 'fixture-settings', styles: 'fixture-styles', reviews: 'fixture-reviews' } };

async function fixture(run) {
  let handler;
  const server = http.createServer((request, response) => handler(request, response));
  let browser;
  let context;
  let release;
  const reads = [];
  const unexpected = [];
  const errors = [];
  let booking = structuredClone(CATALOG);
  let published = structuredClone(CATALOG);
  let delay = false;
  let malformed = false;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    handler = createMockHandler({ port: server.address().port });
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base) { unexpected.push(url.origin); return route.abort(); }
      if (url.pathname === '/assets/js/published-menus.js') {
        return route.fulfill({ contentType: 'text/javascript', body: malformed ? 'const PUBLISHED_MENUS = (() => alert(1))();'
          : 'const PUBLISHED_MENUS = ' + JSON.stringify(published) + ';\n' });
      }
      if (url.pathname !== '/exec') return route.continue();
      const payload = request.postDataJSON();
      reads.push(payload);
      assert.deepEqual(payload, { type: 'menu', booking: true }, '照合は認証情報も書込も送らない');
      const response = structuredClone(booking);
      if (delay) await new Promise(resolve => { release = resolve; });
      return route.fulfill({ json: { ok: true, ...response, settings: { 'キャッチコピー': '書き換えてはいけない' } } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/admin.html?design=a');
    assert.equal(await page.evaluate(async seed => {
      window.fixtureWrites = [];
      adminPost = async payload => {
        if (payload.type === 'adminData') return structuredClone(seed);
        window.fixtureWrites.push(payload);
        return { ok: true, stamps: { menus: 'fixture-saved' } };
      };
      return await openDashboard();
    }, SEED), true, '初回応答が正常な模擬データで管理画面を開ける');
    await page.locator('#site-edit-tabs > summary').click();
    await page.locator('#admin-tabs [data-pane="menus"]').click();
    assert.equal(await page.locator('[data-publication-check]').count(), 2, '単品・おすすめに掲載確認を用意する');
    const pane = page.locator('.admin-pane[data-pane="menus"]');
    const button = pane.locator('[data-publication-check]');
    const status = pane.locator('[data-publication-note]');
    await run({ page, context, pane, button, status, reads,
      changeBooking(callback) { callback(booking); }, changePublished(callback) { callback(published); },
      delay() { delay = true; }, release() { delay = false; release?.(); },
      malformed() { malformed = true; }, errors });
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    release?.();
    await context?.close();
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('掲載の照合は任意の読取だけで、320〜1280pxの操作・入力・共通設定を保持する', async () => {
  await fixture(async ({ page, pane, button, status, reads }) => {
    assert.equal(reads.length, 0, '起動だけでは予約受け口の読込を増やさない');
    await page.locator('[data-target="menus"][data-col="価格"]').fill('6000');
    await button.click();
    await status.filter({ hasText: '一致しています' }).waitFor();
    assert.equal(reads.length, 1);
    assert.equal(await page.locator('[data-target="menus"][data-col="価格"]').inputValue(), '6000');
    assert.equal(await page.evaluate(() => isDirty('menus')), true);
    assert.notEqual(await page.evaluate(() => SALON.catch), '書き換えてはいけない');
    assert.match(await status.innerText(), /未保存.*含みません/);
    assert.deepEqual(await page.evaluate(() => window.fixtureWrites), []);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await button.scrollIntoViewIfNeeded();
      assert.equal(await button.isVisible(), true);
      assert.ok((await button.boundingBox()).height >= 44);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await pane.locator('[data-publication-note]').getAttribute('role'), 'status');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    if (process.env.TEST_ARTIFACT_DIR) {
      await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
      await pane.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, 'admin-publication-390.png') });
    }
  });
});

test('照合結果は両タブへ表示し、料金・非表示の差分と確認後の保存を区別する', async () => {
  await fixture(async ({ page, button, status, changeBooking, changePublished }) => {
    changeBooking(catalog => { catalog.categories[0].items[0].price = 5000; });
    await button.click();
    await status.filter({ hasText: '差分があります' }).waitFor();
    await page.locator('#admin-tabs [data-pane="coupons"]').click();
    assert.match(await page.locator('.admin-pane[data-pane="coupons"] [data-publication-note]').innerText(), /差分があります/);
    changePublished(catalog => { catalog.categories[0].items[0].price = 5000; });
    await page.locator('.admin-pane[data-pane="coupons"] [data-publication-check]').click();
    await page.locator('.admin-pane[data-pane="coupons"] [data-publication-note]').filter({ hasText: '一致しています' }).waitFor();
    await page.locator('#admin-tabs [data-pane="menus"]').click();
    await page.locator('[data-target="menus"][data-col="価格"]').fill('7000');
    await page.locator('[data-save="menus"]').click();
    await status.filter({ hasText: '未確認' }).waitFor();
    assert.match(await status.innerText(), /別途更新/);
    assert.equal(await page.evaluate(() => window.fixtureWrites.length), 1);
    changeBooking(catalog => { catalog.categories = []; });
    await button.click();
    await status.filter({ hasText: '差分があります' }).waitFor();
  });
});

test('照合中の保存と再読込で、遅い照合結果を掲載済みとして採用しない', async () => {
  await fixture(async ({ page, button, status, reads, delay, release }) => {
    delay();
    await button.click();
    await page.waitForFunction(() => document.querySelector('[data-publication-check]').disabled);
    assert.equal(reads.length, 1);
    await page.locator('[data-target="menus"][data-col="価格"]').fill('5500');
    await page.locator('[data-save="menus"]').click();
    await status.filter({ hasText: '未確認' }).waitFor();
    release();
    assert.doesNotMatch(await status.innerText(), /一致しています/);
    assert.equal(await page.locator('[data-target="menus"][data-col="価格"]').inputValue(), '5500');
    await button.click();
    await status.filter({ hasText: '一致しています' }).waitFor();
    delay();
    await button.click();
    await page.evaluate(async () => { await openDashboard(); });
    release();
    assert.match(await status.innerText(), /未確認/);
    assert.equal(await button.isEnabled(), true);
  });
});

test('公開データのJavaScriptを実行せず、不正な内容は照合不能として再試行できる', async () => {
  await fixture(async ({ page, button, status, malformed }) => {
    let dialogs = 0;
    page.on('dialog', async dialog => { dialogs += 1; await dialog.dismiss(); });
    malformed();
    await button.click();
    await status.filter({ hasText: '確認できません' }).waitFor();
    assert.equal(dialogs, 0);
    assert.equal(await button.isEnabled(), true);
    assert.doesNotMatch(await status.innerText(), /一致しています|差分があります/);
  });
});
