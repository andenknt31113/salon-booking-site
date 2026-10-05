import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { mockBookingState } from './booking-state-fixture.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await engines.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
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

async function withPage(design, run, allowReservation = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const requests = [];
  const errors = [];
  const dialogs = [];
  const writes = [];
  const allowedTypes = allowReservation ? ['menu', 'availability', 'reserve'] : ['menu', 'availability'];
  let armed = false;
  let release;
  let started;
  const pending = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await mockBookingState(context);
    await context.route('**/exec', async route => {
      const payload = route.request().postDataJSON();
      requests.push(payload.type);
      assert.ok(allowedTypes.includes(payload.type), '許可した模擬要求だけを扱う');
      if (payload.type === 'reserve') {
        writes.push(payload);
        return route.fulfill({ json: { ok: false, taken: true, error: '架空の枠満席' } });
      }
      if (payload.type !== 'availability' || !armed) return route.continue();
      started();
      const result = await pending;
      return route.fulfill({ status: result.ok === true ? 200 : 503, json: result });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.goto(base + '/reserve.html' + (design ? '?design=a' : ''));
    await page.waitForFunction(() => typeof Catalog !== 'undefined' && Catalog.loaded && Remote.loaded);
    await page.locator('#coupon-choices .selectable').first().click();
    await page.locator('#step-cta button').click();
    await page.locator('#cal-body .slot:not(:disabled)').first().click();
    const selected = await page.evaluate(() => ({ date: state.date, time: state.time,
      staffId: state.staffId, minutes: totalMinutes() }));
    const readsBefore = requests.filter(type => type === 'availability').length;
    armed = true;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await requested;
    assert.equal(requests.filter(type => type === 'availability').length, readsBefore + 1,
      '重複する復帰イベントの通信を一本にする');
    await run({ page, selected, dialogs, requests, writes,
      async finish(result) {
        armed = false;
        release(result);
        await page.waitForFunction(() => Remote.loading === null);
      } });
    assert.deepEqual(errors, []);
    assert.ok(requests.every(type => allowedTypes.includes(type)));
  } finally {
    armed = false;
    release({ ok: true, booked: [] });
    await context.close();
  }
}

async function inputCustomer(page) {
  await page.locator('#f-name').fill('空席確認 試験');
  await page.locator('#f-kana').fill('クウセキカクニンシケン');
  await page.locator('#f-tel').fill('00000000000');
  await page.locator('#f-email').fill('calendar-check@example.test');
  await page.locator('[name="visit"][value="初めて"]').check();
  await page.locator('#f-request').fill('書きかけの要望');
  await page.locator('#f-agree').check();
}

const snapshot = page => page.evaluate(() => ({ step: state.step, date: state.date, time: state.time,
  customer: { ...state.customer }, draft: sessionStorage.getItem(DRAFT_KEY) }));

for (const design of [false, true]) {
  const label = design ? 'A案' : '従来版';
  for (const step of [4, 5]) {
    test(`${label}：空席の遅い満席応答がSTEP${step}の日時・連絡先・下書きを消さない`, () =>
      withPage(design, async ({ page, selected, dialogs, finish }) => {
        await page.locator('#step-cta button').click();
        await inputCustomer(page);
        if (step === 5) await page.locator('#step-cta button').click();
        const before = await snapshot(page);
        assert.equal(before.step, step);
        await finish({ ok: true, booked: [selected] });
        assert.deepEqual(await snapshot(page), before);
        assert.deepEqual(dialogs, []);
        assert.equal(await page.locator('#f-name').inputValue(), before.customer.name);
        if (step === 5) assert.match(await page.locator('#confirm-body').innerText(), new RegExp(selected.time));
      }));
  }

  test(`${label}：以前の枠だけが埋まっても、待機中に選び直した空き日時を保持する`, () =>
    withPage(design, async ({ page, selected, dialogs, finish }) => {
      await page.locator('#cal-body .slot:not(:disabled)').last().click();
      const before = await snapshot(page);
      assert.notDeepEqual([before.date, before.time], [selected.date, selected.time]);
      await finish({ ok: true, booked: [selected] });
      assert.deepEqual(await snapshot(page), before);
      assert.deepEqual(dialogs, []);
    }));

  test(`${label}：待機中に選び直した枠が埋まった場合は、その日時を一回だけ警告する`, () =>
    withPage(design, async ({ page, selected, dialogs, finish }) => {
      await page.locator('#cal-body .slot:not(:disabled)').last().click();
      const before = await snapshot(page);
      assert.notDeepEqual([before.date, before.time], [selected.date, selected.time]);
      await finish({ ok: true, booked: [{ ...selected, date: before.date, time: before.time }] });
      assert.equal((await snapshot(page)).time, null);
      assert.equal((await snapshot(page)).date, before.date);
      assert.equal(dialogs.length, 1);
      assert.ok(dialogs[0].includes(before.time));
      assert.equal(await page.locator('#step-cta button').isDisabled(), true);
    }));

  test(`${label}：同じ満席結果を待つ復帰イベントが重なっても警告を二重に開かない`, () =>
    withPage(design, async ({ page, selected, dialogs, finish }) => {
      await finish({ ok: true, booked: [selected] });
      assert.equal((await snapshot(page)).time, null);
      assert.equal(dialogs.length, 1);
      assert.ok(dialogs[0].includes(selected.time));
      assert.equal(await page.locator('#step-cta button').isDisabled(), true);
    }));

  test(`${label}：遅い空席確認が失敗しても入力画面の選択を保持し、空席成功や予約完了にはしない`, () =>
    withPage(design, async ({ page, dialogs, requests, finish }) => {
      await page.locator('#step-cta button').click();
      await inputCustomer(page);
      const before = await snapshot(page);
      await finish({ ok: false });
      assert.deepEqual(await snapshot(page), before);
      assert.equal(await page.evaluate(() => Remote.booked), null);
      assert.deepEqual(dialogs, []);
      assert.ok(requests.every(type => ['menu', 'availability'].includes(type)));
      assert.equal(await page.locator('[data-panel="6"]').isVisible(), false);
    }));

  test(`${label}：確認画面で日時を保持した後も受け口の満席拒否を無視せず、入力を残して選び直す`, () =>
    withPage(design, async ({ page, selected, dialogs, writes, finish }) => {
      await page.locator('#step-cta button').click();
      await inputCustomer(page);
      await page.locator('#step-cta button').click();
      const before = await snapshot(page);
      await finish({ ok: true, booked: [selected] });
      assert.deepEqual(await snapshot(page), before);
      await page.locator('#submit-reservation').click();
      await page.waitForFunction(() => !submitting && state.step === 3);
      assert.equal(writes.length, 1);
      assert.deepEqual([writes[0].date, writes[0].time], [selected.date, selected.time]);
      const current = await snapshot(page);
      assert.equal(current.date, selected.date);
      assert.equal(current.time, null);
      assert.deepEqual(current.customer, before.customer);
      assert.deepEqual(await page.evaluate(() => Store.all()), []);
      assert.deepEqual(dialogs, ['架空の枠満席']);
      assert.equal(await page.locator('[data-panel="6"]').isVisible(), false);
    }, true));
}
