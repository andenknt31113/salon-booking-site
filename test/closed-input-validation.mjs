import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { openGoogleAdmin } from './google-admin-fixture.mjs';

const browsers = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const engine = process.env.TEST_BROWSER || 'chromium';
const browser = await browsers[engine].launch(engine === 'chromium' && process.env.CHROMIUM
  ? { executablePath: process.env.CHROMIUM } : {});
after(() => browser.close());
const DATE = '2026-10-10';

async function fixture(design, run) {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.on('request', createMockHandler({ port }));
  const base = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    timezoneId: 'Asia/Tokyo', locale: 'ja-JP', serviceWorkers: 'block' });
  const writes = [];
  const errors = [];
  const control = { initialRow: null, reject: false };
  try {
    const post = async payload => (await fetch(`${base}/exec`, {
      method: 'POST', body: JSON.stringify({ ...payload, password })
    })).json();
    const initial = await post({ type: 'adminData' });
    assert.equal(initial.ok, true);
    assert.equal((await post({ type: 'adminSave', target: 'closed', stamp: initial.stamps.closed, rows: [] })).ok, true,
      '試験用の既定休業日と新しく追加する行を混ぜない');
    const request = async payload => {
      if (payload.type === 'adminSave') {
        writes.push(structuredClone(payload));
        if (control.reject) {
          return { ok: false, invalidClosed: true, invalidRow: 0, invalidField: '終了',
            error: '受け口で終了時刻の不備を検出しました。' };
        }
      }
      const data = await post(payload);
      if (payload.type === 'adminData' && control.initialRow) {
        return { ...data, closedDates: [control.initialRow] };
      }
      return data;
    };
    const shell = await context.newPage();
    shell.on('pageerror', error => errors.push(error.message));
    shell.on('dialog', dialog => dialog.dismiss());
    await shell.clock.setFixedTime(new Date('2026-10-08T10:00:00+09:00'));
    let admin;
    const open = async () => {
      admin = await openGoogleAdmin({ shell, base, design, request });
      const page = admin.frame;
      await page.locator('#admin-tabs [data-pane="closed"]').click();
      return page;
    };
    await run({ open, control, writes });
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
  test(`${design || '従来版'}：逆転時刻を保存せず、時刻・メモを保って終了欄へ案内する`, async () => {
    await fixture(design, async ({ open, writes }) => {
      const page = await open();
      await page.locator('[data-add="closed"]').click();
      await page.locator('[data-col="休業日"][data-index="0"]').fill(DATE);
      await page.locator('[data-closed-mode="0"][value="range"]').check();
      await page.locator('[data-col="開始"][data-index="0"]').fill('14:00');
      const end = page.locator('[data-col="終了"][data-index="0"]');
      await end.fill('12:00');
      await page.locator('[data-col="メモ"][data-index="0"]').fill('残しておく用事');
      assert.match(await page.locator('[data-closed-summary="0"]').textContent(), /終了時刻.*開始時刻より後/);
      assert.doesNotMatch(await page.locator('[data-closed-summary="0"]').textContent(), /他の時間.*予約できます/);
      assert.match(await page.locator(`[data-ccal="${DATE}"]`).getAttribute('aria-label'), /入力要確認/);
      await page.locator('[data-save="closed"]').click();
      assert.deepEqual(writes, [], '不正な休業で保存APIへ送らない');
      assert.equal(await end.evaluate(element => element === document.activeElement), true);
      assert.equal(await end.getAttribute('aria-invalid'), 'true');
      assert.equal(await end.getAttribute('aria-describedby'), 'closed-summary-0');
      assert.equal(await end.inputValue(), '12:00');
      assert.equal(await page.locator('[data-col="メモ"][data-index="0"]').inputValue(), '残しておく用事');
      await end.fill('16:00');
      assert.equal(await end.getAttribute('aria-invalid'), null, '正しく修正した後だけエラーを解除する');
      assert.match(await page.locator('[data-closed-summary="0"]').textContent(), /14:00〜16:00.*だけ/);
      await page.locator('[data-save="closed"]').click();
      await page.waitForFunction(() => !pendingSaves.has('closed'));
      assert.equal(writes.length, 1);
      assert.equal(writes[0].rows[0]['終了'], '16:00');
    });
  });

  test(`${design || '従来版'}：日付なし・時刻片側なしを保存せず、終日指定なら時刻を両方消す`, async () => {
    await fixture(design, async ({ open, writes }) => {
      const page = await open();
      await page.locator('[data-add="closed"]').click();
      await page.locator('[data-save="closed"]').click();
      assert.deepEqual(writes, []);
      const date = page.locator('[data-col="休業日"][data-index="0"]');
      assert.equal(await date.getAttribute('aria-invalid'), 'true');
      assert.equal(await date.evaluate(element => element === document.activeElement), true);
      await date.fill(DATE);
      await page.locator('[data-closed-mode="0"][value="range"]').check();
      await page.locator('[data-col="終了"][data-index="0"]').fill('');
      assert.match(await page.locator('[data-closed-summary="0"]').textContent(), /終了時刻/);
      await page.locator('[data-save="closed"]').click();
      assert.deepEqual(writes, []);
      await page.locator('[data-closed-mode="0"][value="allday"]').check();
      assert.match(await page.locator('[data-closed-summary="0"]').textContent(), /終日お休み/);
      await page.locator('[data-save="closed"]').click();
      await page.waitForFunction(() => !pendingSaves.has('closed'));
      assert.equal(writes.length, 1);
      assert.equal(writes[0].rows[0]['開始'], '');
      assert.equal(writes[0].rows[0]['終了'], '');
    });
  });

  test(`${design || '従来版'}：過去に保存された壊れた休業も、入力を隠さず修正できる`, async () => {
    await fixture(design, async ({ open, control, writes }) => {
      control.initialRow = { 休業日: DATE, 開始: '14:00', 終了: '', メモ: '元の入力' };
      const page = await open();
      assert.equal(await page.locator('[data-closed-mode="0"][value="range"]').isChecked(), true);
      assert.equal(await page.locator('[data-col="開始"][data-index="0"]').inputValue(), '14:00');
      const end = page.locator('[data-col="終了"][data-index="0"]');
      assert.equal(await end.inputValue(), '');
      assert.match(await page.locator(`[data-ccal="${DATE}"]`).textContent(), /要確認/);
      await page.locator(`[data-ccal="${DATE}"]`).click();
      assert.equal(await page.locator('#closed-rows .booking-card').count(), 1,
        'カレンダーを押しただけで壊れた行を消さない');
      assert.deepEqual(writes, []);
      await end.fill('16:00');
      control.reject = true;
      await page.locator('[data-save="closed"]').click();
      await page.waitForFunction(() => !pendingSaves.has('closed'));
      assert.equal(await end.inputValue(), '16:00', '受け口の拒否でも入力を残す');
      assert.equal(await end.getAttribute('aria-invalid'), 'true');
      assert.equal(await end.evaluate(element => element === document.activeElement), true);
      assert.match(await page.locator('[data-closed-summary="0"]').textContent(), /受け口/);
    });
  });
}
