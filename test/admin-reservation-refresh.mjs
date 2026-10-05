import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const gasSource = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const adminSource = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const dataSource = readFileSync(new URL('../assets/js/admin-data.js', import.meta.url), 'utf8');
const BOOKING = { 予約番号: 'LM-FRESH', 来店日: '2030-01-02', 開始: '10:00', 終了: '11:00',
  お名前: '架空の試験客', 電話番号: "'00000000000", 状態: '予約確定', メニュー: '試験カット',
  担当: '試験担当', 合計金額: 6900, メール: 'example@example.invalid', 施術メモ: '保存したメモ',
  予約の入口: 'LINE', 店舗メール状態: '送信処理受付', お客様メール状態: '送信処理受付' };
const CLIENT_BOOKING = { code: 'LM-FRESH', date: '2030-01-02', time: '10:00', endTime: '11:00',
  name: '架空の試験客', tel: '00000000000', status: '予約確定', price: 6900 };

function gasFixture() {
  const reads = [];
  const rows = new Map();
  const context = vm.createContext({ console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'ADMIN_GOOGLE_ONLY' ? 'true' : '' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: name => {
      reads.push(name);
      assert.ok(['予約一覧', '休業日'].includes(name), '日常更新では編集用シートを読まない');
      const cells = rows.get(name);
      if (!cells) return null;
      return { getLastRow: () => cells.length, getLastColumn: () => cells[0]?.length || 0,
        getRange: (row, column, height = 1, width = 1) => ({ getValues: () =>
          cells.slice(row - 1, row - 1 + height).map(values => values.slice(column - 1, column - 1 + width)) }) };
    } }) }
  });
  vm.runInContext(gasSource, context);
  const headers = Object.keys(BOOKING);
  rows.set('予約一覧', [headers, headers.map(header => BOOKING[header])]);
  rows.set('休業日', [['休業日', '開始', '終了', 'メモ'], ['2030-01-03', '14:00', '16:00', '試験休業']]);
  const request = vm.runInContext('({ reservationsOnly: true, googleAdminContext: GOOGLE_ADMIN_CONTEXT })', context);
  return { context, reads, rows, refresh: () => JSON.parse(JSON.stringify(context.doAdminData_(request))) };
}

test('日常の予定更新は予約と休業だけを読み、編集データ・stampを取得しない', () => {
  const app = gasFixture();
  const before = structuredClone([...app.rows]);
  const result = app.refresh();
  assert.deepEqual(Object.keys(result).sort(), ['closedDates', 'ok', 'reservations']);
  assert.equal(result.ok, true);
  assert.equal(result.reservations.length, 1);
  assert.equal(result.reservations[0].code, 'LM-FRESH');
  assert.equal(result.reservations[0].tel, '00000000000');
  assert.equal(result.reservations[0].note, BOOKING.施術メモ);
  assert.equal(result.reservations[0].source, 'LINE');
  assert.equal(result.reservations[0].price, 6900);
  assert.equal(result.reservations[0].email, BOOKING.メール);
  assert.deepEqual(result.closedDates, [{ 休業日: '2030-01-03', 開始: '14:00', 終了: '16:00', メモ: '試験休業' }]);
  assert.deepEqual([...app.rows], before, '取得ではシートの見出しも設定行も書き換えない');
});

test('軽量な予定更新も、認証前に台帳へアクセスしない', () => {
  const app = gasFixture();
  assert.throws(() => app.context.doAdminData_({ reservationsOnly: true }), /Google|ログイン/);
  assert.deepEqual(app.reads, []);
});

test('日常更新は列の順番と旧形式の任意列を正しく扱い、履歴と取消も残す', () => {
  const app = gasFixture();
  const cells = app.rows.get('予約一覧');
  const headers = ['状態', '電話番号', 'お名前', '終了', '開始', '来店日', '予約番号', '独自列'];
  cells.splice(0, cells.length, headers,
    headers.map(header => BOOKING[header] || '独自値'),
    headers.map(header => ({ ...BOOKING, 予約番号: 'LM-PAST', 来店日: '2029-01-01', 状態: '取り消し' })[header] || '独自値'));
  const result = app.refresh();
  assert.equal(result.ok, true);
  assert.deepEqual(result.reservations.map(row => row.code), ['LM-FRESH', 'LM-PAST']);
  assert.equal(result.reservations[0].menu, '');
  assert.equal(result.reservations[0].note, '');
  assert.equal(result.reservations[0].email, '');
  assert.equal(result.reservations[1].status, 'キャンセル');
});

test('台帳の欠落・空見出し・欠けた列・重複列は予定ゼロの成功にしない', () => {
  for (const corrupt of [
    app => app.rows.delete('予約一覧'),
    app => app.rows.set('予約一覧', []),
    app => app.rows.get('予約一覧')[0].fill(''),
    app => { const cells = app.rows.get('予約一覧'); cells[0][cells[0].indexOf('状態')] = '独自列'; },
    app => { app.rows.get('予約一覧')[0].push('予約番号'); }
  ]) {
    const app = gasFixture();
    corrupt(app);
    const result = app.refresh();
    assert.equal(result.ok, false);
    assert.equal(result.reservations, undefined);
    assert.ok(result.error);
  }
});

test('壊れた休業見出しを休業なしとして反映しない', () => {
  const app = gasFixture();
  app.rows.get('休業日')[0][0] = '不明';
  const result = app.refresh();
  assert.equal(result.ok, false);
  assert.equal(result.closedDates, undefined);
});

test('正常な空台帳と休業シート未作成は、予約・休業とも空で返る', () => {
  const app = gasFixture();
  app.rows.get('予約一覧').length = 1;
  app.rows.delete('休業日');
  assert.deepEqual(app.refresh(), { ok: true, reservations: [], closedDates: [] });
});

function clientFixture(response) {
  const selected = ['validReservationRefresh', 'validAdminChangeResponse', 'validAdminChangeReservation',
    'hasPendingReservationDetails', 'hasUnsavedReservationNotes', 'refreshReservations', 'checkAdminChange'];
  const functions = selected.map(name => {
    const match = adminSource.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    return match ? match[0] : '';
  }).join('\n');
  const status = { textContent: '' };
  const button = { disabled: false };
  const requests = [];
  const reservation = { ...CLIENT_BOOKING };
  const adminData = { reservations: [reservation], closedDates: [{ 休業日: '2030-01-03' }],
    menus: [{ 名称: '入力中メニュー' }], stamps: { closed: 'old-stamp' } };
  const edits = { settings: [{ value: '未保存の設定' }] };
  const context = vm.createContext({ adminData, edits, activeChange: null, dashboardGeneration: 1,
    toMinutes: value => { const parts = value.split(':').map(Number); return parts[0] * 60 + parts[1]; },
    isCancelled: row => row.status === 'キャンセル',
    pendingNoteSaves: new Set(), $: selector => selector === '#reservation-freshness' ? status : button,
    $$: () => [], adminPost: async request => { requests.push(request); return response; },
    renderStats() {}, renderReservations() {}, renderAdminCalendar() {}, renderCustomers() {}, renderNumbers() {},
    showReservationFreshness: () => { status.textContent = '最終読込'; },
    showChangedReservation: () => { context.activeChange = null; }
  });
  vm.runInContext(dataSource + '\n' + functions, context);
  const checkButton = { disabled: false, closest: () => ({ querySelector: () => status }) };
  return { context, requests, status, button, adminData, edits, checkButton };
}

test('予約の更新は軽量取得を使い、編集中の設定・メニューとstampを保持する', async () => {
  const app = clientFixture({ ok: true, reservations: [{ ...CLIENT_BOOKING, code: 'LM-NEW' }], closedDates: [] });
  const menus = app.adminData.menus;
  const stamps = app.adminData.stamps;
  await app.context.refreshReservations();
  assert.deepEqual(JSON.parse(JSON.stringify(app.requests)), [{ type: 'adminData', reservationsOnly: true }]);
  assert.equal(app.adminData.reservations[0].code, 'LM-NEW');
  assert.deepEqual(app.adminData.closedDates, []);
  assert.equal(app.adminData.menus, menus);
  assert.equal(app.adminData.stamps, stamps);
  assert.equal(app.context.edits, app.edits);
  assert.equal(app.button.disabled, false);
});

test('詳細未取得の起動データを更新する場合だけ軽量な過去詳細を指定し、件数を保持する', async () => {
  const rows = [{ ...CLIENT_BOOKING, detailsPending: true }, { ...CLIENT_BOOKING, code: 'LM-NEW', note: '', request: '' }];
  const app = clientFixture({ ok: true, reservations: rows, closedDates: [] });
  app.adminData.reservations[0].detailsPending = true;
  const menus = app.adminData.menus;
  await app.context.refreshReservations();
  assert.deepEqual(JSON.parse(JSON.stringify(app.requests)), [{ type: 'adminData', reservationsOnly: true, briefPast: true }]);
  assert.equal(app.adminData.reservations.length, 2);
  assert.equal(app.adminData.reservations[0].detailsPending, true);
  assert.equal(app.adminData.menus, menus);
});

for (const reason of ['電話予約追加', '保存済みメモ', '休業日の追加', '休業日配列の入替', '再ログイン']) {
  test(`予定の再読込中の${reason}を遅い応答で巻き戻さない`, async () => {
    const app = clientFixture();
    let finishRead;
    app.context.adminPost = () => new Promise(resolve => { finishRead = resolve; });
    const reading = app.context.refreshReservations();
    if (reason === '電話予約追加') app.adminData.reservations.push({ ...CLIENT_BOOKING, code: 'LM-PHONE' });
    if (reason === '保存済みメモ') app.adminData.reservations[0].note = '通信中に保存したメモ';
    if (reason === '休業日の追加') app.adminData.closedDates.push({ 休業日: '2030-01-04' });
    if (reason === '休業日配列の入替') app.adminData.closedDates = [{ 休業日: '2030-01-05' }];
    if (reason === '再ログイン') {
      app.context.dashboardGeneration++;
      app.adminData.reservations = [{ ...CLIENT_BOOKING, code: 'LM-LOGIN' }];
      app.status.textContent = '新しいログイン後の表示';
    }
    const snapshot = structuredClone(app.adminData);
    finishRead({ ok: true, reservations: [{ ...CLIENT_BOOKING, code: 'LM-OLD' }], closedDates: [] });
    assert.equal(await reading, undefined);
    assert.deepEqual(app.adminData, snapshot);
    assert.match(app.status.textContent, reason === '再ログイン' ? /新しいログイン後/ : /更新を保留/);
    assert.equal(app.button.disabled, false);
  });
}

test('前のログインの読込失敗で、新しいログインの案内を上書きしない', async () => {
  const app = clientFixture();
  let failRead;
  app.context.adminPost = () => new Promise((resolve, reject) => { failRead = reject; });
  const reading = app.context.refreshReservations();
  app.context.dashboardGeneration++;
  app.status.textContent = '新しいログイン後の表示';
  failRead(new Error('架空の通信障害'));
  await reading;
  assert.equal(app.status.textContent, '新しいログイン後の表示');
  assert.equal(app.button.disabled, false);
});

test('欠けた取得応答で表示中の予約・休業を消さず、再確認を案内する', async () => {
  for (const response of [null, { ok: true }, { ok: true, reservations: null, closedDates: [] },
    { ok: true, reservations: [], closedDates: null }, { ok: true, reservations: [null], closedDates: [] },
    { ok: true, reservations: [23], closedDates: [] }, { ok: true, reservations: [{}], closedDates: [] },
    { ok: true, reservations: [], closedDates: [null] }]) {
    const app = clientFixture(response);
    const before = structuredClone(app.adminData);
    await app.context.refreshReservations();
    assert.deepEqual(app.adminData, before);
    assert.match(app.status.textContent, /取得できません|確認できません/);
    assert.equal(app.button.disabled, false);
  }
});

test('日時変更の結果確認も軽量取得で行い、編集中データを再取得しない', async () => {
  const app = clientFixture({ ok: true, reservations: [{ ...CLIENT_BOOKING, date: '2030-01-04', time: '14:00', endTime: '15:00',
    menu: '試験カット', staffName: '試験担当', email: 'example@example.invalid', visit: '', source: '',
    request: '', note: '保存したメモ', shopMailStatus: '', customerMailStatus: '' }], closedDates: [] });
  app.context.activeChange = { code: 'LM-FRESH', date: '2030-01-04', time: '14:00',
    fromTime: '10:00', fromEndTime: '11:00', pending: false };
  await app.context.checkAdminChange(app.checkButton);
  assert.deepEqual(JSON.parse(JSON.stringify(app.requests)), [{ type: 'adminData', reservationsOnly: true }]);
  assert.equal(app.context.activeChange, null);
  assert.equal(app.adminData.reservations[0].time, '14:00');
});

for (const reason of ['電話予約追加', '休業日の保存', '再ログイン']) {
  test(`日時変更の確認中の${reason}を古い照会結果で上書きしない`, async () => {
    const app = clientFixture();
    let finishRead;
    app.context.adminPost = () => new Promise(resolve => { finishRead = resolve; });
    app.context.activeChange = { code: 'LM-FRESH', date: '2030-01-04', time: '14:00', pending: false, uncertain: true };
    const reading = app.context.checkAdminChange(app.checkButton);
    if (reason === '電話予約追加') app.adminData.reservations.push({ ...CLIENT_BOOKING, code: 'LM-PHONE' });
    if (reason === '休業日の保存') app.adminData.closedDates = [{ 休業日: '2030-01-05' }];
    if (reason === '再ログイン') {
      app.context.dashboardGeneration++;
      app.context.activeChange = null;
      app.adminData.reservations = [{ ...CLIENT_BOOKING, code: 'LM-LOGIN' }];
      app.status.textContent = '新しいログイン後の表示';
    }
    const snapshot = structuredClone(app.adminData);
    finishRead({ ok: true, reservations: [{ ...CLIENT_BOOKING, date: '2030-01-04', time: '14:00' }], closedDates: [] });
    await reading;
    assert.deepEqual(app.adminData, snapshot);
    assert.match(app.status.textContent, reason === '再ログイン' ? /新しいログイン後/ : /更新を保留/);
    if (reason !== '再ログイン') {
      assert.equal(app.context.activeChange.uncertain, true);
      assert.equal(app.context.activeChange.pending, false);
    }
    assert.equal(app.checkButton.disabled, false);
  });
}

test('日時変更の確認接続が例外でも結果未確認の操作を残し、確認ボタンへ復帰する', async () => {
  const app = clientFixture();
  app.context.activeChange = { code: 'LM-FRESH', date: '2030-01-04', time: '14:00', pending: false, uncertain: true };
  app.context.adminPost = async () => { throw new Error('架空の接続障害'); };
  await app.context.checkAdminChange(app.checkButton);
  assert.equal(app.context.activeChange.pending, false);
  assert.equal(app.context.activeChange.uncertain, true);
  assert.equal(app.checkButton.disabled, false);
  assert.match(app.status.textContent, /台帳を確認できません/);
});

test('日時変更の取得応答が壊れても未確認の操作を解除せず、再送を促さない', async () => {
  const app = clientFixture({ ok: true, reservations: [null], closedDates: [] });
  app.context.activeChange = { code: 'LM-FRESH', date: '2030-01-04', time: '14:00', pending: false, uncertain: true };
  const before = structuredClone(app.adminData);
  await app.context.checkAdminChange(app.checkButton);
  assert.deepEqual(app.adminData, before);
  assert.equal(app.context.activeChange.uncertain, true);
  assert.equal(app.context.activeChange.pending, false);
  assert.match(app.status.textContent, /確認できません/);
  assert.equal(app.checkButton.disabled, false);
});
