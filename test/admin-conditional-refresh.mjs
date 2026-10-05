import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const DATA_SOURCE = readFileSync(process.env.ADMIN_DATA_SOURCE || new URL('../assets/js/admin-data.js', import.meta.url), 'utf8');
const REFRESH = SOURCE.match(/^async function refreshReservations\([^]*?^}/m)[0];
const VERSION = 'a'.repeat(64);
const NEXT_VERSION = 'b'.repeat(64);
const BOOKING = { code: 'LM-CONDITIONAL', date: '2030-01-06', time: '10:00', endTime: '11:00',
  name: '架空のお客様', tel: '00000000000', status: '予約確定', price: 4000, note: '保持するメモ' };
const FULL = { ok: true, reservations: [{ ...BOOKING }], closedDates: [], refreshVersion: NEXT_VERSION };
const SAME = { ok: true, unchanged: true, refreshVersion: VERSION };

function fixture({ version = VERSION, response = SAME, pending = false } = {}) {
  const status = { textContent: '' };
  const button = { disabled: false };
  const effects = [];
  const requests = [];
  let complete;
  let dirty = false;
  const context = vm.createContext({ adminData: { reservations: [{ ...BOOKING }],
    closedDates: [{ 休業日: '2030-01-07' }], refreshVersion: version,
    menus: ['保持するメニュー'], stamps: { menus: '保持する印' } },
    dashboardGeneration: 1, activeChange: null,
    $: selector => selector === '#reservation-freshness' ? status : button,
    hasUnsavedReservationNotes: () => dirty, hasPendingReservationDetails: () => pending,
    adminPost: async payload => { requests.push(structuredClone(payload)); return new Promise(resolve => { complete = resolve; }); },
    renderStats: () => effects.push('stats'), renderReservations: () => effects.push('reservations'),
    renderAdminCalendar: () => effects.push('calendar'), renderCustomers: () => effects.push('customers'),
    renderNumbers: () => effects.push('numbers'), showReservationFreshness: () => { effects.push('freshness'); status.textContent = '最終読込'; }
  });
  vm.runInContext(DATA_SOURCE + '\nfunction validReservationRefresh(result) { return AdminData.validRefresh(result); }\n' + REFRESH, context);
  return { context, status, button, effects, requests, dirty: () => { dirty = true; },
    async run(value = response) { const reading = context.refreshReservations(); complete(value); return reading; },
    start() { return context.refreshReservations(); }, complete: value => complete(value) };
}

test('版が一致した予定は取得済みの全履歴・詳細・休業を保持し、時刻依存の集計と読込時刻は再描画する', async () => {
  const app = fixture();
  const rows = app.context.adminData.reservations;
  const closed = app.context.adminData.closedDates;
  const before = structuredClone(app.context.adminData);
  assert.equal(await app.run(), true);
  assert.deepEqual(app.requests, [{ type: 'adminData', reservationsOnly: true, ifNoneMatch: VERSION }]);
  assert.equal(app.context.adminData.reservations, rows);
  assert.equal(app.context.adminData.closedDates, closed);
  assert.deepEqual(app.context.adminData, before);
  assert.deepEqual(app.effects, ['stats', 'reservations', 'calendar', 'customers', 'numbers', 'freshness']);
  assert.equal(app.button.disabled, false);
});

test('初回の更新は空の版を送り、全件反映後だけ次回の版を記憶する', async () => {
  const app = fixture({ version: undefined, response: FULL });
  delete app.context.adminData.refreshVersion;
  assert.equal(await app.run(), true);
  assert.equal(app.requests[0].ifNoneMatch, '');
  assert.equal(app.context.adminData.refreshVersion, NEXT_VERSION);
  assert.deepEqual(app.context.adminData.closedDates, []);
  assert.equal(await app.run({ ...SAME, refreshVersion: NEXT_VERSION }), true);
  assert.equal(app.requests[1].ifNoneMatch, NEXT_VERSION);
});

test('過去詳細の未取得指定を保持し、旧GASの全件応答へも安全に戻れる', async () => {
  const app = fixture({ pending: true });
  const legacy = { ...FULL };
  delete legacy.refreshVersion;
  assert.equal(await app.run(legacy), true);
  assert.equal(app.requests[0].briefPast, true);
  assert.equal(app.context.adminData.refreshVersion, '');
  assert.equal(await app.run(legacy), true);
  assert.equal(app.requests[1].ifNoneMatch, '');
});

for (const bad of [null, {}, { ...SAME, ok: false }, { ...SAME, unchanged: 'true' },
  { ...SAME, refreshVersion: NEXT_VERSION }, { ...SAME, refreshVersion: '' },
  { ...SAME, reservations: [] }, { ...SAME, closedDates: [] },
  ...[null, [], {}, 1, 'short', 'F'.repeat(64)].map(refreshVersion => ({ ...FULL, refreshVersion })),
  { ...FULL, unchanged: true }, { ...FULL, unchanged: false }]) {
  test('不正な版・矛盾した変更なし応答を反映せず、全履歴と版を保持する', async () => {
    const app = fixture();
    const before = structuredClone(app.context.adminData);
    assert.notEqual(await app.run(bad), true);
    assert.deepEqual(app.context.adminData, before);
    assert.deepEqual(app.effects, []);
    assert.match(app.status.textContent, /取得できません/);
    assert.equal(app.button.disabled, false);
  });
}

test('まだ一致する版を持たない画面で変更なし応答を成功扱いしない', async () => {
  const app = fixture({ version: '' });
  assert.notEqual(await app.run(), true);
  assert.deepEqual(app.effects, []);
  assert.equal(app.context.adminData.reservations.length, 1);
});

for (const mutate of [app => { app.context.dashboardGeneration++; }, app => app.dirty(),
  app => { app.context.activeChange = { code: BOOKING.code }; },
  app => { app.context.adminData.reservations = structuredClone(app.context.adminData.reservations); },
  app => { app.context.adminData.reservations[0].note = '通信中に保存したメモ'; },
  app => { app.context.adminData.closedDates[0].休業日 = '2030-01-08'; }]) {
  for (const response of [SAME, FULL]) {
    test('通信中のログイン・入力・予定・休業変更を遅い全件／変更なし応答で巻き戻さない', async () => {
      const app = fixture();
      const reading = app.start();
      mutate(app);
      const before = structuredClone(app.context.adminData);
      app.complete(response);
      assert.notEqual(await reading, true);
      assert.deepEqual(app.context.adminData, before);
      assert.deepEqual(app.effects, []);
      assert.equal(app.button.disabled, false);
      assert.equal(app.requests.length, 1);
    });
  }
}

test('失敗応答の後も同じ版で確認し、自動再送や履歴削除をしない', async () => {
  const app = fixture();
  assert.notEqual(await app.run({ ok: false, error: '架空の読込失敗' }), true);
  assert.equal(app.context.adminData.refreshVersion, VERSION);
  assert.equal(app.requests.length, 1);
  assert.equal(await app.run(), true);
  assert.equal(app.requests.length, 2);
  assert.equal(app.context.adminData.reservations[0].note, BOOKING.note);
});
