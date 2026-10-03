import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const begin = SOURCE.indexOf('function mailNeedsAttention(');
const end = SOURCE.indexOf('\nfunction reservationCard(', begin);
assert.ok(begin >= 0 && end > begin);
const LARGE_HISTORY_SIZE = 1000;
const MAX_CODE_READS_PER_ROW = 3;
const booking = index => ({ code: `LM-INDEX-${index}`, name: `架空のお客様${index}`, date: '2030-01-05',
  time: '10:00', endTime: '11:00', status: '予約確定', note: `残すメモ${index}`,
  shopMailStatus: '新規予約：送信処理受付', customerMailStatus: '新規予約：送信処理受付' });

function fixture(rows) {
  let reads = 0;
  let queries = 0;
  const current = rows.map(row => Object.defineProperty({ ...row }, 'code', {
    enumerable: true, get() { reads++; return row.code; }
  }));
  const elements = rows.map(row => ({ dataset: { mailStatus: row.code }, outerHTML: '前の表示' }));
  const alert = { hidden: true, innerHTML: '前の警告' };
  const context = vm.createContext({ adminData: { reservations: current },
    esc: value => String(value), $: () => alert, $$: () => { queries++; return elements; } });
  vm.runInContext(SOURCE.slice(begin, end), context);
  return { context, current, elements, alert, reads: () => reads, queries: () => queries,
    apply: rows => context.applyMailStatusUpdate(rows) };
}

test('全履歴の通知を逆順に受けても、予約番号を繰り返し全件探索しない', () => {
  const rows = Array.from({ length: LARGE_HISTORY_SIZE }, (_, index) => booking(index));
  const app = fixture(rows);
  assert.equal(app.apply([...rows].reverse()), true);
  const reads = app.reads();
  assert.ok(reads <= rows.length * MAX_CODE_READS_PER_ROW, `${rows.length}件で番号の参照は${reads}回`);
  assert.equal(app.queries(), 0, '同じ配送表示でDOMを再取得・書換しない');
  assert.ok(app.current.every((row, index) => row.note === rows[index].note));
});

test('末尾の予約と未登録の番号だけの通知も一回の索引で照合し、履歴を削らない', () => {
  const rows = Array.from({ length: LARGE_HISTORY_SIZE }, (_, index) => booking(index));
  const app = fixture(rows);
  assert.equal(app.apply([booking(LARGE_HISTORY_SIZE - 1), booking(LARGE_HISTORY_SIZE + 1)]), true);
  assert.ok(app.reads() <= rows.length * MAX_CODE_READS_PER_ROW);
  assert.equal(app.current.length, rows.length);
  assert.equal(app.queries(), 0);
  assert.equal(app.current[0].note, rows[0].note);
  assert.equal(app.current.at(-1).note, rows.at(-1).note);
});

test('番号の一致だけでは別の日時の配送を混ぜず、対象だけを更新して入力を保持する', () => {
  const rows = [booking(0), booking(1), booking(2)];
  const app = fixture(rows);
  const incoming = rows.map(row => ({ ...row, shopMailStatus: '新規予約：送信結果不明', note: '別のメモ' }));
  incoming[0].time = '12:00';
  incoming[2].code = 'LM-NOT-PRESENT';
  assert.equal(app.apply(incoming), true);
  assert.equal(app.current[0].shopMailStatus, rows[0].shopMailStatus);
  assert.equal(app.current[1].shopMailStatus, incoming[1].shopMailStatus);
  assert.equal(app.current[2].shopMailStatus, rows[2].shopMailStatus);
  assert.ok(app.current.every((row, index) => row.note === rows[index].note));
  assert.equal(app.elements[0].outerHTML, '前の表示');
  assert.match(app.elements[1].outerHTML, /送信結果不明/);
  assert.equal(app.elements[2].outerHTML, '前の表示');
  assert.equal(app.alert.hidden, false);
});

test('現在の配列の先頭一致を保ち、同じ番号の別の行を更新しない', () => {
  const first = booking(0);
  const second = { ...first, name: '別の行', note: '別の行のメモ' };
  const app = fixture([first, second]);
  assert.equal(app.apply([{ ...first, shopMailStatus: '新規予約：送信失敗' }]), true);
  assert.equal(app.current[0].shopMailStatus, '新規予約：送信失敗');
  assert.equal(app.current[1].shopMailStatus, second.shopMailStatus);
  assert.equal(app.current[1].note, second.note);
});

test('不正・重複した通知は照合前に全体を拒否し、部分的な表示変更をしない', () => {
  for (const incoming of [null, [booking(0), booking(0)], [booking(0), { ...booking(1), customerMailStatus: null }]]) {
    const rows = [booking(0), booking(1)];
    const app = fixture(rows);
    assert.equal(app.apply(incoming), false);
    assert.equal(app.reads(), 0);
    assert.equal(app.queries(), 0);
    assert.ok(app.current.every((row, index) => row.note === rows[index].note && row.shopMailStatus === rows[index].shopMailStatus));
    assert.ok(app.elements.every(element => element.outerHTML === '前の表示'));
  }
});

test('空の通知では索引のために全履歴を読まず、正常な空結果を保持する', () => {
  const app = fixture([booking(0), booking(1)]);
  assert.equal(app.apply([]), true);
  assert.equal(app.reads(), 0);
  assert.equal(app.queries(), 0);
  assert.equal(app.current.length, 2);
});
