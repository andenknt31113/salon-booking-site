import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const functions = ['validReservationRefresh', 'hasPendingReservationDetails', 'loadCustomerDetails', 'loadReservationDetails']
  .map(name => source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))[0]).join('\n');
const PAST = { code: 'LM-HISTORY', date: '2026-09-01', time: '10:00', endTime: '11:00',
  name: '架空のお客様', tel: '09000000000', status: '確定', price: 6900, detailsPending: true };
const OTHER = { ...PAST, code: 'LM-OTHER', tel: '09000000001', name: '別の架空のお客様' };
const READY = { ...PAST, code: 'LM-READY', detailsPending: undefined, note: '保存済み', request: '' };
const complete = row => {
  const result = { ...row, note: '履歴の保存済みメモ', request: '履歴のご要望' };
  delete result.detailsPending;
  return result;
};

function fixture({ rows = [PAST, OTHER, READY], throws = false } = {}) {
  const calls = [];
  const completions = [];
  const renders = [];
  const context = vm.createContext({ Promise, Set, Map, JSON,
    adminData: { reservations: structuredClone(rows), closedDates: [], settings: { label: '保持する設定' } },
    dashboardGeneration: 1, customerDetailsReads: new Map(), customerDetailsErrors: new Map(),
    reservationDetailsRead: null, reservationDetailsError: '',
    activeChange: null, unsaved: false,
    telKey: value => String(value || '').replace(/\D/g, ''),
    hasUnsavedReservationNotes: () => context.unsaved,
    adminPost: payload => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      if (throws) throw Error('架空の接続失敗');
      return new Promise(resolve => completions.push(result => resolve(result ?? { ok: true,
        reservations: rows.filter(row => !payload.reservationCodes || payload.reservationCodes.includes(row.code)).map(complete),
        closedDates: [{ 休業日: '2026-01-01', メモ: '古い休業日' }] })));
    },
    renderReservations: () => renders.push('reservations'), renderCustomers: () => renders.push('customers'),
    renderCustomerDetails: key => renders.push(key), renderStats() {}, renderAdminCalendar() {}, renderNumbers() {},
    showReservationFreshness() {}
  });
  vm.runInContext(functions, context);
  return { context, calls, completions, renders, read: (key = PAST.tel) => context.loadCustomerDetails(key) };
}

test('選んだ電話番号の未取得メモだけを一回読み、件数・他のメモ・休業・設定を保持する', async () => {
  const app = fixture();
  const previousRows = app.context.adminData.reservations;
  const closed = app.context.adminData.closedDates;
  const settings = app.context.adminData.settings;
  const beforeOther = JSON.stringify(previousRows[1]);
  const beforeReady = JSON.stringify(previousRows[2]);
  const first = app.read();
  assert.equal(app.read(), first);
  await Promise.resolve();
  assert.deepEqual(app.calls, [{ type: 'adminData', reservationsOnly: true, reservationCodes: [PAST.code] }]);
  app.completions[0]();
  assert.equal(await first, true);
  assert.equal(app.context.adminData.reservations, previousRows);
  assert.equal(previousRows.length, 3);
  assert.equal(previousRows[0].note, '履歴の保存済みメモ');
  assert.equal(previousRows[0].detailsPending, undefined);
  assert.equal(JSON.stringify(previousRows[1]), beforeOther);
  assert.equal(JSON.stringify(previousRows[2]), beforeReady);
  assert.equal(app.context.adminData.closedDates, closed);
  assert.equal(app.context.adminData.settings, settings);
  assert.equal(app.context.customerDetailsReads.size, 0);
  assert.equal(await app.read(), true);
  assert.equal(app.calls.length, 1);
});

test('同じ電話番号の別名・取消も含め、電話番号のない別予約を混ぜない', async () => {
  const second = { ...PAST, code: 'LM-FAMILY', name: '架空のご家族', status: 'キャンセル' };
  const app = fixture({ rows: [PAST, second, OTHER, { ...OTHER, code: 'LM-NO-TEL', tel: '' }] });
  const pending = app.read();
  await Promise.resolve();
  assert.deepEqual(app.calls[0].reservationCodes, [PAST.code, second.code]);
  app.completions[0]();
  assert.equal(await pending, true);
  assert.equal(app.context.adminData.reservations[1].name, second.name);
  assert.equal(app.context.adminData.reservations[1].status, second.status);
});

for (const [name, result] of [
  ['失敗', { ok: false, error: '架空の接続失敗' }],
  ['欠落', { ok: true, reservations: [], closedDates: [] }],
  ['全量への誤フォールバック', { ok: true, reservations: [complete(PAST), complete(OTHER)], closedDates: [] }],
  ['別の番号', { ok: true, reservations: [complete(OTHER)], closedDates: [] }],
  ['重複', { ok: true, reservations: [complete(PAST), complete(PAST)], closedDates: [] }],
  ['未取得印', { ok: true, reservations: [PAST], closedDates: [] }],
  ['メモ未返却', { ok: true, reservations: [{ ...complete(PAST), note: undefined }], closedDates: [] }],
  ['ご要望未返却', { ok: true, reservations: [{ ...complete(PAST), request: undefined }], closedDates: [] }]
]) {
  test(`${name}の応答を空メモ・成功と扱わず、取得済みの一覧を保持する`, async () => {
    const app = fixture();
    const before = JSON.stringify(app.context.adminData);
    const pending = app.read();
    await Promise.resolve();
    app.completions[0](result);
    assert.equal(await pending, false);
    assert.equal(JSON.stringify(app.context.adminData), before);
    assert.match(app.context.customerDetailsErrors.get(PAST.tel), /確認できません/);
  });
}

for (const field of ['date', 'time', 'status', 'tel', 'name', 'price', 'email', 'menu']) {
  test(`サーバー側で${field}が変わった履歴を古い予定へ混ぜない`, async () => {
    const app = fixture();
    const before = JSON.stringify(app.context.adminData);
    const pending = app.read();
    await Promise.resolve();
    app.completions[0]({ ok: true, reservations: [{ ...complete(PAST), [field]: '架空の変更値' }], closedDates: [] });
    assert.equal(await pending, false);
    assert.equal(JSON.stringify(app.context.adminData), before);
    assert.match(app.context.customerDetailsErrors.get(PAST.tel), /更新を保留/);
  });
}

for (const reason of ['未保存メモ', '日時変更', '対象のメモ保存', '対象の取消', '対象の削除', '予約配列の差替え']) {
  test(`取得中の${reason}を遅い応答で上書きしない`, async () => {
    const app = fixture();
    const pending = app.read();
    await Promise.resolve();
    if (reason === '未保存メモ') app.context.unsaved = true;
    if (reason === '日時変更') app.context.activeChange = { code: PAST.code };
    if (reason === '対象のメモ保存') app.context.adminData.reservations[0].note = '別操作で保存したメモ';
    if (reason === '対象の取消') app.context.adminData.reservations[0].status = 'キャンセル';
    if (reason === '対象の削除') app.context.adminData.reservations.shift();
    if (reason === '予約配列の差替え') app.context.adminData.reservations = structuredClone([PAST, OTHER, READY]);
    const before = JSON.stringify(app.context.adminData);
    app.completions[0]();
    assert.equal(await pending, false);
    assert.equal(JSON.stringify(app.context.adminData), before);
    assert.match(app.context.customerDetailsErrors.get(PAST.tel), /更新を保留/);
  });
}

test('対象外の電話予約追加・メモ保存・休業保存を巻き戻さず、対象の詳細だけを反映する', async () => {
  const app = fixture();
  const pending = app.read();
  await Promise.resolve();
  app.context.adminData.reservations.push({ ...READY, code: 'LM-NEW', tel: OTHER.tel });
  app.context.adminData.reservations[1].note = '別のお客様に保存したメモ';
  app.context.adminData.closedDates = [{ 休業日: '2026-10-10', メモ: '保存した休業日' }];
  const closed = app.context.adminData.closedDates;
  app.completions[0]();
  assert.equal(await pending, true);
  assert.equal(app.context.adminData.reservations.length, 4);
  assert.equal(app.context.adminData.reservations[1].note, '別のお客様に保存したメモ');
  assert.equal(app.context.adminData.closedDates, closed);
});

test('失敗した方だけ再試行でき、別のお客様の取得とエラーは混ざらない', async () => {
  const app = fixture();
  const first = app.read();
  const second = app.read(OTHER.tel);
  await Promise.resolve();
  app.completions[0]({ ok: false });
  app.completions[1]();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.match(app.context.customerDetailsErrors.get(PAST.tel), /確認できません/);
  assert.equal(app.context.customerDetailsErrors.has(OTHER.tel), false);
  const retry = app.read();
  await Promise.resolve();
  assert.equal(app.calls.length, 3);
  app.completions[2]();
  assert.equal(await retry, true);
  assert.equal(app.context.customerDetailsErrors.size, 0);
});

test('再ログイン後へ前の応答・失敗案内・取得状態を持ち越さない', async () => {
  const app = fixture();
  const pending = app.read();
  await Promise.resolve();
  app.context.dashboardGeneration++;
  app.context.customerDetailsReads.clear();
  app.context.customerDetailsErrors.clear();
  const latest = [{ ...READY, note: '再ログイン後のメモ' }];
  app.context.adminData.reservations = latest;
  app.completions[0]();
  assert.equal(await pending, false);
  assert.equal(app.context.adminData.reservations, latest);
  assert.equal(app.context.customerDetailsErrors.size, 0);
  assert.equal(app.context.customerDetailsReads.size, 0);
});

test('同期的な通信例外から再試行でき、未保存入力中は通信しない', async () => {
  const app = fixture({ throws: true });
  assert.equal(await app.read(), false);
  assert.equal(app.context.customerDetailsReads.size, 0);
  assert.equal(app.calls.length, 1);
  app.context.unsaved = true;
  assert.equal(await app.read(), false);
  assert.equal(app.calls.length, 1);
  assert.match(app.context.customerDetailsErrors.get(PAST.tel), /保存または閉じて/);
});

test('顧客の詳細取得が先の場合、全件CSVの取得は完了を待ち正常な読込を競合と扱わない', async () => {
  const app = fixture();
  const customer = app.read();
  const full = app.context.loadReservationDetails();
  await Promise.resolve();
  assert.equal(app.calls.length, 1);
  app.completions[0]();
  assert.equal(await customer, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1].reservationCodes, undefined);
  app.completions[1]();
  assert.equal(await full, true);
  assert.equal(app.context.adminData.reservations.every(row => !row.detailsPending), true);
});

test('全量取得が先の場合、顧客の詳細取得を重ねず結果を再利用する', async () => {
  const app = fixture();
  const full = app.context.loadReservationDetails();
  const customer = app.read();
  await Promise.resolve();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].reservationCodes, undefined);
  app.completions[0]();
  assert.equal(await full, true);
  assert.equal(await customer, true);
  assert.equal(app.calls.length, 1);
});

test('同時取得の待機中に再ログインしたら、旧世代で新しい全量取得を始めない', async () => {
  const app = fixture();
  const customer = app.read();
  const full = app.context.loadReservationDetails();
  await Promise.resolve();
  app.context.dashboardGeneration++;
  app.context.customerDetailsReads.clear();
  app.completions[0]();
  assert.equal(await customer, false);
  assert.equal(await full, false);
  assert.equal(app.calls.length, 1);
});
