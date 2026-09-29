import assert from 'node:assert/strict';
import { mockBookingState } from './booking-state-fixture.mjs';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createMockHandler } from './mock-gas.mjs';
import { isPublicMapFrame, mapFixture } from './public-map-fixture.mjs';

const WIDTHS = [320, 390, 768, 1280];
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

async function openPage(name, width = 390, active = false) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await context.route('**/*', route => {
    if (isPublicMapFrame(route.request())) return route.fulfill(mapFixture);
    return new URL(route.request().url()).origin === base ? route.continue() : route.abort();
  });
  await mockBookingState(context, { approved: active, draft: !active });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/${name}.html`, { waitUntil: 'load' });
  return { context, page, errors };
}

test('全画面幅で6つの主ナビと予約済みの入口を横スクロールなしで押せる', async () => {
  for (const width of WIDTHS) {
    const { context, page, errors } = await openPage('gallery', width);
    try {
      const nav = page.locator('.site-nav');
      assert.deepEqual(await nav.locator('a').allTextContents(), ['サロンTOP', 'スタイル', 'メニュー・料金', 'スタッフ', 'アクセス', '口コミ']);
      assert.equal(await nav.locator('a[href="reserve.html"], a[href="mypage.html"]').count(), 0, '新規・既存の手続きと店の紹介を混在させない');
      assert.equal(await nav.locator('[aria-current="page"]').getAttribute('href'), 'gallery.html');
      assert.equal(await nav.evaluate(element => element.scrollWidth > element.clientWidth), false);
      const controls = page.locator('.site-header a');
      const rectangles = await controls.evaluateAll(links => links.filter(link => link.getClientRects().length).map(link => {
        const bounds = link.getBoundingClientRect();
        return { text: link.textContent, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, height: bounds.height };
      }));
      for (const [index, rectangle] of rectangles.entries()) {
        assert.ok(rectangle.left >= 0 && rectangle.right <= width, `${rectangle.text}が画面内にある`);
        assert.ok(rectangle.height >= 44, `${rectangle.text}の高さが44px以上`);
        for (const other of rectangles.slice(index + 1)) {
          assert.ok(rectangle.right <= other.left || other.right <= rectangle.left || rectangle.bottom <= other.top || other.bottom <= rectangle.top,
            `${rectangle.text}と${other.text}が重ならない`);
        }
      }
      const existing = page.locator('.reservation-link');
      assert.match(await existing.innerText(), /予約済みの方/);
      if (process.env.TEST_ARTIFACT_DIR) {
        await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `navigation-${width}.png`) });
      }
      await existing.focus();
      await page.keyboard.press('Enter');
      await page.waitForURL(`${base}/mypage.html`);
      assert.equal(new URL(page.url()).pathname, '/mypage.html');
      assert.equal(await page.locator('.reservation-link').getAttribute('aria-current'), 'page');
      const lookup = page.locator('.reservation-lookup-link');
      await lookup.focus();
      await page.keyboard.press('Enter');
      await page.waitForURL(`${base}/mypage.html#lookup-box`);
      assert.equal(new URL(page.url()).hash, '#lookup-box');
      assert.equal(await page.locator('#lookup-code').isVisible(), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('トップ以外のページからもアクセスを開き、店舗地図へ到達する', async () => {
  const { context, page, errors } = await openPage('menu');
  try {
    await page.locator('.site-nav a[href="index.html#info"]').click();
    assert.equal(new URL(page.url()).pathname, '/index.html');
    assert.equal(new URL(page.url()).hash, '#info');
    assert.equal(await page.locator('#info').isVisible(), true);
    assert.equal(await page.locator('#info iframe').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('準備中も既存予約へ進めるが、新規の予約フォームは開かない', async () => {
  const { context, page, errors } = await openPage('reserve', 320);
  try {
    await page.waitForFunction(() => Catalog.loaded);
    const notice = page.locator('#booking-paused-notice');
    assert.match(await notice.innerText(), /新しいご予約/);
    assert.match(await notice.innerText(), /すでに予約済みの方/);
    assert.equal(await notice.locator('a[href^="tel:"]').count(), 1);
    assert.equal(await page.locator('#reserve-layout').isVisible(), false);
    assert.equal(await page.locator('#step-cta').isVisible(), false);
    await notice.locator('a[href="mypage.html"]').click();
    assert.equal(new URL(page.url()).pathname, '/mypage.html');
    assert.match(await page.locator('h1').innerText(), /確認・変更・キャンセル/);
    await page.locator('#lookup-btn').click();
    assert.ok((await page.locator('#lookup-error').innerText()).trim(), '照会の必須入力を維持する');
    assert.equal(await page.locator('#lookup-result .booking-card').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('トップと404の予約ボタンは準備中と受付中で正しく案内を切り替える', async () => {
  for (const active of [false, true]) {
    for (const name of ['index', '404']) {
      const { context, page, errors } = await openPage(name, 390, active);
      try {
        const label = active ? '空き時間を見る' : '予約方法を見る';
        const links = page.locator('.header-actions a[href="reserve.html"], main a[href="reserve.html"]:not(.style-book), .sp-cta a[href="reserve.html"]');
        const texts = await links.allInnerTexts();
        assert.ok(texts.length >= 3);
        assert.ok(texts.every(text => text.trim() === label), `${name}・受付${active}：${texts.join(' / ')}`);
        await page.locator('.header-actions a[href="reserve.html"]').click();
        await page.waitForFunction(() => Catalog.loaded);
        assert.equal(await page.locator('#reserve-layout').isVisible(), active);
        assert.equal(await page.locator('#booking-paused-notice').isVisible(), !active);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  }
});
