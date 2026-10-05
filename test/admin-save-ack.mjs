import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const TARGETS = ['menus', 'coupons', 'styles', 'reviews', 'closed', 'settings'];

function fixture(target) {
  const success = { style: {}, textContent: '' };
  const failure = { style: {}, textContent: '' };
  const button = { disabled: false, dataset: { label: '保存' } };
  const errors = [];
  const requests = [];
  const renders = [];
  let complete;
  const edits = { menus: [{ 価格: 4000 }], coupons: [{ 価格: 6000 }],
    styles: [{ タイトル: '保存前' }], reviews: [{ 状態: '未承認' }],
    closed: [{ 休業日: '2030-01-05', メモ: '保存前' }], settings: { 紹介文: '保存前' } };
  const context = vm.createContext({ pendingEditors: new Set(), pendingSaves: new Set(), edits,
    stamps: Object.fromEntries(TARGETS.map(name => [name, name + '-before'])),
    rowBase: new WeakMap(), baseCount: {}, settingsBase: '', savedNote: {},
    adminData: { menus: structuredClone(edits.menus), coupons: structuredClone(edits.coupons), closedDates: structuredClone(edits.closed) },
    $: selector => selector === '#save-ok' ? success : failure,
    document: { querySelector: () => button },
    collectWeekdays() {}, closedRowProblem: () => null, firstInvalidBookableMinutes: () => -1,
    showSaveError: (_target, message) => { errors.push(message); failure.textContent = message; },
    redraw: name => renders.push(name), refreshList() {}, updateDirty() {},
    renderReservations: () => renders.push('reserve'), renderAdminCalendar: () => renders.push('calendar'),
    adminPost: payload => { requests.push(payload); return new Promise(resolve => { complete = resolve; }); }
  });
  for (const name of ['markSaved', 'rowDirty', 'isDirty', 'saveResultMessage', 'save']) {
    const match = SOURCE.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  for (const name of TARGETS) context.markSaved(name);
  if (target === 'settings') edits.settings.紹介文 = '未保存の内容';
  else edits[target][0].メモ = '未保存の内容';
  return { context, success, failure, button, errors, requests, renders,
    complete: response => complete(response) };
}

const uncertain = [null, [], {}, { ok: true }, { ok: 'true' }, { ok: 1 },
  { ok: true, stamps: null }, { ok: true, stamps: [] }, { ok: true, stamps: {} },
  ...[null, '', '  ', 0, 123, [], {}].map(stamp => ({ ok: true, stamps: { TARGET: stamp } })),
  ...['unknown', 'stale', 'transportError', 'authDenied', 'invalid', 'restored'].map(flag => ({ ok: true, stamps: { TARGET: 'saved' }, [flag]: true }))];

for (const [index, response] of uncertain.entries()) {
  test(`保存の未確認応答${index + 1}：六対象で下書き・印・参照データを保存済みへ進めない`, async () => {
    for (const target of TARGETS) {
      const app = fixture(target);
      const result = response?.stamps?.TARGET !== undefined
        ? { ...response, stamps: { [target]: response.stamps.TARGET } } : response;
      const before = JSON.stringify({ stamps: app.context.stamps, adminData: app.context.adminData,
        settingsBase: app.context.settingsBase, baseCount: app.context.baseCount });
      const saving = app.context.save(target);
      assert.equal(app.button.disabled, true);
      await app.context.save(target);
      assert.equal(app.requests.length, 1);
      app.complete(result);
      await saving;
      assert.equal(app.context.isDirty(target), true, target);
      assert.equal(JSON.stringify({ stamps: app.context.stamps, adminData: app.context.adminData,
        settingsBase: app.context.settingsBase, baseCount: app.context.baseCount }), before);
      assert.deepEqual(app.renders, []);
      assert.equal(app.success.style.display, 'none');
      assert.match(app.errors[0], /保存の結果を確認できません.*入力は残しています/);
      assert.match(app.errors[0], /保存を繰り返さず/);
      assert.equal(app.context.pendingSaves.size, 0);
      assert.equal(app.button.disabled, false);
      assert.equal(app.requests.length, 1, '結果不明でも自動再送しない');
    }
  });
}

for (const target of TARGETS) {
  test(`${target}：旧・新の有効な保存印を受け取り、通信中の追加入力と別対象の印を保つ`, async () => {
    for (const stamp of ['0', 'fixture-saved', '123456abcdef', '1:abc']) {
      const app = fixture(target);
      const saving = app.context.save(target);
      assert.equal(app.requests[0].stampScope, 'target');
      if (target === 'settings') app.context.edits.settings.紹介文 = '通信中の追加入力';
      else app.context.edits[target][0].メモ = '通信中の追加入力';
      app.complete({ ok: true, stamps: Object.fromEntries(TARGETS.map(name => [name, name === target ? stamp : '別対象の古い印'])) });
      await saving;
      assert.equal(app.context.isDirty(target), true);
      assert.equal(app.context.stamps[target], stamp);
      for (const name of TARGETS) if (name !== target) assert.equal(app.context.stamps[name], name + '-before');
      assert.match(app.success.textContent, /その後の変更は未保存/);
      assert.deepEqual(app.errors, []);
      const again = app.context.save(target);
      assert.equal(app.requests[1].stamp, stamp);
      app.complete({ ok: true, stamps: { [target]: 'next' } });
      await again;
      assert.equal(app.context.isDirty(target), false);
    }
  });
}

test('結果不明・通信断・競合の拒否は元の案内を維持し、再送しない', async () => {
  for (const response of [{ ok: false, unknown: true, error: '確認できません' },
    { ok: false, error: '架空の拒否' }]) {
    const app = fixture('settings');
    const saving = app.context.save('settings');
    app.complete(response);
    await saving;
    assert.equal(app.errors[0], response.error);
    assert.equal(app.context.isDirty('settings'), true);
    assert.equal(app.requests.length, 1);
  }
  const app = fixture('settings');
  app.context.adminPost = async () => { throw new Error('架空の通信断'); };
  await app.context.save('settings');
  assert.match(app.errors[0], /通信に失敗しました.*入力を残しています/);
  assert.equal(app.context.isDirty('settings'), true);
  assert.equal(app.button.disabled, false);
});
