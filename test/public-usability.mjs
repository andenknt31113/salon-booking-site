import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const TEST_BROWSER = process.env.TEST_BROWSER || 'chromium';
const NEXT_CONTROL_KEY = TEST_BROWSER === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const browserType = engines[TEST_BROWSER];
assert.ok(browserType && typeof browserType.launch === 'function', '試験用のブラウザを確認できる');
const browser = await browserType.launch(TEST_BROWSER === 'chromium' && process.env.CHROMIUM
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

async function withPage(name, run, options = {}, setup, navigation = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP', ...options });
  const forbidden = [];
  const errors = [];
  await context.route('**/*', route => {
    const request = route.request();
    if (request.method() !== 'GET') { forbidden.push(request.method()); return route.abort(); }
    if (new URL(request.url()).origin !== base) {
      if (request.resourceType() !== 'document') forbidden.push(request.resourceType());
      return route.abort();
    }
    return route.continue();
  });
  if (setup) await setup(context);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/${name}.html`, navigation);
    await run(page);
    assert.deepEqual(forbidden, [], '閲覧で台帳の送信や外部SDKの読込を行わない');
    assert.deepEqual(errors, [], '操作中もJavaScriptエラーを出さない');
  } finally { await context.close(); }
}

const FILTERS = [
  { name: 'gallery', host: '#style-tabs', list: '#style-list .style-card', key: 'len',
    choice: '白髪ぼかし', label: 'スタイルの種類で絞り込む', init: 'initGalleryPage' },
  { name: 'menu', host: '#coupon-tabs', list: '#coupon-list .coupon', key: 'tag',
    choice: 'カラー', label: 'おすすめメニューの施術で絞り込む', init: 'initMenuPage' },
  { name: 'menu', host: '#menu-tabs', list: '#menu-list .menu-row', key: 'cat',
    label: '単品メニューの種類で絞り込む', init: 'initMenuPage' }
];

for (const filter of FILTERS) {
  test(`${filter.host}：選択を押下状態で伝え、再描画後も分類と操作位置を保つ`, () => withPage(filter.name, async page => {
    const group = page.locator(filter.host);
    const allCount = await page.locator(filter.list).count();
    const target = filter.choice
      ? group.locator(`button[data-${filter.key}="${filter.choice}"]`) : group.locator('button').nth(1);
    const selected = await target.getAttribute(`data-${filter.key}`);
    await target.focus();
    await page.keyboard.press('Space');
    const filteredCount = await page.locator(filter.list).count();
    assert.ok(filteredCount > 0 && filteredCount < allCount, 'キーボードから本当に一覧を絞り込める');
    assert.equal(await group.getAttribute('role'), 'group', '一覧の絞込みを不完全なタブとして読み上げない');
    assert.equal(await group.getAttribute('aria-label'), filter.label);
    assert.equal(await target.getAttribute('aria-pressed'), 'true');
    assert.equal(await group.locator('[role="tab"], [aria-selected]').count(), 0, '押下状態とタブの選択状態を混在させない');
    const before = await page.locator(filter.list).allTextContents();
    await page.evaluate(init => window[init](), filter.init);
    assert.deepEqual(await page.locator(filter.list).allTextContents(), before, '再描画で勝手にすべてへ戻らない');
    assert.equal(await group.locator('[aria-pressed="true"]').count(), 1, '押されている分類は一つだけ');
    const state = await target.evaluate(button => ({
      active: document.activeElement === button, pressed: button.getAttribute('aria-pressed'),
      width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height,
      background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color
    }));
    assert.ok(state.active && state.pressed === 'true', `再描画後も${selected}の操作位置を保つ`);
    assert.ok(state.width >= 44 && state.height >= 44, '分類の操作領域を小さくしない');
    assert.notEqual(state.background, 'rgba(0, 0, 0, 0)', '選択の見た目も消さない');
    const choices = await group.locator('button').evaluateAll((buttons, attribute) => buttons.map(button => button.getAttribute(attribute)), `data-${filter.key}`);
    await page.keyboard.press(NEXT_CONTROL_KEY);
    assert.equal(await page.evaluate(attribute => document.activeElement.getAttribute(attribute), `data-${filter.key}`),
      choices[choices.indexOf(selected) + 1], 'ブラウザ標準の次項目キーで隣の分類へ進める');
    await group.locator('button').first().click();
    assert.equal(await page.locator(filter.list).count(), allCount, 'すべてへ戻すと元の一覧を読める');
  }));
}

test('選んだ分類がなくなったらすべてへ戻し、空の一覧や消えた操作位置を残さない', () => withPage('gallery', async page => {
  const chosen = page.locator('#style-tabs button[data-len="白髪ぼかし"]');
  await chosen.focus();
  await page.keyboard.press('Space');
  const remaining = await page.evaluate(() => {
    SALON.styles = SALON.styles.filter(style => style.length !== '白髪ぼかし');
    initGalleryPage();
    return SALON.styles.length;
  });
  const all = page.locator('#style-tabs button').first();
  assert.equal(await all.getAttribute('aria-pressed'), 'true');
  assert.equal(await all.evaluate(button => document.activeElement === button), true);
  assert.equal(await page.locator('#style-list .style-card').count(), remaining);
  assert.ok(remaining > 0);
}));

test('FAQの質問と回答を結び付け、再描画しても開いた答えと操作位置を消さない', () => withPage('index', async page => {
  const question = page.locator('.faq-q').first();
  const answerId = await question.getAttribute('aria-controls');
  assert.ok(answerId, '質問ボタンから回答の欄が分かる');
  const answer = page.locator(`[id="${answerId}"]`);
  assert.equal(await answer.count(), 1, '回答のIDは一意');
  assert.equal(await answer.isVisible(), false);
  await question.focus();
  await page.keyboard.press('Enter');
  assert.equal(await answer.isVisible(), true);
  assert.equal(await question.getAttribute('aria-expanded'), 'true');
  const text = await answer.innerText();
  await page.evaluate(() => initHome());
  assert.equal(await answer.isVisible(), true, '同じ内容の再描画で読んでいた回答を閉じない');
  assert.equal(await answer.innerText(), text, '店舗の回答文を変更しない');
  assert.equal(await question.evaluate(button => document.activeElement === button), true);
  assert.equal(await question.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Space');
  assert.equal(await answer.isVisible(), false);
  assert.equal(await question.getAttribute('aria-expanded'), 'false');
}));

const PHOTO_CASES = [
  { name: 'index', selector: '.coupon', photo: '.coupon-photo', asset: 'style11.jpg', parts: ['h3', '.price-now', 'a'] },
  { name: 'menu', selector: '.coupon', photo: '.coupon-photo', asset: 'style11.jpg', parts: ['h3', '.price-now', 'a'] },
  { name: 'menu', selector: '.menu-row', photo: '.menu-row-photo', asset: 'style6.jpg', parts: ['.menu-row-name', '.menu-row-price', '.menu-row-meta'] }
];

for (const { name, selector, photo: photoSelector, asset, parts } of PHOTO_CASES) {
  for (const width of [390, 1280]) {
    test(`${name}・${selector}・${width}px：メニュー写真が遅れても料金と操作を動かさない`, async () => {
      let releasePhoto;
      const pendingPhoto = new Promise(resolve => { releasePhoto = resolve; });
      try {
        await withPage(name, async page => {
          const card = page.locator(selector).first();
          const photo = card.locator(photoSelector);
          const layout = () => card.evaluate((element, selectors) => [element, ...selectors.map(part => element.querySelector(part))].map(part => {
              const bounds = part.getBoundingClientRect();
              return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
            }), parts);
          assert.equal(await photo.evaluate(image => image.complete), false, '写真の到着前を確かめる');
          const before = await layout();
          releasePhoto();
          await photo.evaluate(image => image.complete && image.naturalWidth > 0
            ? Promise.resolve() : new Promise(resolve => image.addEventListener('load', resolve, { once: true })));
          await page.waitForFunction(selector => document.querySelector(selector)?.classList.contains('has-photo'), selector);
          const after = await layout();
          for (const [index, bounds] of before.entries()) {
            for (const key of Object.keys(bounds)) assert.ok(Math.abs(after[index][key] - bounds[key]) < 1,
              `読込完了でメニュー・見出し・料金・予約操作の${key}を動かさない`);
          }
          assert.equal(await photo.isVisible(), true, '写真自体も消さない');
          if (selector === '.coupon') assert.equal(await card.locator('a').getAttribute('href'), 'reserve.html?menu=sc0', '予約メニューを維持する');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }, { viewport: { width, height: 900 } }, context => context.route(`**/assets/${asset}`, async route => {
          await pendingPhoto;
          await route.continue();
        }), { waitUntil: 'domcontentloaded' });
      } finally { releasePhoto(); }
    });
  }
}

test('メニュー写真の取得に失敗しても壊れた画像や空の列を残さない', () => withPage('menu', async page => {
  const card = page.locator('.coupon').first();
  assert.equal(await card.locator('img').count(), 0);
  assert.equal(await card.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 1);
  assert.match(await card.innerText(), /6,900/);
  assert.equal(await card.locator('a').isVisible(), true);
}, {}, context => context.route('**/assets/style11.jpg', route => route.abort())));

for (const dimensions of [{ width: 480, height: 800 }, { width: 800, height: 300 }]) {
  test(`店内写真が${dimensions.width}×${dimensions.height}でも本文と写真名を重ねない`, () => withPage('index', async page => {
    const layout = await page.evaluate(() => {
      const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { photo: bounds('#home-photo'), image: bounds('#home-photo img'),
        caption: bounds('#home-photo figcaption'), copy: bounds('.hero-inner') };
    });
    assert.ok(layout.image.width > 0 && layout.image.height > 0);
    assert.ok(Math.abs(layout.photo.height - layout.image.height) < 1, '実写真の高さに枠を合わせ、余分な空白やはみ出しを作らない');
    assert.ok(layout.image.bottom <= layout.caption.top && layout.caption.bottom <= layout.copy.top, '写真名や店舗の文章を画像に重ねない');
    assert.ok(Math.abs(layout.image.width / layout.image.height - dimensions.width / dimensions.height) < 0.001, '異なる縦横比でも写真全体を表示する');
  }, {}, context => context.route('**/assets/shop2.jpg', route => route.fulfill({
    contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}"><rect width="100%" height="100%" fill="#eee"/></svg>`
  }))));
}
