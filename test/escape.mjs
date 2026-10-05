/* 画面に、お客様が書いた文字がそのまま埋め込まれていないかを確かめる。

   お名前やご要望は、確認画面・完了画面・管理ページ・お客様タブ・
   予約確認ページと、いくつもの場所に出ます。
   どこか1か所でも生のまま埋め込むと、そこだけが穴になります。
   店側の画面で動くと、開いているのは店の人なので被害が大きくなります。

   使い方は ユースケース.md を参照。 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { mockBookingState } from './booking-state-fixture.mjs';
import { openGoogleAdmin } from './google-admin-fixture.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const NAME = '<img src=x onerror=alert(1)>山田';
const REQUEST = '<script>alert(2)</script>\nよろしく';
const PHONE = '00000000000';
const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
after(() => browser.close());

async function escaped(locator, values) {
  const content = await locator.textContent();
  for (const value of values) assert.ok(content.includes(value), '入力はタグではなく全文の文字として表示する');
  assert.equal(await locator.locator('img[src="x"],script').count(), 0, '入力のタグをDOMへ埋め込まない');
}

for (const design of ['', '?design=a']) {
  test(`名前・ご要望のタグを確認／完了／Google管理／名簿／予約確認で実行しない：${design || '従来版'}`, async () => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    const contexts = [];
    const external = [];
    const errors = [];
    const dialogs = [];
    const requests = [];
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      handler = createMockHandler({ port: server.address().port });
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password }) })
        .then(response => response.json());
      for (const role of ['customer', 'admin']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 },
          isMobile: true, hasTouch: true, timezoneId: 'Asia/Tokyo', locale: 'ja-JP', serviceWorkers: 'block' });
        contexts.push(context);
        context.on('page', page => {
          page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.dismiss(); });
          page.on('pageerror', error => errors.push(error.message));
        });
        await context.route('**/*', route => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== base) { external.push(request.method()); return route.abort(); }
          if (role === 'customer' && url.pathname === '/exec') {
            const payload = request.postDataJSON();
            assert.ok(['menu', 'availability', 'reserve', 'lookup'].includes(payload.type));
            requests.push(structuredClone(payload));
          }
          return route.continue();
        });
      }
      await mockBookingState(contexts[0]);
      const customer = await contexts[0].newPage();
      await customer.goto(base + '/reserve.html');
      await customer.waitForFunction(() => Catalog.loaded && Remote.loaded);
      await customer.locator('#coupon-choices .selectable').first().click();
      await customer.locator('#step-cta button').click();
      await customer.locator('#cal-next').click();
      await customer.locator('#cal-body .slot:not(:disabled)').first().click();
      const date = await customer.evaluate(() => state.date);
      const menu = await customer.evaluate(() => selectedMenus()[0].name);
      await customer.locator('#step-cta button').click();
      for (const [field, value] of Object.entries({ name: NAME, kana: 'ヤマダ', tel: PHONE,
        email: 'input-check@example.test', request: REQUEST })) await customer.locator('#f-' + field).fill(value);
      await customer.locator('[name="visit"][value="初めて"]').check();
      await customer.locator('#f-agree').check();
      await customer.locator('#step-cta button').click();
      assert.equal(await customer.evaluate(() => state.step), 5);
      await escaped(customer.locator('#confirm-body'), [NAME, REQUEST.split('\n')[0]]);
      await customer.locator('#submit-reservation').click();
      await customer.locator('#done-code').waitFor({ state: 'visible' });
      const code = (await customer.locator('#done-code').innerText()).trim();
      assert.match(code, /^LM-[A-Z0-9]{5}$/);
      assert.equal(await customer.locator('#h-done').innerText(), 'ご予約が完了しました');
      await escaped(customer.locator('#done-body'), [menu]);
      const saved = await customer.evaluate(code => Store.all().find(reservation => reservation.code === code).customer, code);
      assert.equal(saved.name, NAME, '完了画面に名前を表示しなくても記録から消さない');
      assert.equal(saved.request, REQUEST);
      const submitted = requests.filter(request => request.type === 'reserve');
      assert.equal(submitted.length, 1, '架空台帳に一回だけ予約を登録する');
      assert.equal(submitted[0].customer.name, NAME);
      assert.equal(submitted[0].customer.request, REQUEST);

      const shell = await contexts[1].newPage();
      const admin = await openGoogleAdmin({ shell, base, design, request: post });
      await admin.frame.locator('#filter-date').fill(date);
      await admin.frame.locator('#filter-date').dispatchEvent('change');
      await escaped(admin.frame.locator('#admin-rows'), [NAME]);
      await admin.frame.locator('#admin-tabs .tab', { hasText: 'お客様' }).first().click();
      await admin.frame.locator('#customer-rows [data-customer-history]').first().waitFor();
      await escaped(admin.frame.locator('#customer-rows'), [NAME]);
      assert.ok(admin.operations.length > 0);
      assert.ok(admin.operations.every(operation => operation.type === 'adminData'), '表示の確認で台帳を変更しない');
      admin.assertIsolated();

      await customer.goto(base + '/mypage.html');
      await customer.waitForFunction(() => document.querySelector('#upcoming-list').textContent.includes('LM-'));
      assert.ok((await customer.locator('#upcoming-list').textContent()).includes(code));
      await escaped(customer.locator('#upcoming-list'), [REQUEST.split('\n')[0]]);
      await customer.locator('#lookup-code').fill(code);
      await customer.locator('#lookup-tel').fill(PHONE);
      await customer.locator('#lookup-btn').click();
      await customer.locator('#lookup-result .booking-card').waitFor();
      await escaped(customer.locator('#lookup-result'), [NAME]);
      assert.equal(await customer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(dialogs, [], '入力されたスクリプトのalertを実行しない');
      assert.deepEqual(errors, []);
      assert.deepEqual(external, [], '実台帳・Google・通知先へ接続しない');
    } finally {
      for (const context of contexts) await context.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
