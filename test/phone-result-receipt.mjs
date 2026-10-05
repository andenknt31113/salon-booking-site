import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const dataSource = readFileSync(new URL('../assets/js/admin-data.js', import.meta.url), 'utf8');
const requestId = 'phone-receipt-fixture-0001';
const payload = { type: 'adminAdd', requestId, date: '2030-01-05', time: '10:00', minutes: 60,
  price: 4000, name: '架空の電話受付客', tel: '00000000000', menu: '試験カット', memo: '保持する入力' };
const reservation = { code: 'LM-PHONE', date: payload.date, time: payload.time, endTime: '11:00',
  price: payload.price, name: payload.name, tel: payload.tel, menu: payload.menu,
  staffName: '試験担当', email: '', visit: '電話・来店', source: '電話・来店',
  request: payload.memo, note: '', status: '予約確定' };
const receipt = () => ({ ok: true, requestId, code: reservation.code, endTime: reservation.endTime,
  duplicate: false, reservation: structuredClone(reservation) });

function fixture() {
  const elements = Object.fromEntries(['fields', 'save', 'cancel', 'check', 'error', 'recovery',
    'date', 'time', 'name', 'tel', 'minutes', 'price', 'menu', 'memo', 'menu-hint', 'customer']
    .map(key => ['#ab-' + key, { value: String(payload[key] ?? ''), textContent: '', hidden: false,
      disabled: false, style: {}, scrollIntoView() {} }]));
  Object.assign(elements, { '#filter-date': { value: payload.date }, '#filter-status': { value: 'all' },
    '#add-booking-form': { hidden: false }, '#add-result': { hidden: true, dataset: {}, scrollIntoView() {} } });
  const operations = [];
  const confirmations = [];
  const stored = new Map([['fixture-key', requestId]]);
  let resolveResponse;
  let rejectResponse;
  const context = vm.createContext({ phoneRequestId: requestId, phonePayload: structuredClone(payload),
    phoneSubmitting: false, phoneUncertain: false, phoneConflict: false, phonePriceNeedsInput: false,
    adminData: { reservations: [], closedDates: [], capabilities: { phoneRequestIds: true } },
    MINUTES_PER_DAY: 1440, showPast: false, crypto: { randomUUID: () => requestId },
    $: selector => elements[selector],
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value),
      removeItem: key => stored.delete(key) },
    phoneRequestKey: () => 'fixture-key',
    toHalfWidth: value => String(value), normalizeTel: value => value,
    toMinutes: value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)),
    toKey: date => date.toISOString().slice(0, 10), formatDateJa: value => value,
    isCancelled: row => row.status === 'キャンセル',
    showAddError: message => { elements['#ab-error'].textContent = message; },
    confirm: message => { confirmations.push(message); return true; },
    adminPost: operation => {
      operations.push(structuredClone(operation));
      return new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    },
    AdminNotifications: { invalidate() {} },
    hasUnsavedReservationNotes: () => false,
    renderStats() {}, renderReservations() {}, renderCustomers() {}, renderAdminCalendar() {},
    phoneResultState: row => JSON.stringify([row.date, row.time, row.endTime, row.status])
  });
  vm.runInContext(dataSource, context);
  for (const name of ['validReservationRefresh', 'validAdminChangeResponse', 'validPhoneResponse',
    'validPhoneBookingResult', 'setPhoneBusy', 'numberOf',
    'checkPhoneResult', 'saveAddBooking', 'finishPhoneBooking']) {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    if (match) vm.runInContext(match[0], context);
    else assert.ok(['validPhoneResponse', 'validPhoneBookingResult'].includes(name), name);
  }
  context.supportsPhoneRetry = () => context.adminData.capabilities.phoneRequestIds === true;
  return { context, elements, stored, operations, confirmations,
    finish: value => {
      assert.equal(typeof resolveResponse, 'function', elements['#ab-error'].textContent);
      resolveResponse(value);
    }, reject: () => rejectResponse(new Error('架空の応答切断')) };
}

const invalidReceipts = [
  { ...receipt(), unknown: true }, { ...receipt(), transportError: true },
  { ...receipt(), requestConflict: true }, { ...receipt(), confirm: true },
  { ...receipt(), error: '結果未確認' }, { ...receipt(), duplicate: 'false' },
  { ...receipt(), code: 'LM-OTHER' }, { ...receipt(), endTime: '12:00' },
  { ...receipt(), reservation: { code: reservation.code } },
  ...['date', 'time', 'endTime', 'price'].map(field => ({ ...receipt(),
    reservation: { ...reservation, [field]: ({ date: '2030-01-06', time: '11:00', endTime: '12:00', price: 8000 })[field] } })),
  ...['name', 'note', 'request', 'email'].map(field => {
    const result = receipt();
    delete result.reservation[field];
    return result;
  })
];

for (const [index, response] of invalidReceipts.entries()) {
  test(`電話受付の不完全な応答${index + 1}で完了せず、入力・受付ID・一覧を保持する`, async () => {
    const app = fixture();
    const before = JSON.stringify(app.context.adminData);
    const saving = app.context.saveAddBooking();
    app.finish(response);
    await saving;
    assert.equal(app.elements['#add-result'].hidden, true);
    assert.equal(app.elements['#add-booking-form'].hidden, false);
    assert.equal(app.context.phoneUncertain, true);
    assert.equal(app.context.phoneSubmitting, false);
    assert.equal(app.context.phoneRequestId, requestId);
    assert.equal(app.stored.get('fixture-key'), requestId);
    assert.equal(JSON.stringify(app.context.adminData), before);
    assert.equal(app.elements['#ab-fields'].disabled, true);
    assert.equal(app.elements['#ab-check'].disabled, false);
    assert.equal(app.operations.length, 1);
    assert.deepEqual(app.confirmations, []);
    for (const field of ['date', 'time', 'name', 'tel', 'minutes', 'price', 'menu', 'memo']) {
      assert.equal(app.elements['#ab-' + field].value, String(payload[field]));
    }
  });
}

const invalidChecks = [null, {}, { ok: true, requestId },
  { ok: true, requestId, found: 'false' }, { ok: true, requestId, found: false, unknown: true },
  { ok: true, requestId, found: false, duplicate: true },
  { ...receipt(), found: false },
  ...invalidReceipts.slice(0, 9).map(result => ({ ...result, found: true,
    duplicate: typeof result.duplicate === 'boolean' ? true : result.duplicate })),
  { ...receipt(), found: true, duplicate: true, reservation: { ...reservation, date: '2030-02-30' } },
  { ...receipt(), found: true, duplicate: true, reservation: { ...reservation, endTime: '24:00' } }
];

for (const [index, response] of invalidChecks.entries()) {
  test(`電話受付の不完全な照会${index + 1}で未登録・登録済みと決めず控えを保持する`, async () => {
    const app = fixture();
    app.context.phoneUncertain = true;
    const checking = app.context.checkPhoneResult();
    app.finish(response);
    await checking;
    assert.equal(app.elements['#add-result'].hidden, true);
    assert.equal(app.context.phoneUncertain, true);
    assert.equal(app.context.phoneRequestId, requestId);
    assert.equal(app.stored.get('fixture-key'), requestId);
    assert.equal(app.context.adminData.reservations.length, 0);
    assert.equal(app.context.phoneSubmitting, false);
    assert.equal(app.elements['#ab-fields'].disabled, true);
    assert.equal(app.elements['#ab-check'].disabled, false);
    assert.deepEqual(app.operations, [{ type: 'adminAddStatus', requestId }]);
  });
}

test('電話受付の照会例外を画面で処理し、同じIDで手動確認を残す', async () => {
  const app = fixture();
  app.context.phoneUncertain = true;
  const checking = app.context.checkPhoneResult();
  app.reject();
  await checking;
  assert.equal(app.context.phoneUncertain, true);
  assert.equal(app.context.phoneSubmitting, false);
  assert.equal(app.stored.get('fixture-key'), requestId);
  assert.equal(app.elements['#ab-check'].disabled, false);
  assert.match(app.elements['#ab-error'].textContent, /確認できません/);
  assert.equal(app.operations.length, 1);
});

test('確定した重複時間の確認だけは了承後に同じ受付IDで登録する', async () => {
  const app = fixture();
  const saving = app.context.saveAddBooking();
  app.finish({ ok: false, confirm: true, error: '同じ時間に別の予約があります。' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.operations.length, 2);
  assert.equal(app.operations[1].requestId, requestId);
  assert.equal(app.operations[1].force, true);
  assert.equal(app.confirmations.length, 1);
  app.finish(receipt());
  await saving;
  assert.equal(app.elements['#add-result'].hidden, false);
  assert.equal(app.context.phoneSubmitting, false);
});

test('結果不明と確認要求が混ざる応答を強制登録で送り直さない', async () => {
  const app = fixture();
  const saving = app.context.saveAddBooking();
  app.finish({ ok: false, confirm: true, unknown: true, error: '結果未確認です。' });
  await new Promise(resolve => setImmediate(resolve));
  if (app.operations.length > 1) app.finish(receipt());
  await saving;
  assert.equal(app.operations.length, 1);
  assert.deepEqual(app.confirmations, []);
  assert.equal(app.context.phoneUncertain, true);
  assert.equal(app.stored.get('fixture-key'), requestId);
  assert.equal(app.elements['#add-result'].hidden, true);
});

for (const scenario of ['new', 'duplicate', 'changed', 'cancelled', 'legacy', 'unwritten', 'rejected']) {
  test(`電話受付の正常な${scenario}応答の従来動作を維持する`, async () => {
    const app = fixture();
    let response = receipt();
    const checking = ['changed', 'cancelled', 'unwritten'].includes(scenario);
    if (scenario === 'legacy') {
      app.context.adminData.capabilities.phoneRequestIds = false;
      response = { ok: true, code: reservation.code, endTime: reservation.endTime };
    }
    if (scenario === 'duplicate') response.duplicate = true;
    if (checking) Object.assign(response, { found: true, duplicate: true });
    if (scenario === 'changed') Object.assign(response.reservation, { date: '2030-01-06', time: '12:00', endTime: '13:00' });
    if (scenario === 'cancelled') response.reservation.status = 'キャンセル';
    if (scenario === 'unwritten') response = { ok: true, requestId, found: false };
    if (scenario === 'rejected') response = { ok: false, error: '予約台帳を確認できません。' };
    if (scenario === 'changed') response.endTime = '13:00';
    const pending = checking ? app.context.checkPhoneResult() : app.context.saveAddBooking();
    app.finish(response);
    await pending;
    assert.equal(app.context.phoneSubmitting, false);
    assert.equal(app.operations.length, 1);
    if (['unwritten', 'rejected'].includes(scenario)) {
      assert.equal(app.elements['#add-result'].hidden, true);
      assert.equal(app.context.phoneUncertain, false);
      assert.equal(app.elements['#ab-fields'].disabled, false);
      assert.equal(app.stored.get('fixture-key'), requestId);
    } else {
      assert.equal(app.elements['#add-result'].hidden, false);
      assert.equal(app.elements['#add-booking-form'].hidden, true);
      assert.equal(app.context.adminData.reservations.length, 1);
      assert.equal(app.context.phoneRequestId, '');
      assert.equal(app.stored.has('fixture-key'), false);
      if (scenario === 'cancelled') assert.match(app.elements['#add-result'].textContent, /キャンセル済み/);
    }
  });
}
