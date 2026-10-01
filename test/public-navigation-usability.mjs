import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createMockHandler } from './mock-gas.mjs';
import { isPublicMapFrame, mapFixture } from './public-map-fixture.mjs';

const PAGES = ['index', 'gallery', 'menu', 'staff', 'reviews', 'reserve', 'mypage', 'privacy', '404'];
const NAV_LABELS = ['サロンTOP', 'スタイル', 'メニュー・料金', 'スタッフ', 'アクセス', '口コミ'];
const TEST_BROWSER = process.env.TEST_BROWSER || 'chromium';
const NEXT_CONTROL_KEY = TEST_BROWSER === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const browserType = engines[TEST_BROWSER];
assert.ok(browserType && typeof browserType.launch === 'function', '指定した試験用ブラウザが利用できる');
const browser = await browserType.launch(TEST_BROWSER === 'chromium' && process.env.CHROMIUM
  ? { executablePath: process.env.CHROMIUM } : {});
let handler;
const server = http.createServer((request, response) => handler(request, response));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
handler = createMockHandler({ port: server.address().port });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function withPage(name, width, run, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo', ...options });
  const forbidden = [];
  const errors = [];
  await context.route('**/*', route => {
    const request = route.request();
    if (isPublicMapFrame(request)) return route.fulfill(mapFixture);
    if (new URL(request.url()).origin !== base) { forbidden.push('外部接続'); return route.abort(); }
    if (request.method() !== 'GET') {
      const type = new URL(request.url()).pathname === '/exec' ? request.postDataJSON().type : '';
      if (!['menu', 'availability'].includes(type)) { forbidden.push(type || request.method()); return route.abort(); }
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/${name}.html`);
    if (['reserve', 'mypage'].includes(name)) await page.waitForFunction(() => Catalog.loaded);
    await run(page);
    assert.deepEqual(forbidden, [], '実API・外部素材・予約や台帳の更新へ接続しない');
    assert.deepEqual(errors, [], 'ナビゲーション操作でもJavaScriptエラーなし');
  } finally { await context.close(); }
}

async function checkControls(page, selectors) {
  const boxes = [];
  for (const selector of selectors) {
    const control = page.locator(selector);
    assert.equal(await control.isVisible(), true, `${selector}が見える`);
    const box = await control.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `${selector}を押しやすい大きさにする`);
    boxes.push(box);
  }
  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) assert.ok(box.x + box.width <= other.x
      || other.x + other.width <= box.x || box.y + box.height <= other.y
      || other.y + other.height <= box.y, '操作領域を重ねない');
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}

async function saveScreenshot(page, name) {
  if (!process.env.TEST_ARTIFACT_DIR) return;
  await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `${name}.png`) });
}

for (const width of [320, 390, 700]) {
  test(`${width}px：紹介ナビをたたみ、予約と予約確認を残して写真を先に見せる`, () =>
    withPage('index', width, async page => {
      assert.equal(await page.locator('#site-menu-toggle').count(), 1);
      const toggle = page.getByRole('button', { name: 'サイトメニュー', exact: true });
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await toggle.getAttribute('aria-controls'), 'site-main-menu');
      assert.equal(await page.locator('#site-main-menu').isVisible(), false);
      assert.ok((await page.locator('.site-header').boundingBox()).height <= 150, '通常サイズの上部を3段ナビで埋めない');
      await checkControls(page, ['#site-menu-toggle', '.header-actions a[href="reserve.html"]', '.reservation-link']);
      const photo = await page.locator('#home-photo img').boundingBox();
      const booking = await page.locator('.sp-cta').boundingBox();
      if (width <= 640) assert.ok(booking, 'スマホ幅には固定の予約入口を残す');
      assert.ok(photo.height > 0 && photo.y + photo.height <= (booking?.y ?? page.viewportSize().height),
        '店内写真全体を最初の画面で確認できる');
      assert.equal(await page.locator('#home-styles .style-card').count(), 4, '既存のスタイル写真を減らさない');
      await saveScreenshot(page, `closed-${width}`);
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#site-main-menu').isVisible(), true);
      assert.deepEqual(await page.locator('#site-main-menu a').allTextContents(), NAV_LABELS);
      await checkControls(page, ['#site-menu-toggle', '.reservation-link',
        ...await page.locator('#site-main-menu a').evaluateAll(links => links.map(link => `#site-main-menu a[href="${link.getAttribute('href')}"]`))]);
      await saveScreenshot(page, `open-${width}`);
    }));
}

for (const width of [768, 1280]) {
  test(`${width}px：広い画面では紹介ナビを常時表示し、不要な開閉ボタンを出さない`, () =>
    withPage('gallery', width, async page => {
      assert.equal(await page.locator('#site-menu-toggle').count(), 1);
      assert.equal(await page.locator('#site-menu-toggle').isVisible(), false);
      assert.equal(await page.locator('#site-main-menu').isVisible(), true);
      assert.deepEqual(await page.locator('#site-main-menu a').allTextContents(), NAV_LABELS);
      assert.equal(await page.locator('#site-main-menu [aria-current="page"]').getAttribute('href'), 'gallery.html');
      await checkControls(page, ['.header-actions a[href="reserve.html"]', '.reservation-link',
        ...await page.locator('#site-main-menu a').evaluateAll(links => links.map(link => `#site-main-menu a[href="${link.getAttribute('href')}"]`))]);
      await saveScreenshot(page, `desktop-${width}`);
    }));
}

test('公開9ページで同じ開閉操作を使え、閉じたままでも予約確認に進める', async () => {
  for (const name of PAGES) await withPage(name, 390, async page => {
    assert.equal(await page.locator('#site-menu-toggle').count(), 1, `${name}にも共通の開閉操作がある`);
    assert.equal(await page.locator('#site-menu-toggle').getAttribute('aria-expanded'), 'false');
    await page.locator('#site-menu-toggle').click();
    assert.equal(await page.locator('#site-main-menu a:visible').count(), 6);
    await page.locator('#site-menu-toggle').click();
    assert.equal(await page.locator('#site-main-menu').isVisible(), false);
    await page.locator('.reservation-link').click();
    await page.waitForURL(`${base}/mypage.html`);
    assert.equal(await page.locator('.reservation-link').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#site-menu-toggle').getAttribute('aria-expanded'), 'false');
  });
});

for (const width of [320, 1280]) {
  test(`${width}px：本文へのショートカットを最初のキーボード操作で使える`, () =>
    withPage('index', width, async page => {
      const skip = page.getByRole('link', { name: '本文へ移動', exact: true });
      assert.equal(await skip.count(), 1);
      const first = await page.evaluate(() => [...document.querySelectorAll('a[href], button')]
        .find(element => element.getClientRects().length && !element.disabled)?.classList.contains('skip-link'));
      assert.equal(first, true, '本文への操作を店名やナビより前に置く');
      await page.keyboard.press(NEXT_CONTROL_KEY);
      assert.equal(await skip.evaluate(link => document.activeElement === link), true, '最初のキーボード操作で実際に本文へのリンクを選べる');
      const box = await skip.boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.height >= 44, 'フォーカス中は画面内で読みやすく表示する');
      await page.keyboard.press('Enter');
      assert.equal(new URL(page.url()).hash, '#main-content');
      assert.equal(await page.locator('#main-content').evaluate(main => document.activeElement === main), true,
        '見た目のスクロールだけでなく、操作位置も本文へ移す');
      assert.equal(await page.locator('#main-content').getAttribute('tabindex'), '-1', '通常のTab順に大きな本文枠を追加しない');
    }));
}

test('開閉をキーボードで操作でき、Escapeでは閉じて元のボタンへ戻る', () =>
  withPage('gallery', 390, async page => {
    assert.equal(await page.locator('#site-menu-toggle').count(), 1);
    const toggle = page.locator('#site-menu-toggle');
    await toggle.focus();
    await page.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await page.locator('#site-main-menu a').last().focus();
    await page.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.evaluate(button => document.activeElement === button), true);
    await page.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  }));

test('閉じたメニューのリンクへTabが入り込まず、開くと6つのリンクへ進める', () =>
  withPage('index', 390, async page => {
    const toggle = page.locator('#site-menu-toggle');
    assert.equal(await toggle.count(), 1);
    await toggle.focus();
    await page.keyboard.press(NEXT_CONTROL_KEY);
    assert.equal(await page.locator('.reservation-link').evaluate(link => document.activeElement === link), true);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press(NEXT_CONTROL_KEY);
    assert.equal(await page.locator('#site-main-menu a').first().evaluate(link => document.activeElement === link), true);
  }));

test('再描画で開いているメニューや現在の操作位置を失わない', () =>
  withPage('gallery', 390, async page => {
    assert.equal(await page.locator('#site-menu-toggle').count(), 1);
    await page.locator('#site-menu-toggle').click();
    const current = page.locator('#site-main-menu a[href="gallery.html"]');
    await current.focus();
    await page.evaluate(() => renderHeader());
    assert.equal(await page.locator('#site-menu-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await current.evaluate(link => document.activeElement === link), true);
    await page.evaluate(() => { SALON.tel = ''; renderHeader(); wireImageFallbacks(); });
    assert.equal(await page.locator('#site-menu-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await current.evaluate(link => document.activeElement === link), true, '実際にHTMLが変わる再描画後も同じリンクへ戻す');
  }));

test('画面サイズ変更でナビを隠しっぱなしにせず、隠れた操作へフォーカスを残さない', () =>
  withPage('gallery', 768, async page => {
    assert.equal(await page.locator('#site-menu-toggle').count(), 1);
    await page.locator('#site-main-menu a[href="gallery.html"]').focus();
    await page.setViewportSize({ width: 700, height: 844 });
    await page.waitForFunction(() => document.querySelector('#site-main-menu').hidden);
    assert.equal(await page.locator('#site-menu-toggle').evaluate(button => document.activeElement === button), true);
    await page.setViewportSize({ width: 701, height: 844 });
    await page.waitForFunction(() => !document.querySelector('#site-main-menu').hidden);
    assert.equal(await page.locator('#site-menu-toggle').isVisible(), false);
    assert.equal(await page.locator('#site-main-menu a[href="gallery.html"]').evaluate(link => document.activeElement === link), true);
  }));

test('同じページのアクセスへ進むとナビを閉じ、店舗情報へ操作位置も移す', () =>
  withPage('index', 390, async page => {
    assert.equal(await page.locator('#site-menu-toggle').count(), 1);
    await page.locator('#site-menu-toggle').click();
    await page.locator('#site-main-menu a[href="index.html#info"]').click();
    assert.equal(new URL(page.url()).hash, '#info');
    assert.equal(await page.locator('#site-main-menu').isVisible(), false);
    assert.equal(await page.locator('#info').evaluate(info => document.activeElement === info), true);
    assert.equal(await page.locator('#info iframe').count(), 1, '既存の店舗地図も残す');
  }));

test('文字を拡大しても開閉と予約確認を重ねず、ナビの中に別のスクロールを作らない', () =>
  withPage('index', 320, async page => {
    assert.equal(await page.locator('#site-menu-toggle').count(), 1);
    await page.addStyleTag({ content: '#site-menu-toggle, .reservation-link, .site-nav a { font-size:24px !important; }' });
    await checkControls(page, ['#site-menu-toggle', '.reservation-link']);
    await page.locator('#site-menu-toggle').click();
    await checkControls(page, ['#site-menu-toggle', '.reservation-link', '#site-main-menu a[href="gallery.html"]']);
    assert.equal(await page.locator('#site-main-menu').evaluate(nav => getComputedStyle(nav).overflowY), 'visible');
  }));
