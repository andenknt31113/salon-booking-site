import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const DATA_SOURCE = readFileSync(process.env.ADMIN_DATA_SOURCE || new URL('../assets/js/admin-data.js', import.meta.url), 'utf8');
const BOOKING = { code: 'LM-SCHEMA', date: '2030-01-05', time: '10:00', endTime: '11:00',
  name: '架空の応答確認', tel: '00000000000', status: '予約確定', price: 4000,
  menu: '架空カット', staffName: '架空担当', email: '', visit: '', source: '',
  shopMailStatus: '', customerMailStatus: '', note: '保存済みのメモ', request: '' };
const snapshot = () => ({ ok: true, reservations: [{ ...BOOKING }], closedDates: [] });
const definitions = ['validReservationRefresh', 'validAdminChangeResponse', 'validAdminChangeReservation',
  'hasPendingReservationDetails', 'hasUnsavedReservationNotes',
  'refreshReservations', 'checkAdminChange', 'loadReservationDetails'].map(name => {
  const match = SOURCE.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `${name} の実装が必要です`);
  return match[0];
}).join('\n');

function fixture(operation = '予定更新') {
  const status = { textContent: '' };
  const button = { disabled: false, closest: () => ({ querySelector: () => status }) };
  const requests = [];
  const effects = [];
  const current = { ...BOOKING };
  if (operation === '履歴取得') {
    delete current.note;
    delete current.request;
    current.detailsPending = true;
  }
  const context = vm.createContext({ adminData: { reservations: [current],
    closedDates: [{ 休業日: '2030-01-06', 開始: '', 終了: '', メモ: '保存済みの休業' }],
    menus: [{ メニュー名: '保持するメニュー' }], settings: { 値: '保持する設定' }, stamps: { closed: '0' } },
    dashboardGeneration: 1, pendingNoteSaves: new Set(), activeChange: null,
    toMinutes: value => { const parts = value.split(':').map(Number); return parts[0] * 60 + parts[1]; },
    isCancelled: row => row.status === 'キャンセル',
    reservationDetailsRead: null, reservationDetailsError: '', scopedDetailsReads: new Map(),
    $: selector => selector === '#reservation-freshness' ? status : button, $$: () => [],
    adminPost: async payload => { requests.push(JSON.parse(JSON.stringify(payload))); return context.response; },
    renderStats: () => effects.push('stats'), renderReservations: () => effects.push('rows'),
    renderAdminCalendar: () => effects.push('calendar'), renderCustomers: () => effects.push('customers'),
    renderNumbers: () => effects.push('numbers'), showReservationFreshness: () => effects.push('freshness'),
    showChangedReservation: () => { context.activeChange = null; effects.push('changed'); }
  });
  vm.runInContext(DATA_SOURCE + '\n' + definitions, context);
  return { context, status, button, effects, requests,
    validate: result => context.validReservationRefresh(result),
    async run(result) {
      context.response = result;
      if (operation === '予定更新') return context.refreshReservations();
      if (operation === '履歴取得') return context.loadReservationDetails();
      context.activeChange = { code: BOOKING.code, date: BOOKING.date, time: BOOKING.time,
        fromDate: '2030-01-04', fromTime: '12:00', fromEndTime: '13:00', pending: false, uncertain: true };
      return context.checkAdminChange(button);
    }
  };
}

const corruptions = [
  ['日時の欠落', result => { delete result.reservations[0].date; }],
  ['時刻がobject', result => { result.reservations[0].time = {}; }],
  ['終了時刻が配列', result => { result.reservations[0].endTime = []; }],
  ['氏名がobject', result => { result.reservations[0].name = { text: '壊れた氏名' }; }],
  ['電話番号がnull', result => { result.reservations[0].tel = null; }],
  ['状態がboolean', result => { result.reservations[0].status = false; }],
  ['金額が文字列', result => { result.reservations[0].price = '4000'; }],
  ['金額が非有限', result => { result.reservations[0].price = Infinity; }],
  ['ご要望がobject', result => { result.reservations[0].request = {}; }],
  ['正常行と壊れた行の混在', result => { result.reservations.push({ ...BOOKING, code: 'LM-BROKEN', date: null }); }],
  ['休業メモがobject', result => { result.closedDates = [{ 休業日: '2030-01-06', メモ: {} }]; }],
  ['休業時刻が非有限', result => { result.closedDates = [{ 休業日: '2030-01-06', 開始: NaN }]; }]
];

for (const operation of ['予定更新', '日時変更の結果確認', '履歴取得']) {
  for (const [label, mutate] of corruptions) {
    test(`${operation}で${label}の応答を反映せず、取得済みの予約・休業・編集を保持する`, async () => {
      const app = fixture(operation);
      const previousRows = app.context.adminData.reservations;
      const previousClosed = app.context.adminData.closedDates;
      const before = structuredClone(app.context.adminData);
      const result = snapshot();
      mutate(result);
      await app.run(result);
      assert.deepEqual(app.context.adminData, before);
      assert.equal(app.context.adminData.reservations, previousRows);
      assert.equal(app.context.adminData.closedDates, previousClosed);
      assert.ok(!app.effects.includes('freshness'), '不正応答を最終読込として記録しない');
      assert.equal(app.button.disabled, false);
      if (operation === '日時変更の結果確認') {
        assert.equal(app.context.activeChange.uncertain, true);
        assert.equal(app.context.activeChange.pending, false);
        assert.match(app.status.textContent, /確認できません|再送せず/);
      } else if (operation === '履歴取得') {
        assert.equal(app.context.reservationDetailsRead, null);
        assert.equal(app.context.adminData.reservations[0].detailsPending, true);
        assert.match(app.context.reservationDetailsError, /確認できません/);
      } else assert.match(app.status.textContent, /取得できません|確認できません/);
      assert.equal(app.requests.length, 1);
      assert.ok(app.requests.every(request => request.type === 'adminData' && request.reservationsOnly === true));
    });
  }
}

test('必須の予約情報は欠落・null・配列・object・誤った型を全て拒否する', () => {
  const app = fixture();
  for (const field of ['date', 'time', 'endTime', 'name', 'tel', 'status', 'price']) {
    const missing = snapshot();
    delete missing.reservations[0][field];
    assert.equal(app.validate(missing), false, `${field}の欠落`);
    for (const value of [null, [], {}, true, field === 'price' ? '4000' : 4000]) {
      const result = snapshot();
      result.reservations[0][field] = value;
      assert.equal(app.validate(result), false, `${field}の型`);
    }
  }
});

test('初回と更新で同じ予約・休業の検査を使い、更新だけでは編集データを要求しない', () => {
  const context = vm.createContext({});
  vm.runInContext(DATA_SOURCE + '\nthis.dataChecks = AdminData;', context);
  const startup = () => ({ ...snapshot(), settings: {}, menus: [], coupons: [], styles: [], reviews: [],
    stamps: { closed: '0', settings: '0', menus: '0', coupons: '0', styles: '0', reviews: '0' } });
  assert.equal(context.dataChecks.validStartup(startup()), true);
  assert.equal(context.dataChecks.validRefresh(snapshot()), true);
  assert.equal(context.dataChecks.validStartup(snapshot()), false);
  for (const [label, mutate] of corruptions) {
    const result = startup();
    mutate(result);
    assert.equal(context.dataChecks.validStartup(result), false, `${label}の初回`);
    assert.equal(context.dataChecks.validRefresh(result), false, `${label}の更新`);
  }
  const editorMissing = startup();
  delete editorMissing.menus;
  assert.equal(context.dataChecks.validStartup(editorMissing), false);
  assert.equal(context.dataChecks.validRefresh(editorMissing), true);
});

test('正常な空台帳、空文字を含む旧予約、金額0、任意列なしの読み取りを維持する', async () => {
  const app = fixture();
  const legacy = { code: 'LM-LEGACY', date: '', time: '', endTime: '', name: '', tel: '', status: '', price: 0 };
  assert.equal(app.validate({ ok: true, reservations: [legacy], closedDates: [{ 休業日: '' }] }), true);
  assert.equal(await app.run({ ok: true, reservations: [], closedDates: [] }), true);
  assert.deepEqual(app.context.adminData.reservations, []);
  assert.deepEqual(app.context.adminData.closedDates, []);
  assert.ok(app.effects.includes('freshness'));
});

test('詳細の未取得印と全量のメモを区別し、更新だけでメニュー・設定を要求しない', async () => {
  const app = fixture();
  const pending = { ...BOOKING, detailsPending: true };
  delete pending.note;
  delete pending.request;
  const result = { ok: true, reservations: [pending], closedDates: [] };
  assert.equal(await app.run(result), true);
  assert.equal(app.context.adminData.reservations[0].detailsPending, true);
  assert.deepEqual(app.context.adminData.settings, { 値: '保持する設定' });
  assert.deepEqual(app.requests, [{ type: 'adminData', reservationsOnly: true, ifNoneMatch: '' }]);
  assert.equal(app.validate({ ...result, reservations: [{ ...pending, note: '' }] }), false);
  assert.equal(app.validate({ ...result, reservations: [{ ...pending, detailsPending: false }] }), false);
});
