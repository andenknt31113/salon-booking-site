import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../assets/js/admin-portal.js', import.meta.url), 'utf8');
const REQUEST_TIMEOUT_MS = 30000;
const MICRO_TASK_STEPS = 30;

async function flushTasks() {
  for (let step = 0; step < MICRO_TASK_STEPS; step++) await Promise.resolve();
}

function fixture({ outcome = 'pending', dirty = false, consent = true, startup = false } = {}) {
  const elements = new Map();
  const timers = new Map();
  const operations = [];
  let nextTimer = 0;
  let signOutCalls = 0;
  let popupCalls = 0;
  let confirmations = 0;
  let finishSignOut;
  const deferred = new Promise(resolve => { finishSignOut = resolve; });
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: false, disabled: false, textContent: '', src: 'admin.html?google=1', handlers: new Map(),
      addEventListener(name, callback) { this.handlers.set(name, callback); },
      removeAttribute(name) { this[name] = ''; },
      contentWindow: { authDemoHasUnsaved: () => dirty }
    });
    return elements.get(selector);
  };
  const account = { email: 'fixture-admin@example.test', getIdToken: async () => randomUUID() };
  const context = vm.createContext({ window: {}, AbortController,
    SALON: { reservationEndpoint: 'https://fixture.invalid/exec',
      adminAuth: { requestTimeoutMs: REQUEST_TIMEOUT_MS, popupWaitNoticeMs: REQUEST_TIMEOUT_MS } },
    document: { querySelector: element, documentElement: { classList: { add() {}, remove() {} } } },
    setTimeout(callback, delay) { const timer = ++nextTimer; timers.set(timer, { callback, delay }); return timer; },
    clearTimeout: timer => timers.delete(timer),
    confirm() { confirmations++; return consent; },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      operations.push({ type: body.type, action: body.action });
      return { ok: true, json: async () => ({ ok: false, authDenied: true, error: '架空の管理権限失効' }) };
    },
    fixtureAccount: account,
    fixtureSdk: {
      async signOut() {
        signOutCalls++;
        if (outcome === 'reject') throw new Error('架空のログアウト障害');
        if (outcome === 'pending') await deferred;
      },
      GoogleAuthProvider: class { setCustomParameters() {} },
      async signInWithPopup() { popupCalls++; return { user: account }; }
    }
  });
  assert.match(SOURCE, /\nawait setupAuth\(\);\s*$/);
  vm.runInContext(SOURCE.replace(/\nawait setupAuth\(\);\s*$/, ''), context);
  vm.runInContext('authReady = true; auth = { currentUser: fixtureAccount, authStateReady: async () => {} }; sdk = fixtureSdk; user = fixtureAccount;', context);
  if (startup) vm.runInContext('authReady = false; user = null;', context);
  element('#management-view').hidden = startup;
  element('#login-view').hidden = !startup;
  element('#login-error').hidden = true;
  const state = () => vm.runInContext('({ authReady, busy, user, generation, requests: requests.size })', context);
  const expire = () => {
    const pending = [...timers.values()];
    assert.equal(pending.length, 1, 'Googleのログアウトも有限の待機にする');
    assert.equal(pending[0].delay, REQUEST_TIMEOUT_MS, '既存の管理通信の上限を使う');
    pending[0].callback();
  };
  return { context, element, timers, operations, state, expire, finishSignOut,
    logout: () => element('#google-logout').handlers.get('click')(),
    denied: () => context.window.authAdminRequest({ type: 'adminSave', target: 'closed', rows: [] }),
    startup: () => context.setupAuth(),
    signOutCalls: () => signOutCalls, popupCalls: () => popupCalls, confirmations: () => confirmations };
}

for (const entry of ['logout', 'denied', 'startup']) {
  for (const outcome of ['pending', 'reject', 'success']) {
    test(`${entry}：Googleログアウトの${outcome}でも管理を閉じ、結果と再ログイン可否を正しく扱う`, async () => {
      const app = fixture({ outcome, startup: entry === 'startup' });
      let settled = false;
      let result;
      const operation = app[entry]().then(value => { settled = true; result = value; });
      try {
        await flushTasks();
        assert.equal(app.signOutCalls(), 1);
        assert.equal(app.element('#admin-frame').src, '');
        assert.equal(app.element('#management-view').hidden, true);
        assert.equal(app.element('#login-view').hidden, false);
        assert.equal(app.state().user, null);
        if (outcome === 'pending') {
          assert.equal(settled, false);
          assert.equal(app.state().authReady, false, 'ログアウト確認中に別のGoogleログインを始めない');
          assert.equal(app.element('#google-login').disabled, true);
          if (entry !== 'logout') assert.match(app.element('#login-error').textContent, /管理権限失効/);
          app.expire();
          await flushTasks();
        }
        assert.equal(settled, true, '返事がない場合も送信中を終える');
        await operation;
        assert.equal(app.state().busy, false);
        assert.equal(app.state().requests, 0);
        assert.equal(app.timers.size, 0);
        assert.equal(app.state().authReady, outcome === 'success');
        assert.equal(app.element('#google-login').disabled, outcome !== 'success');
        if (entry === 'denied') {
          assert.equal(result.ok, false);
          assert.equal(result.authDenied, true, '認証拒否を台帳の通信失敗へ変えない');
          assert.match(result.error, /管理権限失効/);
          assert.equal(app.operations.length, 1);
        } else assert.equal(app.operations.length, entry === 'startup' ? 1 : 0);
        const reads = app.operations.length;
        assert.equal((await app.context.window.authAdminRequest({ type: 'adminData' })).ok, false);
        assert.equal(app.operations.length, reads, '閉じた管理から自動で取り直さない');
        if (outcome !== 'success') {
          assert.match(app.element('#login-error').textContent, /ログアウト.*確認できません.*閉じ/);
          await app.context.signIn();
          assert.equal(app.popupCalls(), 0, '古いログアウトが未確認のまま新しいログインを始めない');
          const message = app.element('#login-error').textContent;
          app.finishSignOut();
          await flushTasks();
          assert.equal(app.state().authReady, false, '期限後の返事でログインを解放しない');
          assert.equal(app.element('#login-error').textContent, message);
        }
      } finally {
        app.finishSignOut();
        await operation;
        await flushTasks();
      }
    });
  }
}

for (const consent of [false, true]) {
  test(`書きかけの入力があるログアウトは店主の確認${consent}を守る`, async () => {
    const app = fixture({ outcome: 'success', dirty: true, consent });
    await app.logout();
    assert.equal(app.confirmations(), 1);
    assert.equal(app.signOutCalls(), consent ? 1 : 0);
    assert.equal(app.element('#management-view').hidden, consent);
    assert.equal(app.state().user === null, consent);
    assert.equal(app.state().busy, false);
    assert.equal(app.state().authReady, true);
    assert.equal(app.operations.length, 0);
  });
}
