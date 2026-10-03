import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { createMockHandler } from './mock-gas.mjs';
import { mockBookingState } from './booking-state-fixture.mjs';

const MOBILE_WIDTHS = [320, 390, 430];
const MIN_TOUCH_SIZE = 44;
const MAX_FIRST_THREE_HEIGHT = 390;
const published = JSON.parse(vm.runInNewContext(await readFile(new URL('../assets/js/published-menus.js', import.meta.url), 'utf8')
  + '\nJSON.stringify(PUBLISHED_MENUS)'));
const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const engineName = process.env.TEST_BROWSER || 'chromium';
const browser = await engines[engineName].launch(engineName === 'chromium' && process.env.CHROMIUM
  ? { executablePath: process.env.CHROMIUM } : {});
const server = http.createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
server.on('request', createMockHandler({ port: server.address().port }));
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function withBooking(width, run) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const errors = [];
  const writes = [];
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await mockBookingState(context);
    await context.route('**/exec', async route => {
      const request = route.request().postDataJSON();
      if (!['menu', 'availability'].includes(request.type)) {
        writes.push(request.type);
        return route.abort();
      }
      if (request.type !== 'menu') return route.fallback();
      const response = await route.fetch();
      const catalog = await response.json();
      await route.fulfill({ response, json: { ...catalog, ...published } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/reserve.html`);
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    await run(page);
    assert.deepEqual(errors, [], 'JavaScript例外なし');
    assert.deepEqual(writes, [], '閲覧・選択で予約を書き込まない');
  } finally { await context.close(); }
}

async function assertReadableChoices(page, host) {
  const failures = await page.locator(`${host} .selectable`).evaluateAll((buttons, minimum) => buttons.flatMap(button => {
    const bounds = button.getBoundingClientRect();
    const fields = [...button.querySelectorAll('.selectable-title, .selectable-sub, .selectable-meta')];
    return [
      bounds.height >= minimum && bounds.width >= minimum ? null : '操作領域が小さい',
      ...fields.map(field => {
        const style = getComputedStyle(field);
        const rect = field.getBoundingClientRect();
        return style.display !== 'none' && !['hidden', 'clip'].includes(style.overflow)
          && field.scrollHeight <= field.clientHeight + 1 && field.scrollWidth <= field.clientWidth + 1
          && rect.left >= bounds.left && rect.right <= bounds.right + 1 ? null : '文字の隠れ・はみ出し';
      })
    ].filter(Boolean);
  }), MIN_TOUCH_SIZE);
  assert.deepEqual(failures, [], '名前・説明・料金・時間を隠さず読める');
}

for (const width of [...MOBILE_WIDTHS, 768, 1280]) {
  test(`${width}px：予約メニューを省略せずコンパクトに表示し、選択状態を保つ`, () => withBooking(width, async page => {
    const coupons = page.locator('#coupon-choices .selectable');
    assert.equal(await coupons.count(), published.coupons.length);
    for (const [index, coupon] of published.coupons.entries()) {
      assert.equal(await coupons.nth(index).locator('.selectable-title').textContent(), `［${coupon.badge}］${coupon.title}`);
      assert.equal(await coupons.nth(index).locator('.selectable-meta strong').textContent(),
        await page.evaluate(item => priceText(item), coupon));
      assert.ok((await coupons.nth(index).locator('.selectable-meta').innerText()).includes(
        await page.evaluate(minutes => `約${formatDuration(minutes)}`, coupon.minutes)));
    }
    await assertReadableChoices(page, '#coupon-choices');
    await assertReadableChoices(page, '#menu-choices');
    const metrics = await coupons.evaluateAll(buttons => {
      const first = buttons[0].getBoundingClientRect();
      const third = buttons[2].getBoundingClientRect();
      return { firstThreeHeight: third.bottom - first.top, firstHeight: first.height };
    });
    if (process.env.TEST_ARTIFACT_DIR) {
      await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
      await writeFile(join(process.env.TEST_ARTIFACT_DIR, `density-${width}.json`), JSON.stringify(metrics, null, 2));
      await coupons.first().evaluate(button => window.scrollTo({ top: button.getBoundingClientRect().top + scrollY - 12, behavior: 'instant' }));
      await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `density-${width}.png`) });
    }
    if (width === 390) assert.ok(metrics.firstThreeHeight <= MAX_FIRST_THREE_HEIGHT,
      `390pxでは先頭3件を${MAX_FIRST_THREE_HEIGHT}px以内に表示（実測${metrics.firstThreeHeight}px）`);
    await coupons.first().click();
    assert.equal(await coupons.first().getAttribute('aria-pressed'), 'true');
    await coupons.nth(1).click();
    assert.equal(await coupons.first().getAttribute('aria-pressed'), 'false');
    assert.equal(await coupons.nth(1).getAttribute('aria-pressed'), 'true');
    assert.ok((await page.locator('#step-cta').innerText()).includes('¥10,000'));
    await page.locator('#menu-choices [data-menu]').nth(1).click();
    await page.locator('#menu-choices [data-menu]').nth(2).click();
    assert.equal(await page.locator('#menu-choices [aria-pressed="true"]').count(), 2);
    assert.equal(await page.locator('#coupon-choices [aria-pressed="true"]').count(), 1, 'おすすめに単品を追加できる既存仕様を保つ');
    assert.ok((await page.locator('#step-cta').innerText()).includes('3件'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }));
}

for (const width of [390, 1280]) {
  test(`${width}px：名前と対象に強弱をつけ、未選択・選択済みを見分けて解除できる`, () => withBooking(width, async page => {
    const first = page.locator('#coupon-choices .selectable').first();
    const appearance = () => first.evaluate(button => {
      const style = selector => getComputedStyle(button.querySelector(selector));
      const indicator = getComputedStyle(button, '::after');
      const bounds = button.getBoundingClientRect();
      return { titleSize: parseFloat(style('.selectable-title').fontSize),
        badgeSize: parseFloat(style('.selectable-badge').fontSize),
        priceSize: parseFloat(style('.selectable-meta strong').fontSize),
        indicatorWidth: parseFloat(indicator.width), indicatorHeight: parseFloat(indicator.height),
        indicatorBorder: indicator.borderTopStyle, indicatorContent: indicator.content,
        indicatorBackground: indicator.backgroundColor, pressed: button.getAttribute('aria-pressed'),
        height: bounds.height };
    });
    assert.equal(await first.locator('.selectable-badge').textContent(), `［${published.coupons[0].badge}］`);
    const idle = await appearance();
    assert.equal(idle.titleSize, 15);
    assert.equal(idle.badgeSize, 12);
    assert.equal(idle.priceSize, 18);
    assert.equal(idle.indicatorBorder, 'solid');
    assert.ok(idle.indicatorWidth >= 16 && idle.indicatorHeight >= 16);
    assert.equal(idle.pressed, 'false');
    assert.ok(!idle.indicatorContent.includes('✓'));
    await first.click();
    const selected = await appearance();
    assert.equal(selected.pressed, 'true');
    assert.ok(selected.indicatorContent.includes('✓'));
    assert.notEqual(selected.indicatorBackground, idle.indicatorBackground);
    assert.equal(selected.height, idle.height, '選択してもカードの高さを変えない');
    await page.keyboard.press('Space');
    assert.equal((await appearance()).pressed, 'false');
    for (const selector of ['.selectable-sub', '.selectable-time']) {
      const sizes = await page.locator(`#menu-choices ${selector}`).evaluateAll(fields =>
        fields.map(field => parseFloat(getComputedStyle(field).fontSize)));
      assert.ok(sizes.length && sizes.every(size => size >= 13), '説明と時間は読みやすい大きさを保つ');
    }
    assert.ok(await page.locator('#f-name').evaluate(field => parseFloat(getComputedStyle(field).fontSize)) >= 16,
      '入力欄まで小さくしない');
  }));
}

test('320px・文字拡大：長い名前・説明・お見積りも切らず、キーボードで解除できる', () => withBooking(320, async page => {
  const title = '長いメニュー名を省略せず全文で比較できることを確認します'.repeat(3);
  const detail = '施術の条件と追加料金の説明を隠しません。'.repeat(5);
  await page.evaluate(({ title, detail }) => {
    SALON.coupons[0].title = title;
    SALON.coupons[0].detail = detail;
    SALON.coupons[0].price = 0;
    renderCouponChoices();
  }, { title, detail });
  await page.addStyleTag({ content: '#coupon-choices .selectable-title { font-size: 32px; } #coupon-choices .selectable-sub { font-size: 25px; }' });
  const first = page.locator('#coupon-choices .selectable').first();
  assert.equal(await first.locator('.selectable-title').textContent(), `［${published.coupons[0].badge}］${title}`);
  assert.equal(await first.locator('.selectable-sub').textContent(), detail);
  assert.equal(await first.locator('.is-quote').isVisible(), true);
  await assertReadableChoices(page, '#coupon-choices');
  await first.focus();
  await page.keyboard.press('Space');
  assert.equal(await first.getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Space');
  assert.equal(await first.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}));
