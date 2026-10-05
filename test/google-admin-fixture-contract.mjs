import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openGoogleAdmin } from './google-admin-fixture.mjs';

const BASE = 'http://127.0.0.1:8080';

function fixture({ gateVisible = false, missingFrame = false, state } = {}) {
  const bindings = new Map();
  const routes = [];
  const effects = [];
  const frame = { locator: () => ({ isVisible: async () => gateVisible }),
    evaluate: async () => state || { embedded: true, passwordEmpty: true, tokenEmpty: true } };
  const shell = {
    exposeFunction: async (name, handler) => bindings.set(name, handler),
    context: () => ({ route: async (pattern, handler) => routes.push({ pattern, handler }) }),
    goto: async url => effects.push({ goto: url }),
    frameLocator: () => ({ locator: () => ({ waitFor: async () => effects.push({ ready: true }) }) }),
    locator: () => ({ elementHandle: async () => ({ contentFrame: async () => missingFrame ? null : frame }) })
  };
  const outgoing = async (url, method = 'GET') => {
    const result = [];
    await routes[0].handler({ request: () => ({ url: () => url, method: () => method }),
      abort: async () => result.push('abort'), continue: async () => result.push('continue'),
      fulfill: async value => result.push(value) });
    return result;
  };
  return { shell, frame, effects, bindings, outgoing };
}

for (const design of ['', '?design=a', '&design=a']) {
  test(`管理fixtureは実bridgeのフレームを確認し、許可したデザインだけを描画する：${design}`, async () => {
    const app = fixture();
    const seen = [];
    const admin = await openGoogleAdmin({ shell: app.shell, base: BASE, design,
      request: async payload => { seen.push(payload); return { ok: true }; } });
    assert.equal(admin.frame, app.frame);
    assert.deepEqual(app.effects, [{ goto: BASE + '/fixture-shell.html' }, { ready: true }]);
    const [html] = await app.outgoing(BASE + '/fixture-shell.html');
    assert.equal(html.contentType, 'text/html');
    assert.ok(html.body.includes(`src="admin.html?google=1${design ? '&design=a' : ''}"`));
    assert.match(html.body, /window\.authAdminRequest/);
    const payload = { type: 'adminData', startupOnly: true };
    assert.deepEqual(await app.bindings.get('fixtureAdminRequest')(payload), { ok: true });
    payload.startupOnly = false;
    assert.deepEqual(admin.operations, [{ type: 'adminData', startupOnly: true }]);
    assert.equal(seen.length, 1);
    admin.assertIsolated();
  });
}

for (const key of ['password', 'token']) {
  test(`旧認証の${key}を持つ要求は、架空台帳へ渡す前に拒否する`, async () => {
    const app = fixture();
    let writes = 0;
    const admin = await openGoogleAdmin({ shell: app.shell, base: BASE,
      request: async () => { writes++; return { ok: true }; } });
    await assert.rejects(app.bindings.get('fixtureAdminRequest')({ type: 'adminData', [key]: undefined }));
    assert.equal(writes, 0);
    assert.deepEqual(admin.operations, []);
  });
}

for (const [url, method] of [[BASE + '/exec', 'GET'], [BASE + '/exec', 'POST'],
  ['https://example.test/exec', 'POST'], ['http://127.0.0.1:8081/exec', 'POST']]) {
  test(`直接要求・外部originを送信前に遮断し、隔離検査も失敗させる：${method} ${url}`, async () => {
    const app = fixture();
    const admin = await openGoogleAdmin({ shell: app.shell, base: BASE, request: async () => ({ ok: true }) });
    assert.deepEqual(await app.outgoing(url, method), ['abort']);
    assert.throws(() => admin.assertIsolated());
  });
}

test('同じoriginの静的ファイルだけを読み、指定した架空ソースはローカルで差し替える', async () => {
  const app = fixture();
  const sourceOverride = 'globalThis.fixtureAdminSource = true;';
  const admin = await openGoogleAdmin({ shell: app.shell, base: BASE, sourceOverride,
    request: async () => ({ ok: true }) });
  assert.deepEqual(await app.outgoing(BASE + '/assets/css/style.css'), ['continue']);
  assert.deepEqual(await app.outgoing(BASE + '/assets/js/admin.js'),
    [{ contentType: 'text/javascript', body: sourceOverride }]);
  admin.assertIsolated();
});

for (const options of [{ gateVisible: true }, { missingFrame: true },
  { state: { embedded: false, passwordEmpty: true, tokenEmpty: true } },
  { state: { embedded: true, passwordEmpty: false, tokenEmpty: true } },
  { state: { embedded: true, passwordEmpty: true, tokenEmpty: false } }]) {
  test(`旧入口・管理フレーム欠落・旧認証の保持を成功扱いしない：${JSON.stringify(options)}`, async () => {
    const app = fixture(options);
    await assert.rejects(openGoogleAdmin({ shell: app.shell, base: BASE, request: async () => ({ ok: true }) }));
  });
}

for (const options of [{ base: 'https://example.test' }, { base: BASE + '/other' },
  { base: BASE, design: '&design=unknown' }]) {
  test(`架空台帳以外の接続先や任意のHTML差込を開始前に拒否する：${JSON.stringify(options)}`, async () => {
    const app = fixture();
    await assert.rejects(openGoogleAdmin({ shell: app.shell, ...options, request: async () => ({ ok: true }) }));
    assert.deepEqual(app.effects, []);
    assert.equal(app.bindings.size, 0);
  });
}
