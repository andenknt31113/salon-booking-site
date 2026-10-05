import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
after(() => browser.close());
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));

for (const design of ['', '&design=a']) {
  for (const scenario of ['unknown-unwritten', 'unknown-saved', 'old-receipt', 'wrong-duration',
    'contradictory', 'exception-saved', 'cancelled-read', 'normal']) {
    test(`Google管理bridge ${design || '従来版'} ${scenario}：入力を保ち手動照会だけで完了する`, async () => {
      const server = http.createServer();
      let context;
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        server.on('request', createMockHandler({ port: server.address().port }));
        const base = `http://127.0.0.1:${server.address().port}`;
        const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password }) })
          .then(response => response.json());
        const booking = await post({ type: 'adminAdd', force: true, date: day(), time: '10:00',
          minutes: 60, price: 6900, name: '架空の変更確認客', tel: '00000000000', menu: '試験カット' });
        assert.equal(booking.ok, true);
        const before = (await post({ type: 'adminData' })).reservations.find(row => row.code === booking.code);
        const operations = [];
        const errors = [];
        context = await browser.newContext({ viewport: { width: design ? 390 : 320, height: 568 }, timezoneId: 'Asia/Tokyo' });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => dialog.dismiss());
        await page.exposeFunction('fixtureAdminRequest', async payload => {
          operations.push(structuredClone(payload));
          if (payload.type === 'adminChange') {
            const actual = scenario === 'unknown-unwritten' ? null : await post(payload);
            if (actual) assert.equal(actual.ok, true);
            if (scenario === 'exception-saved') throw new Error('架空の応答切断');
            if (scenario.startsWith('unknown') || scenario === 'cancelled-read') {
              return { ok: false, unknown: true, error: '日時変更後の予約内容を確認できません' };
            }
            if (scenario === 'old-receipt') return { ok: true, reservation: before };
            if (scenario === 'wrong-duration') return { ...actual, reservation: { ...actual.reservation, endTime: '16:00' } };
            if (scenario === 'contradictory') return { ...actual, unknown: true };
            return actual;
          }
          const actual = await post(payload);
          if (scenario === 'cancelled-read' && payload.reservationsOnly) {
            return { ...actual, reservations: actual.reservations.map(row => row.code === booking.code
              ? { ...row, status: 'キャンセル' } : row) };
          }
          return actual;
        });
        await context.route('**/*', async route => {
          const request = route.request();
          if (new URL(request.url()).origin !== base) return route.abort();
          if (request.url() === base + '/fixture-shell.html') {
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width">'
              + '<script>window.authAdminRequest = payload => window.fixtureAdminRequest(payload);</script>'
              + `<iframe id="management" title="架空のGoogle管理" style="width:100%;height:95vh;border:0" src="admin.html?google=1${design}"></iframe>` });
          }
          if (process.env.ADMIN_SOURCE && new URL(request.url()).pathname === '/assets/js/admin.js') {
            return route.fulfill({ contentType: 'text/javascript', body: readFileSync(process.env.ADMIN_SOURCE, 'utf8') });
          }
          return route.continue();
        });
        await page.goto(base + '/fixture-shell.html');
        const frame = page.frameLocator('#management');
        await frame.locator('#dashboard:not([hidden])').waitFor();
        assert.equal(await frame.locator('#gate').isVisible(), false, '旧ログインを操作しない');
        const calendar = frame.locator('#filter-date');
        await calendar.fill(day());
        await calendar.dispatchEvent('change');
        const card = frame.locator(`[data-code="${booking.code}"]`);
        const snapshot = await frame.locator('body').evaluate(() => JSON.stringify(adminData));
        await card.locator('[data-admin-change]').click();
        await card.locator('[data-change-time]').selectOption('14:00');
        await card.locator('[data-change-save]').click();
        const dialog = frame.getByRole('dialog');
        assert.match(await dialog.innerText(), /10:00[\s\S]*14:00/);
        await dialog.getByRole('button', { name: 'この日時へ変更する', exact: true }).click();
        if (scenario === 'normal') {
          await card.locator('[data-change-editor]').waitFor({ state: 'detached' });
          assert.match(await frame.locator('#reservation-freshness').innerText(), /日時を保存/);
        } else {
          await card.locator('[data-change-check]:not([hidden])').waitFor({ timeout: 4000 });
          assert.equal(await card.locator('[data-change-save]').isDisabled(), true);
          assert.equal(await card.locator('[data-change-check]').isEnabled(), true);
          assert.match(await card.locator('[data-change-status]').innerText(), /もう一度保存せず/);
          assert.equal(await card.locator('[data-change-time]').inputValue(), '14:00');
          assert.equal(await frame.locator('body').evaluate(() => JSON.stringify(adminData)), snapshot);
          assert.equal(operations.filter(operation => operation.type === 'adminChange').length, 1);
          await card.locator('[data-change-check]').click();
          if (['unknown-unwritten', 'cancelled-read'].includes(scenario)) {
            await card.locator('[data-change-check]:enabled').waitFor();
            assert.equal(await frame.locator('body').evaluate(() => JSON.stringify(adminData)), snapshot);
            assert.equal(await card.locator('[data-change-save]').isDisabled(), true);
            assert.match(await card.locator('[data-change-status]').innerText(), /変更前の日時|予約内容を確認できません/);
          } else {
            await card.locator('[data-change-editor]').waitFor({ state: 'detached' });
            assert.match(await frame.locator('#reservation-freshness').innerText(), /台帳で変更後の日時を確認/);
          }
        }
        const current = (await post({ type: 'adminData' })).reservations.find(row => row.code === booking.code);
        assert.equal(current.time, scenario === 'unknown-unwritten' ? '10:00' : '14:00');
        assert.equal(current.endTime, scenario === 'unknown-unwritten' ? '11:00' : '15:00');
        assert.equal(current.status, '予約確定');
        assert.equal(operations.filter(operation => operation.type === 'adminChange').length, 1);
        assert.ok(operations.every(operation => ['adminData', 'adminChange'].includes(operation.type)));
        assert.equal(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
      } finally {
        if (context) await context.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
}
