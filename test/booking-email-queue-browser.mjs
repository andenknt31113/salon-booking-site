import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { join } from 'node:path';
import { createMockHandler } from './mock-gas.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const DAY_MS = 24 * 60 * 60 * 1000;
const visitDate = new Date(Date.now() + 7 * DAY_MS).toISOString().slice(0, 10);

for (const design of ['', '?design=a']) {
  test(`${design || '従来版'}で配送待ち・結果不明・受付済みを区別し、更新で状態を確認できる`, async () => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    server.on('request', createMockHandler({ port }));
    const base = `http://127.0.0.1:${port}`;
    const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify(payload) }).then(response => response.json());
    const browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
      process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let status = '配送待ち';
    let brokenMailStatus = false;
    try {
      await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
        ? route.continue() : route.abort());
      const booking = await post({ type: 'adminAdd', password, force: true, date: visitDate,
        time: '10:00', minutes: 60, price: 4000, name: '架空 配送確認', tel: '00000000031' });
      assert.equal(booking.ok, true);
      await page.route('**/exec', async route => {
        const request = JSON.parse(route.request().postData() || '{}');
        if (request.type !== 'adminData') return route.continue();
        const response = await route.fetch();
        const body = await response.json();
        body.reservations = (body.reservations || []).map(reservation => reservation.code === booking.code
          ? { ...reservation, shopMailStatus: '新規予約：' + status, customerMailStatus: '新規予約：' + status }
          : reservation);
        if (request.notificationsOnly === true) {
          body.mailStatuses = true;
          if (brokenMailStatus) body.reservations.find(row => row.code === booking.code).shopMailStatus = null;
        }
        await route.fulfill({ response, body: JSON.stringify(body) });
      });
      await page.goto(base + '/admin.html' + design);
      await page.locator('#passcode').fill(password);
      await page.locator('#gate-btn').click();
      await page.locator('#dashboard:not([hidden])').waitFor();
      await page.locator('#filter-date').fill(visitDate);
      await page.locator('#filter-date').dispatchEvent('change');
      const card = page.locator(`#admin-rows .booking-card[data-code="${booking.code}"]`);
      await card.waitFor();
      assert.match(await card.innerText(), /予約は保存済み.*メールは別の処理で配送/s);
      assert.equal(await page.locator('#mail-alert').isVisible(), false);
      if (process.env.TEST_SCREENSHOT_DIR) await card.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR,
        `queue-pending-${process.env.TEST_BROWSER || 'chromium'}-${design ? 'a' : 'original'}.png`) });
      await card.locator('[data-note-summary]').click();
      await card.locator('[data-note-input]').fill('配送確認中も残す下書き');
      brokenMailStatus = true;
      await page.evaluate(() => AdminNotifications.check());
      assert.match(await page.locator('#notification-status').textContent(), /自動確認を停止/);
      assert.equal(await page.locator('#notification-health').count(), 1);
      assert.equal(await page.locator('#notification-health').isVisible(), true);
      assert.match(await page.locator('#booking-notifications > summary').innerText(), /自動確認停止/);
      assert.match(await card.innerText(), /配送待ち/);
      assert.equal(await card.locator('[data-note-input]').inputValue(), '配送確認中も残す下書き');
      assert.equal(await page.locator('#mail-alert').isVisible(), false);
      brokenMailStatus = false;
      status = '送信結果不明';
      await page.evaluate(() => AdminNotifications.check());
      await page.locator('#mail-alert:not([hidden])').waitFor();
      assert.equal(await page.locator('#notification-health').isVisible(), false);
      assert.match(await card.innerText(), /送信結果不明/);
      assert.equal(await card.locator('[data-note-input]').inputValue(), '配送確認中も残す下書き');
      assert.match(await page.locator('#mail-alert').innerText(), /登録し直さず.*自動再送しません/s);
      if (process.env.TEST_SCREENSHOT_DIR) await card.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR,
        `queue-unknown-${process.env.TEST_BROWSER || 'chromium'}-${design ? 'a' : 'original'}.png`) });
      status = '送信処理受付';
      await page.evaluate(() => AdminNotifications.check());
      await page.locator('#mail-alert').waitFor({ state: 'hidden' });
      assert.match(await card.innerText(), /送信処理受付/);
      assert.match(await card.innerText(), /受信箱への到着は確認していません/);
      assert.equal(await card.locator('[data-note-input]').inputValue(), '配送確認中も残す下書き');
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
