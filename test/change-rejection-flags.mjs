import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const ORIGINAL = { 予約番号: 'LM-CHG01', 来店日: '2030-01-02', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 状態: '予約確定', 担当ID: 'st01', 電話番号: '00000000000' };
const REQUEST = { code: ORIGINAL.予約番号, tel: ORIGINAL.電話番号, date: '2030-01-03', time: '14:00',
  fromDate: ORIGINAL.来店日, fromTime: ORIGINAL.開始 };

function fixture() {
  const context = vm.createContext({ Date, console });
  vm.runInContext(source, context);
  const record = { ...ORIGINAL };
  const header = Object.keys(record);
  let writes = 0;
  context.findRowByCode_ = () => 2;
  context.colIndex_ = () => name => header.indexOf(name);
  context.readRow_ = () => header.map(name => record[name]);
  context.isAdmin_ = () => false;
  context.withinDeadline_ = () => true;
  context.todayKey_ = () => '2030-01-01';
  context.nowMinJst_ = () => 9 * 60;
  context.openHours_ = () => ({ open: 9 * 60, last: 21 * 60, close: 22 * 60 });
  context.isClosedWeekday_ = () => false;
  context.hitsClosed_ = () => false;
  context.isTaken_ = () => false;
  context.writeBookingWindow_ = () => { writes++; throw new Error('拒否前に書込された'); };
  return { context, record, writes: () => writes,
    change: request => context.doChange_({}, { ...REQUEST, ...request }) };
}

const cases = [
  ['予約番号なし', 'invalid', app => { app.context.findRowByCode_ = () => -1; }],
  ['本人確認の不一致', 'invalid', () => {}, { tel: '00000000001' }],
  ['取消済み', 'cancelled', app => { app.record.状態 = 'キャンセル'; }],
  ['元日付の不明', 'invalid', app => { app.record.来店日 = '不明'; }],
  ['期限切れ', 'deadline', app => { app.context.withinDeadline_ = () => false; }],
  ['壊れた日付', 'invalid', () => {}, { date: '2030-02-30' }],
  ['過去への移動', 'invalid', () => {}, { date: '2029-12-31' }],
  ['受付範囲外', 'invalid', () => {}, { date: '2030-06-01' }],
  ['壊れた開始時刻', 'invalid', () => {}, { time: '29:00' }],
  ['直前の当日変更', 'invalid', () => {}, { date: '2030-01-01', time: '09:00' }],
  ['所要時間の不正', 'invalid', app => { app.record['所要(分)'] = 0; }],
  ['営業時間外', 'scheduleChanged', () => {}, { time: '22:00' }],
  ['定休日', 'scheduleChanged', app => { app.context.isClosedWeekday_ = () => true; }],
  ['臨時休業', 'closed', app => { app.context.hitsClosed_ = () => true; }],
  ['予約の重なり', 'taken', app => { app.context.isTaken_ = () => true; }],
  ['元日時の不足', 'invalid', () => {}, { fromTime: '' }],
  ['元日時の競合', 'stale', () => {}, { fromTime: '12:00' }]
];

for (const [name, flag, prepare, request] of cases) {
  test(`日時変更の${name}は、通信結果不明ではなく${flag}として書込前に拒否する`, () => {
    const app = fixture();
    prepare(app);
    const before = { ...app.record };
    const result = app.change(request);
    assert.equal(result.ok, false);
    assert.equal(result[flag], true);
    assert.equal(result.unknown, undefined);
    assert.equal(app.writes(), 0);
    assert.deepEqual(app.record, before);
    assert.ok(result.error);
  });
}
