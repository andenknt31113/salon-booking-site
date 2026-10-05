import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';
import { publicHtml } from '../tools/public-content.mjs';
import { PUBLICATION_SETTING_KEYS, publicationSite, parsePublishedMenus, serializePublishedMenus } from '../tools/publication-site.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const PAGES = ['index.html', 'menu.html', 'staff.html', 'gallery.html', 'reviews.html', 'privacy.html'];

async function fixture(empty, width, run) {
  const data = parsePublishedMenus(await readFile(new URL('../assets/js/published-menus.js', import.meta.url), 'utf8'));
  const settings = Object.fromEntries(PUBLICATION_SETTING_KEYS.map(key => [key, '']));
  Object.assign(settings, { '準備中の帯': '出さない', 営業開始: '09:00', 営業終了: '19:00', 最終受付: '18:00',
    店の紹介文: empty ? '' : '公開同期の架空紹介文', スタッフの紹介文: '公開同期の架空スタッフ紹介',
    住所: '公開同期の架空住所', メイン写真: 'assets/shop1.jpg', ロゴ画像: 'assets/logo-hpb.jpg',
    スタッフ写真: 'assets/staff-matteo.jpg', 問い合わせ先メール: 'publication@example.test' });
  data.site = publicationSite({ settings, styles: empty ? [] : [{ id: 'ss0', title: '公開同期の架空写真',
    length: 'ショート', staffId: null, tags: [], detail: '公開同期の説明', image: 'assets/style1.jpg', hue: 0 }] });
  const catalog = serializePublishedMenus(data);
  const generated = new Map((await publicHtml(catalog)).map(file => ['/' + file.name, file.next]));
  const calls = [];
  let handler;
  let browser;
  const server = http.createServer((request, response) => {
    const path = new URL(request.url, 'http://local.invalid').pathname;
    if (request.method !== 'GET') {
      calls.push({ method: request.method, path });
      response.writeHead(400); response.end(); return;
    }
    if (path === '/assets/js/published-menus.js' || generated.has(path)) {
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html;charset=utf-8');
      response.end(path.endsWith('.js') ? catalog : generated.get(path)); return;
    }
    handler(request, response);
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    handler = createMockHandler({ port: server.address().port });
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        window.initialPublication = { description: SALON.description, styles: structuredClone(SALON.styles),
          heroImage: SALON.heroImage, contactEmail: SALON.contactEmail };
      });
    });
    await run({ context, base, calls, expected: { description: settings['店の紹介文'], styles: data.site.styles,
      heroImage: settings['メイン写真'], contactEmail: settings['問い合わせ先メール'] } });
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

for (const width of [390, 1280]) {
  for (const empty of [false, true]) {
    test(`${width}px・写真${empty ? 'なし' : 'あり'}：六ページで静的設定を先に適用し、読込待ちの変更を起こさない`, async () => {
      await fixture(empty, width, async ({ context, base, calls, expected }) => {
        for (const path of PAGES) {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(base + '/' + path);
          assert.deepEqual(await page.evaluate(() => window.initialPublication), expected, path);
          assert.deepEqual(await page.evaluate(async () => {
            const loaded = await Catalog.load();
            return { loaded, description: SALON.description, styles: structuredClone(SALON.styles),
              heroImage: SALON.heroImage, contactEmail: SALON.contactEmail };
          }), { loaded: 'local', ...expected }, path);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, path);
          if (path === 'index.html') assert.equal(await page.locator('#hero-desc').innerText(), expected.description);
          if (path === 'gallery.html') {
            assert.equal((await page.locator('#style-list').innerText()).includes('公開同期の架空写真'), !empty);
            if (!empty) {
              const picture = page.locator('#style-list img').first();
              await picture.scrollIntoViewIfNeeded();
              await picture.evaluate(image => image.decode());
              assert.equal(await picture.evaluate(image => image.naturalWidth > 0), true);
            }
          }
          assert.deepEqual(errors, [], path);
          await page.close();
        }
        assert.deepEqual(calls, []);
      });
    });
  }
}
