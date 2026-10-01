import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const DATE = '2028-02-29';
const validRow = { 休業日: DATE, 開始: '14:00', 終了: '16:00', メモ: '維持するメモ' };

function fixture() {
  const calls = [];
  let savedRows;
  const context = vm.createContext({ Date, console });
  vm.runInContext(source, context);
  context.requireAdmin_ = () => calls.push('認証');
  context.SpreadsheetApp = { getActiveSpreadsheet: () => { calls.push('台帳取得'); return {}; } };
  context.sheetStamp_ = () => 'current';
  context.allStamps_ = () => ({ closed: 'new' });
  context.writeSheetRows_ = (_spreadsheet, _name, _headers, rows) => {
    calls.push('保存');
    savedRows = structuredClone(rows);
  };
  return { calls, context, saved: () => savedRows,
    save: rows => context.doAdminSave_({ target: 'closed', rows, stamp: 'current' }) };
}

const invalidCases = [
  ['逆転した時間帯', { ...validRow, 終了: '12:00' }, '終了'],
  ['長さゼロの時間帯', { ...validRow, 終了: '14:00' }, '終了'],
  ['日またぎ', { ...validRow, 開始: '23:00', 終了: '01:00' }, '終了'],
  ['開始のみ', { ...validRow, 終了: '' }, '終了'],
  ['終了のみ', { ...validRow, 開始: '' }, '開始'],
  ['壊れた時刻', { ...validRow, 開始: '29:00' }, '開始'],
  ['存在しない分', { ...validRow, 終了: '16:99' }, '終了'],
  ['数字ゼロを終日指定にしない', { ...validRow, 開始: 0, 終了: '' }, '開始'],
  ['真偽値を終日指定にしない', { ...validRow, 終了: false }, '終了'],
  ['存在しないうるう日', { ...validRow, 休業日: '2027-02-29' }, '休業日'],
  ['存在しない日', { ...validRow, 休業日: '2028-04-31' }, '休業日'],
  ['空の日付', { ...validRow, 休業日: '' }, '休業日'],
  ['日付の型不正', { ...validRow, 休業日: {} }, '休業日'],
  ['行の欠落', null, '休業日']
];

for (const [label, row, field] of invalidCases) {
  test(`休業日保存：${label}は認証後・シートへの接続前に拒否する`, () => {
    const app = fixture();
    const rows = [structuredClone(validRow), row];
    const before = structuredClone(rows);
    const result = app.save(rows);
    assert.equal(result.ok, false);
    assert.equal(result.invalidClosed, true);
    assert.equal(result.invalidRow, 1);
    assert.equal(result.invalidField, field);
    assert.match(result.error, /2件目/);
    assert.deepEqual(app.calls, ['認証'], '他の休業日の消去・シートへの接続をしない');
    assert.deepEqual(rows, before, '不正な入力を黙って終日休みに変換しない');
  });
}

test('有効な時間帯・終日・明示的な空配列は、既存の競合確認と保存を通る', () => {
  for (const rows of [[validRow], [{ ...validRow, 開始: '', 終了: '' }], []]) {
    const app = fixture();
    const result = app.save(rows);
    assert.equal(result.ok, true);
    assert.deepEqual(app.saved(), rows);
    assert.deepEqual(app.calls, ['認証', '台帳取得', '保存']);
  }
  const app = fixture();
  app.context.sheetStamp_ = () => 'changed';
  assert.equal(app.save([validRow]).stale, true);
  assert.equal(app.saved(), undefined, '新しい検証で競合保護を飛ばさない');
});

test('認証の失敗を休業入力のエラーで隠さず、シートへ触れない', () => {
  const app = fixture();
  app.context.requireAdmin_ = () => { throw new Error('管理権限なし'); };
  assert.throws(() => app.save([null]), /管理権限なし/);
  assert.deepEqual(app.calls, []);
});

test('既存の壊れた時間帯は読込時も終日を止め、勝手に空席へ変えない', () => {
  const app = fixture();
  app.context.readSheetSnapshot_ = () => ({ head: ['休業日', '開始', '終了', 'メモ'],
    rows: [[DATE, '14:00', '12:00', '以前の逆転指定'], [DATE, '14:00', '', '終了が空']] });
  const result = app.context.readClosedSheet_({ getSheetByName: () => ({}) });
  assert.deepEqual(Array.from(result), [DATE, DATE]);
});
