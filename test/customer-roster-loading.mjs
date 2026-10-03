import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const CUSTOMER_COUNT = 250;
const VISITS_PER_CUSTOMER = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const nextDate = new Date(Date.now() + 7 * DAY_MS).toISOString().slice(0, 10);

for (const design of ['', '?design=a']) {
  test(`${design || '従来版'}の大きな名簿は選んだ人だけの履歴を作り、メモ・検索・予約移動を守る`, async () => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    server.on('request', createMockHandler({ port }));
    const base = `http://127.0.0.1:${port}`;
    const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify(payload) }).then(response => response.json());
    const browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
      process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
    const errors = [];
    let warning = '';
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { warning = dialog.message(); await dialog.dismiss(); });
    try {
      await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
        ? route.continue() : route.abort());
      const rows = Array.from({ length: CUSTOMER_COUNT * VISITS_PER_CUSTOMER }, (_, index) => {
        const customer = Math.floor(index / VISITS_PER_CUSTOMER);
        const visit = index % VISITS_PER_CUSTOMER;
        return { code: `LM-ROSTER-${index}`, name: customer === 0 ? '架空 名簿最初' : `架空 顧客${String(customer + 1).padStart(4, '0')}`,
          tel: String(1000 + customer).padStart(11, '0'), date: `2025-01-${String(VISITS_PER_CUSTOMER - visit).padStart(2, '0')}`,
          time: '10:00', endTime: '11:00', menu: '試験カット', staffName: '試験担当', price: 4000,
          email: '', visit: '試験', source: '試験', request: '', note: '',
          shopMailStatus: '', customerMailStatus: '', status: visit === VISITS_PER_CUSTOMER - 1 ? 'キャンセル' : '予約確定' };
      });
      const firstVisit = rows[0];
      const booking = await post({ type: 'adminAdd', password, force: true, date: firstVisit.date,
        time: firstVisit.time, minutes: 60, price: firstVisit.price, menu: firstVisit.menu, name: firstVisit.name, tel: firstVisit.tel });
      assert.equal(booking.ok, true);
      firstVisit.code = booking.code;
      rows.push({ ...firstVisit, code: 'LM-ROSTER-NEXT', date: nextDate });
      await page.route('**/exec', async route => {
        const request = JSON.parse(route.request().postData() || '{}');
        if (request.type !== 'adminData') return route.continue();
        const response = await route.fetch();
        const body = await response.json();
        Object.assign(firstVisit, body.reservations.find(row => row.code === booking.code));
        body.reservations = rows;
        await route.fulfill({ response, body: JSON.stringify(body) });
      });
      await page.goto(base + '/admin.html' + design);
      await page.evaluate(() => {
        const build = buildCustomers;
        window.customerBuilds = 0;
        buildCustomers = () => { window.customerBuilds++; return build(); };
      });
      await page.locator('#passcode').fill(password);
      await page.locator('#remember-me').setChecked(false);
      await page.locator('#gate-btn').click();
      await page.locator('#dashboard:not([hidden])').waitFor();
      assert.equal(await page.locator('.customer-record').count(), 0, '予定を開く時点では隠れた名簿を作らない');
      assert.equal(await page.evaluate(() => window.customerBuilds), 0, '予定表示のために顧客の全履歴を集計しない');
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      assert.equal(await page.evaluate(() => window.customerBuilds), 1);
      await page.locator('#admin-tabs [data-pane="reserve"]').click();
      rows.push({ ...rows[VISITS_PER_CUSTOMER], code: 'LM-ROSTER-UPDATE', date: nextDate });
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.equal(await page.evaluate(() => window.customerBuilds), 1, '予定を更新しても隠れた名簿は再集計しない');
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      assert.equal(await page.evaluate(() => window.customerBuilds), 2, '名簿を開いたとき最新の取得結果を集計する');
      assert.match(await page.locator(`.customer-record[data-customer-tel="${rows[VISITS_PER_CUSTOMER].tel}"]`).innerText(), /今後・施術中 1件/);
      await page.locator('#admin-tabs [data-pane="reserve"]').click();
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      assert.equal(await page.evaluate(() => window.customerBuilds), 2, '取得結果が変わらないタブ切替では作り直さない');
      const measurement = await page.evaluate(() => {
        const start = performance.now();
        renderCustomers();
        return { renderMs: performance.now() - start, elements: document.querySelectorAll('#customer-rows *').length,
          historyRows: document.querySelectorAll('#customer-rows .customer-history li').length,
          noteInputs: document.querySelectorAll('#customer-rows [data-note-input]').length };
      });
      console.log(JSON.stringify({ design: design || 'original', customers: CUSTOMER_COUNT, visits: rows.length, ...measurement }));
      assert.equal(await page.locator('.customer-record').count(), 50);
      assert.match(await page.locator('#customer-count').textContent(), /1〜50件を表示 \/ 検索結果 250件 \/ 名簿 250件/);
      assert.equal(await page.evaluate(() => buildCustomers().length), CUSTOMER_COUNT, '名簿の全件を保持する');
      assert.equal(measurement.historyRows, 0, '閉じた人の全履歴を先に描画しない');
      assert.equal(measurement.noteInputs, 0, '閉じた人の編集欄を先に作らない');
      const first = page.locator(`.customer-record[data-customer-tel="${firstVisit.tel}"]`);
      const second = page.locator('.customer-record').nth(1);
      await first.locator('[data-customer-history]').focus();
      await first.locator('[data-customer-history]').press('Enter');
      assert.equal(await first.getAttribute('open'), '');
      assert.equal(await first.locator('.customer-history li').count(), VISITS_PER_CUSTOMER + 1);
      assert.match(await first.locator('.customer-profile').innerText(), /過去の予約 19件/);
      assert.match(await first.locator('.customer-profile').innerText(), /今後・施術中 1件 ／ キャンセル 1件/);
      assert.equal(await page.locator('.customer-history').count(), 1);
      const noteBox = first.locator(`[data-note-box="${booking.code}"]`);
      await noteBox.locator('[data-note-summary]').click();
      await noteBox.locator('[data-note-input]').fill('軽くした名簿でも残す申し送り');
      await second.locator('[data-customer-history]').click();
      assert.equal(await first.getAttribute('open'), '');
      assert.equal(await second.getAttribute('open'), null);
      await page.locator('#customer-search').fill('架空 顧客0002');
      assert.equal(await page.locator('#customer-search').inputValue(), '');
      await page.locator('#customer-sort').selectOption('name');
      assert.equal(await page.locator('#customer-sort').inputValue(), 'recent');
      await first.locator('[data-customer-close]').click();
      assert.equal(await first.getAttribute('open'), '');
      assert.equal(await noteBox.locator('[data-note-input]').inputValue(), '軽くした名簿でも残す申し送り');
      assert.match(warning, /保存/);
      await noteBox.locator('[data-note-save]').click();
      await noteBox.locator('[data-note-status]').filter({ hasText: '保存しました' }).waitFor();
      await second.locator('[data-customer-history]').click();
      assert.equal(await first.getAttribute('open'), null);
      assert.equal(await first.locator('.customer-profile *').count(), 0, '閉じた詳細を解放する');
      assert.equal(await page.locator('.customer-history').count(), 1);
      await first.locator('[data-customer-history]').click();
      assert.match(await first.locator('.customer-profile').innerText(), /軽くした名簿でも残す申し送り/);
      assert.equal(await noteBox.locator('[data-note-input]').inputValue(), '軽くした名簿でも残す申し送り');
      await first.locator(`[data-history-booking="${booking.code}"]`).click();
      await page.locator('#admin-rows .is-focus').waitFor();
      assert.equal(await page.locator('#admin-rows .is-focus').getAttribute('data-code'), booking.code);
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      assert.equal(await first.getAttribute('open'), '');
      await first.locator('[data-customer-close]').click();
      assert.equal(await page.locator('.customer-history').count(), 0);
      await page.locator('#customer-search').fill(firstVisit.name);
      assert.equal(await page.locator('.customer-record').count(), 1);
      await first.locator('[data-customer-history]').click();
      await page.locator('#customer-sort').selectOption('name');
      assert.equal(await page.locator('.customer-record[open]').count(), 1, '保存済みの詳細は並び替え後も保持');
      if (process.env.TEST_SCREENSHOT_DIR) await first.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR,
        `roster-detail-${process.env.TEST_BROWSER || 'chromium'}-${design ? 'a' : 'original'}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
