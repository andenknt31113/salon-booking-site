import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createMockHandler } from './mock-gas.mjs';
import { isPublicMapFrame, mapFixture } from './public-map-fixture.mjs';

const PAGES = ['index', 'gallery', 'menu', 'staff', 'reviews', 'privacy', '404'];
const MOBILE_WIDTHS = [320, 390, 640];
const VIEWPORT_HEIGHT = 568;
const BOUNDARY_TOLERANCE = 1;
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
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

async function withPage(name, width, run) {
  const context = await browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT },
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo', reducedMotion: 'reduce' });
  const forbidden = [];
  const errors = [];
  await context.route('**/*', route => {
    const request = route.request();
    if (isPublicMapFrame(request)) return route.fulfill(mapFixture);
    if (request.method() !== 'GET' || new URL(request.url()).origin !== base) {
      forbidden.push(request.method());
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/${name}.html`);
    await run(page);
    assert.deepEqual(forbidden, [], '外部接続・実予約・台帳への書込を行わない');
    assert.deepEqual(errors, [], 'キーボード操作でJavaScriptエラーを出さない');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
      'スクロール位置の調整で横にはみ出さない');
  } finally {
    await context.close();
  }
}

async function saveScreenshot(page, name) {
  if (!process.env.TEST_ARTIFACT_DIR) return;
  await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `${name}.png`) });
}

for (const width of MOBILE_WIDTHS) {
  test(`${width}px：公開7ページのTab移動先を固定予約バーで隠さない`, async () => {
    for (const name of PAGES) await withPage(name, width, async page => {
      const links = page.locator('.footer-grid li a');
      const booking = page.locator('.sp-cta');
      assert.equal(await booking.isVisible(), true, '固定の予約入口を維持する');
      await links.first().focus();
      for (let index = 1; index < await links.count(); index++) {
        await page.keyboard.press('Tab');
        const link = links.nth(index);
        const state = await link.evaluate(element => {
          const rectangle = element.getBoundingClientRect();
          const bar = document.querySelector('.sp-cta').getBoundingClientRect();
          const front = document.elementFromPoint(rectangle.x + rectangle.width / 2,
            rectangle.y + rectangle.height / 2);
          return { active: document.activeElement === element,
            focusVisible: element.matches(':focus-visible'), label: element.textContent.trim(),
            top: rectangle.top, bottom: rectangle.bottom, bookingTop: bar.top,
            obscured: !!front?.closest('.sp-cta') };
        });
        assert.ok(state.active && state.focusVisible, `${name}の${state.label}へTabで移動する`);
        if (state.label === '口コミ' || state.obscured) await saveScreenshot(page, `${name}-${width}-focus-${index}`);
        assert.ok(state.top >= 0 && state.bottom <= state.bookingTop + BOUNDARY_TOLERANCE,
          `${name}の${state.label}全体を固定予約バーより上に表示する`);
        assert.equal(state.obscured, false, `${name}の${state.label}を予約バーで覆わない`);
      }
      const href = await links.last().getAttribute('href');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]);
      assert.equal(page.url(), new URL(href, base).href);
      assert.equal(await page.locator('h1').count(), 1, '最後のリンクからも実際に移動できる');
    });
  });
}

test('1280px：固定バーのない画面でもフッターをTabとEnterで使える', async () => {
  for (const name of PAGES) await withPage(name, 1280, async page => {
    assert.equal(await page.locator('.sp-cta').isVisible(), false);
    const links = page.locator('.footer-grid li a');
    await links.first().focus();
    for (let index = 1; index < await links.count(); index++) {
      await page.keyboard.press('Tab');
      assert.equal(await links.nth(index).evaluate(element => document.activeElement === element), true);
    }
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]);
    assert.equal(page.url(), `${base}/privacy.html`);
  });
});
