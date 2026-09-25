import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const PASSWORD = process.env.MOCK_ADMIN_PASSWORD;
if (!PASSWORD) throw new Error('MOCK_ADMIN_PASSWORD を設定してください。');
const SOURCE = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const ADMIN_ACTIONS = ['adminLogin', 'adminData', 'adminSave', 'adminUpload', 'adminAdd', 'adminAddStatus', 'adminNote', 'adminChange'];

function backend() {
  const properties = new Map([['ADMIN_PASSWORD', PASSWORD]]);
  const cloudCalls = [];
  const logs = [];
  let now = Date.now();
  let held = false;
  const cloud = new Proxy({}, { get: (target, method) => () => {
    cloudCalls.push(String(method));
    throw new Error('試験用：認証前の外部サービス呼び出し');
  } });
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...items) => logs.push(items.map(String).join(' '))])),
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) ?? null,
      setProperty: (key, value) => properties.set(key, value),
      deleteProperty: key => properties.delete(key),
      getKeys: () => [...properties.keys()]
    }) },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(held, false, '同じ処理でロックを二重取得しない'); held = true; },
      releaseLock() { held = false; }
    }) },
    ContentService: { createTextOutput: text => ({ setMimeType: () => text }), MimeType: { JSON: 'json' } },
    Utilities: { getUuid: randomUUID },
    SpreadsheetApp: cloud, DriveApp: cloud, MailApp: cloud, CalendarApp: cloud, UrlFetchApp: cloud
  });
  vm.runInContext(SOURCE, context);
  return {
    context, properties, logs, cloudCalls,
    advance: milliseconds => { now += milliseconds; },
    constant: name => vm.runInContext(name, context),
    sendRaw(contents) {
      const result = JSON.parse(context.doPost({ postData: { contents } }));
      assert.equal(held, false, '応答後にロックを残さない');
      return result;
    },
    send(body) { return this.sendRaw(JSON.stringify(body)); }
  };
}

test('管理APIはすべて、認証前に台帳・画像・通知へ触れない', () => {
  const routed = [...SOURCE.matchAll(/data\.type === '(admin\w+)'/g)].map(match => match[1]);
  assert.ok(routed.includes('adminAuthConfig'), '公開設定の入口も試験対象に含める');
  assert.deepEqual([...new Set(routed.filter(type => type !== 'adminAuthConfig'))].sort(), ADMIN_ACTIONS.slice().sort(), '管理APIの追加時は認証試験も追加する');
  for (const type of ADMIN_ACTIONS) {
    for (const credentials of [{}, { password: PASSWORD + randomUUID() }, { token: randomUUID() }]) {
      const instance = backend();
      const response = instance.send({ type, ...credentials, demo: true, isAdmin: true, force: true });
      assert.equal(response.ok, false, `${type} は管理者の自己申告で通さない`);
      assert.equal(response.error, 'パスワードが違います。', `${type} は認証拒否を返す`);
      assert.deepEqual(instance.cloudCalls, [], `${type} は認証前に外部サービスへ触れない`);
      assert.equal(instance.properties.has('ADMIN_TOKENS'), false, '認証失敗で合鍵を発行しない');
    }
  }
});

test('パスワード未設定では、残存する端末の合鍵も管理権限に使えない', () => {
  const instance = backend();
  const token = instance.context.issueToken_();
  instance.properties.delete('ADMIN_PASSWORD');
  assert.equal(instance.send({ type: 'adminLogin', token }).ok, false, 'ログインは未設定を拒否する');
  assert.equal(instance.context.isAdmin_({ token }), false, '変更・取消の管理者判定も未設定を拒否する');
  assert.deepEqual(instance.cloudCalls, [], '未設定で台帳へ触れない');
});

test('記憶しないログインは合鍵を作らず、記憶した端末も期限切れ・全解除後は拒否する', () => {
  const instance = backend();
  assert.equal(instance.send({ type: 'adminLogin', password: PASSWORD, remember: false }).ok, true);
  assert.equal(instance.properties.has('ADMIN_TOKENS'), false, '記憶しない端末の合鍵は保存しない');
  const response = instance.send({ type: 'adminLogin', password: PASSWORD, remember: true });
  assert.equal(response.ok, true);
  assert.ok(typeof response.token === 'string' && response.token.length > 0, '記憶する端末にだけ合鍵を発行する');
  assert.equal(instance.context.isAdmin_({ token: response.token }), true, '有効な合鍵は受け付ける');
  const lifetime = instance.constant('TOKEN_DAYS') * 24 * 60 * 60 * 1000;
  instance.advance(lifetime);
  assert.equal(instance.context.isAdmin_({ token: response.token }), false, '期限の境界から拒否する');
  const replacement = instance.context.issueToken_();
  instance.context.revokeAllAdminTokens();
  assert.equal(instance.context.isAdmin_({ token: replacement }), false, '解除した端末の合鍵は再利用できない');
});

test('ログイン・取消の管理者判定は同じ失敗制限を使い、記憶済み端末の復旧経路を残す', () => {
  const instance = backend();
  const token = instance.context.issueToken_();
  const limit = instance.constant('ADMIN_MAX_FAILS');
  const wrongPassword = PASSWORD + randomUUID();
  for (let attempt = 0; attempt < limit; attempt += 1) {
    assert.equal(instance.context.isAdmin_({ password: wrongPassword }), false);
  }
  const rejected = instance.send({ type: 'adminLogin', password: PASSWORD });
  assert.equal(rejected.ok, false, '制限中は正しいパスワードでも待機する');
  assert.ok(rejected.error.includes('お待ちください'), '通信障害でなく待機と分かる');
  assert.equal(instance.send({ type: 'adminLogin', token }).ok, true, '記憶済みの端末は使える');
  assert.equal(instance.context.isAdmin_({ token }), true, '取消側も同じ合鍵を受け付ける');
  instance.advance(instance.constant('ADMIN_LOCK_MINUTES') * 60 * 1000);
  assert.equal(instance.send({ type: 'adminLogin', password: PASSWORD }).ok, true, '待機期限後は再試行できる');
  assert.equal(instance.properties.has('ADMIN_FAILS'), false, '成功後は失敗回数を消す');
});

test('壊れた送信データを応答やログに写さず、外部サービスにも触れない', () => {
  for (const contents of [PASSWORD + ' }', JSON.stringify({ password: PASSWORD }).slice(0, -1), 'null', '[]', '1', JSON.stringify({ type: 1 })]) {
    const instance = backend();
    const response = instance.sendRaw(contents);
    assert.equal(response.ok, false, '壊れた入力は受け付けない');
    assert.ok(response.error === '送信内容を読み取れませんでした。ページを読み込み直してからお試しください。', '生の解析エラーを返さない');
    assert.equal(JSON.stringify(response).includes(PASSWORD), false, '秘密情報を応答へ写さない');
    assert.equal(instance.logs.some(entry => entry.includes(PASSWORD)), false, '秘密情報をログへ写さない');
    assert.deepEqual(instance.cloudCalls, [], '壊れた入力で台帳へ触れない');
  }
});

test('変更・取消の本人確認は、未認証の自己申告で省略できない', () => {
  const headers = ['予約番号', '電話番号', '状態'];
  const values = [headers, ['LM-TESTA', '00000000001', '予約確定']];
  for (const action of ['doCancel_', 'doChange_']) {
    const instance = backend();
    let writes = 0;
    const sheet = {
      getLastRow: () => values.length,
      getLastColumn: () => headers.length,
      getRange: (row, column, height = 1, width = 1) => ({
        getValues: () => values.slice(row - 1, row - 1 + height).map(cells => cells.slice(column - 1, column - 1 + width)),
        setValue: () => { writes += 1; }
      })
    };
    const response = instance.context[action](sheet, { code: 'LM-TESTA', isAdmin: true, demo: true, force: true });
    assert.equal(response.ok, false, '管理者の自己申告で電話番号の確認を省略しない');
    assert.ok(response.error.includes('電話番号'), '本人確認で拒否する');
    assert.equal(writes, 0, '未認証の変更・取消は台帳を変えない');
    assert.deepEqual(instance.cloudCalls, [], '通知や予定を変更しない');
  }
});
