import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const functionSource = name => source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))[0];
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const hosts = { '#style-rows': { innerHTML: '' }, '#review-rows': { innerHTML: '' } };
  const buttons = { styles: { disabled: true }, reviews: { disabled: true } };
  const calls = [];
  const completions = [];
  const saved = [];
  const renders = [];
  const context = vm.createContext({ pendingEditors: new Set(['styles', 'reviews']), editorReads: new Map(),
    dashboardGeneration: 1, pendingSaves: new Set(), edits: { styles: [], reviews: [], menus: [{ 価格: 4000 }] },
    stamps: { menus: '保持する更新印' }, Promise,
    $: selector => hosts[selector], esc: value => String(value).replaceAll('<', '&lt;'),
    document: { querySelector: selector => buttons[selector.match(/"([^\"]+)"/)[1]] },
    adminPost: payload => { calls.push(payload); return new Promise(resolve => completions.push(resolve)); },
    markSaved: target => saved.push(target), redraw: target => renders.push(target),
    showSaveError: (target, message) => saved.push({ target, message })
  });
  for (const name of ['showEditorLoading', 'validEditorRead', 'commitEditorRead', 'ensureEditorLoaded', 'save']) {
    vm.runInContext(functionSource(name), context);
  }
  return { context, hosts, buttons, calls, completions, saved, renders };
}

test('閉じた編集は空と誤認せず保存を止め、開いた対象だけを一回取得する', async () => {
  const app = fixture();
  await app.context.save('styles');
  assert.equal(app.calls.length, 0);
  assert.match(app.saved[0].message, /読込が完了するまで保存できません/);
  const first = app.context.ensureEditorLoaded('styles');
  assert.equal(app.context.ensureEditorLoaded('styles'), first);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].editorTarget, 'styles');
  assert.match(app.hosts['#style-rows'].innerHTML, /読み込んでいます/);
  app.completions[0]({ ok: true, editorTarget: 'styles', rows: [{ タイトル: '試験写真', 表示: '○' }], stamp: '123456abcdef' });
  assert.equal(await first, true);
  assert.equal(app.buttons.styles.disabled, false);
  assert.equal(app.buttons.reviews.disabled, true);
  assert.deepEqual(app.context.edits.menus, [{ 価格: 4000 }]);
  assert.equal(app.context.stamps.menus, '保持する更新印');
  assert.equal(app.context.pendingEditors.has('reviews'), true);
  await app.context.ensureEditorLoaded('styles');
  assert.equal(app.calls.length, 1, '入力後のタブ往復で取り直さない');
  assert.deepEqual(app.renders, ['styles']);
});

for (const result of [{ ok: false, error: '架空の通信障害' },
  { ok: true, editorTarget: 'styles', rows: [], stamp: undefined },
  { ok: true, editorTarget: 'reviews', rows: [], stamp: '0' },
  { ok: true, editorTarget: 'styles', rows: [{}], stamp: '0' },
  { ok: true, editorTarget: 'styles', rows: [{ タイトル: { value: '不正な行' } }], stamp: '0' }]) {
  test(`不確かな編集取得は保存を有効にせず、同じ対象を手動再確認できる ${JSON.stringify(result)}`, async () => {
    const app = fixture();
    const reading = app.context.ensureEditorLoaded('styles');
    app.completions[0](result);
    assert.equal(await reading, false);
    assert.equal(app.buttons.styles.disabled, true);
    assert.equal(app.context.pendingEditors.has('styles'), true);
    assert.match(app.hosts['#style-rows'].innerHTML, /もう一度読み込む/);
    assert.deepEqual(app.context.edits.styles, []);
    const retry = app.context.ensureEditorLoaded('styles');
    app.completions[1]({ ok: true, editorTarget: 'styles', rows: [], stamp: '0' });
    assert.equal(await retry, true);
    assert.equal(app.calls.length, 2);
    assert.equal(app.buttons.styles.disabled, false);
  });
}

test('画面の再取得後に届いた古い編集結果は、新しい内容・更新印・保存ボタンを上書きしない', async () => {
  const app = fixture();
  const reading = app.context.ensureEditorLoaded('styles');
  app.context.dashboardGeneration++;
  app.context.edits.styles = [{ タイトル: '新しい画面の内容' }];
  app.context.stamps.styles = 'fedcba654321';
  app.completions[0]({ ok: true, editorTarget: 'styles', rows: [{ タイトル: '古い通信' }], stamp: '123456abcdef' });
  assert.equal(await reading, false);
  assert.equal(app.context.edits.styles[0].タイトル, '新しい画面の内容');
  assert.equal(app.context.stamps.styles, 'fedcba654321');
  assert.equal(app.buttons.styles.disabled, true);
  assert.deepEqual(app.renders, []);
  await settle();
});
