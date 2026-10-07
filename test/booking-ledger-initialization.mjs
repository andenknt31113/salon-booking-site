import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const OPERATIONS = { reserve: 'doReserve_', cancel: 'doCancel_', change: 'doChange_',
  review: 'doReview_', adminAdd: 'doAdminAdd_', adminAddStatus: 'doAdminAddStatus_',
  adminNote: 'doAdminNote_', adminChange: 'doAdminChange_' };
const GOOGLE_OPERATIONS = ['adminAdd', 'adminAddStatus', 'adminNote', 'adminChange', 'cancel'];

function fixture({ shape = 'missing', authorized = true, unavailable = false } = {}) {
  const effects = [];
  const operations = [];
  const properties = new Map();
  let held = false;
  let exists = shape !== 'missing';
  let cells = [];
  const context = vm.createContext({ Date, console: { error() {}, warn() {}, log() {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) ?? null,
      setProperty(key, value) { effects.push(`property:${key}`); properties.set(key, value); },
      deleteProperty: key => properties.delete(key)
    }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  vm.runInContext(SOURCE, context);
  const headers = Array.from(vm.runInContext('HEADERS', context));
  if (shape === 'ready') cells = [headers.slice()];
  const before = structuredClone(cells);
  const range = (row, column, numRows = 1, numColumns = 1) => {
    const api = {
      getValues: () => Array.from({ length: numRows }, (_unused, rowIndex) =>
        Array.from({ length: numColumns }, (_value, columnIndex) =>
          cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? '')),
      setValues(values) {
        effects.push('values');
        values.forEach((valuesRow, rowIndex) => valuesRow.forEach((value, columnIndex) => {
          cells[row - 1 + rowIndex] ||= [];
          cells[row - 1 + rowIndex][column - 1 + columnIndex] = value;
        }));
        return api;
      },
      setFontWeight() { effects.push('format'); return api; },
      setBackground() { effects.push('format'); return api; }
    };
    return api;
  };
  const sheet = { getLastRow: () => cells.length,
    getLastColumn: () => Math.max(0, ...cells.map(row => row.length)),
    getRange: range,
    appendRow(values) { effects.push('append'); cells.push(Array.from(values)); },
    setFrozenRows() { effects.push('format'); }, setColumnWidth() { effects.push('format'); },
    getParent: () => spreadsheet };
  const spreadsheet = {
    getSheetByName(name) {
      if (unavailable) throw new Error('試験用の台帳取得失敗');
      return name === '予約一覧' && exists ? sheet : null;
    },
    insertSheet(name) { assert.equal(name, '予約一覧'); effects.push('insert'); exists = true; return sheet; }
  };
  context.SpreadsheetApp = { getActiveSpreadsheet: () => spreadsheet };
  for (const handler of Object.values(OPERATIONS)) context[handler] = () => {
    assert.equal(held, true);
    operations.push(handler);
    return { ok: true };
  };
  context.requireAdmin_ = () => { if (!authorized) throw new Error('試験用の認証拒否'); };
  context.verifyGoogleAdmin_ = () => {
    assert.equal(held, false);
    if (!authorized) throw new Error('試験用の認証拒否');
  };
  context.ensureSettingRows_ = () => { effects.push('settings-initialize'); return 0; };
  context.bookingEmailSummary_ = () => ({});
  context.bookingEmailSheet_ = () => { effects.push('delivery-sheet'); return {}; };
  context.currentBookingEmailJobs_ = () => { effects.push('delivery-jobs'); return {}; };
  context.setupMenuSheets = () => { effects.push('menu-setup'); };
  context.notifyList_ = () => [];
  context.readSettings_ = () => ({});
  return { context, properties, effects, operations, headers, before, cells: () => structuredClone(cells),
    held: () => held, exists: () => exists,
    send: request => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(request) } })) };
}

for (const shape of ['missing', 'empty']) {
  for (const type of Object.keys(OPERATIONS)) {
    test(`${shape}台帳で${type}を受けても空台帳を作らず、処理本体へ進まない`, () => {
      const app = fixture({ shape });
      const result = app.send({ type, initialize: true });
      assert.equal(result.ok, false);
      assert.match(result.error, /予約台帳.*確認できません/);
      assert.deepEqual(app.operations, []);
      assert.deepEqual(app.effects, []);
      assert.deepEqual(app.cells(), app.before);
      assert.equal(app.held(), false);
    });
  }
  for (const action of GOOGLE_OPERATIONS) {
    test(`Google管理の${action}でも${shape}台帳を自動で作り直さない`, () => {
      const app = fixture({ shape });
      const result = app.send({ type: 'googleAdmin', action, payload: { initialize: true } });
      assert.equal(result.ok, false);
      assert.match(result.error, /予約台帳.*確認できません/);
      assert.deepEqual(app.operations, []);
      assert.deepEqual(app.effects, []);
      assert.deepEqual(app.cells(), app.before);
      assert.equal(app.held(), false);
    });
  }
  test(`管理初回の読込で${shape}台帳や設定を補完せず、空の予約一覧と返さない`, () => {
    const app = fixture({ shape });
    const result = app.send({ type: 'googleAdmin', action: 'adminData', payload: { startupOnly: true } });
    assert.equal(result.ok, false);
    assert.match(result.error, /予約台帳.*確認できません/);
    assert.equal(result.reservations, undefined);
    assert.deepEqual(app.effects, []);
    assert.deepEqual(app.cells(), app.before);
    assert.equal(app.held(), false);
  });
  for (const worker of ['deliverBookingEmails', 'claimBookingEmail_']) {
    test(`${worker}が${shape}台帳を作り直して配送が正常だと記録しない`, () => {
      const app = fixture({ shape });
      app.properties.set('BOOKING_EMAIL_QUEUE_ENABLED', 'true');
      app.properties.set('BOOKING_EMAIL_WORK_PENDING', 'true');
      assert.throws(() => worker === 'deliverBookingEmails' ? app.context[worker]()
        : app.context[worker]('LM-INITIAL', 'fixture-delivery', 'customer'), /予約台帳.*確認できません/);
      assert.deepEqual(app.effects, []);
      assert.deepEqual(app.cells(), app.before);
      assert.equal(app.held(), false);
    });
  }
  test(`明示的なはじめの準備だけは${shape}台帳を作成できる`, () => {
    const app = fixture({ shape });
    app.context.はじめの準備();
    assert.equal(app.exists(), true);
    assert.deepEqual(app.cells(), [app.headers]);
    assert.equal(app.effects.filter(effect => effect === 'append').length, 1);
    assert.equal(app.effects.includes('menu-setup'), true);
    assert.deepEqual(app.operations, []);
  });
}

test('準備済みの空予約一覧は通常どおり使い、初期化し直さない', () => {
  for (const type of Object.keys(OPERATIONS)) {
    const app = fixture({ shape: 'ready' });
    assert.equal(app.send({ type }).ok, true);
    assert.deepEqual(app.operations, [OPERATIONS[type]]);
    assert.deepEqual(app.effects, []);
    assert.deepEqual(app.cells(), app.before);
  }
});

test('初期化の値を要求へ混ぜても、未対応の操作から準備を実行できない', () => {
  for (const type of ['initialize', 'はじめの準備']) {
    const app = fixture();
    assert.equal(app.send({ type, initialize: true }).invalid, true);
    assert.deepEqual(app.effects, []);
    assert.deepEqual(app.operations, []);
  }
});

test('Google・旧管理の認証拒否で台帳を初期化しない', () => {
  for (const request of [{ type: 'adminAdd' }, { type: 'googleAdmin', action: 'adminAdd', payload: {} }]) {
    const app = fixture({ authorized: false });
    assert.equal(app.send(request).ok, false);
    assert.deepEqual(app.effects, []);
    assert.deepEqual(app.operations, []);
    assert.equal(app.held(), false);
  }
});

test('台帳取得失敗を空台帳へすり替えず、そのまま処理を止める', () => {
  const app = fixture({ unavailable: true });
  assert.equal(app.send({ type: 'reserve' }).ok, false);
  assert.deepEqual(app.effects, []);
  assert.deepEqual(app.operations, []);
  assert.equal(app.held(), false);
});

test('省略された予約操作も台帳消失を正常な初回受付へすり替えない', () => {
  const app = fixture();
  const result = app.send({ code: 'LM-INITIAL', initialize: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /予約台帳.*確認できません/);
  assert.deepEqual(app.effects, []);
  assert.deepEqual(app.operations, []);
  assert.equal(app.held(), false);
});
