import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { assertAdminContract } from './admin-contract.mjs';

const source = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const common = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const extract = (code, name) => {
  const match = code.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, name);
  return match[0];
};
const TEST_DATE = '2030-01-01';
const dates = Array.from({ length: 7 }, (_unused, index) => `2030-01-0${index + 1}`);
const functions = ['endMinutesOf', 'surnameOf', 'acalCellBody', 'acalCell', 'closedAllDay',
  'closedBlocksOn', 'renderAdminCalendar'];

function fixture({ code = source, hidden = false, missing = false, loaded = true, offset = 0,
  records = [], closed = [], times = ['10:00', '10:10', '10:20', '10:30', '10:40', '10:50', '11:00'], holidays = [] } = {}) {
  const host = { hidden };
  const head = { innerHTML: '保持する見出し' };
  const body = { innerHTML: '保持する予定表' };
  const range = { textContent: '保持する期間' };
  const maps = [];
  const period = [];
  let timeReads = 0;
  const context = vm.createContext({ adminData: loaded ? { reservations: records, closedDates: closed } : null,
    SALON: { business: { slotMinutes: 10 } }, WEEKDAY_JA: ['日', '月', '火', '水', '木', '金', '土'],
    ACAL_DAYS: 7, acalOffset: offset,
    Date: class extends Date {
      constructor(...values) { super(...(values.length ? values : [TEST_DATE + 'T12:00:00+09:00'])); }
    },
    Map: class extends Map { constructor(entries) { super(entries); maps.push(this); } },
    $: selector => {
      const nodes = { '#admin-calendar': missing ? null : host, '#acal-head': head, '#acal-body': body, '#acal-range': range };
      assert.ok(Object.hasOwn(nodes, selector), selector);
      return nodes[selector];
    },
    acalTimes: () => { timeReads++; return times; }, acalHolidays: () => holidays,
    Availability: { dateRange: (start, count) => {
      period.push([start, count]);
      return dates.map(date => {
        const value = new Date(date + 'T12:00:00Z');
        value.setUTCDate(value.getUTCDate() + start);
        return value.toISOString().slice(0, 10);
      });
    } }
  });
  vm.runInContext([common.match(/^const pad2 =[^\n]+/m)[0], code.match(/^const isCancelled =[^\n]+/m)[0],
    ...['toKey', 'fromKey', 'formatDateJa', 'toMinutes', 'esc'].map(name => extract(common, name)),
    ...functions.map(name => extract(code, name))].join('\n'), context);
  return { context, host, head, body, range, maps, period, timeReads: () => timeReads };
}

test('一覧で隠れている予定表は履歴を走査せず、以前の表と期間を保持する', () => {
  const app = fixture({ hidden: true });
  Object.defineProperty(app.context.adminData, 'reservations', { get() { throw new Error('不要な台帳参照'); } });
  app.context.renderAdminCalendar();
  assert.equal(app.timeReads(), 0);
  assert.deepEqual(app.period, []);
  assert.equal(app.head.innerHTML, '保持する見出し');
  assert.equal(app.body.innerHTML, '保持する予定表');
  assert.equal(app.range.textContent, '保持する期間');
});

test('5,000件の予約の日付を一度ずつ読み、表示する7日間だけをまとめる', () => {
  let dateReads = 0;
  const history = Array.from({ length: 5000 }, (_unused, index) => {
    const date = index < 2 ? TEST_DATE : new Date(Date.UTC(2010, 0, index + 1)).toISOString().slice(0, 10);
    return { get date() { dateReads++; return date; }, code: `LM-GRID-${index}`,
      time: '10:00', endTime: '10:30', name: '架空 太郎', status: '予約確定' };
  });
  const app = fixture({ records: history });
  app.context.renderAdminCalendar();
  assert.equal(dateReads, history.length);
  assert.equal(app.maps.length, 1);
  assert.deepEqual([...app.maps[0].keys()], dates);
  assert.equal([...app.maps[0].values()].reduce((sum, rows) => sum + rows.length, 0), 2);
  assert.match(app.body.innerHTML, /LM-GRID-0/);
  assert.doesNotMatch(app.body.innerHTML, /LM-GRID-2/);
});

const records = [
  { code: 'LM-LIVE', date: TEST_DATE, time: '10:05', endTime: '10:35', name: '架空 一郎', status: '予約確定' },
  { code: 'LM-CANCELLED', date: TEST_DATE, time: '10:00', endTime: '11:00', name: '取消 太郎', status: 'キャンセル' },
  { code: 'LM-OVERLAP', date: TEST_DATE, time: '10:20', endTime: '10:40', name: '<>&" 太郎', status: '' },
  { code: 'LM-OLD-END', date: '2030-01-02', time: '10:00', endTime: '', name: '古い予約', status: '予約確定' },
  { code: 'LM-PREVIOUS', date: '2029-12-31', time: '10:00', endTime: '10:30', name: '前日 太郎', status: '予約確定' },
  { code: 'LM-NEXT', date: '2030-01-08', time: '10:00', endTime: '10:30', name: '翌週 太郎', status: '予約確定' },
  { code: 'LM-UNKNOWN', date: '', time: '10:00', endTime: '10:30', name: '日付なし', status: '予約確定' }
];
const closed = [{ '休業日': TEST_DATE, '開始': '10:10', '終了': '10:40', 'メモ': '架空の時間休み' },
  { '休業日': '2030-01-03' }];

for (const offset of [-7, 0, 7]) {
  test(`表示週${offset}の予約・取消・時間休み・重なり・旧終了時刻が変更前と一致する`, () => {
    const before = structuredClone({ records, closed });
    const options = { records, closed, offset, holidays: [0] };
    const app = fixture(options);
    app.context.renderAdminCalendar();
    assertAdminContract('calendar:week:' + offset,
      { head: app.head.innerHTML, body: app.body.innerHTML, range: app.range.textContent });
    assert.deepEqual({ records, closed }, before);
    assert.deepEqual(app.period, [[offset, 7]]);
  });
}

test('隠れている間の予約の置換と取消は、再表示した時だけ最新の表へ反映する', () => {
  const app = fixture({ records: structuredClone(records), closed });
  app.context.renderAdminCalendar();
  const before = app.body.innerHTML;
  app.host.hidden = true;
  app.context.adminData.reservations = [{ ...records[0], code: 'LM-UPDATED', time: '10:40', endTime: '11:00' }];
  app.context.renderAdminCalendar();
  assert.equal(app.body.innerHTML, before);
  assert.equal(app.timeReads(), 1);
  app.host.hidden = false;
  app.context.renderAdminCalendar();
  assert.equal(app.timeReads(), 2);
  assert.match(app.body.innerHTML, /LM-UPDATED/);
  assert.doesNotMatch(app.body.innerHTML, /LM-LIVE|LM-CANCELLED/);
});

test('未読込・予定表なし・予約なし・時刻を読めない場合の表示を保持する', () => {
  for (const options of [{ loaded: false }, { missing: true }]) {
    const app = fixture(options);
    app.context.renderAdminCalendar();
    assert.equal(app.timeReads(), 0);
    assert.equal(app.body.innerHTML, '保持する予定表');
  }
  for (const options of [{ records: [] }, { records: null }, { times: [] }]) {
    const app = fixture(options);
    app.context.renderAdminCalendar();
    assertAdminContract('calendar:empty:' + JSON.stringify(options), app.body.innerHTML);
  }
});
