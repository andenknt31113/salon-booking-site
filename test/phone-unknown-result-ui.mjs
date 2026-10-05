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
const DAY_MS = 24 * 60 * 60 * 1000;
const futureDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 8 * DAY_MS));

async function withPhoneAdmin(design, respond, run) {
  const server = http.createServer();
  let context;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    server.on('request', createMockHandler({ port: server.address().port }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password }) })
      .then(response => response.json());
    context = await browser.newContext({ viewport: { width: design ? 390 : 320, height: 844 },
      timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
    const operations = [];
    const errors = [];
    const external = [];
    const direct = [];
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.exposeFunction('fixtureAdminRequest', async payload => {
      assert.equal(Object.hasOwn(payload, 'password'), false);
      assert.equal(Object.hasOwn(payload, 'token'), false);
      operations.push(structuredClone(payload));
      return respond(payload, post);
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
    await page.goto(base + '/fixture-shell.html');
    await page.frameLocator('#management').locator('#dashboard:not([hidden])').waitFor();
    const frame = await (await page.locator('#management').elementHandle()).contentFrame();
    assert.ok(frame);
    assert.equal(await frame.locator('#gate').isVisible(), false);
    assert.deepEqual(await frame.evaluate(() => ({ embedded: window.googleAdminEmbedded, password: adminPw, token: adminToken })),
      { embedded: true, password: '', token: '' });
    await frame.locator('#add-booking').click();
    await frame.locator('#ab-date').fill(futureDate());
    await frame.locator('#ab-time').selectOption('10:00');
    for (const [key, value] of Object.entries({ name: '架空の電話受付客', tel: '00000000000', minutes: '60',
      price: '4000', memo: '保持する電話受付の内容' })) await frame.locator('#ab-' + key).fill(value);
    await run({ frame, page, post, operations });
    assert.deepEqual(errors, [], '応答例外を含めJavaScriptエラーを残さない');
    assert.deepEqual(external, [], '実台帳・外部サービスには接続しない');
    assert.deepEqual(direct, [], '実管理bridgeから親への要求だけを使う');
  } finally {
    if (context) await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const snapshot = frame => frame.evaluate(() => ({ reservations: structuredClone(adminData.reservations),
  fields: ['date', 'time', 'name', 'tel', 'minutes', 'price', 'memo'].map(key => document.querySelector('#ab-' + key).value) }));

for (const design of ['', '&design=a']) {
  for (const requestError of ['予約台帳を確認できません。',
    '処理の結果を確認できません。予約や保存を繰り返さず、現在の結果を確認するか、店舗または制作担当者へ連絡してください。']) {
    test(`Google管理bridge ${design || '従来版'}で確定拒否を登録済みと表示しない：${requestError}`, async () => {
      await withPhoneAdmin(design, (payload, post) => payload.type === 'adminAdd'
        ? { ok: false, error: requestError } : post(payload), async ({ frame, operations }) => {
        const before = await snapshot(frame);
        await frame.locator('#ab-save').click();
        await frame.waitForFunction(message => !phoneSubmitting
          && document.querySelector('#ab-error').textContent.includes(message), requestError);
        const additions = operations.filter(operation => operation.type === 'adminAdd');
        assert.equal(additions.length, 1);
        assert.equal(await frame.locator('#add-result').isVisible(), false);
        assert.equal(await frame.locator('#add-booking-form').isVisible(), true);
        assert.equal(await frame.locator('#ab-name').isDisabled(), false);
        assert.equal(await frame.locator('#ab-save').isDisabled(), false);
        assert.equal(await frame.evaluate(() => phoneRequestId), additions[0].requestId);
        assert.deepEqual(await snapshot(frame), before);
      });
    });
  }

  for (const saved of [false, true]) {
    test(`Google管理bridge ${design || '従来版'}で結果不明を保持し、${saved ? '保存済み' : '未保存'}を手動照会する`, async () => {
      await withPhoneAdmin(design, async (payload, post) => {
        if (payload.type !== 'adminAdd') return post(payload);
        if (saved) assert.equal((await post({ ...payload, force: true })).ok, true);
        return { ok: false, unknown: true, error: '電話予約の保存結果を確認できません。同じ電話受付の登録結果を確認してください。' };
      }, async ({ frame, operations, post }) => {
        await frame.locator('#ab-save').click();
        await frame.waitForFunction(() => document.querySelector('#ab-error').textContent.includes('保存結果') && !phoneSubmitting);
        assert.equal(await frame.locator('#ab-name').isDisabled(), true);
        assert.match(await frame.locator('#ab-save').innerText(), /同じ受付として再試行/);
        assert.equal(await frame.locator('#add-result').isVisible(), false);
        await frame.locator('#ab-check').click();
        if (saved) {
          await frame.locator('#add-result:not([hidden])').waitFor();
          assert.match(await frame.locator('#add-result').innerText(), /前の電話受付の登録結果/);
          assert.equal(await frame.locator('#add-booking-form').isVisible(), false);
        } else {
          await frame.waitForFunction(() => document.querySelector('#ab-recovery').textContent.includes('まだ登録を確認できません') && !phoneSubmitting);
          assert.equal(await frame.locator('#ab-name').isDisabled(), false);
          assert.equal(await frame.locator('#ab-name').inputValue(), '架空の電話受付客');
        }
        const additions = operations.filter(operation => operation.type === 'adminAdd');
        const checks = operations.filter(operation => operation.type === 'adminAddStatus');
        assert.equal(additions.length, 1);
        assert.equal(checks.length, 1);
        assert.equal(checks[0].requestId, additions[0].requestId);
        assert.equal((await post({ type: 'adminData' })).reservations.length, saved ? 1 : 0);
      });
    });
  }

  for (const scenario of ['partial', 'contradictory', 'wrong-duration', 'missing-found', 'unknown-unwritten', 'exception']) {
    test(`Google管理bridge ${design || '従来版'} ${scenario}：不完全な受付・照会で入力を消さず同じIDで再確認`, async () => {
      let checks = 0;
      await withPhoneAdmin(design, async (payload, post) => {
        if (!['adminAdd', 'adminAddStatus'].includes(payload.type)) return post(payload);
        if (payload.type === 'adminAddStatus') checks++;
        const actual = scenario === 'unknown-unwritten' && payload.type === 'adminAdd'
          ? null : await post({ ...payload, force: true });
        if (actual) assert.equal(actual.ok, true);
        if (payload.type === 'adminAddStatus' && checks > 1) return actual;
        if (scenario === 'exception') throw new Error('架空の応答切断');
        if (scenario === 'unknown-unwritten') return { ok: true, found: false, requestId: payload.requestId, unknown: true };
        if (scenario === 'partial') return { ...actual, reservation: { code: actual.code } };
        if (scenario === 'wrong-duration') return { ...actual, reservation: { ...actual.reservation, endTime: '13:00' } };
        if (scenario === 'missing-found' && payload.type === 'adminAddStatus') {
          const result = { ...actual };
          delete result.found;
          return result;
        }
        return { ...actual, unknown: true };
      }, async ({ frame, operations, post }) => {
        const before = await snapshot(frame);
        await frame.locator('#ab-save').click();
        await frame.waitForFunction(() => !phoneSubmitting && phoneUncertain, null, { timeout: 3000 });
        assert.equal(await frame.locator('#add-result').isVisible(), false);
        const requestId = await frame.evaluate(() => phoneRequestId);
        await frame.locator('#ab-check').click();
        await frame.waitForFunction(() => !phoneSubmitting);
        assert.equal(await frame.locator('#add-result').isVisible(), false);
        assert.equal(await frame.evaluate(() => phoneUncertain), true);
        assert.equal(await frame.locator('#ab-name').isDisabled(), true);
        assert.equal(await frame.locator('#ab-check').isEnabled(), true);
        assert.equal(await frame.evaluate(() => localStorage.getItem(phoneRequestKey())), requestId);
        assert.deepEqual(await snapshot(frame), before);
        await frame.locator('#ab-check').click();
        if (scenario === 'unknown-unwritten') {
          await frame.waitForFunction(() => !phoneSubmitting && !phoneUncertain);
          assert.equal(await frame.locator('#ab-name').isEnabled(), true);
          assert.deepEqual(await snapshot(frame), before);
        } else {
          await frame.locator('#add-result:not([hidden])').waitFor();
          assert.match(await frame.locator('#add-result').innerText(), /前の電話受付の登録結果/);
          assert.equal(await frame.evaluate(() => localStorage.getItem(phoneRequestKey())), null);
        }
        assert.equal(operations.filter(operation => operation.type === 'adminAdd').length, 1);
        const reads = operations.filter(operation => operation.type === 'adminAddStatus');
        assert.equal(reads.length, 2);
        assert.ok(reads.every(operation => operation.requestId === requestId));
        assert.equal((await post({ type: 'adminData' })).reservations.length, scenario === 'unknown-unwritten' ? 0 : 1);
        assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      });
    });
  }

  test(`Google管理bridge ${design || '従来版'}を再読込しても、不完全な復旧応答で受付控えを捨てず登録を増やさない`, async () => {
    let checks = 0;
    await withPhoneAdmin(design, async (payload, post) => {
      const actual = await post({ ...payload, force: true });
      if (payload.type === 'adminAdd') return { ok: false, unknown: true, error: '保存結果は未確認です。' };
      if (payload.type === 'adminAddStatus' && ++checks === 1) {
        const result = { ...actual };
        delete result.found;
        return result;
      }
      return actual;
    }, async ({ frame, page, operations, post }) => {
      await frame.locator('#ab-save').click();
      await frame.waitForFunction(() => !phoneSubmitting && phoneUncertain);
      const requestId = await frame.evaluate(() => phoneRequestId);
      await page.reload();
      const restored = page.frameLocator('#management');
      await restored.locator('#dashboard:not([hidden])').waitFor();
      await restored.locator('#ab-check:enabled').waitFor();
      assert.equal(await restored.locator('#add-result').isVisible(), false);
      assert.equal(await restored.locator('#ab-name').isDisabled(), true);
      assert.equal(await restored.locator('#ab-save').isDisabled(), true, '元の入力がないため再登録せず照会する');
      assert.equal(await restored.locator('body').evaluate(() => localStorage.getItem(phoneRequestKey())), requestId);
      await restored.locator('#ab-check').click();
      await restored.locator('#add-result:not([hidden])').waitFor();
      assert.match(await restored.locator('#add-result').innerText(), /前の電話受付の登録結果/);
      assert.equal(operations.filter(operation => operation.type === 'adminAdd').length, 1);
      const reads = operations.filter(operation => operation.type === 'adminAddStatus');
      assert.equal(reads.length, 2);
      assert.ok(reads.every(operation => operation.requestId === requestId));
      assert.equal((await post({ type: 'adminData' })).reservations.length, 1);
    });
  });
}
