import { mockBookingState } from './booking-state-fixture.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const server = http.createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
server.on('request', createMockHandler({ port }));
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch(process.env.CHROMIUM
  ? { executablePath: process.env.CHROMIUM } : {});

try {
  const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await mockBookingState(context);
  const page = await context.newPage();
  const errors = [];
  const reservations = [];
  page.on('pageerror', error => errors.push(error.message));
  let responseMode = 'pending';
  let releaseMenu;
  let menuRequested;
  const menuStarted = new Promise(resolve => { menuRequested = resolve; });
  await page.route(`${base}/exec`, async route => {
    const data = JSON.parse(route.request().postData() || '{}');
    if (data.type === 'reserve') reservations.push(data);
    if (data.type !== 'menu') { await route.continue(); return; }
    if (responseMode === 'pending') {
      menuRequested();
      await new Promise(resolve => { releaseMenu = resolve; });
    }
    if (responseMode === 'error') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    } else if (responseMode === 'missing') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, settings: { '準備中の帯': '出さない' } }) });
    } else if (responseMode === 'partial') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true,
        categories: [{ id: 'cat0', name: 'カット', items: [] }], coupons: [null], closedDates: [],
        settings: { '準備中の帯': '出さない' } }) });
    } else {
      await route.continue();
    }
  });

  await page.goto(`${base}/reserve.html`, { waitUntil: 'load' });
  await menuStarted;
  assert.equal(await page.locator('#reserve-layout').isVisible(), true, '確認中も公開メニューは選べる');
  await page.locator('#coupon-choices .selectable').first().click();
  await page.locator('[data-next="2"]').first().click();
  assert.equal(await page.locator('[data-next="3"]').first().isDisabled(), true, '確認前は日時へ進まない');
  assert.match(await page.locator('#catalog-status').innerText(), /確認しています/, '読込中と分かる');
  responseMode = 'success';
  releaseMenu();
  await page.waitForFunction(() => Catalog.loaded);
  assert.equal(await page.locator('#reserve-layout').isVisible(), true, '正しい応答のあとで予約フォームを出す');

  for (const mode of ['error', 'missing', 'partial']) {
    responseMode = mode;
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => Catalog.loaded);
    assert.equal(await page.locator('#reserve-layout').isVisible(), false, `${mode}：古いメニューでは進めない`);
    assert.match(await page.locator('#catalog-status').innerText(), /確認できません/, `${mode}：取得失敗を伝える`);
    if (mode === 'error') {
      assert.equal(await page.locator('#catalog-status a[href^="tel:"]').isVisible(), true,
        '取得に失敗しても店舗へ電話できる');
    }
  }

  responseMode = 'success';
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => Catalog.loaded);
  assert.equal(await page.locator('#reserve-layout').isVisible(), true, '正常応答に戻れば再び進める');
  assert.deepEqual(reservations, [], '試験中に予約を送信しない');
  assert.deepEqual(errors, [], 'JavaScriptエラーがない');
  await context.close();
  console.log('メニュー取得失敗時の予約停止：全項目成功');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
