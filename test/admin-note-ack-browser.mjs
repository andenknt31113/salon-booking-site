import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const DAY_MS = 24 * 60 * 60 * 1000;
const visitDate = new Date(Date.now() + 8 * DAY_MS).toISOString().slice(0, 10);

for (const design of ['', '&design=a']) {
  for (const [saved, responseKind] of [false, true].flatMap(saved =>
    ['unknown', 'missing-note', 'wrong-code', 'wrong-note'].map(responseKind => [saved, responseKind]))) {
    test(`Google管理bridge ${design || '従来版'}のメモ保存${saved ? '済み' : '未反映'}・${responseKind}でも、下書きを消さず照会できる`, async () => {
      const server = http.createServer();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      server.on('request', createMockHandler({ port }));
      const base = `http://127.0.0.1:${port}`;
      const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password }) })
        .then(response => response.json());
      const browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
        process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
      const context = await browser.newContext({ viewport: { width: 390, height: 844 },
        timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
      const writes = [];
      const dialogs = [];
      const errors = [];
      const direct = [];
      const external = [];
      const operations = [];
      try {
        const booking = await post({ type: 'adminAdd', password, force: true, date: visitDate,
          time: '10:00', minutes: 60, price: 4000, name: 'メモ結果確認試験', tel: '00000000000' });
        assert.equal(booking.ok, true);
        const shell = await context.newPage();
        shell.on('pageerror', error => errors.push(error.message));
        shell.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
        await shell.exposeFunction('fixtureAdminRequest', async payload => {
          assert.equal(Object.hasOwn(payload, 'password'), false, '管理画面から旧パスワードを送らない');
          assert.equal(Object.hasOwn(payload, 'token'), false, '管理画面から旧合鍵を送らない');
          operations.push(structuredClone(payload));
          if (payload.type === 'adminNote') {
            writes.push(structuredClone(payload));
            if (saved) assert.equal((await post(payload)).ok, true);
            const responses = {
              unknown: { ok: false, unknown: true },
              'missing-note': { ok: true, code: payload.code },
              'wrong-code': { ok: true, code: 'LM-OTHER', note: payload.note },
              'wrong-note': { ok: true, code: payload.code, note: '別のメモ' }
            };
            return responses[responseKind];
          }
          return post(payload);
        });
        await context.route('**/*', route => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== base) { external.push(request.method()); return route.abort(); }
          if (url.pathname === '/exec') { direct.push(request.method()); return route.abort(); }
          if (url.pathname === '/fixture-shell.html') {
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width">'
              + '<style>html,body{margin:0}iframe{display:block;width:100%;height:100vh;border:0}</style>'
              + '<script>window.authAdminRequest = payload => window.fixtureAdminRequest(payload);</script>'
              + `<iframe id="management" title="架空のGoogle管理" src="admin.html?google=1${design}"></iframe>` });
          }
          return route.continue();
        });
        await shell.goto(base + '/fixture-shell.html');
        await shell.frameLocator('#management').locator('#dashboard:not([hidden])').waitFor();
        const page = await (await shell.locator('#management').elementHandle()).contentFrame();
        assert.ok(page);
        assert.equal(await page.locator('#gate').isVisible(), false, '旧ログインを操作しない');
        assert.deepEqual(await page.evaluate(() => ({ embedded: window.googleAdminEmbedded,
          password: adminPw, token: adminToken })), { embedded: true, password: '', token: '' });
        assert.deepEqual(operations[0], { type: 'adminData', startupOnly: true, briefPast: true, deferMenus: true });
        await page.locator('#filter-date').fill(visitDate);
        const card = page.locator(`[data-code="${booking.code}"]`);
        await card.locator('[data-note-summary]').click();
        await card.locator('[data-note-input]').fill('結果照会まで消さない下書き');
        await card.locator('[data-note-save]').click();
        await page.waitForFunction(code => document.querySelector(`[data-code="${code}"] [data-note-status]`)
          ?.textContent.includes('保存結果を確認できません'), booking.code);
        assert.equal(await card.locator('[data-note-input]').inputValue(), '結果照会まで消さない下書き');
        assert.equal(await card.locator('[data-note-input]').evaluate(input => input.defaultValue), '');
        assert.equal(await card.locator('[data-note-save]').isDisabled(), false);
        assert.match(dialogs[0], /保存結果を確認できません/);
        assert.doesNotMatch(dialogs[0], /保存できませんでした/);
        assert.equal(writes.length, 1);
        assert.equal(writes[0].expectedNote, '');
        await page.locator('#refresh-reservations').click();
        assert.equal(await card.locator('[data-note-input]').inputValue(), '結果照会まで消さない下書き');
        assert.match(await page.locator('#reservation-freshness').innerText(), /未保存.*メモ|保存または/);
        const current = (await post({ type: 'adminData', password })).reservations.find(record => record.code === booking.code);
        assert.equal(current.note, saved ? '結果照会まで消さない下書き' : '');
        assert.equal(writes.length, 1, '読み取り確認でメモを自動再保存しない');
        assert.deepEqual(errors, []);
        assert.deepEqual(direct, [], '管理画面は台帳へ直接送信せず、Google管理bridgeを通す');
        assert.deepEqual(external, [], '実台帳を含む外部サービスへ接続しない');
      } finally {
        await context.close();
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
}
