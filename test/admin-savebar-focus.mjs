import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const PASSWORD = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(PASSWORD, 'MOCK_ADMIN_PASSWORD が必要です');
const VIEWPORT_HEIGHT = 568;
const WORKSPACE_HEADER_HEIGHT = 48;
const BOUNDARY_TOLERANCE = 1;

for (const design of ['', '?design=a']) {
  for (const width of [320, 390, 768, 1280]) {
    for (const dirty of [false, true]) {
      test(`${design ? 'A案・管理フレーム' : '従来版'}／${width}px／${dirty ? '未保存' : '保存前'}：Tab移動した休業メモを保存バーで隠さない`, async () => {
        let handler;
        const server = http.createServer((request, response) => {
          if (request.url === '/savebar-frame') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(`<!doctype html><html lang="ja"><title>架空の管理枠</title>
              <body style="margin:0;overflow:hidden;display:grid;height:100dvh;grid-template-rows:${WORKSPACE_HEADER_HEIGHT}px minmax(0,1fr)">
              <header>架空の管理枠</header><iframe title="管理画面" src="admin.html?design=a"
                style="border:0;width:100%;height:100%;min-height:0"></iframe></body></html>`);
            return;
          }
          handler(request, response);
        });
        let browser;
        try {
          server.listen(0, '127.0.0.1');
          await once(server, 'listening');
          handler = createMockHandler({ port: server.address().port });
          const base = `http://127.0.0.1:${server.address().port}`;
          browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
          const mainPage = await browser.newPage({ viewport: { width, height: VIEWPORT_HEIGHT },
            locale: 'ja-JP', timezoneId: 'Asia/Tokyo', reducedMotion: 'reduce' });
          const errors = [];
          const writes = [];
          mainPage.on('pageerror', error => errors.push(error.message));
          await mainPage.route('**/*', route => {
            const request = route.request();
            if (new URL(request.url()).origin !== base) return route.abort();
            if (request.method() === 'POST') {
              const type = request.postDataJSON().type;
              if (!['adminLogin', 'adminData'].includes(type)) writes.push(type);
            }
            return route.continue();
          });
          await mainPage.goto(base + (design ? '/savebar-frame' : '/admin.html'));
          const page = design ? await (await mainPage.locator('iframe').elementHandle()).contentFrame() : mainPage;
          assert.equal(await page.locator('.admin-savebar:visible').count(), 0);
          assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBottom), 'auto');
          await page.locator('#passcode').fill(PASSWORD);
          await page.locator('#remember-me').uncheck();
          await page.locator('#gate-btn').click();
          await page.locator('#dashboard:not([hidden])').waitFor();
          await page.locator('#admin-tabs [data-pane="closed"]').click();
          const memo = page.locator('#closed-rows [data-col="メモ"]').first();
          const before = await memo.inputValue();
          if (dirty) await memo.fill('未保存の休業メモを保持する');
          const expected = dirty ? '未保存の休業メモを保持する' : before;
          await page.waitForFunction(() => {
            const pane = document.querySelector('.admin-pane[data-pane="closed"]');
            const bar = pane.querySelector('.admin-savebar');
            return Math.abs(parseFloat(pane.style.getPropertyValue('--admin-savebar-height'))
              - bar.getBoundingClientRect().height) < 1;
          });
          await memo.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            scrollBy({ top: bounds.bottom - innerHeight + 1, behavior: 'instant' });
            element.closest('.booking-card').querySelector('input[type="radio"]:checked').focus({ preventScroll: true });
          });
          await mainPage.keyboard.press('Tab');
          const focused = await memo.evaluate(async element => {
            await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
            const bounds = element.getBoundingClientRect();
            const bar = element.closest('.admin-pane').querySelector('.admin-savebar').getBoundingClientRect();
            const front = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            return { active: document.activeElement === element, focusVisible: element.matches(':focus-visible'),
              top: bounds.top, bottom: bounds.bottom, barTop: bar.top,
              obscured: !!front?.closest('.admin-savebar') };
          });
          if (process.env.TEST_SCREENSHOT_DIR) await mainPage.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR,
            `savebar-focus-${design ? 'a' : 'original'}-${width}-${dirty ? 'dirty' : 'clean'}.png`), animations: 'disabled' });
          assert.ok(focused.active && focused.focusVisible, 'Tabで実際のメモ欄へ移動する');
          assert.ok(focused.top >= 0 && focused.bottom <= focused.barTop + BOUNDARY_TOLERANCE,
            `入力欄全体を保存バーより上に表示する：${JSON.stringify(focused)}`);
          assert.equal(focused.obscured, false, '保存バーで入力中のメモを覆わない');
          assert.equal(await memo.inputValue(), expected, '位置を調整しても入力を消さない');
          assert.equal(await page.locator('.admin-savebar:visible').count(), 1, '保存操作は残す');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.locator('#admin-tabs [data-pane="reserve"]').click();
          assert.equal(await page.locator('.admin-savebar:visible').count(), 0);
          assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBottom), 'auto',
            '予約一覧へ戻ったら保存バー用のスクロール余白を残さない');
          await page.locator('#admin-tabs [data-pane="closed"]').click();
          assert.equal(await memo.inputValue(), expected, 'タブを往復しても下書きを残す');
          await page.waitForFunction(() => {
            const bar = document.querySelector('.admin-pane[data-pane="closed"] .admin-savebar');
            return parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) >= bar.getBoundingClientRect().height;
          });
          assert.deepEqual(writes, [], '表示・入力・Tab操作だけでは保存しない');
          assert.deepEqual(errors, []);
        } finally {
          if (browser) await browser.close();
          server.closeAllConnections();
          await new Promise(resolveClose => server.close(resolveClose));
        }
      });
    }
  }
}
