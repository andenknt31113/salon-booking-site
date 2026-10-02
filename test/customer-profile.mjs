import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const functions = ['customerSchedule', 'customerProfileHtml', 'closeCustomerProfile'].map(name => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, name + ' が必要です');
  return match[0];
}).join('\n');
const escape = value => String(value).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function fixture() {
  const context = vm.createContext({
    esc: escape, isCancelled: reservation => reservation.status === 'キャンセル',
    toKey: () => '2030-01-10', telKey: tel => String(tel).replace(/[^0-9]/g, ''),
    yen: price => `¥${price}`, formatDateJa: date => escape(date),
    noteEditorHtml: reservation => `<div data-note-code="${escape(reservation.code)}">${escape(reservation.note || '')}</div>`
  });
  vm.runInContext(functions, context);
  const past = { code: 'LM-PAST', date: '2030-01-09', time: '10:00', endTime: '11:00',
    name: '架空 親', menu: '試験カット', email: '', status: '予約確定', note: '前回の申し送り', request: '' };
  const next = { ...past, code: 'LM-NEXT', date: '2030-01-11', name: '架空 子', note: '' };
  const cancelled = { ...past, code: 'LM-OFF', date: '2030-01-08', status: 'キャンセル' };
  const visits = [next, past, cancelled];
  const customer = { name: next.name, names: [next.name, past.name], email: '', tel: '00000000041',
    visits, spent: 8000, schedule: context.customerSchedule(visits, new Date(2030, 0, 10, 12)) };
  return { context, customer, past, next, cancelled };
}

test('選んだ番号の詳細で、過去・今後・取消と家族を区別して全履歴を残す', () => {
  const app = fixture();
  const html = app.context.customerProfileHtml(app.customer);
  assert.match(html, /同じ電話番号を使う方/);
  assert.match(html, /過去の予約 1件/);
  assert.match(html, /今後・施術中 1件 ／ キャンセル 1件/);
  assert.match(html, /すべての予約を見る（3件・キャンセルを含む）/);
  assert.equal((html.match(/data-history-booking=/g) || []).length, 3);
  assert.equal((html.match(/data-note-code=/g) || []).length, 2);
  assert.match(html, /架空 親／試験カット（過去の予約）/);
  assert.match(html, /架空 子／試験カット（今後・施術中）/);
  assert.match(html, /試験カット（キャンセル）/);
});

test('開き直した詳細は最新の保存メモを使い、名前・メニュー・要望のHTMLを実行しない', () => {
  const app = fixture();
  app.context.customerProfileHtml(app.customer);
  app.past.note = '保存後の新しい申し送り';
  app.past.menu = '<script>架空のメニュー</script>';
  app.past.request = '<img src=x onerror=alert(1)>';
  app.next.name = '<svg onload=alert(1)>';
  app.customer.name = app.next.name;
  app.customer.names = [...new Set(app.customer.visits.map(visit => visit.name))];
  const html = app.context.customerProfileHtml(app.customer);
  assert.match(html, /保存後の新しい申し送り/);
  assert.equal(/<script>|<img|<svg/.test(html), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;svg/);
});

test('名簿に戻ると詳細だけを解放し、番号・行・フォーカス先を残す', () => {
  let released = 0;
  const record = { open: true, dataset: { customerTel: '00000000041' }, querySelector: selector => {
    assert.equal(selector, '.customer-profile');
    return { replaceChildren: () => { released++; } };
  } };
  fixture().context.closeCustomerProfile(record);
  assert.equal(record.open, false);
  assert.equal(released, 1);
  assert.equal(record.dataset.customerTel, '00000000041');
});
