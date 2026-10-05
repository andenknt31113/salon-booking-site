import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const PASSWORD = process.env.MOCK_ADMIN_PASSWORD;
assert.ok(PASSWORD, 'MOCK_ADMIN_PASSWORD が必要です');
const TARGETS = ['menus', 'coupons', 'styles', 'reviews', 'closed', 'settings'];

function fixture({ native = true, google = true } = {}) {
  let held = false;
  let fault;
  const effects = [];
  const sheets = new Map();
  const properties = new Map([['ADMIN_PASSWORD', PASSWORD]]);
  const signal = event => { assert.equal(held, true); effects.push(event); fault?.(event); };
  const spreadsheet = { getSheetByName(name) { signal({ name, operation: 'open' }); return sheets.get(name); },
    insertSheet() { assert.fail('保存対象以外のシートは作成しない'); } };
  const context = vm.createContext({ Date, console: { error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null,
      setProperty: (key, value) => properties.set(key, value), deleteProperty: key => properties.delete(key) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush: () => signal({ operation: 'flush' }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    Utilities: { DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      formatDate(date, timezone, pattern) {
        assert.equal(timezone, 'Asia/Tokyo');
        const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();
        if (pattern === 'yyyy-MM-dd') return shifted.slice(0, 10);
        assert.equal(pattern, 'HH:mm');
        return shifted.slice(11, 16);
      },
      computeDigest: (algorithm, value, charset) => Array.from(createHash(algorithm).update(value, charset).digest()) }
  });
  vm.runInContext(SOURCE, context);
  context.verifyGoogleAdmin_ = () => assert.equal(held, false, '本人確認中は台帳をロックしない');
  const targets = vm.runInContext('SAVE_TARGETS', context);
  const headers = vm.runInContext('({menus:MENU_HEADERS,coupons:COUPON_HEADERS,styles:STYLE_HEADERS,reviews:REVIEW_HEADERS,closed:CLOSED_HEADERS,settings:["項目","内容"]})', context);
  for (const target of TARGETS) {
    const cells = [Array.from(headers[target])];
    if (target === 'reviews') cells.push(Array.from(headers[target]).map(header => ({
      投稿日: '2030-01-01', 予約番号: 'LM-FIXTURE', 本文: '架空の元の言葉', 状態: '未承認'
    })[header] ?? ''));
    const name = targets[target];
    const sheet = { cells, getLastRow: () => cells.length, getLastColumn: () => Math.max(...cells.map(row => row.length)),
      getRange(row, column, height = 1, width = 1) {
        return {
          getValues() {
            signal({ name, operation: 'read' });
            return Array.from({ length: height }, (_unused, rowOffset) =>
              Array.from({ length: width }, (_value, columnOffset) => cells[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? ''));
          },
          getFormulas() { signal({ name, operation: 'formulas' }); return Array.from({ length: height }, () => Array(width).fill('')); },
          setValues(values) {
            signal({ name, operation: 'write' });
            values.forEach((line, rowOffset) => line.forEach((value, columnOffset) => {
              cells[row - 1 + rowOffset] ||= [];
              cells[row - 1 + rowOffset][column - 1 + columnOffset] = value;
            }));
          }
        };
      }
    };
    if (native) sheet.getDataRange = () => sheet.getRange(1, 1, cells.length, sheet.getLastColumn());
    sheets.set(name, sheet);
  }
  const rows = {
    menus: [{ 区分: 'カット', メニュー名: '架空カット', 価格: 4000, '所要(分)': 60, 表示: '表示' }],
    coupons: [{ メニュー名: '架空コース', 価格: 6000, '所要(分)': 90, 表示: '表示' }],
    styles: [{ タイトル: '架空スタイル', 表示: '表示' }],
    reviews: [{ 予約番号: 'LM-FIXTURE', 状態: '非掲載' }], closed: [{ 休業日: '2030-01-05', 開始: '', 終了: '', メモ: '架空の休業' }],
    settings: { 営業開始: '10:00' }
  };
  const send = (target, overrides = {}) => {
    const name = targets[target];
    const stamp = context.stampValues_(sheets.get(name).cells);
    const payload = { target, rows: structuredClone(rows[target]), stamp, ...overrides };
    const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify(google
      ? { type: 'googleAdmin', action: 'adminSave', payload }
      : { type: 'adminSave', password: PASSWORD, ...payload }) } }));
    assert.equal(held, false, '成功・失敗の応答後にロックを残さない');
    return result;
  };
  return { context, effects, sheets, targets, send, setFault: callback => { fault = callback; } };
}

for (const native of [true, false]) {
  for (const google of [true, false]) {
    for (const target of TARGETS) {
      test(`${native ? 'native' : 'fallback'}・${google ? 'Google' : '既存API'}・${target}：対象だけの保存確認は別シートに触れない`, () => {
        const app = fixture({ native, google });
        const before = new Map(Array.from(app.sheets, ([name, sheet]) => [name, structuredClone(sheet.cells)]));
        const result = app.send(target, { stampScope: 'target' });
        assert.equal(result.ok, true);
        assert.deepEqual(Object.keys(result.stamps), [target]);
        assert.equal(result.stamps[target], app.context.stampValues_(app.sheets.get(app.targets[target]).cells));
        assert.ok(app.effects.some(event => event.operation === 'flush'));
        assert.ok(app.effects.filter(event => event.name).every(event => event.name === app.targets[target]));
        for (const [name, cells] of before) if (name !== app.targets[target]) assert.deepEqual(app.sheets.get(name).cells, cells);
        const again = app.send(target, { stampScope: 'target', stamp: result.stamps[target] });
        assert.equal(again.ok, true, '保存後の印で次の保存もできる');
      });
    }
  }
}

for (const stampScope of [undefined, 'all', 'TARGET', null, true, {}]) {
  test(`旧API互換：${JSON.stringify(stampScope)}は六対象の印を返す`, () => {
    const app = fixture();
    const result = app.send('menus', { stampScope });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.stamps), TARGETS);
    for (const target of TARGETS) assert.equal(result.stamps[target], app.context.stampValues_(app.sheets.get(app.targets[target]).cells));
  });
}

test('無関係な写真シートの読込障害で、休業日の保存結果を失敗へ変えない', () => {
  const app = fixture();
  app.setFault(event => { if (event.name === app.targets.styles && event.operation === 'read') throw new Error('架空の読込障害'); });
  const result = app.send('closed', { stampScope: 'target' });
  assert.equal(result.ok, true);
  assert.equal(app.sheets.get(app.targets.closed).cells[1][0], '2030-01-05');
  assert.deepEqual(Object.keys(result.stamps), ['closed']);
});

test('対象の印を保存後に読めない場合は成功を返さず、無関係な対象を読み込まない', () => {
  const app = fixture();
  let flushed = false;
  app.setFault(event => {
    if (event.operation === 'flush') flushed = true;
    if (flushed && event.operation === 'read') throw new Error('架空の確認障害');
  });
  const result = app.send('closed', { stampScope: 'target' });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, true);
  assert.match(result.error, /保存を繰り返さず/);
  assert.equal(result.stamps, undefined);
  assert.ok(app.effects.filter(event => event.name).every(event => event.name === app.targets.closed));
  assert.equal(app.sheets.get(app.targets.closed).cells[1][0], '2030-01-05', '確認障害を未保存とは決めつけない');
});

test('対象だけの印を要求しても競合・入力・認証の保護を省略しない', () => {
  for (const overrides of [{ stamp: '古い印' }, { rows: null },
    { rows: [{ 休業日: '2030-02-30', 開始: '', 終了: '' }] }]) {
    const app = fixture();
    assert.equal(app.send('closed', { stampScope: 'target', ...overrides }).ok, false);
    assert.equal(app.effects.some(event => event.operation === 'write'), false);
  }
  const app = fixture();
  app.context.verifyGoogleAdmin_ = () => { throw new Error('架空の本人確認拒否'); };
  const result = app.send('closed', { stampScope: 'target' });
  assert.equal(result.ok, false);
  assert.equal(result.authDenied, true);
  assert.deepEqual(app.effects, []);
});

const CLOSED_DATE = new Date('2030-01-04T15:00:00Z');

for (const native of [true, false]) {
  for (const google of [true, false]) {
    const label = `${native ? 'native' : 'fallback'}・${google ? 'Google' : '既存API'}`;
    for (const target of ['closed', 'settings']) {
      for (const dateToText of [true, false]) {
        test(`${label}・${target}：同じJSONになる日付セル・ISO文字列への変更も競合として断り、別端末の内容を消さない：${dateToText}`, () => {
          const app = fixture({ native, google });
          const sheet = app.sheets.get(app.targets[target]);
          const value = dateToText ? CLOSED_DATE : CLOSED_DATE.toISOString();
          const initial = target === 'closed' ? { 休業日: value, 開始: '', 終了: '', メモ: '他端末の内容' }
            : { 項目: '営業開始', 内容: value };
          sheet.cells.push(Array.from(sheet.cells[0], header => initial[header] ?? ''));
          const column = sheet.cells[0].indexOf(target === 'closed' ? '休業日' : '内容');
          const spreadsheet = { getSheetByName: () => sheet };
          const stamp = app.context.stampValues_(sheet.cells);
          const display = () => app.context.withLedgerLock_(() => target === 'closed'
            ? app.context.readSheetRows_(spreadsheet, app.targets[target], sheet.cells[0])[0]['休業日']
            : app.context.readSettings_(spreadsheet)['営業開始']);
          const beforeValue = display();
          sheet.cells[1][column] = dateToText ? CLOSED_DATE.toISOString() : new Date(CLOSED_DATE.getTime());
          assert.notEqual(display(), beforeValue, 'セル型の変更は表示する内容も変える');
          const changed = structuredClone(sheet.cells);
          const result = app.send(target, { stampScope: 'target', stamp });
          assert.equal(result.ok, false);
          assert.equal(result.stale, true);
          assert.match(result.error, /変更されています/);
          assert.deepEqual(sheet.cells, changed);
          assert.equal(app.effects.some(event => ['write', 'flush', 'formulas'].includes(event.operation)), false);
        });
      }
    }

    test(`${label}：古い日付セルの印は上書きせず、新しく取得した印なら保存して再保存できる`, () => {
      const app = fixture({ native, google });
      const sheet = app.sheets.get(app.targets.closed);
      sheet.cells.push(Array.from(sheet.cells[0], header => ({
        休業日: CLOSED_DATE, 開始: '', 終了: '', メモ: '日付セルの休業'
      })[header] ?? ''));
      const legacyStamp = createHash('md5').update(JSON.stringify(sheet.cells)).digest('hex').slice(0, 12);
      const before = structuredClone(sheet.cells);
      const outdated = app.send('closed', { stampScope: 'target', stamp: legacyStamp });
      assert.equal(outdated.ok, false);
      assert.equal(outdated.stale, true);
      assert.deepEqual(sheet.cells, before);
      assert.equal(app.effects.some(event => event.operation === 'write'), false);
      const latestStamp = app.context.withLedgerLock_(() => app.context.sheetStamp_(
        { getSheetByName: () => sheet }, app.targets.closed));
      const saved = app.send('closed', { stampScope: 'target', stamp: latestStamp });
      assert.equal(saved.ok, true);
      assert.match(saved.stamps.closed, /^[a-f0-9]{12}$/);
      assert.equal(app.send('closed', { stampScope: 'target', stamp: saved.stamps.closed }).ok, true);
    });
  }
}
