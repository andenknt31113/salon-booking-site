import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { mockBookingState } from './booking-state-fixture.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const engine = process.env.TEST_BROWSER || 'chromium';
const browser = await engines[engine].launch(
  engine === 'chromium' && process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let handler;
const server = http.createServer((request, response) => handler(request, response));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
handler = createMockHandler({ port: server.address().port });
const base = `http://127.0.0.1:${server.address().port}`;
const normal = { name: '架空の入力確認', kana: 'カクウノニュウリョクカクニン', tel: '00000000000',
  email: 'input-check@example.test', request: '' };
const cases = [
  ['name', 'あ'.repeat(61), 60], ['kana', 'ア'.repeat(61), 60],
  ['email', 'a'.repeat(108) + '@example.test', 120], ['request', 'あ'.repeat(1001), 1000]
];
after(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function withForm(run) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    timezoneId: 'Asia/Tokyo', locale: 'ja-JP', serviceWorkers: 'block' });
  const errors = [];
  const external = [];
  const writes = [];
  try {
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      external.push(route.request().method());
      return route.abort();
    });
    await mockBookingState(context);
    await context.route('**/exec', route => {
      const payload = route.request().postDataJSON();
      if (['menu', 'availability'].includes(payload.type)) return route.continue();
      writes.push(payload.type);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/reserve.html');
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    await page.locator('#coupon-choices .selectable').first().click();
    await page.locator('#step-cta button').click();
    await page.locator('#cal-next').click();
    await page.locator('#cal-body .slot:not(:disabled)').first().click();
    await page.locator('#step-cta button').click();
    for (const [field, value] of Object.entries(normal)) await page.locator('#f-' + field).fill(value);
    await page.locator('[name="visit"][value="初めて"]').check();
    await page.locator('#f-agree').check();
    await run(page);
    assert.deepEqual(writes, [], '確認・修正・復元だけでは予約を書き込まない');
    assert.deepEqual(external, [], '実台帳・Google・通知先へ接続しない');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

for (const [field, input, limit] of cases) {
  test(`${field}：長い入力を保持して案内し、直したら同じ日時・メニューで確認へ進む`, () => withForm(async page => {
    const chosen = await page.evaluate(() => ({ date: state.date, time: state.time, coupon: state.couponId }));
    await page.locator('#f-' + field).fill(input);
    await page.locator('#step-cta button').click();
    assert.equal(await page.evaluate(() => state.step), 4);
    assert.equal(await page.locator('#f-' + field).inputValue(), input);
    assert.equal(await page.locator('#f-' + field).getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#f-' + field).getAttribute('aria-describedby'), 'f-' + field + '-error');
    assert.equal(await page.locator('#f-' + field + '-error').isVisible(), true);
    assert.match(await page.locator('#f-' + field + '-error').innerText(), new RegExp(String(limit)));
    assert.equal(await page.locator('#f-' + field).evaluate(element => element === document.activeElement), true);
    await page.waitForFunction(({ field, input }) => JSON.parse(sessionStorage.getItem(DRAFT_KEY)).customer[field] === input,
      { field, input });
    await page.reload();
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    assert.equal(await page.locator('#f-' + field).inputValue(), input, '再読込でも入力を切り詰めない');
    assert.deepEqual(await page.evaluate(() => ({ date: state.date, time: state.time, coupon: state.couponId })), chosen);
    await page.locator('#f-' + field).fill(normal[field]);
    await page.locator('#step-cta button').click();
    assert.equal(await page.evaluate(() => state.step), 5);
    assert.equal(await page.locator('#f-' + field).getAttribute('aria-invalid'), 'false');
    assert.deepEqual(await page.evaluate(() => ({ date: state.date, time: state.time, coupon: state.couponId })), chosen);
  }));
}

test('覚えたプロフィールの長い名前も隠れたまま通さず、入力欄を開いて原文を残す', () => withForm(async page => {
  const input = 'あ'.repeat(61);
  await page.locator('#f-name').fill(input);
  await page.evaluate(() => showProfileCard(readForm()));
  assert.equal(await page.locator('[data-field="name"]').isVisible(), false);
  await page.locator('#step-cta button').click();
  assert.equal(await page.evaluate(() => state.step), 4);
  assert.equal(await page.locator('[data-field="name"]').isVisible(), true);
  assert.equal(await page.locator('#saved-profile').isVisible(), false);
  assert.equal(await page.locator('#f-name').inputValue(), input);
  assert.equal(await page.locator('#f-name').getAttribute('aria-invalid'), 'true');
}));

test('上限ちょうどは確認へ進み、確認の復元後に長くなっても送信前に入力へ戻す', () => withForm(async page => {
  const values = { name: 'あ'.repeat(60), kana: 'ア'.repeat(60),
    email: 'a'.repeat(107) + '@example.test', request: 'あ'.repeat(1000) };
  for (const [field, input] of Object.entries(values)) await page.locator('#f-' + field).fill(input);
  await page.locator('#step-cta button').click();
  assert.equal(await page.evaluate(() => state.step), 5);
  for (const input of Object.values(values)) assert.ok((await page.locator('#confirm-body').innerText()).includes(input));
  await page.evaluate(() => { state.customer.request += '超'; saveDraft(); });
  await page.reload();
  await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
  assert.equal(await page.evaluate(() => state.step), 5);
  await page.locator('#submit-reservation').click();
  assert.equal(await page.evaluate(() => state.step), 4);
  assert.equal(await page.locator('#f-request').inputValue(), values.request + '超');
  assert.equal(await page.locator('#f-request').evaluate(element => element === document.activeElement), true);
  assert.equal(await page.evaluate(() => submitting), false);
  assert.equal(await page.locator('#sending-note').isVisible(), false);
}));
