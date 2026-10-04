import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const NOW = Date.parse('2030-01-01T12:00:00+09:00');
const ORIGINAL = { 予約番号: 'LM-TARGET', 来店日: '2030-01-05', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 状態: '予約確定', メニュー: '対象予約の試験カット', 担当: '試験担当', 担当ID: 'st01',
  合計金額: 4000, お名前: '対象の試験客', 電話番号: '00000000000', メール: 'target@example.test',
  施術メモ: '対象の非公開メモ', 独自列: 'そのまま残す' };
const OTHER = { ...ORIGINAL, 予約番号: 'LM-OTHER', お名前: '別の試験客', メール: 'other@example.test',
  メニュー: '別予約の試験カット', 施術メモ: '別の非公開メモ', 独自列: '別の行も残す' };
const CHANGED = { 来店日: '2030-01-07', 開始: '14:00', 終了: '15:00' };
const ACTIONS = [{ type: 'cancel' }, { type: 'change' },
  { type: 'cancel', google: true }, { type: 'adminChange', google: true }];

class FixtureDate extends Date {
  constructor(...values) { super(...(values.length ? values : [NOW])); }
  static now() { return NOW; }
}

function fixture({ phase = '', mutation = 'rows', discard = false, reordered = false, other = {} } = {}) {
  let held = false;
  let mutated = false;
  let cells;
  let targetReads = 0;
  let expectedOther = { ...OTHER, ...other };
  const writes = [];
  const effects = [];
  const properties = new Map([['ADMIN_GOOGLE_ONLY', 'true']]);
  const snapshot = code => {
    const index = cells[0].indexOf('予約番号');
    const values = cells.slice(1).find(row => row[index] === code);
    return values ? Object.fromEntries(cells[0].map((header, offset) => [header, values[offset]])) : null;
  };
  const mutate = () => {
    if (mutated) return;
    mutated = true;
    if (phase === 'after-save') {
      const otherRow = cells.find(row => row[cells[0].indexOf('予約番号')] === OTHER.予約番号);
      for (const [header, value] of Object.entries(CHANGED)) otherRow[cells[0].indexOf(header)] = value;
      otherRow[cells[0].indexOf('状態')] = 'キャンセル';
      expectedOther = { ...expectedOther, ...CHANGED, 状態: 'キャンセル' };
    }
    if (mutation === 'rows') [cells[1], cells[2]] = [cells[2], cells[1]];
    else if (mutation === 'headers') {
      const indices = cells[0].map((_header, index) => index).reverse();
      cells = cells.map(row => indices.map(index => row[index]));
    } else if (mutation === 'phone') cells[1][cells[0].indexOf('電話番号')] = '00000000001';
    else if (mutation === 'state') cells[1][cells[0].indexOf('状態')] = 'キャンセル';
    else throw new Error('不明な試験用の変更');
  };
  const spreadsheet = { getSheetByName: name => name === '予約一覧' ? sheet : null };
  const sheet = {
    getParent: () => spreadsheet,
    getLastRow: () => cells.length,
    getLastColumn: () => cells[0].length,
    getRange(row, column, height = 1, width = 1) {
      const range = {
        getValues() {
          assert.equal(held, true);
          const values = Array.from({ length: height }, (_unused, rowIndex) =>
            Array.from({ length: width }, (_value, columnIndex) => cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
          if (phase === 'after-code' && row === 2 && height === 2 && width === 1
              && column === cells[0].indexOf('予約番号') + 1) mutate();
          if (row === 2 && height === 1 && width === cells[0].length && ++targetReads === 1
              && phase === 'after-initial-read') mutate();
          return values;
        },
        getFormulas() { return Array.from({ length: height }, () => Array(width).fill('')); },
        setValues(values) {
          assert.equal(held, true);
          writes.push({ row, code: cells[row - 1]?.[cells[0].indexOf('予約番号')], column, width });
          if (!discard || writes.length > 1) values.forEach((line, rowIndex) => line.forEach((value, columnIndex) => {
            cells[row - 1 + rowIndex][column - 1 + columnIndex] = value;
          }));
          if (phase === 'after-save') mutate();
          return range;
        },
        setValue(value) { return range.setValues([[value]]); },
        setFontLine() { effects.push('format'); return range; },
        setFontColor() { effects.push('format'); return range; }
      };
      return range;
    }
  };
  const context = vm.createContext({ Date: FixtureDate, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null,
      setProperty(key, value) { properties.set(key, value); if (phase === 'after-journal') mutate(); },
      deleteProperty: key => properties.delete(key) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() { assert.equal(held, true); } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    Utilities: { formatDate(date, _timezone, format) {
      const japan = new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();
      assert.ok(['yyyy-MM-dd', 'HH:mm'].includes(format));
      return format === 'yyyy-MM-dd' ? japan.slice(0, 10) : japan.slice(11, 16);
    } }
  });
  vm.runInContext(SOURCE, context);
  const canonical = [...Array.from(vm.runInContext('HEADERS', context)), '独自列'];
  const headers = reordered ? canonical.slice().reverse() : canonical;
  cells = [headers, ...[ORIGINAL, expectedOther].map(record => headers.map(header => record[header] ?? ''))];
  const before = snapshot(ORIGINAL.予約番号);
  context.getSheet_ = () => { assert.equal(held, true); return sheet; };
  context.verifyGoogleAdmin_ = () => { assert.equal(held, false); };
  context.stageBookingEmails_ = () => { assert.equal(held, true); if (phase === 'after-stage') mutate(); return false; };
  context.recordMailStatus_ = () => {};
  for (const name of ['notify_', 'mailCustomer_', 'notifyLine_', 'addToCalendar_', 'removeFromCalendar_']) {
    context[name] = () => { effects.push(name); return '送信処理受付'; };
  }
  return { before, writes, effects, properties, mutated: () => mutated, held: () => held,
    target: () => snapshot(ORIGINAL.予約番号), other: () => snapshot(OTHER.予約番号), expectedOther: () => expectedOther,
    send({ type, google = false }, changes = {}) {
      const payload = { code: ORIGINAL.予約番号, tel: ORIGINAL.電話番号,
        fromDate: ORIGINAL.来店日, fromTime: ORIGINAL.開始, date: CHANGED.来店日, time: CHANGED.開始, ...changes };
      return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(google
        ? { type: 'googleAdmin', action: type, payload } : { type, ...payload }) } }));
    }
  };
}

function assertSafeTarget(app, result, action) {
  assert.ok(app.writes.every(write => write.code === ORIGINAL.予約番号), '別の予約行へ書かない');
  for (const [header, value] of Object.entries(app.expectedOther())) assert.equal(app.other()[header], value, header);
  if (result.ok) {
    if (action.type === 'adminChange') {
      assert.equal(result.reservation.code, ORIGINAL.予約番号);
      assert.equal(result.reservation.name, ORIGINAL.お名前);
      assert.equal(result.reservation.date, CHANGED.来店日);
      assert.equal(result.reservation.time, CHANGED.開始);
    }
    if (action.type === 'cancel') assert.equal(app.target().状態, 'キャンセル');
    else for (const [header, value] of Object.entries(CHANGED)) assert.equal(app.target()[header], value, header);
  } else {
    assert.ok(result.invalid || result.unknown || result.restored, '保存前の拒否・結果不明・復旧済みを区別する');
    assert.equal(result.reservation, undefined);
    assert.deepEqual(app.effects, []);
    if (!app.writes.length || result.restored) assert.deepEqual(app.target(), app.before);
  }
  assert.equal(app.held(), false);
}

for (const action of ACTIONS) {
  const label = `${action.google ? 'Google管理' : 'お客様'}の${action.type}`;
  for (const phase of ['after-code', 'after-initial-read', 'after-stage']) {
    test(`${label}の${phase}で行が入れ替わっても、別予約の保存・返却・通知へすり替えない`, () => {
      const app = fixture({ phase });
      const result = app.send(action);
      assert.equal(app.mutated(), true);
      assertSafeTarget(app, result, action);
    });
  }
  for (const phase of ['after-code', 'after-initial-read', 'after-stage']) {
    test(`${label}の${phase}で列が変わったら、古い列番号で保存・通知しない`, () => {
      const app = fixture({ phase, mutation: 'headers' });
      const result = app.send(action);
      assert.equal(app.mutated(), true);
      assert.equal(result.ok, false);
      assertSafeTarget(app, result, action);
    });
  }
  test(`${label}の保存直前に本人の電話番号が変わったら、古い本人確認で保存を続けない`, () => {
    const app = fixture({ phase: 'after-stage', mutation: 'phone' });
    const result = app.send(action);
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.effects, []);
    assert.equal(app.target().電話番号, '00000000001');
  });
  test(`${label}の保存直前の取消状態を上書きせず、送信を先取りしない`, () => {
    const app = fixture({ phase: 'after-stage', mutation: 'state' });
    const result = app.send(action);
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.effects, []);
    assert.equal(app.target().状態, 'キャンセル');
  });
  test(`${label}の反映漏れと行入替が重なっても、別の行の同じ値を成功確認に使わない`, () => {
    const app = fixture({ phase: 'after-save', discard: true });
    const result = app.send(action);
    assert.equal(result.ok, false);
    assertSafeTarget(app, result, action);
    assert.deepEqual(app.target(), app.before);
  });
  test(`${label}は正常な列の並び替え・独自列と、同じ電話を使う別予約を保持する`, () => {
    const app = fixture({ reordered: true });
    const result = app.send(action);
    assert.equal(result.ok, true);
    assertSafeTarget(app, result, action);
    assert.equal(app.target().施術メモ, ORIGINAL.施術メモ);
    assert.equal(app.target().独自列, ORIGINAL.独自列);
    assert.equal(app.properties.has('BOOKING_CHANGE_RECOVERY'), false);
  });
}

for (const action of ACTIONS.filter(value => value.type !== 'cancel')) {
  test(`${action.type}の復旧記録の直後に行が入れ替わっても、別予約へ日時を書かない`, () => {
    const app = fixture({ phase: 'after-journal' });
    const result = app.send(action);
    assert.equal(result.ok, false);
    assertSafeTarget(app, result, action);
    assert.deepEqual(app.target(), app.before);
    assert.equal(app.properties.has('BOOKING_CHANGE_RECOVERY'), false);
  });
}
