import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
after(() => browser.close());

for (const design of ['', '?design=a']) {
  test(`名簿を開かずに過去・今後の予約件数を見分け、取消を過去予約に数えない ${design || '従来版'}`, async () => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    handler = createMockHandler({ port: server.address().port });
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
    const requests = [];
    try {
      for (const [index, date] of ['2025-01-01', '2025-02-01', '2099-01-01', '2025-03-01'].entries()) {
        const response = await fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ type: 'seed',
          code: `LM-COUNT${index}`, date, time: '10:00', endTime: '11:00', name: index === 0 ? '番号を共有するご家族' : '件数の試験客',
          tel: '09000000000', cancelled: index === 3 }) });
        assert.equal((await response.json()).ok, true);
      }
      await page.goto(base + '/admin.html' + design);
      await page.locator('#passcode').fill(password);
      await page.locator('#remember-me').uncheck();
      await page.locator('#gate-btn').click();
      await page.locator('#dashboard:not([hidden])').waitFor();
      page.on('request', request => {
        if (request.url() === base + '/exec' && request.method() === 'POST') requests.push(request.postDataJSON().type);
      });
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      const row = page.locator('[data-customer-history]').first();
      assert.equal(await page.locator('.customer-record[open]').count(), 0);
      assert.match(await row.innerText(), /過去の予約 2件 ／ 今後・施術中 1件/);
      assert.match(await row.innerText(), /同じ番号/);
      assert.equal((await row.innerText()).includes('来店回数'), false, '実際の来店を確認していないので予約件数と書く');
      await row.focus();
      await page.keyboard.press('Enter');
      assert.match(await page.locator('.customer-profile').innerText(), /キャンセル 1件/);
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}pxで横にはみ出さない`);
      }
      assert.deepEqual(requests, [], '件数を見るだけで台帳に通信・保存しない');
    } finally {
      await page.context().close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
