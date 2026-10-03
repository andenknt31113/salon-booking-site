import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const source = await readFile(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const common = await readFile(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const TEST_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 20;
const FIRST = { code: 'LM-REVIEW-A', date: '2020-01-01', time: '10:00', endTime: '11:00',
  menu: '架空カット', name: '架空のお客様A', tel: '09000000000', status: '確定', price: 6900,
  detailsPending: true };
const SECOND = { ...FIRST, code: 'LM-REVIEW-B', name: '架空のお客様B', tel: '09000000001' };
const HTML = `<input id="customer-search">
  <select id="customer-sort"><option value="recent">recent</option></select>
  <button id="clear-customer-search">clear</button>
  <input id="filter-date"><select id="filter-status"><option value="all">all</option></select>
  <button id="refresh-reservations">refresh</button><p id="reservation-freshness"></p>
  <div class="admin-pane" data-pane="customers"><p id="customer-count"></p>
    <nav id="customer-pages" hidden><button id="customer-previous"></button><span id="customer-page-label"></span>
      <button id="customer-next"></button></nav><div id="customer-rows"></div></div>`;

function extract(text, name, optional = false) {
  const match = text.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match || optional, `${name} が見つかりません`);
  return match?.[0] || '';
}

const functions = ['validReservationRefresh', 'hasPendingReservationDetails', 'loadCustomerDetails',
  'loadReservationDateDetails', 'sameSelectedReservationSnapshot', 'loadSelectedReservationDetails', 'renderSelectedReservationDetails',
  'loadReservationDetails', 'hasUnsavedReservationNotes', 'guardNoteFilters', 'buildCustomers',
  'customerSchedule', 'customerProfileHtml', 'closeCustomerProfile', 'renderCustomers',
  'noteEditorHtml', 'filteredReservations', 'exportCsv', 'refreshReservations', 'telKey', 'searchKey']
  .map(name => extract(source, name)).join('\n') + '\n' + extract(source, 'renderCustomerDetails', true);
const helpers = ['toKey', 'fromKey', 'formatDateJa', 'esc', 'toHalfWidth', 'toKatakana']
  .map(name => extract(common, name)).join('\n');
const clickStart = source.indexOf("    const customer = e.target.closest('[data-customer-history]');");
const clickEnd = source.indexOf('    const customerBooking =', clickStart);
const retry = source.match(/^    const retryCustomerHistory =[^\n]*\n    if \(retryCustomerHistory\)[^\n]*\n/m);
assert.ok(clickStart >= 0 && clickEnd > clickStart && retry, 'お客様の開閉・再取得処理が見つかりません');

function complete(row) {
  const result = { ...row, note: `保存済みのメモ ${row.code}`, request: `保存済みのご要望 ${row.code}` };
  delete result.detailsPending;
  return result;
}

let browser;
before(async () => {
  browser = await engines.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
});
after(async () => { await browser?.close(); });

async function fixture(testContext, rows) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    timezoneId: 'Asia/Tokyo', offline: true, serviceWorkers: 'block', acceptDownloads: true });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => route.abort());
  testContext.after(async () => {
    try {
      assert.deepEqual(requests, [], '外部通信を試みない');
      assert.deepEqual(errors, [], 'ブラウザ内で例外を出さない');
    } finally { await context.close(); }
  });
  page.setDefaultTimeout(TEST_TIMEOUT_MS);
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await page.addScriptTag({ content: `
    var adminData, dashboardGeneration = 1, reservationDetailsRead = null, reservationDetailsError = '';
    var scopedDetailsReads = new Map(), scopedDetailsErrors = new Map(), pendingNoteSaves = new Set();
    var activeChange = null, renderedCustomerFilters = {}, customersNeedRender = true, showPast = false, customerPage = 0;
    const CUSTOMER_PAGE_SIZE = 50;
    var reviewCalls = [], reviewCompletions = [], reviewAlerts = [];
    const NOTE_MAX = 1000;
    const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const yen = value => '¥' + Number(value).toLocaleString('ja-JP');
    const pad2 = value => String(value).padStart(2, '0');
    const isCancelled = row => row.status === 'キャンセル';
    const noteSummaryLabel = has => has ? '申し送りを直す' : '次回への申し送りを書く';
    function adminPost(payload) {
      if (payload.type !== 'adminData' || payload.reservationsOnly !== true) throw new Error('読込以外は禁止');
      reviewCalls.push(payload);
      return new Promise(resolve => reviewCompletions.push(resolve));
    }
    function renderReservations() {}
    function renderStats() {}
    function renderAdminCalendar() {}
    function renderNumbers() {}
    function showReservationFreshness() {}
    window.alert = message => reviewAlerts.push(message);
    ${helpers}
    ${functions}
    document.addEventListener('click', async event => {
      ${retry[0].replace(/\be\./g, 'event.')}
      ${source.slice(clickStart, clickEnd).replace(/\be\./g, 'event.')}
    });
  ` });
  await page.evaluate(rows => {
    adminData = { reservations: rows, closedDates: [] };
    renderCustomers();
  }, rows);
  return page;
}

const customer = (page, row) => page.locator(`.customer-record[data-customer-tel="${row.tel}"]`);

async function reply(page, index, rows) {
  await page.waitForFunction(index => typeof reviewCompletions[index] === 'function', index);
  await page.evaluate(({ index, rows }) => {
    reviewCompletions[index]({ ok: true, reservations: rows, closedDates: [] });
  }, { index, rows });
}

async function finishCustomer(page) {
  await page.waitForFunction(() => scopedDetailsReads.size === 0);
}

test('予定更新で未取得に戻った展開中のお客様から、実際に履歴を再取得できる', async testContext => {
  const page = await fixture(testContext, [FIRST, SECOND]);
  await customer(page, FIRST).locator('[data-customer-history]').click();
  await reply(page, 0, [complete(FIRST)]);
  await finishCustomer(page);
  await page.evaluate(() => {
    $('.admin-pane[data-pane="customers"]').hidden = true;
    window.reviewRefresh = refreshReservations();
  });
  await reply(page, 1, [FIRST, SECOND]);
  assert.equal(await page.evaluate(() => reviewRefresh), true);
  assert.equal(await page.evaluate(() => reviewCalls[1].briefPast), true);
  await page.evaluate(() => {
    $('.admin-pane[data-pane="customers"]').hidden = false;
    renderCustomers();
  });
  const profile = customer(page, FIRST).locator('.customer-profile');
  assert.equal(await customer(page, FIRST).evaluate(record => record.open), true);
  assert.equal(await page.evaluate(() => scopedDetailsReads.size), 0);
  assert.equal(await profile.locator('[data-retry-customer-history]').count(), 1,
    '通信していない展開行に、履歴を読み込むボタンを表示する');
  assert.match(await profile.innerText(), /まだ読み込んでいません/);
  assert.equal(await profile.locator('[data-note-input]').count(), 0);
  await profile.locator('[data-retry-customer-history]').click();
  await reply(page, 2, [complete(FIRST)]);
  await finishCustomer(page);
  assert.equal(await profile.locator('[data-note-input]').inputValue(), complete(FIRST).note);
  assert.deepEqual(await page.evaluate(() => reviewCalls[2].reservationCodes), [FIRST.code]);
  assert.equal(await page.evaluate(() => adminData.reservations[1].detailsPending), true);
});

test('お客様の詳細取得待ちに始めた全量CSVが、正常な二つの応答で完成する', async testContext => {
  const page = await fixture(testContext, [FIRST, SECOND]);
  const downloads = [];
  page.on('download', download => downloads.push(download));
  await customer(page, FIRST).locator('[data-customer-history]').click();
  await page.waitForFunction(() => reviewCalls.length === 1);
  await page.evaluate(() => { window.reviewCsv = exportCsv(); });
  await reply(page, 0, [complete(FIRST)]);
  await finishCustomer(page);
  await reply(page, 1, [complete(FIRST), complete(SECOND)]);
  await page.evaluate(() => reviewCsv);
  assert.deepEqual(await page.evaluate(() => reviewAlerts), [], '正常な詳細取得をCSVの競合と扱わない');
  assert.equal(await page.evaluate(() => reservationDetailsError), '');
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (!downloads.length) {
    assert.ok(Date.now() < deadline, '全量CSVが出力されません');
    await delay(POLL_INTERVAL_MS);
  }
  assert.equal(downloads.length, 1);
  const csv = await readFile(await downloads[0].path(), 'utf8');
  assert.equal(csv.split('\r\n').length, 3);
  for (const row of [FIRST, SECOND]) {
    assert.ok(csv.includes(complete(row).note));
    assert.ok(csv.includes(complete(row).request));
  }
  assert.deepEqual(await page.evaluate(() => reviewCalls), [
    { type: 'adminData', reservationsOnly: true, reservationCodes: [FIRST.code] },
    { type: 'adminData', reservationsOnly: true }
  ]);
  assert.equal(await page.evaluate(() => hasPendingReservationDetails()), false);
});

test('遅いAの詳細応答が、選び直したBのDOM・focus・保存済みメモを保持する', async testContext => {
  const page = await fixture(testContext, [FIRST, complete(SECOND)]);
  await customer(page, FIRST).locator('[data-customer-history]').click();
  await customer(page, SECOND).locator('[data-customer-history]').click();
  await customer(page, SECOND).evaluate(record => {
    window.reviewOtherRecord = record;
    window.reviewOtherProfile = record.querySelector('.customer-profile');
    window.reviewOtherSummary = record.querySelector('[data-customer-history]');
  });
  assert.equal(await page.evaluate(() => document.activeElement === reviewOtherSummary), true);
  await reply(page, 0, [complete(FIRST)]);
  await finishCustomer(page);
  assert.deepEqual(await customer(page, SECOND).evaluate(record => ({
    record: record === reviewOtherRecord,
    profile: record.querySelector('.customer-profile') === reviewOtherProfile,
    summary: record.querySelector('[data-customer-history]') === reviewOtherSummary,
    focused: document.activeElement === reviewOtherSummary,
    open: record.open
  })), { record: true, profile: true, summary: true, focused: true, open: true });
  assert.equal(await customer(page, SECOND).locator('[data-note-input]').inputValue(), complete(SECOND).note);
  assert.equal(await page.evaluate(() => adminData.reservations[0].note), complete(FIRST).note);
});
