import assert from 'node:assert/strict';

const FIXTURE_PATH = '/fixture-shell.html';

export async function openGoogleAdmin({ shell, base, design = '', request, sourceOverride = null }) {
  const origin = new URL(base);
  assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)
    && origin.origin === base, '架空台帳のローカルoriginが必要です');
  assert.ok(['', '?design=a', '&design=a'].includes(design), '比較用の管理デザインだけを指定してください');
  assert.equal(typeof request, 'function', '架空の管理要求処理が必要です');
  const operations = [];
  const external = [];
  const direct = [];
  await shell.exposeFunction('fixtureAdminRequest', async payload => {
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    assert.equal(Object.hasOwn(payload, 'password'), false, '旧パスワードを管理本体から送らない');
    assert.equal(Object.hasOwn(payload, 'token'), false, '旧合鍵を管理本体から送らない');
    operations.push(structuredClone(payload));
    return request(payload);
  });
  await shell.context().route('**/*', route => {
    const outgoing = route.request();
    const url = new URL(outgoing.url());
    if (url.origin !== base) { external.push(outgoing.method()); return route.abort(); }
    if (url.pathname === '/exec') { direct.push(outgoing.method()); return route.abort(); }
    if (sourceOverride && url.pathname === '/assets/js/admin.js') {
      return route.fulfill({ contentType: 'text/javascript', body: sourceOverride });
    }
    if (url.pathname === FIXTURE_PATH) {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width">'
        + '<style>html,body{margin:0}iframe{display:block;width:100%;height:100vh;border:0}</style>'
        + '<script>window.authAdminRequest = payload => window.fixtureAdminRequest(payload);</script>'
        + `<iframe id="management" title="架空のGoogle管理" src="admin.html?google=1${design ? '&design=a' : ''}"></iframe>` });
    }
    return route.continue();
  });
  await shell.goto(base + FIXTURE_PATH);
  await shell.frameLocator('#management').locator('#dashboard:not([hidden])').waitFor();
  const frame = await (await shell.locator('#management').elementHandle()).contentFrame();
  assert.ok(frame, '実際の管理フレームを確認する');
  assert.equal(await frame.locator('#gate').isVisible(), false, '旧ログインは表示しない');
  assert.deepEqual(await frame.evaluate(() => ({ embedded: window.googleAdminEmbedded === true,
    passwordEmpty: adminPw === '', tokenEmpty: adminToken === '' })),
  { embedded: true, passwordEmpty: true, tokenEmpty: true });
  return { frame, operations, assertIsolated() {
    assert.deepEqual(external, [], '実台帳を含む外部サービスへ接続しない');
    assert.deepEqual(direct, [], '管理要求はGoogle管理bridgeから親だけへ渡す');
  } };
}
