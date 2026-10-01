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
const PAGES = ['index', 'gallery', 'menu', 'staff', 'reviews', 'reserve', 'mypage', 'privacy', '404'];
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

async function openPage(name, width = 390, paused = false) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await context.route('**/*', route => {
    if (isPublicMapFrame(route.request())) return route.fulfill(mapFixture);
    return new URL(route.request().url()).origin === base ? route.continue() : route.abort();
  });
  if (paused) await mockBookingState(context, { approved: false, draft: true });
  const page = await context.newPage();
  await page.goto(`${base}/${name}.html`, { waitUntil: 'load' });
  return { context, page };
}

test('公開9ページの色・ヘッダー・余白を揃え、4画面幅で本文をはみ出させない', async () => {
  for (const width of WIDTHS) {
    let homeShell;
    for (const name of PAGES) {
      const { context, page } = await openPage(name, width);
      try {
        const shell = await page.evaluate(() => {
          const header = document.querySelector('.header-top');
          const rectangle = header.getBoundingClientRect();
          return {
            paper: getComputedStyle(document.body).backgroundColor,
            header: getComputedStyle(document.querySelector('.site-header')).backgroundColor,
            padding: getComputedStyle(header).paddingBlock,
            left: rectangle.left, width: rectangle.width
          };
        });
        if (name === 'index') homeShell = shell;
        assert.deepEqual(shell, homeShell, `${name}・幅${width}でもトップと同じ外観の枠組み`);
        assert.equal(shell.paper, 'rgb(245, 242, 235)');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
          `${name}・幅${width}でページ全体の横スクロールがない`);
        assert.equal(await page.locator('main h1').count(), 1);
        if (!['index', '404'].includes(name)) {
          assert.equal(await page.locator('.page-head').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
          assert.equal(await page.locator('.page-kicker').isVisible(), true);
        }
        if (name === 'gallery') {
          assert.equal(await page.locator('#style-list .style-card').count(), 12, '写真を減らさない');
          const columns = await page.locator('#style-list').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
          assert.equal(columns, width < 360 ? 1 : width <= 700 ? 2 : 3);
          const first = await page.locator('.style-thumb').first().boundingBox();
          const copy = await page.locator('.style-body').first().boundingBox();
          assert.ok(first.y + first.height <= copy.y, '写真と文章を重ねない');
        }
        if (process.env.TEST_ARTIFACT_DIR && ['gallery', 'menu', 'staff', 'reserve', 'mypage'].includes(name)) {
          await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `${name}-${width}.png`), fullPage: true });
          if (['gallery', 'menu'].includes(name)) {
            await page.locator(name === 'gallery' ? '#style-list' : '#coupon-list').scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `${name}-${width}-detail.png`) });
          }
        }
      } finally { await context.close(); }
    }
  }
});

test('トップからスタイル一覧へ進み、分類の絞込みと予約案内・戻る道を使える', async () => {
  const { context, page } = await openPage('index', 390, true);
  try {
    await page.locator('.home-styles .section-more a').click();
    assert.equal(new URL(page.url()).pathname, '/gallery.html');
    const allCount = await page.locator('#style-list .style-card').count();
    const filter = page.locator('#style-tabs button[data-len="白髪ぼかし"]');
    await filter.focus();
    await page.keyboard.press('Enter');
    assert.equal(await filter.getAttribute('aria-pressed'), 'true');
    const titles = await page.locator('#style-list .style-title').allTextContents();
    assert.ok(titles.length > 0 && titles.length < allCount);
    assert.ok(titles.every(title => title.includes('白髪ぼかし')));
    assert.ok((await filter.boundingBox()).height >= 44, '押しやすい大きさを維持する');
    await page.locator('#style-tabs button[data-len="すべて"]').click();
    assert.equal(await page.locator('#style-list .style-card').count(), allCount);
    await page.locator('.style-book').first().click();
    await page.waitForURL(`${base}/reserve.html`);
    await page.waitForFunction(() => Catalog.loaded);
    assert.equal(await page.locator('#booking-paused-notice').isVisible(), true);
    assert.equal(await page.locator('.reserve-layout').isVisible(), false);
    await page.locator('.breadcrumb a').click();
    await page.waitForURL(`${base}/index.html`);
    assert.equal(new URL(page.url()).pathname, '/index.html');
  } finally { await context.close(); }
});

test('メニューの料金・条件と予約引継ぎを保ち、単品の分類も操作できる', async () => {
  const { context, page } = await openPage('menu', 390, true);
  try {
    const prices = await page.locator('#coupon-list .price-now').allTextContents();
    assert.equal(prices.length, 14);
    const singlePrices = await page.locator('#menu-list .menu-row-price').allTextContents();
    assert.equal(singlePrices.filter(price => price.includes('〜')).length, 5, '単品5件の目安料金の意味を失わない');
    assert.equal(await page.locator('#coupon-list .price-min').count(), 14);
    assert.match(await page.locator('.page-head').innerText(), /税込.*追加料金/);
    await page.locator('.page-jump a[href="#single"]').click();
    await page.locator('#menu-tabs button').nth(1).click();
    assert.equal(await page.locator('#menu-tabs button').nth(1).getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('#menu-list .menu-row').count() > 0);
    const target = page.locator('#coupon-list a[href^="reserve.html?menu="]').first();
    const href = await target.getAttribute('href');
    await target.click();
    await page.waitForURL(new URL(href, base).href);
    await page.waitForFunction(() => Catalog.loaded);
    assert.equal(new URL(page.url()).search, new URL(href, base).search);
    assert.equal(await page.locator('#booking-paused-notice').isVisible(), true);
  } finally { await context.close(); }
});

test('新しい見た目でも予約照会の必須入力を守り、管理画面には適用しない', async () => {
  const { context, page } = await openPage('mypage');
  try {
    await page.locator('#lookup-btn').click();
    assert.equal(await page.locator('#lookup-error').isVisible(), true);
    assert.ok((await page.locator('#lookup-error').innerText()).trim());
    assert.equal(await page.locator('#lookup-result .booking-card').count(), 0);
    await page.goto(base + '/admin-google.html');
    assert.equal(await page.locator('link[href*="public.css"]').count(), 0);
    await page.goto(base + '/admin.html');
    assert.equal(await page.locator('link[href*="public.css"]').count(), 0);
  } finally { await context.close(); }
});
