import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { mockBookingState } from './booking-state-fixture.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const GAS_SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const TEST_WAIT_MS = 5000;
const BOOKING = {
  code: 'LM-FINAL', status: 'reserved', date: '2099-10-08', time: '10:00', endTime: '11:00',
  totalMinutes: 60, totalPrice: 4000, staffName: '試験担当', staffId: 'st01', nominationFee: 0,
  menus: [{ id: 'm01', name: '試験用カット', price: 4000, minutes: 60 }],
  delivered: true, deliveryState: 'confirmed', deliveryError: '',
  customer: { name: '架空の確認客', tel: '00000000000', email: 'final@example.test', request: '' }
};

function cancellationLedger() {
  const record = {
    予約番号: BOOKING.code, 来店日: BOOKING.date, 開始: BOOKING.time, 終了: BOOKING.endTime,
    '所要(分)': BOOKING.totalMinutes, 合計金額: BOOKING.totalPrice, 状態: '予約確定',
    お名前: BOOKING.customer.name, 電話番号: BOOKING.customer.tel, メール: BOOKING.customer.email,
    担当: BOOKING.staffName, メニュー: BOOKING.menus[0].name
  };
  const writes = [];
  let headers;
  const sheet = {
    getLastRow: () => 2,
    getLastColumn: () => headers.length,
    getRange(row, column, height = 1, width = 1) {
      const range = {
        getValues: () => [headers, headers.map(header => record[header] ?? '')]
          .slice(row - 1, row - 1 + height)
          .map(cells => cells.slice(column - 1, column - 1 + width)),
        setValue(value) {
          assert.equal(row, 2);
          writes.push({ column, value });
          record[headers[column - 1]] = value;
          return range;
        }
      };
      return range;
    }
  };
  const context = vm.createContext({ Date, console: { warn() {}, error() {} },
    SpreadsheetApp: { flush() {} } });
  vm.runInContext(GAS_SOURCE, context);
  headers = Array.from(vm.runInContext('HEADERS', context));
  context.isAdmin_ = () => false;
  context.readBookingSettings_ = () => ({});
  context.stageBookingEmails_ = () => true;
  return { record, writes, cancel: payload => context.doCancel_(sheet, payload) };
}

async function fixture(run, { records = [] } = {}) {
  const server = http.createServer();
  let browser;
  let context;
  const releases = [];
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    server.on('request', createMockHandler({ port }));
    const base = `http://127.0.0.1:${port}`;
    const post = async payload => {
      const response = await fetch(`${base}/exec`, {
        method: 'POST', body: JSON.stringify(payload)
      });
      return response.json();
    };
    browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
      process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    context = await browser.newContext({ viewport: { width: 390, height: 844 },
      locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    context.setDefaultTimeout(TEST_WAIT_MS);
    await context.route('**/*', route => new URL(route.request().url()).origin === base
      ? route.continue() : route.abort());
    await mockBookingState(context, { approved: true, draft: false });
    await context.addInitScript(records => {
      if (!sessionStorage.getItem('final-booking-initialized')) {
        localStorage.setItem('salon.reservations.v1', JSON.stringify(records));
        sessionStorage.setItem('final-booking-initialized', 'true');
      }
    }, records);
    const page = await context.newPage();
    const errors = [];
    const notices = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { notices.push(dialog.message()); await dialog.accept(); });
    await run({ page, base, context, post, releases, notices });
    assert.deepEqual(errors, [], 'JavaScript例外なし');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
      '横はみ出しなし');
  } finally {
    releases.forEach(release => release());
    await context?.close();
    await browser?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

async function fillReservation(page, base) {
  await page.goto(`${base}/reserve.html`);
  await page.waitForFunction(() => typeof Catalog !== 'undefined' && Catalog.loaded && Remote.loaded);
  await page.locator('#coupon-choices .selectable').first().click();
  await page.locator('[data-next="2"]').first().click();
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
  await page.fill('#f-name', '架空の通信客');
  await page.fill('#f-kana', 'カクウノツウシンキャク');
  await page.fill('#f-tel', '00000000000');
  await page.fill('#f-email', 'final-reserve@example.test');
  await page.locator('label.radio-chip:has-text("初めて")').first().click();
  await page.locator('.checkbox-line > span').click();
  await page.locator('[data-next="5"]').first().click();
}

async function openMyPage(page, base, fromLookup) {
  await page.goto(`${base}/mypage.html`);
  if (!fromLookup) return;
  await page.fill('#lookup-code', BOOKING.code);
  await page.fill('#lookup-tel', BOOKING.customer.tel);
  await page.locator('#lookup-btn').click();
  await page.locator('#lookup-result .booking-card').waitFor();
}

const lookupRecord = changes => ({
  code: BOOKING.code, date: BOOKING.date, time: BOOKING.time, endTime: BOOKING.endTime,
  totalMinutes: BOOKING.totalMinutes, totalPrice: BOOKING.totalPrice,
  name: BOOKING.customer.name, staffName: BOOKING.staffName, menuText: BOOKING.menus[0].name,
  status: '予約確定', ...changes
});

for (const fromLookup of [false, true]) {
  test(`${fromLookup ? '照会' : '端末控え'}の取消は、確認後に変わった日時を取り消さない`, async () => {
    await fixture(async ({ page, base }) => {
      const ledger = cancellationLedger();
      const requests = [];
      await page.route('**/exec', async route => {
        const payload = route.request().postDataJSON();
        if (payload.type === 'lookup') return route.fulfill({ json: { ok: true,
          reservation: lookupRecord({ date: ledger.record.来店日, status: ledger.record.状態 }) } });
        if (payload.type !== 'cancel') return route.continue();
        requests.push(payload);
        await route.fulfill({ json: ledger.cancel(payload) });
      });
      await openMyPage(page, base, fromLookup);
      await page.locator(fromLookup ? '[data-lookup-cancel]' : '[data-cancel]').click();
      ledger.record.来店日 = '2099-10-09';
      await page.getByRole('button', { name: 'キャンセルを確定する', exact: true }).click();
      await page.locator('#flash').waitFor({ state: 'visible' });
      assert.equal(ledger.record.状態, '予約確定', '実GASの日時照合で新しい予約を守る');
      assert.deepEqual(ledger.writes, [], '取消の書込なし');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].fromDate, BOOKING.date);
      assert.equal(requests[0].fromTime, BOOKING.time);
      assert.match(await page.locator('#flash').innerText(), /最新/);
      assert.doesNotMatch(await page.locator('#flash').innerText(), /取り消されている可能性/);
      await page.locator('[data-check-booking]').first().click();
      await page.locator('#lookup-btn:not([disabled])').waitFor();
      assert.equal(await page.locator('#lookup-result .status-chip').textContent(), '予約確定');
      assert.match(await page.locator('#lookup-result .booking-when').textContent(), /10月9日/);
      assert.equal(requests.length, 1, '照会で再取消しない');
    }, { records: fromLookup ? [] : [BOOKING] });
  });

  test(`${fromLookup ? '照会' : '端末控え'}の取消は、確認した日時が同じなら一度だけ反映する`, async () => {
    await fixture(async ({ page, base }) => {
      const ledger = cancellationLedger();
      const requests = [];
      await page.route('**/exec', async route => {
        const payload = route.request().postDataJSON();
        if (payload.type === 'lookup') return route.fulfill({ json: { ok: true, reservation: lookupRecord() } });
        if (payload.type !== 'cancel') return route.continue();
        requests.push(payload);
        await route.fulfill({ json: ledger.cancel(payload) });
      });
      await openMyPage(page, base, fromLookup);
      await page.locator(fromLookup ? '[data-lookup-cancel]' : '[data-cancel]').click();
      await page.getByRole('button', { name: 'キャンセルを確定する', exact: true }).click();
      await page.locator('#flash').waitFor({ state: 'visible' });
      assert.equal(ledger.record.状態, 'キャンセル');
      assert.equal(ledger.writes.length, 1);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].fromDate, BOOKING.date);
      assert.equal(requests[0].fromTime, BOOKING.time);
      assert.equal(await page.locator('[data-cancel], [data-lookup-cancel], [data-change]').count(), 0);
      assert.match(await page.locator('#flash').innerText(), /キャンセルを承りました/);
    }, { records: fromLookup ? [] : [BOOKING] });
  });

  test(`${fromLookup ? '照会' : '端末控え'}の取消応答を失った後、古い照会で確定表示へ戻さない`, async () => {
    await fixture(async ({ page, base, releases }) => {
      let finishCancellation;
      let releaseLookup;
      let lookupStarted;
      let cancelling = false;
      let cancelled = false;
      let cancellations = 0;
      const cancellationGate = new Promise(resolve => { finishCancellation = resolve; });
      const lookupGate = new Promise(resolve => { releaseLookup = resolve; });
      const lookupReady = new Promise(resolve => { lookupStarted = resolve; });
      releases.push(finishCancellation, releaseLookup);
      await page.route('**/exec', async route => {
        const payload = route.request().postDataJSON();
        if (payload.type === 'cancel') {
          cancellations++;
          cancelling = true;
          await cancellationGate;
          cancelled = true;
          await route.fulfill({ status: 503, body: '試験用の応答断' });
          return;
        }
        if (payload.type !== 'lookup') return route.continue();
        const reservation = lookupRecord({ status: cancelled ? 'キャンセル' : '予約確定' });
        if (cancelling && !cancelled) {
          lookupStarted();
          await lookupGate;
        }
        await route.fulfill({ json: { ok: true, reservation } });
      });
      await openMyPage(page, base, fromLookup);
      await page.locator(fromLookup ? '[data-lookup-cancel]' : '[data-cancel]').click();
      await page.getByRole('button', { name: 'キャンセルを確定する', exact: true }).click();
      await page.locator('[data-check-booking]').first().click();
      await lookupReady;
      finishCancellation();
      await page.waitForFunction(() => document.querySelector('#flash').textContent.includes('反映結果'));
      releaseLookup();
      await page.locator('#lookup-btn:not([disabled])').waitFor();
      assert.equal(await page.locator('[data-cancel]:not([disabled]), [data-lookup-cancel]:not([disabled]), [data-change]').count(), 0,
        '照会開始後に結果が変わった操作は再度の照会を要求する');
      if (!fromLookup) assert.equal(await page.evaluate(code => Store.find(code).deliveryState, BOOKING.code), 'unknown');
      await page.locator('#lookup-btn').click();
      await page.locator('#lookup-btn:not([disabled])').waitFor();
      assert.equal(await page.locator('#lookup-result .status-chip').textContent(), 'キャンセル済み');
      assert.equal(cancellations, 1);
    }, { records: fromLookup ? [] : [BOOKING] });
  });
}

for (const response of [{ ok: true }, { ok: true, code: '' }, { ok: true, code: 12 },
  { ok: true, code: {} }, { ok: true, code: ' ' }, { ok: true, code: '<invalid>' }]) {
  test(`新規予約の番号不明の成功応答${JSON.stringify(response)}を、予約確定と表示しない`, async () => {
    await fixture(async ({ page, base }) => {
      const requests = [];
      await page.route('**/exec', async route => {
        const payload = route.request().postDataJSON();
        if (payload.type !== 'reserve') return route.continue();
        requests.push(payload);
        await route.fulfill({ json: response });
      });
      await fillReservation(page, base);
      await page.locator('#submit-reservation').click();
      await page.waitForFunction(() => !submitting && state.step === 6);
      assert.equal(requests.length, 1);
      assert.equal(await page.locator('#done-code').textContent(), requests[0].code);
      assert.match(await page.locator('#h-done').innerText(), /受付結果を確認できません/);
      assert.equal(await page.locator('#add-to-calendar').isDisabled(), true);
      assert.equal(await page.evaluate(() => Store.all()[0].deliveryState), 'unknown');
      await page.goto(`${base}/mypage.html`);
      assert.equal(await page.locator('#upcoming-list .status-chip').textContent(), '受付未確認');
      assert.equal(await page.locator('[data-cancel], [data-change]').count(), 0);
      assert.equal(requests.length, 1, '結果不明で自動再予約しない');
    });
  });
}

test('新規予約の二重クリックと送信中の画面操作でも、一度だけ保存する', async () => {
  await fixture(async ({ page, base, releases }) => {
    const requests = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    releases.push(release);
    await page.route('**/exec', async route => {
      const payload = route.request().postDataJSON();
      if (payload.type !== 'reserve') return route.continue();
      requests.push(payload);
      await gate;
      await route.continue();
    });
    await fillReservation(page, base);
    await page.locator('#submit-reservation').click();
    await page.evaluate(() => { void submitReservation(); void submitReservation(); });
    await page.locator('[data-panel="5"] [data-prev="4"]').dispatchEvent('click');
    assert.equal(await page.evaluate(() => state.step), 5);
    assert.equal(await page.locator('[data-panel="5"] [data-prev="4"]').isDisabled(), true);
    assert.equal(await page.locator('#submit-reservation').isDisabled(), true);
    const record = await page.evaluate(() => Store.all()[0]);
    assert.equal(record.deliveryState, 'unknown');
    assert.match(await page.locator('#sending-note').innerText(), new RegExp(record.code));
    release();
    await page.waitForFunction(() => !submitting && state.step === 6);
    assert.equal(requests.length, 1);
    assert.equal(await page.locator('#done-code').innerText(), requests[0].code);
    assert.equal(await page.evaluate(() => Store.all()[0].deliveryState), 'confirmed');
    assert.equal(await page.locator('#add-to-calendar').isDisabled(), false);
  });
});

for (const saveFirst of [false, true]) {
  test(`控えを保存できず、予約${saveFirst ? '保存後' : '保存前'}に応答を失っても番号で照会できる`, async () => {
    await fixture(async ({ page, context, base }) => {
      const requests = [];
      await page.route('**/exec', async route => {
        const payload = route.request().postDataJSON();
        if (payload.type !== 'reserve') return route.continue();
        requests.push(payload);
        if (saveFirst) assert.equal((await (await route.fetch()).json()).ok, true);
        await route.fulfill({ status: 503, body: '試験用の応答断' });
      });
      await fillReservation(page, base);
      const disableReceipt = () => {
        const originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'salon.reservations.v1') throw new Error('試験用の保存拒否');
          return originalSetItem.call(this, key, value);
        };
      };
      await page.evaluate(disableReceipt);
      await context.addInitScript(disableReceipt);
      await page.locator('#submit-reservation').click();
      await page.waitForFunction(() => !submitting && state.step === 6);
      const code = await page.locator('#done-code').innerText();
      assert.match(await page.locator('#done-follow').innerText(), /この端末に控えを保存できません/);
      assert.equal(await page.locator('#add-to-calendar').isDisabled(), true);
      await page.goto(`${base}/mypage.html`);
      assert.equal(await page.evaluate(() => Store.all().length), 0);
      await page.fill('#lookup-code', code);
      await page.fill('#lookup-tel', '00000000000');
      await page.locator('#lookup-btn').click();
      await page.locator('#lookup-btn:not([disabled])').waitFor();
      if (saveFirst) assert.equal(await page.locator('#lookup-result .status-chip').innerText(), '予約確定');
      else assert.equal(await page.locator('#lookup-error').isVisible(), true);
      assert.equal(requests.length, 1, '番号の手入力による照会で再予約しない');
    });
  });
}
