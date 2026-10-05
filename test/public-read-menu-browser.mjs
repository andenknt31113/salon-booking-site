import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { withBookingState } from './booking-state-fixture.mjs';

const SOURCE = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const DATA = readFileSync(new URL('../assets/js/data.js', import.meta.url), 'utf8');
const ENDPOINT = 'https://script.google.com/macros/s/fixture/exec';
const FRAME_ORIGIN = 'https://fixture-script.googleusercontent.com';
const catalog = vm.runInNewContext(DATA + '\nSALON;');
const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await engines.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let handler;
const server = http.createServer((request, response) => handler(request, response));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
handler = createMockHandler({ port: server.address().port });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

function backendFixture(unavailable) {
  const reads = [];
  let held = false;
  const context = vm.createContext({ Date,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    console: { error() {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => ({ text }) }) },
    HtmlService: { XFrameOptionsMode: { ALLOWALL: 'allow' },
      createHtmlOutput: html => ({ setXFrameOptionsMode: () => ({ html }) }) },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; }
    }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName() {
      assert.equal(held, true);
      reads.push('ledger');
      if (unavailable) throw new Error('架空の予約台帳読込障害');
      return {};
    } }) }
  });
  vm.runInContext(SOURCE, context);
  for (const [name, value] of Object.entries({ readMenuSheet_: catalog.menuCategories,
    readCouponSheet_: catalog.coupons, readClosedSheet_: [], readSettings_: { '準備中の帯': '出さない' } })) {
    context[name] = () => { assert.equal(held, true); reads.push(name); return value; };
  }
  context.doAvailability_ = () => { assert.equal(held, true); reads.push('availability'); return { ok: true, booked: [] }; };
  return { reads, get: parameter => context.doGet({ parameter }) };
}

async function withPage(path, design, unavailable, run) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const backend = backendFixture(unavailable);
  const requests = [];
  const errors = [];
  try {
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === base) {
        if (url.pathname !== '/assets/js/data.js') return route.continue();
        const response = await route.fetch();
        const source = await response.text();
        const rewritten = withBookingState(source).replace(/reservationEndpoint\s*:\s*(['"])[^]*?\1/, `reservationEndpoint: '${ENDPOINT}'`);
        assert.notEqual(rewritten, source);
        return route.fulfill({ response, body: rewritten });
      }
      if (url.origin === new URL(ENDPOINT).origin) {
        if (request.method() !== 'GET') {
          errors.push('読取フレーム以外の要求を拒否');
          return route.abort();
        }
        assert.equal(url.pathname, new URL(ENDPOINT).pathname);
        const source = (FRAME_ORIGIN + '/read' + url.search).replaceAll('&', '&amp;');
        return route.fulfill({ status: 200, contentType: 'text/html', body: `<iframe src="${source}"></iframe>` });
      }
      if (url.origin === FRAME_ORIGIN) {
        const parameters = Object.fromEntries(url.searchParams);
        requests.push(parameters);
        const result = backend.get(parameters);
        assert.equal(typeof result.html, 'string');
        return route.fulfill({ status: 200, contentType: 'text/html', body: result.html });
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/${path}.html${design ? '?design=a' : ''}`);
    await page.waitForFunction(() => typeof Catalog !== 'undefined' && Catalog.loaded);
    await run({ page, reads: backend.reads, requests });
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 1);
    assert.equal(await page.locator('iframe').count(), 0, '応答後の読取フレームを残さない');
  } finally {
    await context.close();
  }
}

for (const design of [false, true]) {
  const label = design ? 'A案' : '従来版';
  test(`${label}：予約確認は台帳障害時も不要な空席を取らず、最新メニュー・受付条件を一回で受け取る`, () =>
    withPage('mypage', design, true, async ({ page, reads, requests }) => {
      assert.equal(requests[0].initialAvailability, 'false');
      assert.deepEqual(reads, ['readMenuSheet_', 'readCouponSheet_', 'readClosedSheet_', 'readSettings_']);
      assert.equal(await page.evaluate(() => Catalog.source), 'sheet');
      assert.equal(await page.evaluate(() => SALON.menuCategories.length), catalog.menuCategories.length);
      assert.equal(await page.locator('h1').innerText(), '予約の確認・変更・キャンセル');
    }));

  test(`${label}：新規予約は最新メニューと空席を一回で取得してから日時を選べる`, () =>
    withPage('reserve', design, false, async ({ page, reads, requests }) => {
      await page.waitForFunction(() => Remote.loaded);
      assert.equal(requests[0].initialAvailability, 'true');
      assert.deepEqual(reads, ['readMenuSheet_', 'readCouponSheet_', 'readClosedSheet_', 'readSettings_', 'ledger', 'availability']);
      assert.equal(await page.evaluate(() => Catalog.source), 'sheet');
      assert.equal(await page.evaluate(() => Array.isArray(Remote.booked)), true);
      assert.equal(await page.evaluate(() => SALON.draft), false);
      await page.locator('#coupon-choices .selectable').first().click();
      await page.locator('#step-cta button').click();
      assert.ok(await page.locator('#cal-body .slot:not(:disabled)').count() > 0);
    }));

  test(`${label}：新規予約で台帳障害を空席ありへ変えず、日時選択を止める`, () =>
    withPage('reserve', design, true, async ({ page, reads, requests }) => {
      assert.equal(requests[0].initialAvailability, 'true');
      assert.ok(reads.includes('ledger'));
      assert.equal(await page.evaluate(() => Catalog.source), 'local');
      assert.match(await page.locator('#catalog-status').innerText(), /日時の選択へは進めません/);
      assert.equal(await page.evaluate(() => Remote.booked), null);
      assert.equal(await page.locator('#cal-body .slot:not(:disabled)').count(), 0);
    }));
}
