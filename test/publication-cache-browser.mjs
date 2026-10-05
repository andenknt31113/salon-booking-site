import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { publicHtml } from '../tools/public-content.mjs';
import { PUBLICATION_SETTING_KEYS, publicationSite, parsePublishedMenus, serializePublishedMenus } from '../tools/publication-site.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const MIME = { js: 'text/javascript', css: 'text/css', jpg: 'image/jpeg', svg: 'image/svg+xml',
  woff2: 'font/woff2', png: 'image/png', webp: 'image/webp' };
const SECURITY_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-src 'none'";

test('長期cacheを残した実ブラウザで、写真・紹介文の更新と全非表示が旧データへ戻らない', async () => {
  const data = parsePublishedMenus(await readFile(new URL('../assets/js/published-menus.js', import.meta.url), 'utf8'));
  let catalog;
  let pages;
  const requests = [];
  const errors = [];
  const update = async sequence => {
    const settings = Object.fromEntries(PUBLICATION_SETTING_KEYS.map(key => [key, '']));
    Object.assign(settings, { 店の紹介文: 'cache試験の紹介' + sequence, メイン写真: 'assets/shop1.jpg',
      ロゴ画像: 'assets/logo-hpb.jpg', スタッフ写真: 'assets/staff-matteo.jpg' });
    data.site = publicationSite({ settings, styles: sequence === 2 ? [] : [{ id: 'ss0', title: 'cache試験の写真' + sequence,
      length: 'ショート', staffId: null, tags: [], detail: '', image: 'assets/style1.jpg', hue: 0 }] });
    catalog = serializePublishedMenus(data);
    pages = new Map((await publicHtml(catalog)).map(file => ['/' + file.name, file.next]));
  };
  await update(0);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://local.invalid');
    response.setHeader('Content-Security-Policy', SECURITY_POLICY);
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') { errors.push('書込要求'); response.writeHead(400); response.end(); return; }
    if (url.pathname === '/assets/js/published-menus.js') {
      requests.push(request.url);
      response.setHeader('Cache-Control', 'public, max-age=31536000');
      response.setHeader('Content-Type', MIME.js); response.end(catalog); return;
    }
    if (pages.has(url.pathname)) {
      response.setHeader('Content-Type', 'text/html;charset=utf-8'); response.end(pages.get(url.pathname)); return;
    }
    if (['/index.html', '/gallery.html', '/privacy.html'].includes(url.pathname)) {
      response.setHeader('Content-Type', 'text/html;charset=utf-8');
      response.end(await readFile(new URL('..' + url.pathname, import.meta.url))); return;
    }
    if (!url.pathname.startsWith('/assets/')) { response.writeHead(404); response.end(); return; }
    try {
      response.setHeader('Content-Type', MIME[url.pathname.split('.').at(-1)] || 'application/octet-stream');
      response.end(await readFile(new URL('..' + url.pathname, import.meta.url)));
    } catch { response.writeHead(404); response.end(); }
  });
  let browser;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const sequence of [0, 1, 2]) {
      if (sequence) await update(sequence);
      for (const path of ['index.html', 'gallery.html', 'privacy.html']) {
        await page.goto(base + '/' + path);
        assert.deepEqual(await page.evaluate(() => ({ description: SALON.description, titles: SALON.styles.map(style => style.title) })),
          { description: 'cache試験の紹介' + sequence, titles: sequence === 2 ? [] : ['cache試験の写真' + sequence] }, path);
        if (path === 'index.html') assert.equal(await page.locator('#hero-desc').innerText(), 'cache試験の紹介' + sequence);
        if (path === 'gallery.html') assert.equal((await page.locator('#style-list').innerText()).includes('cache試験の写真' + sequence), sequence !== 2);
      }
    }
    assert.equal(requests.length, 3, '同じsnapshotは九ページ間で再利用し、変更したsnapshotだけを取得する');
    assert.equal(new Set(requests).size, 3);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});
