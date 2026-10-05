import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const common = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const success = { style: {}, textContent: '' };
const failure = { style: {}, textContent: '' };
const button = { disabled: false, dataset: { label: '保存' } };
let complete;
let submitted;
let requests = 0;
const context = vm.createContext({
  pendingEditors: new Set(), pendingSaves: new Set(),
  edits: { menus: [{ メニュー名: '架空の施術', 価格: 4000, '所要(分)': 60 }], settings: { 紹介文: '保存済み' }, closed: [] },
  rowBase: new WeakMap(), baseCount: {}, settingsBase: '', savedNote: {},
  stamps: { menus: '読込時', settings: '設定読込時' }, adminData: {},
  $: selector => selector === '#save-ok' ? success : failure,
  document: { querySelector: () => button },
  collectWeekdays() {}, redraw() {}, refreshList() {}, updateDirty() {},
  renderReservations() {}, renderAdminCalendar() {},
  pad2: value => String(value).padStart(2, '0'),
  adminPost: payload => {
    requests++;
    submitted = payload;
    return new Promise(resolve => { complete = resolve; });
  }
});
context.toHalfWidth = value => String(value ?? '')
  .replace(/[！-～]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
  .replace(/　/g, ' ');
for (const name of ['toKey', 'fromKey']) {
  const match = common.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `${name} がある`);
  vm.runInContext(match[0], context);
}
for (const name of ['bookableMinutes', 'firstInvalidBookableMinutes', 'closedRowProblem', 'showSaveError',
  'markSaved', 'rowDirty', 'isDirty', 'saveResultMessage', 'save']) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `${name} がある`);
  vm.runInContext(match[0], context);
}
context.markSaved('menus');
context.edits.menus[0].価格 = 5000;
let saving = context.save('menus');
assert.equal(button.disabled, true, '送信中の保存ボタンを止める');
await context.save('menus');
assert.equal(requests, 1, '同じ項目を二重送信しない');
context.edits.menus[0].価格 = 6000;
assert.equal(submitted.rows[0].価格, 5000, '送信後の編集で送信内容を書き換えない');
complete({ ok: true, stamps: { menus: '保存後', settings: '別通信の古い設定' } });
await saving;
assert.equal(context.edits.menus[0].価格, 6000, '通信中の追加入力を残す');
assert.equal(context.adminData.menus[0].価格, 5000, '電話受付の補助には実際に保存した価格だけを渡す');
assert.equal(context.isDirty('menus'), true, '追加入力を保存済みと誤認しない');
assert.match(success.textContent, /その後の変更は未保存/, '保存された範囲を伝える');
assert.equal(context.stamps.settings, '設定読込時', '別項目の更新確認用の値を巻き戻さない');
assert.equal(context.pendingSaves.size, 0, '保存待ちを解消する');

saving = context.save('menus');
complete({ ok: true, stamps: { menus: '再保存後' } });
await saving;
assert.equal(context.isDirty('menus'), false, '追加入力を次の保存で確定できる');
assert.equal(context.adminData.menus[0].価格, 6000, '次の保存が成功したら電話受付の補助も更新する');

saving = context.save('menus');
context.edits.menus.splice(0, 1, { メニュー名: '別の架空施術', 価格: 7000, '所要(分)': 60 });
complete({ ok: true, stamps: { menus: '置換前の保存後' } });
await saving;
assert.equal(context.isDirty('menus'), true, '通信中の同件数の削除・追加も未保存として残す');

context.markSaved('settings');
context.edits.settings.紹介文 = '送信した文';
saving = context.save('settings');
context.edits.settings.紹介文 = 'その後に書いた文';
complete({ ok: true, stamps: { settings: '送信した文の保存後' } });
await saving;
assert.equal(context.isDirty('settings'), true, '店舗情報も通信中の変更を未保存として残す');
assert.equal(context.edits.settings.紹介文, 'その後に書いた文', '店舗情報の追加入力を保持する');

context.edits.closed = [{ 休業日: '2026-10-01' }];
saving = context.save('closed');
context.edits.closed[0].休業日 = '2026-10-02';
complete({ ok: true, stamps: { closed: '送信した休業の保存後' } });
await saving;
assert.equal(context.adminData.closedDates[0].休業日, '2026-10-01', '予約の参照データは実際に保存した休業日だけ');
assert.equal(context.edits.closed[0].休業日, '2026-10-02', '新しい休業日入力は消さない');
assert.equal(context.isDirty('closed'), true, '新しい休業日は未保存');

saving = context.save('settings');
complete({ ok: false, error: '試験用の失敗' });
await saving;
assert.equal(context.isDirty('settings'), true, '失敗時に保存済みとしない');
assert.equal(button.disabled, false, '失敗後も再保存できる');
assert.match(failure.textContent, /試験用の失敗/, '失敗を表示する');
context.adminPost = async () => { throw new Error('試験用の通信断'); };
await context.save('settings');
assert.equal(context.pendingSaves.size, 0, '例外でも保存中の状態を解除する');
assert.equal(button.disabled, false, '例外後も再保存できる');
console.log('保存中の追加入力・削除追加・休業日・失敗時の保持・二重送信防止：成功');
