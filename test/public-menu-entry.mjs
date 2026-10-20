import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { mockBookingState } from './booking-state-fixture.mjs';

const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const browserName = process.env.TEST_BROWSER || 'chromium';
const browser = await engines[browserName].launch(browserName === 'chromium' && process.env.CHROMIUM
  ? { executablePath: process.env.CHROMIUM } : {});
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

async function withPage(name, width, run, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'ja-JP', ...options });
  const unexpected = [];
  const errors = [];
  let published;
  await context.route('**/*', async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== base) return route.abort();
    if (request.method() !== 'GET') {
      const operation = request.postDataJSON()?.type;
      if (!['menu', 'availability'].includes(operation)) {
        unexpected.push(operation);
        return route.abort();
      }
      if (operation === 'menu' && published) {
        const response = await route.fetch();
        const catalog = await response.json();
        catalog.categories = published.map(category => ({ ...category,
          items: category.items.map(item => ({ ...item, id: 'live-' + item.id })) }));
        catalog.settings['準備中の帯'] = '出さない';
        return route.fulfill({ response, json: catalog });
      }
    }
    return route.continue();
  });
  if (options.javaScriptEnabled !== false) await mockBookingState(context, { approved: true, draft: false });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/${name}.html`);
    if (name === 'menu' && options.javaScriptEnabled !== false) published = await page.evaluate(() => SALON.menuCategories);
    await run(page);
    assert.deepEqual(unexpected, [], '閲覧・事前選択で照会や予約を送信しない');
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  } finally { await context.close(); }
}

for (const width of [320, 390, 1280]) {
  test(`${width}px：単品メニューの行から予約でき、最新メニューのID変更後も選択を保つ`, () => withPage('menu', width, async page => {
    const rows = page.locator('#menu-list .menu-row');
    assert.equal(await rows.count(), 9);
    const source = await page.evaluate(() => allMenuItems().map(item => ({ id: item.id, name: item.name,
      note: item.note || '', price: item.price ? yen(item.price) + (item.priceFrom ? '〜' : '') : 'お見積り',
      duration: '約' + formatDuration(item.minutes) })));
    for (const [index, row] of (await rows.all()).entries()) {
      assert.equal(await row.evaluate(element => element.tagName), 'A', '写真・説明・料金の行全体から選べる');
      assert.equal(await row.getAttribute('href'), 'reserve.html?menu=' + encodeURIComponent(source[index].id));
      assert.equal(await row.locator('.menu-row-name').innerText(), source[index].name);
      assert.equal(await row.locator('.menu-row-price').innerText(), source[index].price);
      assert.equal(await row.locator('.menu-row-time').innerText(), source[index].duration);
      if (source[index].note) assert.equal(await row.locator('.menu-row-note').innerText(), source[index].note);
      assert.equal(await row.locator('.menu-row-action').innerText(), 'このメニューで予約');
      const bounds = await row.boundingBox();
      assert.ok(bounds.width >= 44 && bounds.height >= 44, '行の操作範囲を小さくしない');
    }
    const first = rows.first();
    await first.focus();
    const focus = await first.evaluate(element => ({ style: getComputedStyle(element).outlineStyle,
      width: parseFloat(getComputedStyle(element).outlineWidth) }));
    assert.ok(focus.style !== 'none' && focus.width > 0, 'キーボードの操作位置が見える');
    await Promise.all([
      page.waitForURL(url => url.pathname === '/reserve.html', { waitUntil: 'domcontentloaded' }),
      first.press('Enter')
    ]);
    await page.waitForFunction(() => Catalog.loaded && Remote.loaded);
    assert.equal(await page.evaluate(() => state.couponId), null, 'おすすめメニューを勝手に選ばない');
    assert.deepEqual(await page.evaluate(() => selectedMenus().map(menu => ({ id: menu.id, name: menu.name }))),
      [{ id: 'live-' + source[0].id, name: source[0].name }]);
    assert.equal(await page.locator('#menu-choices [aria-pressed="true"]').count(), 1);
    await page.locator('#to-staff').click();
    assert.equal(await page.evaluate(() => state.step), 3, '担当が一人なら選び直さず日時へ進める');
  }));
}

test('JavaScriptが無効でも全単品メニューから該当する予約URLへ進める', () => withPage('menu', 320, async page => {
  const rows = page.locator('#menu-list .menu-row');
  assert.equal(await rows.count(), 9);
  for (const row of await rows.all()) {
    assert.equal(await row.evaluate(element => element.tagName), 'A');
    assert.match(await row.getAttribute('href'), /^reserve\.html\?menu=.+/);
    assert.equal(await row.locator('.menu-row-action').innerText(), 'このメニューで予約');
  }
}, { javaScriptEnabled: false }));

for (const width of [390, 1280]) {
  test(`${width}px：トップは本人の紹介文を保って短くし、詳しいプロフィールへ進める`, () => withPage('index', width, async page => {
    const card = page.locator('#home-staff .staff-card');
    const source = await page.evaluate(() => SALON.staff[0]);
    assert.equal(await card.locator('.staff-message > p').innerText(), source.message);
    assert.equal(await card.locator('.staff-details').count(), 0, '長い技術・趣味の紹介をトップへ重複掲載しない');
    const profile = card.getByRole('link', { name: 'プロフィールを見る', exact: true });
    assert.equal(await profile.getAttribute('href'), 'staff.html');
    assert.ok((await profile.boundingBox()).height >= 44);
    assert.equal(await card.locator('a[href^="reserve.html?staff="]').getAttribute('href'), 'reserve.html?staff=' + source.id);
    await profile.click();
    assert.equal(await page.locator('#staff-list .staff-message > p').innerText(), source.message);
    assert.deepEqual(await page.locator('#staff-list .staff-details dd').allTextContents(), [source.skills, source.hobby]);
  }));
}

test('初期HTMLもトップの紹介を短く保ち、詳しい紹介文を消さない', () => withPage('index', 390, async page => {
  assert.equal(await page.locator('#home-staff .staff-details').count(), 0);
  const profile = page.locator('#home-staff').getByRole('link', { name: 'プロフィールを見る', exact: true });
  await profile.click();
  assert.equal(await page.locator('#staff-list .staff-details dd').count(), 2);
}, { javaScriptEnabled: false }));

test('地図の下で表示済みと断定せず、埋込みなしの案内も重複させない', () => withPage('index', 390, async page => {
  assert.equal(await page.locator('#home-access iframe').count(), 1);
  assert.equal(await page.locator('#home-access .map-note').count(), 0, '外部リンクと同じ説明を繰り返さない');
  await page.evaluate(() => { SALON.mapEmbedUrl = ''; initHome(); });
  assert.equal(await page.locator('#home-access iframe').count(), 0);
  assert.equal(await page.locator('#home-access .map-note').count(), 1);
  assert.doesNotMatch(await page.locator('#home-access').innerText(), /表示しています/);
  assert.equal(await page.locator('#home-access .map-actions a').count(), 2, '地図がなくても場所と経路を調べられる');
}));

test('受付停止時も単品の予約先を残し、受付中と誤表示しない', () => withPage('menu', 390, async page => {
  await page.evaluate(() => { SALON.draft = true; initMenuPage(); });
  const rows = page.locator('#menu-list .menu-row');
  for (const row of await rows.all()) {
    assert.equal(await row.locator('.menu-row-action').innerText(), '予約について');
    assert.match(await row.getAttribute('href'), /^reserve\.html\?menu=.+/);
  }
}));
