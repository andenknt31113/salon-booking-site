import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const BOOKING = { 予約番号: 'LM-NOTEACK', 来店日: '2030-01-05', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 状態: '予約確定', お名前: 'メモ確認試験', 電話番号: '00000000000', 施術メモ: '前回のメモ' };

function fixture({ fault = '', authorized = true } = {}) {
  const record = { ...BOOKING };
  const effects = [];
  let held = false;
  let headers;
  let attempted = false;
  let pending;
  const sheet = {
    getLastRow: () => 2, getLastColumn: () => headers.length,
    getRange(row, column, numRows = 1, numColumns = 1) {
      const range = {
        getValues() {
          assert.equal(held, true);
          if (attempted && row === 2 && column === headers.indexOf('施術メモ') + 1 && numColumns === 1) {
            effects.push('read-note');
            if (fault === 'read-failure') throw new Error('試験用の読込失敗');
            if (fault === 'empty-read') return [];
            if (fault === 'wrong-read') return [['別のメモ']];
          }
          const values = [headers, headers.map(header => record[header] ?? '')];
          return values.slice(row - 1, row - 1 + numRows).map(cells => cells.slice(column - 1, column - 1 + numColumns));
        },
        setValue(value) {
          assert.equal(held, true);
          assert.equal(row, 2);
          assert.equal(headers[column - 1], '施術メモ');
          attempted = true;
          effects.push('write');
          if (fault === 'write-before') throw new Error('試験用の保存前失敗');
          if (fault === 'delayed') pending = value;
          else if (fault !== 'discard') record.施術メモ = value;
          if (fault === 'write-after') throw new Error('試験用の保存後失敗');
          return range;
        }
      };
      return range;
    }
  };
  const context = vm.createContext({ Date, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({}), flush() {
      assert.equal(held, true);
      effects.push('flush');
      if (fault === 'flush-failure') throw new Error('試験用の反映失敗');
      if (pending !== undefined) { record.施術メモ = pending; pending = undefined; }
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  vm.runInContext(SOURCE, context);
  headers = Array.from(vm.runInContext('HEADERS', context));
  context.getSheet_ = () => sheet;
  context.ensureHeaders_ = () => {};
  context.requireAdmin_ = () => { if (!authorized) throw new Error('試験用の管理者拒否'); };
  return { record, effects, held: () => held, send: (changes = {}) =>
    JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ type: 'adminNote',
      code: BOOKING.予約番号, expectedNote: BOOKING.施術メモ, note: '今回の施術メモ', ...changes }) } })) };
}

for (const fault of ['discard', 'write-before', 'write-after', 'flush-failure', 'read-failure', 'empty-read', 'wrong-read']) {
  test(`施術メモの${fault}を保存成功とせず、確認を案内する`, () => {
    const app = fixture({ fault });
    const result = app.send();
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.match(result.error, /保存結果.*確認/);
    assert.equal(result.error.includes('試験用'), false);
    assert.equal(result.note, undefined);
    assert.equal(app.held(), false);
  });
}

for (const note of ['今回の施術メモ', '=数式ではないメモ', "'そのまま残すメモ", '', '前回\r\n次回', 'あ'.repeat(1100)]) {
  test(`正常な施術メモの保存は反映・照合後だけ成功する：${note.slice(0, 12) || '空欄'}`, () => {
    const app = fixture();
    const result = app.send({ note });
    assert.equal(result.ok, true);
    const expected = note.trim().slice(0, 1000);
    assert.equal(result.note, expected);
    assert.equal(app.record.施術メモ, expected.startsWith('=') ? "'" + expected : expected);
    assert.deepEqual(app.effects, ['write', 'flush', 'read-note']);
    assert.equal(app.held(), false);
  });
}

test('反映まで読み戻せないメモもflush後に保存を確認する', () => {
  const app = fixture({ fault: 'delayed' });
  assert.equal(app.send().ok, true);
  assert.equal(app.record.施術メモ, '今回の施術メモ');
  assert.deepEqual(app.effects, ['write', 'flush', 'read-note']);
});

test('保存後の応答障害の同一内容再送は書込を増やさず現在のメモを返す', () => {
  const app = fixture({ fault: 'write-after' });
  assert.equal(app.send().unknown, true);
  assert.equal(app.record.施術メモ, '今回の施術メモ');
  const confirmed = app.send();
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.note, '今回の施術メモ');
  assert.deepEqual(app.effects, ['write', 'read-note']);
});

test('古い元データと管理権限なしは書込や反映を行わない', () => {
  const conflict = fixture();
  assert.equal(conflict.send({ expectedNote: '古いメモ' }).conflict, true);
  assert.deepEqual(conflict.effects, []);
  assert.equal(conflict.record.施術メモ, BOOKING.施術メモ);
  const denied = fixture({ authorized: false });
  assert.equal(denied.send().ok, false);
  assert.deepEqual(denied.effects, []);
  assert.equal(denied.record.施術メモ, BOOKING.施術メモ);
  assert.equal(denied.held(), false);
});
