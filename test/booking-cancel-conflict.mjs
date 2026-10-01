import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const BOOKING = { 予約番号: 'LM-CANCEL', 来店日: '2030-01-05', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 状態: '予約確定', お名前: '取消試験', 電話番号: '00000000000', メール: 'cancel@example.test' };

function fixture({ current = {}, admin = true } = {}) {
  const writes = [];
  const notifications = [];
  const record = { ...BOOKING, ...current };
  let headers;
  let held = false;
  const sheet = {
    getParent: () => ({ getSheetByName: () => null }),
    getLastRow: () => 2,
    getLastColumn: () => headers.length,
    getRange(row, column, numRows = 1, numColumns = 1) {
      const range = { getValues() {
        assert.equal(held, true);
        const values = [headers, headers.map(header => record[header] ?? '')];
        return values.slice(row - 1, row - 1 + numRows).map(cells => cells.slice(column - 1, column - 1 + numColumns));
      }, setValue(value) {
        assert.equal(held, true);
        assert.equal(row, 2);
        writes.push({ column, value });
        record[headers[column - 1]] = value;
        return range;
      }, setFontLine: () => range, setFontColor: () => range };
      return range;
    }
  };
  const context = vm.createContext({ Date, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  vm.runInContext(SOURCE, context);
  headers = Array.from(vm.runInContext('HEADERS', context));
  context.getSheet_ = () => sheet;
  context.isAdmin_ = () => admin;
  context.recordMailStatus_ = () => {};
  for (const name of ['notify_', 'mailCustomer_', 'notifyLine_']) context[name] = () => {
    assert.equal(held, true);
    notifications.push(name);
    return '送信処理受付';
  };
  const request = { type: 'cancel', code: BOOKING.予約番号, tel: BOOKING.電話番号,
    fromDate: BOOKING.来店日, fromTime: BOOKING.開始 };
  return { record, writes, notifications, held: () => held,
    send: changes => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ ...request, ...changes }) } })) };
}

for (const current of [{ 来店日: '2030-01-06' }, { 開始: '14:00', 終了: '15:00' }]) {
  for (const admin of [true, false]) {
    test(`${admin ? '管理者' : 'お客様'}が確認した後の日時変更を、取消で上書きしない：${JSON.stringify(current)}`, () => {
      const app = fixture({ current, admin });
      const result = app.send();
      assert.equal(result.ok, false);
      assert.equal(result.stale, true);
      assert.match(result.error, /最新/);
      assert.equal(app.record.状態, '予約確定');
      assert.deepEqual(app.writes, []);
      assert.deepEqual(app.notifications, []);
      assert.equal(app.held(), false);
    });
  }
}

for (const changes of [{ fromDate: '' }, { fromTime: '' }, { fromDate: undefined }, { fromTime: null }]) {
  test(`確認した日時の一部が欠けている取消は保存しない：${JSON.stringify(changes)}`, () => {
    const app = fixture();
    const result = app.send(changes);
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.notifications, []);
  });
}

test('確認した日時が一致する取消は受け付け、通知は一度だけ送る', () => {
  const app = fixture();
  assert.equal(app.send({ fromDate: '２０３０/１/５', fromTime: '１０：００' }).ok, true);
  assert.equal(app.record.状態, 'キャンセル');
  assert.equal(app.writes.length, 1);
  assert.equal(app.notifications.length, 3);
  assert.equal(app.send().alreadyCancelled, true);
  assert.equal(app.writes.length, 1);
  assert.equal(app.notifications.length, 3);
});

test('元日時を指定しない従来の電話番号照合・管理取消を保持する', () => {
  for (const admin of [true, false]) {
    const app = fixture({ admin });
    assert.equal(app.send({ fromDate: undefined, fromTime: undefined }).ok, true);
    assert.equal(app.record.状態, 'キャンセル');
  }
});

test('最新の日時を確認した後なら、改めて取消できる', () => {
  const app = fixture({ current: { 来店日: '2030-01-06', 開始: '14:00', 終了: '15:00' } });
  assert.equal(app.send().stale, true);
  assert.equal(app.send({ fromDate: app.record.来店日, fromTime: app.record.開始 }).ok, true);
  assert.equal(app.writes.length, 1);
  assert.equal(app.notifications.length, 3);
});

test('本人確認の拒否では、日時の不一致を明かさない', () => {
  const app = fixture({ admin: false, current: { 来店日: '2030-01-06' } });
  const result = app.send({ tel: '00000000001' });
  assert.equal(result.ok, false);
  assert.equal(result.stale, undefined);
  assert.match(result.error, /電話番号/);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.notifications, []);
});
