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

async function withAdmin(design, run) {
  let handler;
  const server = http.createServer((request, response) => handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  handler = createMockHandler({ port });
  const base = `http://127.0.0.1:${port}`;
  const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify(payload) }).then(response => response.json());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
  const errors = [];
  const blocked = [];
  const directRequests = [];
  const operations = [];
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      blocked.push(request.method());
      return route.abort();
    }
    if (url.pathname === '/exec') {
      directRequests.push(request.method());
      return route.abort();
    }
    if (url.pathname === '/fixture-shell.html') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width">'
        + '<style>html,body{margin:0}iframe{display:block;width:100%;height:100vh;border:0}</style>'
        + '<script>window.authAdminRequest = payload => window.fixtureAdminRequest(payload);</script>'
        + `<iframe id="management" title="架空のGoogle管理" src="admin.html?google=1${design ? '&design=a' : ''}"></iframe>` });
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const reservation = await post({ type: 'adminAdd', password, force: true, date: '2026-10-08',
      time: '10:00', minutes: 60, name: '使い勝手の試験客', tel: '09000000000', price: 4000 });
    assert.equal(reservation.ok, true);
    await page.exposeFunction('fixtureAdminRequest', payload => {
      assert.equal(Object.hasOwn(payload, 'password'), false, '旧パスワードを使わない');
      assert.equal(Object.hasOwn(payload, 'token'), false, '旧合鍵を使わない');
      operations.push(structuredClone(payload));
      return post({ ...payload, password });
    });
    await page.goto(base + '/fixture-shell.html');
    const management = page.frameLocator('#management');
    await management.locator('#dashboard:not([hidden])').waitFor();
    const frame = await (await page.locator('#management').elementHandle()).contentFrame();
    assert.ok(frame);
    assert.equal(await management.locator('#gate').isVisible(), false, '旧ログインを操作しない');
    assert.deepEqual(await frame.evaluate(() => ({ embedded: window.googleAdminEmbedded, password: adminPw, token: adminToken })),
      { embedded: true, password: '', token: '' });
    assert.deepEqual(operations[0], { type: 'adminData', startupOnly: true, briefPast: true, deferMenus: true });
    await run(frame, reservation.code, page);
    assert.ok(operations.length > 0);
    assert.ok(operations.every(operation => operation.type === 'adminData'), '表示・入力だけでは台帳を更新しない');
    assert.deepEqual(directRequests, [], '管理操作はGoogle管理bridgeだけを通す');
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
    assert.deepEqual(blocked, [], '本番を含む外部サービスへ通信しない');
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const design of ['', '?design=a']) {
  test(`休業日でも絞り込みの該当なしと解除先を隠さない ${design || '従来版'}`, async () => {
    await withAdmin(design, async (page, code) => {
      await page.evaluate(() => {
        adminData.closedDates = [{ '休業日': '2026-10-08', '開始': '', '終了': '', 'メモ': '' }];
      });
      await page.locator('#filter-date').fill('2026-10-08');
      await page.locator('#filter-status').selectOption('cancelled');
      const rows = page.locator('#admin-rows');
      assert.match(await rows.innerText(), /この条件に合うご予約はありません.*すべての日・状態に戻す/s);
      assert.match(await rows.innerText(), /終日お休み/);
      assert.equal(await rows.locator(`[data-code="${code}"]`).count(), 0, '状態に合わない予約は出さない');
      await page.locator('#filter-status').selectOption('reserved');
      assert.equal(await rows.locator(`[data-code="${code}"]`).count(), 1);
      assert.match(await rows.innerText(), /終日お休み・予約1件あり/);
      assert.equal(await rows.locator('.empty-state').count(), 0, '該当予約がある場合は該当なしと案内しない');
      await page.locator('#filter-status').selectOption('cancelled');
      await page.locator('#filter-reset').click();
      assert.equal(await page.locator('#filter-date').inputValue(), '');
      assert.equal(await page.locator('#filter-status').inputValue(), 'all');
      assert.equal(await rows.locator(`[data-code="${code}"]`).count(), 1, '解除して予約を再表示する');
      assert.equal(await rows.locator('.empty-state').count(), 0);
    });
  });

  test(`日付移動・電話予約の日付・下書き保護 ${design || '従来版'}`, async () => {
    await withAdmin(design, async (page, code) => {
      assert.equal(await page.locator('.admin-workspace-header #add-booking').count(), 1, '電話受付は作業見出しの隣');
      await page.locator('#filter-date').fill('2028-02-28');
      await page.locator('#filter-next').click();
      assert.equal(await page.locator('#filter-date').inputValue(), '2028-02-29', 'うるう日を飛ばさない');
      await page.locator('#filter-next').click();
      assert.equal(await page.locator('#filter-date').inputValue(), '2028-03-01', '月をまたげる');
      await page.locator('#filter-previous').click();
      assert.equal(await page.locator('#filter-date').inputValue(), '2028-02-29');
      assert.match(await page.locator('#reservation-filter-summary').innerText(), /2028.*2.*29/);
      await page.locator('#filter-date').fill('2026-10-08');
      await page.locator('#add-booking').click();
      assert.equal(await page.locator('#ab-date').inputValue(), '2026-10-08', '選んだ日から電話予約を始める');
      await page.locator('#ab-name').fill('書きかけを残す');
      await page.locator('#ab-cancel').click();
      await page.locator('#filter-next').click();
      await page.locator('#add-booking').click();
      assert.equal(await page.locator('#ab-date').inputValue(), '2026-10-08', '再度開いても入力済みの日付を変えない');
      assert.equal(await page.locator('#ab-name').inputValue(), '書きかけを残す');
      await page.locator('#ab-cancel').click();
      await page.locator('#filter-date').fill('2026-10-08');
      const card = page.locator(`[data-code="${code}"]`);
      await card.locator('[data-note-summary]').click();
      await card.locator('[data-note-input]').fill('消してはいけないメモ');
      await page.locator('#filter-next').click();
      assert.equal(await page.locator('#filter-date').inputValue(), '2026-10-08');
      assert.equal(await card.locator('[data-note-input]').inputValue(), '消してはいけないメモ');
      await card.locator('[data-note-input]').fill('');
      await card.locator('[data-admin-change]').click();
      await page.locator('#filter-previous').click();
      assert.equal(await page.locator('#filter-date').inputValue(), '2026-10-08', '日時変更の編集中も表示日を保護');
      await card.locator('[data-change-close]').click();
      await page.locator('#filter-status').selectOption('cancelled');
      assert.match(await page.locator('#admin-rows').innerText(), /すべての日・状態に戻す/);
      await page.locator('#filter-reset').click();
      assert.equal(await page.locator('#filter-date').inputValue(), '');
      assert.equal(await page.locator('#filter-status').inputValue(), 'all');
      await page.locator('#reserve-view [data-view="calendar"]').click();
      assert.match(await page.locator('#reservation-filter-summary').innerText(), /7日間/);
    });
  });

  test(`名簿検索の解除・入力保護・画面幅 ${design || '従来版'}`, async () => {
    await withAdmin(design, async (page, _bookingCode, viewportPage) => {
      await page.locator('#admin-tabs [data-pane="customers"]').click();
      await page.locator('#customer-search').fill('見つからない名前');
      assert.match(await page.locator('#customer-count').innerText(), /0件を表示/);
      await page.locator('#clear-customer-search').click();
      assert.equal(await page.locator('#customer-search').inputValue(), '');
      assert.equal(await page.locator('.customer-record').count(), 1);
      assert.equal(await page.locator('#customer-search').evaluate(element => element === document.activeElement), true);
      await page.locator('#customer-search').fill('試験客');
      await page.locator('[data-customer-history]').click();
      await page.locator('#customer-rows [data-note-summary]').click();
      await page.locator('#customer-rows [data-note-input]').fill('検索解除でも消さない');
      await page.locator('#clear-customer-search').click();
      assert.equal(await page.locator('#customer-search').inputValue(), '試験客');
      assert.equal(await page.locator('#customer-rows [data-note-input]').inputValue(), '検索解除でも消さない');
      await page.locator('#customer-rows [data-note-input]').fill('');
      await page.locator('#admin-tabs [data-pane="reserve"]').click();
      for (const width of [320, 390, 768, 1280]) {
        await viewportPage.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}pxで横はみ出しなし`);
        const action = await page.locator('#add-booking').boundingBox();
        assert.ok(action.height >= 44, '主要操作は指で押せる大きさ');
        if (design) {
          const workspace = await page.locator('.admin-pane[data-pane="reserve"]').boundingBox();
          const stats = await page.locator('#stats').boundingBox();
          assert.ok(stats.y >= workspace.y + workspace.height, '集計より予約の操作を先に表示する');
        }
      }
    });
  });
}
