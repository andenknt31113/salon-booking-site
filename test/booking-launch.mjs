import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createMockHandler } from './mock-gas.mjs';
import { withBookingState } from './booking-state-fixture.mjs';

const data = readFileSync(new URL('../assets/js/data.js', import.meta.url), 'utf8');
const readState = source => vm.runInNewContext(source + ';({ approved: SALON.bookingLaunchApproved, draft: SALON.draft })');
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let handler;
const server = http.createServer((request, response) => handler(request, response));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
handler = createMockHandler({ port: server.address().port });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('公開設定を試験内で上書きしなくても受付が開始される', async () => {
  const state = readState(data);
  assert.equal(state.approved, true);
  assert.equal(state.draft, false);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base + '/index.html');
    assert.equal((await page.locator('.hero a[href="reserve.html"]').innerText()).trim(), '空き時間を見る');
    await page.locator('.hero a[href="reserve.html"]').click();
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    await page.locator('#coupon-choices .selectable').first().click();
    await page.locator('[data-next="2"]').first().click();
    assert.equal(await page.locator('[data-panel="3"]').isVisible(), true);
    await page.locator('button[data-date][data-time]:not([disabled])').last().click();
    await page.locator('[data-next="4"]').first().click();
    await page.locator('#f-name').fill('受付試験');
    await page.locator('#f-kana').fill('ウケツケシケン');
    await page.locator('#f-tel').fill('09012345678');
    await page.locator('#f-email').fill('booking@example.test');
    await page.locator('label.radio-chip:has-text("初めて")').first().click();
    await page.locator('.checkbox-line > span').click();
    await page.locator('[data-next="5"]').first().click();
    await page.locator('#submit-reservation').click();
    await page.locator('#done-code').waitFor({ state: 'visible' });
    assert.match(await page.locator('#done-code').innerText(), /^LM-[A-Z0-9]{5}$/);
    await page.goto(base + '/mypage.html');
    await page.locator('.booking-card').waitFor();
    assert.equal(await page.locator('.booking-card').count(), 1);
    assert.equal(await page.locator('[data-change]').count(), 1);
    assert.equal(await page.locator('[data-cancel]').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

test('試験の受付状態は現在の公開設定に依存せず、両方向へ切り替えられる', () => {
  for (const initial of [{ approved: true, draft: false }, { approved: false, draft: true }]) {
    for (const approved of [true, false]) for (const draft of [true, false]) {
      const state = readState(withBookingState(withBookingState(data, initial), { approved, draft }));
      assert.equal(state.approved, approved);
      assert.equal(state.draft, draft);
    }
  }
  assert.throws(() => withBookingState('const SALON = {};'), /設定箇所は1つ/);
});

test('受付開始後も設定が欠けたGASと新しいシートは準備中から始まる', () => {
  const source = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
  const fallback = source.match(/const DRAFT_DEFAULT = (true|false);/)?.[0];
  const draftFunction = source.match(/function draftMode_\(settings\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fallback && draftFunction);
  for (const setting of [undefined, '', '不明', '出す', '出さない']) {
    const paused = vm.runInNewContext(fallback + '\n' + draftFunction + ';draftMode_()', {
      readSettings_: () => ({ '準備中の帯': setting }),
      SpreadsheetApp: { getActiveSpreadsheet() { return {}; } }
    });
    assert.equal(paused, setting !== '出さない', '明示的な受付許可がない場合は停止');
  }
  assert.match(source, /\['準備中の帯',\s*'出す'/);
});
