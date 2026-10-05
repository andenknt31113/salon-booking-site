import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const TEST_TIMEOUT_MS = 10000;
const BOOKING = { code: 'LM-REFRESH-SCHEMA', date: '2099-01-05', time: '10:00', endTime: '11:00',
  menu: '架空カット', staffName: '架空担当', price: 4000, name: '取得済みの試験客',
  tel: '00000000000', email: '', visit: '初めて', source: '試験', request: '', note: '',
  status: '予約確定', shopMailStatus: '', customerMailStatus: '' };
const seed = { ok: true, reservations: [BOOKING], closedDates: [], menus: [], coupons: [], styles: [], reviews: [],
  settings: {}, stamps: { closed: '0', menus: '0', coupons: '0', styles: '0', reviews: '0', settings: '0' } };
const brokenReplies = [
  ['予約の必須情報が不完全', () => ({ ok: true, reservations: [{ code: BOOKING.code,
    date: BOOKING.date, time: BOOKING.time, name: { text: '壊れた氏名' } }], closedDates: [] })],
  ['休業時刻がobject', () => ({ ok: true, reservations: [{ ...BOOKING }],
    closedDates: [{ 休業日: BOOKING.date, 開始: { time: '10:00' }, 終了: '11:00', メモ: '' }] })],
  ['正常行に不完全な行が混在', () => ({ ok: true, reservations: [{ ...BOOKING, name: 'まだ採用しない変更' },
    { code: 'LM-BROKEN', date: BOOKING.date }], closedDates: [] })]
];

for (const design of ['', '?design=a']) {
  for (const [label, makeReply] of brokenReplies) {
    test(`${design || '従来版'}で${label}の一覧を採用せず、入力と再確認を保持する`, async () => {
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
          window.fixtureRequests = [];
          window.fixtureReply = null;
          adminPost = async payload => {
            window.fixtureRequests.push(structuredClone(payload));
            if (payload.type !== 'adminData') throw new Error('架空台帳でも書込はしない');
            return structuredClone(payload.reservationsOnly ? window.fixtureReply : data);
          };
          return openDashboard();
        }, seed), true);
        await page.locator('#filter-date').fill(BOOKING.date);
        await page.locator('#add-booking').click();
        await page.locator('#ab-name').fill('保持する電話受付の入力');
        await page.locator('#ab-menu').fill('書きかけのメニュー');
        await page.locator('#ab-price').fill('6900');
        const before = await page.evaluate(() => structuredClone({ adminData, edits, stamps }));
        await page.evaluate(reply => { window.fixtureReply = reply; }, makeReply());
        await page.locator('#refresh-reservations').click();
        await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
        assert.deepEqual(await page.evaluate(() => ({ adminData, edits, stamps })), before);
        assert.match(await page.locator('#reservation-freshness').innerText(), /取得できません|確認できません/);
        const card = page.locator(`#admin-rows .booking-card[data-code="${BOOKING.code}"]`);
        assert.match(await card.innerText(), /取得済みの試験客/);
        assert.equal(await page.locator('#ab-name').inputValue(), '保持する電話受付の入力');
        assert.equal(await page.locator('#ab-menu').inputValue(), '書きかけのメニュー');
        assert.equal(await page.locator('#ab-price').inputValue(), '6900');
        if (process.env.SCREENSHOT_DIR && design && label === '予約の必須情報が不完全') {
          await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'refresh-invalid-390.png'), fullPage: true });
        }
        await page.evaluate(row => { window.fixtureReply = { ok: true, reservations: [{ ...row, name: '再確認後の試験客' }], closedDates: [] }; }, BOOKING);
        await page.locator('#refresh-reservations').click();
        await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
        assert.match(await card.innerText(), /再確認後の試験客/);
        assert.match(await page.locator('#reservation-freshness').innerText(), /最終読込/);
        assert.equal(await page.locator('#ab-name').inputValue(), '保持する電話受付の入力');
        assert.equal(await page.locator('#ab-menu').inputValue(), '書きかけのメニュー');
        assert.equal(await page.locator('#ab-price').inputValue(), '6900');
        assert.deepEqual(await page.evaluate(() => window.fixtureRequests), [
          { type: 'adminData', startupOnly: true, briefPast: true, deferMenus: true },
          { type: 'adminData', reservationsOnly: true, ifNoneMatch: '' },
          { type: 'adminData', reservationsOnly: true, ifNoneMatch: '' }
        ]);
        const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: window.innerWidth }));
        assert.ok(width.page <= width.viewport, '390pxで横にはみ出さない');
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, []);
      } finally {
        await context?.close();
        await browser?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
}
