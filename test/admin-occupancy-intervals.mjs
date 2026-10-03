import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const TEST_DATE = '2030-01-01';
const HOURS = { open: 600, close: 1200 };
const functions = ['closedBlocksOn', 'closedAllDay', 'openMinutesOn', 'endMinutesOf',
  'monthBookings', 'occupancy', 'numbersOccupancy'];

function fixture(ranges = [], { date = TEST_DATE, allDay = false, holidays = [] } = {}) {
  const closedDates = ranges.map(([start, end]) => ({ '休業日': date, '開始': start, '終了': end, 'メモ': '架空の時間休み' }));
  if (allDay) closedDates.push({ '休業日': date });
  const reservations = [{ date: TEST_DATE, time: '10:00', endTime: '12:00', status: '予約確定' }];
  const context = vm.createContext({ adminData: { closedDates, reservations }, SALON: { business: { slotMinutes: 10 } },
    numbersHours: () => HOURS, acalHolidays: () => holidays,
    isCancelled: booking => booking.status === 'キャンセル',
    toKey: () => TEST_DATE, fromKey: key => new Date(key + 'T12:00:00Z'),
    pad2: value => String(value).padStart(2, '0'),
    toMinutes: value => /^\d{2}:\d{2}$/.test(value)
      ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN,
    hoursText: minutes => `${Math.round(minutes / 6) / 10}時間`,
    numCard: (title, value, unit, sub, read, className) => ({ title, value, unit, sub, read, className })
  });
  vm.runInContext(functions.map(name => {
    const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, name);
    return match[0];
  }).join('\n'), context);
  return { context, closedDates, reservations };
}

const cases = [
  ['同じ時間を二重に登録', [['12:00', '15:00'], ['12:00', '15:00']], 420],
  ['一部の時間が重なる', [['12:00', '15:00'], ['14:00', '16:00']], 360],
  ['片方の時間休みがもう片方に含まれる', [['12:00', '16:00'], ['13:00', '14:00']], 360],
  ['三つの時間休みが連続して重なる', [['11:00', '13:00'], ['12:00', '15:00'], ['14:00', '16:00']], 300],
  ['隣接する時間休み', [['12:00', '14:00'], ['14:00', '15:00']], 420],
  ['離れた時間休み', [['11:00', '12:00'], ['15:00', '16:00']], 480],
  ['営業時間の外へ延びる時間休み', [['08:00', '11:00'], ['19:00', '22:00']], 480],
  ['営業時間の外だけの時間休み', [['08:00', '09:00'], ['21:00', '22:00']], 600],
  ['営業時間全体を覆う時間休み', [['09:00', '21:00']], 0],
  ['時間休みなし', [], 600],
  ['旧データの開始と終了が同じ', [['12:00', '12:00']], 600],
  ['旧データの開始と終了が逆', [['14:00', '12:00']], 600],
  ['1分単位の重なり', [['12:01', '12:03'], ['12:02', '12:04']], 597]
];

for (const [label, ranges, expected] of cases) {
  test(`営業可能な時間を実際の休業時間の和集合から計算する：${label}`, () => {
    for (const order of [ranges, ranges.slice().reverse()]) {
      const app = fixture(order);
      const before = structuredClone({ closedDates: app.closedDates, reservations: app.reservations });
      assert.equal(app.context.openMinutesOn(TEST_DATE, HOURS, []), expected);
      assert.deepEqual({ closedDates: app.closedDates, reservations: app.reservations }, before);
    }
  });
}

test('別の日の休み・終日休業・定休の判定を維持する', () => {
  assert.equal(fixture([['10:00', '20:00']], { date: '2030-01-02' })
    .context.openMinutesOn(TEST_DATE, HOURS, []), 600);
  assert.equal(fixture([['12:00', '15:00']], { allDay: true })
    .context.openMinutesOn(TEST_DATE, HOURS, []), 0);
  const weekday = new Date(TEST_DATE + 'T12:00:00Z').getDay();
  assert.equal(fixture([['12:00', '15:00']]).context.openMinutesOn(TEST_DATE, HOURS, [weekday]), 0);
});

test('重なる時間休みを含む月の稼働率と画面の時間表示を正しく返す', () => {
  const app = fixture([['12:00', '15:00'], ['14:00', '16:00']]);
  const month = { key: '2030-01', year: 2030, month: 1, label: '2030年1月' };
  const result = JSON.parse(JSON.stringify(app.context.occupancy(month)));
  assert.deepEqual(result, { open: 360, used: 120, days: 1, until: TEST_DATE, rate: 1 / 3 });
  const card = app.context.numbersOccupancy(month);
  assert.equal(card.value, '33%');
  assert.match(card.sub, /受けられた 6時間 のうち 2時間 が予約/);
});

test('読めない旧時刻を営業可能な時間として黙って数えない', () => {
  for (const ranges of [[['不明', '15:00']], [['12:00', '不明']]]) {
    const app = fixture(ranges);
    assert.ok(Number.isNaN(app.context.openMinutesOn(TEST_DATE, HOURS, [])));
    assert.equal(app.context.numbersOccupancy({ key: '2030-01', year: 2030, month: 1, label: '2030年1月' }).value,
      '分かりません');
  }
});

test('多数の組合せでも1分単位の独立した基準と一致する', () => {
  const toTime = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const scenarios = 200;
  let seed = 491;
  const nextMinute = () => {
    seed = (seed * 48271) % 2147483647;
    return seed % (24 * 60);
  };
  for (let scenario = 0; scenario < scenarios; scenario++) {
    const intervals = Array.from({ length: scenario % 12 }, () => [nextMinute(), nextMinute()].sort((first, second) => first - second));
    const blocked = new Set();
    for (const [start, end] of intervals) {
      for (let minute = Math.max(HOURS.open, start); minute < Math.min(HOURS.close, end); minute++) blocked.add(minute);
    }
    const app = fixture(intervals.map(([start, end]) => [toTime(start), toTime(end)]));
    assert.equal(app.context.openMinutesOn(TEST_DATE, HOURS, []), HOURS.close - HOURS.open - blocked.size, `組合せ${scenario}`);
  }
});
