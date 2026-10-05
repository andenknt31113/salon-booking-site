import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { mockBookingState } from './booking-state-fixture.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let handler;
const server = http.createServer((request, response) => handler(request, response));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
handler = createMockHandler({ port: server.address().port });
const base = `http://127.0.0.1:${server.address().port}`;
const UI_RESULT_TIMEOUT_MS = 5000;
after(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function withPage(run, response) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const writes = [];
  const errors = [];
  const dialogs = [];
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await mockBookingState(context);
    await context.route('**/exec', async route => {
      const request = route.request().postDataJSON();
      if (['menu', 'availability'].includes(request.type)) return route.continue();
      if (request.type === 'lookup') {
        return route.fulfill({ json: { ok: true, reservation: await page.evaluate(() => {
          const record = window.testBooking;
          return { code: record.code, date: record.date, time: record.time, endTime: record.endTime,
            totalMinutes: record.totalMinutes, totalPrice: record.totalPrice, totalLabel: record.totalLabel,
            name: record.customer.name, menuText: record.menus.map(menu => menu.name).join(' / '),
            staffName: record.staffName, status: '予約確定' };
        }) } });
      }
      writes.push(request);
      assert.ok(['reserve', 'change', 'cancel'].includes(request.type));
      return route.fulfill({ json: { code: request.code, ...response } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.goto(base + '/reserve.html');
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    await page.locator('#coupon-choices .selectable').first().click();
    await page.locator('#step-cta button').click();
    await page.locator('#cal-body .slot:not(:disabled)').first().click();
    await page.locator('#step-cta button').click();
    await page.locator('#f-name').fill('応答確認 試験');
    await page.locator('#f-kana').fill('オウトウカクニンシケン');
    await page.locator('#f-tel').fill('00000000000');
    await page.locator('#f-email').fill('response-check@example.test');
    await page.locator('[name="visit"][value="初めて"]').check();
    await page.locator('#f-agree').check();
    await page.locator('#step-cta button').click();
    assert.equal(await page.evaluate(() => state.step), 5);
    assert.equal(writes.length, 0);
    await run({ page, context, writes, dialogs });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function saveOriginal(page) {
  return page.evaluate(() => {
    const record = { ...buildReservation(), delivered: true, deliveryState: 'confirmed', deliveryError: '' };
    Store.add(record);
    return record;
  });
}

async function assertUnknownCompletion(page, writes, original = null) {
  await page.waitForFunction(() => !submitting && state.step === 6, null, { timeout: UI_RESULT_TIMEOUT_MS });
  assert.equal(writes.length, 1);
  assert.equal(await page.locator('#h-done').innerText(), 'ご予約の受付結果を確認できません');
  assert.equal(await page.locator('#done-warning').isVisible(), true);
  assert.equal(await page.locator('#add-to-calendar').isDisabled(), true);
  assert.equal(await page.locator('#sending-note').isVisible(), false);
  assert.equal(await page.locator('#done-code').innerText(), writes[0].code);
  const records = await page.evaluate(() => Store.all());
  assert.equal(records.length, 1);
  assert.equal(records[0].code, writes[0].code);
  assert.equal(records[0].delivered, false);
  assert.equal(records[0].deliveryState, 'unknown');
  if (original) {
    assert.deepEqual([records[0].date, records[0].time], [original.date, original.time]);
    assert.deepEqual(records[0].customer, original.customer);
  } else {
    assert.deepEqual([records[0].date, records[0].time], [writes[0].date, writes[0].time]);
    assert.deepEqual(records[0].customer, writes[0].customer);
  }
  await page.reload();
  await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
  assert.equal(writes.length, 1);
  assert.deepEqual(await page.evaluate(() => Store.all()), records);
}

for (const response of [{ ok: true, unknown: true }, { ok: false, unknown: true, taken: true }]) {
  test(`新規予約の矛盾応答で控えを消さず完了を先取りしない：${JSON.stringify(response)}`, () =>
    withPage(async ({ page, writes, dialogs }) => {
      await page.locator('#submit-reservation').click();
      await assertUnknownCompletion(page, writes);
      assert.deepEqual(dialogs, []);
    }, response));
}

test('接続先が未設定なら送信・完了扱いをせず、確認画面と入力を保持する', () =>
  withPage(async ({ page, writes, dialogs }) => {
    const before = await page.evaluate(() => ({ date: state.date, time: state.time, customer: state.customer,
      draft: sessionStorage.getItem(DRAFT_KEY), records: Store.all() }));
    await page.evaluate(() => { SALON.reservationEndpoint = ''; });
    await page.locator('#submit-reservation').click();
    await page.waitForFunction(() => !submitting);
    assert.equal(await page.evaluate(() => state.step), 5);
    assert.equal(await page.locator('#done-code').isVisible(), false);
    assert.equal(await page.locator('#sending-note').isVisible(), false);
    assert.equal(await page.locator('#submit-reservation').isDisabled(), false);
    assert.equal(writes.length, 0);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /店舗へ送信できません.*予約は登録されていません/);
    assert.deepEqual(await page.evaluate(() => ({ date: state.date, time: state.time, customer: state.customer,
      draft: sessionStorage.getItem(DRAFT_KEY), records: Store.all() })), before);
  }, { ok: true }));

for (const response of [{ ok: true, unknown: true }, { ok: false, unknown: true, restored: true }]) {
  test(`日時変更の矛盾応答で元の日時を未確認のまま保持する：${JSON.stringify(response)}`, () =>
    withPage(async ({ page, writes, dialogs }) => {
      const original = await saveOriginal(page);
      await page.goto(base + '/mypage.html');
      await page.locator('[data-change]').click();
      await page.waitForFunction(() => Catalog.loaded && Remote.loaded && changing !== null);
      await page.locator('#cal-body .slot:not(:disabled)').last().click();
      await page.locator('#step-cta button').click();
      assert.equal(await page.evaluate(() => state.step), 5);
      await page.locator('#submit-reservation').click();
      await assertUnknownCompletion(page, writes, original);
      assert.equal(writes[0].type, 'change');
      assert.notDeepEqual([writes[0].date, writes[0].time], [original.date, original.time]);
      assert.deepEqual(dialogs, []);
    }, response));
}

async function openCancellation(page, original, lookupOnly) {
  if (lookupOnly) await page.evaluate(code => Store.remove(code), original.code);
  await page.goto(base + '/mypage.html');
  if (lookupOnly) {
    await page.evaluate(record => { window.testBooking = record; }, original);
    await page.locator('#lookup-code').fill(original.code);
    await page.locator('#lookup-tel').fill(original.customer.tel);
    await page.locator('#lookup-btn').click();
    await page.locator('[data-lookup-cancel]').click();
  } else await page.locator('[data-cancel]').click();
  await page.getByRole('button', { name: 'キャンセルを確定する', exact: true }).click();
  await page.locator('#flash').waitFor({ state: 'visible' });
}

for (const lookupOnly of [false, true]) {
  for (const response of [{ ok: true, unknown: true }, { ok: false, unknown: true, deadline: true }]) {
    test(`${lookupOnly ? '照会から' : '端末の控えから'}の取消で矛盾応答を成功・確定拒否にしない：${JSON.stringify(response)}`, () =>
      withPage(async ({ page, writes, dialogs }) => {
        const original = await saveOriginal(page);
        await openCancellation(page, original, lookupOnly);
        assert.equal(writes.length, 1);
        assert.equal(writes[0].type, 'cancel');
        assert.match(await page.locator('#flash').innerText(), /取り消されている可能性/);
        assert.doesNotMatch(await page.locator('#flash').innerText(), /キャンセルを承りました|行われていません/);
        assert.equal(await page.locator('.booking-card.is-cancelled').count(), 0);
        const records = await page.evaluate(() => Store.all());
        if (lookupOnly) assert.deepEqual(records, []);
        else {
          assert.equal(records.length, 1);
          assert.equal(records[0].status, original.status);
          assert.equal(records[0].deliveryState, 'unknown');
          assert.deepEqual([records[0].date, records[0].time], [original.date, original.time]);
        }
        await page.reload();
        assert.equal(writes.length, 1);
        assert.deepEqual(await page.evaluate(() => Store.all()), records);
        assert.deepEqual(dialogs, []);
      }, response));
  }
}

test('正常な新規受付は番号と完了表示を確認してから控えを成立済みにする', () =>
  withPage(async ({ page, writes }) => {
    await page.locator('#submit-reservation').click();
    await page.waitForFunction(() => !submitting && state.step === 6);
    assert.equal(writes.length, 1);
    assert.equal(await page.locator('#done-warning').isVisible(), false);
    assert.match(await page.locator('#h-done').innerText(), /完了/);
    assert.equal(await page.locator('#add-to-calendar').isDisabled(), false);
    assert.equal((await page.evaluate(() => Store.all()))[0].deliveryState, 'confirmed');
  }, { ok: true, notificationsQueued: true }));

test('正常な日時変更は変更後の日時だけを成立済みとして表示する', () =>
  withPage(async ({ page, writes }) => {
    const original = await saveOriginal(page);
    await page.goto(base + '/mypage.html');
    await page.locator('[data-change]').click();
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded && changing !== null);
    await page.locator('#cal-body .slot:not(:disabled)').last().click();
    await page.locator('#step-cta button').click();
    await page.locator('#submit-reservation').click();
    await page.waitForFunction(() => !submitting && state.step === 6);
    assert.equal(writes.length, 1);
    assert.equal(await page.locator('#h-done').innerText(), '日時を変更しました');
    const record = (await page.evaluate(() => Store.all())).find(record => record.code === original.code);
    assert.equal(record.deliveryState, 'confirmed');
    assert.deepEqual([record.date, record.time], [writes[0].date, writes[0].time]);
    assert.notDeepEqual([record.date, record.time], [original.date, original.time]);
  }, { ok: true, notificationsQueued: true }));

for (const lookupOnly of [false, true]) {
  test(`${lookupOnly ? '照会から' : '端末の控えから'}の正常取消は成立後に取消状態を表示する`, () =>
    withPage(async ({ page, writes }) => {
      const original = await saveOriginal(page);
      await openCancellation(page, original, lookupOnly);
      assert.equal(writes.length, 1);
      assert.equal(await page.locator('#flash').innerText(), 'キャンセルを承りました。');
      const records = await page.evaluate(() => Store.all());
      if (lookupOnly) {
        assert.deepEqual(records, []);
        assert.deepEqual(await page.evaluate(() => ({ status: lastLookup.status, delivered: lastLookup.delivered,
          deliveryState: lastLookup.deliveryState })),
        { status: 'キャンセル', delivered: true, deliveryState: 'confirmed' });
      } else {
        const record = records.find(record => record.code === original.code);
        assert.equal(record.deliveryState, 'confirmed');
        assert.equal(record.status, 'cancelled');
      }
    }, { ok: true, alreadyCancelled: false }));
}
