import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const PLAYWRIGHT = process.env.PLAYWRIGHT || 'playwright';
const PASSWORD = process.env.MOCK_ADMIN_PASSWORD;
const ARTIFACT_DIR = process.env.ADMIN_TEST_ARTIFACT_DIR;
const DAY_MS = 86400000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const FUTURE_DAYS = 14;
const futureDate = offset => new Date(Date.now() + JST_OFFSET_MS + (FUTURE_DAYS + offset) * DAY_MS).toISOString().slice(0, 10);
const DATE = futureDate(0);
const NEXT_DATE = futureDate(1);
const CLOSED_DATE = futureDate(2);
const TIMEOUT_MS = Number(process.env.ADMIN_TEST_TIMEOUT_MS || 10000);
const { chromium } = await import(PLAYWRIGHT);
assert.ok(PASSWORD, 'MOCK_ADMIN_PASSWORD が必要です');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
after(() => browser.close());
if (ARTIFACT_DIR) mkdirSync(ARTIFACT_DIR, { recursive: true });

async function withAdmin(design, run) {
  let handler;
  const server = http.createServer((request, response) => handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  handler = createMockHandler({ port });
  const base = `http://127.0.0.1:${port}`;
  const post = payload => fetch(base + '/exec', {
    method: 'POST', body: JSON.stringify({ ...payload, password: PASSWORD })
  }).then(response => response.json());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
  const errors = [];
  const externalRequests = [];
  const requests = [];
  const control = { notificationResponse: undefined, failNote: false,
    losePhoneResponse: false, loseChangeResponse: false };
  await context.route('**/*', async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== base) {
      externalRequests.push(new URL(request.url()).hostname);
      return route.abort();
    }
    if (request.url() === base + '/exec' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      requests.push({ type: payload.type, target: payload.target,
        notificationsOnly: payload.notificationsOnly === true,
        reservationsOnly: payload.reservationsOnly === true });
      if (payload.notificationsOnly && control.notificationResponse !== undefined) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(control.notificationResponse) });
      }
      if (payload.type === 'adminNote' && control.failNote) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: '架空の保存障害' }) });
      }
      if (payload.type === 'adminAdd' && control.losePhoneResponse) {
        control.losePhoneResponse = false;
        await route.fetch();
        return route.abort();
      }
      if (payload.type === 'adminChange' && control.loseChangeResponse) {
        control.loseChangeResponse = false;
        await route.fetch();
        return route.abort();
      }
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const seeded = await post({ type: 'adminAdd', force: true, date: DATE, time: '10:00',
      name: '架空の開店確認', tel: '00000000000', minutes: 60, price: 5000 });
    assert.equal(seeded.ok, true);
    await page.goto(base + '/admin.html' + design);
    await page.locator('#passcode').fill(PASSWORD);
    await page.locator('#remember-me').uncheck();
    await page.locator('#gate-btn').click();
    await page.locator('#dashboard:not([hidden])').waitFor();
    assert.equal(await page.locator('#notification-count').innerText(), '未読0件');
    await page.locator('#filter-date').fill(DATE);
    await page.locator('#filter-date').press('Tab');
    await run({ page, seeded, post, requests, control });
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
  } catch (error) {
    console.error('架空画面の診断', JSON.stringify(await page.evaluate(() => ({
      changeStatus: document.querySelector('[data-change-status]')?.textContent,
      freshness: document.querySelector('#reservation-freshness')?.textContent,
      phoneError: document.querySelector('#ab-error')?.textContent,
      change: typeof activeChange === 'undefined' ? null : activeChange
    }))));
    if (ARTIFACT_DIR) await page.screenshot({ path: resolve(ARTIFACT_DIR, `failure-${design ? 'a' : 'current'}.png`), fullPage: true });
    throw error;
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

async function fillPhone(page, name = '架空の電話受付') {
  await page.locator('#add-booking').click();
  await page.locator('#ab-date').fill(DATE);
  await page.locator('#ab-time').selectOption('12:00');
  await page.locator('#ab-name').fill(name);
  await page.locator('#ab-tel').fill('00000000001');
  await page.locator('#ab-menu').fill('試験用の手入力');
  await page.locator('#ab-minutes').fill('60');
  await page.locator('#ab-price').fill('5000');
}

async function assertNoOverflow(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, label);
}

for (const design of ['', '?design=a']) {
  const label = design ? 'A版' : '従来版';

  test(`開店から電話・変更取消・メモ・休業・通知の保存条件 ${label}`, async () => {
    await withAdmin(design, async ({ page, post, requests, control }) => {
      await fillPhone(page);
      const beforeInvalid = requests.filter(request => request.type === 'adminAdd').length;
      await page.locator('#ab-minutes').fill('0');
      await page.locator('#ab-save').click();
      assert.match(await page.locator('#ab-error').innerText(), /15〜480/);
      assert.equal(requests.filter(request => request.type === 'adminAdd').length, beforeInvalid);
      assert.equal(await page.locator('#ab-name').inputValue(), '架空の電話受付');
      await page.locator('#ab-minutes').fill('60');
      await page.locator('#ab-save').click();
      await page.locator('#add-result:not([hidden])').waitFor();
      assert.equal(requests.filter(request => request.type === 'adminAdd').length, beforeInvalid + 1);
      let ledger = await post({ type: 'adminData' });
      const phone = ledger.reservations.find(row => row.name === '架空の電話受付');
      assert.ok(phone);
      assert.equal(phone.date, DATE);
      assert.equal(phone.time, '12:00');
      assert.equal(phone.endTime, '13:00');
      const card = page.locator(`#admin-rows [data-code="${phone.code}"]`);
      await card.locator('[data-admin-change]').click();
      await card.locator('[data-change-save]').click();
      assert.match(await card.locator('[data-change-status]').innerText(), /別の日時/);
      assert.equal(requests.filter(request => request.type === 'adminChange').length, 0);
      await card.locator('[data-change-date]').fill(NEXT_DATE);
      await card.locator('[data-change-time]').selectOption('14:00');
      await card.locator('[data-change-save]').click();
      await page.locator('.admin-action-dialog [value="back"]').click();
      assert.equal(requests.filter(request => request.type === 'adminChange').length, 0);
      assert.equal(await card.locator('[data-change-date]').inputValue(), NEXT_DATE);
      await card.locator('[data-change-save]').click();
      await page.locator('.admin-action-dialog [value="confirm"]').click();
      await card.locator('[data-change-editor]').waitFor({ state: 'detached' });
      await page.waitForFunction(() => !document.querySelector('#refresh-reservations').disabled);
      assert.match(await card.innerText(), /14:00〜15:00/);
      ledger = await post({ type: 'adminData' });
      const changed = ledger.reservations.find(row => row.code === phone.code);
      assert.equal(changed.date, NEXT_DATE);
      assert.equal(changed.time, '14:00');
      assert.equal(changed.endTime, '15:00');
      assert.equal(changed.price, phone.price);
      assert.equal(requests.filter(request => request.type === 'adminChange').length, 1);
      await card.locator('[data-note-summary]').click();
      const note = card.locator('[data-note-input]');
      await note.fill('架空の保存失敗でも残すメモ');
      control.failNote = true;
      await card.locator('[data-note-save]').click();
      await page.waitForFunction(code => document.querySelector(`[data-code="${code}"] [data-note-status]`)?.textContent.includes('未保存'), phone.code);
      assert.equal(await note.inputValue(), '架空の保存失敗でも残すメモ');
      assert.equal(await note.isDisabled(), false);
      const notification = await post({ type: 'adminAdd', force: true, date: NEXT_DATE, time: '16:00',
        name: '架空の別画面通知', tel: '00000000002', minutes: 60 });
      assert.equal(notification.ok, true);
      await page.evaluate(() => AdminNotifications.check());
      await page.locator('#booking-notifications > summary').click();
      await page.locator(`[data-notification="${notification.code}"]`).click();
      assert.equal(await note.inputValue(), '架空の保存失敗でも残すメモ');
      assert.match(await page.locator('#notification-status').innerText(), /施術メモ/);
      control.failNote = false;
      await card.locator('[data-note-save]').click();
      await page.waitForFunction(code => document.querySelector(`[data-code="${code}"] [data-note-status]`)?.textContent.includes('保存しました'), phone.code);
      ledger = await post({ type: 'adminData' });
      assert.equal(ledger.reservations.find(row => row.code === phone.code).note, '架空の保存失敗でも残すメモ');
      await page.locator(`[data-notification="${notification.code}"]`).click();
      await page.locator(`#admin-rows [data-code="${notification.code}"].is-focus`).waitFor();
      await card.locator('[data-admin-cancel]').click();
      await page.locator('.admin-action-dialog [value="back"]').click();
      assert.equal(requests.filter(request => request.type === 'cancel').length, 0);
      await card.locator('[data-admin-cancel]').click();
      await page.locator('.admin-action-dialog [value="confirm"]').click();
      await page.waitForFunction(code => document.querySelector(`#admin-rows [data-code="${code}"]`)?.classList.contains('is-cancelled')
        && !document.querySelector('#refresh-reservations').disabled, phone.code);
      ledger = await post({ type: 'adminData' });
      assert.equal(ledger.reservations.find(row => row.code === phone.code).status, 'キャンセル');
      assert.equal(requests.filter(request => request.type === 'cancel').length, 1);
      await page.locator('#admin-tabs [data-pane="closed"]').click();
      await page.locator('[data-add="closed"]').click();
      const row = page.locator('#closed-rows .booking-card').last();
      await row.locator('[data-col="休業日"]').fill(CLOSED_DATE);
      await row.locator('[data-closed-mode][value="range"]').check();
      await row.locator('[data-col="開始"]').fill('14:00');
      await row.locator('[data-col="終了"]').fill('13:00');
      await page.locator('[data-save="closed"]').click();
      assert.match(await page.locator('[data-note="closed"]').innerText(), /開始時刻より後/);
      assert.equal(requests.filter(request => request.type === 'adminSave').length, 0);
      const closedDraft = await page.evaluate(() => JSON.stringify(edits.closed));
      await page.evaluate(() => AdminNotifications.check());
      assert.equal(await page.evaluate(() => JSON.stringify(edits.closed)), closedDraft);
      assert.equal(await row.locator('[data-col="開始"]').inputValue(), '14:00');
      assert.equal(await row.locator('[data-col="終了"]').inputValue(), '13:00');
      await row.locator('[data-col="終了"]').fill('16:00');
      await page.locator('[data-save="closed"]').click();
      await page.waitForFunction(() => !document.querySelector('[data-save="closed"]').disabled);
      ledger = await post({ type: 'adminData' });
      assert.ok(ledger.closedDates.some(closed => closed.休業日 === CLOSED_DATE && closed.開始 === '14:00' && closed.終了 === '16:00'));
      assert.equal(requests.filter(request => request.type === 'adminSave').length, 1);
      await row.locator('[data-closed-mode][value="allday"]').check();
      assert.equal(await row.locator('[data-col="開始"]').count(), 0);
      assert.equal(await row.locator('[data-col="終了"]').count(), 0);
      await page.locator('[data-save="closed"]').click();
      await page.waitForFunction(() => !document.querySelector('[data-save="closed"]').disabled);
      ledger = await post({ type: 'adminData' });
      assert.ok(ledger.closedDates.some(closed => closed.休業日 === CLOSED_DATE && closed.開始 === '' && closed.終了 === ''));
      assert.equal(requests.filter(request => request.type === 'adminSave').length, 2);
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await assertNoOverflow(page, `休業画面 ${width}px`);
        await page.locator('#admin-tabs [data-pane="reserve"]').click();
        await assertNoOverflow(page, `予約画面 ${width}px`);
        await page.locator('#admin-tabs [data-pane="closed"]').click();
      }
      if (ARTIFACT_DIR) await page.screenshot({ path: resolve(ARTIFACT_DIR, `workflow-${label}.png`), fullPage: true });
    });
  });

  test(`登録済みの電話受付は応答喪失後も一行で回復 ${label}`, async () => {
    await withAdmin(design, async ({ page, post, control }) => {
      await fillPhone(page, '架空の応答喪失');
      control.losePhoneResponse = true;
      await page.locator('#ab-save').click();
      await page.waitForFunction(() => !document.querySelector('#ab-save').disabled
        && document.querySelector('#ab-save').textContent.includes('再試行'));
      assert.equal(await page.locator('#ab-name').inputValue(), '架空の応答喪失');
      assert.equal(await page.locator('#ab-name').isDisabled(), true);
      await page.locator('#ab-check').click();
      await page.locator('#add-result:not([hidden])').waitFor();
      assert.match(await page.locator('#add-result').innerText(), /登録結果を確認/);
      const ledger = await post({ type: 'adminData' });
      assert.equal(ledger.reservations.filter(row => row.name === '架空の応答喪失').length, 1);
    });
  });

  test(`通知の壊れた成功値を停止扱いにして入力と比較元を守る ${label}`, async () => {
    await withAdmin(design, async ({ page, post, control, requests }) => {
      const added = await post({ type: 'adminAdd', force: true, date: DATE, time: '12:00',
        name: '架空の通知復旧', tel: '00000000003', minutes: 60 });
      assert.equal(added.ok, true);
      await page.evaluate(() => AdminNotifications.check());
      assert.equal(await page.locator('#notification-count').innerText(), '未読1件');
      const notices = await page.locator('#notification-list').textContent();
      await fillPhone(page, '架空の電話下書き');
      const before = await page.evaluate(() => JSON.stringify(adminData.reservations));
      control.notificationResponse = { ok: 'false', reservations: [] };
      await page.evaluate(() => AdminNotifications.check());
      assert.equal(await page.locator('#notification-health').isVisible(), true);
      assert.match(await page.locator('#notification-status').textContent(), /自動確認を停止/);
      assert.equal(await page.locator('#notification-list').textContent(), notices);
      assert.equal(await page.locator('#ab-name').inputValue(), '架空の電話下書き');
      assert.equal(await page.evaluate(() => JSON.stringify(adminData.reservations)), before);
      control.notificationResponse = undefined;
      await page.evaluate(() => AdminNotifications.check());
      assert.equal(await page.locator('#notification-health').isVisible(), false);
      assert.equal(await page.locator('#notification-count').innerText(), '未読1件');
      assert.equal(await page.locator('#notification-list').textContent(), notices);
      assert.equal(requests.filter(request => request.type === 'adminAdd').length, 0);
    });
  });

  test(`日時変更の応答喪失では再保存せず、通知も入力と未読を保持 ${label}`, async () => {
    await withAdmin(design, async ({ page, seeded, post, requests, control }) => {
      const card = page.locator(`#admin-rows [data-code="${seeded.code}"]`);
      await card.locator('[data-admin-change]').click();
      await card.locator('[data-change-date]').fill(NEXT_DATE);
      await card.locator('[data-change-time]').selectOption('12:00');
      control.loseChangeResponse = true;
      await card.locator('[data-change-save]').click();
      await page.locator('.admin-action-dialog [value="confirm"]').click();
      await card.locator('[data-change-check]:not([hidden])').waitFor();
      assert.equal(await card.locator('[data-change-save]').isDisabled(), true);
      assert.match(await card.locator('[data-change-status]').innerText(), /保存結果を確認できません/);
      assert.equal(await card.locator('[data-change-date]').inputValue(), NEXT_DATE);
      assert.equal(await card.locator('[data-change-time]').inputValue(), '12:00');
      await page.evaluate(() => AdminNotifications.check());
      assert.equal(await page.locator('#notification-count').innerText(), '未読1件');
      await page.locator('#booking-notifications > summary').click();
      const beforeRefresh = requests.filter(request => request.reservationsOnly).length;
      await page.locator(`[data-notification="${seeded.code}"]`).click();
      assert.equal(await page.locator('#notification-count').innerText(), '未読1件');
      assert.equal(await card.locator('[data-change-date]').inputValue(), NEXT_DATE);
      assert.equal(await card.locator('[data-change-time]').inputValue(), '12:00');
      assert.equal(requests.filter(request => request.reservationsOnly).length, beforeRefresh);
      await page.setViewportSize({ width: 320, height: 900 });
      await assertNoOverflow(page, '結果不明の日時変更と通知を開いた320px画面');
      await card.locator('[data-change-check]').click();
      await card.locator('[data-change-editor]').waitFor({ state: 'detached' });
      const ledger = await post({ type: 'adminData' });
      const changed = ledger.reservations.find(row => row.code === seeded.code);
      assert.equal(changed.date, NEXT_DATE);
      assert.equal(changed.time, '12:00');
      assert.equal(changed.endTime, '13:00');
      assert.match(await card.innerText(), /12:00〜13:00/);
      assert.equal(requests.filter(request => request.type === 'adminChange').length, 1);
      await page.locator(`[data-notification="${seeded.code}"]`).click();
      await page.waitForFunction(() => document.querySelector('#notification-count').textContent === '未読0件');
      assert.equal(await card.getAttribute('class'), 'booking-card is-focus');
    });
  });
}
