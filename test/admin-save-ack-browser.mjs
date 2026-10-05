import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const PASSWORD = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(PASSWORD, 'MOCK_ADMIN_PASSWORD が必要です');

for (const design of ['', '?design=a']) {
  for (const saved of [false, true]) {
    for (const responseKind of ['missing', 'wrong-target', 'contradictory']) {
      test(`${design || '従来版'}・保存${saved ? '済み' : '未反映'}・${responseKind}：休業日の下書きを保存済みと誤表示しない`, async () => {
        const server = http.createServer();
        let browser;
        try {
          server.listen(0, '127.0.0.1');
          await once(server, 'listening');
          server.on('request', createMockHandler({ port: server.address().port }));
          const base = `http://127.0.0.1:${server.address().port}`;
          const post = payload => fetch(base + '/exec', { method: 'POST', body: JSON.stringify(payload) }).then(response => response.json());
          browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
          const page = await browser.newPage({ viewport: { width: 390, height: 568 }, timezoneId: 'Asia/Tokyo' });
          const errors = [];
          const writes = [];
          let valid = false;
          page.on('pageerror', error => errors.push(error.message));
          await page.route('**/*', async route => {
            const request = route.request();
            if (new URL(request.url()).origin !== base) return route.abort();
            if (request.method() === 'POST' && request.postDataJSON().type === 'adminSave') {
              const payload = request.postDataJSON();
              writes.push(payload);
              const actual = saved || valid ? await post(payload) : null;
              if (actual && !valid) assert.equal(actual.ok, true);
              if (valid) {
                assert.equal(actual.ok, !saved);
                if (saved) assert.equal(actual.stale, true);
                else assert.deepEqual(Object.keys(actual.stamps), [payload.target]);
                return route.fulfill({ json: actual });
              }
              const responses = { missing: { ok: true }, 'wrong-target': { ok: true, stamps: { menus: 'unrelated' } },
                contradictory: { ok: true, unknown: true, stamps: { closed: 'unconfirmed' } } };
              return route.fulfill({ json: responses[responseKind] });
            }
            return route.continue();
          });
          await page.goto(base + '/admin.html' + design);
          await page.locator('#passcode').fill(PASSWORD);
          await page.locator('#remember-me').uncheck();
          await page.locator('#gate-btn').click();
          await page.locator('#dashboard:not([hidden])').waitFor();
          await page.locator('#admin-tabs [data-pane="closed"]').click();
          const date = page.locator('#closed-rows [data-col="休業日"]').first();
          const beforeDate = await date.inputValue();
          const changedDate = '2030-01-05';
          assert.notEqual(beforeDate, changedDate);
          await date.fill(changedDate);
          const memo = page.locator('#closed-rows [data-col="メモ"]').first();
          await memo.fill('結果を確認するまで残す休業メモ');
          await page.locator('[data-save="closed"]').click();
          await page.waitForFunction(() => document.querySelector('[data-note="closed"]')?.textContent.includes('保存の結果を確認できません'));
          assert.equal(await memo.inputValue(), '結果を確認するまで残す休業メモ');
          assert.equal(await page.locator('#save-ok').isVisible(), false);
          assert.equal(await page.locator('[data-save="closed"]').isDisabled(), false);
          assert.match(await page.locator('[data-note="closed"]').innerText(), /保存を繰り返さず/);
          assert.equal(writes.length, 1);
          assert.equal(writes[0].stampScope, 'target');
          const current = await post({ type: 'adminData', password: PASSWORD });
          assert.equal(current.closedDates[0].休業日, saved ? changedDate : beforeDate,
            '保存が反映済み・未反映の両方で結果不明の表示と下書きを保持する');
          await page.locator('#admin-tabs [data-pane="reserve"]').click();
          await page.locator('#admin-tabs [data-pane="closed"]').click();
          assert.equal(await memo.inputValue(), '結果を確認するまで残す休業メモ');
          assert.equal(writes.length, 1, 'タブ往復で再送しない');
          valid = true;
          await page.locator('[data-save="closed"]').click();
          await page.waitForFunction(wasSaved => document.querySelector('[data-note="closed"]')?.textContent
            .includes(wasSaved ? '別の端末から変更されています' : '休業日を保存しました'), saved);
          assert.equal(writes.length, 2, '有効な保存は手動の操作だけ');
          assert.equal(await memo.inputValue(), '結果を確認するまで残す休業メモ');
          if (saved) {
            assert.equal(writes[1].stamp, writes[0].stamp, '不明な結果を根拠に更新印を進めない');
            assert.equal(await page.locator('#save-ok').isVisible(), false);
            assert.equal(await page.locator('#reload-admin').count(), 1, '競合時には読み直す操作を示す');
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
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
