import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { mockBookingState } from './booking-state-fixture.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const DRAFT = { step: 3, couponId: 'cp01', menuIds: [], staffId: 'st01', staffChosen: true,
  date: null, time: null, calOffset: 0,
  customer: { name: '', kana: '', tel: '', email: '', visit: '', request: '', agree: false } };
const cases = [
  ['メニューIDが配列ではない下書き', { draft: { ...DRAFT, menuIds: null } }],
  ['お客様情報がobjectではない下書き', { draft: { ...DRAFT, customer: null } }],
  ['以前のメニュー情報が壊れた下書き', { draft: { ...DRAFT, menuDetails: [null] } }],
  ['文字列ではない保存済み連絡先', { profile: { name: {}, tel: '00000000000', email: [] } }]
];

for (const [label, stored] of cases) {
  test(`${label}でも入力を始められ、予約を自動送信しない`, async () => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    server.on('request', createMockHandler({ port }));
    const base = `http://127.0.0.1:${port}`;
    const browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
      process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const requests = [];
    const errors = [];
    try {
      await context.route('**/*', route => {
        const request = route.request();
        if (new URL(request.url()).origin !== base) return route.abort();
        if (request.method() === 'POST') requests.push(JSON.parse(request.postData()));
        return route.continue();
      });
      await mockBookingState(context, { approved: true, draft: false });
      await context.addInitScript(({ draft, profile }) => {
        if (draft) sessionStorage.setItem('salon.reserveDraft.v1', JSON.stringify(draft));
        if (profile) localStorage.setItem('salon.customer.v1', JSON.stringify(profile));
      }, stored);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/reserve.html');
      await page.waitForFunction(() => typeof Catalog !== 'undefined' && Catalog.loaded);
      await page.locator('[data-panel="1"].is-active').waitFor({ timeout: 3000 });
      await page.locator('#coupon-choices .selectable').first().click();
      await page.locator('[data-next="2"]').first().click();
      await page.locator('[data-panel="2"].is-active').waitFor();
      assert.equal(await page.locator('#saved-profile').evaluate(element => element.hidden), true);
      assert.equal(await page.locator('[data-field="name"]').evaluate(element => element.hidden), false);
      assert.equal(await page.evaluate(() => state.customer.agree), false);
      assert.deepEqual(errors, []);
      assert.ok(requests.every(request => ['menu', 'availability'].includes(request.type)));
    } finally {
      await context.close();
      await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
