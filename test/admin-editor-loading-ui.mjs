import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const TEST_TIMEOUT_MS = 5000;

for (const design of ['', '?design=a']) {
  test(`写真・口コミは開くまで取得せず、障害後も編集と他タブの入力を守る ${design || '従来版'}`, async () => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    handler = createMockHandler({ port });
    const base = `http://127.0.0.1:${port}`;
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
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
        if (url.pathname !== '/exec' || request.method() !== 'POST') return route.continue();
        const payload = request.postDataJSON();
        if (payload.type !== 'adminData') return route.continue();
        calls.push(payload);
        const response = await route.fetch();
        const body = await response.json();
        if (payload.startupOnly === true) {
          delete body.styles;
          delete body.reviews;
          delete body.stamps.styles;
          delete body.stamps.reviews;
          body.pendingEditors = ['styles', 'reviews'];
        } else if (payload.editorTarget === 'styles') {
          await new Promise(resolve => { finishStyles = resolve; beginStyles(); });
          return route.fulfill({ response, json: { ok: true, editorTarget: 'styles', rows: body.styles, stamp: '123456abcdef' } });
        } else if (payload.editorTarget === 'reviews') {
          reviewAttempt++;
          return route.fulfill({ response, json: reviewAttempt === 1
            ? { ok: false, error: '架空の口コミ読込障害' }
            : { ok: true, editorTarget: 'reviews', rows: [], stamp: '0' } });
        }
        return route.fulfill({ response, json: body });
      });
      await page.goto(base + '/admin.html' + design);
      await page.locator('#passcode').fill(password);
      await page.locator('#remember-me').uncheck();
      await page.locator('#gate-btn').click();
      await page.locator('#dashboard:not([hidden])').waitFor();
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
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      if (process.env.TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR,
        `editor-${design ? 'a' : 'original'}.png`), fullPage: true });
      assert.deepEqual(errors, []);
    } finally {
      finishStyles?.();
      if (browser) await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
