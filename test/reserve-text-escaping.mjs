import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { mockBookingState } from './booking-state-fixture.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const server = http.createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
server.on('request', createMockHandler({ port: server.address().port }));
const base = `http://127.0.0.1:${server.address().port}`;
const LITERAL_TEXT = `確認用 <img src="/missing-text-image" onerror="window.unsafeTextCount++"> & "'`;

after(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function fixture(run, width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 },
    timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  const errors = [];
  const writes = [];
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base
      ? route.continue() : route.abort());
    await mockBookingState(context);
    await context.addInitScript(() => { window.unsafeTextCount = 0; });
    await context.route(`${base}/exec`, async route => {
      const payload = route.request().postDataJSON();
      if (!['reserve', 'change'].includes(payload?.type)) return route.continue();
      writes.push(payload);
      await route.fulfill({ json: { ok: true, code: payload.code } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/reserve.html`);
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    await run({ page, writes });
    assert.deepEqual(errors, [], 'JavaScript例外なし');
  } finally { await context.close(); }
}

async function selectDate(page) {
  await page.waitForFunction(() => document.querySelector('button[data-date][data-time]:not([disabled])'));
  const slot = await page.evaluate(() => {
    const earliest = new Date();
    earliest.setDate(earliest.getDate() + 4);
    const button = [...document.querySelectorAll('button[data-date][data-time]:not([disabled])')]
      .find(candidate => candidate.dataset.date >= toKey(earliest));
    return button ? { date: button.dataset.date, time: button.dataset.time } : null;
  });
  assert.ok(slot);
  await page.locator(`button[data-date="${slot.date}"][data-time="${slot.time}"]`).click();
  await page.locator('[data-next="4"]').first().click();
}

async function finishCustomer(page) {
  await page.fill('#f-name', '架空の表示確認客');
  await page.fill('#f-kana', 'カクウノヒョウジカクニンキャク');
  await page.fill('#f-tel', '00000000000');
  await page.fill('#f-email', 'text-review@example.test');
  await page.locator('label.radio-chip:has-text("初めて")').first().click();
  await page.locator('#customer-form .checkbox-line > span').click();
  await page.locator('[data-next="5"]').first().click();
}

async function assertLiteralRow(page, host, heading, expected) {
  const row = page.locator(`${host} tr`).filter({ has: page.locator('th', { hasText: heading }) });
  assert.equal(await page.locator(`${host} img, ${host} svg, ${host} script`).count(), 0,
    '名前や料金からHTML要素を生成しない');
  assert.equal(await page.evaluate(() => window.unsafeTextCount), 0, '入力中の処理を実行しない');
  assert.ok((await row.locator('td').textContent()).includes(expected), '元の文字をそのまま読める');
}

for (const choice of ['coupon', 'menu']) {
  for (const width of [320, 1280]) {
    test(`${width}px・${choice}：確認画面と完了画面でメニュー名を文字として表示する`, async () => {
      await fixture(async ({ page, writes }) => {
        await page.evaluate(({ choice, text }) => {
          if (choice === 'coupon') {
            SALON.coupons[0].title = text;
            renderCouponChoices();
          } else {
            SALON.menuCategories[0].items[0].name = text;
            renderMenuChoices(SALON.menuCategories[0].id);
          }
        }, { choice, text: LITERAL_TEXT });
        await page.locator(choice === 'coupon' ? '#coupon-choices .selectable' : '#menu-choices .selectable').first().click();
        await page.locator('[data-next="2"]').first().click();
        await selectDate(page);
        await finishCustomer(page);
        await assertLiteralRow(page, '#confirm-body', 'メニュー', LITERAL_TEXT);
        await page.locator('#submit-reservation').click();
        await page.waitForFunction(() => state.step === 6 && !submitting);
        await assertLiteralRow(page, '#done-body', 'メニュー', LITERAL_TEXT);
        assert.equal(writes.length, 1);
        assert.equal(writes[0].menus[0].name, LITERAL_TEXT, '送るデータをHTML用に変換しない');
      }, width);
    });
  }
}

test('新規予約：担当者名を確認・完了画面で文字として表示する', async () => {
  await fixture(async ({ page, writes }) => {
    await page.evaluate(text => { SALON.staff[0].name = text; }, LITERAL_TEXT);
    await page.locator('#coupon-choices .selectable').first().click();
    await page.locator('[data-next="2"]').first().click();
    await selectDate(page);
    await finishCustomer(page);
    await assertLiteralRow(page, '#confirm-body', 'ご担当', LITERAL_TEXT);
    await page.locator('#submit-reservation').click();
    await page.waitForFunction(() => state.step === 6 && !submitting);
    await assertLiteralRow(page, '#done-body', 'ご担当', LITERAL_TEXT);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].staffName, LITERAL_TEXT);
  });
});

for (const [field, heading] of [['staffName', 'ご担当'], ['totalLabel', '合計金額']]) {
  test(`日時変更：元の${heading}の文字を完了画面でHTMLとして解釈しない`, async () => {
    await fixture(async ({ page, writes }) => {
      await page.evaluate(({ field, text }) => {
        const date = new Date();
        date.setDate(date.getDate() + 3);
        changing = { code: 'LM-TEXT1', date: toKey(date), time: '10:00', endTime: '11:00',
          totalMinutes: 60, staffName: '架空の担当', totalLabel: '¥6,900〜', totalPrice: 6900,
          menuText: '架空のカット', lookupTel: '00000000000', [field]: text };
        state.step = 3;
        renderStep();
        renderCalendar();
      }, { field, text: LITERAL_TEXT });
      await selectDate(page);
      await assertLiteralRow(page, '#confirm-body', heading, LITERAL_TEXT);
      await page.locator('#submit-reservation').click();
      await page.waitForFunction(() => state.step === 6 && !submitting);
      await assertLiteralRow(page, '#done-body', heading, LITERAL_TEXT);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].type, 'change');
    });
  });
}

test('通常の予約：複数メニューの改行、料金の「〜」、確定した予約番号を維持する', async () => {
  await fixture(async ({ page, writes }) => {
    await page.locator('#coupon-choices .selectable').first().click();
    await page.locator('#menu-choices .selectable').first().click();
    await page.locator('[data-next="2"]').first().click();
    await selectDate(page);
    await finishCustomer(page);
    const expected = await page.evaluate(() => ({ names: selectedMenus().map(menu => menu.name),
      price: totalText(), staff: staffLabel(state.staffId) }));
    await assertLiteralRow(page, '#confirm-body', '合計金額', expected.price);
    const menuRow = page.locator('#confirm-body tr').filter({ has: page.locator('th', { hasText: 'メニュー' }) });
    assert.equal(await menuRow.locator('br').count(), 1);
    await page.locator('#submit-reservation').click();
    await page.waitForFunction(() => state.step === 6 && !submitting);
    await assertLiteralRow(page, '#done-body', '合計金額', expected.price);
    await assertLiteralRow(page, '#done-body', 'ご担当', expected.staff);
    for (const name of expected.names) await assertLiteralRow(page, '#done-body', 'メニュー', name);
    assert.equal(writes.length, 1);
    assert.equal(await page.locator('#done-code').textContent(), writes[0].code);
    assert.equal((await page.evaluate(() => Store.all()))[0].deliveryState, 'confirmed');
  });
});
