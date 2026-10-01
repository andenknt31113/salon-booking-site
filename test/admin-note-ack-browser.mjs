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

for (const design of ['', '?design=a']) {
  for (const saved of [false, true]) {
    test(`${design || '従来版'}のメモ保存${saved ? '済み' : '未反映'}で返事が不明でも、下書きを消さず照会できる`, async () => {
      const server = http.createServer();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      server.on('request', createMockHandler({ port }));
      const base = `http://127.0.0.1:${port}`;
      const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify(payload) }).then(response => response.json());
      const browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
        process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
      const writes = [];
      const dialogs = [];
      const errors = [];
      try {
        const booking = await post({ type: 'adminAdd', password, force: true, date: visitDate,
          time: '10:00', minutes: 60, price: 4000, name: 'メモ結果確認試験', tel: '00000000000' });
        assert.equal(booking.ok, true);
        await context.route('**/*', async route => {
          const request = route.request();
          if (new URL(request.url()).origin !== base) return route.abort();
          if (request.url() === base + '/exec' && request.method() === 'POST') {
            const payload = JSON.parse(request.postData());
            if (payload.type === 'adminNote') {
              writes.push(payload);
              if (saved) assert.equal((await post(payload)).ok, true);
              return route.fulfill({ json: { ok: false, unknown: true,
                error: '施術メモの保存結果を確認できません。入力をコピーしてから最新のメモを確認してください。' } });
            }
          }
          return route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
        await page.goto(base + '/admin.html' + design);
        await page.locator('#passcode').fill(password);
        await page.locator('#remember-me').uncheck();
        await page.locator('#gate-btn').click();
        await page.locator('#dashboard:not([hidden])').waitFor();
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
      } finally {
        await context.close();
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
}
