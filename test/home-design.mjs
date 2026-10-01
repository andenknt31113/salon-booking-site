import assert from 'node:assert/strict';
import { mockBookingState } from './booking-state-fixture.mjs';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createMockHandler } from './mock-gas.mjs';

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

async function openHome(options = {}, paused = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
  await context.route('**/*', route => new URL(route.request().url()).origin === base
    ? route.continue() : route.abort());
  if (paused) await mockBookingState(context, { approved: false, draft: true });
  const page = await context.newPage();
  await page.goto(base + '/index.html', { waitUntil: 'load' });
  return { context, page };
}

test('正式トップをA案の構成にし、スマホからPCまで写真・文章・操作が重ならない', async () => {
  for (const width of WIDTHS) {
    const { context, page } = await openHome({ viewport: { width, height: 900 } });
    try {
      assert.equal(await page.locator('.preview-note').count(), 0, '比較用ではなく通常のトップにする');
      assert.equal(await page.locator('.hero #hero-desc').count(), 0, '説明文は写真の次の段で読める');
      const layout = await page.evaluate(() => {
        const bounds = selector => {
          const rectangle = document.querySelector(selector)?.getBoundingClientRect();
          return rectangle && { left: rectangle.left, right: rectangle.right, top: rectangle.top, bottom: rectangle.bottom };
        };
        return {
          copy: bounds('.hero-inner'), photo: bounds('#home-photo'),
          styles: bounds('#home-styles'), menus: bounds('#home-coupons'),
          overflow: document.documentElement.scrollWidth > innerWidth
        };
      });
      assert.ok(layout.photo && layout.copy, '店内写真と本文の領域がある');
      assert.ok(width <= 700 ? layout.photo.bottom <= layout.copy.top : layout.copy.right <= layout.photo.left,
        'スマホは店内写真から、PCは文章と写真を左右に読み、どちらも重ねない');
      assert.ok(layout.styles.top < layout.menus.top, 'ヘアスタイルを料金より先に見せる');
      assert.equal(layout.overflow, false, `幅${width}で横にはみ出さない`);
      assert.equal(await page.locator('#home-styles .style-card').count(), 4, '既存のヘア写真4点を残す');
      assert.equal(await page.locator('.hero a[href="reserve.html"]').isVisible(), true, '冒頭から予約案内へ進める');
      assert.equal(await page.locator('.hero a[href="menu.html"]').isVisible(), true, '冒頭から料金へ進める');
      if (process.env.TEST_ARTIFACT_DIR) {
        await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `home-${width}.png`), fullPage: true });
      }
    } finally { await context.close(); }
  }
});

test('JavaScriptなしでも店内・ヘア写真と紹介文を読め、初期化し直しても写真を再生成しない', async () => {
  const offline = await openHome({ javaScriptEnabled: false });
  try {
    assert.equal(await offline.page.locator('#home-photo img').count(), 1);
    assert.ok(await offline.page.locator('#home-photo img').evaluate(photo => photo.complete && photo.naturalWidth > 0));
    assert.equal(await offline.page.locator('#home-styles .style-card').count(), 4);
    assert.ok((await offline.page.locator('#hero-desc').innerText()).includes('マンツーマン'));
  } finally { await offline.context.close(); }
  const { context, page } = await openHome();
  try {
    assert.equal(await page.evaluate(() => {
      const photo = document.querySelector('#home-photo img');
      initHome();
      return photo === document.querySelector('#home-photo img');
    }), true, '同じ写真を一度取り外してちらつかせない');
    assert.equal(await page.locator('#home-photo img').count(), 1);
  } finally { await context.close(); }
});

test('新トップでも予約メニューを引き継ぎ、準備中の予約は始めさせない', async () => {
  const { context, page } = await openHome({}, true);
  try {
    const link = page.locator('#home-coupons a[href^="reserve.html?"]').first();
    const target = await link.getAttribute('href');
    assert.ok(new URL(target, base).searchParams.get('menu'), 'メニューIDを維持する');
    assert.match(await link.innerText(), /予約について/);
    await link.click();
    assert.equal(new URL(page.url()).pathname, '/reserve.html');
    assert.equal(new URL(page.url()).search, new URL(target, base).search);
    assert.equal(await page.locator('#booking-paused-notice').isVisible(), true);
    assert.equal(await page.locator('#booking-paused-notice a[href^="tel:"]').isVisible(), true);
    assert.equal(await page.locator('.reserve-layout').isVisible(), false, '見た目の変更で受付停止を解除しない');
  } finally { await context.close(); }
});
