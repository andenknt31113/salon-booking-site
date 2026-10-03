import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const TEST_TIMEOUT_MS = 7000;
const HEADERS = ['予約番号', '来店日', '開始', '終了', 'メニュー', '担当', '金額',
  'お名前', '電話番号', 'メール', '来店回数', 'ご要望', '状態', '施術メモ'];
const FIELDS = ['code', 'date', 'time', 'endTime', 'menu', 'staffName', 'price',
  'name', 'tel', 'email', 'visit', 'request', 'status', 'note'];
const rows = [{ code: 'LM-CSV-FIRST', date: '2099-01-01', time: '10:00', endTime: '11:00',
  menu: '架空カット', staffName: '架空担当', price: 6900, name: '＝1+2', tel: '00000000000',
  email: 'fixture@example.test', visit: '2回目以降', request: '\t=1+2', status: '予約確定', note: ' \uFEFF＋1+2' },
{ code: 'LM-CSV-SECOND', date: '2099-01-02', time: '10:00', endTime: '11:00',
  menu: '架空カット', staffName: '架空担当', price: 0, name: '架空のお客様', tel: '00000000001',
  email: '', visit: '初めて', request: 'メモ,"引用";区切り\r\n次の行', status: 'キャンセル', note: "'=保存済みの文字" }];
const seed = { ok: true, reservations: rows, closedDates: [], menus: [], coupons: [],
  styles: [], reviews: [], settings: {}, stamps: {} };
const quoted = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
const expected = [HEADERS, ...rows.map((row, index) => FIELDS.map(field =>
  (index === 0 && ['name', 'request', 'note'].includes(field) ? "'" : '') + String(row[field] ?? '')))]
  .map(row => row.map(quoted).join(',')).join('\r\n');

for (const design of ['', '?design=a']) {
  test(`${design || '従来版'}でCSVをダウンロードし、数式・全角・改行を保護して元データを保持する`, async () => {
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
      context = await browser.newContext({ viewport: { width: 390, height: 844 },
        timezoneId: 'Asia/Tokyo', serviceWorkers: 'block', acceptDownloads: true });
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
      await page.evaluate(async data => {
        window.fixtureRequests = [];
        adminPost = async payload => {
          window.fixtureRequests.push(payload);
          if (payload.type !== 'adminData') throw new Error('架空台帳でも書込はしない');
          return structuredClone(data);
        };
        await openDashboard();
        document.querySelector('#filter-date').value = '';
        document.querySelector('#filter-status').value = 'all';
        showPast = true;
        renderReservations();
      }, seed);
      const before = await page.evaluate(() => structuredClone(adminData.reservations));
      const download = page.waitForEvent('download');
      await page.locator('#export-csv').click();
      const file = await download;
      assert.match(file.suggestedFilename(), /^reservations_\d{4}-\d{2}-\d{2}\.csv$/);
      const bytes = await readFile(await file.path());
      assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
      assert.equal(bytes.toString('utf8').slice(1), expected);
      assert.deepEqual(await page.evaluate(() => adminData.reservations), before);
      assert.deepEqual(await page.evaluate(() => window.fixtureRequests),
        [{ type: 'adminData', startupOnly: true, briefPast: true }], 'CSVで新しい通信・書込を加えない');
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
