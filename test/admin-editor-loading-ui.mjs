import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { openGoogleAdmin } from './google-admin-fixture.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const TEST_TIMEOUT_MS = 5000;

for (const design of ['', '?design=a']) {
  test(`電話メニューの一括取得・不完全応答・手動復旧で手入力を守る ${design || '従来版'}`, async () => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    handler = createMockHandler({ port });
    const base = `http://127.0.0.1:${port}`;
    const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password }) })
      .then(response => response.json());
    const calls = [];
    const writes = [];
    const errors = [];
    let catalog;
    let finishCatalog;
    let beginCatalog;
    const catalogStarted = new Promise(resolve => { beginCatalog = resolve; });
    let attempts = 0;
    let browser;
    try {
      browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
        process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
      const shell = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      shell.on('pageerror', error => errors.push(error.message));
      const admin = await openGoogleAdmin({ shell, base, design, request: async payload => {
        if (payload.type !== 'adminData') {
          writes.push(payload.type);
          return post(payload);
        }
        calls.push(payload);
        if (payload.phoneCatalogOnly === true) {
          attempts++;
          const result = structuredClone(catalog);
          if (attempts === 1) {
            await new Promise(resolve => { finishCatalog = resolve; beginCatalog(); });
            delete result.editors.coupons.stamp;
          }
          return result;
        }
        const body = await post(payload);
        if (payload.startupOnly === true) {
          catalog = { ok: true, phoneCatalog: true, editors: Object.fromEntries(['menus', 'coupons']
            .map(target => [target, { ok: true, editorTarget: target, rows: body[target],
              stamp: target === 'menus' ? '123456abcdef' : 'fedcba654321' }])) };
          for (const target of ['menus', 'coupons', 'styles', 'reviews']) {
            delete body[target];
            delete body.stamps[target];
          }
          body.pendingEditors = ['menus', 'coupons', 'styles', 'reviews'];
          body.capabilities.phoneCatalog = true;
        }
        return body;
      } });
      const page = admin.frame;
      await page.locator('#add-booking').click();
      let readTimer;
      try {
        await Promise.race([catalogStarted, new Promise((_resolve, reject) => {
          readTimer = setTimeout(() => reject(new Error('電話メニューの一括取得が始まりませんでした。')), TEST_TIMEOUT_MS);
        })]);
      } finally { clearTimeout(readTimer); }
      await page.locator('#site-edit-tabs summary').click();
      await page.locator('#admin-tabs [data-pane="menus"]').click();
      assert.equal(await page.locator('[data-save="menus"]').isDisabled(), true);
      await page.locator('#admin-tabs [data-pane="reserve"]').click();
      await page.locator('#ab-menu').fill('取得中の手入力');
      await page.locator('#ab-minutes').fill('80');
      await page.locator('#ab-price').fill('12345');
      assert.equal(await page.locator('#ab-menu-preset').isDisabled(), true);
      assert.equal(calls.filter(payload => payload.phoneCatalogOnly === true).length, 1);
      assert.equal(calls.filter(payload => payload.editorTarget).length, 0);
      finishCatalog();
      await page.locator('[data-retry-phone-presets]').waitFor();
      assert.deepEqual(await page.evaluate(() => ['menus', 'coupons'].map(target => ({
        pending: pendingEditors.has(target), stamp: stamps[target], rows: edits[target].length
      }))), [{ pending: true, stamp: undefined, rows: 0 }, { pending: true, stamp: undefined, rows: 0 }]);
      assert.equal(await page.locator('[data-save="menus"]').isDisabled(), true);
      assert.equal(await page.locator('[data-save="coupons"]').isDisabled(), true);
      assert.equal(attempts, 1, '不完全応答を自動で再取得しない');
      await page.locator('[data-retry-phone-presets]').click();
      await page.waitForFunction(() => !document.querySelector('#ab-menu-preset').disabled);
      assert.equal(await page.locator('#ab-presets-status').isHidden(), true);
      assert.equal(await page.locator('#ab-menu').inputValue(), '取得中の手入力');
      assert.equal(await page.locator('#ab-minutes').inputValue(), '80');
      assert.equal(await page.locator('#ab-price').inputValue(), '12345');
      const visibleRows = Object.values(catalog.editors).flatMap(editor => editor.rows)
        .filter(row => String(row['メニュー名'] || '').trim()
          && !/^(×|✕|false|off|0|非表示)$/i.test(String(row['表示'] ?? '').trim()));
      assert.equal(await page.locator('#ab-menu-preset option').count(), 1 + visibleRows.length);
      assert.equal(await page.locator('#ab-menu-preset option').first().innerText(), 'メニュー・時間・金額を手入力');
      for (const row of visibleRows) assert.ok((await page.locator('#ab-menu-preset').innerText()).includes(row['メニュー名']));
      assert.deepEqual(await page.evaluate(() => ['menus', 'coupons'].map(target => ({
        rows: adminData[target].length, stamp: stamps[target], pending: pendingEditors.has(target)
      }))), ['menus', 'coupons'].map(target => ({ rows: catalog.editors[target].rows.length,
        stamp: catalog.editors[target].stamp, pending: false })));
      await page.locator('#site-edit-tabs summary').click();
      await page.locator('#admin-tabs [data-pane="menus"]').click();
      assert.equal(await page.locator('[data-save="menus"]').isDisabled(), false);
      assert.equal(calls.filter(payload => payload.editorTarget).length, 0);
      assert.equal(calls.filter(payload => payload.phoneCatalogOnly === true).length, 2);
      for (const width of [320, 390, 768, 1280]) {
        await shell.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      if (process.env.TEST_SCREENSHOT_DIR) await shell.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR,
        `phone-catalog-${design ? 'a' : 'original'}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, [], 'メニュー取得・手入力だけでは予約も台帳も書き換えない');
      admin.assertIsolated();
    } finally {
      finishCatalog?.();
      if (browser) await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  test(`写真・口コミは開くまで取得せず、障害後も編集と他タブの入力を守る ${design || '従来版'}`, async () => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    handler = createMockHandler({ port });
    const base = `http://127.0.0.1:${port}`;
    const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify({ ...payload, password }) })
      .then(response => response.json());
    const calls = [];
    const errors = [];
    let finishStyles;
    let beginStyles;
    const stylesStarted = new Promise(resolve => { beginStyles = resolve; });
    let reviewAttempt = 0;
    let browser;
    try {
      browser = await engines[process.env.TEST_BROWSER || 'chromium'].launch(
        process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
      const shell = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      shell.on('pageerror', error => errors.push(error.message));
      const admin = await openGoogleAdmin({ shell, base, design, request: async payload => {
        if (payload.type !== 'adminData') return post(payload);
        calls.push(payload);
        const body = await post(payload);
        if (payload.startupOnly === true) {
          delete body.styles;
          delete body.reviews;
          delete body.stamps.styles;
          delete body.stamps.reviews;
          body.pendingEditors = ['styles', 'reviews'];
        } else if (payload.editorTarget === 'styles') {
          await new Promise(resolve => { finishStyles = resolve; beginStyles(); });
          return { ok: true, editorTarget: 'styles', rows: body.styles, stamp: '123456abcdef' };
        } else if (payload.editorTarget === 'reviews') {
          reviewAttempt++;
          return reviewAttempt === 1
            ? { ok: false, error: '架空の口コミ読込障害' }
            : { ok: true, editorTarget: 'reviews', rows: [], stamp: '0' };
        }
        return body;
      } });
      const page = admin.frame;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].startupOnly, true);
      assert.equal(await page.locator('[data-save="styles"]').isDisabled(), true);
      assert.equal(await page.locator('#style-rows [data-editor]').count(), 0);
      await page.locator('#site-edit-tabs summary').click();
      await page.locator('#admin-tabs [data-pane="menus"]').click();
      await page.locator('[data-target="menus"][data-col="価格"]').first().fill('7654');
      await page.locator('#admin-tabs [data-pane="styles"]').click();
      await page.waitForFunction(() => document.querySelector('#style-rows').textContent.includes('読み込んでいます'));
      await page.waitForFunction(() => document.querySelector('[data-save="styles"]').disabled);
      let readTimer;
      try {
        await Promise.race([stylesStarted, new Promise((_resolve, reject) => {
          readTimer = setTimeout(() => reject(new Error('編集取得が始まりませんでした。')), TEST_TIMEOUT_MS);
        })]);
      } finally { clearTimeout(readTimer); }
      await page.locator('#admin-tabs [data-pane="menus"]').click();
      await page.locator('#admin-tabs [data-pane="styles"]').click();
      assert.equal(calls.filter(payload => payload.editorTarget === 'styles').length, 1);
      finishStyles();
      await page.waitForFunction(() => !document.querySelector('[data-save="styles"]').disabled);
      await page.locator('[data-target="styles"][data-col="タイトル"]').first().fill('保持する入力');
      await page.locator('#admin-tabs [data-pane="reviews"]').click();
      await page.locator('[data-retry-editor="reviews"]').waitFor();
      assert.equal(await page.locator('[data-save="reviews"]').isDisabled(), true);
      assert.match(await page.locator('#review-rows').innerText(), /架空の口コミ読込障害/);
      await page.locator('[data-retry-editor="reviews"]').click();
      await page.waitForFunction(() => !document.querySelector('[data-save="reviews"]').disabled);
      assert.match(await page.locator('#review-rows').innerText(), /まだ口コミは/);
      await page.locator('#admin-tabs [data-pane="styles"]').click();
      assert.equal(await page.locator('[data-target="styles"][data-col="タイトル"]').first().inputValue(), '保持する入力');
      assert.equal(calls.filter(payload => payload.editorTarget === 'styles').length, 1);
      await page.locator('#admin-tabs [data-pane="menus"]').click();
      assert.equal(await page.locator('[data-target="menus"][data-col="価格"]').first().inputValue(), '7654');
      for (const width of [320, 390, 768, 1280]) {
        await shell.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      if (process.env.TEST_SCREENSHOT_DIR) await shell.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR,
        `editor-${design ? 'a' : 'original'}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      assert.ok(admin.operations.every(payload => payload.type === 'adminData'), '編集欄の入力だけでは保存しない');
      admin.assertIsolated();
    } finally {
      finishStyles?.();
      if (browser) await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
