import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { openGoogleAdmin } from './google-admin-fixture.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const NOW = '2030-01-15T03:00:00.000Z';
const TODAY = '2030-01-15';
const HISTORY_COUNT = 3500;
const UPCOMING_COUNT = 1498;
const TOTAL_COUNT = HISTORY_COUNT + UPCOMING_COUNT + 2;

function shiftDate(days) {
  const date = new Date(TODAY + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function reservation(code, date, status = '予約確定') {
  return { code, date, time: '10:00', endTime: '11:00', menu: '架空の施術', staffName: '架空担当',
    price: 6900, name: '架空の日付確認', tel: '00000000000', email: '', visit: '2回目以降',
    source: '直接', status, shopMailStatus: '', customerMailStatus: '', note: '保持するメモ：' + code,
    request: '保持するご要望：' + code };
}

for (const design of ['', '?design=a']) {
  test(`初回は今日の2件だけ描画し、5000件の履歴・未来・取消を残して手動移動できる：${design || '従来版'}`, async testContext => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    let browser;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      handler = createMockHandler({ port: server.address().port });
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password }) })
        .then(response => response.json());
      const records = [reservation('LM-TODAY', TODAY), reservation('LM-CANCEL', TODAY, 'キャンセル'),
        ...Array.from({ length: HISTORY_COUNT }, (_, index) => reservation('LM-PAST-' + index, shiftDate(-index - 1))),
        ...Array.from({ length: UPCOMING_COUNT }, (_, index) => reservation('LM-NEXT-' + index, shiftDate(index + 1)))];
      browser = await engines.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
      const shell = await browser.newPage({ viewport: { width: 390, height: 844 },
        timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
      const errors = [];
      shell.on('pageerror', error => errors.push(error.message));
      shell.on('dialog', dialog => dialog.dismiss());
      await shell.clock.install({ time: new Date(NOW) });
      const admin = await openGoogleAdmin({ shell, base, design, request: async payload => {
        assert.equal(payload.type, 'adminData', 'この画面確認では予約・台帳を書き換えない');
        const result = await post(payload);
        result.reservations = structuredClone(records);
        result.closedDates = [];
        return result;
      } });
      const page = admin.frame;
      const initial = await page.locator('#admin-rows .booking-card[data-code]').count();
      testContext.diagnostic(`初回に描画した架空の予約カード：${initial}件／索引${TOTAL_COUNT}件`);
      assert.equal(await page.locator('#filter-date').inputValue(), TODAY);
      assert.equal(await page.locator('#export-csv').innerText(), '表示条件でCSV');
      assert.equal(initial, 2);
      assert.equal(await page.evaluate(() => adminData.reservations.length), TOTAL_COUNT);
      assert.equal(await page.locator('[data-code="LM-TODAY"]').count(), 1);
      assert.equal(await page.locator('[data-code="LM-CANCEL"]').count(), 1, '今日の取消を隠さない');
      assert.match(await page.locator('#stats').innerText(), /本日のご予約\s*1件/);
      await page.locator('#filter-next').click();
      assert.equal(await page.locator('#filter-date').inputValue(), shiftDate(1));
      assert.equal(await page.locator('#admin-rows .booking-card[data-code]').count(), 1);
      assert.equal(await page.locator('[data-code="LM-NEXT-0"]').count(), 1);
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.equal(await page.locator('#filter-date').inputValue(), shiftDate(1), '手動更新で選んだ日を今日へ戻さない');
      await page.locator('#filter-reset').click();
      assert.equal(await page.locator('#filter-date').inputValue(), '');
      assert.equal(await page.locator('#admin-rows .booking-card[data-code]').count(), UPCOMING_COUNT + 2);
      assert.match(await page.locator('[data-toggle-past]').innerText(), new RegExp(`過ぎたご予約（${HISTORY_COUNT}件）も見る`));
      await page.locator('#filter-date').fill(shiftDate(-1));
      await page.locator('#filter-date').dispatchEvent('change');
      assert.equal(await page.locator('[data-code="LM-PAST-0"]').count(), 1);
      assert.equal(await page.locator('[data-note-box="LM-PAST-0"] [data-note-input]').inputValue(), '保持するメモ：LM-PAST-0');
      assert.equal(await page.evaluate(() => JSON.stringify(adminData.reservations)), JSON.stringify(records),
        '描画範囲を変えても索引・本文・料金・取消の全件を切り捨てない');
      for (const width of [320, 390, 768, 1280]) {
        await shell.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      assert.deepEqual(errors, []);
      admin.assertIsolated();
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
