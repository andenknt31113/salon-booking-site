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
let authUnavailable = false;
let savedNote = '';
let noteWrites = 0;
let loseNextNoteResponse = false;
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
      if (data.type === 'googleAdmin') {
        if (authUnavailable) {
          result = { ok: false, transportError: true, error: '試験用：Googleとの通信を確認できません。' };
        } else if (!allowed || data.idToken !== '試験用IDトークン') {
          result = { ok: false, authDenied: true, error: 'このGoogleアカウントには管理権限がありません。' };
        } else if (data.action === 'adminNote') {
          if (typeof data.payload.expectedNote !== 'string') {
            result = { ok: false, error: '元のメモを確認できません。' };
          } else if (data.payload.expectedNote !== savedNote && data.payload.note !== savedNote) {
            result = { ok: false, conflict: true,
              error: '別の画面で施術メモが更新されました。入力をコピーしてからページを再読み込みしてください。' };
          } else {
            if (savedNote !== data.payload.note) noteWrites++;
            savedNote = data.payload.note;
            if (loseNextNoteResponse) {
              loseNextNoteResponse = false;
              response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
              response.end('試験用：保存は完了したが応答が壊れた');
              return;
            }
            result = { ok: true, code: data.payload.code, note: savedNote };
          }
        } else {
          result = { ok: true, reservations: [{ code: 'LM-TEST1', date: '2026-10-08', time: '12:00',
            endTime: '13:00', menu: '試験用カット', staffName: '担当者', price: 5000,
            name: '試験太郎', tel: '09000000000', email: '', visit: '初めて',
            request: '', status: '', note: savedNote }], menus: [], coupons: [], styles: [], reviews: [],
            closedDates: [], settings: {}, stamps: { menus: '0', coupons: '0', styles: '0',
              reviews: '0', closed: '0', settings: '0' } };
        }
      }
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
  let popupCalls = 0;
  await context.exposeBinding('recordTestPopup', () => { popupCalls++; });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failedAssets.push([response.status(), response.url()]); });
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(base + '/')) return route.continue();
    if (/^https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-app\.js$/.test(url)) {
      return route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
        body: 'export function initializeApp() { return {}; }' });
    }
    if (/^https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-auth\.js$/.test(url)) {
      return route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: `
        export const inMemoryPersistence = {};
        export const browserSessionPersistence = {};
        export const browserPopupRedirectResolver = {};
        const account = { email: 'test@example.invalid', async getIdToken() { return '試験用IDトークン'; } };
        export function initializeAuth(app, options) {
          if (options.persistence[0] !== browserSessionPersistence || options.persistence[1] !== inMemoryPersistence)
            throw new Error('タブ内保存とメモリへの復帰を指定してください');
          return { currentUser: sessionStorage.getItem('test-signed-in') ? account : null, async authStateReady() {} };
        }
        export class GoogleAuthProvider { setCustomParameters() {} }
        export async function signInWithPopup(auth) {
          await window.recordTestPopup();
          sessionStorage.setItem('test-signed-in', 'yes');
          auth.currentUser = account;
          return { user: account };
        }
        export async function signOut(auth) { sessionStorage.removeItem('test-signed-in'); auth.currentUser = null; }
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
  assert.equal(adminCalls.length, 1, '認証済みの台帳読込結果を初回表示に使い、重複取得しない');
  assert.ok(adminCalls.every(item => item.idToken === '試験用IDトークン'
    && item.action === 'adminData' && !item.payload.password && !item.payload.token), '旧パスワード・合鍵は送らない');
  const popupsBeforeReload = popupCalls;
  await page.reload();
  await frame.locator('#dashboard:not([hidden])').waitFor();
  assert.equal(popupCalls, popupsBeforeReload, '同じタブの再読込でGoogleの小窓を出し直さない');
  assert.equal(requests.filter(item => item.type === 'googleAdmin' && item.action === 'adminData').length, 2,
    '復帰後は保存済み台帳を流用せずサーバーで再認証・再読込する');
  await frame.locator('#refresh-reservations').click();
  await page.waitForFunction(() => !document.querySelector('#admin-frame').contentDocument.querySelector('#refresh-reservations').disabled);
  assert.equal(requests.filter(item => item.type === 'googleAdmin' && item.action === 'adminData').length, 3,
    '次の再読込は必ずサーバーで認証し、最新台帳を取得する');
  const otherPage = await context.newPage();
  const dialogs = [];
  otherPage.on('pageerror', error => errors.push(error.message));
  otherPage.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await otherPage.goto(base + '/admin-google.html');
  await otherPage.waitForFunction(() => !document.querySelector('#google-login').disabled);
  await otherPage.locator('#google-login').click();
  const otherFrame = otherPage.frameLocator('#admin-frame');
  await otherFrame.locator('#dashboard:not([hidden])').waitFor();
  const otherNote = otherFrame.locator('#admin-rows [data-note-box]').first();
  await otherNote.locator('[data-note-summary]').click();
  await otherNote.locator('[data-note-input]').fill('別タブで書きかけの申し送り');
  const noteBox = frame.locator('#admin-rows [data-note-box]').first();
  await noteBox.locator('[data-note-summary]').click();
  await noteBox.locator('[data-note-input]').fill('次回は右側を短めに');
  await noteBox.locator('[data-note-save]').click();
  await noteBox.locator('[data-note-status]').getByText('保存しました').waitFor();
  assert.equal(savedNote, '次回は右側を短めに', 'Google管理画面から施術メモを保存できる');
  assert.equal(await noteBox.locator('[data-note-input]').inputValue(), savedNote, '保存値を画面に反映する');
  const noteCalls = requests.filter(item => item.type === 'googleAdmin' && item.action === 'adminNote');
  assert.equal(noteCalls.length, 1, 'メモを二重送信しない');
  assert.equal(noteCalls[0].idToken, '試験用IDトークン', '保存にもGoogleの本人確認を付ける');
  assert.equal(noteCalls[0].payload.password, undefined, '旧パスワードを送らない');
  assert.equal(noteCalls[0].payload.expectedNote, '', '読込時の元のメモを添える');
  await otherNote.locator('[data-note-save]').click();
  await otherNote.locator('[data-note-status]').getByText('別の画面で更新されています。入力は残っています。').waitFor();
  assert.equal(savedNote, '次回は右側を短めに', '別タブの古い元データでは先の保存を上書きしない');
  assert.equal(noteWrites, 1, '競合した要求で台帳を書き換えない');
  assert.equal(await otherNote.locator('[data-note-input]').inputValue(), '別タブで書きかけの申し送り', '競合後も入力を保持する');
  assert.equal(await otherNote.locator('[data-note-save]').isEnabled(), true, '競合後も操作できる');
  assert.ok(dialogs.some(message => /入力をコピーしてからページを再読み込み/.test(message)), '下書きを保護して最新内容を確認する手順を示す');
  const popupsBeforeOtherReload = popupCalls;
  await otherPage.reload();
  await otherFrame.locator('#dashboard:not([hidden])').waitFor();
  assert.equal(popupCalls, popupsBeforeOtherReload, '競合後の再読込でもGoogle選択を繰り返さない');
  await otherNote.locator('[data-note-summary]').click();
  assert.equal(await otherNote.locator('[data-note-input]').inputValue(), savedNote, '読み直すと先に保存した内容を取得できる');
  await otherNote.locator('[data-note-input]').fill('最新のメモを確認して追記');
  loseNextNoteResponse = true;
  await otherNote.locator('[data-note-save]').click();
  await otherNote.locator('[data-note-status]').getByText('保存結果を確認できません。入力は残っています。').waitFor();
  assert.equal(savedNote, '最新のメモを確認して追記', '保存後に返事だけ失う条件を再現する');
  assert.equal(await otherNote.locator('[data-note-input]').inputValue(), savedNote, '応答不明でも再送する内容を失わない');
  assert.equal(noteWrites, 2);
  await otherNote.locator('[data-note-save]').click();
  await otherNote.locator('[data-note-status]').getByText('保存しました').waitFor();
  assert.equal(noteWrites, 2, '同じメモの再送で重ね書きしない');
  const retried = requests.filter(item => item.type === 'googleAdmin' && item.action === 'adminNote').slice(-2);
  assert.equal(retried[0].payload.expectedNote, '次回は右側を短めに', '最新内容を読んだ上で更新する');
  assert.deepEqual(retried[1].payload, retried[0].payload, '応答不明の再送では元の内容も変えない');
  await otherPage.close();
  const offlineNote = frame.locator('#admin-rows [data-note-box]').first();
  const originalNote = await offlineNote.locator('[data-note-input]').inputValue();
  if (!await offlineNote.locator('[data-note-input]').isVisible()) await offlineNote.locator('[data-note-summary]').click();
  await offlineNote.locator('[data-note-input]').fill('Googleが混雑しても残す下書き');
  const noteAttempts = requests.filter(item => item.action === 'adminNote').length;
  authUnavailable = true;
  await offlineNote.locator('[data-note-save]').click();
  await offlineNote.locator('[data-note-status]').getByText('保存結果を確認できません。入力は残っています。').waitFor();
  assert.equal(await page.locator('#management-view').isVisible(), true, '通信障害を権限失効と取り違えて管理画面を閉じない');
  assert.equal(await offlineNote.locator('[data-note-input]').inputValue(), 'Googleが混雑しても残す下書き');
  assert.equal(noteWrites, 2, '本人確認ができない間は書き込まない');
  assert.equal(requests.filter(item => item.action === 'adminNote').length, noteAttempts + 1, '失敗した保存を自動で再送しない');
  authUnavailable = false;
  await offlineNote.locator('[data-note-input]').fill(originalNote);
  const [download] = await Promise.all([
    page.waitForEvent('download'), frame.locator('#export-csv').click()
  ]);
  assert.match(download.suggestedFilename(), /^reservations_\d{4}-\d{2}-\d{2}\.csv$/,
    'Google管理画面から台帳をCSV出力できる');
  await page.locator('#google-logout').click();
  await page.waitForFunction(() => !document.querySelector('#google-login').disabled);
  assert.equal(await page.locator('#management-view').isVisible(), false, 'ログアウトで台帳を隠す');
  assert.equal(await page.locator('#admin-frame').getAttribute('src'), null, 'ログアウトで台帳画面を破棄する');
  assert.equal(await page.locator('#login-status').innerText(), '管理者のGoogleアカウントでログインしてください。',
    'ログアウト後に台帳の読込中という古い案内を残さない');
  const afterLogout = requests.filter(item => item.type === 'googleAdmin').length;
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#google-login').disabled);
  assert.equal(requests.filter(item => item.type === 'googleAdmin').length, afterLogout, 'ログアウト後の再読込では勝手に台帳を開かない');
  assert.equal(await page.locator('#management-view').isVisible(), false);
  await page.locator('#google-login').click();
  await frame.locator('#dashboard:not([hidden])').waitFor();
  allowed = false;
  await frame.locator('#refresh-reservations').click();
  try { await page.waitForFunction(() => document.querySelector('#management-view').hidden, null, { timeout: 8000 }); }
  catch (error) {
    console.log('失効確認:', requests.slice(-3).map(item => ({ type: item.type, action: item.action })),
      await frame.locator('body').evaluate(() => ({ pending: hasUnsavedReservationNotes(),
        notes: [...document.querySelectorAll('[data-note-input]')].map(input => ({ value: input.value, base: input.defaultValue })),
        status: document.querySelector('#reservation-message')?.textContent })));
    throw error;
  }
  assert.equal(await page.locator('#admin-frame').getAttribute('src'), null, '権限を失ったら台帳画面を破棄する');
  assert.match(await page.locator('#login-error').innerText(), /管理権限/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('test-signed-in')), null, '権限失効時はタブのログイン状態も消す');
  allowed = true;
  await page.locator('#google-login').click();
  await frame.locator('#dashboard:not([hidden])').waitFor();
  allowed = false;
  const popupsBeforeDeniedRestore = popupCalls;
  await page.reload();
  await page.locator('#login-error').getByText(/管理権限/).waitFor();
  assert.equal(popupCalls, popupsBeforeDeniedRestore);
  assert.equal(await page.locator('#management-view').isVisible(), false, '復元済みGoogleでも権限失効後は台帳を表示しない');
  assert.equal(await page.locator('#admin-frame').getAttribute('src'), null);
  assert.deepEqual(errors, [], '画面のJSエラーなし');
  assert.deepEqual(unexpected, [], '試験から実Firebase・実GASへ通信しない');
  console.log('公開Google管理入口：認証前拒否・台帳表示・施術メモの競合保護と再送・旧ログイン非使用・権限失効の試験に成功');
} finally {
  await browser.close();
  server.close();
  server.closeAllConnections();
  await once(server, 'close');
}
