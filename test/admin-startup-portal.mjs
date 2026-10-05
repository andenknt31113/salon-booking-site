import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/admin-portal.js', import.meta.url), 'utf8');
const requestSource = source.match(/window\.authAdminRequest = async payload => {[\s\S]*?\n};/)[0];
const loadSource = source.match(/async function loadAdmin\(\) {[\s\S]*?\n}/)[0];
const signOutSource = source.match(/async function signOutAdmin\(\) {[\s\S]*?\n}/)[0];
const dataSource = readFileSync(new URL('../assets/js/admin-data.js', import.meta.url), 'utf8');

function fixture(seed = null) {
  const calls = [];
  const effects = [];
  const context = vm.createContext({ window: {}, actions: new Set(['adminData', 'adminSave']),
    initialAdminData: seed, user: { getIdToken: async () => randomUUID() }, generation: 1, auth: {}, authReady: true,
    withRequestTimeout: callback => callback({ aborted: false }),
    post: async body => { calls.push({ action: body.action, payload: body.payload }); return context.response; },
    managementView: { hidden: true }, connectionDetail: () => '',
    loginStatus: { textContent: '' }, retryAccessButton: { hidden: true }, loginButton: { disabled: false },
    showAdmin: data => { context.initialAdminData = data; },
    sdk: { signOut: async () => {
      effects.push('sign-out');
      if (context.rejectSignOut) throw new Error('架空のログアウト失敗');
    } }, closeAdmin() {
      effects.push('close');
      context.generation++;
      context.initialAdminData = null;
      context.managementView.hidden = true;
      context.retryAccessButton.hidden = true;
    }, showError: message => effects.push({ error: message })
  });
  context.response = { ok: true, reservations: [], closedDates: [], menus: [], coupons: [], settings: {},
    stamps: { menus: '0', coupons: '0', closed: '0', settings: '0' }, pendingEditors: ['styles', 'reviews'] };
  vm.runInContext(dataSource + '\n' + signOutSource + '\n' + requestSource + '\n' + loadSource, context);
  return { context, calls, effects, request: context.window.authAdminRequest };
}

test('Google入口は起動用データを要求し、管理HTMLは同じ応答を一回だけ受け取る', async () => {
  const app = fixture();
  await app.context.loadAdmin();
  assert.equal(app.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0])), { action: 'adminData', payload: { startupOnly: true, briefPast: true, deferMenus: true } });
  const seed = app.context.initialAdminData;
  assert.equal(await app.request({ type: 'adminData', startupOnly: true, briefPast: true }), seed);
  assert.equal(app.calls.length, 1);
  await app.request({ type: 'adminData', startupOnly: true, briefPast: true });
  assert.equal(app.calls.length, 2);
});

test('メニュー未取得の初回応答は明示した新しい起動要求へ一回だけ渡す', async () => {
  const seed = { ok: true, reservations: [], pendingEditors: ['menus', 'coupons', 'styles', 'reviews'] };
  const app = fixture(seed);
  const payload = { type: 'adminData', startupOnly: true, briefPast: true, deferMenus: true };
  assert.equal(await app.request(payload), seed);
  assert.equal(app.calls.length, 0);
  await app.request(payload);
  assert.equal(app.calls.length, 1);
});

test('メニュー未取得の応答を旧起動・全件・単一編集・通知へ混ぜず、明示した要求だけに残す', async () => {
  const seed = { ok: true, reservations: [], pendingEditors: ['menus', 'coupons', 'styles', 'reviews'] };
  const app = fixture(seed);
  const payloads = [{ type: 'adminData' }, { type: 'adminData', startupOnly: true },
    { type: 'adminData', startupOnly: true, briefPast: true }, { type: 'adminData', editorTarget: 'menus' },
    { type: 'adminData', notificationsOnly: true }, { type: 'adminData', reservationsOnly: true },
    { type: 'adminData', startupOnly: true, briefPast: true, deferMenus: false },
    { type: 'adminData', startupOnly: true, briefPast: true, deferMenus: 'true' },
    { type: 'adminData', startupOnly: true, briefPast: true, deferMenus: true, unknown: true }];
  for (const payload of payloads) assert.notEqual(await app.request(payload), seed);
  assert.equal(app.calls.length, payloads.length);
  assert.equal(await app.request({ type: 'adminData', startupOnly: true, briefPast: true, deferMenus: true }), seed);
  assert.equal(app.calls.length, payloads.length);
});

test('過去の詳細を省略した初回応答は、詳細の全量を求める要求へ流用しない', async () => {
  const seed = { ok: true, reservations: [{ code: 'LM-HISTORY', detailsPending: true }], pendingEditors: ['styles', 'reviews'] };
  const app = fixture(seed);
  for (const payload of [{ type: 'adminData' }, { type: 'adminData', startupOnly: true },
    { type: 'adminData', reservationsOnly: true }]) assert.notEqual(await app.request(payload), seed);
  assert.equal(app.calls.length, 3);
  assert.equal(await app.request({ type: 'adminData', startupOnly: true, briefPast: true }), seed);
  assert.equal(app.calls.length, 3);
});

test('部分データを通常の全件取得・単一編集・通知・予約更新の代わりに渡さない', async () => {
  const seed = { ok: true, reservations: [], pendingEditors: ['styles', 'reviews'] };
  const app = fixture(seed);
  for (const payload of [{ type: 'adminData' }, { type: 'adminData', editorTarget: 'styles' },
    { type: 'adminData', notificationsOnly: true }, { type: 'adminData', reservationsOnly: true }]) {
    assert.notEqual(await app.request(payload), seed);
  }
  assert.equal(app.calls.length, 4);
  assert.equal(await app.request({ type: 'adminData', startupOnly: true }), seed);
  assert.equal(app.calls.length, 4);
});

test('旧サーバーの完全な初回データは従来要求とも互換にし、ログインなしでは返さない', async () => {
  const seed = { ok: true, reservations: [], styles: [], reviews: [] };
  const full = fixture(seed);
  assert.equal(await full.request({ type: 'adminData' }), seed);
  assert.equal(full.calls.length, 0);
  const denied = fixture(seed);
  denied.context.user = null;
  assert.equal((await denied.request({ type: 'adminData', startupOnly: true })).ok, false);
  assert.equal(denied.calls.length, 0);
});

for (const error of ['台帳の見出しを確認できません。', '店舗の予定を読めません。',
  '別の管理操作が処理中です。', '管理操作の内容をご確認ください。']) {
  test(`認証拒否ではない台帳エラーはGoogle選択を保持し、自動再送しない：${error}`, async () => {
    const app = fixture();
    const account = app.context.user;
    const generation = app.context.generation;
    app.context.response = { ok: false, error };
    await app.context.loadAdmin();
    assert.equal(app.context.user, account);
    assert.equal(app.context.generation, generation);
    assert.equal(app.context.initialAdminData, null);
    assert.equal(app.context.managementView.hidden, true);
    assert.equal(app.context.retryAccessButton.hidden, false);
    assert.match(app.context.loginStatus.textContent, /Googleのアカウント選択は完了.*台帳の読込は未完了/);
    assert.deepEqual(app.effects, [{ error }]);
    assert.equal(app.calls.length, 1);
  });
}

test('台帳の失敗後も毎回本人確認して手動で読み直し、成功結果だけを初回表示へ渡す', async () => {
  const app = fixture();
  const account = app.context.user;
  const data = app.context.response;
  let tokenReads = 0;
  account.getIdToken = async () => { tokenReads++; return randomUUID(); };
  app.context.response = { ok: false, error: '架空の台帳読込失敗' };
  await app.context.loadAdmin();
  await app.context.loadAdmin();
  assert.equal(app.calls.length, 2);
  assert.equal(tokenReads, 2);
  assert.equal(app.context.user, account);
  app.context.response = data;
  await app.context.loadAdmin();
  assert.equal(app.context.user, account);
  assert.equal(tokenReads, 3);
  assert.equal(app.calls.length, 3);
  assert.equal(app.context.initialAdminData, data);
  assert.equal(await app.request({ type: 'adminData', startupOnly: true, briefPast: true }), data);
  assert.equal(app.calls.length, 3);
  assert.equal(app.effects.filter(value => value === 'sign-out').length, 0);
});

test('理由のない台帳失敗も認証の間違いと案内せず、再読込を案内する', async () => {
  const app = fixture();
  app.context.response = { ok: false };
  await app.context.loadAdmin();
  assert.ok(app.context.user);
  assert.equal(app.context.retryAccessButton.hidden, false);
  assert.match(app.effects[0].error, /台帳.*読み込/);
  assert.doesNotMatch(app.effects[0].error, /管理権限|ログイン/);
});

test('本人選択を保持した再読込でも実際の権限失効は一度だけログアウトし、再試行で迂回できない', async () => {
  for (const rejectSignOut of [false, true]) {
    const app = fixture();
    app.context.response = { ok: false, error: '架空の台帳読込失敗' };
    await app.context.loadAdmin();
    app.context.rejectSignOut = rejectSignOut;
    app.context.response = { ok: false, authDenied: true, error: '架空の管理権限失効' };
    await app.context.loadAdmin();
    assert.equal(app.context.user, null);
    assert.equal(app.context.initialAdminData, null);
    assert.equal(app.context.managementView.hidden, true);
    assert.equal(app.context.retryAccessButton.hidden, true);
    assert.equal(app.effects.filter(value => value === 'sign-out').length, 1);
    assert.equal(app.effects.filter(value => value === 'close').length, 1);
    assert.equal(app.calls.length, 2);
    const result = await app.request({ type: 'adminData', startupOnly: true, briefPast: true });
    assert.equal(result.ok, false);
    assert.equal(app.calls.length, 2);
  }
});

test('権限拒否の理由がなくても台帳失敗ではなく再ログインを案内する', async () => {
  const app = fixture();
  app.context.response = { ok: false, authDenied: true };
  await app.context.loadAdmin();
  assert.equal(app.context.user, null);
  assert.equal(app.context.retryAccessButton.hidden, true);
  assert.match(app.effects.at(-1).error, /管理権限.*ログイン/);
  assert.equal(app.effects.filter(value => value === 'sign-out').length, 1);
});
