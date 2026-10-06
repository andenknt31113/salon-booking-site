import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { openGoogleAdmin } from './google-admin-fixture.mjs';

const PASSWORD = process.env.MOCK_ADMIN_PASSWORD;
const ARTIFACT_DIR = process.env.ADMIN_TEST_ARTIFACT_DIR;
const FUTURE_DAYS = 14;
const DAY_MS = 86400000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TIMEOUT_MS = 7000;
assert.ok(PASSWORD, 'MOCK_ADMIN_PASSWORD が必要です');
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
after(() => browser.close());
if (ARTIFACT_DIR) mkdirSync(ARTIFACT_DIR, { recursive: true });

for (const design of ['', '?design=a']) {
  test(`Google管理本体の受け口が空でも親経由の操作・保存・再読込を保つ：${design || '従来版'}`, async () => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    let context;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      handler = createMockHandler({ port: server.address().port });
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password: PASSWORD }) })
        .then(response => response.json());
      context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
      const shell = await context.newPage();
      shell.setDefaultTimeout(TIMEOUT_MS);
      const errors = [];
      shell.on('pageerror', error => errors.push(error.message));
      shell.on('dialog', dialog => dialog.dismiss());
      let sourceReads = 0;
      await shell.route(/\/assets\/js\/data\.js(?:\?.*)?$/, async route => {
        const response = await route.fetch();
        const source = await response.text();
        assert.equal([...source.matchAll(/reservationEndpoint: '[^']*'/g)].length, 1);
        sourceReads++;
        await route.fulfill({ response, body: source.replace(/reservationEndpoint: '[^']*'/, "reservationEndpoint: ''") });
      });
      let failRead = false;
      const admin = await openGoogleAdmin({ shell, base, design, request: payload => {
        if (failRead && payload.type === 'adminData' && payload.reservationsOnly) throw new Error('架空の再読込障害');
        return post(payload);
      } });
      const frame = admin.frame;
      assert.equal(sourceReads, 1);
      assert.equal(await frame.evaluate(() => SALON.reservationEndpoint === ''), true);
      await frame.locator('#admin-tabs [data-pane="customers"]').click();
      assert.equal(await frame.locator('.admin-pane[data-pane="customers"]').isVisible(), true);
      await frame.locator('#customer-search').fill('架空のお客様');
      await frame.locator('#admin-tabs [data-pane="reserve"]').click();
      await frame.locator('#add-booking').click();
      assert.equal(await frame.locator('#add-booking-form').isVisible(), true);
      const date = new Date(Date.now() + JST_OFFSET_MS + FUTURE_DAYS * DAY_MS).toISOString().slice(0, 10);
      await frame.locator('#ab-date').fill(date);
      await frame.locator('#ab-time').selectOption('10:00');
      await frame.locator('#ab-name').fill('架空の受け口確認');
      await frame.locator('#ab-tel').fill('00000000000');
      await frame.locator('#ab-minutes').fill('60');
      await frame.locator('#ab-price').fill('4000');
      await frame.locator('#ab-save').click();
      await frame.locator('#add-result:not([hidden])').waitFor();
      const ledger = await post({ type: 'adminData' });
      const saved = ledger.reservations.find(row => row.name === '架空の受け口確認');
      assert.ok(saved);
      assert.equal(saved.date, date);
      assert.equal(saved.time, '10:00');
      assert.match(await frame.locator('#add-result').innerText(), new RegExp(saved.code));
      assert.equal(admin.operations.filter(operation => operation.type === 'adminAdd').length, 1);
      failRead = true;
      await frame.locator('#refresh-reservations').click();
      await frame.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.match(await frame.locator('#reservation-freshness').innerText(), /取得できません/);
      failRead = false;
      await frame.locator('#refresh-reservations').click();
      await frame.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.doesNotMatch(await frame.locator('#reservation-freshness').innerText(), /取得できません/);
      await frame.locator('#filter-date').fill(date);
      await frame.locator(`#admin-rows [data-code="${saved.code}"]`).waitFor();
      assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.deepEqual(errors, []);
      admin.assertIsolated();
      if (ARTIFACT_DIR) await shell.screenshot({ path: resolve(ARTIFACT_DIR, `endpoint-${design ? 'a' : 'current'}.png`), fullPage: true });
    } finally {
      await context?.close();
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    }
  });
}
