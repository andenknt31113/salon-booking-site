import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const extract = name => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, name);
  return match[0];
};

function renderFixture({ hidden = false, missing = false, data = true } = {}) {
  const pane = { hidden };
  const host = { innerHTML: '前回の数字' };
  const months = [];
  const calls = [];
  const current = [{ date: '2030-01-14', price: 4000 }, { date: '2030-01-14', walkIn: true, price: 6000 }];
  const previous = [{ date: '2029-12-14', price: 3000 }];
  const context = vm.createContext({ adminData: data ? {} : null, numbersMonth: 0,
    $: selector => selector === '#numbers-body' ? (missing ? null : host) : pane,
    monthOf: offset => ({ key: offset === 0 ? '2030-01' : '2029-12' }),
    monthBookings: key => { months.push(key); return key === '2030-01' ? current : previous; },
    isWalkIn: booking => booking.walkIn === true,
    numbersCount: (month, before, site, siteBefore) => { calls.push([site.length, siteBefore.length]); return '件数'; },
    numbersSources: () => '入口', numbersRepeat: () => '再予約',
    numbersOccupancy: (month, bookings) => { assert.equal(bookings, current); return '稼働'; },
    numbersSavings: () => '金額', numbersLinks: () => 'URL', numbersUnknown: () => '注意事項' });
  vm.runInContext(extract('renderNumbers'), context);
  return { context, pane, host, months, current, previous, calls };
}

test('閉じた数字画面では全履歴を集計せず、前の表示を保持する', () => {
  const app = renderFixture({ hidden: true });
  app.context.renderNumbers();
  assert.deepEqual(app.months, []);
  assert.equal(app.host.innerHTML, '前回の数字');
});

test('数字を開いた時だけ今月と比較月を読み、稼働率にも同じ月の予約を渡す', () => {
  const app = renderFixture();
  app.context.renderNumbers();
  assert.deepEqual(app.months, ['2030-01', '2029-12']);
  assert.deepEqual(app.calls, [[1, 1]]);
  assert.equal(app.host.innerHTML, '件数入口再予約稼働金額URL注意事項');
});

test('非表示中の更新は集計せず、次の表示で最新の予約を使う', () => {
  const app = renderFixture();
  app.context.renderNumbers();
  app.pane.hidden = true;
  app.current.push({ date: '2030-01-15', price: 7000 });
  app.context.renderNumbers();
  assert.equal(app.months.length, 2);
  app.pane.hidden = false;
  app.context.renderNumbers();
  assert.deepEqual(app.calls, [[1, 1], [2, 1]]);
});

test('未読込と存在しない表示領域は集計せず、空の正常な月は0件として表示する', () => {
  for (const options of [{ missing: true }, { data: false }]) {
    const app = renderFixture(options);
    app.context.renderNumbers();
    assert.deepEqual(app.months, []);
  }
  const app = renderFixture();
  app.current.length = 0;
  app.previous.length = 0;
  app.context.renderNumbers();
  assert.deepEqual(app.calls, [[0, 0]]);
});

function occupancyFixture(today = '2030-01-15') {
  const rows = [];
  let scans = 0;
  let dailyFilters = 0;
  const selected = [];
  selected.filter = (...args) => { dailyFilters++; return Array.prototype.filter.apply(selected, args); };
  const context = vm.createContext({ adminData: { reservations: rows, closedDates: [
    { '休業日': '2030-01-05' }, { '休業日': '2030-01-07', '開始': '14:00', '終了': '16:00' }
  ] }, SALON: { business: { slotMinutes: 10 } },
    isCancelled: booking => booking.status === 'キャンセル',
    numbersHours: () => ({ open: 600, close: 1200 }), acalHolidays: () => [0],
    toKey: () => today, fromKey: key => new Date(key + 'T12:00:00Z'),
    pad2: value => String(value).padStart(2, '0'),
    toMinutes: value => /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN });
  vm.runInContext(['monthBookings', 'closedBlocksOn', 'closedAllDay', 'openMinutesOn', 'endMinutesOf', 'occupancy']
    .map(extract).join('\n'), context);
  const readMonth = context.monthBookings;
  context.monthBookings = key => { scans++; return readMonth(key); };
  return { context, rows, selected, scans: () => scans, dailyFilters: () => dailyFilters };
}

const month = { key: '2030-01', year: 2030, month: 1 };
const plain = value => JSON.parse(JSON.stringify(value));

test('稼働率は定休・終日休み・時間休み・未来・取消・旧終了時刻と営業時間端を従来どおり扱う', () => {
  const app = occupancyFixture();
  app.rows.push(...[
    ['2030-01-01', '09:30', '10:30'], ['2030-01-01', '19:30', '21:00'],
    ['2030-01-02', '11:00', ''], ['2030-01-02', '不明', '12:00'],
    ['2030-01-03', '21:00', '22:00'], ['2030-01-05', '10:00', '11:00'],
    ['2030-01-06', '10:00', '11:00'], ['2030-01-07', '10:00', '11:00'],
    ['2030-01-15', '10:00', '11:00'], ['2030-01-16', '10:00', '11:00'],
    ['2029-12-01', '10:00', '11:00']
  ].map(([date, time, endTime]) => ({ date, time, endTime, status: '予約確定' })),
  { date: '2030-01-03', time: '10:00', endTime: '20:00', status: 'キャンセル' });
  assert.deepEqual(plain(app.context.occupancy(month)),
    { open: 7080, used: 190, days: 12, until: '2030-01-15', rate: 190 / 7080 });
  assert.equal(app.scans(), 1);
});

test('選択月の予約が既にあれば全台帳を読み直さず、日ごとの全件検索も行わない', () => {
  const app = occupancyFixture();
  app.selected.push({ date: '2030-01-14', time: '10:00', endTime: '11:00' });
  app.rows.push(...app.selected);
  const result = app.context.occupancy(month, app.selected);
  assert.equal(result.used, 60);
  assert.equal(app.scans(), 0);
  assert.equal(app.dailyFilters(), 0);
});

test('うるう月の末日と、まだ始まっていない月の集計を守る', () => {
  const app = occupancyFixture('2032-03-01');
  app.context.acalHolidays = () => [];
  app.rows.push({ date: '2032-02-29', time: '10:00', endTime: '11:00' });
  assert.deepEqual(plain(app.context.occupancy({ key: '2032-02', year: 2032, month: 2 })),
    { open: 17400, used: 60, days: 29, until: '2032-02-29', rate: 60 / 17400 });
  assert.deepEqual(plain(app.context.occupancy({ key: '2032-04', year: 2032, month: 4 })),
    { open: 0, used: 0, days: 0, until: '', rate: null });
});

test('5,000件ある月も予約の日付を見るのは一回ずつで、日数倍の検索に戻らない', () => {
  const app = occupancyFixture();
  const bookingCount = 5000;
  let dateReads = 0;
  app.selected.push(...Array.from({ length: bookingCount }, () => ({
    get date() { dateReads++; return '2030-01-14'; }, time: '10:00', endTime: '11:00'
  })));
  app.rows.push(...app.selected);
  const result = app.context.occupancy(month, app.selected);
  assert.equal(result.used, bookingCount * 60);
  assert.equal(dateReads, bookingCount);
  assert.equal(app.scans(), 0);
});
