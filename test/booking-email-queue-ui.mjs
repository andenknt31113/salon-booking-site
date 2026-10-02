import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const begin = SOURCE.indexOf('function mailNeedsAttention(');
const end = SOURCE.indexOf('\nfunction reservationCard(', begin);
assert.ok(begin >= 0 && end > begin);

function fixture(status) {
  const alert = { hidden: true, innerHTML: '' };
  const reservation = { code: 'LM-QUEUEUI', name: '架空のお客様', date: '2030-01-05', time: '10:00', endTime: '11:00', status: '予約確定', note: '書きかけのメモ',
    shopMailStatus: '新規予約：' + status, customerMailStatus: '新規予約：' + status };
  const context = vm.createContext({
    esc: value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
    $: () => alert, $$: () => [], adminData: { reservations: [reservation] } });
  vm.runInContext(SOURCE.slice(begin, end), context);
  return { context, alert, reservation };
}

for (const status of ['配送待ち', '配送処理中']) {
  test(`${status}はメール到着と区別し、通常の待機を失敗と表示しない`, () => {
    const app = fixture(status);
    assert.equal(app.context.mailNeedsAttention(app.reservation), false);
    const html = app.context.mailStatusHtml(app.reservation);
    assert.match(html, /予約は保存済み/);
    assert.match(html, /メールは別の処理で配送/);
    assert.match(html, /到着は確認していません/);
    app.context.renderMailAlert();
    assert.equal(app.alert.hidden, true);
  });
}

for (const status of ['送信結果不明', '配送状況を要確認', '送信失敗']) {
  test(`${status}は店主に確認を促し、再登録・自動再送しない`, () => {
    const app = fixture(status);
    assert.equal(app.context.mailNeedsAttention(app.reservation), true);
    app.context.renderMailAlert();
    assert.equal(app.alert.hidden, false);
    assert.match(app.alert.innerHTML, /登録し直さず/);
    assert.match(app.alert.innerHTML, /自動再送しません/);
  });
}

test('配送完了後は警告を消し、本文や状態に含まれるHTMLを実行しない', () => {
  const app = fixture('送信処理受付');
  app.context.renderMailAlert();
  assert.equal(app.alert.hidden, true);
  assert.match(app.context.mailStatusHtml(app.reservation), /受信箱への到着は確認していません/);
  app.reservation.shopMailStatus = '<img src=x onerror=alert(1)>送信結果不明';
  assert.equal(app.context.mailStatusHtml(app.reservation).includes('<img'), false);
});

test('配送状態の自動更新は施術メモや予約日時を変更せず、同じ状態の再描画もしない', () => {
  const app = fixture('配送待ち');
  const element = { dataset: { mailStatus: app.reservation.code }, outerHTML: '' };
  app.context.$$ = () => [element];
  const row = { ...app.reservation, shopMailStatus: '新規予約：送信処理受付', customerMailStatus: '新規予約：送信処理受付', note: 'サーバーの別メモ' };
  assert.equal(app.context.applyMailStatusUpdate([row]), true);
  assert.match(element.outerHTML, /送信処理受付/);
  assert.equal(app.reservation.note, '書きかけのメモ');
  assert.equal(app.reservation.time, '10:00');
  element.outerHTML = '同じ描画のまま';
  assert.equal(app.context.applyMailStatusUpdate([row]), true);
  assert.equal(element.outerHTML, '同じ描画のまま');
});

for (const changed of [{ date: '2030-01-06' }, { time: '14:00' }, { endTime: '12:00' },
  { status: 'キャンセル' }, { name: '別のお客様' }, { code: 'LM-OTHER' }]) {
  test(`古い予約画面には別の予定の配送結果を混ぜない：${Object.keys(changed)[0]}`, () => {
    const app = fixture('配送待ち');
    const row = { ...app.reservation, ...changed, shopMailStatus: '日時変更：送信処理受付', customerMailStatus: '日時変更：送信処理受付' };
    assert.equal(app.context.applyMailStatusUpdate([row]), true);
    assert.equal(app.reservation.shopMailStatus, '新規予約：配送待ち');
    assert.equal(app.reservation.note, '書きかけのメモ');
  });
}

test('壊れた・重複した配送応答では、部分的な成功表示や入力の上書きをしない', () => {
  for (const makeRows of [() => null, () => [null], row => [row, row],
    row => [{ ...row, customerMailStatus: null }], row => [{ ...row, shopMailStatus: '長'.repeat(201) }]]) {
    const app = fixture('配送待ち');
    assert.equal(app.context.applyMailStatusUpdate(makeRows({ ...app.reservation })), false);
    assert.equal(app.reservation.shopMailStatus, '新規予約：配送待ち');
    assert.equal(app.reservation.note, '書きかけのメモ');
  }
});
