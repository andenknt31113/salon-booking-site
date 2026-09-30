import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

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

test('メニューを先に表示し、空席取得を待たせてもメニュー選択を始められる', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
  const requests = [];
  let releaseMenu;
  let releaseAvailability;
  let availabilityStarted;
  const menuGate = new Promise(resolve => { releaseMenu = resolve; });
  const availabilityGate = new Promise(resolve => { releaseAvailability = resolve; });
  const availabilityRequest = new Promise(resolve => { availabilityStarted = resolve; });
  try {
    await page.route('**/exec', async route => {
      const payload = route.request().postDataJSON();
      requests.push(payload);
      if (payload.type === 'menu') await menuGate;
      if (payload.type === 'availability') { availabilityStarted(); await availabilityGate; }
      await route.continue();
    });
    await page.goto(base + '/reserve.html');
    assert.deepEqual(requests.map(request => request.type), ['menu'], 'メニューと空席が同じロックを取り合わない');
    assert.equal(requests[0].booking, true);
    assert.equal(requests[0].initialAvailability, true);
    assert.equal(await page.locator('#reserve-layout').isVisible(), true, '通信待ちでも公開メニューを選べる');
    await page.locator('#coupon-choices .selectable').first().click();
    await page.locator('[data-next="2"]').first().click();
    assert.equal(await page.locator('[data-next="3"]').first().isDisabled(), true, '最新料金の確認前は日時へ進まない');
    releaseMenu();
    await availabilityRequest;
    assert.equal(await page.evaluate(() => state.step), 1, '公開メニューと試験台帳の内容が違うため最新内容を選び直す');
    assert.equal(await page.locator('#catalog-change-notice').isVisible(), true);
    await page.locator('#coupon-choices .selectable').first().click();
    await page.locator('[data-next="2"]').first().click();
    await page.locator('[data-next="3"]').first().click();
    assert.equal(await page.locator('button[data-date][data-time]:not([disabled])').count(), 0, '空席の返事前は枠を選べない');
    releaseAvailability();
    await page.waitForFunction(() => Remote.loaded);
    assert.ok(await page.locator('button[data-date][data-time]:not([disabled])').count() > 0);
    assert.deepEqual(requests.map(request => request.type), ['menu', 'availability']);
    await page.evaluate(() => Remote.load(true));
    assert.deepEqual(requests.map(request => request.type), ['menu', 'availability', 'availability'], '再確認は最新の枠を取り直す');
  } finally { releaseMenu(); releaseAvailability(); await page.context().close(); }
});

test('メニュー取得失敗時は空席の無駄な通信を始めず、安全に停止する', async () => {
  const page = await browser.newPage();
  const types = [];
  try {
    await page.route('**/exec', async route => {
      types.push(route.request().postDataJSON().type);
      await route.fulfill({ status: 503, json: { ok: false } });
    });
    await page.goto(base + '/reserve.html');
    await page.waitForFunction(() => Catalog.loaded);
    assert.equal(await page.locator('#reserve-layout').isVisible(), false);
    assert.match(await page.locator('#catalog-status').innerText(), /確認できません/);
    assert.deepEqual(types, ['menu']);
  } finally { await page.context().close(); }
});

test('日時選択の下書きを開き直しても、画面復帰がメニュー確認を追い越さない', async () => {
  const page = await browser.newPage({ timezoneId: 'Asia/Tokyo' });
  const types = [];
  let releaseMenu;
  const menuGate = new Promise(resolve => { releaseMenu = resolve; });
  try {
    await page.goto(base + '/reserve.html');
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    await page.locator('#coupon-choices .selectable').first().click();
    await page.locator('[data-next="2"]').first().click();
    await page.locator('[data-next="3"]').first().click();
    await page.waitForFunction(() => Remote.loaded);
    await page.route('**/exec', async route => {
      const payload = route.request().postDataJSON();
      types.push(payload.type);
      if (payload.type === 'menu') await menuGate;
      await route.continue();
    });
    await page.reload();
    assert.equal(await page.evaluate(() => state.step), 3);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await page.evaluate(() => Remote.loading), null, 'メニュー待機中に復帰しても空席通信を開始しない');
    assert.deepEqual(types, ['menu']);
    releaseMenu();
    await page.waitForFunction(() => Remote.loaded);
    assert.deepEqual(types, ['menu', 'availability']);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => Remote.loading === null);
    assert.deepEqual(types, ['menu', 'availability', 'availability'], '確認後の画面復帰では最新の空席を読む');
  } finally { releaseMenu(); await page.context().close(); }
});
