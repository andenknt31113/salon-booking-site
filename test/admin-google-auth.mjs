import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const PROJECT = 'zer01-local-test';
const UID = '試験用の管理者';
const now = Math.floor(Date.now() / 1000);
const claims = (change = {}) => ({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`,
  sub: UID, email_verified: true, firebase: { sign_in_provider: 'google.com' },
  exp: now + 3600, iat: now - 60, auth_time: now - 60, ...change });
const token = payload => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'c2ln'].join('.');

function backend({ properties = {}, account = {}, status = 200 } = {}) {
  const stored = new Map(Object.entries({ ADMIN_GOOGLE_PROJECT_ID: PROJECT,
    ADMIN_GOOGLE_API_KEY: '試験用の公開設定', ADMIN_GOOGLE_APP_ID: '試験用アプリ',
    ADMIN_GOOGLE_UIDS: UID, ...properties }));
  let lookupCalls = 0;
  let sheetCalls = 0;
  let accepted;
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => stored.get(key) || null,
      setProperty: (key, value) => stored.set(key, value), deleteProperty: key => stored.delete(key) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: body => ({ setMimeType: () => body }), MimeType: { JSON: 'json' } },
    Utilities: { base64DecodeWebSafe: value => Buffer.from(value, 'base64url'),
      newBlob: value => ({ getDataAsString: () => Buffer.from(value).toString('utf8') }) },
    UrlFetchApp: { fetch: (url, options) => {
      lookupCalls += 1;
      assert.match(url, /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:lookup\?key=/);
      assert.equal(options.method, 'post');
      assert.deepEqual(Object.keys(JSON.parse(options.payload)), ['idToken']);
      return { getResponseCode: () => status,
        getContentText: () => JSON.stringify({ users: [{ localId: UID, emailVerified: true,
          validSince: String(now - 1000), ...account }] }) };
    } },
    SpreadsheetApp: new Proxy({}, { get: () => () => { sheetCalls += 1; throw new Error('認証前に台帳へ触れた'); } })
  });
  vm.runInContext(SOURCE, context);
  context.doAdminData_ = request => {
    accepted = request;
    context.requireAdmin_(request);
    return { ok: true, reservations: [] };
  };
  const send = body => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }));
  return { context, stored, send, get lookupCalls() { return lookupCalls; },
    get sheetCalls() { return sheetCalls; }, get accepted() { return accepted; } };
}

test('Googleの本人確認と許可が揃った場合だけ管理操作へ進む', () => {
  const app = backend();
  const result = app.send({ type: 'googleAdmin', action: 'adminData', idToken: token(claims()), payload: {} });
  assert.equal(result.ok, true);
  assert.equal(app.lookupCalls, 1);
  assert.equal(app.sheetCalls, 0);
  assert.equal(app.accepted.type, 'adminData');
  assert.equal(Object.hasOwn(app.accepted, 'password'), false);
});

test('公開接続設定はWebアプリの識別情報だけを返し、許可リストと旧パスワードを漏らさない', () => {
  const app = backend({ properties: { ADMIN_PASSWORD: '試験用の旧パスワード' } });
  const result = app.send({ type: 'adminAuthConfig' });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.firebase).sort(), ['apiKey', 'appId', 'authDomain', 'projectId']);
  assert.equal(JSON.stringify(result).includes(UID), false);
  assert.equal(JSON.stringify(result).includes('試験用の旧パスワード'), false);
  assert.equal(app.lookupCalls, 0);
  assert.equal(app.sheetCalls, 0);
});

test('Google専用への切替後は、正しい旧パスワードと端末の合鍵も拒否する', () => {
  const app = backend({ properties: { ADMIN_GOOGLE_ONLY: 'true', ADMIN_PASSWORD: '試験用の旧パスワード' } });
  for (const body of [
    { type: 'adminLogin', password: '試験用の旧パスワード' },
    { type: 'adminData', password: '試験用の旧パスワード' },
    { type: 'adminData', token: '昔の合鍵' }
  ]) {
    const result = app.send(body);
    assert.equal(result.ok, false);
    assert.equal(result.error?.includes('旧ログイン'), true);
  }
  assert.equal(app.context.isAdmin_({ password: '試験用の旧パスワード' }), false, '取消の店側権限にも旧方式を使えない');
  const google = app.send({ type: 'googleAdmin', action: 'adminData', idToken: token(claims()), payload: {} });
  assert.equal(google.ok, true, 'Googleだけは管理画面へ進める');
  assert.equal(app.sheetCalls, 0, '旧方式では台帳を読まない');
});

test('管理者の自己申告、古いパスワード、偽の内部印は通さない', () => {
  const app = backend({ properties: { ADMIN_PASSWORD: '' } });
  for (const body of [
    { type: 'googleAdmin', action: 'adminData', payload: { isAdmin: true } },
    { type: 'googleAdmin', action: 'adminData', idToken: 'not-a-token', payload: {} },
    { type: 'googleAdmin', action: 'adminData', idToken: token(claims()), payload: { googleAdminContext: {}, isAdmin: true }, password: '旧方式' },
    { type: 'adminData', password: '旧方式', googleAdminContext: {} }
  ]) {
    const result = app.send(body);
    if (body.idToken && body.idToken !== 'not-a-token') assert.equal(result.ok, true, '内部印を利用者の値で置き換えない');
    else assert.equal(result.ok, false);
  }
  assert.equal(app.sheetCalls, 0);
});

test('別人・別プロジェクト・Google以外・未確認・期限切れ・失効・無効化は台帳より前に拒否する', () => {
  const cases = [
    { token: claims({ sub: '別人' }) },
    { token: claims({ aud: '別のプロジェクト' }) },
    { token: claims({ firebase: { sign_in_provider: 'password' } }) },
    { token: claims({ email_verified: false }) },
    { token: claims({ exp: now - 1 }) },
    { token: claims(), account: { validSince: String(now) } },
    { token: claims(), account: { disabled: true } },
    { token: claims(), account: { emailVerified: false } },
    { token: claims(), account: { localId: '別人' } },
    { token: claims(), status: 400 },
    { token: claims(), properties: { ADMIN_GOOGLE_UIDS: '' } }
  ];
  for (const item of cases) {
    const app = backend({ account: item.account, status: item.status, properties: item.properties });
    const result = app.send({ type: 'googleAdmin', action: 'adminData', idToken: token(item.token), payload: {} });
    assert.equal(result.ok, false, JSON.stringify(item));
    assert.equal(app.sheetCalls, 0, '認証拒否の間は台帳に触れない');
  }
});

test('許可しない管理操作と壊れた送信は本人確認や台帳へ進めない', () => {
  const app = backend();
  for (const action of ['reserve', 'lookup', 'adminLogin', 'unknown']) {
    assert.equal(app.send({ type: 'googleAdmin', action, idToken: token(claims()), payload: {} }).ok, false);
  }
  assert.equal(app.send({ type: 'googleAdmin', action: 'adminData', idToken: token(claims()), payload: [] }).ok, false);
  assert.equal(app.lookupCalls, 0);
  assert.equal(app.sheetCalls, 0);
});
