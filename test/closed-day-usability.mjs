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
const CLOSED_DATE = '2026-10-10';
const RANGE_DATE = '2026-10-12';
const FREE_DATE = '2026-10-13';
const BUSY_DATE = '2026-10-15';

async function withClosedDays(design, run) {
  let handler;
  const server = http.createServer((request, response) => handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  handler = createMockHandler({ port: server.address().port });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = payload => fetch(base + '/exec', { method: 'POST',
    body: JSON.stringify({ ...payload, password }) }).then(response => response.json());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
  const shell = await context.newPage();
  const errors = [];
  const writes = [];
  shell.on('pageerror', error => errors.push(error.message));
  shell.on('dialog', dialog => dialog.dismiss());
  try {
    const initial = await post({ type: 'adminData' });
    assert.equal(initial.ok, true);
    assert.equal((await post({ type: 'adminSave', target: 'closed', stamp: initial.stamps.closed, rows: [
      { '休業日': CLOSED_DATE, '開始': '', '終了': '', 'メモ': '終日休みの試験' },
      { '休業日': RANGE_DATE, '開始': '14:00', '終了': '16:00', 'メモ': '時間帯の試験' }
    ] })).ok, true);
    assert.equal((await post({ type: 'adminAdd', force: true, date: BUSY_DATE,
      time: '10:00', minutes: 60, name: '試験のお客様', tel: '00000000000', price: 4000 })).ok, true);
    await shell.clock.setFixedTime(new Date('2026-10-08T10:00:00+09:00'));
    const admin = await openGoogleAdmin({ shell, base, design, request: payload => {
      if (payload.type !== 'adminData') writes.push(structuredClone(payload));
      return post(payload);
    } });
    const page = admin.frame;
    await page.locator('#admin-tabs [data-pane="closed"]').click();
    await run(page, writes, post, shell);
    assert.ok(admin.operations.every(operation => operation.type === 'adminData'
      || operation.type === 'adminSave' && operation.target === 'closed'), '休業設定以外を保存・取消しない');
    admin.assertIsolated();
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const design of ['', '?design=a']) {
  const label = design ? 'A案' : '従来版';

  test(`${label}：休みを入り切りしても操作位置を失わず、次の日へ進める`, () => withClosedDays(design, async (page, writes) => {
    const day = page.locator(`[data-ccal="${FREE_DATE}"]`);
    await day.focus();
    await day.press('Enter');
    assert.equal(await day.getAttribute('aria-pressed'), 'true');
    assert.equal(await day.evaluate(element => element === document.activeElement), true);
    await day.press('Enter');
    assert.equal(await day.getAttribute('aria-pressed'), 'false');
    assert.equal(await day.evaluate(element => element === document.activeElement), true);
    await day.press('Tab');
    assert.equal(await page.locator('[data-ccal="2026-10-14"]').evaluate(element => element === document.activeElement), true);
    assert.deepEqual(writes, [], '保存前は台帳へ送らない');
  }));

  test(`${label}：一覧で日付を直すと、カレンダーも即座に一致する`, () => withClosedDays(design, async (page, writes) => {
    const date = page.locator('#closed-rows [data-index="0"][data-col="休業日"]');
    await date.fill(FREE_DATE);
    assert.equal(await page.locator(`[data-ccal="${CLOSED_DATE}"]`).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator(`[data-ccal="${FREE_DATE}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await date.evaluate(element => element === document.activeElement), true);
    assert.match(await page.locator('[data-closed-summary="0"]').innerText(), /2026-10-13.*終日/);
    assert.deepEqual(writes, [], '日付入力だけでは保存しない');
  }));

  test(`${label}：休み方を切り替えてもラジオの操作を続けられる`, () => withClosedDays(design, async (page, writes) => {
    const range = page.locator('[data-closed-mode="0"][value="range"]');
    await range.check();
    assert.equal(await range.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator(`[data-ccal="${CLOSED_DATE}"].is-part`).count(), 1);
    await range.press('ArrowUp');
    const allDay = page.locator('[data-closed-mode="0"][value="allday"]');
    assert.equal(await allDay.isChecked(), true);
    assert.equal(await allDay.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('[data-target="closed"][data-index="0"][data-col="開始"]').count(), 0);
    assert.deepEqual(writes, [], '休み方の切替だけでは保存しない');
  }));

  test(`${label}：時間帯だけ休む日から、該当する入力欄へ移動する`, () => withClosedDays(design, async (page, writes) => {
    await page.locator(`[data-ccal="${RANGE_DATE}"]`).click();
    const date = page.locator('#closed-rows [data-index="1"][data-col="休業日"]');
    assert.equal(await date.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('[data-index="1"][data-col="開始"]').inputValue(), '14:00');
    assert.equal(await page.locator('[data-index="1"][data-col="終了"]').inputValue(), '16:00');
    assert.deepEqual(writes, [], '時間帯の休みを勝手に終日休みへ変えない');
  }));

  test(`${label}：休業日の追加後、すぐ日付を入力できる`, () => withClosedDays(design, async (page, writes) => {
    await page.locator('[data-add="closed"]').click();
    const date = page.locator('#closed-rows [data-index="2"][data-col="休業日"]');
    assert.equal(await date.evaluate(element => element === document.activeElement), true);
    assert.equal(await date.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= innerHeight;
    }), true, '入力欄が画面内に見える');
    assert.deepEqual(writes, [], '空の行を追加しても保存はしない');
  }));

  test(`${label}：削除後も次の行を操作でき、最後の行では追加へ戻る`, () => withClosedDays(design, async (page, writes, post, shell) => {
    shell.removeAllListeners('dialog');
    shell.on('dialog', dialog => dialog.accept());
    await page.locator('[data-remove="closed"][data-index="0"]').click();
    const next = page.locator('#closed-rows [data-index="0"][data-col="休業日"]');
    assert.equal(await next.inputValue(), RANGE_DATE);
    assert.equal(await next.evaluate(element => element === document.activeElement), true);
    await page.locator('[data-remove="closed"][data-index="0"]').click();
    assert.equal(await page.locator('[data-add="closed"]').evaluate(element => element === document.activeElement), true);
    assert.deepEqual(writes, [], '削除も保存するまで台帳へ送らない');
  }));

  test(`${label}：削除の確認で戻れば入力を残し、保存時の反映先も正しく伝える`, () => withClosedDays(design, async (page, writes, post, shell) => {
    const field = page.locator('[data-index="0"][data-col="メモ"]');
    await field.fill('消さない試験メモ');
    const confirmation = shell.waitForEvent('dialog');
    const remove = page.locator('[data-remove="closed"][data-index="0"]');
    await remove.click();
    const message = (await confirmation).message();
    assert.match(message, /休業日を保存.*予約受付に反映/);
    assert.match(message, /登録済みの予約は消えません/);
    assert.doesNotMatch(message, /別途更新/);
    assert.equal(await field.inputValue(), '消さない試験メモ');
    assert.equal(await page.locator('#closed-rows .booking-card').count(), 2);
    assert.equal(await remove.evaluate(element => element === document.activeElement), true);
    assert.deepEqual(writes, [], '確認を閉じても台帳を変えない');
  }));

  test(`${label}：月を移動しても入力を残し、戻ると編集した休みが表示される`, () => withClosedDays(design, async (page, writes) => {
    await page.locator(`[data-ccal="${FREE_DATE}"]`).click();
    await page.locator('[data-index="0"][data-col="メモ"]').fill('月を送っても残す試験メモ');
    await page.locator('#ccal-next').click();
    assert.equal(await page.locator('#ccal-title').innerText(), '2026年11月');
    assert.equal(await page.locator('#ccal-next').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('.ccal').getAttribute('aria-labelledby'), 'ccal-title');
    await page.locator('#ccal-prev').click();
    assert.equal(await page.locator(`[data-ccal="${FREE_DATE}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-index="0"][data-col="メモ"]').inputValue(), '月を送っても残す試験メモ');
    assert.deepEqual(writes, [], '月の移動では保存しない');
  }));

  test(`${label}：予約済みの日は件数を伝え、確認で戻れば変更しない`, () => withClosedDays(design, async (page, writes) => {
    const day = page.locator(`[data-ccal="${BUSY_DATE}"]`);
    assert.match(await day.getAttribute('aria-label'), /2026年10月15日.*予約1件/);
    await day.click();
    assert.equal(await day.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#closed-rows .booking-card').count(), 2);
    assert.equal(await page.locator('[data-ccal="2026-10-07"]').isDisabled(), true);
    assert.equal(await page.locator('#ccal-title').getAttribute('aria-live'), 'polite');
    assert.deepEqual(writes, [], '予約が入っている日の確認を省略しない');
  }));

  test(`${label}：予約済みの日を休みにしても件数を隠さず、予約は取り消さない`, () => withClosedDays(design, async (page, writes, post, shell) => {
    shell.removeAllListeners('dialog');
    shell.on('dialog', dialog => dialog.accept());
    const day = page.locator(`[data-ccal="${BUSY_DATE}"]`);
    await day.click();
    assert.equal(await day.getAttribute('aria-pressed'), 'true');
    assert.equal(await day.locator('.ccal-live').innerText(), '1件予約');
    assert.equal(await day.locator('.ccal-live').evaluate(element => getComputedStyle(element).color),
      await day.locator('.ccal-mark').evaluate(element => getComputedStyle(element).color), '休業日の件数も読みやすい色で表示する');
    assert.equal((await post({ type: 'adminData' })).reservations.length, 1);
    assert.deepEqual(writes, [], '休みにしても既存予約を取消・保存しない');
  }));

  test(`${label}：複数の日を直してもメモを残し、保存後に一覧と台帳が揃う`, () => withClosedDays(design, async (page, writes, post) => {
    await page.locator('[data-index="0"][data-col="メモ"]').fill('次の営業日に確認する試験メモ');
    await page.locator(`[data-ccal="${FREE_DATE}"]`).click();
    assert.equal(await page.locator('[data-index="0"][data-col="メモ"]').inputValue(), '次の営業日に確認する試験メモ');
    assert.deepEqual(writes, [], '入力はまだ未保存');
    await page.locator('[data-save="closed"]').click();
    await page.waitForFunction(() => document.querySelector('#save-ok').style.display !== 'none');
    assert.equal(writes.length, 1, '保存は1回だけ送る');
    assert.equal(writes[0].type, 'adminSave');
    assert.equal(writes[0].target, 'closed');
    assert.equal(writes[0].rows[0]['メモ'], '次の営業日に確認する試験メモ');
    assert.ok(writes[0].stamp, '競合確認の印を省略しない');
    const saved = await post({ type: 'adminData' });
    assert.deepEqual(saved.closedDates.map(row => row['休業日']), [CLOSED_DATE, RANGE_DATE, FREE_DATE]);
    assert.equal(saved.reservations.length, 1, '元の予約を変更しない');
  }));
}
