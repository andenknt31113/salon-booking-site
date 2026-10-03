import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const dataSource = readFileSync(new URL('../assets/js/admin-data.js', import.meta.url), 'utf8');
const functions = ['validReservationRefresh', 'hasPendingReservationDetails', 'reservationDetailsMessage', 'loadReservationDetails',
  'loadReservationDateDetails', 'sameSelectedReservationSnapshot', 'loadSelectedReservationDetails']
  .map(name => {
    const definition = source.match(new RegExp(`function ${name}\\([^]*?\\n}`))?.[0];
    assert.ok(definition, `${name} が必要です`);
    return definition;
  }).join('\n');
const actions = ['exportCsv', 'focusBooking'].map(name => {
  const definition = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))?.[0];
  assert.ok(definition, `${name} が必要です`);
  return definition;
}).join('\n');

const PAST = { code: 'LM-HISTORY', date: '2026-09-01', time: '10:00', endTime: '11:00',
  name: '架空のお客様', tel: '09000000000', status: '確定', price: 6900, detailsPending: true };
const TODAY = { ...PAST, code: 'LM-TODAY', date: '2026-10-03', detailsPending: undefined,
  note: '今日の保存済みメモ', request: '今日のご要望' };

function complete(row) {
  const result = { ...row, note: '履歴の保存済みメモ', request: '履歴のご要望' };
  delete result.detailsPending;
  return result;
}

function fixture(rows = [PAST, TODAY], { throws = false } = {}) {
  const requests = [];
  const nodes = { '#reservation-freshness': { textContent: '' }, '#filter-date': { value: '' } };
  let resolveRead;
  const pending = new Promise(resolve => { resolveRead = resolve; });
  const context = vm.createContext({ Promise, Set, JSON,
    adminData: { reservations: structuredClone(rows), closedDates: [], settings: { label: '保持する設定' } },
    reservationDetailsRead: null, reservationDetailsError: '', dashboardGeneration: 1,
    scopedDetailsReads: new Map(), scopedDetailsErrors: new Map(),
    activeChange: null, unsaved: false, pendingBookingFocus: null,
    showPast: false, toKey: () => '2026-10-03',
    hasUnsavedReservationNotes: () => context.unsaved,
    adminPost: payload => {
      requests.push(JSON.parse(JSON.stringify(payload)));
      if (throws) throw new Error('架空の接続失敗');
      return pending;
    },
    $: selector => nodes[selector], esc: value => String(value),
    renderStats() {}, renderReservations() {}, renderAdminCalendar() {}, renderCustomers() {}, renderNumbers() {},
    renderSelectedReservationDetails() {}, renderCustomerDetails() {}, telKey: value => String(value),
    showReservationFreshness() {}
  });
  vm.runInContext(dataSource + '\n' + functions, context);
  return { context, requests, read: () => context.loadReservationDetails(),
    finish: result => resolveRead(result ?? { ok: true, reservations: rows.map(complete), closedDates: [] }) };
}

test('詳細が揃っている場合は余分な通信をしない', async () => {
  const app = fixture([complete(PAST), TODAY]);
  assert.equal(await app.read(), true);
  assert.deepEqual(app.requests, []);
});

test('同時の取得を一回にまとめ、全量のメモと件数を戻し、他の編集設定は保持する', async () => {
  const app = fixture();
  const settings = app.context.adminData.settings;
  const first = app.read();
  assert.equal(app.read(), first);
  await Promise.resolve();
  assert.deepEqual(app.requests, [{ type: 'adminData', reservationsOnly: true }]);
  app.finish();
  assert.equal(await first, true);
  assert.equal(app.context.adminData.reservations.length, 2);
  assert.equal(app.context.adminData.reservations[0].note, '履歴の保存済みメモ');
  assert.equal(app.context.adminData.settings, settings);
  assert.equal(app.context.reservationDetailsRead, null);
});

for (const [name, reservations] of [
  ['空の応答', []], ['一行欠落', [complete(TODAY)]],
  ['番号重複', [complete(PAST), complete(PAST)]],
  ['未取得印が残る応答', [PAST, TODAY]],
  ['メモが欠ける応答', [{ ...complete(PAST), note: undefined }, TODAY]],
  ['ご要望が欠ける応答', [{ ...complete(PAST), request: undefined }, TODAY]],
  ['印が不正な応答', [{ ...complete(PAST), detailsPending: 'yes' }, TODAY]]
]) {
  test(`${name}を全件取得として扱わず、元の件数・情報を保つ`, async () => {
    const app = fixture();
    const previous = app.context.adminData.reservations;
    const pending = app.read();
    app.finish({ ok: true, reservations, closedDates: [] });
    assert.equal(await pending, false);
    assert.equal(app.context.adminData.reservations, previous);
    assert.equal(app.context.adminData.reservations.length, 2);
    assert.equal(app.context.adminData.reservations[0].detailsPending, true);
    assert.match(app.context.reservationDetailsError, /確認できません/);
  });
}

test('読込開始前の書きかけメモを守り、通信せず保存を案内する', async () => {
  const app = fixture();
  app.context.unsaved = true;
  assert.equal(await app.read(), false);
  assert.deepEqual(app.requests, []);
  assert.match(app.context.reservationDetailsError, /保存または閉じて/);
});

for (const reason of ['未保存メモ', '日時変更', '同じ配列への電話予約追加', '保存済みメモ更新', '予約配列の入替']) {
  test(`通信中の${reason}を遅い履歴取得で上書きしない`, async () => {
    const app = fixture();
    const pending = app.read();
    await Promise.resolve();
    if (reason === '未保存メモ') app.context.unsaved = true;
    if (reason === '日時変更') app.context.activeChange = { code: TODAY.code };
    if (reason === '同じ配列への電話予約追加') app.context.adminData.reservations.push({ ...TODAY, code: 'LM-PHONE' });
    if (reason === '保存済みメモ更新') app.context.adminData.reservations[1].note = '別操作で保存したメモ';
    if (reason === '予約配列の入替') app.context.adminData.reservations = structuredClone([PAST, TODAY]);
    const snapshot = JSON.stringify(app.context.adminData.reservations);
    app.finish();
    assert.equal(await pending, false);
    assert.equal(JSON.stringify(app.context.adminData.reservations), snapshot);
    assert.match(app.context.reservationDetailsError, /更新を保留/);
  });
}

for (const reason of ['同じ配列への休業追加', '保存後の休業配列の入替']) {
  test(`通信中の${reason}を遅い履歴応答で上書きしない`, async () => {
    const app = fixture();
    const pending = app.read();
    await Promise.resolve();
    const saved = { 休業日: '2026-10-04', 開始: '', 終了: '', メモ: '保存した休業' };
    if (reason === '同じ配列への休業追加') app.context.adminData.closedDates.push(saved);
    else app.context.adminData.closedDates = [saved];
    const snapshot = JSON.stringify(app.context.adminData.closedDates);
    app.finish();
    assert.equal(await pending, false);
    assert.equal(JSON.stringify(app.context.adminData.closedDates), snapshot);
    assert.equal(app.context.adminData.reservations[0].detailsPending, true);
    assert.match(app.context.reservationDetailsError, /更新を保留/);
  });
}

for (const action of ['CSV出力', 'カレンダーから詳細表示']) {
  test(`履歴取得に失敗した${action}は見える警告を出し、同じ操作で再試行できる`, async () => {
    const app = fixture(undefined, { throws: true });
    const alerts = [];
    app.context.alert = message => alerts.push(message);
    app.context.filteredReservations = () => app.context.adminData.reservations;
    vm.runInContext(actions, app.context);
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (action === 'CSV出力') await app.context.exportCsv();
      else {
        app.context.focusBooking(PAST.code);
        await app.context.scopedDetailsReads.get('date:' + PAST.date);
        await Promise.resolve();
      }
      assert.equal(alerts.length, attempt);
      assert.match(alerts.at(-1), /履歴.*確認できません.*もう一度/);
      assert.equal(app.requests.length, attempt);
      assert.equal(app.context.adminData.reservations[0].detailsPending, true);
    }
  });

  test(`再ログイン後に前の${action}の失敗警告やダウンロードを出さない`, async () => {
    const app = fixture();
    const alerts = [];
    app.context.alert = message => alerts.push(message);
    app.context.filteredReservations = () => app.context.adminData.reservations;
    vm.runInContext(actions, app.context);
    const actionResult = action === 'CSV出力' ? app.context.exportCsv() : app.context.focusBooking(PAST.code);
    const pending = action === 'CSV出力' ? app.context.reservationDetailsRead
      : app.context.scopedDetailsReads.get('date:' + PAST.date);
    app.context.dashboardGeneration++;
    app.finish();
    await pending;
    await actionResult;
    await Promise.resolve();
    assert.deepEqual(alerts, []);
    assert.equal(app.context.adminData.reservations[0].detailsPending, true);
  });
}

test('再ログイン後のデータに前のログインの遅い応答を混ぜない', async () => {
  const app = fixture();
  const pending = app.read();
  await Promise.resolve();
  app.context.dashboardGeneration++;
  const latest = [{ ...TODAY, note: '再ログイン後のメモ' }];
  app.context.adminData.reservations = latest;
  app.finish();
  assert.equal(await pending, false);
  assert.equal(app.context.adminData.reservations, latest);
  assert.equal(app.context.reservationDetailsError, '');
});

test('接続処理が同期的に失敗しても、未取得を空欄のメモと扱わず再試行できる', async () => {
  const app = fixture(undefined, { throws: true });
  assert.equal(await app.read(), false);
  assert.equal(app.context.reservationDetailsRead, null);
  assert.equal(app.context.adminData.reservations[0].detailsPending, true);
  assert.match(app.context.reservationDetailsMessage(), /data-retry-history/);
});

test('既存番号を保持した最新の全量応答なら、新しい予約も含めて整合した件数へ更新する', async () => {
  const app = fixture();
  const pending = app.read();
  app.finish({ ok: true, reservations: [complete(PAST), complete(TODAY), complete({ ...TODAY, code: 'LM-NEW' })], closedDates: [] });
  assert.equal(await pending, true);
  assert.equal(app.context.adminData.reservations.length, 3);
});
