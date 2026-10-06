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

const INVALID_RESPONSES = [
  ['結果なし', null], ['成功値なし', {}], ['拒否', { ok: false }],
  ['数値ゼロ', { ok: 0 }], ['数値一', { ok: 1 }],
  ['文字のfalse', { ok: 'false' }], ['文字のtrue', { ok: 'true' }],
  ['成功とエラー', { ok: true, error: '架空の読込障害' }],
  ...['transportError', 'unknown', 'stale'].flatMap(field => [
    [`成功と${field}`, { ok: true, [field]: true }],
    [`文字の${field}`, { ok: true, [field]: 'false' }]
  ]),
  ['文字の配送指定', { ok: true, mailStatuses: 'true' }],
  ['数値の配送指定', { ok: true, mailStatuses: 1 }]
];

for (const [label, response] of INVALID_RESPONSES) {
  test(`${label}を正常な通知にせず、未読・比較元・配送表示を保って再確認できる`, async () => {
    const app = fixture();
    const added = { ...RESERVATION, code: 'LM-HEALTH-ADDED', name: '架空の新着' };
    app.context.adminPost = async () => ({ ok: true, reservations: [RESERVATION, added] });
    await app.notices.check();
    const before = app.getElement('#notification-list').innerHTML;
    const scheduled = app.scheduled();
    let updates = 0;
    app.context.applyMailStatusUpdate = () => { updates++; return true; };
    app.context.adminPost = async () => response === null ? null
      : { mailStatuses: true, reservations: [], ...response };
    await app.notices.check();
    assert.equal(app.getElement('#notification-health').hidden, false);
    assert.match(app.getElement('#notification-status').textContent, /自動確認を停止/);
    assert.equal(app.getElement('#notification-list').innerHTML, before);
    assert.equal(app.getElement('#notification-count').textContent, '未読1件');
    assert.equal(app.getElement('#notification-check').disabled, false);
    assert.equal(app.scheduled(), scheduled, '不正応答の後は自動通信を続けない');
    assert.equal(updates, 0, '確認できない応答で配送表示を消さない');
    app.context.adminPost = async () => ({ ok: true, reservations: [RESERVATION, added], mailStatuses: true });
    await app.notices.check();
    assert.equal(app.getElement('#notification-health').hidden, true);
    assert.equal(app.getElement('#notification-list').innerHTML, before);
    assert.equal(app.getElement('#notification-count').textContent, '未読1件');
    assert.equal(updates, 1);
    assert.equal(app.scheduled(), scheduled + 1);
  });
}

test('不完全・重複した通知は未読と比較元を壊さず、復旧時も既存予約を新着にしない', async () => {
  const nextReservation = { ...RESERVATION, code: 'LM-NEXT', name: '架空の新着' };
  const fields = Object.keys(RESERVATION);
  const brokenRows = [null, {}, { ...RESERVATION, code: '' }, { ...RESERVATION, code: ' ' },
    ...fields.map(field => ({ ...RESERVATION, [field]: null })),
    ...fields.map(field => {
      const row = { ...RESERVATION };
      delete row[field];
      return row;
    })];
  const brokenBatches = [null, {}, ...brokenRows.map(row => [nextReservation, row]),
    [nextReservation, { ...nextReservation, time: '12:00' }]];
  for (const reservations of brokenBatches) {
    const app = fixture();
    app.context.adminPost = async () => ({ ok: true, reservations: [RESERVATION, nextReservation] });
    await app.notices.check();
    const previous = app.getElement('#notification-list').innerHTML;
    const scheduled = app.scheduled();
    assert.equal(app.getElement('#notification-count').textContent, '未読1件');
    app.context.adminPost = async () => ({ ok: true, reservations });
    await app.notices.check();
    assert.equal(app.getElement('#notification-health').hidden, false);
    assert.equal(app.getElement('#notification-list').innerHTML, previous);
    assert.equal(app.getElement('#notification-count').textContent, '未読1件');
    assert.equal(app.getElement('#notification-check').disabled, false);
    assert.equal(app.scheduled(), scheduled);
    app.context.adminPost = async () => ({ ok: true, reservations: [RESERVATION, nextReservation] });
    await app.notices.check();
    assert.equal(app.getElement('#notification-health').hidden, true);
    assert.equal(app.getElement('#notification-list').innerHTML, previous);
    assert.equal(app.getElement('#notification-count').textContent, '未読1件');
    assert.equal(app.scheduled(), scheduled + 1);
  }
});

test('通知の予約情報が壊れているときは、配送表示も先に書き換えない', async () => {
  const app = fixture();
  let updates = 0;
  app.context.applyMailStatusUpdate = () => { updates++; return true; };
  app.context.adminPost = async () => ({ ok: true, reservations: [{}], mailStatuses: true });
  await app.notices.check();
  assert.equal(updates, 0);
  assert.equal(app.getElement('#notification-health').hidden, false);
});

test('正常な空台帳と名前・状態が空の旧予約は、正常な通知として扱う', async () => {
  const app = fixture();
  app.context.adminPost = async () => ({ ok: true, reservations: [] });
  await app.notices.check();
  assert.equal(app.getElement('#notification-health').hidden, true);
  assert.equal(app.getElement('#notification-count').textContent, '未読0件');
  app.context.adminPost = async () => ({ ok: true, reservations: [{ ...RESERVATION, name: '', status: '' }] });
  await app.notices.check();
  assert.equal(app.getElement('#notification-health').hidden, true);
  assert.equal(app.getElement('#notification-count').textContent, '未読1件');
  assert.match(app.getElement('#notification-list').innerHTML, /お名前なし/);
});
