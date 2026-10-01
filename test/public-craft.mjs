import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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

async function withPage(name, run, options = {}, setup) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo', ...options });
  const writes = [];
  const external = [];
  const errors = [];
  await context.route('**/*', route => {
    const request = route.request();
    if (request.method() !== 'GET') { writes.push(request.method()); return route.abort(); }
    if (new URL(request.url()).origin !== base) { external.push(request.resourceType()); return route.abort(); }
    return route.continue();
  });
  if (setup) await setup(context);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/${name}.html`);
    await run(page);
    assert.deepEqual(writes, [], 'デザイン・写真の閲覧ではAPIや台帳へ送信しない');
    assert.ok(external.every(type => type === 'document'), '地図以外の外部SDK・フォント・素材を追加しない');
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
  } finally { await context.close(); }
}

for (const width of [320, 390, 768, 1280]) {
  test(`${width}px：店の文章はそのままで、主見出しと補足の強弱を付ける`, () => withPage('index', async page => {
    const type = await page.locator('#hero-catch').evaluate(heading => ({
      text: heading.textContent,
      lead: parseFloat(getComputedStyle(heading.children[0]).fontSize),
      supporting: parseFloat(getComputedStyle(heading.children[2]).fontSize),
      spans: [...heading.children].map(span => ({ box: span.getBoundingClientRect().toJSON(), width: span.scrollWidth })),
      box: heading.getBoundingClientRect().toJSON()
    }));
    assert.equal(type.text, 'イタリア発、東京経由。伝統と研ぎ澄まされた技術が生む、本格バーバーを日常に');
    assert.ok(type.lead >= type.supporting * 1.8, '最初の一文を視覚の主役にする');
    assert.ok(type.spans.every(span => span.box.right <= type.box.right + 1 && span.width <= span.box.width + 1), '大きい文字を途中で切らない');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('.hero a[href="reserve.html"]').isVisible(), true);
    if (process.env.TEST_ARTIFACT_DIR) {
      await mkdir(process.env.TEST_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.TEST_ARTIFACT_DIR, `home-top-${width}.png`) });
    }
  }, { viewport: { width, height: 900 } }));
}

for (const name of ['index', 'gallery']) {
  test(`${name}：写真を大きく見て閉じても一覧の操作位置へ戻る`, () => withPage(name, async page => {
    const button = page.locator('.style-photo-open').first();
    await button.scrollIntoViewIfNeeded();
    await button.waitFor({ state: 'visible' });
    const photo = page.locator('.style-thumb img.ph-photo').first();
    const source = await photo.getAttribute('src');
    const position = await page.evaluate(() => scrollY);
    await button.focus();
    await button.press('Enter');
    const dialog = page.locator('.style-photo-dialog');
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('aria-labelledby'), 'style-photo-title');
    assert.equal(await dialog.locator('img').getAttribute('src'), source, '元の写真を使い、作り物や別の写真に置き換えない');
    assert.equal(await dialog.locator('img').evaluate(image => getComputedStyle(image).objectFit), 'contain', '拡大では髪の全体を切らずに見せる');
    const close = dialog.getByRole('button', { name: '閉じる', exact: true });
    assert.equal(await close.evaluate(element => document.activeElement === element), true);
    await close.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement === document.body
      || !!document.activeElement.closest('.style-photo-dialog')), true, '背景ではなくダイアログかブラウザの操作へ移る');
    assert.equal(await page.locator('.style-book').first().evaluate(element => {
      element.focus();
      return document.activeElement === element;
    }), false, '標準ダイアログが背景の操作を無効にする');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await button.evaluate(element => document.activeElement === element), true);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - position) <= 1, '閉じても一覧の位置を変えない');
    assert.notEqual(await page.locator('body').evaluate(element => getComputedStyle(element).overflow), 'hidden', '背景のスクロールも元へ戻す');
    await button.click();
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.style-photo-dialog').count(), 0);
  }));
}

for (const name of ['gallery', 'menu', 'staff', 'reviews']) {
  test(`${name}：PCでは見出しと案内を並べ、スマホでは読み順に積む`, () => withPage(name, async page => {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const heading = await page.locator('.page-head h1').boundingBox();
      const guide = await page.locator('.page-head h1 + p').boundingBox();
      assert.ok(width > 1000 ? heading.x + heading.width <= guide.x : heading.y + heading.height <= guide.y,
        '見出しと案内を重ねず、画面幅に合わせて読みやすく配置する');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
  }));
}

test('再初期化・絞込みでも写真の操作を重複させない', () => withPage('gallery', async page => {
  const first = page.locator('.style-photo-open').first();
  await first.scrollIntoViewIfNeeded();
  await first.waitFor({ state: 'visible' });
  await page.evaluate(() => { initGalleryPage(); initGalleryPage(); });
  assert.equal(await page.locator('.style-photo-open').count(), await page.locator('.style-thumb img.ph-photo').count());
  await page.locator('#style-tabs .tab').nth(1).click();
  assert.equal(await page.locator('.style-photo-open').count(), await page.locator('.style-thumb img.ph-photo').count());
  await page.locator('.style-photo-open').first().click();
  assert.equal(await page.locator('.style-photo-dialog').count(), 1);
}));

test('ダイアログ非対応・JavaScriptなしでも写真と予約導線を残す', async () => {
  await withPage('gallery', async page => {
    assert.ok(await page.locator('.style-thumb img.ph-photo').count() > 0);
    assert.equal(await page.locator('.style-photo-open').count(), 0);
    assert.equal(await page.locator('.style-book').first().isVisible(), true);
    await page.locator('.style-keywords summary').first().click();
    assert.match(await page.locator('.style-keywords').first().innerText(), /#メンズヘア/);
  }, { javaScriptEnabled: false });
  await withPage('gallery', async page => {
    await page.evaluate(() => {
      document.querySelectorAll('.style-photo-open').forEach(button => button.remove());
      HTMLDialogElement.prototype.showModal = undefined;
      wireStylePhotos();
    });
    assert.equal(await page.locator('.style-photo-open').count(), 0);
    assert.equal(await page.locator('.style-book').first().isVisible(), true);
  });
});

test('写真の名前にHTMLが含まれても実行せず、文字として表示する', () => withPage('gallery', async page => {
  const button = page.locator('.style-photo-open').first();
  await button.scrollIntoViewIfNeeded();
  await button.waitFor({ state: 'visible' });
  const title = '<img src="x" onerror="window.写真試験 = true">';
  await page.locator('.style-title').first().evaluate((element, text) => { element.textContent = text; }, title);
  await button.click();
  assert.equal(await page.locator('#style-photo-title').innerText(), title);
  assert.equal(await page.locator('#style-photo-title img').count(), 0);
  assert.equal(await page.evaluate(() => window.写真試験), undefined);
}));

test('説明文は隠さず、関連キーワードは標準の折りたたみで選んで読める', () => withPage('index', async page => {
  const card = page.locator('.style-card').first();
  assert.match(await card.innerText(), /癖毛の方は曲がる縮毛矯正/);
  const keywords = card.locator('.style-keywords');
  assert.equal(await keywords.getAttribute('open'), null);
  const summary = keywords.locator('summary');
  assert.ok((await summary.boundingBox()).height >= 44);
  await summary.focus();
  await summary.press('Enter');
  assert.match(await keywords.innerText(), /#メンズ縮毛矯正/);
  await page.evaluate(() => initHome());
  assert.notEqual(await keywords.getAttribute('open'), null, '同じ初期化では開いたキーワードを閉じない');
  await summary.press('Space');
  assert.equal(await keywords.getAttribute('open'), null);
}));

test('絞り込みの選択状態を読み上げへ伝え、失敗した写真の拡大操作は出さない', () => withPage('gallery', async page => {
  assert.equal(await page.locator('#style-tabs').getAttribute('aria-label'), 'スタイルの種類で絞り込む');
  const filter = page.locator('#style-tabs button').nth(1);
  await filter.click();
  assert.equal(await filter.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#style-tabs button[aria-pressed="true"]').count(), 1);
  const firstCard = page.locator('.style-card').first();
  await firstCard.scrollIntoViewIfNeeded();
  await firstCard.locator('img.ph-photo').waitFor({ state: 'detached' });
  assert.equal(await firstCard.locator('.style-photo-open').isVisible(), false);
  assert.equal(await firstCard.locator('.style-book').isVisible(), true);
}, {}, context => context.route('**/style1.jpg', route => route.abort())));

test('320px・高さ320px・動きを減らす設定でも写真を閉じる操作が画面内に収まる', () => withPage('gallery', async page => {
  const button = page.locator('.style-photo-open').first();
  await button.click();
  const dialog = page.locator('.style-photo-dialog');
  const close = dialog.getByRole('button', { name: '閉じる', exact: true });
  const box = await close.boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 320 && box.y + box.height <= 320);
  assert.ok(box.height >= 44);
  assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await close.click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await button.evaluate(element => document.activeElement === element), true);
}, { viewport: { width: 320, height: 320 }, reducedMotion: 'reduce' }));
