import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { assertAdminContract } from './admin-contract.mjs';

const source = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const common = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const functions = ['closedRowProblem', 'closedStateOf', 'liveCountOn', 'renderClosedCalendar', 'renderClosed'];
const extract = (text, name) => {
  const match = text.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, name);
  return match[0];
};

function fixture({ code = source, now = '2030-01-15T12:00:00+09:00', offset = 0, hidden = false,
  missingHost = false, focused = '', records = [], closed = [] } = {}) {
  const focusedNode = focused ? { dataset: { ccal: focused } } : null;
  const focusCalls = [];
  const validationCalls = [];
  const calendar = { innerHTML: '保持するカレンダー', contains: element => !!focusedNode && element === focusedNode,
    querySelector: selector => ({ focus: options => focusCalls.push({ selector, options }) }) };
  const rows = { innerHTML: '保持する休業入力' };
  const pane = { hidden };
  const title = { textContent: '' };
  const fields = [];
  const context = vm.createContext({ adminData: { reservations: records }, edits: { closed }, ccalOffset: offset,
    closedNeedsRender: false, document: { activeElement: focusedNode }, CSS: { escape: value => value },
    WEEKDAY_JA: ['日', '月', '火', '水', '木', '金', '土'],
    Date: class extends Date {
      constructor(...values) { super(...(values.length ? values : [now])); }
      static now() { return Date.parse(now); }
    },
    $: selector => {
      const nodes = { '#closed-cal': missingHost ? null : calendar, '#ccal-title': title,
        '#closed-rows': rows, '.admin-pane[data-pane="closed"]': pane };
      assert.ok(Object.hasOwn(nodes, selector), selector);
      return nodes[selector];
    },
    fieldFor: (column, value, target, index) => { fields.push({ column, value, target, index }); return '<input />'; },
    closedSummary: row => row['休業日'], esc: value => String(value),
    updateClosedValidation: index => validationCalls.push(index) });
  const declarations = [common.match(/^const pad2 =[^\n]+/m)[0], code.match(/^const isCancelled =[^\n]+/m)[0],
    extract(common, 'toKey'), extract(common, 'fromKey'), ...functions.map(name => extract(code, name))];
  vm.runInContext(declarations.join('\n'), context);
  return { context, calendar, rows, pane, title, fields, focusCalls, validationCalls };
}

const records = [{ date: '2030-01-15', status: '予約確定' }, { date: '2030-01-15', status: '予約確定' },
  { date: '2030-01-15', status: 'キャンセル' }, { date: '2030-01-16', status: '' },
  { date: '2030-01-17', status: 'キャンセル' }, { date: '2030-02-03', status: '予約確定' },
  { date: '2029-12-03', status: '予約確定' }, { date: '', status: '予約確定' },
  { date: '2030-01-00', status: '予約確定' }, { date: '2030-01-32', status: '予約確定' },
  { date: '2030-1-15', status: '予約確定' }, { date: '日付不明', status: '予約確定' }];
const closed = [{ '休業日': '2030-01-15', '開始': '', '終了': '', 'メモ': '終日' },
  { '休業日': '2030-01-16', '開始': '12:00', '終了': '13:00', 'メモ': '一部' },
  { '休業日': '2030-01-17', '開始': '12:00', '終了': '', 'メモ': '未完成' }];

test('5,000予約の日付を日数倍で走査せず、一度ずつ確認する', () => {
  const count = 5000;
  let dateReads = 0;
  const history = Array.from({ length: count }, (_unused, index) => ({
    get date() { dateReads++; return index < 3 ? '2030-01-15' : '2025-01-01'; },
    status: index === 2 ? 'キャンセル' : '予約確定'
  }));
  const app = fixture({ records: history });
  app.context.renderClosedCalendar();
  assert.equal(dateReads, count);
  assert.match(app.calendar.innerHTML, /2030年1月15日・予約2件/);
  assert.match(app.calendar.innerHTML, /2件予約/);
});

for (const offset of [-1, 0, 1]) {
  test(`表示月${offset}の全HTML・休み方・予約件数が変更前と一致し、元データを変更しない`, () => {
    const before = structuredClone({ records, closed });
    const app = fixture({ records, closed, offset });
    app.context.renderClosedCalendar();
    assertAdminContract('closed:month:' + offset,
      { calendar: app.calendar.innerHTML, title: app.title.textContent });
    assert.deepEqual({ records, closed }, before);
  });
}

test('予約の更新・取消・配列の置換を次の描画へ反映し、古い件数をcacheしない', () => {
  const app = fixture({ records: structuredClone(records) });
  app.context.renderClosedCalendar();
  assert.match(app.calendar.innerHTML, /2030年1月15日・予約2件/);
  app.context.adminData.reservations = [{ date: '2030-01-15', status: 'キャンセル' },
    { date: '2030-01-16', status: '予約確定' }, { date: '2030-01-16', status: '予約確定' },
    { date: '2030-01-16', status: '予約確定' }];
  app.context.renderClosedCalendar();
  assert.doesNotMatch(app.calendar.innerHTML, /2030年1月15日・予約/);
  assert.match(app.calendar.innerHTML, /2030年1月16日・予約3件/);
});

test('うるう年の2月末・年境界と予約配列なしでも従来の表示を保持する', () => {
  for (const options of [{ now: '2032-03-15T12:00:00+09:00', offset: -1,
    records: [{ date: '2032-02-29', status: '予約確定' }] },
  { now: '2030-12-15T12:00:00+09:00', offset: 1, records: undefined },
  { records: null }, { records: [] }]) {
    const app = fixture(options);
    app.context.renderClosedCalendar();
    assertAdminContract('closed:edge:' + JSON.stringify(options), app.calendar.innerHTML);
  }
});

test('カレンダーがない場合はデータに触れず、描画後のフォーカスも維持する', () => {
  const missing = fixture({ missingHost: true });
  Object.defineProperty(missing.context.adminData, 'reservations', { get() { throw new Error('不要な台帳参照'); } });
  missing.context.renderClosedCalendar();
  assert.equal(missing.calendar.innerHTML, '保持するカレンダー');
  const app = fixture({ focused: '2030-01-16' });
  app.context.renderClosedCalendar();
  assert.deepEqual(app.focusCalls.map(call => ({ selector: call.selector, options: { ...call.options } })),
    [{ selector: '[data-ccal="2030-01-16"]', options: { preventScroll: true } }]);
});

test('非表示の休業日は台帳の再走査・入力生成をせず、次に開く更新だけを記録する', () => {
  const app = fixture({ hidden: true, records, closed });
  Object.defineProperty(app.context.adminData, 'reservations', { get() { throw new Error('隠れた予定表の台帳参照'); } });
  app.context.renderClosed();
  assert.equal(app.context.closedNeedsRender, true);
  assert.equal(app.calendar.innerHTML, '保持するカレンダー');
  assert.equal(app.rows.innerHTML, '保持する休業入力');
  assert.deepEqual(app.fields, []);
  assert.deepEqual(app.validationCalls, []);
});

test('表示時にはカレンダー・編集入力・検証を作り、完成後だけ更新待ちを解除する', () => {
  const app = fixture({ records, closed, hidden: true });
  app.context.renderClosed();
  app.pane.hidden = false;
  app.context.renderClosed();
  assert.equal(app.context.closedNeedsRender, false);
  assert.match(app.calendar.innerHTML, /2030年1月15日・終日休み・予約2件/);
  assert.ok(app.fields.some(field => field.column === 'メモ' && field.value === '未完成'));
  assert.deepEqual(app.validationCalls, [0, 1, 2]);
  app.pane.hidden = true;
  app.context.renderClosed();
  assert.equal(app.context.closedNeedsRender, true);
});

test('描画に失敗した場合は更新待ちを解除しない', () => {
  const app = fixture({ records, closed });
  app.context.closedNeedsRender = true;
  app.context.fieldFor = () => { throw new Error('架空の描画失敗'); };
  assert.throws(() => app.context.renderClosed(), /架空の描画失敗/);
  assert.equal(app.context.closedNeedsRender, true);
});
