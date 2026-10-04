import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { createMockHandler } from './mock-gas.mjs';

const source = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const password = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(password, 'MOCK_ADMIN_PASSWORD が必要です');
const start = source.indexOf('async function saveNote(btn) {');
const end = source.indexOf('\nfunction mailNeedsAttention(', start);
assert.ok(start >= 0 && end > start, '施術メモの保存処理を取り出せる');
const applyStart = source.indexOf('function applyNoteToScreen(');
const applyEnd = source.indexOf('\nconst noteSummaryLabel', applyStart);
assert.ok(applyStart >= 0 && applyEnd > applyStart, '画面内のメモ同期処理を取り出せる');

test('模擬台帳でも競合・再送・空欄を区別し、通知にはメモや連絡先を含めない', async () => {
  const server = http.createServer(createMockHandler({ apiOnly: true }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/exec`;
  const post = async payload => (await fetch(endpoint, {
    method: 'POST', body: JSON.stringify({ password, ...payload })
  })).json();
  try {
    const booking = await post({ type: 'adminAdd', date: '2026-10-08', time: '10:00',
      name: 'メモ試験のお客様', minutes: 60, force: true });
    assert.equal(booking.ok, true);
    const save = (expectedNote, note) => post({ type: 'adminNote', code: booking.code, expectedNote, note });
    assert.equal((await save('', '先に保存したメモ')).ok, true);
    assert.equal((await save('', '古い画面のメモ')).conflict, true);
    assert.equal((await save('', '先に保存したメモ')).ok, true, '同一内容だけを再送成功にする');
    const data = await post({ type: 'adminData' });
    assert.equal(data.reservations.find(row => row.code === booking.code).note, '先に保存したメモ');
    const notifications = await post({ type: 'adminData', notificationsOnly: true });
    assert.deepEqual(Object.keys(notifications).sort(), ['ok', 'reservations']);
    assert.equal(notifications.reservations.length, 1);
    assert.deepEqual(Object.keys(notifications.reservations[0]).sort(), ['code', 'date', 'endTime', 'name', 'status', 'time']);
    assert.equal(notifications.reservations[0].code, booking.code);
    assert.equal((await post({ type: 'adminData' })).reservations[0].note, '先に保存したメモ');
    assert.equal((await save('先に保存したメモ', '=数式ではないメモ')).ok, true);
    assert.equal((await save('先に保存したメモ', '=数式ではないメモ')).ok, true);
    const longNote = 'あ'.repeat(999) + ' ' + '続き';
    const clipped = await save('=数式ではないメモ', longNote);
    assert.equal(clipped.ok, true);
    assert.equal((await save('=数式ではないメモ', longNote)).ok, true);
    assert.equal((await save(clipped.note, '前回\r\n次回')).ok, true);
    assert.equal((await save('前回\n次回', '')).ok, true, '改行の差を誤判定せず空欄への更新もできる');
    assert.equal((await save('前回\n次回', '古い内容')).conflict, true, '消したメモを古い画面から復活させない');
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  }
});

test('別画面の更新と衝突したときは元の内容を送って書きかけを残す', async () => {
  const input = { value: '担当Bの追記', defaultValue: '担当Aの追記', disabled: false };
  const status = { textContent: '' };
  const saveButton = { disabled: false };
  const boxes = [{ querySelector: selector => ({
    '[data-note-input]': input,
    '[data-note-status]': status,
    '[data-note-save]': saveButton
  })[selector] }];
  const requests = [];
  const alerts = [];
  const context = vm.createContext({
    CSS: { escape: value => value },
    $$: () => boxes,
    pendingNoteSaves: new Set(),
    adminPost: async request => {
      requests.push(request);
      return { ok: false, conflict: true, error: '別の画面で施術メモが更新されました。' };
    },
    alert: message => alerts.push(message)
  });
  vm.runInContext(source.slice(start, end), context);
  const button = { dataset: { noteSave: 'LM-TEST1' }, closest: () => boxes[0] };

  await context.saveNote(button);
  assert.equal(requests.length, 1, '一度だけ保存を試みる');
  assert.equal(requests[0].expectedNote, '担当Aの追記', '画面を開いた時点の内容を添える');
  assert.equal(requests[0].note, '担当Bの追記', '書きかけの内容も送る');
  assert.equal(input.value, '担当Bの追記', '競合後も書きかけを消さない');
  assert.match(status.textContent, /別の画面で更新/);
  assert.equal(input.disabled, false, '保存失敗後は編集できる');
  assert.equal(saveButton.disabled, false, '保存失敗後は再試行できる');
  assert.equal(context.pendingNoteSaves.size, 0, '保存中の印を解除する');
  assert.equal(alerts.length, 1, '競合を店の人へ知らせる');
});

test('通信例外では未保存と断定せず、入力を保って手動で確認できる', async () => {
  const input = { value: '結果不明でも残す下書き', defaultValue: '前回のメモ', disabled: false };
  const status = { textContent: '' };
  const button = { disabled: false, dataset: { noteSave: 'LM-TEST1' } };
  const box = { querySelector: selector => ({
    '[data-note-input]': input, '[data-note-status]': status, '[data-note-save]': button
  })[selector] };
  button.closest = () => box;
  const alerts = [];
  let requestCount = 0;
  const context = vm.createContext({
    CSS: { escape: value => value }, $$: () => [box], pendingNoteSaves: new Set(),
    adminPost: async () => { requestCount++; throw new Error('試験用の通信例外'); },
    alert: message => alerts.push(message)
  });
  vm.runInContext(source.slice(start, end), context);
  await context.saveNote(button);
  assert.equal(requestCount, 1, '結果不明でも自動再送しない');
  assert.equal(input.value, '結果不明でも残す下書き');
  assert.equal(input.defaultValue, '前回のメモ', '保存済みの基準を動かさない');
  assert.equal(input.disabled, false);
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /保存結果を確認できません/);
  assert.match(alerts[0], /保存結果を確認できません/);
  assert.doesNotMatch(status.textContent, /未保存です/, '保存済みかもしれないので未保存と断定しない');
});

test('同じ予約を二か所で編集中でも、片方の保存で他方の下書きを消さない', async () => {
  const makeBox = value => {
    const input = { value, defaultValue: '元のメモ' };
    const noteSpan = { textContent: '' };
    const noteText = { hidden: false, querySelector: () => noteSpan };
    const summary = { textContent: '' };
    const status = { textContent: '' };
    const saveButton = { disabled: false };
    return { input, noteSpan, noteText, status, querySelector: selector => ({
      '[data-note-input]': input,
      '[data-note-text]': noteText,
      '[data-note-summary]': summary,
      '[data-note-status]': status,
      '[data-note-save]': saveButton
    })[selector] };
  };
  const savedBox = makeBox('担当Aの追記');
  const otherBox = makeBox('担当Bの下書き');
  const mirroredBox = makeBox('担当Aの追記');
  const requests = [];
  const boxes = [savedBox, otherBox, mirroredBox];
  const context = vm.createContext({
    CSS: { escape: value => value },
    document: { querySelectorAll: () => boxes },
    $$: () => boxes,
    pendingNoteSaves: new Set(),
    adminData: { reservations: [{ code: 'LM-TEST1', note: '元のメモ' }] },
    adminPost: async request => {
      requests.push(request);
      return { ok: true, code: 'LM-TEST1', note: '担当Aの追記' };
    },
    noteSummaryLabel: () => '申し送りを直す',
    NOTE_MAX: 1000,
    alert: () => assert.fail('保存が成功したときに警告を出さない')
  });
  vm.runInContext(source.slice(applyStart, applyEnd), context);
  vm.runInContext(source.slice(start, end), context);

  await context.saveNote({ dataset: { noteSave: 'LM-TEST1' }, closest: () => savedBox });
  assert.equal(requests[0].expectedNote, '元のメモ', '保存前の元データを送る');
  assert.equal(savedBox.input.defaultValue, '担当Aの追記', '保存した欄の元データを更新する');
  assert.equal(otherBox.input.value, '担当Bの下書き', '別の欄の下書きを残す');
  assert.equal(otherBox.input.defaultValue, '元のメモ', '古い元データを残し、上書き検知を働かせる');
  assert.equal(otherBox.noteSpan.textContent, '担当Aの追記', '表示上は最新の保存内容を示す');
  assert.match(otherBox.status.textContent, /下書きは残っています/);
  assert.equal(mirroredBox.input.defaultValue, '担当Aの追記', '入力時に同期した同じ下書きは保存済みにする');
  assert.equal(mirroredBox.input.value, mirroredBox.input.defaultValue, '同期先に未保存扱いの入力を残さない');
});
