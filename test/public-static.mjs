import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8820';
const OBSERVATION_MS = 8500;
const WIDTHS = [390, 1280];
const PAGES = ['index.html', 'menu.html', 'gallery.html', 'staff.html', 'reviews.html', 'privacy.html'];
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];

try {
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ja-JP' });
    const requests = [];
    await context.route('**/*', async route => {
      const request = route.request();
      if (request.method() === 'POST') {
        requests.push(request.url());
        await route.abort();
      } else {
        await route.continue();
      }
    });
    await Promise.all(PAGES.map(async name => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
      await page.goto(`${BASE}/${name}`, { waitUntil: 'load' });
      const snapshot = () => page.evaluate(() => ({
        text: document.querySelector('main').innerText,
        links: Array.from(document.querySelectorAll('main a')).map(link => link.href),
        images: Array.from(document.querySelectorAll('main img')).map(image => image.src),
        logo: Array.from(document.querySelectorAll('#site-header .brand img')).map(image => image.src),
        footerLinks: Array.from(document.querySelectorAll('#site-footer a')).map(link => link.href)
      }));
      const initial = await snapshot();
      assert.ok(initial.text.trim(), `${name} を待たずに読める`);
      assert.ok(initial.footerLinks.some(link => link.includes('line.me/')), `${name} のLINE導線が最初からある`);
      assert.doesNotMatch(await page.locator('meta[name="description"]').getAttribute('content'),
        /24時間.*受付中|24時間.*予約いただけます|指名予約いただけます/,
        `${name} の検索結果で予約受付中と誤案内しない`);
      assert.equal(await page.locator('footer.site-footer a[href*="admin.html"]').count(), 0,
        `${name} のお客様向けフッターに管理画面への入口を出さない`);
      await page.waitForTimeout(OBSERVATION_MS);
      assert.deepEqual(await snapshot(), initial, `${name} の本文・写真・リンクは8秒後にも同じ`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} は幅${width}で横にはみ出さない`);
      if (name === 'reviews.html') {
        assert.equal(await page.locator('#review-form').count(), 0, '自社投稿フォームを出さない');
        assert.equal(await page.getByRole('link', { name: 'Googleで口コミを見る（別タブ）' }).count(), 1, 'Googleの閲覧導線を保持する');
        assert.equal(await page.getByRole('link', { name: 'Googleに口コミを書く（別タブ）' }).count(), 0, '未確認の検索URLを投稿リンクと呼ばない');
        assert.equal(await page.locator('#review-list').count(), 0, '架空のGoogle口コミ一覧を出さない');
      }
      console.log(`成功：${name} 幅${width}・時間経過による差し替えなし`);
    }));
    assert.deepEqual(requests, [], '公開ページはGASに設定取得を要求しない');
    const reserve = await context.newPage();
    reserve.on('pageerror', error => errors.push(`reserve.html: ${error.message}`));
    await reserve.goto(`${BASE}/reserve.html`, { waitUntil: 'load' });
    assert.doesNotMatch(await reserve.locator('meta[name="description"]').getAttribute('content'),
      /24時間.*予約いただけます|受付中/, '準備中の予約画面を検索結果で受付中と案内しない');
    assert.equal(await reserve.locator('body').evaluate(body => body.classList.contains('booking-paused')),
      true, '準備中の予約画面には停止状態を付ける');
    assert.equal(await reserve.locator('#reserve-layout').isVisible(), false,
      '準備中の予約フォームはお客様に見せない');
    await reserve.close();
    await context.close();
  }
  assert.deepEqual(errors, [], 'JavaScriptエラーがない');
} finally {
  await browser.close();
}
console.log('公開6ページ・2画面幅の回帰試験：全項目成功');
