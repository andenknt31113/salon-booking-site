import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createMockHandler } from './mock-gas.mjs';
import { mockBookingState } from './booking-state-fixture.mjs';

const TEST_BROWSER = process.env.TEST_BROWSER || 'chromium';
const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const browserType = engines[TEST_BROWSER];
assert.ok(browserType && typeof browserType.launch === 'function', '試験用ブラウザを確認できる');
const browser = await browserType.launch(TEST_BROWSER === 'chromium' && process.env.CHROMIUM
  ? { executablePath: process.env.CHROMIUM } : {});
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

async function withBooking(run, { width = 390, paused = false, staffFee = 0 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const errors = [];
  const writes = [];
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await mockBookingState(context, { approved: !paused, draft: paused });
  await context.route('**/exec', async route => {
    const request = route.request().postDataJSON();
    if (!['menu', 'availability'].includes(request.type)) {
      writes.push(request.type);
      return route.abort();
    }
    if (request.type !== 'menu') return route.fallback();
    const response = await route.fetch();
    const catalog = await response.json();
    catalog.settings['準備中の帯'] = paused ? '出す' : '出さない';
    await route.fulfill({ response, json: catalog });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/reserve.html`);
    await page.waitForFunction(() => Catalog.loaded);
    if (!paused) await page.waitForFunction(() => Remote.loaded);
    if (staffFee) await page.evaluate(fee => {
      SALON.staff[0].nominationFee = fee;
      renderStaffLead();
      renderStaffChoices();
      renderStep();
    }, staffFee);
    await run(page);
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
    assert.deepEqual(writes, [], '選択・入力・確認の途中では台帳へ書き込まない');
  } finally { await context.close(); }
}

async function selectDate(page) {
  await page.locator('#coupon-choices .selectable').first().click();
  await page.locator('#step-cta button').click();
  assert.equal(await page.locator('[data-panel="3"]').isVisible(), true);
  await page.locator('#cal-body .slot:not(:disabled)').first().click();
}

test('おすすめの選択・解除・切替でボタンを作り直さず、キーボード操作を続けられる', () => withBooking(async page => {
  const first = page.locator('#coupon-choices .selectable').first();
  const second = page.locator('#coupon-choices .selectable').nth(1);
  await first.focus();
  const original = await first.elementHandle();
  await page.keyboard.press('Space');
  assert.equal(await original.evaluate(element => element.isConnected && element === document.activeElement), true);
  assert.equal(await first.getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Space');
  assert.equal(await first.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#step-cta button').isDisabled(), true);
  await second.focus();
  await page.keyboard.press('Enter');
  assert.equal(await second.evaluate(element => element === document.activeElement), true);
  await first.focus();
  await page.keyboard.press('Enter');
  assert.equal(await first.getAttribute('aria-pressed'), 'true');
  assert.equal(await second.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#coupon-choices [aria-pressed="true"]').count(), 1, 'おすすめは一つだけ');
}));

test('追加料金の担当確認でも操作位置を保ち、担当と日時の受付条件を変えない', () => withBooking(async page => {
  await page.locator('#coupon-choices .selectable').first().click();
  await page.locator('#step-cta button').click();
  const staff = page.locator('#staff-choices .selectable').first();
  await staff.focus();
  const original = await staff.elementHandle();
  await page.keyboard.press('Space');
  assert.equal(await original.evaluate(element => element.isConnected && element === document.activeElement), true);
  assert.equal(await staff.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#staff-choices [data-staff=""]').count(), 0, '一人サロンに指名なしを追加しない');
  assert.equal(await page.locator('#step-cta button').isEnabled(), true);
}, { staffFee: 500 }));

test('単品の分類は押下状態で案内し、同じ内容の再描画で分類・選択・フォーカスを保つ', () => withBooking(async page => {
  const filters = page.locator('#menu-cat-tabs');
  const category = filters.locator('button').nth(2);
  await category.focus();
  await page.keyboard.press('Space');
  assert.equal(await filters.getAttribute('role'), 'group');
  assert.equal(await filters.getAttribute('aria-label'), '単品メニューの分類');
  assert.equal(await category.getAttribute('aria-pressed'), 'true');
  assert.equal(await filters.locator('[aria-selected], [role="tab"]').count(), 0);
  const chosenCategory = await category.getAttribute('data-cat');
  const menu = page.locator('#menu-choices [data-menu]').first();
  await menu.click();
  const selectedId = await menu.getAttribute('data-menu');
  const listBefore = await page.locator('#menu-choices').innerText();
  await category.focus();
  await page.evaluate(() => initStep1());
  assert.equal(await category.evaluate(element => element === document.activeElement), true);
  assert.equal(await category.getAttribute('aria-pressed'), 'true');
  assert.equal(await category.getAttribute('data-cat'), chosenCategory);
  assert.equal(await page.locator('#menu-choices').innerText(), listBefore);
  assert.equal(await page.locator(`#menu-choices [data-menu="${selectedId}"]`).getAttribute('aria-pressed'), 'true');
  await filters.locator('button').first().click();
  assert.equal(await page.locator('#menu-choices [data-menu]').count(), await page.evaluate(() => allMenuItems().length));
}));

test('分類が掲載内容からなくなった場合はすべてへ戻して、操作位置を失わない', () => withBooking(async page => {
  const chosen = page.locator('#menu-cat-tabs button').nth(2);
  await chosen.focus();
  await page.keyboard.press('Space');
  const categoryId = await chosen.getAttribute('data-cat');
  await page.evaluate(category => {
    SALON.menuCategories = SALON.menuCategories.filter(item => item.id !== category);
    initStep1();
  }, categoryId);
  const all = page.locator('#menu-cat-tabs button').first();
  assert.equal(await all.getAttribute('aria-pressed'), 'true');
  assert.equal(await all.evaluate(element => element === document.activeElement), true);
  assert.equal(await page.locator('#menu-choices [data-menu]').count(), await page.evaluate(() => allMenuItems().length));
}));

for (const width of [320, 390, 768, 1280]) {
  test(`${width}px：メニューを選んだ場所から金額・所要時間を確認して次へ進める`, () => withBooking(async page => {
    const action = page.locator('#step-cta button');
    assert.equal(await action.isVisible(), true);
    assert.equal(await action.isDisabled(), true, '未選択は進めない');
    await page.locator('#coupon-choices .selectable').first().click();
    const expected = await page.evaluate(() => ({ total: totalText(), duration: formatDuration(totalMinutes()) }));
    assert.match(await page.locator('#step-cta').innerText(), /1件/);
    assert.ok((await page.locator('#step-cta').innerText()).includes(expected.total));
    assert.ok((await page.locator('#step-cta').innerText()).includes(expected.duration), '空き枠を決める所要も選択時に伝える');
    assert.equal(await action.isEnabled(), true);
    if (width > 700) {
      const container = await page.locator('main > .section > .container').boundingBox();
      const bounds = await action.boundingBox();
      const description = await page.locator('#step-cta .step-cta-info').boundingBox();
      assert.ok(Math.abs(description.x - container.x) <= 1, '固定操作も本文と左端を揃える');
      assert.ok(Math.abs(bounds.x + bounds.width - container.x - container.width) <= 1, '固定操作も本文と右端を揃える');
    }
    for (const position of [0, 900]) {
      await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' }), position);
      const bounds = await action.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844, '一覧の下まで動かさなくても操作できる');
      assert.ok(bounds.width >= 44 && bounds.height >= 44);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.TEST_ARTIFACT_DIR) {
      await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `reservation-choice-${width}.png`) });
    }
    await action.click();
    assert.equal(await page.locator('[data-panel="3"]').isVisible(), true);
    assert.equal(await page.locator('#h-step3').evaluate(element => element === document.activeElement), true);
  }, { width }));
}

test('手順の戻る操作をキーボードで使え、未入力の先の手順へ飛び越さない', () => withBooking(async page => {
  await selectDate(page);
  await page.locator('#step-cta button').click();
  const steps = page.locator('#steps');
  assert.equal(await steps.locator('button').count(), 5);
  assert.equal(await steps.locator('button:visible').count(), 4);
  assert.equal(await steps.locator('[aria-current="step"]').count(), 1);
  assert.equal(await steps.locator('[aria-current="step"]').getAttribute('data-step'), '4');
  assert.equal(await steps.locator('[data-step="5"] button').isDisabled(), true);
  const previous = steps.locator('[data-step="3"] button');
  await previous.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-panel="3"]').isVisible(), true);
  assert.equal(await page.locator('#h-step3').evaluate(element => element === document.activeElement), true);
  assert.equal(await page.locator('#cal-body [aria-pressed="true"]').count(), 1);
  assert.equal(await steps.locator('[aria-current="step"]').getAttribute('data-step'), '3');
  assert.equal(await steps.locator('[data-step="4"] button').isDisabled(), true, '手順から先には進めない');
  const original = await page.locator('#step-cta button').elementHandle();
  await page.locator('#step-cta button').focus();
  await page.evaluate(() => updateSummary());
  assert.equal(await original.evaluate(element => element.isConnected && element === document.activeElement), true, '同じ要約の更新で次へボタンを破棄しない');
}));

test('入力の必須チェックを保ち、確認画面には最終送信を一つだけ置く', () => withBooking(async page => {
  await selectDate(page);
  await page.locator('#step-cta button').click();
  await page.locator('#step-cta button').click();
  assert.equal(await page.locator('[data-panel="4"]').isVisible(), true);
  assert.equal(await page.locator('#f-name').getAttribute('aria-invalid'), 'true');
  await page.locator('#f-name').fill('試験 太郎');
  await page.locator('#f-kana').fill('シケン タロウ');
  await page.locator('#f-tel').fill('09012345678');
  await page.locator('#f-email').fill('test@example.com');
  await page.locator('[name="visit"][value="初めて"]').check();
  await page.locator('#f-agree').check();
  await page.locator('#step-cta button').click();
  assert.equal(await page.locator('[data-panel="5"]').isVisible(), true);
  assert.equal(await page.locator('#step-cta').isVisible(), false, '確認画面へ固定の送信ボタンを追加しない');
  assert.equal(await page.getByRole('button', { name: 'この内容で予約する', exact: true }).count(), 1);
  assert.match(await page.locator('#confirm-body').innerText(), /test@example.com/);
}));

test('受付停止中は固定の進む操作や新規入力を出さず、予約を開始しない', () => withBooking(async page => {
  assert.equal(await page.locator('#reserve-layout').isVisible(), false);
  assert.equal(await page.locator('#step-cta').isVisible(), false);
  assert.equal(await page.locator('#steps').isVisible(), false);
  assert.ok((await page.locator('#booking-paused-notice').innerText()).trim());
}, { paused: true }));

test('同じ内容の更新で選択数を読み上げ直さず、操作中の次へボタンも保つ', () => withBooking(async page => {
  await page.locator('#coupon-choices .selectable').first().click();
  const status = page.locator('#step-cta [role="status"]');
  assert.equal(await status.getAttribute('aria-atomic'), 'true');
  const original = await status.elementHandle();
  await page.evaluate(() => {
    window.selectionAnnouncements = 0;
    const status = document.querySelector('#step-cta [role="status"]');
    window.selectionObserver = new MutationObserver(records => { window.selectionAnnouncements += records.length; });
    window.selectionObserver.observe(status, { childList: true, subtree: true, characterData: true });
    updateSummary();
    updateSummary();
  });
  assert.equal(await original.evaluate(element => element.isConnected), true);
  assert.equal(await page.evaluate(() => window.selectionAnnouncements), 0);
  await page.locator('#menu-choices [data-menu]').first().click();
  assert.match(await status.innerText(), /2件/);
  assert.ok(await page.evaluate(() => window.selectionAnnouncements) > 0, '選択が変わった時だけ要約を更新する');
  await page.evaluate(() => window.selectionObserver.disconnect());
}));

for (const choice of [
  { host: '#coupon-choices', key: 'coupon', render: 'renderCouponChoices' },
  { host: '#menu-choices', key: 'menu', render: 'initStep1' },
  { host: '#staff-choices', key: 'staff', render: 'renderStaffChoices' }
]) {
  test(`${choice.key}：選択後に掲載内容を再描画しても同じ選択へフォーカスを戻す`, () => withBooking(async page => {
    if (choice.key === 'staff') {
      await page.locator('#coupon-choices .selectable').first().click();
      await page.locator('#step-cta button').click();
    }
    const button = page.locator(`${choice.host} [data-${choice.key}]`).first();
    await button.focus();
    await page.keyboard.press('Space');
    const selected = await button.getAttribute(`data-${choice.key}`);
    await page.evaluate(render => window[render](), choice.render);
    assert.equal(await button.getAttribute(`data-${choice.key}`), selected);
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    assert.equal(await button.evaluate(element => element === document.activeElement), true);
  }, { staffFee: choice.key === 'staff' ? 500 : 0 }));
}

for (const width of [320, 390, 768, 1280]) {
  test(`${width}px：動きを減らす設定では手順の移動が即時に完了し、見出しをヘッダーの下へ置く`, () => withBooking(async page => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await selectDate(page);
    await page.locator('#step-cta button').click();
    const heading = await page.locator('#h-step4').boundingBox();
    const steps = await page.locator('#steps').boundingBox();
    const header = await page.locator('.site-header').boundingBox();
    const action = await page.locator('#step-cta').boundingBox();
    assert.ok(steps.y >= header.y + header.height + 15, '手順を固定ヘッダーの下に隠さない');
    assert.ok(heading.y >= header.y + header.height && heading.y + heading.height <= action.y, '移動直後に入力見出しを読める');
    assert.equal(await page.locator('#h-step4').evaluate(element => element === document.activeElement), true);
    const scrollPosition = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.scrollY), scrollPosition, '操作後にスクロールアニメーションを続けない');
    if (process.env.TEST_ARTIFACT_DIR) await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `reservation-form-${width}.png`) });
  }, { width }));
}
