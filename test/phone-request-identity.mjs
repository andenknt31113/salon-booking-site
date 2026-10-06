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

function fixture({ records = [BOOKING], authorized = true, allowAppend = false,
  native = true, reordered = false, failRead = false, closedDates = [] } = {}) {
  const reads = [];
  const effects = [];
  let held = false;
  let headers;
  const rows = structuredClone(records);
  const readCells = (row, column, numRows, numColumns) => {
    assert.equal(held, true);
    reads.push({ row, column, numRows, numColumns });
    if (failRead) throw new Error('試験用の台帳読込失敗');
    return [headers, ...rows.map(record => headers.map(header => record[header] ?? ''))]
      .slice(row - 1, row - 1 + numRows).map(cells => cells.slice(column - 1, column - 1 + numColumns));
  };
  const sheet = { getLastRow: () => rows.length + 1, getLastColumn: () => headers.length,
    getRange(row, column, numRows = 1, numColumns = 1) {
      return { getValues() {
        return readCells(row, column, numRows, numColumns);
      } };
    }, appendRow(cells) {
      assert.equal(held, true);
      effects.push('append');
      if (!allowAppend) throw new Error('既存受付の照合で追加しない');
      rows.push(Object.fromEntries(headers.map((header, index) => [header, cells[index]])));
    } };
  if (native) sheet.getDataRange = () => ({ getValues: () => readCells(1, 1, rows.length + 1, headers.length) });
  sheet.getParent = () => ({ getSheetByName: () => ({
    getDataRange: () => ({ getValues() {
      assert.equal(held, true);
      return [['休業日', '開始', '終了'], ...structuredClone(closedDates)];
    } })
  }) });
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
  if (reordered) headers = ['独自列', ...headers.toReversed()];
  context.requireAdmin_ = () => { if (!authorized) throw new Error('試験用の管理者拒否'); };
  context.getSheet_ = () => sheet;
  context.addToCalendar_ = () => { effects.push('calendar'); return ''; };
  return { rows, reads, effects, held: () => held,
    send: changes => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ ...REQUEST, ...changes }) } })) };
}

for (const native of [true, false]) {
  for (const reordered of [true, false]) {
    test(`電話の新規受付は同じ台帳を一回だけ読み、別の保存確認を残す：native=${native}／並べ替え=${reordered}`, () => {
      const existing = { ...BOOKING, 来店日: '2030-01-04', 独自列: '既存の独自値' };
      const app = fixture({ native, reordered, allowAppend: true, records: [existing] });
      const result = app.send({ requestId: 'phone-snapshot-new-0001', force: false });
      assert.equal(result.ok, true);
      assert.equal(result.duplicate, false);
      assert.equal(result.reservation.date, REQUEST.date);
      assert.equal(result.reservation.time, REQUEST.time);
      assert.equal(result.endTime, '11:00');
      assert.equal(app.rows.length, 2);
      assert.deepEqual(app.rows[0], existing);
      assert.deepEqual(app.effects, ['append', 'flush', 'calendar']);
      assert.equal(app.reads.length, 2);
      assert.equal(app.reads[0].row, 1);
      assert.equal(app.reads[0].numRows, 2);
      assert.equal(app.reads[1].row, 3);
      assert.equal(app.reads[1].numRows, 1);
      assert.equal(app.held(), false);
    });
  }

  for (const type of ['adminAdd', 'adminAddStatus']) {
    test(`電話の再送・結果照会は一回の読込で現在の取消状態を返す：${type}／native=${native}`, () => {
      const app = fixture({ native, records: [{ ...BOOKING, 状態: 'キャンセル', 開始: '14:00' }] });
      const result = app.send({ type });
      assert.equal(result.ok, true);
      assert.equal(result.duplicate, true);
      assert.equal(result.reservation.status, 'キャンセル');
      assert.equal(result.reservation.time, '14:00');
      if (type === 'adminAddStatus') assert.equal(result.found, true);
      assert.equal(app.reads.length, 1);
      assert.deepEqual(app.effects, []);
      assert.equal(app.held(), false);
    });
  }
}

test('同じ取得内容で重複時間を検出し、強制受付なしでは書き込まない', () => {
  const app = fixture({ allowAppend: true });
  const result = app.send({ requestId: 'phone-snapshot-overlap-0001', force: false });
  assert.equal(result.ok, false);
  assert.equal(result.confirm, true);
  assert.match(result.error, /別のご予約/);
  assert.equal(app.reads.length, 1);
  assert.deepEqual(app.effects, []);
});

test('台帳をまとめて読んでも部分休業の警告を残す', () => {
  const app = fixture({ allowAppend: true, records: [], closedDates: [[REQUEST.date, '10:30', '11:30']] });
  const result = app.send({ force: false });
  assert.equal(result.ok, false);
  assert.equal(result.confirm, true);
  assert.match(result.error, /休業日/);
  assert.equal(app.reads.length, 1);
  assert.deepEqual(app.effects, []);
});

test('要求をまたいで台帳をキャッシュせず、書込直前の重複時間を読み直す', () => {
  const app = fixture({ allowAppend: true, records: [] });
  const first = app.send({ force: false });
  assert.equal(first.ok, true);
  const second = app.send({ requestId: 'phone-snapshot-other-0001', force: false });
  assert.equal(second.ok, false);
  assert.equal(second.confirm, true);
  assert.equal(app.rows.length, 1);
  assert.deepEqual(app.effects, ['append', 'flush', 'calendar']);
  assert.equal(app.reads.length, 3);
  assert.equal(app.held(), false);
});

for (const type of ['adminAdd', 'adminAddStatus']) {
  test(`読込障害を未登録・空き時間と見なさず、ロックを解放する：${type}`, () => {
    const app = fixture({ failRead: true, allowAppend: true });
    const result = app.send({ type, force: false });
    assert.equal(result.ok, false);
    assert.equal(result.found, undefined);
    assert.equal(result.reservation, undefined);
    assert.deepEqual(app.effects, []);
    assert.equal(app.held(), false);
  });
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
  const other = { ...BOOKING, 予約番号: 'LM-OTHER', 電話受付ID: 'phone-identity-other-0001' };
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
