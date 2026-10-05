import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const dataSource = readFileSync(new URL('../assets/js/admin-data.js', import.meta.url), 'utf8');
const original = { code: 'LM-CHANGE', date: '2030-01-02', time: '10:00', endTime: '11:00',
  name: '架空の日時変更客', tel: '00000000000', price: 6900, status: '予約確定',
  menu: '試験カット', staffName: '試験担当', email: 'example@example.invalid', visit: '再来',
  source: '電話', request: '元のご要望', note: '元の施術メモ', shopMailStatus: '', customerMailStatus: '' };
const changed = () => ({ ...original, date: '2030-01-04', time: '14:00', endTime: '15:00' });

function fixture() {
  const status = { textContent: '' };
  const freshness = { textContent: '変更前の一覧' };
  const date = { value: '2030-01-04', disabled: false };
  const time = { value: '14:00', disabled: false };
  const save = { disabled: false, isConnected: true };
  const check = { disabled: false, hidden: true };
  const close = { disabled: false };
  const notes = [{ value: original.note, disabled: false }];
  const fields = { '[data-change-date]': date, '[data-change-time]': time,
    '[data-change-save]': save, '[data-change-check]': check, '[data-change-status]': status };
  const editor = { querySelector: selector => fields[selector],
    querySelectorAll: () => [date, time, save, check, close] };
  save.closest = check.closest = () => editor;
  const requests = [];
  const applied = [];
  const confirmations = [];
  let finish;
  const context = vm.createContext({ dashboardGeneration: 1,
    activeChange: { code: original.code, fromDate: original.date, fromTime: original.time,
      fromEndTime: original.endTime, date: original.date, time: original.time, pending: false, uncertain: false },
    adminData: { reservations: [structuredClone(original)], closedDates: [] },
    $: () => freshness, $$: () => notes,
    toMinutes: value => { const parts = value.split(':').map(Number); return parts[0] * 60 + parts[1]; },
    isCancelled: reservation => reservation.status === 'キャンセル',
    hasUnsavedReservationNotes: () => false,
    confirmReservationAction: async (...values) => { confirmations.push(values); return true; },
    adminPost: payload => { requests.push(payload); return new Promise(resolve => { finish = resolve; }); },
    showChangedReservation: reservation => {
      applied.push(structuredClone(reservation));
      context.adminData.reservations = [reservation];
      context.activeChange = null;
    },
    refreshReservations: async () => false
  });
  vm.runInContext(dataSource, context);
  for (const name of ['validReservationRefresh', 'validAdminChangeResponse', 'validAdminChangeReservation', 'saveAdminChange', 'checkAdminChange']) {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    if (match) vm.runInContext(match[0], context);
    else assert.ok(['validAdminChangeResponse', 'validAdminChangeReservation'].includes(name), name);
  }
  return { context, save, check, date, time, notes, status, freshness, requests, applied, confirmations,
    finish: response => finish(response) };
}

const invalidResponses = [null, [], {}, { ok: 'true', reservation: changed() },
  { ok: true }, { ok: true, reservation: { code: original.code } },
  { ok: true, reservation: { ...changed(), code: 'LM-OTHER' } },
  { ok: true, reservation: original },
  { ok: true, reservation: { ...changed(), date: '2030-01-05' } },
  { ok: true, reservation: { ...changed(), time: '14:10' } },
  ...['13:00', '14:00', '15:10', '24:00', '15:90', ''].map(endTime => ({ ok: true, reservation: { ...changed(), endTime } })),
  { ok: true, reservation: { ...changed(), status: 'キャンセル' } },
  { ok: true, reservation: { ...changed(), detailsPending: true, note: undefined, request: undefined } },
  ...['name', 'price', 'note', 'request', 'email'].map(field => {
    const reservation = changed();
    delete reservation[field];
    return { ok: true, reservation };
  }),
  ...['unknown', 'transportError', 'stale', 'restored', 'invalid', 'authDenied', 'taken', 'closed', 'deadline', 'cancelled']
    .map(flag => ({ ok: true, reservation: changed(), [flag]: true })),
  { ok: true, reservation: changed(), error: '結果は未確認です' },
  { ok: false, unknown: true, error: '日時変更後の予約内容を確認できません' },
  { ok: false, transportError: true, error: '架空の通信断' },
  { ok: false, stale: true, error: '別の画面で更新されています' },
  { ok: false, unknown: 'false', error: '架空の応答' },
  { ok: false, restored: 'true', error: '架空の応答' },
  { ok: false, error: { message: '架空の応答' } }];

for (const [index, response] of invalidResponses.entries()) {
  test(`未確認の日時変更応答${index + 1}：元の予約と入力を保ち再保存を止める`, async () => {
    const app = fixture();
    const before = JSON.stringify(app.context.adminData);
    const saving = app.context.saveAdminChange(app.save);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.save.disabled, true);
    assert.equal(app.context.activeChange.pending, true);
    await app.context.saveAdminChange(app.save);
    assert.equal(app.requests.length, 1);
    app.finish(response);
    await saving;
    assert.equal(JSON.stringify(app.context.adminData), before);
    assert.deepEqual(app.applied, []);
    assert.equal(app.context.activeChange.uncertain, true);
    assert.equal(app.context.activeChange.pending, false);
    assert.equal(app.save.disabled, true);
    assert.equal(app.check.hidden, false);
    assert.equal(app.check.disabled, false);
    assert.equal(app.date.value, '2030-01-04');
    assert.equal(app.time.value, '14:00');
    assert.equal(app.notes[0].value, original.note);
    assert.equal(app.notes[0].disabled, false);
    assert.match(app.status.textContent, /保存し直さず|もう一度保存せず/);
    assert.equal(app.freshness.textContent, '変更前の一覧');
    await app.context.saveAdminChange(app.save);
    assert.equal(app.requests.length, 1);
    assert.equal(app.confirmations.length, 1);
  });
}

test('正常な保存の番号・日時・所要時間を確認し、返された通知・メモを反映する', async () => {
  for (const duration of [10, 60, 90, 150]) {
    const app = fixture();
    const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    app.context.activeChange.fromEndTime = clock(10 * 60 + duration);
    const reservation = { ...changed(), endTime: clock(14 * 60 + duration), note: '台帳で確認したメモ',
      shopMailStatus: '配送待ち', customerMailStatus: '配送待ち' };
    const saving = app.context.saveAdminChange(app.save);
    await new Promise(resolve => setImmediate(resolve));
    app.finish({ ok: true, reservation, calendarWarning: '連携未確認', notificationsQueued: true });
    await saving;
    assert.equal(app.context.activeChange, null);
    assert.deepEqual(app.applied, [reservation]);
    assert.match(app.freshness.textContent, /日時を保存しました.*カレンダー連携は未確認/);
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].fromTime, original.time);
    assert.equal(app.requests[0].time, '14:00');
  }
});

test('確定した受付拒否と復旧済みは元の予約を保ち、手動だけで別日時を試せる', async () => {
  for (const response of [{ ok: false, taken: true, error: 'その枠は埋まりました' },
    { ok: false, restored: true, error: '変更前の日時へ復旧しました' },
    { ok: false, invalid: true, error: '時刻をご確認ください' }]) {
    const app = fixture();
    const saving = app.context.saveAdminChange(app.save);
    await new Promise(resolve => setImmediate(resolve));
    app.finish(response);
    await saving;
    assert.equal(app.context.activeChange.uncertain, false);
    assert.equal(app.save.disabled, false);
    assert.equal(app.check.hidden, true);
    assert.equal(app.status.textContent, response.error);
    assert.equal(app.requests.length, 1);
    assert.deepEqual(app.context.adminData.reservations, [original]);
  }
});

test('接続が例外でも待ち状態を解放し、入力と結果確認を残して再送しない', async () => {
  const app = fixture();
  app.context.adminPost = async payload => { app.requests.push(payload); throw new Error('架空の接続障害'); };
  await app.context.saveAdminChange(app.save);
  assert.equal(app.context.activeChange.pending, false);
  assert.equal(app.context.activeChange.uncertain, true);
  assert.equal(app.save.disabled, true);
  assert.equal(app.check.disabled, false);
  assert.equal(app.check.hidden, false);
  assert.equal(app.notes[0].disabled, false);
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.applied, []);
});

for (const reason of ['new-dashboard', 'different-change', 'detached']) {
  test(`待機中の${reason}へ古い保存応答を反映しない`, async () => {
    const app = fixture();
    const changing = app.context.activeChange;
    const saving = app.context.saveAdminChange(app.save);
    await new Promise(resolve => setImmediate(resolve));
    if (reason === 'new-dashboard') app.context.dashboardGeneration++;
    if (reason === 'different-change') app.context.activeChange = { ...changing, code: 'LM-NEW' };
    if (reason === 'detached') app.save.isConnected = false;
    app.notes[0].disabled = true;
    const before = JSON.stringify(app.context.adminData);
    app.finish({ ok: true, reservation: changed() });
    await saving;
    assert.equal(JSON.stringify(app.context.adminData), before);
    assert.deepEqual(app.applied, []);
    assert.equal(changing.pending, false);
    assert.equal(app.notes[0].disabled, true, '別画面の入力状態を変更しない');
    assert.equal(app.requests.length, 1);
  });
}

for (const variant of ['correct', 'wrong-end', 'cancelled', 'contradictory', 'old']) {
  test(`結果確認${variant}：変更後の実内容が一致した場合だけ完了する`, async () => {
    const app = fixture();
    app.context.activeChange.date = app.date.value;
    app.context.activeChange.time = app.time.value;
    app.context.activeChange.uncertain = true;
    app.save.disabled = true;
    app.check.hidden = false;
    const reservation = variant === 'old' ? original : { ...changed(),
      ...(variant === 'wrong-end' ? { endTime: '16:00' } : {}),
      ...(variant === 'cancelled' ? { status: 'キャンセル' } : {}) };
    const reading = app.context.checkAdminChange(app.check);
    app.finish({ ok: true, reservations: [reservation], closedDates: [],
      ...(variant === 'contradictory' ? { unknown: true } : {}) });
    await reading;
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].type, 'adminData');
    assert.equal(app.requests[0].reservationsOnly, true);
    assert.equal(app.check.disabled, false);
    if (variant === 'correct') {
      assert.equal(app.context.activeChange, null);
      assert.deepEqual(app.applied, [reservation]);
      assert.match(app.freshness.textContent, /台帳で変更後の日時を確認/);
    } else {
      assert.equal(app.context.activeChange.uncertain, true);
      assert.equal(app.save.disabled, true);
      assert.deepEqual(app.applied, []);
      assert.deepEqual(app.context.adminData.reservations, [original]);
      assert.match(app.status.textContent, /確認|再登録せず/);
    }
  });
}
