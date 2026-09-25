import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { once } from 'node:events';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
const requests = [];
let allowed = true;
let base;
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, base).pathname;
  if (pathname === '/exec' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const data = JSON.parse(body);
      requests.push(data);
      let result = { ok: false, error: '操作を確認できません。' };
      if (data.type === 'adminAuthConfig') result = { ok: true, firebase: {
        projectId: 'zer01-local-test', apiKey: '試験用の公開設定', appId: '試験用アプリ',
        authDomain: 'zer01-local-test.firebaseapp.com' } };
      if (data.type === 'googleAdmin') result = allowed && data.idToken === '試験用IDトークン'
        ? { ok: true, reservations: [{ code: 'LM-TEST1', date: '2026-10-08', time: '12:00',
            endTime: '13:00', menu: '試験用カット', staffName: '担当者', price: 5000,
            name: '試験太郎', tel: '09000000000', email: '', visit: '初めて',
            request: '', status: '', note: '' }], menus: [], coupons: [], styles: [], reviews: [],
          closedDates: [], settings: {}, stamps: {} }
        : { ok: false, authDenied: true, error: 'このGoogleアカウントには管理権限がありません。' };
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(result));
    });
    return;
  }
  const path = normalize(join(root, decodeURIComponent(pathname)));
  if (request.method !== 'GET' || !path.startsWith(root + sep)
      || !(pathname.startsWith('/assets/') || ['/admin.html', '/admin-google.html', '/favicon.svg'].includes(pathname))) {
    response.writeHead(404).end(); return;
  }
  try {
    let body = readFileSync(path);
    if (pathname === '/assets/js/data.js') body = Buffer.from(body.toString()
      .replace(/reservationEndpoint: '[^']*'/, `reservationEndpoint: '${base}/exec'`));
    response.writeHead(200, { 'Content-Type': contentTypes[extname(path)] || 'application/octet-stream' });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
const unexpected = [];
const failedAssets = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failedAssets.push([response.status(), response.url()]); });
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(base + '/')) return route.continue();
    if (/^https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-app\.js$/.test(url)) {
      return route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
        body: 'export function initializeApp() { return {}; }' });
    }
    if (/^https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-auth\.js$/.test(url)) {
      return route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: `
        export const inMemoryPersistence = {};
        export const browserPopupRedirectResolver = {};
        export function initializeAuth() { return {}; }
        export class GoogleAuthProvider { setCustomParameters() {} }
        export async function signInWithPopup() {
          return { user: { email: 'test@example.invalid', async getIdToken() { return '試験用IDトークン'; } } };
        }
        export async function signOut() {}
      ` });
    }
    unexpected.push('想定外の外部通信');
    await route.abort();
  });
  await page.goto(base + '/admin-google.html');
  await page.waitForFunction(() => !document.querySelector('#google-login').disabled);
  assert.equal(requests.filter(item => item.type === 'googleAdmin').length, 0, '認証前には台帳を読まない');
  await page.locator('#google-login').click();
  const frame = page.frameLocator('#admin-frame');
  try { await frame.locator('#dashboard:not([hidden])').waitFor({ timeout: 8000 }); }
  catch (error) {
    console.log('画面状態:', await page.locator('#login-status').innerText(), await page.locator('#login-error').innerText());
    console.log('iframe:', await page.locator('#admin-frame').getAttribute('src'), '送信種別:', requests.map(item => item.type));
    console.log('フレーム状態:', page.frames().map(item => item.url()));
    console.log('管理本文:', (await frame.locator('body').innerText().catch(() => '読めない')).slice(0, 500));
    console.log('ブリッジ:', await frame.locator('body').evaluate(() => ({ embedded: window.googleAdminEmbedded,
      parentMethod: typeof window.parent.authAdminRequest, ownPost: typeof adminPost,
      gateHidden: document.querySelector('#gate').hidden,
      scripts: [...document.scripts].map(script => script.src).slice(-5) })));
    console.log('JSエラー:', errors);
    console.log('取得失敗:', failedAssets);
    throw error;
  }
  assert.equal(await page.locator('#management-view').isVisible(), true, '認証後は管理画面を全面表示する');
  assert.equal(await frame.locator('#gate').isVisible(), false, '旧パスワード欄を出さない');
  assert.equal(await frame.locator('html').getAttribute('data-admin-design'), 'a');
  const adminCalls = requests.filter(item => item.type === 'googleAdmin');
  assert.ok(adminCalls.length >= 2, 'ログイン確認と台帳読込の両方で認証する');
  assert.ok(adminCalls.every(item => item.idToken === '試験用IDトークン'
    && item.action === 'adminData' && !item.payload.password && !item.payload.token), '旧パスワード・合鍵は送らない');
  const [download] = await Promise.all([
    page.waitForEvent('download'), frame.locator('#export-csv').click()
  ]);
  assert.match(download.suggestedFilename(), /^reservations_\d{4}-\d{2}-\d{2}\.csv$/,
    'Google管理画面から台帳をCSV出力できる');
  allowed = false;
  await frame.locator('#refresh-reservations').click();
  await page.waitForFunction(() => document.querySelector('#management-view').hidden);
  assert.equal(await page.locator('#admin-frame').getAttribute('src'), null, '権限を失ったら台帳画面を破棄する');
  assert.match(await page.locator('#login-error').innerText(), /管理権限/);
  assert.deepEqual(errors, [], '画面のJSエラーなし');
  assert.deepEqual(unexpected, [], '試験から実Firebase・実GASへ通信しない');
  console.log('公開Google管理入口：認証前拒否・台帳表示・旧ログイン非使用・権限失効の試験に成功');
} finally {
  await browser.close();
  server.close();
  server.closeAllConnections();
  await once(server, 'close');
}
