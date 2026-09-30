import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const published = vm.runInNewContext(await readFile(new URL('../assets/js/published-menus.js', import.meta.url), 'utf8') + '\nJSON.stringify(PUBLISHED_MENUS)');
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

async function withPendingCatalog(run) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
  const requests = [];
  const errors = [];
  let releaseMenu;
  let menuRequested;
  const gate = new Promise(resolve => { releaseMenu = resolve; });
  const started = new Promise(resolve => { menuRequested = resolve; });
  const catalog = { ok: true, ...JSON.parse(published), closedDates: [], settings: { '準備中の帯': '出さない' } };
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/exec', async route => {
      const request = route.request().postDataJSON();
      requests.push(request.type);
      if (request.type !== 'menu') return route.continue();
      menuRequested();
      await gate;
      await route.fulfill({ json: catalog });
    });
    await page.goto(base + '/reserve.html');
    await started;
    await run({ page, catalog, releaseMenu, requests });
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
    assert.equal(requests.includes('reserve'), false, '閲覧と選択だけでは予約を書き込まない');
  } finally {
    releaseMenu();
    await page.context().close();
  }
}

test('公開メニューは通信の返事前から選べるが、未確認の日時選択・送信は通さない', async () => {
  await withPendingCatalog(async ({ page, releaseMenu, requests }) => {
    assert.equal(await page.locator('#reserve-layout').isVisible(), true);
    await page.locator('#coupon-choices .selectable').first().click();
    assert.equal(await page.locator('#coupon-choices .selectable').first().getAttribute('aria-pressed'), 'true');
    const chosen = await page.locator('#coupon-choices .is-selected .selectable-title').innerText();
    await page.locator('[data-next="2"]').first().click();
    assert.equal(await page.locator('[data-next="3"]').first().isDisabled(), true);
    await page.evaluate(() => goTo(3));
    assert.equal(await page.evaluate(() => state.step), 2);
    await page.evaluate(() => submitReservation());
    assert.deepEqual(requests, ['menu'], '日時確認・書込よりも先に最新メニューを確認する');
    releaseMenu();
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    assert.equal(await page.locator('[data-next="3"]').first().isEnabled(), true);
    await page.locator('[data-prev="1"]').first().click();
    assert.equal(await page.locator('#coupon-choices .is-selected .selectable-title').innerText(), chosen, '同じ料金・時間なら選択を維持');
    await page.locator('[data-next="2"]').first().click();
    await page.locator('[data-next="3"]').first().click();
    assert.ok(await page.locator('button[data-date][data-time]:not([disabled])').count() > 0);
  });
});

test('スマホでは選択前の空のサマリーを先頭に置かず、メニューから操作できる', async () => {
  await withPendingCatalog(async ({ page }) => {
    const panel = await page.locator('[data-panel="1"]').boundingBox();
    const summary = await page.locator('#summary').boundingBox();
    assert.ok(panel.y < summary.y, '操作するメニューがサマリーより前');
    const firstMenu = await page.locator('#coupon-choices .selectable').first().boundingBox();
    assert.ok(firstMenu.y < 844, '最初の画面内にメニューの入口が見える');
    const menu = page.locator('#menu-choices [data-menu]').first();
    await menu.focus();
    await page.keyboard.press('Space');
    assert.equal(await menu.getAttribute('aria-pressed'), 'true', 'キーボードでも選択状態を伝える');
    await page.keyboard.press('Space');
    assert.equal(await menu.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
});

for (const change of ['price', 'minutes', 'priceFrom', 'remove']) {
  test(`先行選択したメニューの${change}が変わったら、黙って進めず選び直す`, async () => {
    await withPendingCatalog(async ({ page, catalog, releaseMenu }) => {
      assert.equal(await page.locator('#reserve-layout').isVisible(), true);
      await page.locator('#coupon-choices .selectable').first().click();
      await page.locator('[data-next="2"]').first().click();
      if (change === 'remove') catalog.coupons.shift();
      else if (change === 'priceFrom') catalog.coupons[0].priceFrom = !catalog.coupons[0].priceFrom;
      else catalog.coupons[0][change] += 10;
      releaseMenu();
      await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
      assert.equal(await page.evaluate(() => state.step), 1);
      assert.equal(await page.locator('.selectable.is-selected[data-coupon]').count(), 0);
      assert.match(await page.locator('#catalog-change-notice').innerText(), /選び直してください/);
      assert.equal(await page.locator('#catalog-change-notice').isVisible(), true);
      assert.equal(await page.locator('#step-cta [data-next="2"]').isDisabled(), true);
      assert.deepEqual(await page.evaluate(() => [state.date, state.time]), [null, null]);
      await page.locator('#coupon-choices .selectable').first().click();
      assert.equal(await page.locator('#catalog-change-notice').isVisible(), false, '選び直した後は更新案内を畳む');
      assert.equal(await page.locator('#step-cta [data-next="2"]').isEnabled(), true);
    });
  });
}

test('通信待ちに選択を解除したら、下書きに残っていたメニューを復活させない', async () => {
  await withPendingCatalog(async ({ page, releaseMenu }) => {
    assert.equal(await page.locator('#reserve-layout').isVisible(), true);
    const coupon = page.locator('#coupon-choices .selectable').first();
    const menu = page.locator('#menu-choices [data-menu]').first();
    await coupon.click();
    await coupon.click();
    await menu.click();
    await menu.click();
    releaseMenu();
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    assert.equal(await page.evaluate(() => selectedMenus().length), 0);
    assert.equal(await page.locator('#catalog-change-notice').isVisible(), false);
  });
});

test('公開後に店が受付を止めていた場合は、最新の返事で停止し日時を選ばせない', async () => {
  await withPendingCatalog(async ({ page, catalog, releaseMenu, requests }) => {
    assert.equal(await page.locator('#reserve-layout').isVisible(), true);
    await page.locator('#coupon-choices .selectable').first().click();
    catalog.settings['準備中の帯'] = '出す';
    releaseMenu();
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    assert.equal(await page.locator('#reserve-layout').isVisible(), false);
    assert.equal(await page.locator('#booking-paused-notice').isVisible(), true);
    await page.evaluate(() => submitReservation());
    assert.equal(requests.includes('reserve'), false);
  });
});

test('応答の一部が壊れても公開メニューと選択を壊さず、再確認で復帰できる', async () => {
  await withPendingCatalog(async ({ page, catalog, releaseMenu, requests }) => {
    await page.locator('#menu-choices [data-menu]').first().click();
    const selected = await page.evaluate(() => draftNames().menuNames);
    catalog.categories = [];
    catalog.coupons = [null];
    releaseMenu();
    await page.waitForFunction(() => Catalog.loaded);
    assert.equal(await page.evaluate(() => Catalog.source), 'local');
    assert.equal(await page.locator('#reserve-layout').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => draftNames().menuNames), selected, '失敗した応答を途中まで適用しない');
    assert.deepEqual(requests, ['menu']);
    Object.assign(catalog, JSON.parse(published));
    await page.locator('[data-catalog-retry]').click();
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    assert.equal(await page.locator('#reserve-layout').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => draftNames().menuNames), selected, '再確認後も選択を維持する');
    assert.deepEqual(requests, ['menu', 'menu', 'availability']);
  });
});

test('メニューと空席の同時応答は1回の通信で日時まで進み、再確認は省略しない', async () => {
  await withPendingCatalog(async ({ page, catalog, releaseMenu, requests }) => {
    catalog.booked = [];
    await page.locator('#coupon-choices .selectable').first().click();
    await page.locator('[data-next="2"]').first().click();
    releaseMenu();
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    await page.locator('[data-next="3"]').first().click();
    assert.ok(await page.locator('button[data-date][data-time]:not([disabled])').count() > 0);
    assert.deepEqual(requests, ['menu'], '空席のための2度目の往復をしない');
    await page.evaluate(() => Remote.load(true));
    assert.deepEqual(requests, ['menu', 'availability'], '画面復帰や登録直前の確認は最新の枠を読み直す');
  });
});

test('同時応答の空席が壊れていたら、信用せず別通信で最新の空席を確認する', async () => {
  await withPendingCatalog(async ({ page, catalog, releaseMenu, requests }) => {
    catalog.booked = [{ date: '2026-02-30', time: '10:00', minutes: 30, staffId: null }];
    releaseMenu();
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    assert.deepEqual(requests, ['menu', 'availability']);
    assert.equal(await page.evaluate(() => Remote.booked.some(slot => slot.date === '2026-02-30')), false);
  });
});
