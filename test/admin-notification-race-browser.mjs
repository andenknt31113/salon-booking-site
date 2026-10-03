import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const TEST_TIMEOUT_MS = 10000;
const BOOKING = { code: 'LM-NOTICE-RACE', date: '2099-01-05', time: '10:00', endTime: '11:00',
  menu: '架空のカット', staffName: '架空の担当', price: 4000, name: '通知競合の試験客',
  tel: '00000000000', email: '', visit: '初めて', source: '試験', request: '', note: '', status: '予約確定',
  shopMailStatus: '新規予約：配送待ち', customerMailStatus: '新規予約：配送待ち' };
const COMPLETED = { ...BOOKING, shopMailStatus: '新規予約：送信処理受付', customerMailStatus: '新規予約：送信処理受付' };
const seed = { ok: true, reservations: [BOOKING], closedDates: [], menus: [], coupons: [], styles: [], reviews: [],
  settings: {}, stamps: { closed: '0', menus: '0', coupons: '0', styles: '0', reviews: '0', settings: '0' } };

for (const design of ['', '?design=a']) {
  for (const situation of ['配送の巻戻し', '取消通知の巻戻し', '古い通信失敗']) {
    test(`${design || '従来版'}：${situation}を防ぎ、入力・未読・再確認を保持する`, async () => {
      let handler;
      const server = http.createServer((request, response) => handler(request, response));
      let browser;
      let context;
      const errors = [];
      const unexpected = [];
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        handler = createMockHandler({ port: server.address().port });
        const base = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
        context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== base || url.pathname === '/exec') {
            unexpected.push(url.pathname);
            return route.abort();
          }
          return route.continue();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(TEST_TIMEOUT_MS);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(base + '/admin.html' + design);
        assert.equal(await page.evaluate(async data => {
          window.fixtureRows = structuredClone(data.reservations);
          window.fixtureRequests = [];
          window.fixtureHoldNotifications = false;
          adminPost = payload => {
            window.fixtureRequests.push(structuredClone(payload));
            if (payload.type !== 'adminData') throw new Error('架空台帳でも書込はしない');
            if (payload.notificationsOnly) {
              if (window.fixtureHoldNotifications) return new Promise((resolve, reject) => {
                window.fixtureReleaseNotifications = result => result === null ? reject(new Error('架空の通信失敗')) : resolve(result);
              });
              return Promise.resolve({ ok: true, reservations: structuredClone(window.fixtureRows), mailStatuses: true });
            }
            if (payload.reservationsOnly) return Promise.resolve({ ok: true, reservations: structuredClone(window.fixtureRows), closedDates: [] });
            return Promise.resolve(structuredClone(data));
          };
          return openDashboard();
        }, seed), true);
        await page.locator('#filter-date').fill(BOOKING.date);
        await page.locator('#booking-notifications > summary').click();
        await page.locator('#notification-check').click();
        await page.waitForFunction(() => !document.querySelector('#notification-check').disabled);
        if (situation === '取消通知の巻戻し') {
          await page.evaluate(row => { window.fixtureRows = [{ ...row, status: 'キャンセル' }]; }, COMPLETED);
          await page.locator('#notification-check').click();
          await page.waitForFunction(() => document.querySelector('#notification-list').textContent.includes('未読：キャンセル'));
        }
        await page.evaluate(() => { window.fixtureHoldNotifications = true; });
        await page.locator('#notification-check').click();
        await page.waitForFunction(() => document.querySelector('#notification-check').disabled && typeof window.fixtureReleaseNotifications === 'function');
        await page.evaluate(({ row, cancelled }) => { window.fixtureRows = [{ ...row, status: cancelled ? 'キャンセル' : row.status }]; },
          { row: COMPLETED, cancelled: situation === '取消通知の巻戻し' });
        await page.locator('#refresh-reservations').click();
        await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
        const card = page.locator(`#admin-rows [data-code="${BOOKING.code}"]`);
        assert.match(await card.innerText(), /店舗 新規予約：送信処理受付/);
        await card.locator('[data-note-summary]').click();
        await card.locator('[data-note-input]').fill('通信中の書きかけを保持');
        if (situation === '取消通知の巻戻し') await page.locator('#notification-read').click();
        const before = await page.evaluate(() => ({ rows: structuredClone(adminData.reservations),
          list: document.querySelector('#notification-list').innerHTML,
          status: document.querySelector('#notification-status').textContent,
          requests: window.fixtureRequests.length }));
        await page.evaluate(({ row, failed }) => window.fixtureReleaseNotifications(failed ? null
          : { ok: true, reservations: [row], mailStatuses: true }), { row: BOOKING, failed: situation === '古い通信失敗' });
        await page.waitForFunction(() => !document.querySelector('#notification-check').disabled);
        assert.deepEqual(await page.evaluate(() => adminData.reservations), before.rows);
        assert.equal(await page.locator('#notification-list').innerHTML(), before.list);
        assert.equal(await page.locator('#notification-status').innerText(), before.status);
        assert.equal(await page.locator('#notification-health').isVisible(), false);
        assert.equal(await page.locator('#notification-count').innerText(), '未読0件');
        assert.equal(await card.locator('[data-note-input]').inputValue(), '通信中の書きかけを保持');
        assert.equal(await page.evaluate(() => window.fixtureRequests.length), before.requests, '破棄で自動の追加通信を増やさない');
        await page.evaluate(() => { window.fixtureHoldNotifications = false; });
        await page.locator('#notification-check').click();
        await page.waitForFunction(() => !document.querySelector('#notification-check').disabled);
        assert.equal(await page.locator('#notification-health').isVisible(), false);
        assert.equal(await page.locator('#notification-count').innerText(), '未読0件');
        assert.equal(await card.locator('[data-note-input]').inputValue(), '通信中の書きかけを保持');
        const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: window.innerWidth }));
        assert.ok(width.page <= width.viewport, '390pxで横にはみ出さない');
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, []);
        assert.ok(await page.evaluate(() => window.fixtureRequests.every(payload => payload.type === 'adminData')), '読取以外を要求しない');
        if (process.env.SCREENSHOT_DIR && design && situation === '配送の巻戻し') {
          await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'notification-order-390.png'), fullPage: true });
        }
      } finally {
        await context?.close();
        await browser?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
}
