import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const TEST_DATE = '2030-01-01';
const TEST_TIMEOUT_MS = 7000;
const seed = { ok: true, reservations: [{ code: 'LM-OCCUPANCY', date: TEST_DATE, time: '10:00', endTime: '12:00',
  name: '架空の集計確認', tel: '00000000041', price: 4000, status: '予約確定', source: 'LINE', visit: '2回目以降',
  menu: '架空カット', staffName: '架空担当', email: '', request: '', note: '' }],
  closedDates: [{ '休業日': TEST_DATE, '開始': '12:00', '終了': '15:00', 'メモ': '架空の時間休み' },
    { '休業日': TEST_DATE, '開始': '14:00', '終了': '16:00', 'メモ': '架空の時間休み' }],
  menus: [], coupons: [], styles: [], reviews: [], settings: { '営業開始': '10:00', '営業終了': '20:00',
    '最終受付': '19:00', '定休曜日': '' },
  stamps: { closed: 'fixture-closed', settings: 'fixture-settings', menus: '0', coupons: '0', styles: '0', reviews: '0' } };

for (const design of ['', '?design=a']) {
  test(`重なる時間休みの稼働率を管理画面で確認し、更新・月移動でも正しく表示する：${design || '従来版'}`, async () => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    let browser;
    const errors = [];
    const unexpected = [];
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      handler = createMockHandler({ port: server.address().port });
      const base = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo',
        serviceWorkers: 'block' });
      page.setDefaultTimeout(TEST_TIMEOUT_MS);
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== base || url.pathname === '/exec') {
          unexpected.push(url.pathname);
          return route.abort();
        }
        return route.continue();
      });
      await page.clock.install({ time: new Date(TEST_DATE + 'T03:00:00Z') });
      await page.goto(base + '/admin.html' + design);
      assert.equal(await page.evaluate(async data => {
        window.fixtureRequests = [];
        window.fixtureClosed = structuredClone(data.closedDates);
        adminPost = async payload => {
          window.fixtureRequests.push(payload);
          if (payload.type !== 'adminData') throw new Error('架空台帳でも書込はしない');
          return { ...structuredClone(data), closedDates: structuredClone(window.fixtureClosed) };
        };
        return openDashboard();
      }, seed), true);
      await page.locator('#admin-tabs [data-pane="numbers"]').click();
      const card = page.locator('#numbers-body .num-card').filter({ hasText: '2030年1月の稼働率' });
      assert.equal(await card.locator('.num-value').innerText(), '33%');
      assert.match(await card.locator('.num-sub').innerText(), /受けられた 6時間 のうち 2時間 が予約/);
      await page.locator('#admin-tabs [data-pane="closed"]').click();
      assert.equal(await page.locator('#closed-rows [data-col="休業日"]').count(), 2);
      await page.locator('#admin-tabs [data-pane="reserve"]').click();
      await page.evaluate(() => { window.fixtureClosed = [window.fixtureClosed[0], { ...window.fixtureClosed[0] }]; });
      await page.locator('#refresh-reservations').click();
      await page.locator('#refresh-reservations:not([disabled])').waitFor();
      await page.locator('#admin-tabs [data-pane="numbers"]').click();
      assert.equal(await card.locator('.num-value').innerText(), '29%');
      assert.match(await card.locator('.num-sub').innerText(), /受けられた 7時間 のうち 2時間 が予約/);
      await page.locator('#numbers-month [data-month="-1"]').click();
      assert.match(await page.locator('#numbers-body').innerText(), /2029年12月の稼働率/);
      await page.locator('#numbers-month [data-month="0"]').click();
      assert.equal(await card.locator('.num-value').innerText(), '29%');
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      if (process.env.TEST_SCREENSHOT_DIR) {
        await mkdir(process.env.TEST_SCREENSHOT_DIR, { recursive: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR, `occupancy-${design ? 'a' : 'original'}.png`), fullPage: true });
      }
      assert.deepEqual(await page.evaluate(() => window.fixtureRequests), [
        { type: 'adminData', startupOnly: true, briefPast: true, deferMenus: true },
        { type: 'adminData', reservationsOnly: true }
      ]);
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
