import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.NOTIFICATIONS_SOURCE || new URL('../assets/js/admin-notifications.js', import.meta.url), 'utf8');
const RESERVATION = { code: 'LM-HEALTH', name: '架空 通知確認', date: '2030-01-05',
  time: '10:00', endTime: '11:00', status: '予約確定' };

function fixture({ missingHealth = false } = {}) {
  const elements = new Map();
  const getElement = selector => {
    if (missingHealth && selector === '#notification-health') return null;
    if (!elements.has(selector)) elements.set(selector, { hidden: true, textContent: '',
      innerHTML: '', disabled: false, dataset: { pollMs: '60000' }, addEventListener() {} });
    return elements.get(selector);
  };
  let scheduled = 0;
  const context = vm.createContext({ Map, Date,
    $: getElement, esc: value => String(value), isCancelled: row => row.status === 'キャンセル',
    document: { hidden: false, addEventListener() {} }, window: { addEventListener() {} },
    setTimeout: () => { scheduled++; return scheduled; }, clearTimeout() {},
    adminPost: async () => ({ ok: true, reservations: [RESERVATION] }),
    applyMailStatusUpdate: () => false });
  const notices = vm.runInContext(SOURCE + '\nAdminNotifications', context);
  notices.start([RESERVATION]);
  return { context, notices, getElement, scheduled: () => scheduled };
}

test('通信停止を閉じたベルの表示にも知らせ、既存の通知と操作を残す', async () => {
  const app = fixture();
  await app.notices.check();
  const previous = app.getElement('#notification-list').innerHTML;
  const scheduled = app.scheduled();
  app.context.adminPost = async () => { throw new Error('架空の通信停止'); };
  await app.notices.check();
  assert.equal(app.getElement('#notification-health').hidden, false);
  assert.equal(app.getElement('#notification-health').textContent, '自動確認停止');
  assert.match(app.getElement('#notification-status').textContent, /最新とは限りません/);
  assert.equal(app.getElement('#notification-list').innerHTML, previous);
  assert.equal(app.getElement('#notification-check').disabled, false);
  assert.equal(app.scheduled(), scheduled, '失敗後は自動の通信を続けない');
});

test('壊れた配送状態を正常な通知にせず、再確認の成功時だけ停止表示を解除する', async () => {
  const app = fixture();
  app.context.adminPost = async () => ({ ok: true, reservations: [RESERVATION], mailStatuses: true });
  await app.notices.check();
  assert.equal(app.getElement('#notification-health').hidden, false);
  app.context.applyMailStatusUpdate = () => true;
  await app.notices.check();
  assert.equal(app.getElement('#notification-health').hidden, true);
  assert.equal(app.getElement('#notification-health').textContent, '');
  assert.match(app.getElement('#notification-status').textContent, /最終確認/);
});

test('切替中の古いHTMLでも、通知の成功・停止確認を例外で妨げない', async () => {
  const app = fixture({ missingHealth: true });
  await app.notices.check();
  assert.match(app.getElement('#notification-status').textContent, /最終確認/);
  app.context.adminPost = async () => ({ ok: false });
  await app.notices.check();
  assert.match(app.getElement('#notification-status').textContent, /自動確認を停止/);
});
