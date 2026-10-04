import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const NOW = Date.parse('2030-01-01T12:00:00+09:00');
const BOOKING = { 予約番号: 'LM-PRIVATE', 来店日: '2030-01-05', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 状態: '予約確定', お名前: '本人照合の試験客', 電話番号: '00000000000',
  メール: 'identity@example.test', 施術メモ: '店だけが見る試験メモ', ご要望: '非公開の試験要望' };

class FixtureDate extends Date {
  constructor(...values) { super(...(values.length ? values : [NOW])); }
  static now() { return NOW; }
}

function fixture({ current = {}, google = false } = {}) {
  let held = false;
  let cells;
  const effects = [];
  const reads = [];
  const spreadsheet = { getSheetByName(name) {
    assert.equal(held, true);
    reads.push(name);
    return name === '予約一覧' ? sheet : null;
  } };
  const sheet = {
    getParent: () => spreadsheet,
    getLastRow: () => cells.length,
    getLastColumn: () => cells[0].length,
    getRange(row, column, numRows = 1, numColumns = 1) {
      const range = { getValues() {
        assert.equal(held, true);
        return Array.from({ length: numRows }, (_unused, rowIndex) =>
          Array.from({ length: numColumns }, (_value, columnIndex) =>
            cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
      }, setValue(value) {
        assert.equal(held, true);
        effects.push('setValue');
        cells[row - 1][column - 1] = value;
        return range;
      }, setValues() { effects.push('setValues'); return range; },
      setFontColor() { effects.push('setFontColor'); return range; },
      setFontLine() { effects.push('setFontLine'); return range; } };
      return range;
    }
  };
  const context = vm.createContext({ Date: FixtureDate, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty(name) {
      return name === 'ADMIN_GOOGLE_ONLY' ? 'true' : null;
    }, setProperty() { effects.push('setProperty'); }, deleteProperty() { effects.push('deleteProperty'); } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() { effects.push('flush'); } },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    Utilities: { formatDate(date, _timezone, format) {
      const japan = new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();
      assert.ok(['yyyy-MM-dd', 'HH:mm'].includes(format));
      return format === 'yyyy-MM-dd' ? japan.slice(0, 10) : japan.slice(11, 16);
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) }
  });
  vm.runInContext(SOURCE, context);
  const headers = Array.from(vm.runInContext('HEADERS', context));
  const record = { ...BOOKING, ...current };
  cells = [headers, headers.map(header => record[header] ?? '')];
  const before = structuredClone(cells);
  context.getSheet_ = () => { assert.equal(held, true); return sheet; };
  for (const name of ['notify_', 'mailCustomer_', 'notifyLine_', 'recordMailStatus_', 'addToCalendar_', 'removeCalendar_']) {
    context[name] = () => { effects.push(name); };
  }
  if (google) context.verifyGoogleAdmin_ = () => { assert.equal(held, false); reads.push('google-verification'); };
  return { effects, reads, before, cells: () => structuredClone(cells), held: () => held,
    send(type, changes = {}) {
      const payload = { code: BOOKING.予約番号, tel: BOOKING.電話番号,
        date: BOOKING.来店日, time: BOOKING.開始, ...changes };
      const data = google ? { type: 'googleAdmin', action: type, payload } : { type, ...payload };
      return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(data) } }));
    }
  };
}

function assertPrivateRejection(app, result, operation) {
  assert.equal(result.ok, false);
  assert.equal(result.invalid, operation !== 'lookup' ? true : undefined);
  for (const key of ['reservation', 'code', 'alreadyCancelled', 'cancelled', 'stale', 'deadline',
    'taken', 'closed', 'unchanged', 'calendarWarning', 'notificationsQueued', 'unknown', 'restored']) {
    assert.equal(result[key], undefined, key);
  }
  for (const value of Object.values(BOOKING)) {
    if (typeof value === 'string' && value.length >= 5) assert.ok(!JSON.stringify(result).includes(value));
  }
  assert.deepEqual(app.effects, []);
  assert.deepEqual(app.cells(), app.before);
  assert.ok(!app.reads.includes('設定'));
  assert.equal(app.held(), false);
}

for (const operation of ['lookup', 'cancel', 'change']) {
  for (const tel of ['00000000001', '', null, '---', '０００－００００－０００１']) {
    test(`${operation}の本人照合失敗では、存在する番号と存在しない番号を応答から区別できない：${JSON.stringify(tel)}`, () => {
      const app = fixture();
      const result = app.send(operation, { tel });
      const missing = fixture();
      assert.deepEqual(result, missing.send(operation, { code: 'LM-MISSING', tel }));
      assertPrivateRejection(app, result, operation);
      assertPrivateRejection(missing, result, operation);
    });
  }
  for (const current of [{ 状態: 'キャンセル済' }, { 来店日: '2029-01-05' },
    { 来店日: '2030-01-01' }, { 来店日: '' }, { 開始: '14:00', 終了: '15:00' }]) {
    test(`${operation}の本人照合失敗では、取消・期限・不明日付・変更後の日時を明かさない：${JSON.stringify(current)}`, () => {
      const app = fixture({ current });
      const result = app.send(operation, { tel: '00000000001', fromDate: BOOKING.来店日, fromTime: BOOKING.開始 });
      assert.deepEqual(result, fixture().send(operation, { code: 'LM-MISSING', tel: '00000000001' }));
      assertPrivateRejection(app, result, operation);
    });
  }
  test(`${operation}の番号省略・空白・未登録でも、本人照合失敗と同じ案内を返す`, () => {
    const expected = fixture().send(operation, { tel: '00000000001' });
    for (const code of [undefined, '', '---', 'LM-MISSING', 'ＬＭ－ＭＩＳＳＩＮＧ']) {
      const app = fixture();
      const result = app.send(operation, { code });
      assert.deepEqual(result, expected);
      assertPrivateRejection(app, result, operation);
    }
  });
  test(`${operation}は公開要求の偽の管理contextを本人確認として採用しない`, () => {
    const app = fixture();
    const result = app.send(operation, { tel: '00000000001', googleAdminContext: {} });
    assert.deepEqual(result, fixture().send(operation, { code: 'LM-MISSING', tel: '00000000001' }));
    assertPrivateRejection(app, result, operation);
  });
}

test('正しい番号と全角・ハイフン付き電話の照会は、従来の公開項目だけを返す', () => {
  const app = fixture();
  const result = app.send('lookup', { code: 'ｌｍ－ｐｒｉｖａｔｅ', tel: '０００－００００－００００' });
  assert.equal(result.ok, true);
  assert.equal(result.reservation.code, BOOKING.予約番号);
  assert.equal(result.reservation.name, BOOKING.お名前);
  for (const value of [BOOKING.メール, BOOKING.施術メモ, BOOKING.ご要望]) assert.ok(!JSON.stringify(result).includes(value));
  assert.deepEqual(app.effects, []);
});

test('正しい本人照合なら、取消済みの再確認と変更不可の区別を保持する', () => {
  const cancel = fixture({ current: { 状態: 'キャンセル済' } });
  assert.equal(cancel.send('cancel').alreadyCancelled, true);
  const change = fixture({ current: { 状態: 'キャンセル済' } });
  assert.equal(change.send('change').cancelled, true);
  assert.deepEqual(cancel.effects, []);
  assert.deepEqual(change.effects, []);
});

for (const operation of ['cancel', 'change']) {
  test(`${operation}の正しい本人照合後は、従来の受付期限で停止する`, () => {
    const app = fixture({ current: { 来店日: '2030-01-01' } });
    const result = app.send(operation);
    assert.equal(result.ok, false);
    assert.equal(result.deadline, true);
    assert.deepEqual(app.effects, []);
  });
}

test('変更前と同じ日時は本人照合後に従来どおり成立し、書込や通知をしない', () => {
  const app = fixture();
  const result = app.send('change', { tel: '０００－００００－００００' });
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.deepEqual(app.effects, []);
});

test('Google認証を通った管理取消は電話番号の再入力を求めず、取消済み確認を保持する', () => {
  const app = fixture({ google: true, current: { 状態: 'キャンセル済' } });
  const result = app.send('cancel', { tel: undefined });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyCancelled, true);
  assert.equal(app.reads.filter(value => value === 'google-verification').length, 1);
  assert.deepEqual(app.effects, []);
  assert.equal(app.held(), false);
});

test('Google管理の日時変更は専用の不存在案内と最新予定の確認を保持する', () => {
  const app = fixture({ google: true });
  const result = app.send('adminChange', { code: 'LM-MISSING', fromDate: BOOKING.来店日, fromTime: BOOKING.開始 });
  assert.equal(result.ok, false);
  assert.match(result.error, /最新の予定/);
  assert.deepEqual(app.effects, []);
});
