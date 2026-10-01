import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { withBookingState } from './booking-state-fixture.mjs';
import { createMockHandler } from './mock-gas.mjs';

const browsers = await import(process.env.PLAYWRIGHT || 'playwright');
const browserType = browsers[process.env.TEST_BROWSER || 'chromium'];
const TEST_WRITE_TIMEOUT_MS = 180;
const TEST_HELD_WRITE_TIMEOUT_MS = 5000;

async function fixture(run) {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.on('request', createMockHandler({ port }));
  const base = `http://127.0.0.1:${port}`;
  const browser = await browserType.launch(process.env.CHROMIUM
    ? { executablePath: process.env.CHROMIUM } : {});
  const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const errors = [];
  const notices = [];
  const writes = [];
  const reads = [];
  const releases = [];
  const control = { fail: '', saveFirst: false, holdAvailability: false, rejection: null, responseCode: '' };
  try {
    await fetch(`${base}/exec`, { method: 'POST', body: JSON.stringify({ type: 'reset' }) });
    await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
      ? route.continue() : route.abort());
    await context.route(/\/assets\/js\/data\.js(?:\?.*)?$/, async route => {
      const response = await route.fetch();
      const source = withBookingState(await response.text());
      assert.match(source, /writeTimeoutMs:\s*45000/);
      await route.fulfill({ response, body: source.replace(/writeTimeoutMs:\s*45000/,
        `writeTimeoutMs: ${TEST_WRITE_TIMEOUT_MS}`) });
    });
    await context.route(`${base}/exec`, async route => {
      const payload = JSON.parse(route.request().postData() || '{}');
      if (['menu', 'availability'].includes(payload.type)) reads.push(payload);
      if (payload.type === 'availability' && control.holdAvailability) {
        await new Promise(resolve => releases.push(resolve));
        await route.continue().catch(() => {});
        return;
      }
      if (!['reserve', 'change', 'cancel'].includes(payload.type)) {
        await route.continue();
        return;
      }
      writes.push(payload);
      if (control.rejection) {
        await route.fulfill({ json: control.rejection });
        return;
      }
      if (control.responseCode && payload.type === 'reserve') {
        const response = await route.fetch({ postData: JSON.stringify({ ...payload, code: control.responseCode }) });
        await route.fulfill({ response });
        return;
      }
      if (!control.fail) { await route.continue(); return; }
      if (control.saveFirst) assert.equal((await (await route.fetch()).json()).ok, true);
      if (control.fail === 'stall') {
        await new Promise(resolve => releases.push(resolve));
        await route.abort().catch(() => {});
      } else {
        await route.fulfill({ status: 503, contentType: 'text/html', body: '<p>応答なし</p>' });
      }
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { notices.push(dialog.message()); await dialog.accept(); });
    await run({ page, base, writes, reads, control, releases, notices });
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
  } finally {
    releases.forEach(resolve => resolve());
    await context.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function fillReservation(page, base) {
  await page.goto(`${base}/reserve.html`);
  await page.waitForFunction(() => typeof Catalog !== 'undefined' && typeof Remote !== 'undefined'
    && Catalog.loaded && Remote.loaded);
  await page.locator('#coupon-choices .selectable').first().click();
  await page.locator('[data-next="2"]').first().click();
  await page.locator('[data-next="3"]').first().click();
  await page.waitForFunction(() => document.querySelector('button[data-date][data-time]:not([disabled])'));
  const slot = await page.evaluate(() => {
    const earliest = new Date();
    earliest.setDate(earliest.getDate() + 3);
    const key = toKey(earliest);
    const button = [...document.querySelectorAll('button[data-date][data-time]:not([disabled])')]
      .find(candidate => candidate.dataset.date >= key);
    return button ? { date: button.dataset.date, time: button.dataset.time } : null;
  });
  assert.ok(slot, '変更・取消の受付期限に余裕がある日時を選ぶ');
  await page.locator(`button[data-date="${slot.date}"][data-time="${slot.time}"]`).click();
  await page.locator('[data-next="4"]').first().click();
  await page.fill('#f-name', '通信試験 太郎');
  await page.fill('#f-kana', 'ツウシンシケン');
  await page.fill('#f-tel', '09011112222');
  await page.fill('#f-email', 'transport@example.test');
  await page.locator('label.radio-chip:has-text("初めて")').first().click();
  await page.locator('.checkbox-line > span').click();
  await page.locator('[data-next="5"]').first().click();
}

async function assertUnconfirmed(page, base, code) {
  await page.goto(`${base}/mypage.html`);
  const card = page.locator('#upcoming-list .booking-card').filter({ hasText: code });
  assert.equal(await card.locator('.status-chip').textContent(), '受付未確認');
  assert.equal(await card.locator('[data-change], [data-cancel]').count(), 0,
    '結果不明のまま変更や取消を繰り返さない');
  await card.locator('[data-check-booking]').click();
  assert.equal(await page.inputValue('#lookup-code'), code, '同じ予約番号を照会へ渡す');
  assert.equal(await page.inputValue('#lookup-tel'), '09011112222', '電話番号を再入力させない');
  assert.equal(new URL(page.url()).search, '', '電話番号をURLへ出さない');
  await page.waitForFunction(() => !document.querySelector('#lookup-btn').disabled);
}

for (const failure of ['http', 'stall']) {
  for (const saveFirst of [false, true]) {
    test(`${failure}応答・台帳${saveFirst ? '保存済み' : '未保存'}でも結果不明を保持し、同じ番号で確認する`, async () => {
      await fixture(async ({ page, base, writes, control }) => {
        await fillReservation(page, base);
        Object.assign(control, { fail: failure, saveFirst });
        await page.locator('#submit-reservation').click();
        await page.waitForFunction(() => !submitting && state.step === 6);
        const code = await page.locator('#done-code').textContent();
        assert.equal(writes.length, 1, '時間切れや通信失敗で自動再送しない');
        assert.equal(writes[0].code, code);
        assert.match(await page.locator('#h-done').textContent(), /受付結果を確認できません/);
        assert.doesNotMatch(await page.locator('#done-warning').textContent(), /届いていません/);
        assert.equal(await page.locator('#add-to-calendar').isDisabled(), true,
          '未確認の日時を確定した予定として登録しない');
        assert.equal((await page.evaluate(() => Store.all()))[0].deliveryState, 'unknown');
        await assertUnconfirmed(page, base, code);
        if (saveFirst) {
          assert.match(await page.locator('#lookup-result .status-chip').textContent(), /予約確定/);
          assert.equal(await page.locator('#upcoming-list [data-change]').count(), 1);
          assert.equal((await page.evaluate(() => Store.all()))[0].deliveryState, 'confirmed');
        } else {
          assert.equal(await page.locator('#lookup-error').isVisible(), true);
          assert.equal(await page.locator('#upcoming-list .status-chip').textContent(), '受付未確認');
        }
        assert.equal(writes.length, 1, '照会で新しい予約を送らない');
      });
    });
  }
}

test('空席を二重に取り直してから送信せず、店舗の最終検査へ一度だけ進む', async () => {
  await fixture(async ({ page, base, writes, reads, control }) => {
    await fillReservation(page, base);
    const readsBefore = reads.length;
    control.holdAvailability = true;
    await page.locator('#submit-reservation').click();
    await page.waitForFunction(() => !submitting && state.step === 6, null, { timeout: 3000 });
    assert.equal(reads.length, readsBefore, '予約前に追加の空席取得を待たない');
    assert.match(await page.locator('#h-done').textContent(), /完了/);
    assert.equal(await page.locator('#add-to-calendar').isDisabled(), false);
    assert.equal(writes.length, 1);
    assert.equal((await page.evaluate(() => Store.all()))[0].deliveryState, 'confirmed');
  });
});

test('店舗で番号が振り直されても、仮控えを増やさず確定した番号へ置き換える', async () => {
  await fixture(async ({ page, base, writes, control }) => {
    await fillReservation(page, base);
    control.responseCode = 'LM-FINAL';
    await page.locator('#submit-reservation').click();
    await page.waitForFunction(() => !submitting && state.step === 6);
    assert.equal(await page.locator('#done-code').textContent(), control.responseCode);
    const records = await page.evaluate(() => Store.all());
    assert.equal(records.length, 1);
    assert.equal(records[0].code, control.responseCode);
    assert.equal(records[0].deliveryState, 'confirmed');
    assert.equal(records[0].changedAt, undefined);
    assert.equal(await page.evaluate(code => Store.find(code), writes[0].code), null);
  });
});

for (const saveFirst of [false, true]) {
  test(`送信中に画面を離れても、台帳${saveFirst ? '保存済み' : '未保存'}の受付結果を同じ番号で確認する`, async () => {
    await fixture(async ({ page, base, writes, control }) => {
      await fillReservation(page, base);
      Object.assign(control, { fail: 'stall', saveFirst });
      await page.evaluate(timeout => { SALON.bookingTransport.writeTimeoutMs = timeout; }, TEST_HELD_WRITE_TIMEOUT_MS);
      await page.locator('#submit-reservation').click();
      await page.waitForFunction(() => submitting && state.step === 5 && Store.all().length === 1,
        null, { timeout: 3000 });
      const pending = (await page.evaluate(() => Store.all()))[0];
      assert.equal(pending.deliveryState, 'unknown');
      assert.equal(pending.delivered, false);
      assert.match(await page.locator('#sending-note').textContent(), new RegExp(pending.code));
      await page.waitForFunction(() => document.querySelector('#submit-reservation').disabled);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].code, pending.code);
      await assertUnconfirmed(page, base, pending.code);
      if (saveFirst) {
        assert.match(await page.locator('#lookup-result .status-chip').textContent(), /予約確定/);
        assert.equal(await page.evaluate(() => Store.all()[0].deliveryState), 'confirmed');
      } else {
        assert.equal(await page.locator('#lookup-error').isVisible(), true);
        assert.equal(await page.evaluate(() => Store.all()[0].deliveryState), 'unknown');
      }
      assert.equal(writes.length, 1, '離れた画面から同じ予約を自動再送しない');
    });
  });
}

test('一部の控えが壊れても、正常な予約と照会の導線を表示する', async () => {
  await fixture(async ({ page, base, writes }) => {
    await fillReservation(page, base);
    const code = await page.evaluate(() => {
      const record = buildReservation();
      localStorage.setItem(STORE_KEY, JSON.stringify([record, null]));
      return record.code;
    });
    await page.goto(base + '/mypage.html');
    await page.locator('#store-warning:not([hidden])').waitFor();
    assert.match(await page.locator('#upcoming-list').textContent(), new RegExp(code));
    assert.equal(await page.locator('#upcoming-list .booking-card').count(), 1);
    assert.equal(await page.locator('#lookup-box').isVisible(), true);
    assert.equal(writes.length, 0);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(STORE_KEY)).length), 2,
      '表示するだけでは元の控えを削除しない');
  });
});

for (const raw of ['null', '{}', '[null]']) {
  test(`端末の控え${raw}が壊れていても送信で固まらず、番号の保存方法を伝える`, async () => {
    await fixture(async ({ page, base, writes }) => {
      await fillReservation(page, base);
      await page.evaluate(value => localStorage.setItem(STORE_KEY, value), raw);
      await page.locator('#submit-reservation').click();
      await page.waitForFunction(() => !submitting && state.step === 6, null, { timeout: 3000 });
      const code = await page.locator('#done-code').textContent();
      assert.equal(writes.length, 1);
      assert.equal(writes[0].code, code);
      assert.match(await page.locator('#h-done').textContent(), /完了/);
      assert.match(await page.locator('#done-follow').textContent(), /この端末に控えを保存できません/);
      assert.equal(await page.evaluate(() => Store.all()[0].deliveryState), 'confirmed');
      assert.equal(await page.evaluate(() => localStorage.getItem(STORE_KEY)), raw);
      await page.goto(base + '/mypage.html');
      await page.locator('#store-warning:not([hidden])').waitFor();
      assert.match(await page.locator('#upcoming-list').textContent(), /控えを確認できません/);
      await page.fill('#lookup-code', code);
      await page.fill('#lookup-tel', '09011112222');
      await page.locator('#lookup-btn').click();
      await page.waitForFunction(() => !document.querySelector('#lookup-btn').disabled);
      assert.match(await page.locator('#lookup-result .status-chip').textContent(), /予約確定/);
      assert.equal(writes.length, 1, '照会で予約を登録し直さない');
    });
  });
}

for (const flag of ['taken', 'closed', 'scheduleChanged', 'catalogChanged', 'draft', 'invalid', 'conflict', 'cancelled']) {
  test(`店舗の最終検査で${flag}を返されたら、完了や未確認の控えを作らない`, async () => {
    await fixture(async ({ page, base, writes, control, notices }) => {
      await fillReservation(page, base);
      control.rejection = { ok: false, [flag]: true, error: `最終検査：${flag}` };
      await page.locator('#submit-reservation').click();
      await page.waitForFunction(() => !submitting);
      assert.equal(writes.length, 1);
      assert.equal(await page.locator('[data-panel="6"]').isVisible(), false);
      assert.equal(await page.evaluate(() => Store.all().length), 0);
      assert.ok(notices.some(message => message.includes(`最終検査：${flag}`)));
      assert.equal(await page.locator('#submit-reservation').isDisabled(), false);
    });
  });
}

for (const fromLookup of [false, true]) {
  test(`${fromLookup ? '照会結果' : '端末の予約'}からの取消が保存後に応答を失っても、確認してから次の操作へ進む`, async () => {
    await fixture(async ({ page, base, writes, control }) => {
      await fillReservation(page, base);
      await page.locator('#submit-reservation').click();
      await page.waitForFunction(() => !submitting && state.step === 6);
      const code = await page.locator('#done-code').textContent();
      if (fromLookup) await page.evaluate(() => Store.save([]));
      await page.goto(`${base}/mypage.html`);
      if (fromLookup) {
        await page.fill('#lookup-code', code);
        await page.fill('#lookup-tel', '09011112222');
        await page.locator('#lookup-btn').click();
        await page.locator('[data-lookup-cancel]').waitFor();
      }
      Object.assign(control, { fail: 'http', saveFirst: true });
      await page.locator(fromLookup ? '[data-lookup-cancel]' : '[data-cancel]').click();
      await page.locator('dialog button[value="confirm"]').click();
      await page.waitForFunction(() => document.querySelector('#flash').textContent.includes('反映結果'));
      assert.equal(writes.filter(write => write.type === 'cancel').length, 1);
      assert.equal(await page.locator('[data-cancel], [data-lookup-cancel], [data-change]').count(), 0);
      await page.locator('[data-check-booking]').first().click();
      await page.waitForFunction(() => !document.querySelector('#lookup-btn').disabled);
      assert.equal(await page.locator('#lookup-result .status-chip').textContent(), 'キャンセル済み');
      assert.equal(writes.length, 2, '予約1回と取消1回だけで、照会は再送しない');
    });
  });
}

test('日時変更は保存後に返事を失っても変更完了と断言せず、元の控えを照会後にだけ更新する', async () => {
  await fixture(async ({ page, base, writes, control }) => {
    await fillReservation(page, base);
    await page.locator('#submit-reservation').click();
    await page.waitForFunction(() => !submitting && state.step === 6);
    const original = (await page.evaluate(() => Store.all()))[0];
    await page.goto(`${base}/mypage.html`);
    await page.locator('[data-change]').click();
    await page.waitForFunction(() => typeof Catalog !== 'undefined' && typeof Remote !== 'undefined'
      && typeof state !== 'undefined' && Catalog.loaded && Remote.loaded && state.step === 3);
    const slot = await page.evaluate(original => {
      const button = [...document.querySelectorAll('button[data-date][data-time]:not([disabled])')]
        .find(candidate => candidate.dataset.date > original.date);
      return button ? { date: button.dataset.date, time: button.dataset.time } : null;
    }, original);
    assert.ok(slot);
    await page.locator(`button[data-date="${slot.date}"][data-time="${slot.time}"]`).click();
    await page.locator('[data-next="4"]').first().click();
    Object.assign(control, { fail: 'http', saveFirst: true });
    await page.locator('#submit-reservation').click();
    await page.waitForFunction(() => !submitting && state.step === 6);
    assert.match(await page.locator('#h-done').textContent(), /受付結果を確認できません/);
    assert.equal(await page.locator('#done-code').textContent(), original.code);
    assert.equal(await page.locator('#add-to-calendar').isDisabled(), true);
    const unconfirmed = (await page.evaluate(() => Store.all()))[0];
    assert.equal(unconfirmed.date, original.date);
    assert.equal(unconfirmed.time, original.time);
    assert.equal(unconfirmed.deliveryState, 'unknown');
    await assertUnconfirmed(page, base, original.code);
    const confirmed = (await page.evaluate(() => Store.all()))[0];
    assert.equal(confirmed.date, slot.date);
    assert.equal(confirmed.time, slot.time);
    assert.equal(confirmed.deliveryState, 'confirmed');
    assert.equal(writes.filter(write => write.type === 'change').length, 1);
  });
});
