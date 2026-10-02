import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const REQUEST = { type: 'reserve', code: 'LM-BATCH', date: '2030-01-05', time: '10:00',
  totalMinutes: 60, totalPrice: 4000, menus: [{ id: 'sm0', name: '試験カット', price: 4000, minutes: 60 }],
  staffId: 'st01', staffName: 'MATTEO',
  customer: { name: '読込試験', kana: 'ヨミコミシケン', tel: '00000000000', email: 'customer@example.test' } };
const PREVIOUS = { 予約番号: 'LM-BEFORE', 来店日: '2030-01-06', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 担当ID: 'st01', 状態: '予約確定', 電話番号: '00000000000', 独自列: '維持する' };

function fixture({ queue = false, records = [PREVIOUS], headers: initialHeaders,
  failure = '', random = Math.random } = {}) {
  let held = false;
  let appended = false;
  const calls = [];
  const effects = [];
  const sheets = new Map();
  const properties = new Map();
  const assertHeld = () => assert.equal(held, true, '最新の検査・保存は同じ台帳ロックの内側');
  const makeSheet = (name, headers, rows = []) => {
    const cells = [Array.from(headers), ...rows.map(row => headers.map(header => row[header] ?? ''))];
    const sheet = { cells, getParent: () => spreadsheet,
      getLastRow() { assertHeld(); calls.push({ name, method: 'lastRow' }); return cells.length; },
      getLastColumn() { assertHeld(); calls.push({ name, method: 'lastColumn' }); return Math.max(...cells.map(row => row.length)); },
      getRange(row, column, numRows = 1, numColumns = 1) {
        assertHeld();
        calls.push({ name, method: 'range' });
        const range = { getValues() {
          assertHeld();
          calls.push({ name, method: 'values', row, column, numRows, numColumns, appended });
          if (name === '予約一覧' && failure === 'snapshot' && row === 1 && numRows > 1) throw new Error('試験用の読込失敗');
          const values = Array.from({ length: numRows }, (_unused, rowIndex) =>
            Array.from({ length: numColumns }, (_value, columnIndex) => cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
          if (name === '予約一覧' && appended && row > 1 && failure === 'readback') values[0][headers.indexOf('開始')] = '18:00';
          return values;
        }, setValues(values) {
          assertHeld();
          values.forEach((valuesRow, rowIndex) => valuesRow.forEach((value, columnIndex) => {
            cells[row - 1 + rowIndex] ||= [];
            cells[row - 1 + rowIndex][column - 1 + columnIndex] = value;
          }));
          return range;
        }, setFontWeight: () => range, setBackground: () => range };
        return range;
      }, appendRow(values) {
        assertHeld();
        effects.push(name === '予約一覧' ? 'booking' : 'queue');
        if (name === '予約一覧') appended = true;
        cells.push(Array.from(values));
      }, setFrozenRows() {}, setColumnWidth() {} };
    sheets.set(name, sheet);
    return sheet;
  };
  const spreadsheet = { getSheetByName(name) { assertHeld(); return sheets.get(name) || null; },
    insertSheet() { throw new Error('不要なシート作成'); } };
  const context = vm.createContext({ Date, Math: Object.create(Math),
    console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null,
      setProperty: (key, value) => properties.set(key, value) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {
      assertHeld(); effects.push('flush');
      if (appended && failure === 'flush') throw new Error('試験用の反映失敗');
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    Utilities: { getUuid: randomUUID, formatDate: () => '2030-01-01' },
    MailApp: { sendEmail() { assertHeld(); effects.push('mail'); } },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assertHeld(); held = false; } }) } });
  context.Math.random = random;
  vm.runInContext(SOURCE, context);
  const canonical = Array.from(vm.runInContext('HEADERS', context));
  const headers = initialHeaders || ['独自列', ...canonical].reverse();
  const ledger = makeSheet('予約一覧', headers, records);
  makeSheet('設定', ['項目', '内容'], Object.entries({ 準備中の帯: '出さない', 営業開始: '09:00',
    営業終了: '20:00', 最終受付: '19:00', 定休曜日: '', 通知先メール: 'shop@example.test' })
    .map(([項目, 内容]) => ({ 項目, 内容 })));
  makeSheet('メニュー', Array.from(vm.runInContext('MENU_HEADERS', context)),
    [{ 区分: 'カット', メニュー名: '試験カット', 価格: 4000, '所要(分)': 60, 表示: '表示' }]);
  makeSheet('おすすめメニュー', Array.from(vm.runInContext('COUPON_HEADERS', context)));
  makeSheet('休業日', Array.from(vm.runInContext('CLOSED_HEADERS', context)));
  if (queue) {
    makeSheet(vm.runInContext('BOOKING_EMAIL_SHEET', context), Array.from(vm.runInContext('BOOKING_EMAIL_HEADERS', context)));
    properties.set(vm.runInContext('BOOKING_EMAIL_ENABLED', context), 'true');
    properties.set(vm.runInContext('BOOKING_EMAIL_HEARTBEAT', context), String(Date.now()));
  }
  context.todayKey_ = () => '2030-01-01';
  context.nowMinJst_ = () => 9 * 60;
  context.recordMailStatus_ = () => {};
  return { context, ledger, sheets, headers, calls, effects, held: () => held,
    send: (changes = {}) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ ...REQUEST, ...changes }) } })) };
}

for (const queue of [false, true]) {
  test(`新規予約は台帳の見出し検査・一括読込・保存読戻しの3取得にまとめる（後送${queue ? 'あり' : 'なし'}）`, () => {
    const app = fixture({ queue });
    assert.equal(app.send().ok, true);
    const reads = app.calls.filter(call => call.name === '予約一覧' && call.method === 'values');
    assert.equal(reads.length, 3);
    assert.equal(reads[0].row, 1);
    assert.equal(reads[1].row, 1);
    assert.equal(reads[1].numRows, 2);
    assert.equal(reads[2].row, 3);
    assert.equal(reads[2].appended, true);
    assert.ok(app.effects.indexOf('flush') > -1);
    assert.equal(app.ledger.cells[1][app.headers.indexOf('独自列')], '維持する');
    assert.equal(app.ledger.cells[2][app.headers.indexOf('開始')], REQUEST.time);
    assert.equal(app.effects.includes('mail'), !queue);
    assert.equal(app.held(), false);
  });
}

test('同じ番号の再送は一括読込から照合し、料金変更後も保存済みの予約を二重作成しない', () => {
  const app = fixture({ queue: true });
  assert.equal(app.send().ok, true);
  app.sheets.get('メニュー').cells[1][2] = 5000;
  app.calls.length = 0;
  assert.equal(app.send().duplicate, true);
  assert.equal(app.ledger.cells.length, 3);
  assert.equal(app.effects.filter(effect => effect === 'queue').length, 1);
  assert.equal(app.calls.filter(call => call.name === '予約一覧' && call.method === 'values').length, 2);
  assert.equal(app.calls.some(call => call.name === 'メニュー'), false);
  assert.equal(app.held(), false);
});

test('次の要求で新しい予約・取消・並べ替えを読み直し、前の空席を使い回さない', () => {
  const app = fixture();
  assert.equal(app.send().ok, true);
  assert.equal(app.send({ code: 'LM-TAKEN', reservationSnapshot: { head: [], rows: [] } }).taken, true);
  app.ledger.cells[2][app.headers.indexOf('状態')] = 'キャンセル';
  assert.equal(app.send({ code: 'LM-FREED' }).ok, true);
  app.ledger.cells.forEach(row => row.reverse());
  assert.equal(app.send({ code: 'LM-CHANGED' }).taken, true);
  assert.equal(app.ledger.cells.length, 4);
  assert.equal(app.held(), false);
});

test('予約番号の重複・取消済み番号・同じ番号の内容変更を成功と誤認しない', () => {
  const duplicated = fixture({ records: [PREVIOUS, { ...PREVIOUS, 予約番号: 'ＬＭ－ｂｅｆｏｒｅ' }] });
  assert.match(duplicated.send({ code: PREVIOUS.予約番号 }).error, /予約番号.*重複/);
  assert.equal(duplicated.ledger.cells.length, 3);
  for (const [status, flag] of [['キャンセル', 'cancelled'], ['予約確定', 'conflict']]) {
    const app = fixture({ records: [{ ...PREVIOUS, 予約番号: REQUEST.code, 状態: status }] });
    assert.equal(app.send()[flag], true);
    assert.equal(app.ledger.cells.length, 2);
    assert.deepEqual(app.effects, []);
  }
});

test('番号の発行に失敗しても同じ一括読込を使い、台帳を50回読み直さない', () => {
  const app = fixture({ records: [{ ...PREVIOUS, 予約番号: 'LM-AAAAA' }], random: () => 0 });
  assert.match(app.send({ code: '' }).error, /予約番号を発行/);
  assert.equal(app.calls.filter(call => call.name === '予約一覧' && call.method === 'values').length, 2);
  assert.deepEqual(app.effects, []);
  assert.equal(app.held(), false);
});

for (const failure of ['snapshot', 'flush', 'readback']) {
  test(`${failure}失敗でも確認を省いて成功扱いしない`, () => {
    const app = fixture({ failure });
    const response = app.send();
    assert.equal(response.ok, false);
    assert.equal(response.unknown, failure === 'snapshot' ? undefined : true);
    assert.equal(app.effects.includes('mail'), false);
    assert.equal(app.held(), false);
  });
}

for (const headers of [
  ['予約番号', '来店日', '開始', '所要(分)', '開始'],
  ['予約番号', '日付', '開始', '終了'],
  ['来店日', '開始', '終了']
]) {
  test(`不完全な見出しは一括読込前から拒否する：${headers.join('／')}`, () => {
    const app = fixture({ headers });
    assert.match(app.send().error, /予約台帳.*見出し/);
    assert.equal(app.ledger.cells.length, 2);
    assert.deepEqual(app.effects, []);
    assert.equal(app.held(), false);
  });
}

test('列が少ない旧台帳は追加列を維持して一括読込し、正しい位置に予約を保存する', () => {
  const app = fixture({ headers: ['独自列', '電話番号', '予約番号', '来店日', '開始', '終了'] });
  assert.equal(app.send().ok, true);
  const headers = app.ledger.cells[0];
  assert.equal(app.ledger.cells[1][headers.indexOf('独自列')], '維持する');
  assert.equal(app.ledger.cells[2][headers.indexOf('合計金額')], REQUEST.totalPrice);
  assert.equal(app.ledger.cells[2][headers.indexOf('来店日')], REQUEST.date);
  assert.equal(app.held(), false);
});
