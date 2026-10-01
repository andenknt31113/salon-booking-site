import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
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
    if (new URL(request.url()).origin !== base) {
      if (request.resourceType() !== 'document') forbidden.push(request.resourceType());
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/${name}.html`);
    await run(page);
    assert.deepEqual(forbidden, [], '写真集の閲覧で台帳の送信や外部素材の読込を行わない');
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

for (const name of ['index', 'gallery']) {
  for (const width of [320, 390, 768, 1280]) {
    test(`${name}・${width}px：写真集の章を揃え、写真・本文・予約操作を読める`, () => withPage(name, width, async page => {
      const collection = page.locator('.style-collection');
      assert.equal(await collection.count(), 1, '写真集の章を一つだけ設ける');
      assert.equal(await collection.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(23, 20, 15)');
      const cards = collection.locator('.style-card');
      assert.equal(await cards.count(), name === 'index' ? 4 : 12, '実際のスタイルを減らさない');
      for (const card of await cards.all()) {
        await card.locator('.style-thumb').scrollIntoViewIfNeeded();
        await page.waitForFunction(image => image.complete && image.naturalWidth > 0, await card.locator('img.ph-photo').elementHandle());
        const geometry = await card.evaluate(element => {
          const rectangle = selector => element.querySelector(selector).getBoundingClientRect().toJSON();
          const color = selector => getComputedStyle(element.querySelector(selector)).color;
          return { photo: rectangle('.style-thumb'), body: rectangle('.style-body'), booking: rectangle('.style-book'),
            title: color('.style-title'), meta: color('.style-meta'), bookingColor: color('.style-book') };
        });
        assert.ok(geometry.photo.width > 0 && geometry.photo.height > 0, '写真の枠を潰さない');
        assert.ok(geometry.photo.bottom <= geometry.body.top + 1, '写真と説明を重ねない');
        assert.ok(geometry.booking.width >= 44 && geometry.booking.height >= 44, '予約操作を小さくしない');
        for (const color of [geometry.title, geometry.meta, geometry.bookingColor]) {
          assert.ok(contrastRatio(color, 'rgb(23, 20, 15)') >= 4.5, '暗い章でも本文と操作を十分な明暗差で読める');
        }
        assert.equal(await card.locator('.style-book').getAttribute('href'), 'reserve.html');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '横はみ出しを作らない');
      if (process.env.TEST_ARTIFACT_DIR) {
        await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
        await collection.locator(name === 'index' ? '.section-head' : '.style-collection-tools').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `${name}-${width}.png`), fullPage: true });
        await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `${name}-${width}-detail.png`) });
      }
    }));
  }
}

test('一覧の件数を絞込みと揃え、キーボード操作・再描画・空の状態でも取り違えない', () => withPage('gallery', 390, async page => {
  const count = page.locator('#style-count');
  assert.equal(await count.getAttribute('role'), 'status');
  assert.equal(await count.getAttribute('aria-atomic'), 'true');
  assert.equal(await count.innerText(), '12スタイルを表示');
  const filter = page.locator('#style-tabs button[data-len="白髪ぼかし"]');
  await filter.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#style-list .style-card').count(), 2);
  assert.equal(await count.innerText(), '2スタイルを表示');
  const colors = await filter.evaluate(button => ({ foreground: getComputedStyle(button).color, background: getComputedStyle(button).backgroundColor }));
  assert.ok(contrastRatio(colors.foreground, colors.background) >= 4.5,
    `選択した瞬間も十分な明暗差で読める（${colors.foreground}／${colors.background}）`);
  await page.evaluate(() => initGalleryPage());
  assert.equal(await count.innerText(), '2スタイルを表示');
  assert.equal(await filter.evaluate(button => document.activeElement === button), true);
  await page.locator('#style-tabs button').first().click();
  assert.equal(await count.innerText(), '12スタイルを表示');
  await page.evaluate(() => { SALON.styles = []; initGalleryPage(); });
  assert.equal(await page.locator('#style-list .style-card').count(), 0);
  assert.equal(await count.innerText(), '0スタイルを表示', '写真がない時に以前の件数を残さない');
  assert.equal(await page.locator('.style-collection > .container > p a[href="reserve.html"]').isVisible(), true, '空でも予約への道を残す');
}));

test('JavaScriptなしでも写真と元の説明・予約リンクを暗い章で読める', () => withPage('gallery', 390, async page => {
  assert.equal(await page.locator('.style-collection .style-card').count(), 12);
  assert.ok((await page.locator('.style-title').first().innerText()).includes('ナチュラルセンターパート'));
  assert.equal(await page.locator('.style-book').count(), 12);
  assert.equal(await page.locator('#style-count').isVisible(), false, '確認できない件数の空欄を場所だけ確保しない');
  assert.equal(await page.locator('.style-collection').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(23, 20, 15)');
}, { javaScriptEnabled: false }));

for (const width of [320, 390]) {
  test(`${width}px：一覧の初期画面で写真が案内と固定の予約バーに埋もれない`, () => withPage('gallery', width, async page => {
    const photo = await page.locator('.style-thumb').first().boundingBox();
    const booking = await page.locator('.sp-cta').boundingBox();
    assert.ok(photo.width > 0 && photo.height > 0, '読込前から写真の領域を確保する');
    assert.ok(Math.min(photo.y + photo.height, booking.y) - photo.y >= 100,
      `初期画面で写真を100px以上見せる（写真上端${photo.y}、予約バー上端${booking.y}）`);
    const guide = await page.locator('.page-head > .container > p').last().innerText();
    assert.match(guide, /ご要望欄.*スタイル名/, '予約へスタイル名を引き継ぐことは説明に残す');
    assert.ok(await page.locator('#style-tabs button').count() > 1, '写真を見せるために分類を隠さない');
  }));
}
