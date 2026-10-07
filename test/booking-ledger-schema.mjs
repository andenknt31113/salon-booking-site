import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const RECORD = { 予約番号: 'LM-SCHEMA', 来店日: '2030-01-05', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 担当ID: 'st01', お名前: '非公開の試験客', 電話番号: '09011112222', 状態: '予約確定' };
const INITIAL_REQUEST = { type: 'menu', booking: true, initialAvailability: true };

function fixture({ editHeaders = headers => headers, legacy = false, blank = false, empty = false,
  authorized = true } = {}) {
  const writes = [];
  const reads = [];
  const operations = [];
  let held = false;
  let cells;
  const context = vm.createContext({ Date, console: { error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    Utilities: { formatDate: () => '2030-01-01' },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  vm.runInContext(SOURCE, context);
  const canonical = Array.from(vm.runInContext('HEADERS', context));
  const original = legacy || blank ? canonical.slice(0, legacy ? 9 : canonical.length) : ['独自列', ...canonical].reverse();
  cells = empty ? [] : [blank ? original.map(() => '') : editHeaders(original.slice()),
    original.map(header => header === '独自列' ? '残す値' : (RECORD[header] ?? ''))];
  const before = structuredClone(cells);
  const range = (row, column, numRows = 1, numColumns = 1) => {
    const api = {
      getValues() {
        assert.equal(held, true);
        reads.push({ row, column, numRows, numColumns });
        return Array.from({ length: numRows }, (_unused, rowIndex) =>
          Array.from({ length: numColumns }, (_value, columnIndex) =>
            cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
      },
      setValues(values) {
        assert.equal(held, true);
        writes.push({ row, column });
        values.forEach((valuesRow, rowIndex) => valuesRow.forEach((value, columnIndex) => {
          cells[row - 1 + rowIndex] ||= [];
          cells[row - 1 + rowIndex][column - 1 + columnIndex] = value;
        }));
        return api;
      },
      setFontWeight: () => api, setBackground: () => api
    };
    return api;
  };
  const sheet = { getLastRow: () => cells.length,
    getLastColumn: () => Math.max(0, ...cells.map(row => row.length)), getRange: range,
    appendRow: row => { writes.push({ append: true }); cells.push(Array.from(row)); },
    setFrozenRows() {}, setColumnWidth() {}, getParent: () => spreadsheet };
  const spreadsheet = { getSheetByName: name => name === '予約一覧' ? sheet : null,
    insertSheet() { throw new Error('不要なシートの作成'); } };
  for (const name of ['readMenuSheet_', 'readCouponSheet_', 'readStyleSheet_', 'readReviewSheet_',
    'readClosedSheet_', 'readSheetRows_']) context[name] = () => [];
  context.readSettings_ = () => ({});
  context.allStamps_ = () => ({});
  context.ensureSettingRows_ = () => {};
  context.requireAdmin_ = () => { if (!authorized) throw new Error('試験用の認証拒否'); };
  for (const name of ['doReserve_', 'doChange_', 'doCancel_']) {
    context[name] = () => { operations.push(name); return { ok: true }; };
  }
  return { cells: () => cells, before, reads, writes, operations, canonical, held: () => held,
    prepare: () => context.withLedgerLock_(() => context.getSheet_(null, { initialize: true })),
    send: request => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(request) } })) };
}

for (const request of [INITIAL_REQUEST, { type: 'availability' }, { type: 'reserve' },
  { type: 'lookup', code: RECORD.予約番号, tel: RECORD.電話番号 },
  { type: 'change' }, { type: 'cancel' }, { type: 'adminData' }]) {
  test(`${request.type}で来店日の見出しが欠けた台帳を空席・正常な保存へすり替えない`, () => {
    const app = fixture({ editHeaders: headers => headers.map(header => header === '来店日' ? '日付' : header) });
    const response = app.send(request);
    assert.equal(response.ok, false);
    assert.match(response.error, /予約台帳.*見出し/);
    assert.equal(Object.hasOwn(response, 'booked'), false);
    assert.deepEqual(app.operations, []);
    assert.deepEqual(app.writes, [], '見出しを新しく足して元の予約が空になる自動修復をしない');
    assert.deepEqual(app.cells(), app.before);
    assert.equal(app.held(), false);
  });
}

for (const header of ['予約番号', '来店日', '開始', '終了', '電話番号']) {
  test(`重複した既知の${header}列を、先頭の列だけ見て正常扱いしない`, () => {
    const app = fixture({ editHeaders: headers => headers.map(value => value === '独自列' ? header : value) });
    assert.equal(app.send({ type: 'reserve' }).ok, false);
    assert.deepEqual(app.operations, []);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.cells(), app.before);
  });
}

for (const header of ['予約番号', '来店日', '状態']) {
  test(`通知の軽量取得も重複した${header}を正常な予約情報として返さない`, () => {
    const app = fixture({ editHeaders: headers => headers.map(value => value === '独自列' ? header : value) });
    assert.equal(app.send({ type: 'adminData', notificationsOnly: true }).ok, false);
    assert.deepEqual(app.operations, []);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.cells(), app.before);
  });
}

test('並べ替えた列・独自列でも既存の占有時間を返し、顧客情報を返さない', () => {
  const app = fixture();
  const response = app.send(INITIAL_REQUEST);
  assert.equal(response.ok, true);
  assert.deepEqual(response.booked, [{ date: RECORD.来店日, time: RECORD.開始, minutes: 60, staffId: RECORD.担当ID }]);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.cells(), app.before);
  assert.equal(JSON.stringify(response).includes(RECORD.電話番号), false);
  assert.equal(JSON.stringify(response).includes(RECORD.お名前), false);
});

test('古い9列の台帳の占有時間を保持し、任意列の追加も元の予約行を変えない', () => {
  const app = fixture({ legacy: true });
  assert.equal(app.send(INITIAL_REQUEST).booked.length, 1);
  assert.equal(app.send({ type: 'reserve' }).ok, true);
  assert.deepEqual(app.cells()[1], app.before[1]);
  assert.equal(app.cells()[0].length, app.canonical.length);
  assert.equal(app.operations.length, 1);
});

test('既存予約の見出しが全て空でも、書込要求で末尾へ新しい見出しを足さない', () => {
  const app = fixture({ blank: true });
  assert.equal(app.send({ type: 'reserve' }).ok, false);
  assert.deepEqual(app.operations, []);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.cells(), app.before);
});

for (const missing of [['開始'], ['終了', '所要(分)'], ['予約番号']]) {
  test(`${missing.join('・')}が欠けた台帳は、別の列で代用せず書込前に止める`, () => {
    const app = fixture({ editHeaders: headers => headers.map(header => missing.includes(header) ? '旧' + header : header) });
    assert.equal(app.send({ type: 'reserve' }).ok, false);
    assert.deepEqual(app.operations, []);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.cells(), app.before);
  });
}

test('既定順の空白見出しの旧台帳は、読取に限り従来の占有時間を保つ', () => {
  const app = fixture({ blank: true });
  const response = app.send(INITIAL_REQUEST);
  assert.equal(response.ok, true);
  assert.deepEqual(response.booked, [{ date: RECORD.来店日, time: RECORD.開始, minutes: 60, staffId: RECORD.担当ID }]);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.cells(), app.before);
});

test('空の新規台帳は明示準備の後だけ使い、管理認証の失敗では台帳を読まない', () => {
  const empty = fixture({ empty: true });
  assert.equal(empty.send({ type: 'reserve' }).ok, false);
  assert.deepEqual(empty.cells(), []);
  assert.deepEqual(empty.writes, []);
  empty.prepare();
  assert.equal(empty.send({ type: 'reserve' }).ok, true);
  assert.deepEqual(empty.cells()[0], empty.canonical);
  const denied = fixture({ authorized: false, editHeaders: headers => headers.map(() => '') });
  assert.equal(denied.send({ type: 'adminData' }).ok, false);
  assert.deepEqual(denied.reads, []);
  assert.deepEqual(denied.writes, []);
  assert.equal(denied.held(), false);
});
