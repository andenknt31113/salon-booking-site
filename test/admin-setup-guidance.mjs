import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const PASSWORD = process.env.MOCK_ADMIN_PASSWORD;
const TOKEN = process.env.MOCK_ADMIN_TOKEN;
if (!PASSWORD || !TOKEN) throw new Error('MOCK_ADMIN_PASSWORD と MOCK_ADMIN_TOKEN を設定してください。');

function fixture({ googleOnly = true, configured = true, uids = 'fixture-admin', passwordInCode = true } = {}) {
  const properties = new Map([
    ['ADMIN_GOOGLE_ONLY', googleOnly ? 'true' : 'false'],
    ['ADMIN_GOOGLE_PROJECT_ID', configured ? 'fixture-project' : ''],
    ['ADMIN_GOOGLE_API_KEY', configured ? TOKEN : ''],
    ['ADMIN_GOOGLE_APP_ID', configured ? 'fixture-app' : ''],
    ['ADMIN_GOOGLE_UIDS', uids]
  ]);
  const writes = [];
  const logs = [];
  const context = vm.createContext({ console: { log: text => logs.push(text), warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) ?? null,
      setProperty(key, value) { writes.push(key); properties.set(key, value); }
    }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({}) }
  });
  vm.runInContext(SOURCE.replace("const PASSWORD = '';", `const PASSWORD = ${JSON.stringify(passwordInCode ? PASSWORD : '')};`), context);
  context.getSheet_ = () => ({});
  context.setupMenuSheets = () => {};
  context.notifyList_ = () => [];
  context.readSettings_ = () => ({});
  return { properties, writes, logs, run: () => context.はじめの準備() };
}

for (const uids of ['fixture-admin', ' , fixture-admin , ']) {
  test(`Google専用の初期準備は旧パスワードを保存・要求せず、管理入口へ案内する：${uids}`, () => {
    const app = fixture({ uids });
    const before = [...app.properties];
    app.run();
    const text = app.logs.join('\n');
    assert.match(text, /Google管理者.*入力済み/);
    assert.match(text, /admin-google\.html/);
    assert.match(text, /ログイン.*台帳/);
    assert.doesNotMatch(text, /パスワード|PASSWORD|設定しました|認証済み/);
    assert.equal(text.includes(PASSWORD), false);
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes('fixture-admin'), false);
    assert.deepEqual([...app.properties], before);
    assert.deepEqual(app.writes, []);
  });
}

for (const [configured, uids] of [[false, 'fixture-admin'], [true, ''], [true, ' , '], [false, '']]) {
  test(`Google設定や許可UIDが欠けた初期準備をログイン確認済みと案内しない：接続=${configured}／UIDあり=${!!uids}`, () => {
    const app = fixture({ configured, uids });
    app.run();
    const text = app.logs.join('\n');
    assert.match(text, /admin-google\.html/);
    assert.doesNotMatch(text, /入力済み|パスワード|PASSWORD|認証済み/);
    if (!configured) assert.match(text, /Google管理者.*接続設定.*未完了/);
    if (!uids.split(',').some(uid => uid.trim())) assert.match(text, /ADMIN_GOOGLE_UIDS/);
    assert.equal(text.includes(PASSWORD), false);
    assert.equal(text.includes(TOKEN), false);
    assert.deepEqual(app.writes, []);
  });
}

test('Google専用を設定していない旧構成の初期準備は従来の保存を保持する', () => {
  const app = fixture({ googleOnly: false });
  app.run();
  assert.deepEqual(app.writes, ['ADMIN_PASSWORD']);
  assert.equal(app.properties.get('ADMIN_PASSWORD') === PASSWORD, true);
  assert.match(app.logs.join('\n'), /管理ページのパスワードを設定しました/);
});

test('空の旧パスワードでGoogle専用モードや許可UIDを勝手に設定しない', () => {
  const app = fixture({ googleOnly: false, passwordInCode: false });
  const before = [...app.properties];
  app.run();
  assert.deepEqual(app.writes, []);
  assert.deepEqual([...app.properties], before);
  assert.match(app.logs.join('\n'), /パスワードが未設定/);
});
