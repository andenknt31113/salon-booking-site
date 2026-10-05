import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { openGoogleAdmin } from './google-admin-fixture.mjs';

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
    const shell = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo',
      serviceWorkers: 'block' });
    const errors = [];
    shell.on('pageerror', error => errors.push(error.message));
    const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password }) })
      .then(response => response.json());
    try {
      for (const [index, date] of ['2025-01-01', '2025-02-01', '2099-01-01', '2025-03-01'].entries()) {
        const response = await post({ type: 'seed',
          code: `LM-COUNT${index}`, date, time: '10:00', endTime: '11:00', name: index === 0 ? '番号を共有するご家族' : '件数の試験客',
          tel: '00000000000', cancelled: index === 3 });
        assert.equal(response.ok, true);
      }
      const admin = await openGoogleAdmin({ shell, base, design, request: post });
      const page = admin.frame;
      const initialReads = admin.operations.length;
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      const row = page.locator('[data-customer-history]').first();
      assert.equal(await page.locator('.customer-record[open]').count(), 0);
      assert.match(await row.innerText(), /過去の予約 2件 ／ 今後・施術中 1件/);
      assert.match(await row.innerText(), /同じ番号/);
      assert.equal((await row.innerText()).includes('来店回数'), false, '実際の来店を確認していないので予約件数と書く');
      assert.equal(admin.operations.length, initialReads, '件数を見るだけでは追加読込も保存もしない');
      const pendingDetails = await page.evaluate(() => hasPendingReservationDetails());
      await row.focus();
      await row.press('Enter');
      assert.match(await page.locator('.customer-profile').innerText(), /キャンセル 1件/);
      await page.waitForFunction(() => !hasPendingReservationDetails());
      assert.deepEqual(admin.operations.slice(initialReads), pendingDetails ? [{ type: 'adminData', reservationsOnly: true,
        reservationCodes: ['LM-COUNT0', 'LM-COUNT1', 'LM-COUNT3'] }] : [], '履歴を開いた場合だけ未読込の詳細を取得する');
      for (const width of [320, 390, 768, 1280]) {
        await shell.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}pxで横にはみ出さない`);
      }
      assert.ok(admin.operations.every(operation => operation.type === 'adminData'), '名簿と履歴を見る操作では台帳を変更しない');
      admin.assertIsolated();
      assert.deepEqual(errors, []);
    } finally {
      await shell.context().close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
