import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

async function waitUntil(check) {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (!check()) {
    assert.ok(Date.now() < deadline, '架空の履歴取得が始まりませんでした');
    await delay(POLL_INTERVAL_MS);
  }
}

function historicalRows(today) {
  const date = new Date(today + 'T12:00:00+09:00');
  return Array.from({ length: HISTORY_COUNT }, (_, index) => {
    const visit = new Date(date);
    visit.setDate(visit.getDate() - index - 1);
    const customer = index % CUSTOMER_COUNT;
    return { code: `LM-H${String(index).padStart(7, '0')}`,
      date: visit.getFullYear() + '-' + String(visit.getMonth() + 1).padStart(2, '0') + '-' + String(visit.getDate()).padStart(2, '0'),
      time: '10:00', endTime: '11:00', menu: '架空カット', staffName: 'MATTEO', price: 6900,
      name: `架空顧客${customer}`, tel: `090${String(customer).padStart(8, '0')}`,
      email: 'fixture@example.test', visit: '2回目以降', source: '直接',
      shopMailStatus: '', customerMailStatus: '', status: index % 5 ? '確定' : 'キャンセル',
      note: `保存済みの施術メモ${index}`, request: `過去のご要望${index}` };
  });
}

for (const design of ['', '?design=a']) {
  test(`5000件を数え落とさず、履歴の失敗・再取得・CSV・詳細移動を保護する ${design || '従来版'}`, async () => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    handler = createMockHandler({ port: server.address().port });
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser;
    let finishDetails;
    const reads = [];
    const writes = [];
    const errors = [];
    let detailAttempt = 0;
    let rows;
    try {
      browser = await engines.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== base) return route.abort();
        if (url.pathname !== '/exec' || request.method() !== 'POST') return route.continue();
        const payload = request.postDataJSON();
        if (payload.type !== 'adminData') {
          if (!['adminLogin', 'adminAddStatus'].includes(payload.type)) writes.push(payload.type);
          return route.continue();
        }
        reads.push({ startupOnly: payload.startupOnly, briefPast: payload.briefPast,
          reservationsOnly: payload.reservationsOnly });
        const response = await route.fetch();
        const body = await response.json();
        if (payload.startupOnly) {
          const today = await page.evaluate(() => toKey(new Date()));
          rows = historicalRows(today);
          rows.push({ ...rows[1], code: 'LM-FUTURE', date: today, name: '本日の架空顧客',
            note: '今日のメモは初回に必要', request: '今日のご要望' });
          body.reservations = rows.map(row => payload.briefPast && row.date < today
            ? Object.fromEntries(Object.entries({ ...row, detailsPending: true })
              .filter(([key]) => !['note', 'request'].includes(key))) : { ...row });
          delete body.styles;
          delete body.reviews;
          body.pendingEditors = ['styles', 'reviews'];
          return route.fulfill({ response, json: body });
        }
        if (payload.reservationsOnly) {
          detailAttempt++;
          await new Promise(resolve => { finishDetails = resolve; });
          return route.fulfill({ response, json: detailAttempt <= 2
            ? { ok: false, error: '架空の履歴取得障害' }
            : { ok: true, reservations: rows.map(row => ({ ...row })), closedDates: [] } });
        }
        return route.fulfill({ response, json: body });
      });
      await page.goto(base + '/admin.html' + design);
      await page.locator('#passcode').fill(password);
      await page.locator('#remember-me').uncheck();
      await page.locator('#gate-btn').click();
      await page.locator('#dashboard:not([hidden])').waitFor();
      assert.equal(reads.length, 1);
      assert.equal(reads[0].briefPast, true, '初回は過去の長いメモを要求しない');
      assert.equal(await page.evaluate(() => adminData.reservations.length), HISTORY_COUNT + 1);
      assert.match(await page.locator('#stats').innerText(), /キャンセル\s*1000件/);
      assert.equal(await page.locator('[data-note-box="LM-FUTURE"] [data-note-input]').inputValue(), '今日のメモは初回に必要');
      assert.equal(await page.locator('#admin-rows [data-code]').count(), 1);
      let failedCsvMessage = '';
      let downloads = 0;
      page.on('download', () => { downloads++; });
      page.once('dialog', dialog => { failedCsvMessage = dialog.message(); dialog.dismiss(); });
      await page.locator('#export-csv').click();
      await waitUntil(() => detailAttempt === 1);
      finishDetails();
      await waitUntil(() => !!failedCsvMessage);
      assert.match(failedCsvMessage, /履歴.*確認できません.*もう一度/);
      assert.equal(downloads, 0, '詳細取得に失敗したCSVを空欄で出力しない');
      assert.equal(await page.locator('#admin-rows [data-code]').count(), 1);
      await page.locator('#admin-tabs [data-pane="numbers"]').click();
      assert.equal(reads.length, 2, '数字に必要な全件の情報は最初からあり、重いメモは追加取得しない');
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      await page.locator('#customer-rows [data-retry-history]').click();
      await page.waitForFunction(() => document.querySelector('#customer-rows').textContent.includes('読み込んでいます'));
      await page.waitForFunction(() => !!window.document.querySelector('#customer-rows [data-retry-history]') === false);
      await waitUntil(() => detailAttempt === 2);
      assert.equal(detailAttempt, 2);
      assert.equal(await page.locator('#customer-rows [data-note-input]').count(), 0, '未取得のメモを空欄の編集欄にしない');
      await page.locator('#admin-tabs [data-pane="reserve"]').click();
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      assert.equal(detailAttempt, 2, 'タブ往復しても同じ取得を増やさない');
      finishDetails();
      await page.locator('#customer-rows [data-retry-history]').waitFor();
      assert.match(await page.locator('#customer-rows').innerText(), /確認できません/);
      assert.equal(await page.locator('#customer-rows [data-note-input]').count(), 0);
      assert.equal(await page.evaluate(() => adminData.reservations.length), HISTORY_COUNT + 1);
      await page.locator('#customer-rows [data-retry-history]').click();
      await waitUntil(() => detailAttempt === 3);
      assert.equal(detailAttempt, 3);
      finishDetails();
      await page.locator('#customer-rows .customer-record').first().waitFor({ timeout: TEST_TIMEOUT_MS });
      assert.match(await page.locator('#customer-count').innerText(), /名簿 250件/);
      const customer = page.locator('.customer-record[data-customer-tel="09000000001"]');
      await customer.locator('[data-customer-history]').click();
      assert.match(await customer.locator('.customer-profile').innerText(), /保存済みの施術メモ1/);
      assert.match(await customer.locator('.customer-profile').innerText(), /過去のご要望1/);
      assert.match(await customer.locator('.customer-profile').innerText(), /すべての予約を見る（21件/);
      await page.locator('#admin-tabs [data-pane="reserve"]').click();
      const downloadEvent = page.waitForEvent('download');
      await page.locator('#export-csv').click();
      const download = await downloadEvent;
      const csv = await readFile(await download.path(), 'utf8');
      assert.ok(csv.includes('保存済みの施術メモ4999'));
      assert.equal(csv.split('\r\n').length, HISTORY_COUNT + 2);
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      await customer.locator('[data-history-booking="LM-H0000001"]').click();
      assert.equal(await page.locator('#filter-date').inputValue(), rows[1].date);
      assert.equal(await page.locator('#admin-rows [data-code]').count(), 1, '履歴からの移動はその日だけ表示し、5000件のカードを作らない');
      assert.equal(await page.locator('#admin-rows [data-note-box="LM-H0000001"] [data-note-input]').inputValue(), '保存済みの施術メモ1');
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      if (process.env.TEST_SCREENSHOT_DIR) {
        await mkdir(process.env.TEST_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR, `brief-history-${design ? 'a' : 'original'}.png`), fullPage: true });
      }
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
    } finally {
      finishDetails?.();
      if (browser) await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
