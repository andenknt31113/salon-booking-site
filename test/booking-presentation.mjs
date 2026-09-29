import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

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

for (const name of ['reserve', 'mypage']) {
  test(`${name}：遅い設定が届いても公開済みのLINE・写真・店舗案内を変えない`, async () => {
    for (const line of ['', 'https://example.invalid/old-line']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
      let release;
      let started;
      const pending = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { started = resolve; });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.route('**/exec', async route => {
          if (route.request().postDataJSON()?.type !== 'menu') return route.continue();
          const response = await route.fetch();
          const data = await response.json();
          data.settings = { ...data.settings, 'LINE友だち追加URL': line,
            'ロゴ画像': 'https://example.invalid/old-logo.jpg',
            'スタッフ写真': 'https://example.invalid/old-staff.jpg',
            '住所': '古い住所', '電話番号': '000-0000-0000',
            '営業開始': '10:00', '営業終了': '19:00', '最終受付': '18:00',
            '変更・キャンセル期限（何日前）': '2', '変更・キャンセル期限（何時）': '16',
            '定休曜日': '水', '準備中の帯': '出さない' };
          data.closedDates = [{ date: '2099-10-08', start: '', end: '' }];
          started();
          await pending;
          await route.fulfill({ json: data });
        });
        await page.goto(`${base}/${name}.html`);
        await requested;
        const readPresentation = () => page.evaluate(() => ({
          line: document.querySelector('#site-footer a[href*="line.me"]')?.getAttribute('href'),
          logo: SALON.logo, staff: SALON.staff[0].image, address: SALON.address
        }));
        const before = await readPresentation();
        assert.ok(before.line, '読込前にLINEへの案内がある');
        release();
        await page.waitForFunction(() => Catalog.loaded);
        assert.deepEqual(await readPresentation(), before, '公開ファイルの案内・写真を維持する');
        assert.equal(await page.locator('#site-footer a[href*="line.me"]').isVisible(), true);
        const live = await page.evaluate(() => ({
          source: Catalog.source, draft: SALON.draft, tel: SALON.tel,
          business: SALON.business
        }));
        assert.equal(live.source, 'sheet');
        assert.equal(live.draft, false);
        assert.equal(live.tel, '000-0000-0000', '予約についての連絡先は最新を使う');
        assert.equal(live.business.openTime, '10:00');
        assert.equal(live.business.closeTime, '19:00');
        assert.equal(live.business.lastOrder, '18:00');
        assert.deepEqual(live.business.closedWeekdays, [3]);
        assert.deepEqual(live.business.closedDates, [{ date: '2099-10-08', start: '', end: '' }]);
        assert.deepEqual(live.business.cancelDeadline, { daysBefore: 2, hour: 16 });
        assert.deepEqual(errors, []);
      } finally { release(); await page.context().close(); }
    }
  });
}
