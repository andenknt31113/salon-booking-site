import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { openGoogleAdmin } from './google-admin-fixture.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const futureDate = () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

for (const design of ['', '?design=a']) {
  test(`${design || '従来版'}で確認済みの日時を送り、競合時は最新予定を表示して取消し直さない`, async () => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    handler = createMockHandler({ port });
    const base = `http://127.0.0.1:${port}`;
    const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password }) })
      .then(response => response.json());
    const browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
      process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    const context = await browser.newContext({ viewport: { width: 390, height: 844 },
      timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
    const operations = [];
    const notices = [];
    const errors = [];
    try {
      const date = futureDate();
      const booking = await post({ type: 'adminAdd', password, force: true, date, time: '10:00',
        minutes: 60, name: '取消競合の試験客', tel: '00000000000' });
      assert.equal(booking.ok, true);
      const shell = await context.newPage();
      shell.on('pageerror', error => errors.push(error.message));
      shell.on('dialog', async dialog => { notices.push(dialog.message()); await dialog.accept(); });
      const admin = await openGoogleAdmin({ shell, base, design, request: async payload => {
        if (payload.type === 'cancel') {
          operations.push(structuredClone(payload));
          return { ok: false, stale: true,
            error: '別の画面で予約日時が変わりました。最新の予定を確認してください。' };
        }
        return post(payload);
      } });
      const page = admin.frame;
      await page.locator('#filter-date').fill(date);
      await page.locator('#filter-date').dispatchEvent('change');
      const card = page.locator(`[data-code="${booking.code}"]`);
      await card.locator('[data-admin-cancel]').click();
      const dialog = page.getByRole('dialog');
      assert.match(await dialog.innerText(), /10:00/);
      const changed = await post({ type: 'adminChange', password, code: booking.code,
        fromDate: futureDate(), fromTime: '10:00', date: futureDate(), time: '14:00' });
      assert.equal(changed.ok, true);
      await dialog.getByRole('button', { name: 'この予約をキャンセルする', exact: true }).click();
      await page.waitForFunction(code => adminData.reservations.find(record => record.code === code)?.time === '14:00',
        booking.code, { timeout: 5000 });
      assert.match(await page.locator('#reservation-freshness').innerText(), /最終読込/);
      assert.equal(operations.length, 1, '自動で取消し直さない');
      assert.equal(operations[0].fromDate, futureDate());
      assert.equal(operations[0].fromTime, '10:00');
      assert.match(await card.innerText(), /14:00/);
      assert.equal(await card.locator('.status-chip.is-cancelled').count(), 0);
      assert.equal(await card.locator('[data-admin-cancel]').isEnabled(), true);
      assert.ok(notices.some(message => /キャンセル.*完了していません|キャンセルしていません/.test(message)));
      assert.deepEqual(errors, []);
      const current = (await post({ type: 'adminData', password })).reservations.find(row => row.code === booking.code);
      assert.equal(current.time, '14:00');
      assert.equal(current.status, '予約確定');
      admin.assertIsolated();
    } finally {
      await context.close();
      await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
