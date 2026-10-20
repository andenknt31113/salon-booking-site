import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
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

const savedReservation = {
  code: 'LM-VIEW2', status: 'reserved', date: '2099-10-25', time: '10:00', endTime: '11:00',
  staffId: 'st01', staffName: '確認用担当', nominationFee: 0,
  menus: [{ id: 'm1', name: '確認用カット', price: 4000, minutes: 60 }],
  totalMinutes: 60, totalPrice: 4000,
  customer: { name: '表示確認', tel: '00000000000', request: '' }
};

async function withPage(name, width, records, run) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const unexpected = [];
  const errors = [];
  await context.route('**/*', async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== base) return route.abort();
    if (request.method() !== 'GET') {
      const operation = request.postDataJSON()?.type;
      if (!['menu', 'availability'].includes(operation)) {
        unexpected.push(operation);
        return route.abort();
      }
      if (operation === 'menu') {
        const response = await route.fetch();
        const catalog = await response.json();
        catalog.settings['準備中の帯'] = '出さない';
        return route.fulfill({ response, json: catalog });
      }
    }
    return route.continue();
  });
  await context.addInitScript(records => localStorage.setItem('salon.reservations.v1', JSON.stringify(records)), records);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/${name}.html`);
    await page.waitForFunction(() => Catalog.loaded);
    await run(page);
    assert.deepEqual(unexpected, [], '表示確認で照会・予約・変更・取消を送信しない');
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  } finally { await context.close(); }
}

for (const width of [320, 390, 1280]) {
  for (const saved of [false, true]) {
    test(`${width}px・${saved ? '控えあり' : '控えなし'}：自分の予約を確認する入口を先に表示する`, () => withPage('mypage', width, saved ? [savedReservation] : [], async page => {
      const order = await page.locator('#lookup-box').evaluate(lookup => ({
        beforeHistory: !!(lookup.compareDocumentPosition(document.querySelector('#upcoming-list')) & Node.DOCUMENT_POSITION_FOLLOWING)
      }));
      assert.equal(order.beforeHistory, !saved, '控えがなければ照会を先に、あれば保存済み予約を先に出す');
      await page.locator('#lookup-code').fill('LM-INPUT');
      await page.locator('#lookup-tel').fill('00000000000');
      await page.evaluate(() => refreshView(true));
      assert.equal(await page.locator('#lookup-code').inputValue(), 'LM-INPUT');
      assert.equal(await page.locator('#lookup-tel').inputValue(), '00000000000');
      assert.equal(await page.locator('#lookup-tel').evaluate(input => input === document.activeElement), true);
      assert.equal(await page.locator('#lookup-box').evaluate(lookup => !!(lookup.compareDocumentPosition(document.querySelector('#upcoming-list')) & Node.DOCUMENT_POSITION_FOLLOWING)), !saved);
      assert.equal(await page.locator('#upcoming-list .booking-card').count(), saved ? 1 : 0);
      assert.doesNotMatch(await page.locator('#lookup-box').innerText(), /上の一覧/);
      assert.equal(await page.locator('.page-kicker').isVisible(), false, '手続き画面で見出しと同じ英語を繰り返さない');
    }));
  }
  test(`${width}px：最終確認は一つにまとめ、修正へ戻ると選択内容の表示を復元する`, () => withPage('reserve', width, [], async page => {
    await page.waitForFunction(() => Remote.loaded);
    await page.locator('#coupon-choices .selectable').first().click();
    await page.evaluate(() => {
      state.date = '2099-10-25'; state.time = '10:00';
      state.customer.name = '表示確認'; state.customer.kana = 'ヒョウジカクニン';
      fillForm();
      goTo(5);
    });
    assert.equal(await page.locator('[data-panel="5"]').isVisible(), true);
    assert.equal(await page.locator('#summary').isVisible(), false, '同じメニュー・担当・日時の一覧を二重に出さない');
    assert.match(await page.locator('#confirm-body').innerText(), /表示確認/);
    assert.equal(await page.locator('#submit-reservation').isVisible(), true);
    await page.locator('[data-panel="5"] [data-prev="4"]').click();
    assert.equal(await page.locator('#summary').isVisible(), true);
    assert.equal(await page.locator('#f-name').inputValue(), '表示確認');
    assert.ok((await page.locator('#summary-total').innerText()).includes('¥'));
    assert.equal(await page.locator('#reserve-layout').evaluate(element => element.style.gridTemplateColumns), '');
    assert.match(await page.locator('.done-box').textContent(), /通知はカレンダーアプリの設定に従います/);
  }));
}

test('予約番号の日本語変換を確定するEnterでは照会しない', () => withPage('mypage', 390, [], async page => {
  for (const selector of ['#lookup-code', '#lookup-tel']) {
    await page.locator(selector).evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    assert.equal(await page.locator('#lookup-error').innerText(), '');
  }
  await page.locator('#lookup-code').press('Enter');
  assert.match(await page.locator('#lookup-error').innerText(), /予約番号/);
}));
