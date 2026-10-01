import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const REQUEST_ID = 'phone-identity-test-0001';
const REQUEST = { type: 'adminAdd', requestId: REQUEST_ID, date: '2030-01-05', time: '10:00',
  minutes: 60, price: 4000, name: '電話受付照合試験', tel: '00000000000', menu: '試験カット', memo: '', force: true };
const CONTENT = JSON.stringify({ date: REQUEST.date, time: REQUEST.time, minutes: REQUEST.minutes,
  price: REQUEST.price, name: REQUEST.name, tel: REQUEST.tel, menu: REQUEST.menu, memo: REQUEST.memo });
const BOOKING = { 予約番号: 'LM-FIRST', 来店日: REQUEST.date, 開始: REQUEST.time, 終了: '11:00',
  '所要(分)': REQUEST.minutes, 合計金額: REQUEST.price, 状態: '予約確定', お名前: REQUEST.name,
  電話番号: "'" + REQUEST.tel, 電話受付ID: REQUEST_ID, 電話受付内容: CONTENT };

function fixture({ records = [BOOKING], authorized = true } = {}) {
  const reads = [];
  const effects = [];
  let held = false;
  let headers;
  const rows = structuredClone(records);
  const sheet = { getLastRow: () => rows.length + 1, getLastColumn: () => headers.length,
    getRange(row, column, numRows = 1, numColumns = 1) {
      return { getValues() {
        assert.equal(held, true);
        reads.push({ row, column, numRows, numColumns });
        return [headers, ...rows.map(record => headers.map(header => record[header] ?? ''))]
          .slice(row - 1, row - 1 + numRows).map(cells => cells.slice(column - 1, column - 1 + numColumns));
      } };
    }, appendRow() { effects.push('append'); throw new Error('既存受付の照合で追加しない'); } };
  const context = vm.createContext({ Date, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { flush() { effects.push('flush'); } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    Utilities: { formatDate: () => REQUEST.date },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  vm.runInContext(SOURCE, context);
  headers = Array.from(vm.runInContext('HEADERS', context));
  context.requireAdmin_ = () => { if (!authorized) throw new Error('試験用の管理者拒否'); };
  context.getSheet_ = () => sheet;
  context.addToCalendar_ = () => { effects.push('calendar'); return ''; };
  return { rows, reads, effects, held: () => held,
    send: changes => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ ...REQUEST, ...changes }) } })) };
}

for (const type of ['adminAdd', 'adminAddStatus']) {
  for (const duplicate of [{ 予約番号: 'LM-SECOND' }, { 予約番号: 'LM-SECOND', 状態: 'キャンセル' },
    { 予約番号: 'LM-SECOND', 電話受付内容: '別の受付内容', お名前: '別の試験客' }]) {
    test(`${type}で同じ電話受付IDの先頭だけを登録結果と扱わない：${JSON.stringify(duplicate)}`, () => {
      const app = fixture({ records: [BOOKING, { ...BOOKING, ...duplicate }] });
      const before = structuredClone(app.rows);
      const result = app.send({ type });
      assert.equal(result.ok, false);
      assert.match(result.error, /電話受付ID.*重複/);
      assert.equal(result.reservation, undefined);
      assert.equal(result.found, undefined);
      assert.equal(JSON.stringify(result).includes(BOOKING.お名前), false);
      assert.deepEqual(app.rows, before);
      assert.deepEqual(app.effects, []);
      assert.equal(app.held(), false);
    });
  }
}

test('一意な電話受付は現在の状態を返し、再送で増やさない', () => {
  const app = fixture({ records: [{ ...BOOKING, 状態: 'キャンセル', 開始: '14:00' }] });
  const replay = app.send();
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.reservation.time, '14:00');
  assert.equal(replay.reservation.status, 'キャンセル');
  assert.equal(app.send({ type: 'adminAddStatus' }).found, true);
  assert.deepEqual(app.effects, []);
});

test('同じ受付IDの内容不一致と、存在しない受付の照会を区別する', () => {
  const app = fixture();
  const conflict = app.send({ time: '14:00' });
  assert.equal(conflict.requestConflict, true);
  const missing = app.send({ type: 'adminAddStatus', requestId: 'phone-identity-missing-0001' });
  assert.equal(missing.ok, true);
  assert.equal(missing.found, false);
  assert.equal(missing.requestId, 'phone-identity-missing-0001');
  assert.deepEqual(app.effects, []);
});

test('別の電話受付IDの重複を理由に正常な受付を照会不能にしない', () => {
  const other = { ...BOOKING, 電話受付ID: 'phone-identity-other-0001' };
  const app = fixture({ records: [BOOKING, other, { ...other, 予約番号: 'LM-SECOND' }] });
  assert.equal(app.send({ type: 'adminAddStatus' }).found, true);
  assert.equal(app.send().duplicate, true);
  assert.deepEqual(app.effects, []);
});

test('認証拒否は重複した電話受付や個人情報を読む前に止める', () => {
  const app = fixture({ authorized: false, records: [BOOKING, BOOKING] });
  assert.equal(app.send({ type: 'adminAddStatus' }).ok, false);
  assert.deepEqual(app.reads, []);
  assert.deepEqual(app.effects, []);
});
