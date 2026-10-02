import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/admin-portal.js', import.meta.url), 'utf8');
const requestSource = source.match(/window\.authAdminRequest = async payload => {[\s\S]*?\n};/)[0];
const loadSource = source.match(/async function loadAdmin\(\) {[\s\S]*?\n}/)[0];

function fixture(seed = null) {
  const calls = [];
  const context = vm.createContext({ window: {}, actions: new Set(['adminData', 'adminSave']),
    initialAdminData: seed, user: { getIdToken: async () => randomUUID() }, generation: 1,
    withRequestTimeout: callback => callback({ aborted: false }),
    post: async body => { calls.push({ action: body.action, payload: body.payload }); return { ok: true, reservations: [] }; },
    managementView: { hidden: true }, connectionDetail: () => '',
    loginStatus: { textContent: '' }, retryAccessButton: { hidden: true },
    showAdmin: data => { context.initialAdminData = data; },
    sdk: { signOut: async () => {} }, closeAdmin() {}, showError() {}
  });
  vm.runInContext(requestSource + '\n' + loadSource, context);
  return { context, calls, request: context.window.authAdminRequest };
}

test('Google入口は起動用データを要求し、管理HTMLは同じ応答を一回だけ受け取る', async () => {
  const app = fixture();
  await app.context.loadAdmin();
  assert.equal(app.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0])), { action: 'adminData', payload: { startupOnly: true, briefPast: true } });
  const seed = app.context.initialAdminData;
  assert.equal(await app.request({ type: 'adminData', startupOnly: true, briefPast: true }), seed);
  assert.equal(app.calls.length, 1);
  await app.request({ type: 'adminData', startupOnly: true, briefPast: true });
  assert.equal(app.calls.length, 2);
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
