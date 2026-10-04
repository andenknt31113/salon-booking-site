import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const LEGACY_ACTIONS = ['adminLogin', 'adminData', 'adminSave', 'adminUpload', 'adminAdd',
  'adminAddStatus', 'adminNote', 'adminChange'];
const GOOGLE_ACTIONS = [...LEGACY_ACTIONS.filter(action => action !== 'adminLogin'), 'cancel'];
const PUBLIC_ACTIONS = ['menu', 'availability', 'lookup', 'cancel', 'change', 'review', 'reserve'];
const RETIRED_ERROR = '旧ログインは終了しました。Googleでログインしてください。';
const LOCK_ERROR = '試験用の台帳ロック混雑';
const SHARED_ERROR = '試験用の共通認証拒否';

function environment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} を設定してください。`);
  return value;
}

function backend({ mode = 'true', busy = false, legacy = false, google = 'allowed', handlers = false,
  config = true } = {}) {
  const events = [];
  const properties = new Map();
  if (mode !== undefined) properties.set('ADMIN_GOOGLE_ONLY', mode);
  if (legacy) properties.set('ADMIN_PASSWORD', environment('MOCK_ADMIN_PASSWORD'));
  let held = false;
  let now = Date.now();
  const counters = { lock: 0, release: 0, auth: 0, recovery: 0, ledger: 0, notification: 0,
    propertyWrites: 0, passwordReads: 0, operations: 0, google: 0, config: 0 };
  const service = category => new Proxy({}, { get() {
    counters[category] += 1;
    throw new Error('試験用の禁止サービス呼出し');
  } });
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    console: { error() {}, warn() {}, log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty(key) {
        if (key === 'ADMIN_PASSWORD') {
          counters.passwordReads += 1;
          assert.ok(legacy, '廃止済み要求やGoogle管理は旧パスワードを取得しない');
        }
        return properties.get(key) ?? null;
      },
      setProperty(key, value) { counters.propertyWrites += 1; properties.set(key, value); },
      deleteProperty(key) { counters.propertyWrites += 1; properties.delete(key); }
    }) },
    LockService: { getScriptLock: () => ({
      waitLock(timeout) {
        counters.lock += 1;
        events.push('lock');
        assert.equal(timeout, vm.runInContext('REQUEST_LOCK_TIMEOUT_MS', context));
        if (busy) throw new Error(LOCK_ERROR);
        assert.equal(held, false, 'ロックを二重取得しない');
        held = true;
      },
      releaseLock() { assert.equal(held, true); held = false; counters.release += 1; events.push('release'); }
    }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => text }) },
    Utilities: { getUuid: randomUUID },
    SpreadsheetApp: service('ledger'), DriveApp: service('ledger'),
    MailApp: service('notification'), CalendarApp: service('notification'), UrlFetchApp: service('notification')
  });
  vm.runInContext(SOURCE, context);
  const authenticate = context.requireAdmin_;
  context.requireAdmin_ = request => {
    counters.auth += 1;
    events.push(held ? 'auth-inside' : 'auth-outside');
    return authenticate(request);
  };
  context.recoverBookingChange_ = () => {
    assert.equal(held, true, '復旧は台帳ロック内のみ');
    counters.recovery += 1;
    events.push('recovery');
  };
  context.verifyGoogleAdmin_ = () => {
    assert.equal(held, false, 'Google認証は台帳ロック前');
    counters.google += 1;
    events.push('google');
    if (google === 'denied') throw new Error('試験用の管理権限なし');
    if (google === 'unavailable') throw Object.assign(new Error('試験用の認証通信失敗'), { authUnavailable: true });
  };
  context.googleAdminConfig_ = () => {
    counters.config += 1;
    return config ? { projectId: 'fixture-project', authDomain: 'fixture.invalid' } : null;
  };
  if (handlers) {
    context.getSheet_ = () => { assert.equal(held, true); counters.ledger += 1; return {}; };
    for (const action of LEGACY_ACTIONS) {
      if (action === 'adminLogin') continue;
      const method = `do${action[0].toUpperCase()}${action.slice(1)}_`;
      context[method] = (...args) => {
        const request = args.at(-1);
        context.requireAdmin_(request);
        assert.equal(held, request.googleAdminContext === vm.runInContext('GOOGLE_ADMIN_CONTEXT', context)
          ? action !== 'adminUpload' : true, 'Google画像以外の操作は既存ロック内');
        counters.operations += 1;
        events.push(action);
        return { ok: true, action };
      };
    }
    for (const action of PUBLIC_ACTIONS) {
      const method = `do${action[0].toUpperCase()}${action.slice(1)}_`;
      context[method] = (...args) => {
        assert.equal(held, true, '公開操作は既存の台帳ロック内');
        const request = args.find(value => value?.googleAdminContext);
        if (request?.googleAdminContext === vm.runInContext('GOOGLE_ADMIN_CONTEXT', context)) context.requireAdmin_(request);
        counters.operations += 1;
        events.push(action);
        return { ok: true, action };
      };
    }
  }
  return {
    context, counters, events, properties,
    advance: milliseconds => { now += milliseconds; },
    constant: name => vm.runInContext(name, context),
    raw(contents) {
      const response = JSON.parse(context.doPost({ postData: { contents } }));
      assert.equal(held, false, '応答後にロックを残さない');
      return response;
    },
    send(request) { return this.raw(JSON.stringify(request)); }
  };
}

function untouched(app, { auth = 0 } = {}) {
  assert.deepEqual(app.counters, { lock: 0, release: 0, auth, recovery: 0, ledger: 0, notification: 0,
    propertyWrites: 0, passwordReads: 0, operations: 0, google: 0, config: 0 });
}

for (const action of LEGACY_ACTIONS) {
  for (const busy of [true, false]) {
    test(`Google専用：${action}は混雑${busy}でも共通認証でロック前拒否し、JSONの管理印を信頼しない`, () => {
      for (const forged of [{}, true, 'GOOGLE_ADMIN_CONTEXT', undefined]) {
        const app = backend({ busy });
        const response = app.send({ type: action, googleAdminContext: forged, remember: true,
          token: null, password: null, isAdmin: true, force: true });
        assert.equal(response.ok, false);
        assert.equal(response.error, RETIRED_ERROR, 'ロック待ちでなく旧入口の廃止を返す');
        untouched(app, { auth: 1 });
        assert.deepEqual(app.events, ['auth-outside']);
      }
    });
  }
  test(`Google専用：${action}の拒否はrequireAdmin_を迂回しない`, () => {
    const app = backend({ busy: true });
    app.context.requireAdmin_ = () => { app.counters.auth += 1; throw app.context.userFacingError_(SHARED_ERROR); };
    assert.equal(app.send({ type: action }).error, SHARED_ERROR);
    untouched(app, { auth: 1 });
  });
}

test('公開設定を除く全旧管理typeとGoogle管理actionを試験対象から漏らさない', () => {
  const app = backend();
  const actions = [...app.constant('POST_REQUEST_TYPES')].filter(action => action.startsWith('admin')
    && action !== 'adminAuthConfig');
  assert.deepEqual(actions.slice().sort(), LEGACY_ACTIONS.slice().sort());
  assert.deepEqual([...app.constant('GOOGLE_ADMIN_ACTIONS')].sort(), GOOGLE_ACTIONS.slice().sort());
});

for (const [label, mode] of [['未設定', undefined], ['false', 'false'], ['空', ''], ['大文字', 'TRUE']]) {
  for (const action of LEGACY_ACTIONS) {
    test(`旧方式${label}：${action}はロック内認証を維持し、認証拒否後は復旧しない`, () => {
      const app = backend({ mode, legacy: true });
      if (mode === undefined) app.properties.delete('ADMIN_GOOGLE_ONLY');
      const response = app.send({ type: action });
      assert.equal(response.error, 'パスワードが違います。');
      assert.deepEqual(app.events, ['lock', 'auth-inside', 'release']);
      assert.equal(app.counters.recovery, 0);
      assert.equal(app.counters.ledger, 0);
      assert.equal(app.counters.notification, 0);
      assert.equal(app.counters.propertyWrites, 0);
      assert.equal(app.counters.auth, 1);
    });
    test(`旧方式${label}：${action}の混雑時は認証順を維持し、内部のロック例外を公開しない`, () => {
      const app = backend({ mode, busy: true });
      if (mode === undefined) app.properties.delete('ADMIN_GOOGLE_ONLY');
      const response = app.send({ type: action });
      assert.equal(response.ok, false);
      assert.equal(response.error, app.constant('UNKNOWN_REQUEST_ERROR'));
      assert.equal(response.error.includes(LOCK_ERROR), false);
      assert.deepEqual(app.events, ['lock']);
      assert.equal(app.counters.auth, 0);
      assert.equal(app.counters.passwordReads, 0);
      assert.equal(app.counters.recovery, 0);
      assert.equal(app.counters.propertyWrites, 0);
      assert.equal(app.counters.ledger, 0);
      assert.equal(app.counters.notification, 0);
    });
  }
}

test('旧方式：全管理操作が同じ失敗回数を使い、成功・期限・記憶済み端末の保護を維持する', () => {
  const app = backend({ mode: 'false', legacy: true });
  const wrong = environment('MOCK_ADMIN_PASSWORD') + randomUUID();
  const limit = app.constant('ADMIN_MAX_FAILS');
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const action = LEGACY_ACTIONS[attempt % LEGACY_ACTIONS.length];
    assert.equal(app.send({ type: action, password: wrong }).ok, false);
    assert.equal(JSON.parse(app.properties.get('ADMIN_FAILS')).n, attempt + 1);
  }
  for (const type of LEGACY_ACTIONS) {
    const response = app.send({ type, password: environment('MOCK_ADMIN_PASSWORD') });
    assert.equal(response.ok, false);
    assert.ok(response.error.includes('お待ちください'));
  }
  assert.equal(app.counters.recovery, 0);
  assert.equal(app.counters.ledger, 0);
  assert.equal(app.counters.notification, 0);
  const token = environment('MOCK_ADMIN_TOKEN');
  app.properties.set('ADMIN_TOKENS', JSON.stringify({ [token]: Date.now() + 60000 }));
  assert.equal(app.send({ type: 'adminLogin', token }).ok, true);
  app.advance(app.constant('ADMIN_LOCK_MINUTES') * 60 * 1000);
  assert.equal(app.send({ type: 'adminLogin', password: environment('MOCK_ADMIN_PASSWORD') }).ok, true);
  assert.equal(app.properties.has('ADMIN_FAILS'), false);
});

for (const action of LEGACY_ACTIONS) {
  test(`旧方式の正規${action}は既存のロック・認証・復旧順で成功する`, () => {
    const app = backend({ mode: 'false', legacy: true, handlers: true });
    const response = app.send({ type: action, password: environment('MOCK_ADMIN_PASSWORD') });
    assert.equal(response.ok, true);
    assert.deepEqual(app.events.slice(0, 3), ['lock', 'auth-inside', 'recovery']);
    assert.equal(app.events.at(-1), 'release');
    assert.equal(app.counters.lock, 1);
    assert.equal(app.counters.recovery, 1);
    assert.equal(app.events.includes('auth-outside'), false);
  });
}

for (const action of GOOGLE_ACTIONS) {
  test(`正規Google管理${action}は旧ログイン拒否を受けず、既存の操作経路を維持する`, () => {
    const app = backend({ handlers: true });
    const response = app.send({ type: 'googleAdmin', action, payload: { googleAdminContext: {} } });
    assert.equal(response.ok, true);
    assert.equal(response.action, action);
    assert.equal(app.events[0], 'google');
    assert.equal(app.counters.passwordReads, 0);
    assert.equal(app.counters.notification, 0);
    assert.equal(app.counters.propertyWrites, 0);
    assert.equal(app.counters.auth >= 1, true);
    assert.equal(app.counters.lock, action === 'adminUpload' ? 0 : 1);
    assert.equal(app.counters.recovery, action === 'adminUpload' ? 0 : 1);
  });
  for (const google of ['denied', 'unavailable']) {
    test(`Google管理${action}の${google}はロック・旧認証・台帳へ入らない`, () => {
      const app = backend({ google, busy: true });
      const response = app.send({ type: 'googleAdmin', action, payload: {} });
      assert.equal(response.ok, false);
      assert.equal(google === 'denied' ? response.authDenied : response.transportError, true);
      assert.deepEqual(app.events, ['google']);
      assert.equal(app.counters.lock, 0);
      assert.equal(app.counters.auth, 0);
      assert.equal(app.counters.recovery, 0);
      assert.equal(app.counters.ledger, 0);
      assert.equal(app.counters.notification, 0);
      assert.equal(app.counters.propertyWrites, 0);
      assert.equal(app.counters.passwordReads, 0);
    });
  }
}

for (const type of [...PUBLIC_ACTIONS, undefined]) {
  test(`公開${type ?? '旧予約形式'}はGoogle専用でも既存のロック内処理を維持する`, () => {
    const app = backend({ handlers: true });
    const response = app.send({ type });
    assert.equal(response.ok, true);
    assert.equal(response.action, type ?? 'reserve');
    assert.deepEqual(app.events, ['lock', 'recovery', type ?? 'reserve', 'release']);
    assert.equal(app.counters.auth, 0);
    assert.equal(app.counters.passwordReads, 0);
    assert.equal(app.counters.propertyWrites, 0);
  });
}

for (const config of [false, true]) {
  test(`公開adminAuthConfigの接続設定${config}は台帳ロックも旧認証も不要`, () => {
    const app = backend({ config, busy: true });
    assert.equal(app.send({ type: 'adminAuthConfig', googleAdminContext: {} }).ok, config);
    assert.equal(app.counters.config, 1);
    app.counters.config = 0;
    untouched(app);
  });
}

test('壊れたJSON・型・未知操作は認証やロック取得より前に拒否する', () => {
  for (const contents of ['{', 'null', '[]', '1', '"text"', '{"type":null}', '{"type":1}',
    '{"type":{}}', '{"type":[]}', '{"type":"unknown"}']) {
    const app = backend({ busy: true });
    const response = app.raw(contents);
    assert.equal(response.ok, false);
    untouched(app);
  }
});

test('不正なGoogle管理操作は確認サービスも共通認証も呼ばない', () => {
  for (const payload of [{ action: 'adminLogin', payload: {} }, { action: 'adminData', payload: null },
    { action: 'adminData', payload: [] }, { action: 'unknown', payload: {} }]) {
    const app = backend({ busy: true });
    assert.equal(app.send({ type: 'googleAdmin', ...payload }).ok, false);
    untouched(app);
  }
});
