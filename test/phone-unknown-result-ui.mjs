import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const DAY_MS = 24 * 60 * 60 * 1000;
const futureDate = () => new Date(Date.now() + 8 * DAY_MS).toISOString().slice(0, 10);

for (const design of ['', '?design=a']) {
  for (const requestError of ['予約台帳を確認できません。',
    '処理の結果を確認できません。予約や保存を繰り返さず、現在の結果を確認するか、店舗または制作担当者へ連絡してください。'])
  test(`${design || '従来版'}でエラーを電話受付の成功と表示せず、入力と同じ受付IDを保持する：${requestError}`, async () => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    server.on('request', createMockHandler({ port }));
    const base = `http://127.0.0.1:${port}`;
    const browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
      process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
    const additions = [];
    const errors = [];
    try {
      await context.route('**/*', route => {
        const request = route.request();
        if (new URL(request.url()).origin !== base) return route.abort();
        if (request.method() === 'POST' && request.url() === base + '/exec'
            && request.postDataJSON().type === 'adminAdd') {
          additions.push(request.postDataJSON());
          return route.fulfill({ json: { ok: false, error: requestError } });
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/admin.html' + design);
      await page.locator('#passcode').fill(password);
      await page.locator('#gate-btn').click();
      await page.locator('#dashboard:not([hidden])').waitFor();
      await page.locator('#add-booking').click();
      await page.locator('#ab-date').fill(futureDate());
      await page.locator('#ab-time').selectOption('10:00');
      await page.locator('#ab-name').fill('台帳障害の試験客');
      await page.locator('#ab-tel').fill('00000000000');
      await page.locator('#ab-minutes').fill('60');
      await page.locator('#ab-price').fill('4000');
      await page.locator('#ab-memo').fill('保持する電話受付の内容');
      const before = await page.evaluate(() => ({ reservations: structuredClone(adminData.reservations),
        fields: ['date', 'time', 'name', 'tel', 'minutes', 'price', 'memo'].map(key => document.querySelector('#ab-' + key).value) }));
      await page.locator('#ab-save').click();
      await page.waitForFunction(message => !phoneSubmitting
        && document.querySelector('#ab-error').textContent.includes(message), requestError);
      assert.equal(additions.length, 1);
      assert.equal(await page.locator('#add-result').isVisible(), false);
      assert.equal(await page.locator('#add-booking-form').isVisible(), true);
      assert.equal(await page.locator('#ab-name').isDisabled(), false);
      assert.equal(await page.locator('#ab-save').isDisabled(), false);
      assert.equal(await page.evaluate(() => phoneRequestId), additions[0].requestId);
      assert.deepEqual(await page.evaluate(() => ({ reservations: adminData.reservations,
        fields: ['date', 'time', 'name', 'tel', 'minutes', 'price', 'memo'].map(key => document.querySelector('#ab-' + key).value) })), before);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  for (const saved of [false, true]) {
    test(`${design || '従来版'}で店舗側の保存結果不明を保持し、${saved ? '保存済み' : '未保存'}を照会で確認する`, async () => {
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
      const additions = [];
      const checks = [];
      const errors = [];
      try {
        await context.route('**/*', async route => {
          const request = route.request();
          if (new URL(request.url()).origin !== base) return route.abort();
          if (request.method() === 'POST' && request.url() === base + '/exec') {
            const payload = JSON.parse(request.postData());
            if (payload.type === 'adminAdd') {
              additions.push(payload);
              if (saved) assert.equal((await post({ ...payload, force: true })).ok, true);
              return route.fulfill({ json: { ok: false, unknown: true,
                error: '電話予約の保存結果を確認できません。同じ電話受付の登録結果を確認してください。' } });
            }
            if (payload.type === 'adminAddStatus') checks.push(payload);
          }
          return route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(base + '/admin.html' + design);
        await page.locator('#passcode').fill(password);
        await page.locator('#gate-btn').click();
        await page.locator('#dashboard:not([hidden])').waitFor();
        await page.locator('#add-booking').click();
        await page.locator('#ab-date').fill(futureDate());
        await page.locator('#ab-time').selectOption('10:00');
        await page.locator('#ab-name').fill('結果不明の試験客');
        await page.locator('#ab-tel').fill('00000000000');
        await page.locator('#ab-minutes').fill('60');
        await page.locator('#ab-price').fill('4000');
        await page.locator('#ab-save').click();
        await page.waitForFunction(() => document.querySelector('#ab-error').textContent.includes('保存結果')
          && !phoneSubmitting);
        assert.equal(await page.locator('#ab-name').isDisabled(), true, '結果不明を確実な拒否と扱って入力を変えない');
        assert.match(await page.locator('#ab-save').innerText(), /同じ受付として再試行/);
        assert.equal(await page.locator('#add-result').isVisible(), false);
        assert.equal(additions.length, 1, '不明な応答を自動で再送しない');
        await page.locator('#ab-check').click();
        if (saved) {
          await page.locator('#add-result:not([hidden])').waitFor();
          assert.match(await page.locator('#add-result').innerText(), /前の電話受付の登録結果/);
          assert.equal(await page.locator('#add-booking-form').isVisible(), false);
        } else {
          await page.waitForFunction(() => document.querySelector('#ab-recovery').textContent.includes('まだ登録を確認できません')
            && !phoneSubmitting);
          assert.equal(await page.locator('#ab-name').isDisabled(), false);
          assert.equal(await page.locator('#ab-name').inputValue(), '結果不明の試験客');
        }
        assert.equal(checks.length, 1);
        assert.equal(checks[0].requestId, additions[0].requestId);
        assert.equal(additions.length, 1, '結果照会は予約を増やさない');
        assert.deepEqual(errors, []);
        const ledger = (await post({ type: 'adminData', password })).reservations;
        assert.equal(ledger.length, saved ? 1 : 0);
      } finally {
        await context.close();
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
}
