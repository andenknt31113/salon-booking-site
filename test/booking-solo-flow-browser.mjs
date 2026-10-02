import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { withBookingState } from './booking-state-fixture.mjs';

const ENGINE = process.env.TEST_BROWSER || 'chromium';
const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await engines[ENGINE].launch(ENGINE === 'chromium' && process.env.CHROMIUM
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

async function withBooking(run, { width = 390, staff = null, pending = false, allowReserve = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const writes = [];
  const errors = [];
  const control = { priceDelta: 0 };
  let release;
  let requested;
  const gate = new Promise(resolve => { release = resolve; });
  const menuRequested = new Promise(resolve => { requested = resolve; });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.route(/\/assets\/js\/data\.js(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    const source = withBookingState(await response.text());
    await route.fulfill({ response, body: source + (staff ? `\nSALON.staff = ${JSON.stringify(staff)};` : '') });
  });
  await context.route('**/exec', async route => {
    const request = route.request().postDataJSON();
    if (!['menu', 'availability'].includes(request.type)) {
      writes.push(request);
      return allowReserve && request.type === 'reserve' ? route.continue() : route.abort();
    }
    if (request.type !== 'menu') return route.continue();
    requested();
    if (pending) await gate;
    const response = await route.fetch();
    const catalog = await response.json();
    catalog.settings['準備中の帯'] = '出さない';
    if (control.priceDelta) catalog.coupons[0].price += control.priceDelta;
    await route.fulfill({ response, json: catalog });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  try {
    await page.goto(`${base}/reserve.html`);
    if (pending) await menuRequested;
    else await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    await run({ page, release, writes, control });
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
    if (!allowReserve) assert.deepEqual(writes, [], '選択・復元・確認だけでは予約を書き込まない');
  } finally { release(); await context.close(); }
}

for (const width of [320, 390, 1280]) {
  test(`${width}px：メニューから日時へ一操作で進み、担当・合計・四つの手順を確認できる`, () => withBooking(async ({ page }) => {
    const steps = page.locator('#steps .step:visible');
    assert.deepEqual(await steps.locator('b').allTextContents(), ['STEP 1', 'STEP 2', 'STEP 3', 'STEP 4']);
    assert.equal(await page.locator('#steps [data-step="2"]').isVisible(), false);
    await page.locator('#coupon-choices .selectable').first().click();
    const selected = await page.evaluate(() => ({ coupon: state.couponId, total: totalText(), staff: SALON.staff[0] }));
    assert.equal(await page.locator('#step-cta button').innerText(), '日時の選択へ');
    await page.locator('#step-cta button').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-panel="3"]').isVisible(), true);
    assert.equal(await page.locator('[data-panel="2"]').isVisible(), false);
    assert.equal(await page.locator('#h-step3').evaluate(element => element === document.activeElement), true);
    assert.ok((await page.locator('#calendar-staff').innerText()).includes(selected.staff.name));
    assert.match(await page.locator('#calendar-staff').innerText(), /マンツーマン/);
    assert.equal(await page.locator('#summary-total').innerText(), selected.total);
    assert.equal(await page.locator('#steps [aria-current="step"] b').innerText(), 'STEP 2');
    assert.equal(await page.locator('#steps [data-step="4"] button').isDisabled(), true);
    assert.ok(await page.locator('#cal-body .slot:not(:disabled)').count() > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.TEST_ARTIFACT_DIR) {
      await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `solo-calendar-${ENGINE}-${width}.png`) });
    }
    await page.locator('[data-panel="3"] [data-prev="2"]').click();
    assert.equal(await page.locator('[data-panel="1"]').isVisible(), true);
    assert.equal(await page.evaluate(() => state.couponId), selected.coupon);
    assert.equal(await page.evaluate(() => state.staffId), selected.staff.id);
    await page.locator('#to-staff').click();
    assert.equal(await page.locator('[data-panel="3"]').isVisible(), true);
  }, { width }));
}

test('通信待ちでもメニューを選べるが、日時へ飛ばさず確認後も勝手に画面を変えない', () => withBooking(async ({ page, release }) => {
  await page.locator('#coupon-choices .selectable').first().click();
  assert.equal(await page.locator('#to-staff').isDisabled(), true);
  assert.equal(await page.locator('#step-cta button').isDisabled(), true);
  assert.match(await page.locator('#step-cta').innerText(), /最新の料金・受付条件を確認中/);
  await page.evaluate(() => goTo(2));
  assert.equal(await page.evaluate(() => state.step), 1);
  release();
  await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
  assert.equal(await page.evaluate(() => state.step), 1);
  await page.locator('#coupon-choices .selectable').first().click();
  await page.locator('#step-cta button').click();
  assert.equal(await page.evaluate(() => state.step), 3);
}, { pending: true }));

for (const staff of [
  [{ id: 'st01', name: '試験担当', role: '担当', tags: [], workdays: [1, 2, 3, 4, 5, 6], nominationFee: 500 }],
  [{ id: 'st01', name: '第一担当', role: '担当', tags: [], workdays: [1, 2, 3, 4, 5, 6], nominationFee: 0 },
    { id: 'st02', name: '第二担当', role: '担当', tags: [], workdays: [1, 2, 3, 4, 5, 6], nominationFee: 500 }]
]) {
  test(`${staff.length}名・追加料金あり：担当の選択と金額確認を省かない`, () => withBooking(async ({ page }) => {
    await page.locator('#coupon-choices .selectable').first().click();
    const menuPrice = await page.evaluate(() => totalPrice() - nominationFee());
    await page.locator('#step-cta button').click();
    assert.equal(await page.evaluate(() => state.step), 2);
    assert.equal(await page.locator('#steps .step:visible').count(), 5);
    const selected = staff.at(-1);
    await page.locator(`#staff-choices [data-staff="${selected.id}"]`).click();
    assert.match(await page.locator('#staff-choices').innerText(), /指名料/);
    assert.equal(await page.evaluate(() => totalPrice()), menuPrice + selected.nominationFee);
    await page.locator('#step-cta button').click();
    assert.equal(await page.evaluate(() => state.step), 3);
    await page.locator('[data-panel="3"] [data-prev="2"]').click();
    assert.equal(await page.evaluate(() => state.step), 2);
  }, { staff }));
}

test('旧担当画面の下書きはメニューへ戻して内容を保ち、違う担当の日時は選び直す', () => withBooking(async ({ page }) => {
  await page.locator('#coupon-choices .selectable').first().click();
  const menu = await page.evaluate(() => state.couponId);
  await page.evaluate(() => { state.step = 2; saveDraft(); });
  await page.reload();
  await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
  assert.equal(await page.evaluate(() => state.step), 1);
  assert.equal(await page.evaluate(() => state.couponId), menu);
  await page.evaluate(() => {
    state.step = 4;
    state.staffId = null;
    state.staffChosen = true;
    state.date = '2030-01-05';
    state.time = '10:00';
    state.customer.name = '復元試験';
    saveDraft();
  });
  await page.reload();
  await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
  assert.equal(await page.evaluate(() => state.step), 3);
  assert.deepEqual(await page.evaluate(() => [state.date, state.time]), [null, null]);
  assert.equal(await page.evaluate(() => state.staffId), await page.evaluate(() => SALON.staff[0].id));
  assert.equal(await page.evaluate(() => state.customer.name), '復元試験');
}));

for (const step of [1, 2]) {
  test(`手順${step}の下書きでも最新の金額が変わったら選び直し、古い金額で日時へ進めない`, () => withBooking(async ({ page, control }) => {
    await page.locator('#coupon-choices .selectable').first().click();
    await page.evaluate(savedStep => { state.step = savedStep; saveDraft(); }, step);
    control.priceDelta = 1000;
    await page.reload();
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    assert.equal(await page.evaluate(() => state.step), 1);
    assert.equal(await page.evaluate(() => state.couponId), null);
    assert.equal(await page.locator('#catalog-change-notice').isVisible(), true);
    assert.match(await page.locator('#catalog-change-notice').innerText(), /選び直してください/);
    assert.equal(await page.locator('#step-cta button').isDisabled(), true);
  }));
}

test('四手順でも必須入力・同意・最終確認を保ち、架空台帳で一回だけ予約を受け付ける', () => withBooking(async ({ page, writes }) => {
  await page.locator('#coupon-choices .selectable').first().click();
  const expected = await page.evaluate(() => ({ staff: SALON.staff[0], price: totalPrice(), minutes: totalMinutes() }));
  await page.locator('#step-cta button').click();
  assert.equal(await page.locator('#step-cta button').isDisabled(), true);
  await page.evaluate(() => goTo(4));
  assert.equal(await page.evaluate(() => state.step), 3, '日時なしで入力へ進めない');
  await page.locator('#cal-body .slot:not(:disabled)').last().click();
  await page.locator('#step-cta button').click();
  await page.locator('#step-cta button').click();
  assert.equal(await page.evaluate(() => state.step), 4, '空の入力で確認へ進めない');
  await page.locator('#f-name').fill('四手順 試験');
  await page.locator('#f-kana').fill('ヨンテジュンシケン');
  await page.locator('#f-tel').fill('00000000000');
  await page.locator('#f-email').fill('solo@example.test');
  await page.locator('[name="visit"][value="初めて"]').check();
  await page.locator('#step-cta button').click();
  assert.equal(await page.evaluate(() => state.step), 4, '同意なしで確認へ進めない');
  await page.locator('#f-agree').check();
  await page.locator('#step-cta button').click();
  assert.equal(await page.evaluate(() => state.step), 5);
  assert.equal(await page.locator('#steps [aria-current="step"] b').innerText(), 'STEP 4');
  assert.ok((await page.locator('#confirm-body').innerText()).includes(expected.staff.name));
  assert.equal(writes.length, 0);
  await page.locator('#submit-reservation').click();
  await page.locator('#done-code').waitFor({ state: 'visible' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].type, 'reserve');
  assert.equal(writes[0].staffId, expected.staff.id);
  assert.equal(writes[0].staffName, expected.staff.name);
  assert.equal(writes[0].totalPrice, expected.price);
  assert.equal(writes[0].totalMinutes, expected.minutes);
  assert.match(await page.locator('#done-code').innerText(), /^LM-[A-Z0-9]{5}$/);
}, { allowReserve: true }));
