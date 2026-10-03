import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const PORTAL = readFileSync(new URL('../assets/js/admin-portal.js', import.meta.url), 'utf8');
const DATA_PATH = new URL('../assets/js/admin-data.js', import.meta.url);
const DATA_SOURCE = existsSync(DATA_PATH) ? readFileSync(DATA_PATH, 'utf8') : '';
const startup = () => ({ ok: true, reservations: [{ code: 'LM-STARTUP', date: '2030-01-05',
  time: '10:00', endTime: '11:00', name: '架空 初回試験', tel: '00000000000',
  price: 4000, status: '予約確定', note: '保持するメモ', request: '' }],
closedDates: [], menus: [], coupons: [], settings: { 独自設定: '保持する値' },
stamps: { closed: '0', menus: '0', coupons: '0', settings: '0' }, pendingEditors: ['styles', 'reviews'] });
const functionSource = (source, name) => source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))[0];

function fixture({ visible = false } = {}) {
  const elements = new Map();
  const effects = [];
  const calls = [];
  const previous = startup();
  const context = vm.createContext({ adminData: previous, customerPage: 2, dashboardGeneration: 3,
    pendingBookingFocus: '保持する選択', reservationDetailsRead: '保持する読込', reservationDetailsError: '保持するエラー',
    scopedDetailsReads: new Map([['保持する対象', '保持する読込']]), scopedDetailsErrors: new Map([['保持する対象', '保持するエラー']]),
    pendingEditors: new Set(['styles']), editorReads: new Map([['styles', '保持する読込']]),
    edits: { closed: [], menus: [{ メニュー名: '未保存のメニュー' }], coupons: [], styles: [], reviews: [], settings: {} },
    stamps: { menus: '123456abcdef' }, openRow: { menus: 2, coupons: 1, styles: 1 },
    adminPost: async payload => { calls.push(payload); return context.response; },
    document: { querySelector: () => ({ disabled: false }) },
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, { hidden: selector === '#dashboard' ? !visible : false,
        textContent: '', style: {} });
      return elements.get(selector);
    }, localStorage: { getItem: () => null }, VIEW_KEY: '架空の表示設定',
    markSaved: target => effects.push('saved:' + target),
    showReservationFreshness: () => effects.push('freshness'),
    renderStats: () => effects.push('stats'), renderReservations: () => effects.push('reservations'),
    setReserveView: () => effects.push('view'), renderCustomers: () => effects.push('customers'),
    renderNumbers: () => effects.push('numbers'), renderClosed: () => effects.push('closed'),
    renderList: () => effects.push('list'), showEditorLoading: target => effects.push('editor-loading:' + target),
    redraw: target => effects.push('editor:' + target), renderSettings: () => effects.push('settings'),
    updateDirty: () => effects.push('dirty'),
    AdminNotifications: { start: () => effects.push('notifications') }, restorePhoneBooking: async () => {},
    invalidatePublicMenuCheck: () => effects.push('publication'), alert: message => effects.push({ alert: message })
  });
  vm.runInContext(DATA_SOURCE + '\n' + functionSource(SOURCE, 'openDashboard'), context);
  return { context, elements, effects, calls, previous, send: async result => {
    context.response = result;
    return context.openDashboard();
  } };
}

const invalid = [
  ['予約一覧の欠落', result => { delete result.reservations; }],
  ['予約一覧がobject', result => { result.reservations = {}; }],
  ['休業一覧の欠落', result => { delete result.closedDates; }],
  ['休業一覧がobject', result => { result.closedDates = {}; }],
  ['単品メニューの欠落', result => { delete result.menus; }],
  ['おすすめメニューの欠落', result => { delete result.coupons; }],
  ['設定の欠落', result => { delete result.settings; }],
  ['設定が配列', result => { result.settings = []; }],
  ['更新印の欠落', result => { delete result.stamps; }],
  ['更新印が配列', result => { result.stamps = []; }],
  ['空でない一覧の更新印欠落', result => { delete result.stamps.menus; }],
  ['更新印の空文字', result => { result.stamps.closed = ''; }],
  ['更新印が空白だけ', result => { result.stamps.closed = ' \t\n'; }],
  ['予約番号の重複', result => { result.reservations.push({ ...result.reservations[0] }); }],
  ['予約日時のobject', result => { result.reservations[0].date = {}; }],
  ['予約料金がnull', result => { result.reservations[0].price = null; }],
  ['予約料金が無限大', result => { result.reservations[0].price = Infinity; }],
  ['予約行がnull', result => { result.reservations = [null]; }],
  ['未取得の状態がfalse', result => { result.reservations[0].detailsPending = false; }],
  ['未取得メモの混在', result => { result.reservations[0].detailsPending = true; }],
  ['休業行がnull', result => { result.closedDates = [null]; }],
  ['メニュー行に名前がない', result => { result.menus = [{ 価格: 4000 }]; }],
  ['メニュー行のobject値', result => { result.coupons = [{ メニュー名: { text: '架空メニュー' } }]; }],
  ['設定のobject値', result => { result.settings.独自設定 = {}; }],
  ['設定がnull', result => { result.settings = null; }],
  ['未取得対象がnull', result => { result.pendingEditors = null; }],
  ['未知の未取得対象', result => { result.pendingEditors = ['settings']; }],
  ['未取得対象の重複', result => { result.pendingEditors = ['styles', 'styles']; }],
  ['未取得対象が文字列', result => { result.pendingEditors = 'styles'; }],
  ['完全取得なのに写真欠落', result => { delete result.pendingEditors; }],
  ['未取得の写真を取得済みとして混在', result => { result.styles = []; }],
  ['更新印がobject', result => { result.stamps.settings = {}; }],
  ['機能情報が配列', result => { result.capabilities = []; }],
  ['機能情報の文字列boolean', result => { result.capabilities = { adminChange: 'true' }; }]
];

for (const [label, mutate] of invalid) {
  test(`初回の不完全な応答を空一覧・保存済みとして開かず、既存入力を保持する：${label}`, async () => {
    const app = fixture();
    const before = { edits: structuredClone(app.context.edits), stamps: structuredClone(app.context.stamps),
      openRow: structuredClone(app.context.openRow) };
    const result = startup();
    mutate(result);
    assert.equal(await app.send(result), false);
    assert.equal(app.context.adminData, app.previous);
    assert.equal(app.context.customerPage, 2);
    assert.equal(app.context.dashboardGeneration, 3);
    assert.deepEqual(app.context.edits, before.edits);
    assert.deepEqual(app.context.stamps, before.stamps);
    assert.deepEqual(app.context.openRow, before.openRow);
    assert.equal(app.context.scopedDetailsReads.size, 1);
    assert.equal(app.context.editorReads.size, 1);
    assert.equal(app.elements.get('#dashboard').hidden, true);
    assert.match(app.elements.get('#gate-error').textContent, /読込内容を確認できません/);
    assert.deepEqual(app.effects, []);
    assert.equal(app.calls.length, 1);
  });
}

test('失敗した再読込も画面・下書き・予定を保持し、空一覧や新しい最終読込時刻にしない', async () => {
  const app = fixture({ visible: true });
  const result = startup();
  delete result.menus;
  assert.equal(await app.send(result), false);
  assert.equal(app.context.adminData, app.previous);
  assert.equal(app.elements.get('#dashboard').hidden, false);
  assert.equal(app.effects.length, 1);
  assert.match(app.effects[0].alert, /最新の予定を読み込めませんでした/);
  assert.equal(app.context.edits.menus[0].メニュー名, '未保存のメニュー');
});

test('新しい初回は4編集を遅延し、未取得を保存可能な空一覧へ変換せず、必要な予定は表示する', async () => {
  const result = startup();
  result.pendingEditors = ['menus', 'coupons', 'styles', 'reviews'];
  delete result.menus;
  delete result.coupons;
  delete result.stamps.menus;
  delete result.stamps.coupons;
  const app = fixture();
  assert.equal(await app.send(result), true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls)), [{ type: 'adminData', startupOnly: true, briefPast: true, deferMenus: true }]);
  assert.deepEqual([...app.context.pendingEditors], result.pendingEditors);
  for (const target of result.pendingEditors) {
    assert.ok(app.effects.includes('editor-loading:' + target));
    assert.equal(app.effects.includes('editor:' + target), false);
    assert.equal(app.context.stamps[target], undefined);
  }
  assert.ok(app.effects.includes('reservations'));
  assert.ok(app.effects.includes('closed'));
  assert.ok(app.effects.includes('settings'));
  assert.deepEqual(Object.entries(app.context.stamps), Object.entries(result.stamps));
});

test('正しい空台帳と過去詳細未取得の応答は開け、件数・メモの状態を保持する', async () => {
  for (const brief of [false, true]) {
    const result = startup();
    if (brief) {
      delete result.reservations[0].note;
      delete result.reservations[0].request;
      result.reservations[0].detailsPending = true;
    } else result.reservations = [];
    const app = fixture();
    assert.equal(await app.send(result), true);
    assert.equal(app.context.adminData, result);
    assert.equal(app.elements.get('#dashboard').hidden, false);
    assert.ok(app.effects.includes('notifications'));
    assert.equal(app.calls.length, 1);
  }
});

test('完全な従来応答と単一編集の未取得を両方受け付ける', async () => {
  for (const pending of [undefined, [], ['reviews'], ['styles']]) {
    const result = startup();
    if (pending === undefined) delete result.pendingEditors;
    else result.pendingEditors = pending;
    for (const target of ['styles', 'reviews']) {
      if (pending?.includes(target)) continue;
      result[target] = [];
      result.stamps[target] = '0';
    }
    assert.equal(await fixture().send(result), true);
  }
});

test('シートの空欄・数値・boolean・独自項目と不正日付の文字は読み取り時に削除しない', async () => {
  const result = startup();
  result.settings = { 空欄: '', 数値: 0, 選択: false, 未設定: null, 独自項目: '保持する値' };
  result.reservations[0].date = '実在しない日付';
  result.reservations[0].time = '';
  result.reservations[0].price = -2000;
  result.menus = [{ メニュー名: '架空メニュー', 価格: '4000〜', '所要(分)': '', 表示: false }];
  result.stamps.menus = '123:abc';
  const app = fixture();
  assert.equal(await app.send(result), true);
  assert.equal(app.context.adminData, result);
  assert.deepEqual(Object.entries(app.context.edits.settings), Object.entries(result.settings));
  assert.equal(app.context.edits.menus[0].価格, '4000〜');
  assert.equal(app.context.stamps.menus, result.stamps.menus);
});

test('Google入口は不完全な読込を開かず、本人選択を保って手動再確認できる', async () => {
  const effects = [];
  const result = startup();
  delete result.reservations;
  let reads = 0;
  const context = vm.createContext({ window: { authAdminRequest: async () => { reads++; return result; } },
    user: { email: 'fixture@example.test' }, loginStatus: { textContent: '' }, retryAccessButton: { hidden: true },
    sdk: { signOut: async () => effects.push('sign-out') }, showAdmin: () => effects.push('open'),
    showError: message => effects.push({ error: message }) });
  vm.runInContext(DATA_SOURCE + '\n' + functionSource(PORTAL, 'loadAdmin'), context);
  await context.loadAdmin();
  assert.equal(reads, 1);
  assert.equal(context.retryAccessButton.hidden, false);
  assert.ok(context.user);
  assert.equal(effects.length, 1);
  assert.match(effects[0].error, /読込内容を確認できません/);
  Object.assign(result, startup());
  await context.loadAdmin();
  assert.equal(reads, 2);
  assert.equal(effects[1], 'open');
});
