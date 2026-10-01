import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const BOOKING = { 予約番号: 'LM-OCCUPIED', 来店日: '2030-01-05', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 担当ID: 'st01', 状態: '予約確定' };

function fixture({ records = [BOOKING], headers: initialHeaders, afterRead, failRead = false } = {}) {
  let held = false;
  let cells;
  const reads = [];
  const context = vm.createContext({ Date, console: { error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  vm.runInContext(SOURCE, context);
  const canonical = Array.from(vm.runInContext('HEADERS', context));
  const setRecords = (nextRecords, headers = initialHeaders || canonical) => {
    cells = [Array.from(headers), ...nextRecords.map(record => headers.map(header => record[header] ?? ''))];
  };
  setRecords(records);
  const sheet = {
    getLastRow: () => cells.length,
    getLastColumn: () => cells[0].length,
    getRange(row, column, numRows = 1, numColumns = 1) {
      return { getValues() {
        assert.equal(held, true, '枠の最終確認は予約のロック内で行う');
        reads.push({ row, column, numRows, numColumns });
        if (failRead) throw new Error('試験用の台帳読込失敗');
        const values = Array.from({ length: numRows }, (_unused, rowIndex) =>
          Array.from({ length: numColumns }, (_value, columnIndex) =>
            cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
        afterRead?.(reads.length, setRecords, canonical);
        return values;
      } };
    }
  };
  return { reads, held: () => held, setRecords,
    check: (date = BOOKING.来店日, time = '10:30', minutes = 30, staff = 'st01', ownCode = '') =>
      context.withLedgerLock_(() => context.isTaken_(sheet, date, time, minutes, staff, ownCode)) };
}

test('最終の重複検査は見出しと予約を1回の読込で取得する', () => {
  const app = fixture();
  assert.equal(app.check(), true);
  assert.equal(app.reads.length, 1);
  assert.equal(app.reads[0].row, 1);
  assert.equal(app.reads[0].numRows, 2);
  assert.equal(app.held(), false);
});

test('読込直後に列が並べ替わっても、一度取得した見出しと値を混ぜない', () => {
  const app = fixture({ afterRead(count, setRecords, canonical) {
    if (count === 1) setRecords([BOOKING], canonical.slice().reverse());
  } });
  assert.equal(app.check(), true);
  assert.equal(app.check(), true, '次の検査では新しい並びを読む');
  assert.equal(app.reads.length, 2);
});

test('次の検査では新たな予約と取消を読み直し、前の結果をキャッシュしない', () => {
  const app = fixture({ records: [] });
  assert.equal(app.check(), false);
  app.setRecords([BOOKING]);
  assert.equal(app.check(), true);
  app.setRecords([{ ...BOOKING, 状態: 'キャンセル' }]);
  assert.equal(app.check(), false);
});

test('占有時間の境界・担当違い・取消・本人の除外を維持する', () => {
  const app = fixture();
  assert.equal(app.check(BOOKING.来店日, '09:30', 30), false);
  assert.equal(app.check(BOOKING.来店日, '09:45', 30), true);
  assert.equal(app.check(BOOKING.来店日, '11:00', 30), false);
  assert.equal(app.check(BOOKING.来店日, '10:15', 30, '別の担当'), true);
  assert.equal(app.check(BOOKING.来店日, '10:30', 30, 'st01', 'ＬＭ－ｏｃｃｕｐｉｅｄ'), false);
  assert.equal(app.check('2030-01-06'), false);
  app.setRecords([{ ...BOOKING, 状態: 'キャンセル済み' }]);
  assert.equal(app.check(), false);
});

for (const change of [{ 開始: '' }, { 終了: '', '所要(分)': '' }, { 終了: '09:00', '所要(分)': 0 }]) {
  test(`占有時間が欠けた既存予約を空席として扱わない：${JSON.stringify(change)}`, () => {
    const app = fixture({ records: [{ ...BOOKING, ...change }] });
    assert.equal(app.check(BOOKING.来店日, '17:00', 30), true);
  });
}

for (const headers of [
  ['来店日', '開始', '終了', '状態', '予約番号'],
  ['独自列', '状態', '所要(分)', '開始', '来店日', '予約番号']
]) {
  test(`正常な旧台帳と任意の列の並びを保持する：${headers.join('／')}`, () => {
    const app = fixture({ headers });
    assert.equal(app.check(), true);
    assert.equal(app.check(BOOKING.来店日, '10:30', 30, 'st01', BOOKING.予約番号), false);
  });
}

for (const headers of [['日付', '開始', '終了'], ['来店日', '開始'], ['来店日', '開始', '終了', '開始']]) {
  test(`曖昧な見出しを重複なしと誤認しない：${headers.join('／')}`, () => {
    const app = fixture({ headers });
    assert.throws(() => app.check(), /予約台帳.*見出し/);
    assert.equal(app.held(), false);
  });
}

test('台帳の読込失敗を空席として返さず、ロックを解放する', () => {
  const app = fixture({ failRead: true });
  assert.throws(() => app.check(), /読込失敗/);
  assert.equal(app.held(), false);
});
