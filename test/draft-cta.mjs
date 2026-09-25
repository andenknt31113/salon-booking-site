import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
let sheetDraft = '出さない';
const server = http.createServer((request, reply) => {
  if (request.method === 'POST' && request.url === '/exec') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const type = JSON.parse(body).type;
      assert.ok(['menu', 'availability'].includes(type), '閲覧中に予約の送信をしない');
      reply.writeHead(200, { 'Content-Type': 'application/json' });
      reply.end(JSON.stringify({ ok: true, categories: [], coupons: [], closedDates: [],
        settings: sheetDraft === null ? {} : { '準備中の帯': sheetDraft }, booked: [] }));
    });
    return;
  }
  const path = join(root, decodeURIComponent(request.url.split('?')[0]));
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { reply.writeHead(403).end(); return; }
  try {
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(path)]
      || 'application/octet-stream';
    let body = readFileSync(path);
    if (path.endsWith('/data.js')) {
      body = Buffer.from(body.toString().replace(/reservationEndpoint: '[^']*'/,
        `reservationEndpoint: 'http://127.0.0.1:${server.address().port}/exec'`));
    }
    reply.writeHead(200, { 'Content-Type': type });
    reply.end(body);
  } catch { reply.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch(process.env.CHROMIUM
  ? { executablePath: process.env.CHROMIUM } : {});

try {
  for (const draft of [true, false]) {
    const context = await browser.newContext();
    if (!draft) {
      await context.route('**/assets/js/data.js', async route => {
        const response = await route.fetch();
        const original = await response.text();
        const body = original.replace('draft: true,', 'draft: false,')
          .replace('bookingLaunchApproved: false,', 'bookingLaunchApproved: true,');
        assert.notEqual(body, original, '試験用に受付開始設定を切り替える');
        assert.ok(body.includes('bookingLaunchApproved: true,'), '受付開始承認も切り替える');
        await route.fulfill({ response, body });
      });
    }
    const errors = [];
    for (const name of ['index.html', 'menu.html', 'staff.html', 'gallery.html', 'reviews.html']) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/${name}`, { waitUntil: 'load' });
      const header = await page.locator('#site-header .header-actions a[href="reserve.html"]').innerText();
      const navigation = await page.locator('#site-header nav a[href="reserve.html"]').innerText();
      const footer = await page.locator('#site-footer .footer-grid a[href="reserve.html"]').innerText();
      if (draft) {
        assert.equal(header, '予約について', `${name}：準備中のヘッダー`);
        assert.equal(navigation, '予約について', `${name}：準備中のメニュー`);
        assert.equal(footer, '予約について', `${name}：準備中のフッター`);
      } else {
        assert.equal(header, 'ネット予約', `${name}：受付中のヘッダー`);
        assert.equal(navigation, '空席・予約', `${name}：受付中のメニュー`);
        assert.equal(footer, '空席状況・ネット予約', `${name}：受付中のフッター`);
      }
      if (name === 'menu.html' || name === 'index.html') {
        const coupon = await page.locator('.coupon-price a[href^="reserve.html?menu="]').first().innerText();
        assert.equal(coupon, draft ? '予約について' : 'このメニューで予約', `${name}：おすすめメニューの導線`);
      }
      if (name === 'index.html' && !draft) {
        const faq = page.locator('.faq-item').filter({ hasText: '予約は必要ですか？' });
        await faq.locator('.faq-q').click();
        assert.equal(/24時間.*予約|予約.*24時間/.test(await faq.locator('.faq-a').innerText()), false,
          '公開FAQもシート側の受付停止後に受付中とは断定しない');
        assert.equal(await page.locator('.sp-cta a[href="reserve.html"]').innerText(), '空席・予約',
          '固定予約ボタンも受付中と断定しない');
        assert.equal(/24時間.*予約|予約.*24時間/.test(await page.locator('body').innerText()), false,
          '公開ページはシート側の受付停止後も24時間受付中とは断定しない');
      }
      if (name === 'menu.html') {
        const bottom = await page.locator('main a[href="reserve.html"]').last().innerText();
        assert.equal(bottom, draft ? '予約のご案内を見る' : 'メニューを選んで予約する', 'メニュー末尾の導線');
      }
      if (name === 'staff.html') {
        const staff = await page.locator('.staff-card a[href^="reserve.html?staff="]').first().innerText();
        assert.equal(staff, draft ? '予約について' : 'MATTEOに予約する', 'スタッフの導線');
      }
      if (name === 'gallery.html') {
        const style = await page.locator('.style-card a[href="reserve.html"]').first().innerText();
        const bottom = await page.locator('main a[href="reserve.html"]').last().innerText();
        const intro = await page.locator('.page-head p').innerText();
        assert.equal(style.replace(/\s+/g, ''), draft ? '予約について' : 'このスタイルで予約', 'スタイルの導線');
        assert.equal(bottom, draft ? '予約のご案内を見る' : 'スタイルを決めずに予約に進む', 'スタイル末尾の導線');
        assert.equal(intro.includes('ご予約に進めます'), !draft, 'スタイルの案内は受付状態と一致');
      }
      if (name === 'reviews.html') {
        const label = await page.locator('main a[href="reserve.html"]').innerText();
        assert.equal(label, draft ? '予約のご案内を見る' : 'ネット予約へ進む', '口コミページの導線');
      }
      await page.close();
    }
    for (const name of ['mypage.html', 'reserve.html']) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/${name}`, { waitUntil: 'load' });
      await page.waitForFunction(() => Catalog.loaded);
      assert.equal(await page.locator('body').evaluate(body => body.classList.contains('booking-paused')),
        draft, `${name}：設定シートが「出さない」でもサイト側の承認を優先する`);
      if (name === 'mypage.html') {
        const label = await page.locator('main a[href="reserve.html"]').innerText();
        assert.equal(label, draft ? '予約のご案内を見る' : '新しく予約する', '予約確認ページの導線');
      } else {
        assert.equal(await page.locator('#reserve-layout').isVisible(), !draft, '予約フォームの表示状態');
        if (draft) {
          const link = await page.locator('#booking-paused-notice a[href="mypage.html"]').boundingBox();
          assert.ok(link && link.height >= 44, '準備中の予約確認リンクは押しやすい高さを保つ');
        }
      }
      await page.close();
    }
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
    await context.close();
  }
  const launchCases = [
    { approved: true, draft: true, sheet: '出さない', paused: true, label: 'サイトの準備中設定を残した場合' },
    { approved: false, draft: false, sheet: '出さない', paused: true, label: 'サイトの開始承認がない場合' },
    { approved: true, draft: false, sheet: '出す', paused: true, label: 'シートが準備中の場合' },
    { approved: true, draft: false, sheet: null, paused: true, label: 'シートの設定が欠けた場合' },
    { approved: true, draft: false, sheet: '不明', paused: true, label: 'シートの設定を読めない場合' },
    { approved: true, draft: false, sheet: '出さない', paused: false, label: '3条件がそろった場合' }
  ];
  for (const item of launchCases) {
    sheetDraft = item.sheet;
    const context = await browser.newContext();
    await context.route('**/assets/js/data.js', async route => {
      const response = await route.fetch();
      const original = await response.text();
      assert.ok(original.includes('bookingLaunchApproved: false,') && original.includes('draft: true,'), '受付開始の試験設定がある');
      const body = original.replace('bookingLaunchApproved: false,', `bookingLaunchApproved: ${item.approved},`)
        .replace('draft: true,', `draft: ${item.draft},`);
      await route.fulfill({ response, body });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/reserve.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => Catalog.loaded && !document.body.classList.contains('catalog-unverified'));
    assert.equal(await page.locator('body').evaluate(body => body.classList.contains('booking-paused')),
      item.paused, item.label);
    assert.equal(await page.locator('#reserve-layout').isVisible(), !item.paused, `${item.label}：予約フォーム`);
    assert.deepEqual(errors, [], `${item.label}：JavaScriptエラーなし`);
    await context.close();
  }
  console.log('準備中・受付中の予約導線：両方の表示を確認しました。');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
