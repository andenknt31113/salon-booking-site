import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const fields = Object.fromEntries(['date', 'time', 'minutes', 'price', 'name', 'tel', 'menu', 'memo', 'menu-preset']
  .map(name => ['#ab-' + name, { value: '', defaultValue: name === 'minutes' ? '60' : '' }]));
const notice = { hidden: true, focus() { this.focused = true; }, scrollIntoView() {} };
let warnings = [];
let confirmations = 0;
let switched = 0;
let accept = false;
let guard = true;
let stored = '';
let readFails = false;
const context = vm.createContext({
  adminData: { reservations: [
    { code: 'first', name: '  選んだ方  ', tel: '０９０-１１１１-２２２２', menu: '前回の施術', request: '過去の要望', email: 'old@example.invalid' },
    { code: 'second', name: '同じ番号の別の方', tel: '09011112222', status: 'キャンセル' }
  ] },
  phoneRequestId: '', phoneSubmitting: false, phoneUncertain: false, phoneConflict: false,
  phonePayload: null, phonePriceNeedsInput: false,
  guardNoteFilters: () => guard,
  phoneRequestKey: () => '模擬受付の控え',
  localStorage: { getItem() { if (readFails) throw new Error('試験用の保存領域エラー'); return stored; } },
  alert: message => warnings.push(message),
  confirm: () => { confirmations++; return accept; },
  telKey: value => value.replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/[^0-9]/g, ''),
  toKey: () => '2026-09-13',
  $: selector => fields[selector] || (selector === '#ab-customer' ? notice : selector === '#admin-tabs [data-pane="reserve"]' ? { click() { switched++; } } : {}),
  $$: () => Object.values(fields),
  toggleAddBooking() { fields['#ab-date'].value ||= '2026-09-13'; }
});
const implementation = source.match(/^function startCustomerBooking\([^]*?^}/m);
assert.ok(implementation, '名簿から電話入力へ進む処理がある');
vm.runInContext(implementation[0], context);
function reset() {
  for (const field of Object.values(fields)) field.value = field.defaultValue;
  context.phoneSubmitting = context.phoneUncertain = context.phoneConflict = false;
  context.phoneRequestId = '';
  context.phonePayload = null;
  context.phonePriceNeedsInput = false;
  guard = true;
  stored = '';
  readFails = false;
  accept = false;
  warnings = [];
  confirmations = switched = 0;
}
reset();
context.startCustomerBooking('first');
assert.equal(fields['#ab-name'].value, '選んだ方', '番号の代表者ではなく選んだ予約者を使う');
assert.equal(fields['#ab-tel'].value, '09011112222', '連絡先の表記を整える');
assert.equal(fields['#ab-minutes'].value, '', '所要を暗黙に確定しない');
assert.equal(fields['#ab-menu'].value, '', '前回の施術を今回へ流用しない');
assert.equal(fields['#ab-memo'].value, '', '過去の要望を新しい要望にしない');
assert.equal(confirmations, 0, '未入力なら不要な確認を挟まない');
assert.equal(switched, 1, '既存の予約タブへ進む');
assert.equal(notice.focused, true, '入力補助後の案内へフォーカスする');
assert.match(notice.textContent, /まだ予約は登録していません/, '登録済みと誤認させない');

for (const selector of Object.keys(fields).filter(selector => selector !== '#ab-menu-preset')) {
  reset();
  fields[selector].value = selector === '#ab-minutes' ? '90' : selector === '#ab-date' ? '2026-10-01' : '入力途中';
  const before = JSON.stringify(fields);
  context.startCustomerBooking('second');
  assert.equal(confirmations, 1, `${selector} だけの書きかけも置換前に確認する`);
  assert.equal(JSON.stringify(fields), before, `${selector} の置換を断れば全入力を保持する`);
  assert.equal(switched, 0, '置換を断れば移動しない');
  accept = true;
  context.startCustomerBooking('second');
  assert.equal(fields['#ab-name'].value, '同じ番号の別の方', '確認後に予約者を選び直す');
  assert.equal(fields['#ab-menu'].value, '', '別の方のメニューを消す');
  assert.equal(fields['#ab-memo'].value, '', '別の方のメモを消す');
  assert.equal(context.adminData.reservations[1].status, 'キャンセル', '過去のキャンセルを復活させない');
}

for (const flag of ['phoneSubmitting', 'phoneUncertain', 'phoneConflict', 'phoneRequestId']) {
  reset();
  context[flag] = flag === 'phoneRequestId' ? 'pending-request-01' : true;
  fields['#ab-name'].value = '結果未確認の方';
  const before = JSON.stringify(fields);
  accept = true;
  context.startCustomerBooking('first');
  assert.equal(JSON.stringify(fields), before, `${flag} の間は別の方へ変えない`);
  assert.equal(confirmations, 0, '未確認受付は置換の確認だけで解除できない');
  assert.equal(switched, 0, '未確認の間は新しい入力へ移動しない');
  assert.match(warnings[0], /前の電話受付/, '先に結果を確認するよう案内する');
}
for (const receipt of ['pending-other-window', '壊れた控え']) {
  reset();
  stored = receipt;
  context.startCustomerBooking('first');
  assert.equal(switched, 0, '別画面や読めない控えを黙って捨てない');
  assert.equal(stored, receipt, '保存されている受付控えは変更しない');
  assert.match(warnings[0], /別の画面/, '元の画面での照合へ案内する');
}
reset();
readFails = true;
context.startCustomerBooking('first');
assert.equal(switched, 0, '控えの読取に失敗したら新しい入力を止める');
assert.match(warnings[0], /読み取れません/, '保存領域の失敗を知らせる');
reset();
guard = false;
context.startCustomerBooking('first');
assert.equal(switched, 0, '未保存メモの共通ガードを通過できなければ進めない');
reset();
context.startCustomerBooking('missing');
assert.equal(switched, 0, '消えた履歴から別の方を推測して入力しない');
assert.match(warnings[0], /確認できません/, '履歴を見つけられなければ読み直しを案内する');
context.adminData.reservations.push({ code: 'no-name', name: '', tel: '09011112222' }, { code: 'no-phone', name: '名前のみ', tel: '' });
for (const code of ['no-name', 'no-phone']) {
  context.startCustomerBooking(code);
  assert.equal(switched, 0, '控えに名前や電話番号がなければ補完しない');
}
const directory = source.match(/^function buildCustomers\([^]*?^}/m);
assert.ok(directory, '名簿を作る処理がある');
context.isCancelled = row => row.status === 'キャンセル';
vm.runInContext(directory[0], context);
const sameDay = [
  { code: 'morning', name: '午前に予約した方', tel: '09011112222', email: 'morning@example.invalid', date: '2026-09-13', time: '10:00' },
  { code: 'afternoon', name: '午後に予約した方', tel: '０９０-１１１１-２２２２', email: 'afternoon@example.invalid', date: '2026-09-13', time: '14:00' }
];
for (const reservations of [sameDay, sameDay.slice().reverse()]) {
  context.adminData = { reservations };
  const customers = context.buildCustomers();
  assert.equal(customers.length, 1, '同じ番号の家族は引き続き一つの名簿行になる');
  assert.equal(customers[0].name, '午後に予約した方', '同じ日でも新しい時刻の予約者を代表表示する');
  assert.equal(customers[0].email, 'afternoon@example.invalid', '代表連絡先と履歴の新しい順を一致させる');
  assert.equal(customers[0].names.length, 2, '新しい予約者だけに家族の選択肢を絞らない');
  assert.equal(customers[0].visits[0].code, 'afternoon', '台帳の並び順で代表表示を変えない');
}
console.log('名簿から電話入力する際の下書き・未確認受付・端末記憶・連絡先の保護：成功');
