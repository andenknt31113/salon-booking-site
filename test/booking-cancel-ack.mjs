import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const BOOKING = { 予約番号: 'LM-ACKNOW', 来店日: '2030-01-05', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 状態: '予約確定', お名前: '取消保存試験', 電話番号: '00000000000', メール: 'ack@example.test' };

function fixture({ fault = '', admin = true } = {}) {
  const record = { ...BOOKING };
  const effects = [];
  let held = false;
  let headers;
  let attempted = false;
  let pending = null;
  const sheet = {
    getLastRow: () => 2, getLastColumn: () => headers.length,
    getRange(row, column, numRows = 1, numColumns = 1) {
      const range = {
        getValues() {
          assert.equal(held, true);
          const readingStatus = attempted && row === 2 && column === headers.indexOf('状態') + 1 && numColumns === 1;
          if (readingStatus) {
            effects.push('read-status');
            if (fault === 'read-failure') throw new Error('試験用の読込失敗');
            if (fault === 'empty-read') return [];
            if (fault === 'wrong-read') return [['予約確定']];
          }
          const values = [headers, headers.map(header => record[header] ?? '')];
          return values.slice(row - 1, row - 1 + numRows).map(cells => cells.slice(column - 1, column - 1 + numColumns));
        },
        setValue(value) {
          assert.equal(held, true);
          assert.equal(row, 2);
          assert.equal(headers[column - 1], '状態');
          attempted = true;
          effects.push('write');
          if (fault === 'write-before') throw new Error('試験用の保存前失敗');
          if (fault === 'delayed') pending = value;
          else if (fault !== 'discard') record.状態 = value;
          if (fault === 'write-after') throw new Error('試験用の保存後失敗');
          return range;
        },
        setFontLine() { effects.push('format'); return range; },
        setFontColor: () => range
      };
      return range;
    }
  };
  const context = vm.createContext({ Date, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { flush() {
      assert.equal(held, true);
      effects.push('flush');
      if (fault === 'flush-failure') throw new Error('試験用の反映失敗');
      if (pending) { record.状態 = pending; pending = null; }
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  vm.runInContext(SOURCE, context);
  headers = Array.from(vm.runInContext('HEADERS', context));
  context.getSheet_ = () => sheet;
  context.isAdmin_ = () => admin;
  context.readBookingSettings_ = () => ({});
  context.recordMailStatus_ = () => {};
  for (const name of ['notify_', 'mailCustomer_', 'notifyLine_']) context[name] = () => {
    assert.equal(held, true);
    effects.push(name);
    return '送信処理受付';
  };
  return { record, effects, held: () => held, send: (changes = {}) =>
    JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ type: 'cancel',
      code: BOOKING.予約番号, tel: BOOKING.電話番号, ...changes }) } })) };
}

for (const fault of ['discard', 'write-before', 'write-after', 'flush-failure', 'read-failure', 'empty-read', 'wrong-read']) {
  test(`取消の${fault}では完了と通知を先取りせず、照会を案内する`, () => {
    const app = fixture({ fault });
    const result = app.send();
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.match(result.error, /確認.*予約確認/);
    assert.equal(result.error.includes('試験用'), false);
    assert.ok(!app.effects.some(effect => ['format', 'notify_', 'mailCustomer_', 'notifyLine_'].includes(effect)));
    assert.equal(app.held(), false);
  });
}

for (const admin of [true, false]) {
  test(`${admin ? '店' : 'お客様'}の取消は反映・読み戻し後に通知する`, () => {
    const app = fixture({ admin });
    assert.equal(app.send().ok, true);
    assert.equal(app.record.状態, 'キャンセル');
    assert.deepEqual(app.effects, ['write', 'flush', 'read-status', 'format', 'mailCustomer_', 'notifyLine_', 'notify_']);
    assert.equal(app.held(), false);
  });
}

test('書込キャッシュが反映後に見える場合も、読み戻した取消だけを完了にする', () => {
  const app = fixture({ fault: 'delayed' });
  assert.equal(app.send().ok, true);
  assert.equal(app.record.状態, 'キャンセル');
  assert.deepEqual(app.effects.slice(0, 3), ['write', 'flush', 'read-status']);
});

test('保存後の応答障害は照会で取消を確認でき、再送で通知を増やさない', () => {
  const app = fixture({ fault: 'write-after' });
  assert.equal(app.send().unknown, true);
  assert.equal(app.send({ type: 'lookup' }).reservation.status, 'キャンセル');
  assert.equal(app.send().alreadyCancelled, true);
  assert.deepEqual(app.effects, ['write']);
});

test('保存されなかった障害は照会で元の予約を確認でき、未保存とは応答だけで断言しない', () => {
  const app = fixture({ fault: 'discard' });
  assert.equal(app.send().unknown, true);
  assert.equal(app.send({ type: 'lookup' }).reservation.status, '予約確定');
  assert.deepEqual(app.effects, ['write', 'flush', 'read-status']);
});

test('電話番号の不一致では書込・反映・通知をせず、結果不明とも取り違えない', () => {
  const app = fixture({ admin: false });
  const result = app.send({ tel: '00000000001' });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, undefined);
  assert.deepEqual(app.effects, []);
  assert.equal(app.record.状態, '予約確定');
});
