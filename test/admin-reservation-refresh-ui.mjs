import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { openGoogleAdmin } from './google-admin-fixture.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
after(() => browser.close());

async function withAdmin(design, run, allowedWrites = []) {
  let handler;
  const server = http.createServer((request, response) => handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  handler = createMockHandler({ port });
  const base = `http://127.0.0.1:${port}`;
  const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password }) })
    .then(response => response.json());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
  const errors = [];
  const requests = [];
  const control = { response: undefined, gate: undefined };
  const shell = await context.newPage();
  shell.on('pageerror', error => errors.push(error.message));
  shell.on('dialog', dialog => dialog.dismiss());
  try {
    const booking = await post({ type: 'adminAdd', password, force: true, date: '2026-10-08',
      time: '10:00', minutes: 60, name: '更新前の試験客', tel: '00000000000', price: 6900 });
    assert.equal(booking.ok, true);
    const initial = await post({ type: 'adminData', password });
    control.response = { ok: true, reservations: initial.reservations.map(row => ({ ...row, name: '更新後の試験客' })),
      closedDates: initial.closedDates };
    const admin = await openGoogleAdmin({ shell, base, design, request: async payload => {
      requests.push({ type: payload.type, reservationsOnly: payload.reservationsOnly === true,
        ...(Object.hasOwn(payload, 'ifNoneMatch') ? { ifNoneMatch: payload.ifNoneMatch } : {}) });
      if (payload.type === 'adminData' && payload.reservationsOnly === true) {
        if (control.gate) await control.gate;
        return structuredClone(control.response);
      }
      return post(payload);
    } });
    const page = admin.frame;
    await page.locator('#filter-date').fill('2026-10-08');
    assert.ok(requests.some(request => request.type === 'adminData' && !request.reservationsOnly), '初回は全管理データを取得する');
    requests.length = 0;
    await run({ page, booking, initial, control, requests });
    assert.ok(requests.every(request => request.type === 'adminData' || allowedWrites.includes(request.type)), '指定した架空操作以外は書き込まない');
    assert.deepEqual(errors, []);
    admin.assertIsolated();
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const design of ['', '?design=a']) {
  test(`予定を再読込している間に保存した休業日を巻き戻さない ${design || '従来版'}`, async () => {
    await withAdmin(design, async ({ page, control, requests }) => {
      let finishRead;
      control.gate = new Promise(resolve => { finishRead = resolve; });
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(() => document.querySelector('#refresh-reservations').disabled);
      await page.locator('#admin-tabs [data-pane="closed"]').click();
      await page.locator('[data-add="closed"]').click();
      const row = page.locator('#closed-rows .booking-card').last();
      await row.locator('[data-col="休業日"]').fill('2026-10-10');
      await page.locator('[data-save="closed"]').click();
      await page.waitForFunction(() => !document.querySelector('[data-save="closed"]').disabled);
      assert.match(await page.locator('#save-ok').innerText(), /休業日を保存しました/);
      const saved = await page.evaluate(() => JSON.stringify({ reservations: adminData.reservations, closedDates: adminData.closedDates }));
      assert.ok(JSON.parse(saved).closedDates.some(closed => closed.休業日 === '2026-10-10'));
      finishRead();
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.equal(await page.evaluate(() => JSON.stringify({ reservations: adminData.reservations, closedDates: adminData.closedDates })), saved);
      assert.match(await page.locator('#reservation-freshness').innerText(), /更新を保留/);
      assert.equal(requests.filter(request => request.type === 'adminSave').length, 1);
    }, ['adminSave']);
  });

  test(`予定だけを更新し、電話予約の入力と編集データを保持 ${design || '従来版'}`, async () => {
    await withAdmin(design, async ({ page, booking, requests }) => {
      const before = await page.evaluate(() => JSON.stringify({ edits, stamps: adminData.stamps, menus: adminData.menus }));
      await page.locator('#add-booking').click();
      await page.locator('#ab-name').fill('電話受付の書きかけ');
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.deepEqual(requests, [{ type: 'adminData', reservationsOnly: true, ifNoneMatch: '' }]);
      assert.match(await page.locator(`[data-code="${booking.code}"]`).innerText(), /更新後の試験客/);
      assert.equal(await page.locator('#ab-name').inputValue(), '電話受付の書きかけ');
      assert.equal(await page.evaluate(() => JSON.stringify({ edits, stamps: adminData.stamps, menus: adminData.menus })), before);
    });
  });

  test(`壊れた応答と通信中の施術メモ入力で予定を消さない ${design || '従来版'}`, async () => {
    await withAdmin(design, async ({ page, booking, control, requests }) => {
      const card = page.locator(`[data-code="${booking.code}"]`);
      control.response = { ok: true };
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.match(await page.locator('#reservation-freshness').innerText(), /取得できません/);
      assert.match(await card.innerText(), /更新前の試験客/);
      control.response = { ok: true, reservations: [], closedDates: [] };
      let release;
      control.gate = new Promise(resolve => { release = resolve; });
      await card.locator('[data-note-summary]').click();
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(() => document.querySelector('#refresh-reservations').disabled);
      await card.locator('[data-note-input]').fill('取得中にも消さないメモ');
      release();
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.match(await page.locator('#reservation-freshness').innerText(), /更新を保留/);
      assert.equal(await card.locator('[data-note-input]').inputValue(), '取得中にも消さないメモ');
      const requested = requests.length;
      await page.locator('#refresh-reservations').click();
      assert.equal(requests.length, requested, '書きかけがある間は追加取得しない');
      assert.match(await page.locator('#reservation-freshness').innerText(), /編集中/);
    });
  });

  test(`変更なし応答でも全履歴・休業・電話入力を保持する ${design || '従来版'}`, async () => {
    await withAdmin(design, async ({ page, booking, control, requests }) => {
      const version = 'a'.repeat(64);
      control.response.refreshVersion = version;
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.equal(await page.evaluate(() => adminData.refreshVersion), version);
      await page.locator('#add-booking').click();
      await page.locator('#ab-name').fill('電話受付の書きかけ');
      const before = await page.evaluate(() => JSON.stringify({ adminData, edits }));
      control.response = { ok: true, unchanged: true, refreshVersion: version };
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.deepEqual(requests, [{ type: 'adminData', reservationsOnly: true, ifNoneMatch: '' },
        { type: 'adminData', reservationsOnly: true, ifNoneMatch: version }]);
      assert.equal(await page.evaluate(() => JSON.stringify({ adminData, edits })), before);
      assert.match(await page.locator(`[data-code="${booking.code}"]`).innerText(), /更新後の試験客/);
      assert.equal(await page.locator('#ab-name').inputValue(), '電話受付の書きかけ');
      assert.match(await page.locator('#reservation-freshness').innerText(), /最終読込/);
    });
  });

  test(`一致しない版の変更なし応答を成功扱いせず、予定を保持する ${design || '従来版'}`, async () => {
    await withAdmin(design, async ({ page, booking, control }) => {
      control.response.refreshVersion = 'a'.repeat(64);
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      const before = await page.evaluate(() => JSON.stringify(adminData));
      control.response = { ok: true, unchanged: true, refreshVersion: 'b'.repeat(64) };
      await page.locator('#refresh-reservations').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.equal(await page.evaluate(() => JSON.stringify(adminData)), before);
      assert.match(await page.locator(`[data-code="${booking.code}"]`).innerText(), /更新後の試験客/);
      assert.match(await page.locator('#reservation-freshness').innerText(), /取得できません/);
    });
  });
}
