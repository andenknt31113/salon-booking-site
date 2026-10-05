import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const REQUEST_TIMEOUT_MS = 30000;
const FIXTURE_TIMEOUT_MS = 1000;
const TEST_TIMEOUT_MS = 7000;
after(() => browser.close());

const startup = () => ({ ok: true, reservations: [], closedDates: [], menus: [], coupons: [], settings: {},
  stamps: { menus: '0', coupons: '0', closed: '0', settings: '0' }, pendingEditors: ['styles', 'reviews'] });
const appSdk = 'export function initializeApp() { return {}; }';
const authSdk = `
const user = { email: 'fixture-admin@example.test', getIdToken: async () => crypto.randomUUID() };
const auth = { currentUser: user, authStateReady: async () => {} };
export const browserSessionPersistence = {};
export const inMemoryPersistence = {};
export const browserPopupRedirectResolver = {};
export function initializeAuth() { return auth; }
export class GoogleAuthProvider { setCustomParameters() {} }
export async function signInWithPopup() { window.fixturePopupCalls++; return { user }; }
export async function signOut() {
  window.fixtureSignOutCalls++;
  if (window.fixtureOutcome === 'reject') throw new Error('架空のログアウト障害');
  if (window.fixtureOutcome === 'pending') await new Promise(resolve => { window.fixtureFinishSignOut = resolve; });
  auth.currentUser = null;
}`;

for (const width of [320, 390]) {
  for (const entry of ['logout', 'denied', 'startup']) {
    for (const outcome of ['pending', 'reject', 'success']) {
      test(`${width}px・${entry}・${outcome}：実Google管理入口の終了と再ログインの保護`, async () => {
        let handler;
        const server = http.createServer((request, response) => handler(request, response));
        const errors = [];
        const external = [];
        const operations = [];
        let context;
        try {
          server.listen(0, '127.0.0.1');
          await once(server, 'listening');
          handler = createMockHandler({ port: server.address().port });
          const base = `http://127.0.0.1:${server.address().port}`;
          context = await browser.newContext({ viewport: { width, height: 568 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
          await context.addInitScript(({ outcome, timeout, requestTimeout }) => {
            window.fixtureOutcome = outcome;
            window.fixtureSignOutCalls = 0;
            window.fixturePopupCalls = 0;
            const nativeTimeout = window.setTimeout;
            window.setTimeout = (callback, delay, ...parameters) => nativeTimeout(callback,
              delay === requestTimeout ? timeout : delay, ...parameters);
          }, { outcome, timeout: FIXTURE_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS });
          await context.route('**/*', route => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin === 'https://www.gstatic.com'
                && /\/firebase-(app|auth)\.js$/.test(url.pathname)) {
              return route.fulfill({ contentType: 'application/javascript',
                headers: { 'Access-Control-Allow-Origin': '*' },
                body: url.pathname.endsWith('/firebase-app.js') ? appSdk : authSdk });
            }
            if (url.origin !== base) {
              external.push(request.method());
              return route.abort();
            }
            if (url.pathname !== '/exec') return route.continue();
            assert.equal(request.method(), 'POST');
            const payload = JSON.parse(request.postData());
            operations.push({ type: payload.type, action: payload.action });
            assert.equal(Object.hasOwn(payload, 'password'), false);
            assert.equal(Object.hasOwn(payload, 'token'), false);
            if (payload.type === 'adminAuthConfig') return route.fulfill({ json: { ok: true,
              firebase: { projectId: 'fixture-admin-test', appId: 'fixture' } } });
            assert.equal(payload.type, 'googleAdmin');
            assert.ok(['adminData', 'adminSave'].includes(payload.action));
            return route.fulfill({ json: payload.action === 'adminSave' || entry === 'startup'
              ? { ok: false, authDenied: true, error: '架空の管理権限失効' } : startup() });
          });
          const page = await context.newPage();
          page.setDefaultTimeout(TEST_TIMEOUT_MS);
          page.on('pageerror', error => errors.push(error.message));
          page.on('dialog', dialog => dialog.dismiss());
          await page.goto(base + '/admin-google.html');
          if (entry !== 'startup') {
            await page.locator('#management-view:not([hidden])').waitFor();
            await page.frameLocator('#admin-frame').locator('#dashboard:not([hidden])').waitFor();
          }
          if (entry === 'logout') await page.locator('#google-logout').click();
          else if (entry === 'denied') await page.evaluate(() => {
            window.fixtureOperation = window.authAdminRequest({ type: 'adminSave', target: 'closed', rows: [] })
              .then(result => { window.fixtureResult = result; });
          });
          await page.locator('#login-view:not([hidden])').waitFor();
          await page.waitForFunction(() => window.fixtureSignOutCalls === 1);
          assert.equal(await page.locator('#management-view').isVisible(), false);
          assert.equal(await page.locator('#admin-frame').getAttribute('src'), null);
          if (outcome !== 'success') {
            await page.waitForFunction(() => document.querySelector('#login-error').textContent.includes('ログアウトを確認できません'));
            assert.equal(await page.locator('#google-login').isDisabled(), true);
            assert.match(await page.locator('#login-error').textContent(), /ページを閉じてください/);
            const message = await page.locator('#login-error').textContent();
            await page.evaluate(() => {
              window.fixtureFinishSignOut?.();
              document.querySelector('#google-login').dispatchEvent(new Event('click'));
            });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            assert.equal(await page.locator('#google-login').isDisabled(), true);
            assert.equal(await page.locator('#login-error').textContent(), message);
            assert.equal(await page.evaluate(() => window.fixturePopupCalls), 0);
          } else await page.waitForFunction(() => !document.querySelector('#google-login').disabled);
          if (entry === 'denied') {
            await page.waitForFunction(() => !!window.fixtureResult);
            const result = await page.evaluate(() => ({ ok: window.fixtureResult.ok,
              authDenied: window.fixtureResult.authDenied, error: window.fixtureResult.error }));
            assert.equal(result.ok, false);
            assert.equal(result.authDenied, true);
            assert.match(result.error, /管理権限失効/);
          }
          if (entry === 'startup') assert.match(await page.locator('#login-error').textContent(), /管理権限失効/);
          assert.equal(operations.filter(operation => operation.action === 'adminSave').length, entry === 'denied' ? 1 : 0);
          const before = operations.length;
          assert.equal(await page.evaluate(async () => (await window.authAdminRequest({ type: 'adminData' })).ok), false);
          assert.equal(operations.length, before);
          assert.equal(await page.evaluate(() => window.fixtureSignOutCalls), 1);
          assert.deepEqual(errors, []);
          assert.deepEqual(external, []);
        } finally {
          await context?.close();
          server.closeAllConnections?.();
          await new Promise(resolve => server.close(resolve));
        }
      });
    }
  }
}
