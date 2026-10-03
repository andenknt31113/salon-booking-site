import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMockHandler } from './mock-gas.mjs';

const TEST_BROWSER = process.env.TEST_BROWSER || 'chromium';
const engines = await import(process.env.PLAYWRIGHT || 'playwright');
const browserType = engines[TEST_BROWSER];
assert.ok(browserType && typeof browserType.launch === 'function', '試験用ブラウザを確認できる');
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

async function withPage(name, width, run, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'ja-JP', ...options });
  const forbidden = [];
  const errors = [];
  await context.route('**/*', route => {
    const request = route.request();
    if (request.method() !== 'GET') { forbidden.push(request.method()); return route.abort(); }
    if (new URL(request.url()).origin !== base) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/${name}.html`);
    if (process.env.TEST_ARTIFACT_DIR) {
      await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
      const content = page.locator(name === 'menu' ? '#coupon-list' : '.staff-card');
      await content.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `${name}-${width}-detail.png`) });
    }
    await run(page);
    assert.deepEqual(forbidden, [], '紹介・メニューの閲覧で台帳へ送信しない');
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
  } finally { await context.close(); }
}

function contrastRatio(foreground, background) {
  const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(channel => Number(channel) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

for (const width of [320, 390, 768, 1280]) {
  test(`${width}px：料金表と施術の選択を並べ、実際の金額・所要・予約先を保つ`, () => withPage('menu', width, async page => {
    assert.equal(await page.locator('#coupon-count').innerText(), '14メニューを表示');
    assert.equal(await page.locator('#menu-count').innerText(), '9メニューを表示');
    for (const section of ['recommended', 'single']) {
      const tools = await page.locator(`#${section} .menu-tools`).boundingBox();
      const list = await page.locator(section === 'recommended' ? '#coupon-list' : '#menu-list').boundingBox();
      if (width > 1000) {
        assert.ok(tools.x + tools.width <= list.x, '広い画面では分類を左、料金表を右へ分ける');
        const title = await page.locator(`#${section} .section-head`).boundingBox();
        assert.ok(Math.abs(list.y - title.y) <= 1, '料金表を分類の下まで押し下げない');
      } else assert.ok(tools.y + tools.height <= list.y + 1, '狭い画面では分類の下に料金表を置く');
    }
    const expected = await page.evaluate(() => SALON.coupons.map(menu => ({
      price: menu.price ? yen(menu.price) + (menu.priceFrom ? '〜' : '') + '（税込）' : 'カウンセリングでお見積り',
      duration: '所要 約' + formatDuration(menu.minutes), href: 'reserve.html?menu=' + encodeURIComponent(menu.id)
    })));
    const actual = await page.locator('#coupon-list .coupon').evaluateAll(cards => cards.map(card => ({
      price: card.querySelector('.price-now').textContent.trim(), duration: card.querySelector('.price-min').textContent.trim(),
      href: card.querySelector('a').getAttribute('href')
    })));
    assert.deepEqual(actual, expected, '金額・相談表示・所要時間・予約IDを変えない');
    const first = page.locator('#coupon-list .coupon').first();
    const title = await first.locator('h3').boundingBox();
    const price = await first.locator('.coupon-price').boundingBox();
    assert.ok(width > 700 ? title.x + title.width <= price.x : title.y + title.height <= price.y,
      '料金と名前を重ねない');
    const booking = await first.locator('a').boundingBox();
    assert.ok(booking.width >= 44 && booking.height >= 44, '予約の操作領域を保つ');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const photo = first.locator('.coupon-photo');
    await photo.scrollIntoViewIfNeeded();
    await page.waitForFunction(image => image.complete && image.naturalWidth > 0, await photo.elementHandle());
    assert.ok((await photo.boundingBox()).width > 0, '料金表にも既存の実写真を表示する');
    if (process.env.TEST_ARTIFACT_DIR) {
      await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `menu-${width}-ready.png`) });
    }
  }));

  test(`${width}px：人物紹介の名前と本文に強弱をつけ、本人の紹介文を項目で読める`, () => withPage('staff', width, async page => {
    const card = page.locator('.staff-card');
    const photo = card.locator('.avatar img');
    await photo.scrollIntoViewIfNeeded();
    await page.waitForFunction(image => image.complete && image.naturalWidth > 0, await photo.elementHandle());
    const source = await page.evaluate(() => ({ ...SALON.staff[0] }));
    assert.equal(await photo.getAttribute('src'), source.image, '既存の実写真を残す');
    assert.equal(await card.locator('.staff-message > p').innerText(), source.message, '紹介文を勝手に書き換えない');
    const details = card.locator('.staff-details');
    assert.deepEqual(await details.locator('dt').allTextContents(), ['得意な技術', '趣味・マイブーム']);
    assert.deepEqual(await details.locator('dd').allTextContents(), [source.skills, source.hobby]);
    const layout = await card.evaluate(element => {
      const rectangle = selector => element.querySelector(selector).getBoundingClientRect().toJSON();
      return { portrait: rectangle('.avatar'), body: rectangle('.staff-body'),
        nameSize: parseFloat(getComputedStyle(element.querySelector('.staff-name')).fontSize) };
    });
    assert.ok(layout.nameSize >= (width > 700 ? 56 : 40), '人物名をプロフィールの主見出しとして見せる');
    assert.ok(layout.portrait.width > 0 && layout.portrait.height > 0, '写真を潰さない');
    assert.ok(width > 700 ? layout.portrait.right <= layout.body.left : layout.portrait.bottom <= layout.body.top,
      '人物写真と文章を重ねない');
    for (const row of await details.locator(':scope > div').all()) {
      const label = await row.locator('dt').boundingBox();
      const description = await row.locator('dd').boundingBox();
      assert.ok(label.x + label.width <= description.x + 1 || label.y + label.height <= description.y + 1,
        '項目名と本文が重ならない');
    }
    const booking = card.locator('a[href^="reserve.html?staff="]');
    assert.equal(await booking.getAttribute('href'), 'reserve.html?staff=' + source.id);
    assert.ok((await booking.boundingBox()).height >= 44, '人物の予約操作も押しやすくする');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.TEST_ARTIFACT_DIR) await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `staff-${width}.png`), fullPage: true });
  }));
}

for (const width of [320, 390, 1280]) {
  test(`${width}px：料金一覧をコンパクトにし、名前・条件・写真・予約先を省かない`, () => withPage('menu', width, async page => {
    const cards = page.locator('#coupon-list .coupon');
    const metrics = await cards.evaluateAll(elements => {
      const bounds = elements.map(element => element.getBoundingClientRect());
      const first = elements[0];
      const title = getComputedStyle(first.querySelector('h3'));
      const price = getComputedStyle(first.querySelector('.price-now'));
      const photo = first.querySelector('.coupon-photo').getBoundingClientRect();
      return { firstThreeHeight: bounds[2].bottom - bounds[0].top,
        paddingTop: parseFloat(getComputedStyle(first).paddingTop),
        nameSize: parseFloat(title.fontSize), nameLineHeight: parseFloat(title.lineHeight),
        priceSize: parseFloat(price.fontSize), photoWidth: photo.width, photoHeight: photo.height };
    });
    assert.ok(metrics.paddingTop <= 22, '情報より余白が大きくならない');
    assert.ok(metrics.nameSize >= 14 && metrics.nameSize <= 15);
    assert.ok(metrics.nameLineHeight <= metrics.nameSize * 1.6);
    assert.ok(metrics.priceSize >= 20 && metrics.priceSize <= 22);
    assert.ok(metrics.photoWidth >= 64 && metrics.photoHeight >= 80, '既存の写真を消さない');
    assert.equal(await cards.count(), 14);
    for (const card of await cards.all()) {
      assert.ok((await card.locator('h3').innerText()).trim());
      assert.ok(await card.locator('.coupon-badge').isVisible());
      assert.ok(await card.locator('.price-min').isVisible());
      const action = await card.locator('a').boundingBox();
      assert.ok(action.width >= 44 && action.height >= 44);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.TEST_ARTIFACT_DIR) await writeFile(join(process.env.TEST_ARTIFACT_DIR, `menu-density-${width}.json`),
      JSON.stringify(metrics, null, 2));
  }));
}

for (const type of ['coupon', 'menu']) {
  test(`${type}：件数を絞込み・再描画・空の一覧と揃え、フォーカスを奪わない`, () => withPage('menu', 390, async page => {
    const count = page.locator(`#${type}-count`);
    const group = page.locator(`#${type}-tabs`);
    const list = page.locator(type === 'coupon' ? '#coupon-list .coupon' : '#menu-list .menu-row');
    const total = await list.count();
    assert.equal(await count.getAttribute('role'), 'status');
    assert.equal(await count.getAttribute('aria-atomic'), 'true');
    assert.equal(await count.innerText(), `${total}メニューを表示`);
    const target = group.locator('button').nth(1);
    await target.focus();
    await page.keyboard.press('Enter');
    const selectedCount = await list.count();
    assert.ok(selectedCount > 0 && selectedCount < total);
    assert.equal(await count.innerText(), `${selectedCount}メニューを表示`);
    await page.evaluate(() => initMenuPage());
    assert.equal(await count.innerText(), `${selectedCount}メニューを表示`);
    assert.equal(await target.evaluate(button => document.activeElement === button), true);
    const mutations = await count.evaluate(element => {
      const records = [];
      const observer = new MutationObserver(changes => records.push(...changes));
      observer.observe(element, { childList: true, characterData: true, subtree: true });
      initMenuPage();
      records.push(...observer.takeRecords());
      observer.disconnect();
      return records.length;
    });
    assert.equal(mutations, 0, '同じ件数を何度も読み上げ直さない');
    await page.evaluate(type => {
      if (type === 'coupon') SALON.coupons = [];
      else SALON.menuCategories = [];
      initMenuPage();
    }, type);
    assert.equal(await list.count(), 0);
    assert.equal(await count.innerText(), '0メニューを表示', '空になったら古い件数を残さない');
  }));
}

test('メニュー分類の選択直後も、文字と背景を十分な明暗差で読める', () => withPage('menu', 390, async page => {
  for (const id of ['coupon-tabs', 'menu-tabs']) {
    const button = page.locator(`#${id} button`).nth(1);
    await button.focus();
    await page.keyboard.press('Enter');
    const colors = await button.evaluate(element => ({ text: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    assert.ok(contrastRatio(colors.text, colors.background) >= 4.5, '色が切り替わる瞬間も文字を消さない');
  }
}));

test('JavaScriptなしでも人物写真・紹介の項目・予約先を表示する', () => withPage('staff', 390, async page => {
  assert.equal(await page.locator('.staff-details dt').count(), 2);
  assert.match(await page.locator('.staff-details dd').first().innerText(), /白髪ぼかし/);
  const photo = page.locator('.avatar img');
  await photo.scrollIntoViewIfNeeded();
  await page.waitForFunction(image => image.complete && image.naturalWidth > 0, await photo.elementHandle());
  assert.ok((await photo.boundingBox()).height > 0);
  assert.equal(await page.locator('.staff-card a').getAttribute('href'), 'reserve.html?staff=st01');
}, { javaScriptEnabled: false }));

test('JavaScriptなしの料金表で未確認の件数を出さず、14コースと9単品を残す', () => withPage('menu', 390, async page => {
  assert.equal(await page.locator('#coupon-list .coupon').count(), 14);
  assert.equal(await page.locator('#menu-list .menu-row').count(), 9);
  for (const id of ['coupon-count', 'menu-count']) assert.equal(await page.locator(`#${id}`).isVisible(), false);
  for (const tools of await page.locator('.menu-tools').all()) assert.equal(await tools.isVisible(), false, '動かせない分類の空欄を残さない');
  assert.equal(await page.locator('.page-jump a').count(), 2);
}, { javaScriptEnabled: false }));

test('紹介の任意項目がないときは空の見出しを作らず、入力をHTMLとして動かさない', () => withPage('staff', 390, async page => {
  await page.evaluate(() => {
    SALON.staff[0].skills = '';
    SALON.staff[0].hobby = '<img src=x onerror=alert(1)>';
    initStaffPage();
  });
  assert.deepEqual(await page.locator('.staff-details dt').allTextContents(), ['趣味・マイブーム']);
  assert.equal(await page.locator('.staff-details dd').innerText(), '<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('.staff-details img').count(), 0);
  await page.evaluate(() => { SALON.staff[0].hobby = ''; initStaffPage(); });
  assert.equal(await page.locator('.staff-details').count(), 0);
  assert.equal(await page.locator('.staff-card a').isVisible(), true);
}));
