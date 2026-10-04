import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const CANARY = process.env.MOCK_ADMIN_TOKEN;
if (!CANARY) throw new Error('MOCK_ADMIN_TOKEN を設定してください。');
const TECHNICAL_MESSAGE = `https://service.example.test/?key=${CANARY} customer@example.test private-ledger-id`;

function fixture({ action = 'reserve', error, authFailure = false, authUnavailable = false,
  configurationFailure = false, lockFailure = false, integrations = false } = {}) {
  const logs = [];
  const operations = [];
  let held = false;
  let source = SOURCE;
  if (integrations) {
    source = source.replace(/const CALENDAR_ID\s*=\s*'';/, "const CALENDAR_ID = 'primary';")
      .replace(/const LINE_TOKEN\s*=\s*'';/, 'const LINE_TOKEN = FIXTURE_TOKEN;')
      .replace(/const LINE_TO\s*=\s*'';/, "const LINE_TO = 'fixture-recipient';");
  }
  const context = vm.createContext({
    FIXTURE_TOKEN: CANARY,
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level,
      (...values) => logs.push({ level, values })])),
    PropertiesService: { getScriptProperties: () => ({ getProperty(key) {
      if (configurationFailure) throw error;
      return key === 'ADMIN_GOOGLE_ONLY' ? 'true' : null;
    } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    LockService: { getScriptLock: () => ({ waitLock() {
      operations.push('lock');
      if (lockFailure) throw error;
      assert.equal(held, false);
      held = true;
    }, releaseLock() { assert.equal(held, true); held = false; operations.push('release'); } }) },
    MailApp: { sendEmail() { operations.push('mail'); throw error; } },
    UrlFetchApp: { fetch() { operations.push('fetch'); throw error; } },
    CalendarApp: { getDefaultCalendar() { operations.push('calendar'); throw error; } }
  });
  vm.runInContext(source, context);
  context.verifyGoogleAdmin_ = () => {
    operations.push('authorize');
    assert.equal(held, false);
    if (authFailure) throw authUnavailable ? Object.assign(error, { authUnavailable: true }) : error;
  };
  context.getSheet_ = () => { assert.equal(held, true); return {}; };
  context['do' + action.charAt(0).toUpperCase() + action.slice(1) + '_'] = () => {
    if (action !== 'adminUpload') assert.equal(held, true);
    operations.push('operation');
    throw error;
  };
  const send = body => {
    const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }));
    assert.equal(held, false);
    return result;
  };
  const userError = message => typeof context.userFacingError_ === 'function'
    ? context.userFacingError_(message) : new Error(message);
  return { context, logs, operations, send, userError,
    setError(value) { error = value; },
    request: () => action.startsWith('admin')
      ? send({ type: 'googleAdmin', action, idToken: CANARY, payload: {} }) : send({ type: action }) };
}

function assertPrivate(result, logs) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
  for (const value of [CANARY, 'customer@example.test', 'private-ledger-id', 'service.example.test']) {
    assert.equal(result.error.includes(value), false, '公開の案内へ内部の値を返さない');
    for (const entry of logs) {
      for (const logged of entry.values) {
        assert.equal(typeof logged, 'string', '例外オブジェクトをログへ渡さない');
        assert.equal(logged.includes(value), false, '内部の値をログへ渡さない');
      }
    }
  }
}

for (const action of ['reserve', 'lookup', 'availability', 'menu', 'change', 'cancel', 'review',
  'adminData', 'adminSave', 'adminNote', 'adminAdd', 'adminAddStatus', 'adminChange', 'adminUpload']) {
  test(`実入口の${action}はサービス例外の認証値・顧客情報を表示せず、結果不明と案内する`, () => {
    const app = fixture({ action, error: new Error(TECHNICAL_MESSAGE) });
    const result = app.request();
    assertPrivate(result, app.logs);
    assert.match(result.error, /結果.*確認できません/);
    assert.match(result.error, /繰り返さず/);
    assert.equal(Object.hasOwn(result, 'reservation'), false);
    assert.equal(Object.hasOwn(result, 'reservations'), false);
    assert.equal(result.invalid, undefined);
    assert.equal(app.operations.filter(operation => operation === 'operation').length, 1);
    assert.equal(app.operations.filter(operation => operation === 'release').length, action === 'adminUpload' ? 0 : 1);
  });
}

for (const [label, makeError] of [
  ['文字列', () => TECHNICAL_MESSAGE], ['null', () => null], ['undefined', () => undefined],
  ['数値', () => 4000], ['messageを持つ通常オブジェクト', () => ({ message: TECHNICAL_MESSAGE })],
  ['messageを持たないオブジェクト', () => ({ privateData: CANARY })]
]) {
  test(`例外が${label}でも公開入口は内部の値を返さない`, () => {
    const app = fixture({ error: makeError() });
    assertPrivate(app.request(), app.logs);
  });
}

test('messageのgetter・toStringを評価して個人情報を露出したり再度例外を起こさない', () => {
  let inspected = 0;
  const error = { get message() { inspected++; throw new Error(TECHNICAL_MESSAGE); },
    toString() { inspected++; return TECHNICAL_MESSAGE; } };
  const app = fixture({ error });
  assertPrivate(app.request(), app.logs);
  assert.equal(inspected, 0);
});

for (const authUnavailable of [false, true]) {
  test(`Google確認の失敗も例外の値を返さず、従来の認証状態を保つ ${authUnavailable}`, () => {
    const app = fixture({ action: 'adminData', error: new Error(TECHNICAL_MESSAGE), authFailure: true, authUnavailable });
    const result = app.request();
    assertPrivate(result, app.logs);
    assert.equal(authUnavailable ? result.transportError : result.authDenied, true);
    assert.equal(authUnavailable ? result.authDenied : result.transportError, undefined);
    assert.deepEqual(app.operations, ['authorize']);
  });
}

for (const [label, error] of [['null', null], ['undefined', undefined], ['文字列', TECHNICAL_MESSAGE]]) {
  test(`Google確認が${label}で失敗しても公開の失敗応答を返し、台帳へ進まない`, () => {
    const app = fixture({ action: 'adminData', error, authFailure: true });
    const result = app.request();
    assertPrivate(result, app.logs);
    assert.equal(result.authDenied, true);
    assert.deepEqual(app.operations, ['authorize']);
  });
}

test('Google接続設定のサービス例外を、未認証の訪問者へ返さない', () => {
  const app = fixture({ error: new Error(TECHNICAL_MESSAGE), configurationFailure: true });
  assertPrivate(app.send({ type: 'adminAuthConfig' }), app.logs);
  assert.deepEqual(app.operations, []);
});

test('ロックのサービス例外でも値を露出せず、台帳操作や他の処理の解放をしない', () => {
  const app = fixture({ error: new Error(TECHNICAL_MESSAGE), lockFailure: true });
  assertPrivate(app.request(), app.logs);
  assert.deepEqual(app.operations, ['lock']);
});

for (const [label, message] of [
  ['見出し', '予約台帳の見出しを確認できません。保存し直さず、制作担当者へ連絡して元の台帳を確認してください。'],
  ['台帳なし', '予約台帳を確認できません。'],
  ['メモ', '施術メモの保存結果を確認できません。入力をコピーしてから最新のメモを確認してください。'],
  ['電話受付', '電話予約の保存結果を確認できません。新しく登録せず、同じ電話受付の登録結果を確認してください。'],
  ['旧ログイン', '旧ログインは終了しました。Googleでログインしてください。'],
  ['本人確認', 'Googleログインを確認できません。もう一度ログインしてください。']
]) {
  test(`アプリ自身が作った${label}の案内は書き換えず返す`, () => {
    const app = fixture();
    app.setError(app.userError(message));
    const result = app.request();
    assert.equal(result.ok, false);
    assert.equal(result.error, message);
    assert.equal(result.invalid, undefined);
  });
}

for (const flags of [{ unknown: true }, { restored: true }, { invalid: true },
  { unknown: true, invalid: true }, { restored: true, invalid: true }]) {
  test(`案内の保護でも保存確認・復旧・入力検証の状態を変えない ${JSON.stringify(flags)}`, () => {
    const app = fixture();
    app.setError(Object.assign(app.userError('入力を残して現在の結果を確認してください。'), flags));
    const result = app.request();
    assert.equal(result.error, '入力を残して現在の結果を確認してください。');
    assert.equal(result.unknown, flags.unknown ? true : undefined);
    assert.equal(result.restored, flags.restored ? true : undefined);
    assert.equal(result.invalid, flags.invalid && !flags.unknown && !flags.restored ? true : undefined);
  });
}

test('公開可能な案内は例外作成時の値を保持し、messageの後付けや自己申告で変更しない', () => {
  const app = fixture();
  const error = app.userError('予約台帳を確認できません。');
  error.message = TECHNICAL_MESSAGE;
  app.setError(error);
  const result = app.request();
  assertPrivate(result, app.logs);
  assert.equal(result.error, '予約台帳を確認できません。');
  app.setError(Object.assign(new Error(TECHNICAL_MESSAGE), { userFacing: true, safe: true }));
  assertPrivate(app.request(), app.logs);
});

for (const [name, call, expected] of [
  ['店舗メール', context => context.notify_('架空の件名', '架空の本文', { 通知先メール: 'shop@example.test' }), '送信失敗'],
  ['顧客メール', context => context.mailCustomer_('customer@example.test', '架空の件名', '架空の本文'), '送信失敗'],
  ['LINE', context => context.notifyLine_('架空の本文'), undefined],
  ['カレンダー登録', context => context.addToCalendar_({}, {}, '架空メニュー'), ''],
  ['カレンダー削除', context => context.removeFromCalendar_('fixture-event'), false],
  ['メール状態記録', context => context.recordMailStatus_({ getLastColumn() { throw new Error(TECHNICAL_MESSAGE); } }, 2, '新規予約', '送信失敗', '送信失敗'), undefined]
]) {
  test(`${name}の失敗は従来の結果を保ち、例外オブジェクトや値をログへ出さない`, () => {
    const app = fixture({ error: new Error(TECHNICAL_MESSAGE), integrations: true });
    assert.equal(call(app.context), expected);
    assert.equal(app.logs.length, 1);
    assert.equal(app.logs[0].level, 'warn');
    assertPrivate({ ok: false, error: '処理を確認できません。' }, app.logs);
  });
}
