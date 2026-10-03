import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const CUSTOMER_COUNT = 125;
const PAGE_SIZE = 50;
const TEST_TIMEOUT_MS = 7000;
const records = Array.from({ length: CUSTOMER_COUNT }, (_unused, index) => {
  const suffix = String(index).padStart(4, '0');
  const row = { code: `LM-PAGE-${suffix}`, date: '2025-01-01', time: '10:00', endTime: '11:00',
    name: `架空のお客様${suffix}`, tel: `0000000${suffix}`, email: '', menu: '架空カット',
    price: 4000, staffName: '架空担当', status: '予約確定', note: `保存済みメモ${suffix}`, request: '' };
  return [row, { ...row, code: row.code + '-NEXT', date: '2099-01-01', note: '' }];
}).flat();
const seed = { ok: true, reservations: records, closedDates: [], styles: [], reviews: [],
  menus: [], coupons: [], settings: {},
  stamps: { closed: '0', menus: '0', coupons: '0', settings: '0', styles: '0', reviews: '0' } };

async function fixture(design, run) {
  let handler;
  const server = http.createServer((request, response) => handler(request, response));
  let browser;
  let context;
  const errors = [];
  const unexpected = [];
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    handler = createMockHandler({ port: server.address().port });
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo',
      serviceWorkers: 'block', acceptDownloads: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base || url.pathname === '/exec') {
        unexpected.push(url.pathname);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TEST_TIMEOUT_MS);
    page.on('pageerror', error => errors.push(error.message));
    const warnings = [];
    page.on('dialog', async dialog => { warnings.push(dialog.message()); await dialog.dismiss(); });
    await page.goto(base + '/admin.html' + design);
    assert.equal(await page.evaluate(async data => {
      window.fixtureRequests = [];
      adminPost = async payload => {
        window.fixtureRequests.push(payload);
        if (payload.type !== 'adminData') throw new Error('架空台帳でも書込はしない');
        return structuredClone(data);
      };
      return openDashboard();
    }, seed), true, '完全な架空応答で管理画面が開く');
    await page.locator('#admin-tabs [data-pane="customers"]').click();
    await run({ page, warnings, base });
    assert.deepEqual(await page.evaluate(() => window.fixtureRequests),
      [{ type: 'adminData', startupOnly: true, briefPast: true, deferMenus: true }], '名簿のページ操作で通信・書込を増やさない');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  } finally {
    await context?.close();
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const design of ['', '?design=a']) {
  test(`${design || '従来版'}の名簿をキーボードでページ移動し、検索は全件を対象にする`, async () => {
    await fixture(design, async ({ page }) => {
      assert.equal(await page.locator('.customer-record').count(), PAGE_SIZE);
      assert.match(await page.locator('#customer-count').innerText(), /検索結果 125件.*名簿 125件/);
      const next = page.locator('#customer-next');
      await next.focus();
      await next.press('Enter');
      assert.match(await page.locator('#customer-count').innerText(), /51〜100件/);
      assert.equal(await page.locator('[data-customer-history]').first().evaluate(element => element === document.activeElement), true);
      await next.click();
      assert.equal(await page.locator('.customer-record').count(), 25);
      assert.equal(await next.isDisabled(), true);
      await page.locator('#customer-previous').click();
      assert.equal(await page.locator('.customer-record').count(), PAGE_SIZE);
      await page.locator('#customer-sort').selectOption('name');
      assert.match(await page.locator('#customer-count').innerText(), /1〜50件/);
      await page.locator('#customer-search').fill('架空のお客様0124');
      assert.equal(await page.locator('.customer-record').count(), 1);
      assert.equal(await page.locator('#customer-pages').isVisible(), false);
      await page.locator('[data-customer-history]').click();
      assert.equal(await page.locator('.customer-history li').count(), 2);
      await page.locator('[data-customer-close]').click();
      await page.locator('#clear-customer-search').click();
      assert.equal(await page.locator('.customer-record').count(), PAGE_SIZE);
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        for (const control of ['#customer-previous', '#customer-next']) {
          assert.ok(await page.locator(control).evaluate(element => element.getBoundingClientRect().height >= 44));
        }
      }
      if (process.env.SCREENSHOT_DIR && design) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#customer-count').scrollIntoViewIfNeeded();
        await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'customer-pages-390.png') });
      }
    });
  });
}

test('メモ入力・保存待ち・日時変更中はページ移動を止め、保存済みの内容へ戻せば移動できる', async () => {
  await fixture('?design=a', async ({ page, warnings }) => {
    const first = page.locator('.customer-record').first();
    await first.locator('[data-customer-history]').click();
    await first.locator('[data-note-summary]').first().click();
    const note = first.locator('[data-note-input]').first();
    const original = await note.inputValue();
    await note.fill('未保存の大事な申し送り');
    await page.locator('#customer-next').click();
    assert.equal(await note.inputValue(), '未保存の大事な申し送り');
    assert.match(await page.locator('#customer-count').innerText(), /1〜50件/);
    await note.fill(original);
    await page.evaluate(() => pendingNoteSaves.add('LM-PAGE-0000'));
    await page.locator('#customer-next').click();
    assert.equal(await first.evaluate(element => element.open), true);
    await page.evaluate(() => { pendingNoteSaves.clear(); activeChange = { code: 'LM-PAGE-0000' }; });
    await page.locator('#customer-next').click();
    assert.match(await page.locator('#customer-count').innerText(), /1〜50件/);
    assert.equal(warnings.length, 3);
    await page.evaluate(() => { activeChange = null; });
    await page.locator('#customer-next').click();
    assert.match(await page.locator('#customer-count').innerText(), /51〜100件/);
    assert.equal(await page.locator('.customer-record[open]').count(), 0);
    assert.equal(await page.locator('#customer-rows [data-note-input]').count(), 0);
  });
});

test('更新で開いた人の位置が次のページへ移っても、その人の履歴を表示し続ける', async () => {
  await fixture('?design=a', async ({ page }) => {
    const selected = page.locator('.customer-record').last();
    const tel = await selected.getAttribute('data-customer-tel');
    await selected.locator('[data-customer-history]').click();
    await page.evaluate(() => {
      adminData.reservations.push({ ...adminData.reservations[0], code: 'LM-NEW-ROW',
        date: '2026-01-01', tel: '00000009999', name: '架空の追加客' });
      renderCustomers();
    });
    assert.match(await page.locator('#customer-count').innerText(), /51〜100件/);
    const open = page.locator(`.customer-record[data-customer-tel="${tel}"][open]`);
    assert.equal(await open.count(), 1);
    assert.equal(await open.locator('.customer-history li').count(), 2);
  });
});

test('名簿の最終ページを表示中も、全予約のCSVは全250行を書き出す', async () => {
  await fixture('?design=a', async ({ page }) => {
    await page.locator('#customer-next').click();
    await page.locator('#customer-next').click();
    const download = page.waitForEvent('download');
    await page.evaluate(async () => {
      document.querySelector('#filter-date').value = '';
      document.querySelector('#filter-status').value = 'all';
      showPast = true;
      await exportCsv();
    });
    const file = await download;
    const csv = await readFile(await file.path(), 'utf8');
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, records.length + 1);
    for (const record of records) assert.ok(csv.includes(`"${record.code}"`), record.code);
    assert.equal(await page.locator('.customer-record').count(), 25);
    assert.equal(await page.evaluate(() => adminData.reservations.length), records.length);
  });
});
