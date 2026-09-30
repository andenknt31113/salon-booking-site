import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { mockBookingState } from './booking-state-fixture.mjs';

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

async function withCalendar(run, width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const errors = [];
  const writes = [];
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await mockBookingState(context, { approved: true, draft: false });
  await context.route('**/exec', async route => {
    const request = route.request().postDataJSON();
    if (!['menu', 'availability'].includes(request.type)) {
      writes.push(request.type);
      return route.abort();
    }
    if (request.type !== 'menu') return route.fallback();
    const response = await route.fetch();
    const catalog = await response.json();
    catalog.settings['準備中の帯'] = '出さない';
    await route.fulfill({ response, json: catalog });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/reserve.html`);
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    await page.locator('#coupon-choices .selectable').first().click();
    await page.locator('[data-next="2"]').first().click();
    await page.locator('[data-next="3"]').first().click();
    await run(page);
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
    assert.deepEqual(writes, [], '閲覧・入力・確認では予約や台帳を書き込まない');
  } finally { await context.close(); }
}

async function openCustomerForm(page) {
  await page.locator('#cal-body .slot:not(:disabled)').first().click();
  await page.locator('[data-next="4"]').first().click();
}

async function fillCustomerForm(page) {
  await page.locator('#f-name').fill('試験 太郎');
  await page.locator('#f-kana').fill('シケン タロウ');
  await page.locator('#f-tel').fill('09012345678');
  await page.locator('#f-email').fill('test@example.com');
  await page.locator('[name="visit"][value="初めて"]').check();
  await page.locator('#f-agree').check();
}

for (const width of [320, 390, 1280]) {
  test(`${width}px：空席ボタンは44px以上で、表だけ横に動かせる`, async () => {
    await withCalendar(async page => {
      const sizes = await page.locator('#cal-body .slot').evaluateAll(buttons => buttons.map(button => {
        const bounds = button.getBoundingClientRect();
        return [bounds.width, bounds.height];
      }));
      assert.ok(sizes.length > 0);
      assert.ok(sizes.every(([buttonWidth, height]) => buttonWidth >= 44 && height >= 44), 'すべての日時を指で押しやすい大きさ');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '画面全体は横にはみ出さない');
      assert.equal(await page.locator('.calendar-scroll').evaluate(element => getComputedStyle(element).overflowX), 'auto');
    }, width);
  });
}

test('日時をキーボードで選んでもボタンを作り直さず、フォーカスと選択状態を維持する', async () => {
  await withCalendar(async page => {
    const slots = page.locator('#cal-body .slot:not(:disabled)');
    const first = slots.nth(0);
    const second = slots.nth(1);
    await first.focus();
    const original = await first.elementHandle();
    await page.keyboard.press('Space');
    assert.equal(await original.evaluate(element => element.isConnected && element === document.activeElement), true, '選択しても操作中の要素は消えない');
    assert.equal(await first.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(await second.evaluate(element => element === document.activeElement), true, '次の空席へ続けて移れる');
    await page.keyboard.press('Enter');
    assert.equal(await second.evaluate(element => element === document.activeElement), true);
    assert.equal(await first.getAttribute('aria-pressed'), 'false');
    assert.equal(await second.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#cal-body [aria-pressed="true"]').count(), 1);
    const selected = await second.evaluate(element => [element.dataset.date, element.dataset.time]);
    assert.deepEqual(await page.evaluate(() => [state.date, state.time]), selected);
    assert.equal(await page.locator('[data-next="4"]').first().isEnabled(), true);
  });
});

test('横へ送った先の日付を選んでも表示位置は戻らず、予約不可の枠は選べない', async () => {
  await withCalendar(async page => {
    const last = page.locator('#cal-body .slot:not(:disabled)').first().locator('xpath=ancestor::tr').locator('.slot:not(:disabled)').last();
    await last.scrollIntoViewIfNeeded();
    const before = await page.locator('.calendar-scroll').evaluate(element => element.scrollLeft);
    assert.ok(before > 0, '先の日付まで横へ送る');
    await last.click();
    assert.equal(await page.locator('.calendar-scroll').evaluate(element => element.scrollLeft), before);
    const selected = await page.evaluate(() => [state.date, state.time]);
    await page.locator('#cal-body .slot:disabled').first().dispatchEvent('click');
    assert.deepEqual(await page.evaluate(() => [state.date, state.time]), selected, '予約不可の枠はクリックイベントでも通さない');
    await page.locator('#cal-next').click();
    await page.locator('#cal-prev').click();
    assert.equal(await page.locator('#cal-body .slot.is-selected').getAttribute('aria-pressed'), 'true', '期間を戻しても選択状態を伝える');
  });
});

for (const reason of ['受付期限', '空席未確認']) {
  test(`再描画前に${reason}の条件が変わった枠は、クリック時に止める`, async () => {
    await withCalendar(async page => {
      const slot = page.locator('#cal-body .slot:not(:disabled)').first();
      const selected = await slot.evaluate(element => [element.dataset.date, element.dataset.time]);
      if (reason === '受付期限') {
        await page.clock.setFixedTime(new Date(`${selected[0]}T${selected[1]}:00+09:00`));
      } else {
        await page.evaluate(() => { Remote.booked = null; });
      }
      const messages = [];
      page.on('dialog', async dialog => { messages.push(dialog.message()); await dialog.accept(); });
      await slot.click();
      assert.deepEqual(await page.evaluate(() => [state.date, state.time]), [null, null], '古い表示だけでは日時を確定しない');
      assert.equal(await page.locator('#cal-body .is-selected').count(), 0);
      assert.equal(await page.locator('[data-next="4"]').first().isDisabled(), true);
      assert.equal(messages.length, 1, '選べない理由をその場で伝える');
      if (reason === '空席未確認') assert.match(messages[0], /空き状況を確認できません/);
    });
  });
}

test('進む・戻る操作で表示した見出しへフォーカスを移し、隠れたボタンに残さない', async () => {
  await withCalendar(async page => {
    assert.equal(await page.locator('#h-step3').evaluate(element => element === document.activeElement), true);
    await openCustomerForm(page);
    assert.equal(await page.locator('#h-step4').evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#f-name').evaluate(element => element === document.activeElement), true, '見出しの次は先頭の入力欄');
    await fillCustomerForm(page);
    await page.locator('[data-next="5"]').first().click();
    assert.equal(await page.locator('#h-step5').evaluate(element => element === document.activeElement), true);
    await page.locator('[data-prev="4"]').click();
    assert.equal(await page.locator('#h-step4').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#f-name').inputValue(), '試験 太郎', '戻っても入力を消さない');
  });
});

test('必須項目のエラーを入力欄に結び付け、最初の不備へ移動して確認画面を止める', async () => {
  await withCalendar(async page => {
    await openCustomerForm(page);
    assert.equal(await page.locator('#customer-form [aria-describedby]').count(), 0, 'まだエラーの無い欄でエラー文を読み上げない');
    await page.locator('[data-next="5"]').first().click();
    assert.equal(await page.locator('[data-panel="4"]').isVisible(), true);
    assert.equal(await page.locator('#f-name').evaluate(element => element === document.activeElement), true);
    for (const key of ['name', 'kana', 'tel', 'email', 'visit', 'agree']) {
      const field = page.locator(`[data-field="${key}"]`);
      assert.equal(await field.locator('.field-error').isVisible(), true, `${key}のエラーを表示`);
      const controls = field.locator('input');
      for (const control of await controls.all()) {
        assert.equal(await control.getAttribute('aria-invalid'), 'true', `${key}の不備を読み上げへ伝える`);
        assert.equal(await control.evaluate(element => element.required), true);
        const description = await control.getAttribute('aria-describedby');
        assert.ok(description);
        assert.equal(await page.locator(`#${description}`).isVisible(), true);
        assert.equal(await page.locator(`#${description}`).innerText(), await field.locator('.field-error').innerText());
      }
    }
    assert.equal(await page.locator('[data-field="visit"] [role="group"]').getAttribute('aria-labelledby'), 'f-visit-label');
  });
});

test('不正なメールを打ち直しただけではエラーを隠さず、正しい入力で解除する', async () => {
  await withCalendar(async page => {
    await openCustomerForm(page);
    await page.locator('[data-next="5"]').first().click();
    await page.locator('#f-email').fill('まだ不正');
    assert.equal(await page.locator('[data-field="email"] .field-error').isVisible(), true);
    assert.equal(await page.locator('#f-email').getAttribute('aria-invalid'), 'true');
    await fillCustomerForm(page);
    assert.equal(await page.locator('.form-field.has-error').count(), 0, 'ラジオ・同意も含めて正しい入力で解除');
    assert.equal(await page.locator('#customer-form [aria-invalid="true"]').count(), 0);
    assert.equal(await page.locator('#customer-form [aria-describedby]').count(), 0, '修正後の欄に古いエラーの説明を残さない');
    await page.locator('[data-next="5"]').first().click();
    assert.equal(await page.locator('[data-panel="5"]').isVisible(), true);
    assert.match(await page.locator('#confirm-body').innerText(), /test@example.com/);
  });
});

test('カナ・全角電話番号は欄を離れて整形した後にエラーを解除する', async () => {
  await withCalendar(async page => {
    await openCustomerForm(page);
    await page.locator('[data-next="5"]').first().click();
    await page.locator('#f-kana').fill('しけん たろう');
    await page.locator('#f-tel').fill('０９０１２３４５６７８');
    assert.equal(await page.locator('#f-kana').inputValue(), 'シケン タロウ');
    assert.equal(await page.locator('#f-kana').getAttribute('aria-invalid'), 'false');
    await page.locator('#f-email').focus();
    assert.equal(await page.locator('#f-tel').inputValue(), '09012345678');
    assert.equal(await page.locator('#f-tel').getAttribute('aria-invalid'), 'false');
    assert.equal(await page.locator('[data-field="tel"] .field-error').isVisible(), false);
    assert.equal(await page.locator('#f-email').getAttribute('aria-invalid'), 'true', '別の未入力欄のエラーは勝手に解除しない');
  });
});
