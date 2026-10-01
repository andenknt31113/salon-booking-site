import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createMockHandler } from './mock-gas.mjs';
import { isPublicMapFrame, mapFixture } from './public-map-fixture.mjs';

const WIDTHS = [320, 390, 768, 1280];
const PAGES = ['index', 'gallery', 'menu', 'staff', 'reviews', 'reserve', 'mypage', 'privacy', '404'];
const TEST_BROWSER = process.env.TEST_BROWSER || 'chromium';
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

async function withLogo(name, width, outcome, run) {
  const context = await browser.newContext({ viewport: { width, height: 900 },
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const writes = [];
  const external = [];
  const errors = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await context.route('**/*', route => {
    const request = route.request();
    if (request.method() !== 'GET') { writes.push(request.method()); return route.abort(); }
    if (isPublicMapFrame(request)) return route.fulfill(mapFixture);
    if (new URL(request.url()).origin !== base) { external.push(request.url()); return route.abort(); }
    return route.continue();
  });
  await context.route(`${base}/exec`, route => {
    const request = route.request();
    const type = request.method() === 'POST' ? request.postDataJSON().type : '';
    if (['menu', 'availability'].includes(type)) return route.continue();
    writes.push(type || request.method());
    return route.abort();
  });
  await context.route('**/logo-hpb.jpg', async route => {
    await gate;
    return outcome === 'failure' ? route.abort() : route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/${name}.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('.header-top .wm-name').waitFor({ state: 'visible' });
    await page.locator('.footer-brand .wm-name').waitFor({ state: 'visible' });
    if (['reserve', 'mypage'].includes(name)) await page.waitForFunction(() => Catalog.loaded);
    await run(page, release);
    assert.deepEqual(writes, [], '表示の試験は予約・台帳の更新処理へ送信しない');
    assert.deepEqual(external, [], '実API・外部素材へ接続しない');
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
  } finally {
    release();
    await context.close();
  }
}

async function positions(page) {
  return page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return {
      header: box('.header-top'), name: box('.header-top .wordmark'),
      booking: box('.header-actions a[href="reserve.html"]'),
      footer: box('.footer-brand .wordmark'), heading: box('main h1')
    };
  });
}

async function logoIsReady(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.brand-lockup')]
    .every(lockup => lockup.classList.contains('is-image')));
}

async function saveScreenshot(page, name) {
  if (!process.env.TEST_ARTIFACT_DIR) return;
  await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `${name}.png`) });
}

for (const width of WIDTHS) {
  test(`${width}px：遅いロゴの到着でも店名・予約ボタン・本文・フッターを動かさない`, () =>
    withLogo('index', width, 'success', async (page, release) => {
      const before = await positions(page);
      assert.equal(await page.locator('.header-top .brand-logo').evaluate(image => image.complete), false);
      assert.equal(await page.locator('.header-top .brand-logo').isVisible(), false, '未読込の画像アイコンは出さない');
      release();
      await logoIsReady(page);
      assert.deepEqual(await positions(page), before, '画像の到着で読む位置・押す位置を動かさない');
      const logo = await page.locator('.header-top .brand-logo').boundingBox();
      assert.ok(logo.width > 0 && logo.height > 0, '既存のロゴを消さない');
      const brand = await page.locator('.header-top .brand').boundingBox();
      const booking = await page.locator('.header-actions a[href="reserve.html"]').boundingBox();
      assert.ok(brand.x + brand.width <= booking.x, 'ロゴと店名を予約ボタンへ重ねない');
      assert.ok(booking.width >= 44 && booking.height >= 44, '予約ボタンの押しやすさを維持する');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await saveScreenshot(page, `loaded-${width}`);
    }));

  test(`${width}px：ロゴの取得が失敗しても店名と予約の位置を保ち、壊れた画像を残さない`, () =>
    withLogo('index', width, 'failure', async (page, release) => {
      const before = await positions(page);
      release();
      await page.waitForFunction(() => document.querySelectorAll('.brand-lockup img').length === 0);
      assert.deepEqual(await positions(page), before, '失敗後も店名・操作・本文の位置を変えない');
      const gap = await page.locator('.header-top .brand').evaluate(brand => {
        const name = brand.querySelector('.wordmark').getBoundingClientRect();
        return name.left - brand.getBoundingClientRect().left;
      });
      assert.ok(gap > 0 && gap <= 64, '小さなロゴの領域だけを残し、大きな空白を作らない');
      assert.deepEqual(await page.locator('.header-top .wm-name, .header-top .wm-sub').allTextContents(),
        ['ZER01', 'barber/lounge'], '店名は画像の成功に依存しない');
      assert.equal(await page.getByRole('link', { name: 'ZER01 barber/lounge', exact: true }).isVisible(), true);
      assert.equal(await page.locator('.header-actions a[href="reserve.html"]').isVisible(), true);
      await saveScreenshot(page, `failed-${width}`);
    }));
}

test('公開9ページでロゴ到着前後のヘッダーとフッターを安定させる', async () => {
  for (const name of PAGES) {
    await withLogo(name, 390, 'success', async (page, release) => {
      const before = await positions(page);
      release();
      await logoIsReady(page);
      assert.deepEqual(await positions(page), before, `${name}のブランドと本文を後から動かさない`);
    });
  }
});

test('ロゴの再描画でも店名と操作を動かさず、指定サイズと装飾画像の扱いを守る', () =>
  withLogo('index', 390, 'success', async (page, release) => {
    const before = await positions(page);
    await page.evaluate(() => { renderHeader(); renderFooter(); wireImageFallbacks(); });
    assert.deepEqual(await positions(page), before);
    release();
    await logoIsReady(page);
    assert.deepEqual(await positions(page), before);
    const sizes = await page.locator('.brand-lockup img').evaluateAll(images => images.map(image => ({
      width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height,
      alt: image.alt, hidden: image.getAttribute('aria-hidden'), fit: getComputedStyle(image).objectFit
    })));
    assert.deepEqual(sizes, [
      { width: 38, height: 38, alt: '', hidden: 'true', fit: 'contain' },
      { width: 40, height: 40, alt: '', hidden: 'true', fit: 'contain' }
    ], 'ヘッダーとフッターの指定サイズで全体を表示し、店名を重複読み上げしない');
  }));

test('ロゴが未設定・非表示の指定なら、不要な画像枠を作らず文字だけを表示する', () =>
  withLogo('index', 390, 'success', async (page, release) => {
    release();
    await logoIsReady(page);
    const omitted = await page.evaluate(() => {
      const logoDisabled = brandLockup({ logo: false });
      SALON.logo = '';
      const logoMissing = brandLockup();
      renderHeader(); renderFooter(); wireImageFallbacks();
      return [logoDisabled, logoMissing].map(html => {
        const host = document.createElement('div');
        host.innerHTML = html;
        return { images: host.querySelectorAll('img').length,
          lockups: host.querySelectorAll('.brand-lockup').length,
          name: host.querySelector('.wm-name').textContent };
      });
    });
    assert.deepEqual(omitted, [
      { images: 0, lockups: 0, name: 'ZER01' }, { images: 0, lockups: 0, name: 'ZER01' }
    ]);
    assert.equal(await page.locator('.brand-logo').count(), 0);
    assert.equal(await page.locator('.header-top .brand-mark').isVisible(), true);
    assert.equal(await page.locator('.header-actions a[href="reserve.html"]').isVisible(), true);
  }));
