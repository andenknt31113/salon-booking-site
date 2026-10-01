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
assert.ok(browserType && typeof browserType.launch === 'function', 'TEST_BROWSERの試験用ブラウザが利用できる');
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
    await page.goto(`${base}/${name}.html`, navigation);
    await run(page);
    assert.deepEqual(writes, [], 'デザイン・写真の閲覧ではAPIや台帳へ送信しない');
    assert.ok(external.every(type => type === 'document'), '地図以外の外部SDK・フォント・素材を追加しない');
    assert.deepEqual(errors, [], 'JavaScriptエラーなし');
  } finally { await context.close(); }
}

for (const width of [320, 390]) {
  test(`${width}px：最初に店内全体が見え、文章と予約操作を重ねない`, () => withPage('index', async page => {
    const layout = await page.evaluate(() => {
      const photo = document.querySelector('#home-photo img');
      const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return {
        photo: bounds('#home-photo'), image: bounds('#home-photo img'), copy: bounds('.hero-inner'), caption: bounds('#home-photo figcaption'),
        container: bounds('.hero'),
        booking: bounds('.sp-cta'), fit: getComputedStyle(photo).objectFit,
        actual: { width: photo.naturalWidth, height: photo.naturalHeight },
        declared: { width: Number(photo.getAttribute('width')), height: Number(photo.getAttribute('height')) }
      };
    });
    assert.ok(layout.photo.top >= 0 && layout.photo.bottom <= layout.booking.top, '初期画面で店内写真の全体を見せ、固定の予約案内で隠さない');
    assert.ok(layout.photo.width >= layout.container.width - 1 && layout.photo.height > 0, '写真の幅や高さをゼロへ潰さない');
    assert.ok(layout.image.width >= layout.photo.width - 1 && layout.image.height >= layout.photo.height - 1, '画像自体も写真の領域全体へ表示する');
    assert.ok(layout.caption.bottom <= layout.copy.top, '写真名と店の文章を重ねない');
    assert.ok(layout.caption.width > layout.caption.height, '写真名を一文字ずつ縦に折り返さない');
    assert.equal(layout.fit, 'contain', 'スマホで椅子や店内の端を切らずに見せる');
    assert.deepEqual(layout.declared, layout.actual, '初期HTMLと初期化後の画像寸法を実写真に合わせる');
    assert.ok(Math.abs(layout.photo.width / layout.photo.height - layout.actual.width / layout.actual.height) < 0.001);
    assert.equal(await page.locator('#home-styles .style-card').count(), 4, 'ヘアスタイルの実写真は4点とも残す');
    assert.equal(await page.locator('.sp-cta a[href="reserve.html"]').isVisible(), true);
    assert.ok(layout.booking.height >= 44, '予約への操作は常に押せる大きさを残す');
  }, { viewport: { width, height: 844 } }));

  test(`${width}px：JavaScriptなしでも写真を先に見せ、店舗の文章とリンクを残す`, () => withPage('index', async page => {
    const photo = await page.locator('#home-photo').boundingBox();
    const copy = await page.locator('.hero-inner').boundingBox();
    const container = await page.locator('.hero').boundingBox();
    assert.ok(photo.width >= container.width - 1 && photo.height > 0, 'JavaScriptなしでも写真を実際に見える大きさにする');
    assert.ok(photo.y + photo.height <= copy.y, '写真を表示後のJavaScriptで並べ替えない');
    assert.equal(await page.locator('#home-photo img').evaluate(image => image.complete && image.naturalWidth > 0), true);
    assert.equal(await page.locator('#hero-catch').textContent(), 'イタリア発、東京経由。伝統と研ぎ澄まされた技術が生む、本格バーバーを日常に');
    assert.equal(await page.locator('.hero a[href="reserve.html"]').isVisible(), true);
    assert.equal(await page.locator('.hero a[href="menu.html"]').isVisible(), true);
  }, { viewport: { width, height: 844 }, javaScriptEnabled: false }));
}

test('店内写真の読込が遅くても、写真・文章の順番と位置を変えない', async () => {
  let releasePhoto;
  const pendingPhoto = new Promise(resolve => { releasePhoto = resolve; });
  try {
    await withPage('index', async page => {
      const layout = () => page.evaluate(() => {
        const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { photo: bounds('#home-photo'), copy: bounds('.hero-inner') };
      });
      const before = await layout();
      const container = await page.locator('.hero').boundingBox();
      assert.ok(before.photo.width >= container.width - 1 && before.photo.height > 0, '画像の読込前も幅と高さを確保する');
      assert.equal(await page.locator('#home-photo img').evaluate(image => image.complete), false);
      assert.ok(before.photo.bottom <= before.copy.top, '読み込み中から写真の位置を確保する');
      releasePhoto();
      await page.waitForFunction(() => {
        const image = document.querySelector('#home-photo img');
        return image?.complete && image.naturalWidth > 0;
      });
      assert.deepEqual(await layout(), before, '画像の到着で文章や予約ボタンを動かさない');
    }, {}, context => context.route('**/shop2.jpg', async route => {
      await pendingPhoto;
      await route.continue();
    }), { waitUntil: 'domcontentloaded' });
  } finally { releasePhoto(); }
});

for (const name of ['index', 'gallery']) {
  test(`${name}：写真到着前は拡大操作を隠し、読込が終わってから案内する`, async () => {
    let releasePhoto;
    const pendingPhoto = new Promise(resolve => { releasePhoto = resolve; });
    try {
      await withPage(name, async page => {
        const card = page.locator('.style-card').first();
        const button = card.locator('.style-photo-open');
        await card.scrollIntoViewIfNeeded();
        assert.deepEqual(await button.evaluate(element => ({ opacity: getComputedStyle(element).opacity,
          pointer: getComputedStyle(element).pointerEvents, hidden: element.getAttribute('aria-hidden') })),
          { opacity: '0', pointer: 'none', hidden: 'true' }, '使えない拡大案内を目・クリック・読み上げに出さない');
        assert.equal(await button.isDisabled(), true, 'まだ届いていない写真を開けない');
        const text = await card.locator('.style-body').innerText();
        const size = await button.evaluate(element => element.getBoundingClientRect().toJSON());
        await button.evaluate(element => element.click());
        assert.equal(await page.locator('.style-photo-dialog').count(), 0);
        releasePhoto();
        await page.waitForFunction(() => {
          const photo = document.querySelector('.style-card img.ph-photo');
          return photo?.complete && photo.naturalWidth > 0;
        });
        await button.waitFor({ state: 'visible' });
        await page.waitForFunction(button => !button.disabled, await button.elementHandle());
        assert.equal(await button.isEnabled(), true);
        assert.deepEqual(await button.evaluate(element => ({ opacity: getComputedStyle(element).opacity,
          pointer: getComputedStyle(element).pointerEvents, hidden: element.getAttribute('aria-hidden') })),
          { opacity: '1', pointer: 'auto', hidden: null }, '写真到着後に実際に見えて操作できる案内にする');
        assert.equal(await card.locator('.style-body').innerText(), text, '到着後も一覧の案内・本文を差し替えない');
        assert.deepEqual(await button.evaluate(element => element.getBoundingClientRect().toJSON()), size,
          '到着前後で操作の位置を変えない');
        await button.click();
        assert.equal(await page.locator('.style-photo-dialog').count(), 1);
        await page.getByRole('button', { name: '閉じる', exact: true }).click();
        await page.locator('.style-photo-dialog').waitFor({ state: 'detached' });
        assert.equal(await button.evaluate(element => document.activeElement === element), true);
      }, {}, context => context.route('**/style1.jpg', async route => {
        await pendingPhoto;
        await route.continue();
      }), { waitUntil: 'domcontentloaded' });
    } finally { releasePhoto(); }
  });
}

test('スマホの境界をまたいで幅を変えても、写真1点を保ち、文章と操作を重ねない', () => withPage('index', async page => {
  for (const width of [700, 701, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { photo: bounds('#home-photo'), copy: bounds('.hero-inner'), container: bounds('.hero'),
        fit: getComputedStyle(document.querySelector('#home-photo img')).objectFit };
    });
    assert.ok(layout.photo.width > 0 && layout.photo.height > 0, `${width}pxで写真の表示領域をゼロにしない`);
    if (width <= 700) assert.ok(layout.photo.width >= layout.container.width - 1, 'スマホは写真を本文と同じ幅へ表示する');
    assert.ok(width <= 700 ? layout.photo.bottom <= layout.copy.top : layout.copy.right <= layout.photo.left,
      `${width}pxでスマホは写真を先に、PCは本文と左右に並べる`);
    assert.equal(layout.fit, width <= 700 ? 'contain' : 'cover', 'スマホだけ店内全体を見せ、PCの構成を保つ');
    assert.equal(await page.locator('#home-photo img').count(), 1, '画面幅を変えても写真を複製しない');
    assert.equal(await page.locator('.hero a[href="reserve.html"]').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
}));

test('aspect-ratioに非対応でも実写真の寸法から高さを取り、写真名を横に読める', () => withPage('index', async page => {
  const layout = await page.evaluate(() => {
    const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    const image = document.querySelector('#home-photo img');
    return { photo: bounds('#home-photo'), image: bounds('#home-photo img'), container: bounds('.hero'),
      caption: bounds('#home-photo figcaption'), copy: bounds('.hero-inner'),
      ratios: [getComputedStyle(document.querySelector('#home-photo')).aspectRatio, getComputedStyle(image).aspectRatio],
      ratio: image.naturalWidth / image.naturalHeight };
  });
  assert.deepEqual(layout.ratios, ['auto', 'auto'], '写真と枠のCSS比率指定を無効にした条件で確認する');
  assert.ok(layout.photo.width >= layout.container.width - 1 && layout.photo.height > 0, '画像が流れの中で高さを確保する');
  assert.ok(Math.abs(layout.image.width / layout.image.height - layout.ratio) < 0.001, 'CSSの比率指定なしでも実写真の全体を見せる');
  assert.ok(layout.caption.width > layout.caption.height && layout.caption.bottom <= layout.copy.top, '写真名を縦に潰したり本文へ重ねたりしない');
  assert.equal(await page.locator('.sp-cta a[href="reserve.html"]').isVisible(), true);
}, {}, context => context.route('**/assets/css/home.css?*', async route => {
  const response = await route.fetch();
  const source = await response.text();
  const unsupported = source + '\n.hero-media, .hero-photo { aspect-ratio: auto !important; }\n';
  return route.fulfill({ response, body: unsupported });
})));

test('店内写真が取得できなければ大きな空白を残さず、店舗の文章と予約へ案内する', () => withPage('index', async page => {
  await page.locator('#home-photo img').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#home-photo').isVisible(), false, '壊れた写真の領域を文章の前に残さない');
  const copy = await page.locator('.hero-inner').boundingBox();
  const hero = await page.locator('.hero').boundingBox();
  assert.ok(copy.y - hero.y <= 32, '本文より前に写真用の高さを残さない');
  assert.equal(await page.locator('.hero a[href="reserve.html"]').isVisible(), true);
  assert.equal(await page.locator('.sp-cta a[href="reserve.html"]').isVisible(), true);
}, {}, context => context.route('**/shop2.jpg', route => route.abort())));

test('320pxでも公開9ページの店名・ロゴと予約ボタンを重ねず、すべて読める', async () => {
  for (const name of ['index', 'gallery', 'menu', 'staff', 'reviews', 'reserve', 'mypage', 'privacy', '404']) {
    const forbidden = [];
    await withPage(name, async page => {
      if (['reserve', 'mypage'].includes(name)) await page.waitForFunction(() => Catalog.loaded);
      const layout = await page.evaluate(() => {
        const brand = document.querySelector('.header-top .brand');
        const button = document.querySelector('.header-actions a[href="reserve.html"]');
        return {
          brand: brand.getBoundingClientRect().toJSON(), button: button.getBoundingClientRect().toJSON(),
          texts: [...brand.querySelectorAll('.wm-name, .wm-sub')].map(element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return { text: element.textContent, bounds: range.getBoundingClientRect().toJSON() };
          })
        };
      });
      assert.ok(layout.brand.right <= layout.button.left, `${name}でブランドと予約の領域を重ねない`);
      assert.ok(layout.texts.every(text => text.bounds.right <= layout.brand.right + 1
        && text.bounds.left >= layout.brand.left - 1), `${name}で店名・肩書きを途中で隠さない`);
      assert.deepEqual(layout.texts.map(text => text.text), ['ZER01', 'barber/lounge']);
      assert.ok(layout.button.width >= 44 && layout.button.height >= 44, '予約ボタンを小さくして解決しない');
      assert.equal(await page.locator('.header-top .brand-logo').isVisible(), true, '既存の店のロゴを消さない');
      assert.deepEqual(forbidden, [], 'メニュー・空席の読取以外は模擬接続でも許可しない');
    }, { viewport: { width: 320, height: 844 } }, context => context.route('**/exec', route => {
      const request = route.request();
      const type = request.method() === 'POST' ? request.postDataJSON().type : '';
      if (!['menu', 'availability'].includes(type)) { forbidden.push(type); return route.abort(); }
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: '表示の試験では予約データを取得しません。' }) });
    }));
  }
});

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
    await page.locator('.style-thumb').first().scrollIntoViewIfNeeded();
    await button.waitFor({ state: 'visible' });
    await page.waitForFunction(button => !button.disabled, await button.elementHandle());
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
  await page.locator('.style-thumb').first().scrollIntoViewIfNeeded();
  await button.waitFor({ state: 'visible' });
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
