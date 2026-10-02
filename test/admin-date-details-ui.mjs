import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createMockHandler } from './mock-gas.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const HISTORY_COUNT = 5000;
const CUSTOMER_COUNT = 250;
const TEST_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 20;
const VIEWPORT_WIDTHS = [320, 390, 768, 1280];
const CSV_HEADERS = ['予約番号', '来店日', '開始', '終了', 'メニュー', '担当', '金額',
  'お名前', '電話番号', 'メール', '来店回数', 'ご要望', '状態', '施術メモ'];
const CSV_FIELDS = ['code', 'date', 'time', 'endTime', 'menu', 'staffName', 'price',
  'name', 'tel', 'email', 'visit', 'request', 'status', 'note'];
const sourceOverride = process.env.ADMIN_SOURCE ? await readFile(process.env.ADMIN_SOURCE, 'utf8') : null;

async function waitUntil(check, message = '架空の詳細取得が始まりませんでした') {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await delay(POLL_INTERVAL_MS);
  }
}

function shiftDate(date, days) {
  const shifted = new Date(date + 'T12:00:00Z');
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function reservationRows(today) {
  const rows = Array.from({ length: HISTORY_COUNT }, (_, index) => {
    const customer = index % CUSTOMER_COUNT;
    return { code: `LM-D${String(index).padStart(7, '0')}`,
      date: shiftDate(today, index % 5 < 3 ? -4 - index % 365 : 1 + index % 60),
      time: '10:00', endTime: '11:00', menu: `架空カット${index}`, staffName: 'MATTEO',
      price: 6900 + index, name: `架空顧客${customer}`, tel: `090${String(customer).padStart(8, '0')}`,
      email: `fixture${customer}@example.test`, visit: '2回目以降', source: '直接',
      shopMailStatus: '', customerMailStatus: '', status: index % 11 ? '確定' : 'キャンセル',
      note: `保存済みの施術メモ${index}`, request: `過去のご要望 "確認", ${index}` };
  });
  for (const [index, time, endTime] of [[0, '10:00', '11:00'], [1, '12:00', '13:00'], [2, '14:00', '15:00']]) {
    Object.assign(rows[index], { date: shiftDate(today, -1), time, endTime,
      status: index === 2 ? 'キャンセル' : '確定' });
  }
  Object.assign(rows[2], { name: rows[0].name, tel: rows[0].tel, email: rows[0].email });
  for (const index of [3, 4]) rows[index].date = shiftDate(today, -2);
  Object.assign(rows[5], { date: today, status: '確定' });
  return rows;
}

function briefRows(rows, today) {
  return rows.map(row => {
    const copy = { ...row };
    if (copy.date < today) {
      delete copy.note;
      delete copy.request;
      copy.detailsPending = true;
    }
    return copy;
  });
}

async function fixture(design, run, prepareRows = () => {}) {
  let handler;
  const server = http.createServer((request, response) => handler(request, response));
  let browser;
  let context;
  const pending = [];
  const reads = [];
  const writes = [];
  const errors = [];
  const dialogs = [];
  let rows;
  let today;
  let closedDates = [];
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    handler = createMockHandler({ port: server.address().port });
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await engines.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo',
      serviceWorkers: 'block', acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(TEST_TIMEOUT_MS);
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base) {
        return route.abort();
      }
      if (sourceOverride && url.pathname === '/assets/js/admin.js') {
        return route.fulfill({ contentType: 'text/javascript', body: sourceOverride });
      }
      if (url.pathname !== '/exec' || request.method() !== 'POST') return route.continue();
      const payload = request.postDataJSON();
      if (payload.type === 'adminNote') {
        const row = rows.find(row => row.code === payload.code);
        writes.push({ type: payload.type, code: payload.code, note: payload.note, expectedNote: payload.expectedNote });
        if (!row || row.note !== payload.expectedNote) return route.fulfill({ json: { ok: false, conflict: true } });
        row.note = payload.note;
        return route.fulfill({ json: { ok: true, note: row.note } });
      }
      if (payload.type === 'adminChange') {
        const row = rows.find(row => row.code === payload.code);
        writes.push({ type: payload.type, code: payload.code, date: payload.date, time: payload.time });
        assert.ok(row, '架空の予約だけを変更する');
        Object.assign(row, { date: payload.date, time: payload.time,
          endTime: `${String(Number(payload.time.slice(0, 2)) + 1).padStart(2, '0')}:${payload.time.slice(3)}` });
        return route.fulfill({ json: { ok: true, reservation: { ...row } } });
      }
      if (payload.type === 'adminSave' && payload.target === 'closed') {
        writes.push({ type: payload.type, target: payload.target });
        closedDates = payload.rows.map(row => ({ ...row }));
        return route.fulfill({ json: { ok: true, stamps: { closed: 'fixture-closed-saved' } } });
      }
      if (payload.type !== 'adminData') {
        assert.ok(['adminLogin', 'adminAddStatus'].includes(payload.type), '指定外の架空書込をしない');
        return route.continue();
      }
      reads.push({ startupOnly: payload.startupOnly, briefPast: payload.briefPast,
        reservationsOnly: payload.reservationsOnly, reservationCodes: payload.reservationCodes?.slice() });
      if (payload.startupOnly) {
        const response = await route.fetch();
        const body = await response.json();
        assert.equal(body.ok, true, 'MOCK_ADMIN_PASSWORD で架空の管理画面へログインできる');
        if (!rows) {
          rows = reservationRows(today);
          prepareRows(rows);
        }
        body.reservations = briefRows(rows, today);
        body.closedDates = closedDates.map(row => ({ ...row }));
        delete body.styles;
        delete body.reviews;
        body.pendingEditors = ['styles', 'reviews'];
        return route.fulfill({ response, json: body });
      }
      assert.equal(payload.reservationsOnly, true, '追加の詳細取得は既存の予約専用APIを使う');
      if (payload.briefPast) return route.fulfill({ json: { ok: true,
        reservations: briefRows(rows, today), closedDates: closedDates.map(row => ({ ...row })) } });
      const result = { ok: true, reservations: rows.filter(row => !payload.reservationCodes
        || payload.reservationCodes.includes(row.code)).map(row => ({ ...row })),
      closedDates: closedDates.map(row => ({ ...row })) };
      const selected = { codes: payload.reservationCodes?.slice(), result, released: false, fulfilled: false };
      pending.push(selected);
      const response = await new Promise(resolve => { selected.release = resolve; });
      await route.fulfill({ json: response });
      selected.fulfilled = true;
    });
    await page.goto(base + '/admin.html' + design);
    today = await page.evaluate(() => toKey(new Date()));
    await page.evaluate(date => { document.querySelector('#filter-date').value = date; }, today);
    await page.locator('#passcode').fill(password);
    await page.locator('#remember-me').uncheck();
    await page.locator('#gate-btn').click();
    await page.locator('#dashboard:not([hidden])').waitFor();
    assert.equal(reads[0].briefPast, true);
    assert.equal(await page.evaluate(() => adminData.reservations.length), HISTORY_COUNT);
    assert.equal(await page.locator('#admin-rows [data-code]').count(), 1);
    const state = { page, rows, today, date: shiftDate(today, -1), otherDate: shiftDate(today, -2),
      codes: rows.slice(0, 3).map(row => row.code), pending, reads, writes, dialogs, errors };
    await run(state);
    assert.deepEqual(errors, [], '画面の JavaScript エラーなし');
  } finally {
    for (const selected of pending) {
      if (!selected.released) selected.release?.({ ok: false, error: '架空試験の終了' });
    }
    try { await context?.close(); } finally {
      try { await browser?.close(); } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
  }
}

async function chooseDate(page, date) {
  await page.locator('#filter-date').fill(date);
  await page.locator('#filter-date').dispatchEvent('change');
}

async function readAt(state, index, expectedCodes) {
  await waitUntil(() => state.pending.length > index);
  const selected = state.pending[index];
  assert.deepEqual(selected.codes?.slice().sort(), expectedCodes?.slice().sort(),
    '選択した日の未取得codeだけを送り、取消も含め、全量へfallbackしない');
  return selected;
}

async function reply(selected, result = selected.result) {
  assert.equal(selected.released, false, '同じ架空応答を二重に返さない');
  selected.released = true;
  selected.release(result);
  await waitUntil(() => selected.fulfilled, '架空の詳細応答が返りませんでした');
}

async function idle(page) {
  await page.waitForFunction(() => scopedDetailsReads.size === 0 && !reservationDetailsRead);
}

async function assertWidths(page) {
  for (const width of VIEWPORT_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `${width}px でページ横overflowなし`);
  }
}

async function customerCounts(page) {
  return page.evaluate(() => buildCustomers().map(customer => {
    const schedule = customerSchedule(customer.visits);
    return { tel: customer.tel, total: customer.visits.length, past: schedule.past.length,
      upcoming: schedule.upcoming.length, cancelled: schedule.cancelled.length, spent: customer.spent };
  }).sort((left, right) => left.tel.localeCompare(right.tel)));
}

function parseCsv(csv) {
  return csv.replace(/^\uFEFF/, '').split('\r\n').map(line => {
    const columns = line.match(/"(?:[^"]|"")*"/g);
    assert.ok(columns, 'CSV の各行を読める');
    return columns.map(column => column.slice(1, -1).replace(/""/g, '"'));
  });
}

for (const design of ['', '?design=a']) {
  const variant = design || '従来版';

  test(`${variant}: 対象日3件だけ取得し、日付往復・失敗・再取得でも5000件を保持する`, async () => {
    await fixture(design, async state => {
      const { page, date, otherDate, codes, rows } = state;
      const before = await customerCounts(page);
      const initialPending = await page.evaluate(() => adminData.reservations.filter(row => row.detailsPending).length);
      await page.locator('#filter-status').selectOption('reserved');
      await chooseDate(page, date);
      const first = await readAt(state, 0, codes);
      assert.equal(await page.locator('#admin-rows [data-note-input]').count(), 0);
      await assertWidths(page);
      await chooseDate(page, otherDate);
      const other = await readAt(state, 1, rows.slice(3, 5).map(row => row.code));
      await chooseDate(page, date);
      await chooseDate(page, otherDate);
      assert.equal(state.pending.length, 2, '同じ日の読込中に往復してもリクエストは1回');
      await reply(first);
      assert.equal(await page.locator('#filter-date').inputValue(), otherDate, '遅い応答で元の日へ表示を戻さない');
      await reply(other, { ok: false, error: '架空の詳細取得障害' });
      await idle(page);
      const retry = page.locator('#admin-rows [data-retry-date-details], #admin-rows [data-retry-history]');
      await retry.waitFor();
      assert.match(await page.locator('#admin-rows').innerText(), /確認できません|取得できません|読み込めません/);
      assert.equal(await page.locator('#admin-rows [data-note-input]').count(), 0, '未取得を空メモの編集欄にしない');
      assert.equal(await page.locator('#admin-rows [data-note-save]').count(), 0);
      assert.deepEqual(state.writes, [], '失敗した詳細を空メモとして保存しない');
      await retry.click();
      const retried = await readAt(state, 2, rows.slice(3, 5).map(row => row.code));
      await reply(retried);
      await idle(page);
      await page.locator('#filter-status').selectOption('all');
      await chooseDate(page, date);
      assert.equal(state.pending.length, 3, '取得済みの日を再表示しても通信しない');
      assert.equal(await page.locator('#admin-rows [data-code]').count(), 3, '取消も含め対象日の全行を表示する');
      for (const row of rows.slice(0, 3)) {
        assert.equal(await page.locator(`[data-note-box="${row.code}"] [data-note-input]`).inputValue(), row.note);
        assert.ok((await page.locator(`[data-code="${row.code}"]`).innerText()).includes(row.request));
      }
      assert.equal(await page.evaluate(() => adminData.reservations.length), HISTORY_COUNT);
      assert.equal(await page.evaluate(() => adminData.reservations.filter(row => row.detailsPending).length), initialPending - 5);
      assert.deepEqual(await customerCounts(page), before, '人ごとの履歴・取消・金額を数え落とさない');
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      assert.match(await page.locator('#customer-count').innerText(), new RegExp(`名簿 ${CUSTOMER_COUNT}件`));
      assert.equal(state.pending.length, 3, '名簿を開くだけでは他日のメモを取得しない');
      await page.locator('#admin-tabs [data-pane="reserve"]').click();
      await assertWidths(page);
      assert.deepEqual(state.dialogs, []);
    });
  });

  test(`${variant}: 全件CSVは先行する日付詳細を待ち、全量APIから全5000行・全14列を出力する`, async () => {
    await fixture(design, async state => {
      const { page, date, codes, rows } = state;
      await chooseDate(page, date);
      const selected = await readAt(state, 0, codes);
      await chooseDate(page, '');
      const downloads = [];
      page.on('download', download => downloads.push(download));
      const downloadEvent = page.waitForEvent('download');
      await page.locator('#export-csv').click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(state.pending.length, 1, '選択詳細の応答前には全量APIを開始しない');
      assert.equal(downloads.length, 0, '未取得のままCSVを出力しない');
      await reply(selected);
      const full = await readAt(state, 1, undefined);
      assert.equal(downloads.length, 0, '全量応答も待つ');
      await reply(full);
      const download = await downloadEvent;
      const csv = parseCsv(await readFile(await download.path(), 'utf8'));
      assert.equal(csv.length, HISTORY_COUNT + 1);
      assert.deepEqual(csv[0], CSV_HEADERS);
      const exported = new Map(csv.slice(1).map(columns => [columns[0], columns]));
      assert.equal(exported.size, HISTORY_COUNT, '全件の予約番号を重複なく出力する');
      for (const row of rows) assert.deepEqual(exported.get(row.code), CSV_FIELDS.map(field => String(row[field] ?? '')));
      assert.equal(await page.evaluate(() => adminData.reservations.length), HISTORY_COUNT);
      assert.equal(await page.evaluate(() => hasPendingReservationDetails()), false);
      assert.deepEqual(state.dialogs, []);
      assert.deepEqual(state.writes, []);
    });
  });

  test(`${variant}: 過去のカレンダーマスから開く詳細はその日3件だけを取得する`, async () => {
    await fixture(design, async state => {
      const { page, codes, date, rows } = state;
      await page.locator('#reserve-view [data-view="calendar"]').click();
      await page.locator('#acal-prev').click();
      await page.locator(`[data-cal-code="${codes[0]}"]`).first().click();
      const selected = await readAt(state, 0, codes);
      await reply(selected);
      await idle(page);
      await page.locator(`#admin-rows [data-code="${codes[0]}"].is-focus`).waitFor();
      assert.equal(await page.locator('#filter-date').inputValue(), date);
      assert.equal(await page.locator('#admin-rows [data-code]').count(), 3);
      assert.equal(await page.locator(`[data-note-box="${codes[0]}"] [data-note-input]`).inputValue(), rows[0].note);
      assert.equal(state.pending.length, 1, '全量読込へfallbackしない');
      await assertWidths(page);
      assert.deepEqual(state.writes, []);
      assert.deepEqual(state.dialogs, []);
    });
  });

  test(`${variant}: 顧客履歴からの詳細移動は同日の未取得codeだけを追加取得する`, async () => {
    await fixture(design, async state => {
      const { page, rows, today, date, codes } = state;
      const before = await customerCounts(page);
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      const customer = page.locator(`.customer-record[data-customer-tel="${rows[0].tel}"]`);
      await customer.locator('[data-customer-history]').click();
      const customerCodes = rows.filter(row => row.tel === rows[0].tel && row.date < today).map(row => row.code);
      await reply(await readAt(state, 0, customerCodes));
      await idle(page);
      assert.match(await customer.locator('.customer-profile').innerText(),
        new RegExp(`すべての予約を見る（${rows.filter(row => row.tel === rows[0].tel).length}件`));
      await customer.locator(`[data-history-booking="${codes[0]}"]`).click();
      await reply(await readAt(state, 1, [codes[1]]));
      await idle(page);
      await page.locator(`#admin-rows [data-code="${codes[0]}"]`).waitFor();
      assert.equal(await page.locator('#filter-date').inputValue(), date);
      assert.equal(await page.locator('#admin-rows [data-code]').count(), 3);
      assert.deepEqual(await customerCounts(page), before);
      assert.equal(state.pending.length, 2);
      assert.deepEqual(state.writes, []);
      assert.deepEqual(state.dialogs, []);
    });
  });

  test(`${variant}: 日付取得で完成した展開中顧客の未取得表示を更新し、他顧客のDOMを保持する`, async () => {
    await fixture(design, async state => {
      const { page, rows, codes, date } = state;
      const before = await customerCounts(page);
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      const customer = page.locator(`.customer-record[data-customer-tel="${rows[0].tel}"]`);
      await customer.locator('[data-customer-history]').click();
      await reply(await readAt(state, 0, [codes[0], codes[2]]));
      await idle(page);
      assert.equal(await customer.locator('[data-note-input]').inputValue(), rows[0].note);
      await page.locator('#admin-tabs [data-pane="reserve"]').click();
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(code => adminData.reservations.find(row => row.code === code).detailsPending === true, codes[0]);
      assert.equal(state.reads.filter(read => read.reservationsOnly && read.briefPast).length, 1);
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      await customer.locator('[data-retry-customer-history]').waitFor();
      assert.equal(await customer.locator('[data-note-input]').count(), 0);
      const other = page.locator(`.customer-record[data-customer-tel="${rows[5].tel}"]`);
      await other.evaluate(record => {
        window.fixtureOtherCustomer = record;
        window.fixtureOtherProfile = record.querySelector('.customer-profile');
        window.fixtureOtherSummary = record.querySelector('[data-customer-history]');
      });
      await page.locator('#admin-tabs [data-pane="reserve"]').click();
      await chooseDate(page, date);
      await reply(await readAt(state, 1, codes));
      await idle(page);
      assert.equal(await customer.locator('[data-note-input]').count(), 1,
        '日付取得で完成した展開中顧客を、未取得表示のまま残さない');
      assert.equal(await customer.locator('[data-note-input]').inputValue(), rows[0].note);
      assert.equal(await customer.locator('[data-retry-customer-history]').count(), 0);
      assert.deepEqual(await other.evaluate(record => ({ record: record === fixtureOtherCustomer,
        profile: record.querySelector('.customer-profile') === fixtureOtherProfile,
        summary: record.querySelector('[data-customer-history]') === fixtureOtherSummary })),
      { record: true, profile: true, summary: true }, '日付取得の対象外顧客のDOMを作り直さない');
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      assert.equal(await customer.evaluate(record => record.open), true);
      assert.equal(await customer.locator('[data-note-input]').inputValue(), rows[0].note);
      assert.equal(state.pending.length, 2, '取得済みの履歴を再取得しない');
      assert.deepEqual(await customerCounts(page), before);
      assert.deepEqual(state.writes, []);
      assert.deepEqual(state.dialogs, []);
    }, rows => {
      for (const index of [0, 2]) rows[index].tel = '00000000000';
    });
  });

  for (const navigation of ['today', 'other-booking', 'same-day-booking']) {
    test(`${variant}: カレンダーAの遅い詳細応答は ${navigation} への選び直しを戻さない`, async () => {
      await fixture(design, async state => {
        const { page, codes, rows, date, today, otherDate } = state;
        await page.locator('#reserve-view [data-view="calendar"]').click();
        await page.locator('#acal-prev').click();
        await page.locator(`[data-cal-code="${codes[0]}"]`).first().click();
        const first = await readAt(state, 0, codes);
        let focusedCode;
        let expectedDate;
        let expectedView;
        if (navigation === 'today') {
          await page.locator('#filter-today').click();
          expectedDate = today;
          expectedView = await page.evaluate(() => reserveView);
        } else {
          focusedCode = navigation === 'other-booking' ? rows[3].code : codes[1];
          await page.locator(`[data-cal-code="${focusedCode}"]`).first().click();
          expectedDate = navigation === 'other-booking' ? otherDate : date;
          expectedView = 'list';
          if (navigation === 'other-booking') {
            await reply(await readAt(state, 1, rows.slice(3, 5).map(row => row.code)));
            await page.locator(`#admin-rows [data-code="${focusedCode}"].is-focus`).waitFor();
            assert.equal(await page.locator('#filter-date').inputValue(), expectedDate);
          }
        }
        await reply(first);
        await idle(page);
        assert.equal(await page.locator('#filter-date').inputValue(), expectedDate,
          '古いカレンダーAの応答で選び直した表示日を戻さない');
        assert.equal(await page.evaluate(() => reserveView), expectedView, '選び直した表示方法を保持する');
        assert.equal(await page.locator(`#admin-rows [data-code="${codes[0]}"].is-focus`).count(), 0,
          '古いカレンダーAへhighlightを戻さない');
        if (focusedCode) {
          assert.equal(await page.locator('#admin-rows .is-focus').count(), 1);
          assert.equal(await page.locator('#admin-rows .is-focus').getAttribute('data-code'), focusedCode,
            '後から選んだ予約Bを保持する');
        } else assert.equal(await page.locator('#admin-rows [data-code]').count(), 1);
        assert.equal(state.pending.length, navigation === 'other-booking' ? 2 : 1,
          '同じ日には1回だけ通信し、全量へfallbackしない');
        assert.deepEqual(state.writes, []);
        assert.deepEqual(state.dialogs, []);
      });
    });
  }

  for (const order of ['date-first', 'customer-first']) {
    for (const conflict of ['', 'note', 'request']) {
      test(`${variant}: 重なる日付・顧客取得 ${order} ${conflict ? `違う${conflict}を上書きしない` : '同じ詳細なら両方成功'}`, async () => {
        await fixture(design, async state => {
          const { page, date, codes, rows, today } = state;
          await chooseDate(page, date);
          const dateRead = await readAt(state, 0, codes);
          await page.locator('#admin-tabs [data-pane="customers"]').click();
          const customer = page.locator(`.customer-record[data-customer-tel="${rows[0].tel}"]`);
          await customer.locator('[data-customer-history]').click();
          const customerRead = await readAt(state, 1,
            rows.filter(row => row.tel === rows[0].tel && row.date < today).map(row => row.code));
          await page.evaluate(() => { window.fixtureReadResults = Promise.all([...scopedDetailsReads.values()]); });
          const first = order === 'date-first' ? dateRead : customerRead;
          const second = order === 'date-first' ? customerRead : dateRead;
          await reply(first);
          await page.waitForFunction(code => !adminData.reservations.find(row => row.code === code).detailsPending, codes[0]);
          const retained = await page.evaluate(code => {
            const row = adminData.reservations.find(row => row.code === code);
            return { note: row.note, request: row.request };
          }, codes[0]);
          const result = structuredClone(second.result);
          if (conflict) {
            const overlap = result.reservations.find(row => row.code === codes[0]);
            overlap[conflict] = '競合する別の内容';
          }
          await reply(second, result);
          const outcomes = await page.evaluate(() => fixtureReadResults);
          assert.deepEqual(outcomes, conflict ? (order === 'date-first' ? [true, false] : [false, true]) : [true, true]);
          await idle(page);
          assert.deepEqual(await page.evaluate(code => {
            const row = adminData.reservations.find(row => row.code === code);
            return { note: row.note, request: row.request };
          }, codes[0]), retained);
          assert.equal(await page.evaluate(() => adminData.reservations.length), HISTORY_COUNT);
          if (!conflict) assert.equal(await page.evaluate(() => scopedDetailsErrors.size), 0);
          assert.deepEqual(state.writes, []);
          assert.deepEqual(state.dialogs, []);
        });
      });
    }
  }

  for (const saved of [false, true]) {
    test(`${variant}: 重なる顧客取得後に同じ予約のメモを${saved ? '保存' : '下書き'}しても日付応答で上書きしない`, async () => {
      await fixture(design, async state => {
        const { page, date, codes, rows, today } = state;
        await chooseDate(page, date);
        const dateRead = await readAt(state, 0, codes);
        await page.locator('#admin-tabs [data-pane="customers"]').click();
        const customer = page.locator(`.customer-record[data-customer-tel="${rows[0].tel}"]`);
        await customer.locator('[data-customer-history]').click();
        const customerRead = await readAt(state, 1,
          rows.filter(row => row.tel === rows[0].tel && row.date < today).map(row => row.code));
        await page.evaluate(date => { window.fixtureDateResult = scopedDetailsReads.get('date:' + date); }, date);
        await reply(customerRead);
        const box = customer.locator(`[data-note-box="${codes[0]}"]`);
        await box.locator('[data-note-summary]').click();
        const input = box.locator('[data-note-input]');
        const original = rows[0].note;
        const draft = '同じ予約に追加した新しい申し送り';
        await input.fill(draft);
        if (saved) {
          await box.locator('[data-note-save]').click();
          await page.waitForFunction(({ code, note }) => adminData.reservations.find(row => row.code === code).note === note,
            { code: codes[0], note: draft });
        }
        await reply(dateRead);
        assert.equal(await page.evaluate(() => fixtureDateResult), false, '保存・下書き後の古い詳細を競合として保留する');
        await idle(page);
        assert.equal(await input.inputValue(), draft);
        assert.equal(await input.evaluate(element => element.defaultValue), saved ? draft : original);
        assert.equal(await page.evaluate(code => adminData.reservations.find(row => row.code === code).note, codes[0]), saved ? draft : original);
        assert.equal(await page.evaluate(code => adminData.reservations.find(row => row.code === code).detailsPending, codes[1]), true,
          '競合した応答の一部だけを取り込まない');
        assert.equal(await page.evaluate(() => adminData.reservations.length), HISTORY_COUNT);
        assert.deepEqual(state.writes.map(write => write.type), saved ? ['adminNote'] : []);
        if (saved) assert.deepEqual(state.dialogs, []);
        else assert.ok(state.dialogs.every(message => /書きかけ、または保存中の施術メモ/.test(message)),
          '未保存を保護する案内以外の警告を出さない');
      });
    });
  }

  for (const change of ['note-draft', 'note-saved', 'booking-draft', 'booking-saved', 'closed-draft', 'closed-saved', 'relogin', 'metadata']) {
    test(`${variant}: 遅い日付詳細は ${change} を巻き戻さない`, async () => {
      await fixture(design, async state => {
        const { page, date, today, codes, rows } = state;
        await chooseDate(page, date);
        const selected = await readAt(state, 0, codes);
        await chooseDate(page, today);
        const currentCode = rows[5].code;
        const savedNote = rows[5].note;
        const draftNote = '通信中に書いた申し送り';
        const holiday = shiftDate(today, 400);
        let input;
        if (change.startsWith('note-')) {
          const box = page.locator(`#admin-rows [data-note-box="${currentCode}"]`);
          await box.locator('[data-note-summary]').click();
          input = box.locator('[data-note-input]');
          await input.fill(draftNote);
          if (change === 'note-saved') {
            await box.locator('[data-note-save]').click();
            await page.waitForFunction(({ code, note }) => adminData.reservations.find(row => row.code === code).note === note,
              { code: currentCode, note: draftNote });
          }
        } else if (change.startsWith('booking-')) {
          await page.locator(`[data-admin-change="${currentCode}"]`).click();
          input = page.locator('[data-change-time]');
          await input.selectOption('14:00');
          if (change === 'booking-saved') {
            await page.locator('[data-change-save]').click();
            await page.getByRole('dialog').getByRole('button', { name: 'この日時へ変更する', exact: true }).click();
            await page.waitForFunction(code => !activeChange && adminData.reservations.find(row => row.code === code).time === '14:00', currentCode);
            await page.waitForFunction(() => document.querySelector('#reservation-freshness').textContent.includes('最新の予定を読み込みました'));
          }
        } else if (change.startsWith('closed-')) {
          await page.locator('#admin-tabs [data-pane="closed"]').click();
          await page.locator('[data-add="closed"]').click();
          const closed = page.locator('#closed-rows .booking-card').last();
          await closed.locator('[data-col="休業日"]').fill(holiday);
          input = closed.locator('[data-col="メモ"]');
          await input.fill(draftNote);
          if (change === 'closed-saved') {
            await page.locator('[data-save="closed"]').click();
            await page.waitForFunction(date => adminData.closedDates.some(row => row.休業日 === date), holiday);
          }
        } else if (change === 'relogin') {
          rows[0].name = '再ログイン後の架空顧客';
          await page.evaluate(() => openDashboard());
          await page.evaluate(() => { window.fixtureGenerationRows = adminData.reservations; });
        }
        const result = structuredClone(selected.result);
        result.closedDates = [{ 休業日: shiftDate(today, 401), 開始: '', 終了: '', メモ: '古い応答の休業' }];
        if (change === 'metadata') result.reservations[0].time = '09:00';
        await reply(selected, result);
        await idle(page);
        assert.equal(await page.evaluate(() => adminData.reservations.length), HISTORY_COUNT);
        assert.equal(await page.evaluate(date => adminData.closedDates.some(row => row.休業日 === date), shiftDate(today, 401)), false,
          '選択詳細からclosedDatesを採用しない');
        if (change.startsWith('note-')) {
          assert.equal(await input.inputValue(), draftNote);
          assert.equal(await input.evaluate(element => element.defaultValue), change === 'note-saved' ? draftNote : savedNote);
          assert.equal(await page.evaluate(code => adminData.reservations.find(row => row.code === code).note, currentCode),
            change === 'note-saved' ? draftNote : savedNote);
        } else if (change === 'booking-draft') {
          assert.equal(await input.inputValue(), '14:00');
          assert.equal(await page.evaluate(code => adminData.reservations.find(row => row.code === code).time, currentCode), '10:00');
          assert.equal(await page.evaluate(() => !!activeChange), true);
        } else if (change === 'booking-saved') {
          assert.equal(await page.evaluate(code => adminData.reservations.find(row => row.code === code).time, currentCode), '14:00');
        } else if (change.startsWith('closed-')) {
          assert.equal(await input.inputValue(), draftNote);
          assert.equal(await page.evaluate(date => edits.closed.some(row => row.休業日 === date && row.メモ === '通信中に書いた申し送り'), holiday), true);
          assert.equal(await page.evaluate(() => isDirty('closed')), change === 'closed-draft');
          assert.equal(await page.evaluate(date => adminData.closedDates.some(row => row.休業日 === date), holiday), change === 'closed-saved');
        } else if (change === 'relogin') {
          assert.equal(await page.evaluate(() => adminData.reservations === fixtureGenerationRows), true);
          assert.equal(await page.evaluate(code => adminData.reservations.find(row => row.code === code).name, codes[0]), rows[0].name);
        }
        if (['note-draft', 'booking-draft', 'booking-saved', 'relogin', 'metadata'].includes(change)) {
          assert.equal(await page.evaluate(codes => codes.every(code => adminData.reservations.find(row => row.code === code).detailsPending), codes), true,
            '競合した選択詳細を取り込まない');
        }
        assert.equal(await page.locator('#filter-date').inputValue(), today, '詳細応答で表示日を巻き戻さない');
        assert.deepEqual(state.writes.map(write => write.type), change === 'note-saved' ? ['adminNote']
          : change === 'booking-saved' ? ['adminChange'] : change === 'closed-saved' ? ['adminSave'] : []);
        assert.deepEqual(state.dialogs, []);
      });
    });
  }
}
