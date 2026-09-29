import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createMockHandler } from './mock-gas.mjs';
import { isPublicMapFrame, mapEmbedUrl, mapFixture } from './public-map-fixture.mjs';

const WIDTHS = [320, 390, 768, 1280];
const model = vm.runInNewContext(readFileSync(new URL('../assets/js/data.js', import.meta.url), 'utf8') + ';SALON');
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

async function openPage({ width = 390, javaScriptEnabled = true, blockMap = false, name = 'index.html' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, javaScriptEnabled });
  const maps = [];
  const unexpected = [];
  const errors = [];
  await context.route('**/*', route => {
    const request = route.request();
    if (isPublicMapFrame(request)) {
      maps.push(request.url());
      return blockMap ? route.abort() : route.fulfill(mapFixture);
    }
    if (new URL(request.url()).origin !== base || request.method() !== 'GET') {
      unexpected.push(request.url());
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/${name}`, { waitUntil: 'load' });
  return { context, page, maps, unexpected, errors };
}

test('地図と来店情報が各画面幅で読め、店舗情報の折りたたみをキーボードで開ける', async () => {
  for (const width of WIDTHS) {
    const { context, page, maps, unexpected, errors } = await openPage({ width });
    try {
      const map = page.locator('#home-access iframe');
      await page.locator('.hero a[href="#info"]').click();
      assert.equal(new URL(page.url()).hash, '#info', '冒頭から地図のあるアクセス欄へ移動する');
      assert.equal(await map.getAttribute('src'), mapEmbedUrl);
      assert.equal(await map.getAttribute('loading'), 'lazy');
      assert.match(await map.getAttribute('title'), /ZER01.*Googleマップ/);
      const access = await page.locator('.access-summary').innerText();
      for (const value of [model.address, model.access, model.parking, model.business.note, model.business.closedNote]) {
        assert.ok(access.includes(value), '確認済みの来店情報を省略せず表示する');
      }
      assert.equal(await page.locator('.access-tel').getAttribute('href'), 'tel:' + model.tel.replaceAll('-', ''));
      const route = new URL(await page.locator('#home-access a[href*="/maps/dir/"]').getAttribute('href'));
      assert.equal(route.searchParams.get('destination'), model.mapQuery);
      await map.scrollIntoViewIfNeeded();
      await page.frameLocator('#home-access iframe').getByText('試験用の地図', { exact: true }).waitFor();
      assert.equal(maps.length, 1, '確認済みの地図だけを一度読む');
      assert.equal(await page.evaluate(() => {
        const original = document.querySelector('#home-access iframe');
        initHome();
        return original === document.querySelector('#home-access iframe');
      }), true, '初期化し直しても地図を取り外さない');
      const rectangles = await page.evaluate(() => ['.access-summary', '.access-map'].map(selector => {
        const bounds = document.querySelector(selector).getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
      }));
      assert.ok(rectangles[0].right <= rectangles[1].left || rectangles[0].bottom <= rectangles[1].top, '地図と本文を重ねない');
      assert.equal(await page.locator('.access-details').getAttribute('open'), null);
      const summary = page.locator('.access-details summary');
      await summary.focus();
      await summary.press('Enter');
      assert.equal(await page.locator('#salon-info').isVisible(), true);
      assert.ok((await page.locator('#salon-info').innerText()).includes(model.payment));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '詳細を開いても横にはみ出さない');
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('地図が失敗しても住所・電話・経路が残り、JavaScriptなしでも口コミへ進める', async () => {
  for (const javaScriptEnabled of [false, true]) {
    const { context, page, unexpected } = await openPage({ javaScriptEnabled, blockMap: true });
    try {
      await page.locator('#home-access iframe').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('.access-address').innerText(), model.address);
      assert.equal(await page.locator('#home-access a[href*="/maps/dir/"]').isVisible(), true);
      assert.equal(await page.locator('.access-tel').isVisible(), true);
      assert.equal(await page.locator('#home-reviews a[href*="/maps/search/"]').count(), 1);
      await page.goto(base + '/reviews.html');
      assert.equal(await page.getByRole('link', { name: 'Googleで口コミを見る（別タブ）' }).isVisible(), true);
      assert.equal(await page.locator('.review-steps li').count(), 3);
      assert.equal(await page.locator('.review, #review-form, #review-list').count(), 0);
      assert.equal(await page.getByRole('link', { name: 'Googleに口コミを書く（別タブ）' }).count(), 0, '未確認URLを直接投稿と呼ばない');
      assert.equal(await page.locator('a[href="index.html#info"]').isVisible(), true);
      assert.deepEqual(unexpected, []);
    } finally { await context.close(); }
  }
});

test('地図の設定が空・不正なら埋め込まず、文章にHTMLが含まれても実行しない', async () => {
  const { context, page } = await openPage();
  try {
    for (const invalid of ['', 'javascript:alert(1)', 'https://www.google.com.example.test/maps/embed?pb=x', 'https://example.test/', 'https://www.google.com/maps/other?pb=x', 'https://user@www.google.com/maps/embed?pb=x']) {
      const result = await page.evaluate(value => {
        SALON.mapEmbedUrl = value;
        SALON.address = '<img src=x onerror=alert(1)>';
        document.querySelector('#home-access').innerHTML = homeAccessHtml();
        return {
          frames: document.querySelectorAll('#home-access iframe').length,
          images: document.querySelectorAll('#home-access img').length,
          address: document.querySelector('.access-address').textContent,
          links: document.querySelectorAll('#home-access .map-actions a').length
        };
      }, invalid);
      assert.deepEqual(result, { frames: 0, images: 0, address: '<img src=x onerror=alert(1)>', links: 2 });
    }
  } finally { await context.close(); }
});

test('口コミページも各画面幅で操作がはみ出さず、閲覧と投稿の案内を分ける', async () => {
  for (const width of WIDTHS) {
    const { context, page, unexpected, errors } = await openPage({ width, name: 'reviews.html' });
    try {
      assert.equal(await page.locator('.google-review-guide h2').count(), 2);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('a[href*="/maps/search/"]').getAttribute('target'), '_blank');
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});
