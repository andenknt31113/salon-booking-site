import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const TODAY = '2030-01-05';
const NOW = Date.parse(TODAY + 'T03:00:00Z');
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const BOOKING = { 予約番号: 'LM-DATE', 来店日: TODAY, 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 担当ID: 'st01', 状態: '予約確定', お名前: '非公開試験客', 電話番号: '00000000000' };
const INVALID_DATES = ['', '　', '未定', '2030-02-30', '2030-13-01', '2030-00-01', '2030-01-00',
  '2030-01-32', '2000-02-30', 42, false, new Date(NaN)];

class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
  static [Symbol.hasInstance](value) { return value instanceof Date; }
}

function fixture({ records = [BOOKING], reverse = false } = {}) {
  let held = false;
  let cells;
  let occupiedReads = 0;
  const reads = [];
  const writes = [];
  const context = vm.createContext({ Date: FixtureDate, console: { error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Utilities: { formatDate(date, zone, format) {
      assert.equal(zone, 'Asia/Tokyo');
      assert.equal(format, 'yyyy-MM-dd');
      return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  vm.runInContext(SOURCE, context);
  const headers = Array.from(vm.runInContext('HEADERS', context));
  if (reverse) headers.reverse();
  const setRecords = nextRecords => {
    cells = [headers, ...nextRecords.map(record => headers.map(header => record[header] ?? ''))];
  };
  setRecords(records);
  const sheet = { getDataRange() {
    assert.equal(held, true);
    reads.push('range');
    return { getValues() {
      assert.equal(held, true);
      reads.push('values');
      return cells.map(row => row.slice());
    } };
  }, appendRow() { writes.push('append'); throw new Error('読取で書込'); } };
  context.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) };
  const originalOccupiedWindow = context.occupiedWindow_;
  context.occupiedWindow_ = (...args) => { occupiedReads++; return originalOccupiedWindow(...args); };
  return { reads, writes, setRecords, held: () => held, occupiedReads: () => occupiedReads,
    send: () => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ type: 'availability' }) } })),
    check: (ownCode = '') => context.withLedgerLock_(() =>
      context.isTaken_(sheet, TODAY, '17:00', 30, 'st01', ownCode)) };
}

for (const [index, date] of INVALID_DATES.entries()) {
  test(`来店日不明の予約を空席として返さず、最終検査も止める：${index}`, () => {
    const app = fixture({ records: [{ ...BOOKING, 来店日: date }] });
    const response = app.send();
    assert.equal(response.ok, false);
    assert.equal(response.invalid, true);
    assert.match(response.error, /予約台帳.*来店日/);
    assert.equal(Object.hasOwn(response, 'booked'), false);
    assert.equal(JSON.stringify(response).includes(BOOKING.お名前), false);
    assert.equal(JSON.stringify(response).includes(BOOKING.電話番号), false);
    assert.equal(JSON.stringify(response).includes(BOOKING.予約番号), false);
    assert.throws(() => app.check(), /予約台帳.*来店日/);
    assert.deepEqual(app.writes, []);
    assert.equal(app.held(), false);
    assert.deepEqual(app.reads, ['range', 'values', 'range', 'values']);
  });
}

test('正常な枠の前後に日付不明があっても不完全な空席一覧を返さない', () => {
  for (const records of [[BOOKING, { ...BOOKING, 来店日: '' }], [{ ...BOOKING, 来店日: '未定' }, BOOKING]]) {
    const app = fixture({ records });
    assert.equal(app.send().ok, false);
    assert.throws(() => app.check(), /予約台帳.*来店日/);
    assert.equal(app.held(), false);
  }
});

test('空行と空白だけの行は予約扱いにしない', () => {
  const app = fixture({ records: [{}, { 来店日: '　', 開始: ' ', 状態: '　' }, BOOKING] });
  assert.deepEqual(app.send(), { ok: true, booked: [{ date: TODAY, time: '10:00', minutes: 60, staffId: 'st01' }] });
  assert.equal(app.check(), false);
  assert.equal(app.occupiedReads(), 2);
  assert.deepEqual(app.writes, []);
});

for (const status of ['キャンセル', 'キャンセル済', 'キャンセル済み', '取消', '取り消し', '取消済', '中止', ' 取 消 済 ']) {
  test(`取消済みの不明日付は新しい予約の妨げにしない：${status}`, () => {
    const app = fixture({ records: [{ ...BOOKING, 来店日: '', 状態: status }] });
    assert.deepEqual(app.send(), { ok: true, booked: [] });
    assert.equal(app.check(), false);
    assert.equal(app.occupiedReads(), 0);
    assert.deepEqual(app.writes, []);
  });
}

test('管理の日時修復では本人だけを除外し、別の不明日付は除外しない', () => {
  const app = fixture({ records: [{ ...BOOKING, 来店日: '' }], reverse: true });
  assert.equal(app.check('ＬＭ－ｄａｔｅ'), false);
  assert.throws(() => app.check('LM-OTHER'), /予約台帳.*来店日/);
  app.setRecords([{ ...BOOKING, 来店日: '' }, { ...BOOKING, 予約番号: 'LM-OTHER', 来店日: '未定' }]);
  assert.throws(() => app.check(BOOKING.予約番号), /予約台帳.*来店日/);
  assert.equal(app.held(), false);
});

test('修復後と取消後は次の要求で受付判定を復旧し、前のエラーを記憶しない', () => {
  const app = fixture({ records: [{ ...BOOKING, 来店日: '' }] });
  assert.equal(app.send().ok, false);
  app.setRecords([BOOKING]);
  assert.equal(app.send().ok, true);
  assert.equal(app.check(), false);
  app.setRecords([{ ...BOOKING, 来店日: '未定', 状態: 'キャンセル' }]);
  assert.deepEqual(app.send(), { ok: true, booked: [] });
  assert.equal(app.check(), false);
});

for (const date of ['2030/1/5', '２０３０年１月５日', new Date('2030-01-04T15:00:00Z')]) {
  test(`従来の日付セル表記と日本時間の変換を保持する：${String(date)}`, () => {
    const app = fixture({ records: [{ ...BOOKING, 来店日: date }], reverse: true });
    assert.deepEqual(app.send().booked, [{ date: TODAY, time: '10:00', minutes: 60, staffId: 'st01' }]);
    assert.equal(app.check(), false);
  });
}

test('過去5000件の時刻を計算せず、今日と未来だけの保守的な占有時間を返す', () => {
  const history = Array.from({ length: 5000 }, (_unused, index) => ({ ...BOOKING,
    予約番号: `LM-PAST-${index}`, 来店日: '2029-12-31', 開始: '', 終了: '', '所要(分)': '' }));
  const app = fixture({ records: [...history, BOOKING, { ...BOOKING, 来店日: '2030-01-06', 開始: '', 終了: '' }] });
  assert.deepEqual(app.send(), { ok: true, booked: [
    { date: TODAY, time: '10:00', minutes: 60, staffId: 'st01' },
    { date: '2030-01-06', time: '00:00', minutes: 1440, staffId: 'st01' }
  ] });
  assert.equal(app.occupiedReads(), 2);
  assert.deepEqual(app.reads, ['range', 'values']);
  assert.deepEqual(app.writes, []);
});
