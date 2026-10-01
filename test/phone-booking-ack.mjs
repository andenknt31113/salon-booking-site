import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const REQUEST = { type: 'adminAdd', requestId: 'phone-ack-test-0001', date: '2030-01-05', time: '10:00',
  minutes: 60, price: 4000, name: '電話保存試験', tel: '00000000000', menu: '試験カット', memo: '試験メモ', force: true };

function fixture({ fault = '', changed = null, authorized = true } = {}) {
  const effects = [];
  const rows = [];
  let held = false;
  let headers;
  let attempted = false;
  let pending = null;
  const spreadsheet = { getSheetByName: () => null };
  const sheet = { getParent: () => spreadsheet,
    getLastRow: () => rows.length + 1, getLastColumn: () => headers.length,
    getRange(row, column, numRows = 1, numColumns = 1) {
      const range = { getValues() {
        assert.equal(held, true);
        if (attempted && row > 1 && numColumns === headers.length) {
          effects.push('read-reservation');
          if (fault === 'read-failure') throw new Error('試験用の読込失敗');
        }
        return [headers, ...rows].slice(row - 1, row - 1 + numRows)
          .map(cells => cells.slice(column - 1, column - 1 + numColumns));
      }, setValue(value) { rows[row - 2][column - 1] = value; return range; } };
      return range;
    }, appendRow(values) {
      assert.equal(held, true);
      attempted = true;
      effects.push('append');
      if (fault === 'write-before') throw new Error('試験用の保存前失敗');
      if (fault === 'delayed') pending = Array.from(values);
      else if (fault !== 'discard') rows.push(Array.from(values));
      if (fault === 'write-after') throw new Error('試験用の保存後失敗');
    } };
  const context = vm.createContext({ Date, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {
      assert.equal(held, true);
      effects.push('flush');
      if (fault === 'flush-failure') throw new Error('試験用の反映失敗');
      if (pending) { rows.push(pending); pending = null; }
      if (changed && rows.length) for (const [header, value] of Object.entries(changed)) {
        rows.at(-1)[headers.indexOf(header)] = value;
      }
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent() {
      assert.equal(held, true);
      effects.push('calendar');
      return { getId: () => 'phone-calendar-test' };
    } }) },
    MailApp: { sendEmail() { throw new Error('電話予約でお客様メールを送らない'); } },
    Utilities: { formatDate(value, _zone, format) {
      const date = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString();
      return format === 'HH:mm' ? date.slice(11, 16) : date.slice(0, 10);
    } },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  const withCalendar = SOURCE.replace("const CALENDAR_ID = '';", "const CALENDAR_ID = 'primary';");
  assert.notEqual(withCalendar, SOURCE);
  vm.runInContext(withCalendar, context);
  headers = Array.from(vm.runInContext('HEADERS', context));
  context.getSheet_ = () => sheet;
  context.requireAdmin_ = () => { if (!authorized) throw new Error('試験用の管理者拒否'); };
  context.issueCode_ = () => 'LM-PHONE';
  return { effects, rows, headers, held: () => held,
    send: changes => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ ...REQUEST, ...changes }) } })) };
}

for (const fault of ['discard', 'write-before', 'write-after', 'flush-failure', 'read-failure']) {
  test(`電話予約の${fault}は台帳登録の完了やカレンダー作成にしない`, () => {
    const app = fixture({ fault });
    const result = app.send();
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.match(result.error, /保存結果.*登録結果/);
    assert.equal(app.effects.includes('calendar'), false);
    assert.equal(app.held(), false);
  });
}

for (const changed of [{ 来店日: '2030-01-06' }, { 電話受付ID: 'phone-other-test-0001' },
  { 電話受付内容: '別の申込' }, { 合計金額: 9000 }]) {
  test(`保存された電話受付が申込と違うときは登録完了と言わない：${JSON.stringify(changed)}`, () => {
    const app = fixture({ changed });
    const result = app.send();
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.equal(app.effects.includes('calendar'), false);
    assert.equal(app.rows.length, 1, '結果不明の行を推測して削除しない');
  });
}

for (const fault of ['', 'delayed']) {
  test(`正常な電話予約は保存の反映と読み戻し後にカレンダーへ登録する：${fault || '通常'}`, () => {
    const app = fixture({ fault });
    const result = app.send();
    assert.equal(result.ok, true);
    assert.equal(result.requestId, REQUEST.requestId);
    assert.deepEqual(app.effects, ['append', 'flush', 'read-reservation', 'calendar']);
    assert.equal(result.reservation.name, REQUEST.name);
    assert.equal(app.rows.length, 1);
  });
}

test('保存後の応答喪失も同じ電話受付IDで照会し、二重登録や追加の予定を作らない', () => {
  const app = fixture({ fault: 'write-after' });
  assert.equal(app.send().unknown, true);
  const status = app.send({ type: 'adminAddStatus' });
  assert.equal(status.found, true);
  assert.equal(status.reservation.code, 'LM-PHONE');
  assert.equal(app.send().duplicate, true);
  assert.equal(app.rows.length, 1);
  assert.equal(app.effects.includes('calendar'), false);
});

test('認証拒否では登録・反映・予定作成のいずれも行わない', () => {
  const app = fixture({ authorized: false });
  assert.equal(app.send().ok, false);
  assert.deepEqual(app.effects, []);
  assert.deepEqual(app.rows, []);
});
