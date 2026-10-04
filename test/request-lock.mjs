import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');

function fixture({ denied = false, unavailable = false, occupied = false } = {}) {
  const events = [];
  let held = false;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    console: { error() {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    LockService: { getScriptLock: () => ({
      waitLock() {
        events.push('ロック待ち');
        if (occupied || held) throw new Error('ロック中');
        held = true;
        events.push('取得');
      },
      releaseLock() { assert.equal(held, true, '取得したロックだけを解放する'); held = false; events.push('解放'); }
    }) }
  });
  vm.runInContext(source, context);
  context.googleAdminConfig_ = () => ({ projectId: '検証用' });
  context.verifyGoogleAdmin_ = () => {
    assert.equal(held, false, 'Googleへの通信中は予約を待たせない');
    events.push('本人確認');
    if (denied) throw new Error('許可なし');
    if (unavailable) throw Object.assign(new Error('通信断'), { authUnavailable: true });
  };
  context.getSheet_ = () => { assert.equal(held, true, '台帳へのアクセスはロック内'); return {}; };
  const read = () => { assert.equal(held, true); events.push('読取'); return { ok: true }; };
  const write = () => { assert.equal(held, true); events.push('最終照合', '保存'); return { ok: true }; };
  context.doAdminData_ = request => { context.requireAdmin_(request); return read(); };
  context.doAdminNote_ = (sheet, request) => { context.requireAdmin_(request); return write(); };
  context.doReserve_ = write;
  context.doChange_ = write;
  context.doCancel_ = write;
  context.doMenu_ = read;
  context.doAvailability_ = read;
  return { context, events, held: () => held,
    send: body => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } })) };
}

test('公開ログイン設定は予約のロック待ちをせず返す', () => {
  const app = fixture({ occupied: true });
  assert.equal(app.send({ type: 'adminAuthConfig' }).ok, true);
  assert.deepEqual(app.events, []);
});

test('Googleの本人確認後にだけ台帳ロックを取得して読み書きする', () => {
  for (const action of ['adminData', 'adminNote']) {
    const app = fixture();
    assert.equal(app.send({ type: 'googleAdmin', action, payload: {} }).ok, true);
    assert.deepEqual(app.events, ['本人確認', 'ロック待ち', '取得', ...(action === 'adminData' ? ['読取'] : ['最終照合', '保存']), '解放']);
    assert.equal(app.held(), false);
  }
});

test('権限拒否とGoogle通信断では台帳もロックも触らない', () => {
  for (const options of [{ denied: true }, { unavailable: true }]) {
    const app = fixture(options);
    const result = app.send({ type: 'googleAdmin', action: 'adminNote', payload: {} });
    assert.equal(result.ok, false);
    assert.equal(options.denied ? result.authDenied : result.transportError, true);
    assert.deepEqual(app.events, ['本人確認']);
  }
});

test('予約の最終照合と保存は引き続き同じロック内で実行する', () => {
  for (const type of ['reserve', 'change', 'cancel', 'menu', 'availability']) {
    const app = fixture();
    assert.equal(app.send({ type }).ok, true);
    assert.deepEqual(app.events, ['ロック待ち', '取得', ...(['menu', 'availability'].includes(type) ? ['読取'] : ['最終照合', '保存']), '解放']);
  }
});

test('予約とGoogle管理の待機失敗では台帳へ進まず、他の処理のロックを解放しない', () => {
  for (const body of [{ type: 'reserve' }, { type: 'googleAdmin', action: 'adminNote', payload: {} }]) {
    const app = fixture({ occupied: true });
    assert.equal(app.send(body).ok, false);
    assert.equal(app.events.includes('保存'), false);
    assert.equal(app.events.includes('解放'), false);
  }
});

test('台帳処理が失敗しても取得したロックを解放し、次の処理へ進める', () => {
  const app = fixture();
  app.context.doReserve_ = () => { throw new Error('試験用の保存失敗'); };
  assert.equal(app.send({ type: 'reserve' }).ok, false);
  assert.equal(app.held(), false);
  assert.equal(app.send({ type: 'menu' }).ok, true);
  assert.equal(app.events.filter(event => event === '解放').length, 2);
});
