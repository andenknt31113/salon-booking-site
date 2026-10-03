import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const dataSource = readFileSync(process.env.ADMIN_DATA_SOURCE || new URL('../assets/js/admin-data.js', import.meta.url), 'utf8');
const extract = name => source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))?.[0] || '';
const functions = ['showEditorLoading', 'ensureEditorLoaded', 'save', 'renderPhonePresets', 'loadPhonePresets']
  .map(extract).join('\n');
const startup = () => ({ ok: true, reservations: [], closedDates: [], settings: {},
  stamps: { closed: '0', settings: '0' }, pendingEditors: ['menus', 'coupons', 'styles', 'reviews'] });
const rows = target => [{ メニュー名: `${target}の架空メニュー`, 価格: '4000〜', '所要(分)': 60, 表示: '○' }];
const response = target => ({ ok: true, editorTarget: target, rows: rows(target), stamp: '123456abcdef' });

function fixture() {
  const calls = [], completions = [], renders = [], saves = [];
  const hosts = Object.fromEntries(['#menu-rows', '#coupon-rows', '#style-rows', '#review-rows',
    '#ab-menu-preset', '#ab-presets-status', '#add-booking-form', '#ab-menu', '#ab-minutes', '#ab-price', '#ab-menu-hint']
    .map(selector => [selector, { innerHTML: '', textContent: '', value: '', hidden: false, disabled: false }]));
  const buttons = Object.fromEntries(['menus', 'coupons', 'styles', 'reviews'].map(target => [target, { disabled: true }]));
  const context = vm.createContext({
    pendingEditors: new Set(['menus', 'coupons', 'styles', 'reviews']), editorReads: new Map(), dashboardGeneration: 1,
    phonePresetGeneration: 0, phonePresets: [], pendingSaves: new Set(),
    adminData: startup(), edits: { menus: [], coupons: [], styles: [], reviews: [], settings: {} },
    stamps: { closed: '0', settings: '0' },
    $: selector => hosts[selector], esc: value => String(value).replaceAll('<', '&lt;'),
    minutesText: value => `${value}分`, priceText: value => `¥${value}`,
    document: { querySelector: selector => buttons[selector.match(/"([^\"]+)"/)[1]] },
    adminPost: payload => { calls.push(payload); return new Promise(resolve => completions.push(resolve)); },
    markSaved: target => saves.push(target), redraw: target => renders.push(target),
    showSaveError: (target, message) => saves.push({ target, message })
  });
  vm.runInContext(dataSource + '\n' + functions + '\nthis.validStartup = AdminData.validStartup;', context);
  return { context, hosts, buttons, calls, completions, renders, saves };
}

test('省略を明示した4つの編集だけを未取得とし、必要な予定・休業・設定は引き続き検査する', () => {
  const app = fixture();
  assert.equal(app.context.validStartup(startup()), true);
  for (const mutate of [result => { delete result.pendingEditors; }, result => { delete result.closedDates; },
    result => { delete result.settings; }, result => { delete result.stamps.closed; },
    result => { result.menus = []; }, result => { result.coupons = []; },
    result => { result.pendingEditors.push('settings'); }]) {
    const result = startup();
    mutate(result);
    assert.equal(app.context.validStartup(result), false);
  }
});

for (const target of ['menus', 'coupons']) {
  test(`${target}は未取得の空配列を保存できず、開いた対象だけ一回読み、電話用の確定データも更新する`, async () => {
    const app = fixture();
    await app.context.save(target);
    assert.equal(app.calls.length, 0);
    assert.match(app.saves[0].message, /読込が完了するまで保存できません/);
    const reading = app.context.ensureEditorLoaded(target);
    assert.equal(app.context.ensureEditorLoaded(target), reading);
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].editorTarget, target);
    app.completions[0](response(target));
    assert.equal(await reading, true);
    assert.equal(app.buttons[target].disabled, false);
    assert.deepEqual(JSON.parse(JSON.stringify(app.context.adminData[target])), rows(target));
    assert.notEqual(app.context.adminData[target][0], app.context.edits[target][0]);
    app.context.edits[target][0]['価格'] = '9999';
    assert.equal(app.context.adminData[target][0]['価格'], '4000〜');
    await app.context.ensureEditorLoaded(target);
    assert.equal(app.calls.length, 1);
    assert.deepEqual(app.renders, [target]);
  });

  test(`${target}の欠落・別対象・不正行・更新印欠落は保存を有効にせず手動で復旧できる`, async () => {
    for (const result of [{ ok: false }, { ...response(target), editorTarget: 'settings' },
      { ...response(target), stamp: undefined }, { ...response(target), rows: [{}] },
      { ...response(target), rows: [{ メニュー名: '不正', 価格: {} }] }]) {
      const app = fixture();
      const reading = app.context.ensureEditorLoaded(target);
      app.completions[0](result);
      assert.equal(await reading, false);
      assert.equal(app.buttons[target].disabled, true);
      assert.equal(app.context.pendingEditors.has(target), true);
      assert.equal(app.context.adminData[target], undefined);
      const retry = app.context.ensureEditorLoaded(target);
      app.completions[1]({ ok: true, editorTarget: target, rows: [], stamp: '0' });
      assert.equal(await retry, true);
    }
  });
}

test('電話入力を始めた時だけメニュー2種類を読み、取得待ちと完了で手入力の内容を変えない', async () => {
  const app = fixture();
  assert.equal(typeof app.context.loadPhonePresets, 'function');
  const values = { '#ab-menu': '今回だけの手入力', '#ab-minutes': '80', '#ab-price': '12345', '#ab-menu-hint': '保持する案内' };
  for (const [selector, value] of Object.entries(values)) app.hosts[selector].value = value;
  app.hosts['#ab-menu-hint'].textContent = '保持する案内';
  const reading = app.context.loadPhonePresets();
  assert.equal(app.calls.length, 2);
  assert.deepEqual(app.calls.map(payload => payload.editorTarget).sort(), ['coupons', 'menus']);
  assert.equal(app.hosts['#ab-menu-preset'].disabled, true);
  app.completions.forEach((complete, index) => complete(response(app.calls[index].editorTarget)));
  assert.equal(await reading, true);
  assert.equal(app.hosts['#ab-menu-preset'].disabled, false);
  assert.equal(app.hosts['#ab-presets-status'].hidden, true);
  assert.match(app.hosts['#ab-menu-preset'].innerHTML, /menusの架空メニュー/);
  assert.match(app.hosts['#ab-menu-preset'].innerHTML, /couponsの架空メニュー/);
  for (const [selector, value] of Object.entries(values)) assert.equal(app.hosts[selector].value, value);
  assert.equal(app.hosts['#ab-menu-hint'].textContent, '保持する案内');
  await app.context.loadPhonePresets();
  assert.equal(app.calls.length, 2, 'フォームの開き直しで取得済み内容を取り直さない');
});

test('電話メニューの片方が取得できなければ不完全な選択肢を出さず、手入力を残して失敗した対象だけ再確認する', async () => {
  const app = fixture();
  assert.equal(typeof app.context.loadPhonePresets, 'function');
  app.hosts['#ab-menu'].value = '保持する電話入力';
  const reading = app.context.loadPhonePresets();
  app.completions.forEach((complete, index) => complete(index ? { ok: false } : response(app.calls[index].editorTarget)));
  assert.equal(await reading, false);
  assert.equal(app.hosts['#ab-menu-preset'].disabled, true);
  assert.match(app.hosts['#ab-presets-status'].innerHTML, /data-retry-phone-presets/);
  assert.equal(app.hosts['#ab-menu'].value, '保持する電話入力');
  const retry = app.context.loadPhonePresets();
  assert.equal(app.calls.length, 3);
  app.completions[2](response(app.calls[2].editorTarget));
  assert.equal(await retry, true);
  assert.equal(app.hosts['#ab-menu'].value, '保持する電話入力');
});

test('旧フォーム・旧管理画面への遅いメニュー応答で、新しい手入力・選択肢・更新印を上書きしない', async () => {
  for (const invalidateDashboard of [false, true]) {
    const app = fixture();
    assert.equal(typeof app.context.loadPhonePresets, 'function');
    const reading = app.context.loadPhonePresets();
    if (invalidateDashboard) app.context.dashboardGeneration++;
    else app.context.phonePresetGeneration++;
    app.hosts['#ab-menu'].value = '新しい手入力';
    app.hosts['#ab-menu-preset'].innerHTML = '新しい選択肢';
    app.hosts['#ab-presets-status'].innerHTML = '新しい状態';
    app.completions.forEach((complete, index) => complete(response(app.calls[index].editorTarget)));
    assert.equal(await reading, false);
    assert.equal(app.hosts['#ab-menu'].value, '新しい手入力');
    assert.equal(app.hosts['#ab-menu-preset'].innerHTML, '新しい選択肢');
    assert.equal(app.hosts['#ab-presets-status'].innerHTML, '新しい状態');
    if (invalidateDashboard) assert.equal(app.context.stamps.menus, undefined);
  }
});
