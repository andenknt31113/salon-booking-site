import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.NOTIFICATIONS_SOURCE || new URL('../assets/js/admin-notifications.js', import.meta.url), 'utf8');
const EXISTING = { code: 'FINAL-EXISTING', name: '架空の既存予約', date: '2030-01-05',
  time: '10:00', endTime: '11:00', status: '予約確定' };
const ADDED = { ...EXISTING, code: 'FINAL-ADDED', name: '架空の通知予約', time: '12:00', endTime: '13:00' };

function fixture() {
  const elements = new Map();
  const timers = new Map();
  const requests = [];
  const focused = [];
  let timerSequence = 0;
  let refreshCount = 0;
  const getElement = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: true, textContent: '', innerHTML: '', disabled: false, open: true,
      dataset: { pollMs: '60000' }, listeners: new Map(),
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      click() {}
    });
    return elements.get(selector);
  };
  const context = vm.createContext({ Map, Date,
    $: getElement,
    esc: value => String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]),
    isCancelled: row => row.status === 'キャンセル',
    document: { hidden: false, addEventListener() {} },
    window: { addEventListener() {} },
    setTimeout: callback => { timers.set(++timerSequence, callback); return timerSequence; },
    clearTimeout: identifier => timers.delete(identifier),
    adminPost: async payload => { requests.push({ ...payload }); return { ok: true, reservations: [EXISTING, ADDED] }; },
    applyMailStatusUpdate: () => true,
    hasUnsavedReservationNotes: () => false,
    refreshReservations: async () => { refreshCount++; return true; },
    adminData: { reservations: [EXISTING, ADDED] },
    focusBooking: code => focused.push(code)
  });
  const api = vm.runInContext(SOURCE + '\nAdminNotifications', context);
  api.start([EXISTING]);
  return { api, context, getElement, timers, requests, focused,
    refreshCount: () => refreshCount,
    open: code => getElement('#notification-list').listeners.get('click')({
      target: { closest: () => ({ dataset: { notification: code } }) }
    }) };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('初回を新着にせず、新規・変更・取消の差分とHTMLエスケープを保つ', async () => {
  const app = fixture();
  assert.equal(app.getElement('#notification-count').textContent, '未読0件');
  await app.api.check();
  assert.equal(app.getElement('#notification-count').textContent, '未読1件');
  assert.match(app.getElement('#notification-list').innerHTML, /新しい予約/);
  await app.api.check();
  assert.equal(app.getElement('#notification-count').textContent, '未読1件');
  app.context.adminPost = async () => ({ ok: true, reservations: [EXISTING,
    { ...ADDED, name: '<img src=x onerror=alert(1)>', time: '14:00', endTime: '15:00' }] });
  await app.api.check();
  assert.match(app.getElement('#notification-list').innerHTML, /日時変更/);
  assert.match(app.getElement('#notification-list').innerHTML, /&lt;img/);
  assert.doesNotMatch(app.getElement('#notification-list').innerHTML, /<img/);
  app.context.adminPost = async () => ({ ok: true, reservations: [EXISTING, { ...ADDED, status: 'キャンセル' }] });
  await app.api.check();
  assert.match(app.getElement('#notification-list').innerHTML, /キャンセル/);
});

for (const rejected of [null, { ok: false, transportError: true }, { ok: false, error: '架空の認証拒否' }]) {
  test(`通信失敗と認証拒否 ${JSON.stringify(rejected)} で通知と比較元を更新しない`, async () => {
    const app = fixture();
    await app.api.check();
    const before = app.getElement('#notification-list').innerHTML;
    app.context.adminPost = async () => rejected;
    await app.api.check();
    assert.equal(app.getElement('#notification-health').hidden, false);
    assert.equal(app.getElement('#notification-list').innerHTML, before);
    assert.equal(app.getElement('#notification-count').textContent, '未読1件');
    assert.equal(app.getElement('#notification-check').disabled, false);
    assert.equal(app.timers.size, 0);
    app.context.adminPost = async () => ({ ok: true, reservations: [EXISTING, ADDED] });
    await app.api.check();
    assert.equal(app.getElement('#notification-health').hidden, true);
    assert.equal(app.getElement('#notification-list').innerHTML, before);
    assert.equal(app.getElement('#notification-count').textContent, '未読1件');
    assert.equal(app.timers.size, 1);
  });
}

test('通知通信の連打と非表示で追加通信や台帳書込を行わない', async () => {
  const app = fixture();
  let release;
  app.context.adminPost = payload => {
    app.requests.push({ ...payload });
    return new Promise(resolve => { release = resolve; });
  };
  const pending = app.api.check();
  await app.api.check();
  assert.equal(app.requests.length, 1);
  assert.equal(app.getElement('#notification-check').disabled, true);
  release({ ok: true, reservations: [EXISTING, ADDED] });
  await pending;
  app.context.document.hidden = true;
  await app.api.check();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].type, 'adminData');
  assert.equal(app.requests[0].notificationsOnly, true);
});

test('書きかけのメモがあると通知を開かず、保存中の入力も未読も保持する', async () => {
  const app = fixture();
  await app.api.check();
  app.context.hasUnsavedReservationNotes = () => true;
  app.open(ADDED.code);
  await settle();
  assert.equal(app.refreshCount(), 0);
  assert.deepEqual(app.focused, []);
  assert.equal(app.getElement('#notification-count').textContent, '未読1件');
  assert.match(app.getElement('#notification-status').textContent, /施術メモ/);
});

test('予定の取得失敗と取得中のメモ入力を確認済みにしない', async () => {
  for (const refreshed of [false, true]) {
    const app = fixture();
    await app.api.check();
    app.context.refreshReservations = async () => {
      app.context.hasUnsavedReservationNotes = () => refreshed;
      return refreshed;
    };
    app.open(ADDED.code);
    await settle();
    assert.deepEqual(app.focused, []);
    assert.equal(app.getElement('#notification-count').textContent, '未読1件');
    assert.equal(app.getElement('#booking-notifications').open, true);
  }
});

test('別の通知が取得中に届いたときは、新しい通知を既読にしない', async () => {
  const app = fixture();
  await app.api.check();
  let release;
  app.context.refreshReservations = () => new Promise(resolve => { release = resolve; });
  app.open(ADDED.code);
  app.open(ADDED.code);
  app.context.adminPost = async () => ({ ok: true, reservations: [EXISTING,
    { ...ADDED, time: '14:00', endTime: '15:00' }] });
  await app.api.check();
  release(true);
  await settle();
  assert.deepEqual(app.focused, [ADDED.code]);
  assert.equal(app.getElement('#notification-count').textContent, '未読1件');
  assert.match(app.getElement('#notification-list').innerHTML, /未読：日時変更/);
});

test('台帳にない予約は既読にせず、存在する対象だけを開く', async () => {
  const app = fixture();
  await app.api.check();
  app.context.adminData.reservations = [EXISTING];
  app.open(ADDED.code);
  await settle();
  assert.deepEqual(app.focused, []);
  assert.equal(app.getElement('#notification-count').textContent, '未読1件');
  assert.match(app.getElement('#notification-status').textContent, /見つかりません/);
  app.context.adminData.reservations.push(ADDED);
  app.open(ADDED.code);
  await settle();
  assert.deepEqual(app.focused, [ADDED.code]);
  assert.equal(app.getElement('#notification-count').textContent, '未読0件');
  assert.equal(app.getElement('#booking-notifications').open, false);
});
