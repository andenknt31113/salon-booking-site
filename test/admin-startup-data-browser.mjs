import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createMockHandler } from './mock-gas.mjs';
import { test } from 'node:test';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const TEST_TIMEOUT_MS = 7000;
const seed = () => ({ ok: true, reservations: [{ code: 'LM-STARTUP', date: '2099-01-05',
  time: '10:00', endTime: '11:00', name: '架空 初回試験', tel: '00000000000',
  price: 4000, status: '予約確定', note: '保持するメモ', request: '', menu: '架空カット',
  staffName: '架空担当', email: '', visit: '', source: '' }], closedDates: [], menus: [], coupons: [], settings: {},
stamps: { menus: '0', coupons: '0', closed: '0', settings: '0' }, pendingEditors: ['styles', 'reviews'] });

for (const design of ['', '?design=a']) {
  test(`${design || '従来版'}で欠落した初回応答を拒否し、正しい再読込と下書き保護を確認する`, async () => {
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
      await page.evaluate(() => {
        window.fixtureReads = 0;
        adminPost = async () => { window.fixtureReads++; return structuredClone(window.fixtureResponse); };
      });
      const invalid = seed();
      delete invalid.reservations;
      assert.equal(await page.evaluate(async response => {
        window.fixtureResponse = response;
        return openDashboard();
      }, invalid), false);
      assert.equal(await page.locator('#dashboard').isVisible(), false);
      assert.equal(await page.locator('#gate').isVisible(), true);
      assert.match(await page.locator('#gate-error').innerText(), /読込内容を確認できません/);
      assert.equal(await page.evaluate(() => adminData), null);
      const correct = seed();
      assert.equal(await page.evaluate(async response => {
        window.fixtureResponse = response;
        return openDashboard();
      }, correct), true);
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      assert.match(await page.locator('#customer-rows').innerText(), /架空 初回試験/);
      const before = await page.evaluate(() => {
        edits.menus.push({ メニュー名: '保持する未保存メニュー' });
        return { adminData: structuredClone(adminData), edits: structuredClone(edits),
          stamps: structuredClone(stamps), generation: dashboardGeneration,
          freshness: document.querySelector('#reservation-freshness').textContent };
      });
      let message = '';
      page.once('dialog', dialog => { message = dialog.message(); return dialog.dismiss(); });
      assert.equal(await page.evaluate(async response => {
        window.fixtureResponse = response;
        return openDashboard();
      }, invalid), false);
      assert.match(message, /最新の予定を読み込めませんでした/);
      assert.deepEqual(await page.evaluate(() => ({ adminData, edits, stamps, generation: dashboardGeneration,
        freshness: document.querySelector('#reservation-freshness').textContent })), before);
      assert.match(await page.locator('#customer-rows').innerText(), /架空 初回試験/);
      assert.equal(await page.evaluate(() => window.fixtureReads), 3);
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
