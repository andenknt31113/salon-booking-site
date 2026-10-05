import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST = { type: 'reserve', code: 'LM-CLOCK', time: '19:00', totalMinutes: 60, totalPrice: 4000,
  menus: [{ id: 'sm0', name: '試験カット', price: 4000, minutes: 60 }], staffId: 'st01', staffName: 'MATTEO',
  customer: { name: '架空の時計試験', kana: 'カクウノトケイシケン', tel: '00000000000', email: 'customer@example.test' } };

function dateKey(instant) { return new Date(instant + JST_OFFSET_MS).toISOString().slice(0, 10); }

function fixture({ instant = '2030-01-01T23:59:59.999+09:00', advance = 0, queue = false,
  originalDate, nativeRange = true } = {}) {
  const clock = { now: Date.parse(instant), advanced: false };
  const effects = [];
  const formats = [];
  const properties = new Map();
  const sheets = new Map();
  let held = false;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const assertHeld = () => assert.equal(held, true);
  const makeSheet = (name, headers, rows = []) => {
    const cells = [Array.from(headers), ...rows.map(row => headers.map(header => row[header] ?? ''))];
    const sheet = { cells, getParent: () => spreadsheet,
      getLastRow() { assertHeld(); return cells.length; },
      getLastColumn() { assertHeld(); return Math.max(...cells.map(row => row.length)); },
      getRange(row, column, height = 1, width = 1) {
        assertHeld();
        const raw = () => Array.from({ length: height }, (_unused, rowIndex) =>
          Array.from({ length: width }, (_value, columnIndex) => cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
        const write = values => {
          assertHeld(); effects.push({ name, action: 'write' });
          values.forEach((line, rowIndex) => line.forEach((value, columnIndex) => {
            cells[row - 1 + rowIndex] ||= [];
            cells[row - 1 + rowIndex][column - 1 + columnIndex] = value;
          }));
          return range;
        };
        const range = { getValues: raw, getFormulas: () => raw().map(line => line.map(() => '')),
          setValues: write, setValue: value => write([[value]]), setFontWeight: () => range, setBackground: () => range };
        return range;
      }, appendRow(values) { assertHeld(); effects.push({ name, action: 'append' }); cells.push(Array.from(values)); },
      setFrozenRows() {}, setColumnWidth() {} };
    if (nativeRange) sheet.getDataRange = () => sheet.getRange(1, 1, cells.length, sheet.getLastColumn());
    sheets.set(name, sheet);
    return sheet;
  };
  const spreadsheet = { getSheetByName(name) { assertHeld(); return sheets.get(name) || null; },
    insertSheet() { throw new Error('試験中の不要なシート作成'); } };
  const context = vm.createContext({ Date: ClockDate, console: { warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null,
      setProperty(key, value) { properties.set(key, value); }, deleteProperty: key => properties.delete(key) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() { assertHeld(); effects.push({ action: 'flush' }); } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    Utilities: { getUuid: randomUUID, formatDate(date, timezone, format) {
      assert.equal(timezone, 'Asia/Tokyo');
      const shifted = new Date(date.getTime() + JST_OFFSET_MS).toISOString();
      formats.push({ instant: date.getTime(), format });
      if (format === 'yyyy-MM-dd' && date.getTime() === clock.now && !clock.advanced && advance) {
        clock.now += advance; clock.advanced = true;
      }
      if (format === 'yyyy-MM-dd') return shifted.slice(0, 10);
      if (format === 'HH:mm') return shifted.slice(11, 16);
      if (format === 'yyyy/MM/dd HH:mm') return shifted.slice(0, 10).replaceAll('-', '/') + ' ' + shifted.slice(11, 16);
      throw new Error('試験で未対応の日時形式');
    } },
    MailApp: { sendEmail() { assertHeld(); effects.push({ action: 'mail' }); } },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assertHeld(); held = false; } }) } });
  vm.runInContext(SOURCE, context);
  const headers = Array.from(vm.runInContext('HEADERS', context));
  const previous = { 予約番号: 'LM-BEFORE', 来店日: originalDate || dateKey(clock.now + 4 * DAY_MS),
    開始: '10:00', 終了: '11:00', '所要(分)': 60, メニュー: '試験カット', 合計金額: 4000,
    担当: 'MATTEO', 担当ID: 'st01', お名前: REQUEST.customer.name, 電話番号: REQUEST.customer.tel,
    メール: REQUEST.customer.email, 状態: '予約確定', 施術メモ: '元の申し送り' };
  const ledger = makeSheet('予約一覧', headers, [previous]);
  makeSheet('設定', ['項目', '内容'], Object.entries({ 準備中の帯: '出さない', 営業開始: '09:00',
    営業終了: '22:00', 最終受付: '21:00', 定休曜日: '', 通知先メール: 'shop@example.test' })
    .map(([項目, 内容]) => ({ 項目, 内容 })));
  makeSheet('メニュー', Array.from(vm.runInContext('MENU_HEADERS', context)),
    [{ 区分: 'カット', メニュー名: '試験カット', 価格: 4000, '所要(分)': 60, 表示: '表示' }]);
  makeSheet('おすすめメニュー', Array.from(vm.runInContext('COUPON_HEADERS', context)));
  makeSheet('休業日', Array.from(vm.runInContext('CLOSED_HEADERS', context)));
  if (queue) {
    makeSheet(vm.runInContext('BOOKING_EMAIL_SHEET', context), Array.from(vm.runInContext('BOOKING_EMAIL_HEADERS', context)));
    properties.set(vm.runInContext('BOOKING_EMAIL_ENABLED', context), 'true');
    properties.set(vm.runInContext('BOOKING_EMAIL_HEARTBEAT', context), String(clock.now));
  }
  const send = request => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(request) } }));
  const reserve = changes => send({ ...REQUEST, date: dateKey(Date.parse(instant)), ...changes });
  const change = changes => send({ type: 'change', code: previous.予約番号, tel: previous.電話番号,
    date: dateKey(Date.parse(instant)), time: '19:00', fromDate: previous.来店日, fromTime: previous.開始, ...changes });
  const adminChange = changes => context.withLedgerLock_(() => {
    context.requireAdmin_ = () => true;
    context.isAdmin_ = () => true;
    return context.doAdminChange_(ledger, { code: previous.予約番号, date: dateKey(Date.parse(instant)),
      time: '19:00', fromDate: previous.来店日, fromTime: previous.開始, ...changes });
  });
  return { context, clock, ledger, headers, previous, sheets, effects, properties, formats,
    reserve, change, adminChange, held: () => held };
}

for (const instant of ['2030-01-01T23:59:59.999+09:00', '2030-12-31T23:59:59.999+09:00', '2032-02-29T23:59:59.999+09:00']) {
  for (const operation of ['reserve', 'change']) {
    for (const queue of [false, true]) {
      test(`${operation}は日付取得直後の翌日移行でも過去の枠を保存・通知しない：${instant}／後送${queue}`, () => {
        const app = fixture({ instant, advance: 1, queue });
        const before = structuredClone([...app.sheets.values()].map(sheet => sheet.cells));
        const properties = Array.from(app.properties);
        const response = app[operation]();
        assert.equal(app.clock.advanced, true);
        assert.equal(response.ok, false);
        assert.equal(response.invalid, true);
        assert.match(response.error, /過ぎた|時間前/);
        assert.deepEqual([...app.sheets.values()].map(sheet => sheet.cells), before);
        assert.deepEqual(Array.from(app.properties), properties);
        assert.deepEqual(app.effects, []);
        assert.equal(app.held(), false);
      });
    }
  }
}

for (const nativeRange of [false, true]) {
  for (const operation of ['reserve', 'change']) {
    test(`${operation}は翌日移行しても翌日の営業時間内の枠を通常どおり保存する：一括範囲${nativeRange}`, () => {
      const app = fixture({ advance: 1, nativeRange });
      const response = app[operation]({ date: '2030-01-02', time: '09:00' });
      assert.equal(response.ok, true, response.error);
      assert.equal(app.clock.advanced, true);
      const row = app.ledger.cells[operation === 'reserve' ? 2 : 1];
      assert.equal(row[app.headers.indexOf('来店日')], '2030-01-02');
      assert.equal(row[app.headers.indexOf('開始')], '09:00');
      assert.equal(row[app.headers.indexOf('終了')], '10:00');
      assert.equal(app.effects.filter(effect => effect.action === 'mail').length, 2);
      assert.equal(app.properties.size, 0);
      assert.equal(app.held(), false);
    });
  }
}

for (const operation of ['reserve', 'change']) {
  for (const [time, accepted] of [['10:44', false], ['10:45', true]]) {
    test(`${operation}は従来の直前受付の境界105分を変えない：${time}`, () => {
      const app = fixture({ instant: '2030-01-01T09:00:00+09:00' });
      const before = structuredClone(app.ledger.cells);
      const response = app[operation]({ time });
      assert.equal(response.ok, accepted, response.error);
      if (!accepted) { assert.deepEqual(app.ledger.cells, before); assert.deepEqual(app.effects, []); }
      assert.equal(app.held(), false);
    });
  }
  for (const [daysAhead, accepted] of [[-1, false], [60, true], [61, false]]) {
    test(`${operation}は過去の日付と60日先までの受付範囲を変えない：${daysAhead}`, () => {
      const app = fixture({ instant: '2030-01-01T09:00:00+09:00' });
      const before = structuredClone(app.ledger.cells);
      const response = app[operation]({ date: dateKey(app.clock.now + daysAhead * DAY_MS), time: '14:00' });
      assert.equal(response.ok, accepted, response.error);
      if (!accepted) { assert.deepEqual(app.ledger.cells, before); assert.deepEqual(app.effects, []); }
      assert.equal(app.held(), false);
    });
  }
}

test('管理者の日時変更は直前受付の例外を保ち、過去の時刻への変更を拒否する', () => {
  for (const [time, accepted] of [['09:30', true], ['08:59', false]]) {
    const app = fixture({ instant: '2030-01-01T09:00:00+09:00' });
    const before = structuredClone(app.ledger.cells);
    const response = app.adminChange({ time });
    assert.equal(response.ok, accepted, response.error);
    if (!accepted) { assert.deepEqual(app.ledger.cells, before); assert.deepEqual(app.effects, []); }
    assert.equal(app.held(), false);
  }
});

test('管理者は過去の日付の元予約を変更できない', () => {
  const app = fixture({ instant: '2030-01-02T09:00:00+09:00', originalDate: '2030-01-01' });
  const before = structuredClone(app.ledger.cells);
  assert.equal(app.adminChange({ date: '2030-01-03' }).ok, false);
  assert.deepEqual(app.ledger.cells, before);
  assert.deepEqual(app.effects, []);
  assert.equal(app.held(), false);
});

for (const operation of ['reserve', 'change']) {
  test(`${operation}は次の要求では切替後の現在日時を読み直す`, () => {
    const app = fixture({ advance: 1 });
    const before = structuredClone(app.ledger.cells);
    assert.equal(app[operation]().ok, false);
    const response = app[operation]();
    assert.equal(response.ok, false);
    assert.match(response.error, /過ぎた日付/);
    assert.deepEqual(app.ledger.cells, before);
    assert.deepEqual(app.effects, []);
    assert.equal(app.held(), false);
  });
}

test('管理の開始時刻判定も同じ時点を使い、内側の変更検査は現在時刻を読み直す', () => {
  const app = fixture({ instant: '2030-01-01T09:00:00+09:00', advance: 60 * 1000 });
  assert.equal(app.adminChange({ time: '09:30' }).ok, true);
  const dateFormats = app.formats.filter(entry => entry.format === 'yyyy-MM-dd');
  const timeFormats = app.formats.filter(entry => entry.format === 'HH:mm');
  assert.equal(dateFormats.length, 2);
  assert.equal(timeFormats.length, 2);
  assert.equal(dateFormats[0].instant, timeFormats[0].instant);
  assert.equal(dateFormats[1].instant, timeFormats[1].instant);
  assert.equal(dateFormats[1].instant - dateFormats[0].instant, 60 * 1000);
  assert.equal(app.held(), false);
});

test('引数なしの時計と明示した同一時点の時計を日本時間で読む', () => {
  const app = fixture({ instant: '2030-01-02T00:00:00+09:00' });
  assert.equal(app.context.todayKey_(), '2030-01-02');
  assert.equal(app.context.nowMinJst_(), 0);
  const captured = vm.runInContext("new Date('2030-01-01T23:59:59.999+09:00')", app.context);
  assert.equal(app.context.todayKey_(captured), '2030-01-01');
  assert.equal(app.context.nowMinJst_(captured), 23 * 60 + 59);
});
