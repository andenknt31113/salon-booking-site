import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const ADMIN_SOURCE = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const DATA_SOURCE = readFileSync(new URL('../assets/js/admin-data.js', import.meta.url), 'utf8');
const NOTIFICATIONS_SOURCE = readFileSync(process.env.NOTIFICATIONS_SOURCE || new URL('../assets/js/admin-notifications.js', import.meta.url), 'utf8');
const BOOKING = { code: 'LM-RACE', name: '架空の通知試験', date: '2030-01-05', time: '10:00',
  endTime: '11:00', status: '予約確定', note: '保存済みのメモ', tel: '00000000000', price: 4000,
  menu: '試験カット', staffName: '試験担当', email: '', visit: '', source: '', request: '',
  shopMailStatus: '新規予約：配送待ち', customerMailStatus: '新規予約：配送待ち' };

function fixture() {
  const elements = new Map();
  const timers = new Map();
  let sequence = 0;
  const requests = [];
  const phoneRequestId = 'phone-notification-fixture-0001';
  const stored = new Map([['fixture-phone', phoneRequestId]]);
  const getElement = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: true, textContent: '', innerHTML: '', outerHTML: '', disabled: false, value: '',
      dataset: { pollMs: '60000', mailStatus: BOOKING.code }, listeners: new Map(),
      addEventListener(type, listener) { this.listeners.set(type, listener); }, scrollIntoView() {}
    });
    return elements.get(selector);
  };
  const context = vm.createContext({ Map, Set, Date, JSON,
    $: getElement, $$: selector => selector === '[data-mail-status]' ? [getElement('#mail')] : [],
    esc: value => String(value), isCancelled: row => row.status === 'キャンセル',
    document: { hidden: false, addEventListener() {} }, window: { addEventListener() {} },
    setTimeout: callback => { timers.set(++sequence, callback); return sequence; },
    clearTimeout: identifier => timers.delete(identifier),
    adminData: { reservations: [{ ...BOOKING }], capabilities: { phoneRequestIds: true } }, activeChange: null,
    phonePayload: null, phoneRequestId, phoneUncertain: false, phoneConflict: false,
    phonePriceNeedsInput: false, showPast: false,
    hasUnsavedReservationNotes: () => false,
    toKey: date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'),
    toMinutes: time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)),
    supportsPhoneRetry: () => true, phoneRequestKey: () => 'fixture-phone',
    localStorage: { getItem: key => stored.get(key) ?? null, removeItem: key => stored.delete(key) },
    formatDateJa: date => date, phoneResultState: row => row.status,
    renderStats() {}, onFilterChange() {}, renderCustomers() {}, renderNumbers() {},
    focusBooking() {}, renderReservations() {}, renderAdminCalendar() {},
    adminPost: payload => {
      requests.push(JSON.parse(JSON.stringify(payload)));
      return Promise.resolve({ ok: true, mailStatuses: true, reservations: [{ ...BOOKING }] });
    }
  });
  const names = ['mailNeedsAttention', 'renderMailAlert', 'mailStatusHtml', 'applyMailStatusUpdate',
    'showReservationFreshness', 'showChangedReservation', 'validReservationRefresh',
    'validAdminChangeResponse', 'validPhoneResponse', 'validPhoneBookingResult', 'finishPhoneBooking'];
  const functions = names.map(name => {
    const match = ADMIN_SOURCE.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, `${name} の実装が必要`);
    return match[0];
  }).join('\n');
  vm.runInContext(DATA_SOURCE + '\nconst MAIL_STATUS_MAX_LENGTH = 200;\n' + functions + '\n' + NOTIFICATIONS_SOURCE
    + '\nthis.notifications = AdminNotifications;', context);
  context.notifications.start(context.adminData.reservations);
  return { context, api: context.notifications, getElement, timers, requests,
    begin() {
      let resolve, reject;
      context.adminPost = payload => {
        requests.push(JSON.parse(JSON.stringify(payload)));
        return new Promise((accept, decline) => { resolve = accept; reject = decline; });
      };
      const pending = context.notifications.check();
      return { pending, resolve, reject };
    },
    next(rows) {
      context.adminPost = payload => {
        requests.push(JSON.parse(JSON.stringify(payload)));
        return Promise.resolve({ ok: true, mailStatuses: true, reservations: rows });
      };
      return context.notifications.check();
    }
  };
}

const completed = row => ({ ...row, shopMailStatus: '新規予約：送信処理受付', customerMailStatus: '新規予約：送信処理受付' });

test('予定の再読込後、同じ日時の古い通知で配送完了を配送待ちへ戻さない', async () => {
  const app = fixture();
  const read = app.begin();
  app.context.adminData.reservations = [completed(BOOKING)];
  app.context.showReservationFreshness();
  app.getElement('#mail').outerHTML = '最新の配送表示';
  read.resolve({ ok: true, mailStatuses: true, reservations: [{ ...BOOKING }] });
  await read.pending;
  assert.equal(app.context.adminData.reservations[0].shopMailStatus, '新規予約：送信処理受付');
  assert.equal(app.getElement('#mail').outerHTML, '最新の配送表示');
  assert.doesNotMatch(app.getElement('#notification-status').textContent, /最終確認/);
  assert.equal(app.getElement('#notification-check').disabled, false);
  assert.equal(app.timers.size, 1);
  assert.equal(app.requests.length, 1, '古い応答の破棄だけで自動の追加通信をしない');
  await app.next([completed(BOOKING)]);
  assert.match(app.getElement('#notification-status').textContent, /最終確認/);
  assert.equal(app.getElement('#notification-count').textContent, '未読0件');
});

for (const response of ['success', 'invalid', 'rejected']) {
  test(`新しい予定を取得した後の古い通知${response}で、通知・停止状態を上書きしない`, async () => {
    const app = fixture();
    const cancelled = { ...completed(BOOKING), status: 'キャンセル' };
    await app.next([cancelled]);
    const previousNotice = app.getElement('#notification-list').innerHTML;
    const previousStatus = app.getElement('#notification-status').textContent;
    const read = app.begin();
    app.context.adminData.reservations = [cancelled];
    app.context.showReservationFreshness();
    if (response === 'rejected') read.reject(new Error('架空の古い通信失敗'));
    else read.resolve(response === 'invalid' ? { ok: true, reservations: [{}] }
      : { ok: true, mailStatuses: true, reservations: [{ ...BOOKING }] });
    await read.pending;
    assert.equal(app.getElement('#notification-list').innerHTML, previousNotice);
    assert.equal(app.getElement('#notification-status').textContent, previousStatus);
    assert.equal(app.getElement('#notification-health').hidden, true);
    assert.equal(app.getElement('#notification-count').textContent, '未読1件');
    assert.equal(app.timers.size, 1);
    await app.next([cancelled]);
    assert.equal(app.getElement('#notification-list').innerHTML, previousNotice);
    assert.equal(app.getElement('#notification-count').textContent, '未読1件');
  });
}

test('管理の再読込後に前の通知応答を混ぜず、比較元・未読・イベントを保持する', async () => {
  const app = fixture();
  const added = { ...completed(BOOKING), code: 'LM-NEXT' };
  await app.next([completed(BOOKING), added]);
  const notice = app.getElement('#notification-list').innerHTML;
  const listeners = app.getElement('#notification-check').listeners.size;
  const read = app.begin();
  app.context.adminData.reservations = [completed(BOOKING), added];
  app.api.start(app.context.adminData.reservations);
  read.resolve({ ok: true, mailStatuses: true, reservations: [{ ...BOOKING }] });
  await read.pending;
  assert.equal(app.context.adminData.reservations[0].shopMailStatus, '新規予約：送信処理受付');
  assert.equal(app.getElement('#notification-list').innerHTML, notice);
  assert.equal(app.getElement('#notification-count').textContent, '未読1件');
  assert.equal(app.getElement('#notification-check').listeners.size, listeners);
  await app.next([completed(BOOKING), added]);
  assert.equal(app.getElement('#notification-list').innerHTML, notice, '同じ予約を再度新着にしない');
});

test('日時変更の保存結果の後に、以前の通知を最新として採用しない', async () => {
  const app = fixture();
  const read = app.begin();
  const changed = { ...completed(BOOKING), time: '12:00', endTime: '13:00' };
  app.context.showChangedReservation(changed);
  read.resolve({ ok: true, mailStatuses: true, reservations: [{ ...BOOKING }] });
  await read.pending;
  assert.equal(app.context.adminData.reservations[0], changed);
  assert.doesNotMatch(app.getElement('#notification-status').textContent, /最終確認/);
  await app.next([changed]);
  assert.match(app.getElement('#notification-list').innerHTML, /日時変更/);
  assert.match(app.getElement('#notification-list').innerHTML, /12:00/);
  assert.equal(app.getElement('#notification-count').textContent, '未読1件');
});

for (const existing of [false, true]) {
  test(`電話受付の${existing ? '前の結果の確認' : '新規保存'}後に古い通知を反映しない`, async () => {
    const app = fixture();
    const read = app.begin();
    const phone = { ...completed(BOOKING), code: existing ? BOOKING.code : 'LM-PHONE', visit: '電話・来店' };
    app.context.finishPhoneBooking({ ok: true, requestId: app.context.phoneRequestId,
      code: phone.code, endTime: phone.endTime, reservation: phone, duplicate: existing });
    read.resolve({ ok: true, mailStatuses: true, reservations: [{ ...BOOKING }] });
    await read.pending;
    assert.equal(app.context.adminData.reservations.find(row => row.code === phone.code).shopMailStatus, '新規予約：送信処理受付');
    assert.doesNotMatch(app.getElement('#notification-status').textContent, /最終確認/);
    assert.match(app.getElement('#add-result').textContent, /台帳に入れました|登録結果を確認しました/);
    await app.next(existing ? [phone] : [{ ...BOOKING }, phone]);
    assert.equal(app.getElement('#notification-count').textContent, existing ? '未読0件' : '未読1件');
  });
}

test('読込や保存のない通常の通知は配送表示だけを更新し、入力・日時を保持する', async () => {
  const app = fixture();
  const original = app.context.adminData.reservations[0];
  await app.next([{ ...completed(BOOKING), note: 'サーバーの別メモ' }]);
  assert.equal(app.context.adminData.reservations[0], original);
  assert.equal(original.note, BOOKING.note);
  assert.equal(original.time, BOOKING.time);
  assert.equal(original.shopMailStatus, '新規予約：送信処理受付');
  assert.match(app.getElement('#mail').outerHTML, /送信処理受付/);
  assert.match(app.getElement('#notification-status').textContent, /最終確認/);
});

test('古い通信の破棄でも確認ボタンを解放し、停止中の自動確認を勝手に再開しない', async () => {
  const app = fixture();
  const failure = app.begin();
  failure.resolve({ ok: false });
  await failure.pending;
  const stoppedStatus = app.getElement('#notification-status').textContent;
  const read = app.begin();
  app.context.adminData.reservations = [completed(BOOKING)];
  app.context.showReservationFreshness();
  read.resolve({ ok: true, mailStatuses: true, reservations: [{ ...BOOKING }] });
  await read.pending;
  assert.equal(app.getElement('#notification-health').hidden, false);
  assert.equal(app.getElement('#notification-status').textContent, stoppedStatus);
  assert.equal(app.timers.size, 0);
  assert.equal(app.getElement('#notification-check').disabled, false);
  await app.next([completed(BOOKING)]);
  assert.equal(app.getElement('#notification-health').hidden, true);
  assert.equal(app.timers.size, 1);
});
