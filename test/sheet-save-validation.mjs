import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');

function createStore() {
  const cells = [['項目', '内容', '店舗用の別列'], ['営業開始', '09:00', '維持する値'], ['通知先メール', 'owner@example.invalid', '別の値']];
  const changes = [];
  const sheet = {
    getLastRow: () => cells.length,
    getLastColumn: () => cells[0].length,
    getRange(row, column, height, width) {
      return {
        getValues: () => cells.slice(row - 1, row - 1 + height).map(values => values.slice(column - 1, column - 1 + width)),
        getFormulas: () => Array.from({ length: height }, () => Array(width).fill('')),
        clearContent() {
          changes.push('消去');
          for (let rowIndex = row - 1; rowIndex < row - 1 + height; rowIndex++) {
            for (let columnIndex = column - 1; columnIndex < column - 1 + width; columnIndex++) cells[rowIndex][columnIndex] = '';
          }
        },
        setValues(values) {
          changes.push('保存');
          values.forEach((line, rowIndex) => line.forEach((value, columnIndex) => {
            cells[row - 1 + rowIndex] ||= [];
            cells[row - 1 + rowIndex][column - 1 + columnIndex] = value;
          }));
        }
      };
    }
  };
  const context = vm.createContext({ Date, console: { error() {} }, SpreadsheetApp: { flush() {} } });
  vm.runInContext(source, context);
  return { cells, changes, context, spreadsheet: { getSheetByName: () => sheet } };
}

test('壊れた一覧を保存しても、既存の営業・通知設定を消さない', () => {
  for (const rows of [undefined, null, {}, '誤った形式', [null], [['営業開始', '10:00']], [{ 項目: '営業開始', 内容: '10:00' }, null], [{ 項目: '営業開始', 内容: {} }]]) {
    const store = createStore();
    const before = structuredClone(store.cells);
    assert.throws(() => store.context.writeSheetRows_(store.spreadsheet, '設定', ['項目', '内容'], rows), /形式/);
    assert.deepEqual(store.cells, before, '不正な形式で元の値を消さない');
    assert.deepEqual(store.changes, [], '検証が済むまで消去・保存をしない');
  }
});

test('設定オブジェクトの欠落・配列を空の設定と取り違えない', () => {
  for (const settings of [undefined, null, [], '誤った設定']) {
    const store = createStore();
    assert.throws(() => store.context.writeSettings_(store.spreadsheet, settings), /形式/);
    assert.deepEqual(store.changes, []);
    assert.equal(store.cells[2][1], 'owner@example.invalid');
  }
});

test('正しい一覧・明示的な空配列と追加列の互換動作は維持する', () => {
  const store = createStore();
  store.context.writeSheetRows_(store.spreadsheet, '設定', ['項目', '内容'], [{ 項目: '営業開始', 内容: '10:00' }]);
  assert.deepEqual(store.cells, [['項目', '内容', '店舗用の別列'], ['営業開始', '10:00', '維持する値'], ['', '', '別の値']]);
  store.context.writeSheetRows_(store.spreadsheet, '設定', ['項目', '内容'], []);
  assert.deepEqual(store.cells, [['項目', '内容', '店舗用の別列'], ['', '', '維持する値'], ['', '', '別の値']]);
  store.context.writeSettings_(store.spreadsheet, { 営業開始: '11:00', 表示: false });
  assert.equal(store.cells[1][1], '11:00');
  assert.equal(store.cells[2][1], false);
});

test('管理APIでも未指定の一覧を削除指示へ変換しない', () => {
  for (const target of ['settings', 'menus', 'coupons', 'closed', 'styles', 'reviews']) {
    for (const rows of [undefined, null, '壊れた内容', target === 'settings' ? [] : {}]) {
      const store = createStore();
      let authorizations = 0;
      let sheetAccesses = 0;
      store.context.requireAdmin_ = () => { authorizations++; };
      store.context.SpreadsheetApp = { getActiveSpreadsheet: () => { sheetAccesses++; return store.spreadsheet; } };
      const result = store.context.doAdminSave_({ target, rows });
      assert.equal(result.ok, false);
      assert.match(result.error, /形式/);
      assert.equal(authorizations, 1, '入力が壊れていても管理権限の確認は省略しない');
      assert.equal(sheetAccesses, 0, '形式の確認前に保存先へ触れない');
      assert.deepEqual(store.changes, []);
    }
  }
});
