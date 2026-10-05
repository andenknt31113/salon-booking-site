import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { openGoogleAdmin } from './google-admin-fixture.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const HISTORICAL_COUNT = 5000;
const SYNTHETIC_TIME = '2030-01-15T03:00:00Z';

for (const design of ['', '?design=a']) {
  test(`数字は開いた時だけ集計し、最新予約・月・入力した率を反映する ${design || '従来版'}`, async () => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    handler = createMockHandler({ port });
    const base = `http://127.0.0.1:${port}`;
    const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password }) })
      .then(response => response.json());
    const errors = [];
    const writes = [];
    let browser;
    try {
      browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
        process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
      const shell = await browser.newPage({ viewport: { width: 390, height: 844 },
        timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
      shell.on('pageerror', error => errors.push(error.message));
      const booking = { date: '2030-01-14', time: '10:00', endTime: '11:00', name: '架空 集計確認',
        tel: '00000000041', price: 4000, status: '予約確定', source: 'LINE', visit: '2回目以降',
        menu: '試験カット', code: 'LM-NUMBERS-FIRST', request: '', note: '' };
      const rows = [booking, { ...booking, code: 'LM-NUMBERS-PHONE', time: '11:00', price: 6000, source: '電話・来店' },
        { ...booking, code: 'LM-NUMBERS-CANCEL', price: 10000, status: 'キャンセル' },
        { ...booking, code: 'LM-NUMBERS-PREV', date: '2029-12-14', price: 3000 },
        { ...booking, code: 'LM-NUMBERS-FUTURE', date: '2030-01-20', price: 5000 },
        ...Array.from({ length: HISTORICAL_COUNT }, (_, index) => ({ ...booking, code: `LM-HISTORY-${index}`, date: '2025-01-01' }))];
      await shell.clock.install({ time: new Date(SYNTHETIC_TIME) });
      await shell.context().addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          if (typeof monthBookings !== 'function') return;
          const read = monthBookings;
          const aggregate = occupancy;
          window.monthReads = 0;
          window.occupancyReads = 0;
          monthBookings = key => { window.monthReads++; return read(key); };
          occupancy = (...args) => { window.occupancyReads++; return aggregate(...args); };
        });
      });
      const admin = await openGoogleAdmin({ shell, base, design, request: async payload => {
        if (payload.type !== 'adminData') { writes.push(payload.type); return post(payload); }
        const body = await post(payload);
        body.reservations = structuredClone(rows);
        body.closedDates = [];
        if (!payload.reservationsOnly) Object.assign(body.settings, {
          'ホットペッパー手数料率（％）': '2', 'ホットペッパー掲載料（月額・円）': '70000'
        });
        return body;
      } });
      const page = admin.frame;
      assert.deepEqual(writes, [], '旧ログインも書込操作も行わない');
      assert.equal(await page.locator('#numbers-body .num-card').count(), 0);
      assert.equal(await page.evaluate(() => window.monthReads), 0);
      await page.locator('#admin-tabs [data-pane="numbers"]').click();
      assert.equal(await page.evaluate(() => window.monthReads), 2);
      assert.equal(await page.evaluate(() => window.occupancyReads), 1);
      assert.equal(await page.locator('#numbers-body .num-card').count(), 7);
      assert.match(await page.locator('#numbers-body .num-value').first().innerText(), /2件/);
      assert.match(await page.locator('#numbers-savings .num-value').innerText(), /180/);
      await page.locator('#admin-tabs [data-pane="reserve"]').click();
      rows.push({ ...booking, code: 'LM-NUMBERS-UPDATE', time: '12:00', price: 7000 });
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.equal(await page.evaluate(() => window.monthReads), 2, '予定更新時に非表示の数字を集計しない');
      await page.locator('#admin-tabs [data-pane="numbers"]').click();
      assert.equal(await page.evaluate(() => window.monthReads), 4);
      assert.match(await page.locator('#numbers-body .num-value').first().innerText(), /3件/);
      assert.match(await page.locator('#numbers-savings .num-value').innerText(), /320/);
      await page.locator('#numbers-month [data-month="-1"]').click();
      assert.equal(await page.locator('#numbers-month [data-month="-1"]').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#numbers-month [data-month="0"]').getAttribute('aria-selected'), 'false');
      assert.match(await page.locator('#numbers-body .num-value').first().innerText(), /1件/);
      assert.match(await page.locator('#numbers-savings .num-value').innerText(), /60/);
      await page.locator('#site-edit-tabs summary').click();
      await page.locator('#admin-tabs [data-pane="settings"]').click();
      const rate = page.locator('[data-setting="ホットペッパー手数料率（％）"]');
      await rate.evaluate(element => { element.closest('details').open = true; });
      await rate.fill('3.5');
      await page.locator('#admin-tabs [data-pane="numbers"]').click();
      assert.match(await page.locator('#numbers-savings .num-value').innerText(), /105/);
      await page.locator('#numbers-month [data-month="0"]').click();
      assert.equal(await page.locator('#numbers-month [data-month="0"]').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#numbers-month [data-month="-1"]').getAttribute('aria-selected'), 'false');
      assert.match(await page.locator('#numbers-savings .num-value').innerText(), /560/);
      for (const width of [320, 390, 768, 1280]) {
        await shell.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      if (process.env.TEST_SCREENSHOT_DIR) await shell.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR,
        `numbers-${design ? 'a' : 'original'}.png`), fullPage: true });
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      admin.assertIsolated();
    } finally {
      if (browser) await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
