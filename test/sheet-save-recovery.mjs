import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
function environment(initial, { failWrite, failFlush = false, failRestore = false } = {}) {
  const cells = structuredClone(initial);
  const writes = [];
  let flushes = 0;
  let failed = false;
  const sheet = {
    getLastRow: () => cells.length,
    getLastColumn: () => cells[0].length,
    getRange(row, column, height, width) {
      const read = () => Array.from({ length: height }, (_unused, offset) =>
        Array.from({ length: width }, (_cell, index) => cells[row - 1 + offset]?.[column - 1 + index] ?? ''));
      return {
        getValues: () => read().map(line => line.map(value => typeof value === 'string' && value.startsWith('=') ? 42 : value)),
        getFormulas: () => read().map(line => line.map(value => typeof value === 'string' && value.startsWith('=') ? value : '')),
        clearContent() { writes.push({ clear: true }); read().forEach((line, offset) => line.forEach((_value, index) => { cells[row - 1 + offset][column - 1 + index] = ''; })); },
        setValues(values) {
          writes.push({ column, width, values: structuredClone(values) });
          if (writes.length === failWrite || (failed && failRestore)) { failed = true; throw new Error('保存サービスの障害'); }
          values.forEach((line, offset) => line.forEach((value, index) => {
            cells[row - 1 + offset] ||= Array(cells[0].length).fill('');
            cells[row - 1 + offset][column - 1 + index] = value;
          }));
        }
      };
    }
  };
  const context = vm.createContext({ Date, console: { warn() {}, error() {} }, SpreadsheetApp: {
    flush() { flushes++; if (failFlush && flushes === 1) { failed = true; throw new Error('反映時の障害'); } }
  } });
  vm.runInContext(source, context);
  return { cells, writes, save(rows) { return context.writeSheetRows_({ getSheetByName: () => sheet }, '設定', ['項目', '内容'], rows); } };
}

test('通常の列順は消去せず1回で置換し、余った行だけ空欄にする', () => {
  const store = environment([['項目', '内容', '独自列'], ['営業開始', '09:00', '=1+1'], ['営業終了', '22:00', '残す']]);
  store.save([{ 項目: '営業開始', 内容: '10:00' }]);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].clear, undefined);
  assert.deepEqual(store.cells, [['項目', '内容', '独自列'], ['営業開始', '10:00', '=1+1'], ['', '', '残す']]);
});

test('最初の書込失敗でも先に旧データを消さない', () => {
  const initial = [['項目', '内容'], ['営業開始', '09:00']];
  const store = environment(initial, { failWrite: 1 });
  assert.throws(() => store.save([{ 項目: '営業開始', 内容: '10:00' }]), /元の内容に戻/);
  assert.deepEqual(store.cells, initial);
});

test('独自列を挟んだ途中書込の失敗は、対象列だけ元の値・数式へ戻す', () => {
  const initial = [['内容', '独自列', '項目'], ['=1+1', '=A2*2', '営業開始'], ['22:00', '残す', '営業終了']];
  const store = environment(initial, { failWrite: 2 });
  assert.throws(() => store.save([{ 項目: '営業開始', 内容: '10:00' }]), /元の内容に戻/);
  assert.deepEqual(store.cells, initial);
  assert.ok(store.writes.every(write => write.column !== 2 && write.width === 1), '独自列は書き直しもしない');
});

test('反映確定時の失敗も復旧し、追加行の途中結果を残さない', () => {
  const store = environment([['項目', '内容'], ['営業開始', '09:00']], { failFlush: true });
  assert.throws(() => store.save([{ 項目: '営業開始', 内容: '10:00' }, { 項目: '営業終了', 内容: '20:00' }]), /元の内容に戻/);
  assert.deepEqual(store.cells, [['項目', '内容'], ['営業開始', '09:00'], ['', '']]);
});

test('復旧にも失敗したら元に戻ったと案内せず、再送しないよう知らせる', () => {
  const store = environment([['項目', '独自列', '内容'], ['営業開始', '残す', '09:00']], { failWrite: 2, failRestore: true });
  assert.throws(() => store.save([{ 項目: '変更済み', 内容: '10:00' }]), /復旧.*確認できません.*保存し直さず/);
  assert.equal(store.cells[1][1], '残す');
});

test('空一覧の保存も一括で消し、書込失敗なら旧一覧を残す', () => {
  const initial = [['項目', '内容', '独自列'], ['営業開始', '09:00', '残す']];
  const store = environment(initial);
  store.save([]);
  assert.equal(store.writes.length, 1);
  assert.deepEqual(store.cells, [['項目', '内容', '独自列'], ['', '', '残す']]);
  const failed = environment(initial, { failWrite: 1 });
  assert.throws(() => failed.save([]), /元の内容に戻/);
  assert.deepEqual(failed.cells, initial);
});
