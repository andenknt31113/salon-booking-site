import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const REQUEST = { type: 'reserve', code: 'LM-BATCH', date: '2030-01-05', time: '10:00',
  totalMinutes: 60, totalPrice: 4000, menus: [{ id: 'sm0', name: '試験カット', price: 4000, minutes: 60 }],
  staffId: 'st01', staffName: 'MATTEO',
  customer: { name: '読込試験', kana: 'ヨミコミシケン', tel: '00000000000', email: 'customer@example.test' } };
const PREVIOUS = { 予約番号: 'LM-BEFORE', 来店日: '2030-01-06', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 担当ID: 'st01', 状態: '予約確定', 電話番号: '00000000000', 独自列: '維持する' };

function fixture({ queue = false, records = [PREVIOUS], headers: initialHeaders,
  failure = '', random = Math.random, native = false, createLedger = false } = {}) {
  let held = false;
  let appended = false;
  const calls = [];
  const effects = [];
  const sheets = new Map();
  const properties = new Map();
  const assertHeld = () => assert.equal(held, true, '最新の検査・保存は同じ台帳ロックの内側');
  const makeSheet = (name, headers, rows = []) => {
    const cells = [Array.from(headers), ...rows.map(row => headers.map(header => row[header] ?? ''))];
    const sheet = { cells, getParent: () => spreadsheet,
      getLastRow() { assertHeld(); calls.push({ name, method: 'lastRow' }); return cells.length; },
      getLastColumn() { assertHeld(); calls.push({ name, method: 'lastColumn' }); return Math.max(...cells.map(row => row.length)); },
      getRange(row, column, numRows = 1, numColumns = 1) {
        assertHeld();
        calls.push({ name, method: 'range' });
        const range = { getValues() {
          assertHeld();
          calls.push({ name, method: 'values', row, column, numRows, numColumns, appended });
          if (name === '予約一覧' && failure === 'snapshot' && row === 1 && numRows > 1) throw new Error('試験用の読込失敗');
          const values = Array.from({ length: numRows }, (_unused, rowIndex) =>
            Array.from({ length: numColumns }, (_value, columnIndex) => cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
          if (name === '予約一覧' && appended && row > 1 && failure === 'readback') values[0][headers.indexOf('開始')] = '18:00';
          return values;
        }, setValues(values) {
          assertHeld();
          values.forEach((valuesRow, rowIndex) => valuesRow.forEach((value, columnIndex) => {
            cells[row - 1 + rowIndex] ||= [];
            cells[row - 1 + rowIndex][column - 1 + columnIndex] = value;
          }));
          return range;
        }, setFontWeight: () => range, setBackground: () => range };
        return range;
      }, appendRow(values) {
        assertHeld();
        const initializing = name === '予約一覧' && cells.length === 0;
        effects.push(initializing ? 'header' : name === '予約一覧' ? 'booking' : 'queue');
        if (name === '予約一覧' && !initializing) appended = true;
        cells.push(Array.from(values));
      }, setFrozenRows() {}, setColumnWidth() {} };
    if (native) sheet.getDataRange = () => sheet.getRange(1, 1,
      Math.max(1, cells.length), Math.max(1, ...cells.map(row => row.length)));
    sheets.set(name, sheet);
    return sheet;
  };
  const spreadsheet = { getSheetByName(name) { assertHeld(); return sheets.get(name) || null; },
    insertSheet(name) {
      assertHeld();
      assert.equal(createLedger, true, '不要なシート作成');
      assert.equal(name, '予約一覧');
      effects.push('create');
      const created = makeSheet(name, []);
      created.cells.length = 0;
      return created;
    } };
  const context = vm.createContext({ Date, Math: Object.create(Math),
    console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null,
      setProperty: (key, value) => properties.set(key, value) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {
      assertHeld(); effects.push('flush');
      if (appended && failure === 'flush') throw new Error('試験用の反映失敗');
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    Utilities: { getUuid: randomUUID, formatDate: () => '2030-01-01' },
    MailApp: { sendEmail() { assertHeld(); effects.push('mail'); } },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assertHeld(); held = false; } }) } });
  context.Math.random = random;
  vm.runInContext(SOURCE, context);
  const canonical = Array.from(vm.runInContext('HEADERS', context));
  const headers = initialHeaders || ['独自列', ...canonical].reverse();
  const ledger = makeSheet('予約一覧', headers, records);
  makeSheet('設定', ['項目', '内容'], Object.entries({ 準備中の帯: '出さない', 営業開始: '09:00',
    営業終了: '20:00', 最終受付: '19:00', 定休曜日: '', 通知先メール: 'shop@example.test' })
    .map(([項目, 内容]) => ({ 項目, 内容 })));
  makeSheet('メニュー', Array.from(vm.runInContext('MENU_HEADERS', context)),
    [{ 区分: 'カット', メニュー名: '試験カット', 価格: 4000, '所要(分)': 60, 表示: '表示' }]);
  makeSheet('おすすめメニュー', Array.from(vm.runInContext('COUPON_HEADERS', context)));
  makeSheet('休業日', Array.from(vm.runInContext('CLOSED_HEADERS', context)));
  if (queue) {
    makeSheet(vm.runInContext('BOOKING_EMAIL_SHEET', context), Array.from(vm.runInContext('BOOKING_EMAIL_HEADERS', context)));
    properties.set(vm.runInContext('BOOKING_EMAIL_ENABLED', context), 'true');
    properties.set(vm.runInContext('BOOKING_EMAIL_HEARTBEAT', context), String(Date.now()));
  }
  context.todayKey_ = () => '2030-01-01';
  context.nowMinJst_ = () => 9 * 60;
  context.recordMailStatus_ = () => {};
  return { context, ledger, sheets, headers, calls, effects, held: () => held,
    send: (changes = {}) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ ...REQUEST, ...changes }) } })) };
}

for (const queue of [false, true]) {
  test(`新規予約は見出しと予約の一括取得・保存読戻しの2取得にまとめる（後送${queue ? 'あり' : 'なし'}）`, () => {
    const app = fixture({ queue });
    assert.equal(app.send().ok, true);
    const reads = app.calls.filter(call => call.name === '予約一覧' && call.method === 'values');
    assert.equal(reads.length, 2);
    assert.equal(reads[0].row, 1);
    assert.equal(reads[0].numRows, 2);
    assert.equal(reads[0].appended, false);
    assert.equal(reads[1].row, 3);
    assert.equal(reads[1].appended, true);
    assert.ok(app.effects.indexOf('flush') > -1);
    assert.equal(app.ledger.cells[1][app.headers.indexOf('独自列')], '維持する');
    assert.equal(app.ledger.cells[2][app.headers.indexOf('開始')], REQUEST.time);
    assert.equal(app.effects.includes('mail'), !queue);
    assert.equal(app.held(), false);
  });
}

test('同じ番号の再送は一括読込から照合し、料金変更後も保存済みの予約を二重作成しない', () => {
  const app = fixture({ queue: true });
  assert.equal(app.send().ok, true);
  app.sheets.get('メニュー').cells[1][2] = 5000;
  app.calls.length = 0;
  assert.equal(app.send().duplicate, true);
  assert.equal(app.ledger.cells.length, 3);
  assert.equal(app.effects.filter(effect => effect === 'queue').length, 1);
  assert.equal(app.calls.filter(call => call.name === '予約一覧' && call.method === 'values').length, 1);
  assert.equal(app.calls.some(call => call.name === 'メニュー'), false);
  assert.equal(app.held(), false);
});

test('次の要求で新しい予約・取消・並べ替えを読み直し、前の空席を使い回さない', () => {
  const app = fixture();
  assert.equal(app.send().ok, true);
  assert.equal(app.send({ code: 'LM-TAKEN', reservationSnapshot: { head: [], rows: [] } }).taken, true);
  app.ledger.cells[2][app.headers.indexOf('状態')] = 'キャンセル';
  assert.equal(app.send({ code: 'LM-FREED' }).ok, true);
  app.ledger.cells.forEach(row => row.reverse());
  assert.equal(app.send({ code: 'LM-CHANGED' }).taken, true);
  assert.equal(app.ledger.cells.length, 4);
  assert.equal(app.held(), false);
});

test('予約番号の重複・取消済み番号・同じ番号の内容変更を成功と誤認しない', () => {
  const duplicated = fixture({ records: [PREVIOUS, { ...PREVIOUS, 予約番号: 'ＬＭ－ｂｅｆｏｒｅ' }] });
  assert.match(duplicated.send({ code: PREVIOUS.予約番号 }).error, /予約番号.*重複/);
  assert.equal(duplicated.ledger.cells.length, 3);
  for (const [status, flag] of [['キャンセル', 'cancelled'], ['予約確定', 'conflict']]) {
    const app = fixture({ records: [{ ...PREVIOUS, 予約番号: REQUEST.code, 状態: status }] });
    assert.equal(app.send()[flag], true);
    assert.equal(app.ledger.cells.length, 2);
    assert.deepEqual(app.effects, []);
  }
});

test('番号の発行に失敗しても同じ一括読込を使い、台帳を50回読み直さない', () => {
  const app = fixture({ records: [{ ...PREVIOUS, 予約番号: 'LM-AAAAA' }], random: () => 0 });
  assert.match(app.send({ code: '' }).error, /予約番号を発行/);
  assert.equal(app.calls.filter(call => call.name === '予約一覧' && call.method === 'values').length, 1);
  assert.deepEqual(app.effects, []);
  assert.equal(app.held(), false);
});

for (const failure of ['snapshot', 'flush', 'readback']) {
  test(`${failure}失敗でも確認を省いて成功扱いしない`, () => {
    const app = fixture({ failure });
    const response = app.send();
    assert.equal(response.ok, false);
    assert.equal(response.unknown, failure === 'snapshot' ? undefined : true);
    assert.equal(app.effects.includes('mail'), false);
    assert.equal(app.held(), false);
  });
}

for (const headers of [
  ['予約番号', '来店日', '開始', '所要(分)', '開始'],
  ['予約番号', '日付', '開始', '終了'],
  ['来店日', '開始', '終了']
]) {
  test(`不完全な見出しは一括読込前から拒否する：${headers.join('／')}`, () => {
    const app = fixture({ headers });
    assert.match(app.send().error, /予約台帳.*見出し/);
    assert.equal(app.ledger.cells.length, 2);
    assert.deepEqual(app.effects, []);
    assert.equal(app.held(), false);
  });
}

test('列が少ない旧台帳は追加列を維持して一括読込し、正しい位置に予約を保存する', () => {
  const app = fixture({ headers: ['独自列', '電話番号', '予約番号', '来店日', '開始', '終了'] });
  assert.equal(app.send().ok, true);
  const headers = app.ledger.cells[0];
  assert.equal(app.ledger.cells[1][headers.indexOf('独自列')], '維持する');
  assert.equal(app.ledger.cells[2][headers.indexOf('合計金額')], REQUEST.totalPrice);
  assert.equal(app.ledger.cells[2][headers.indexOf('来店日')], REQUEST.date);
  assert.equal(app.held(), false);
});

for (const date of ['', '未定', '2030-02-30', '2030-13-01', '2000-02-30']) {
  test(`来店日不明の既存予約があると新規予約・通知を実行しない：${date || '空欄'}`, () => {
    const app = fixture({ records: [{ ...PREVIOUS, 来店日: date }] });
    const before = structuredClone(app.ledger.cells);
    const response = app.send();
    assert.equal(response.ok, false);
    assert.match(response.error, /予約台帳.*来店日/);
    assert.equal(response.invalid, true);
    assert.equal(response.taken, undefined);
    assert.equal(response.unknown, undefined);
    assert.deepEqual(app.ledger.cells, before);
    assert.deepEqual(app.effects, []);
    assert.equal(app.held(), false);
  });
}

test('全て空の行と日付不明の取消済み予約は新規予約を妨げない', () => {
  const app = fixture({ records: [{}, { ...PREVIOUS, 来店日: '', 状態: 'キャンセル' }] });
  assert.equal(app.send().ok, true);
  assert.equal(app.effects.filter(effect => effect === 'booking').length, 1);
  assert.equal(app.held(), false);
});

const HISTORY_COUNT = 5000;

for (const native of [true, false]) {
  for (const queue of [true, false]) {
    test(`${native ? 'native' : 'fallback'}・後送${queue}：5000件でも同じsnapshotで見出し・番号・重複を検査し、保存後だけ読み戻す`, () => {
      const records = Array.from({ length: HISTORY_COUNT }, (_unused, index) => ({ ...PREVIOUS,
        予約番号: `LM-HISTORY-${index}`, 来店日: '2029-12-31' }));
      const app = fixture({ native, queue, records });
      const before = structuredClone(app.ledger.cells);
      const result = app.send({ reservationSnapshot: { head: [], rows: [] } });
      assert.equal(result.ok, true);
      assert.equal(app.ledger.cells.length, HISTORY_COUNT + 2);
      assert.deepEqual(app.ledger.cells.slice(0, -1), before, '過去履歴・独自列を省略も変更もしない');
      const reads = app.calls.filter(call => call.name === '予約一覧' && call.method === 'values');
      assert.equal(reads.length, 2);
      assert.deepEqual(reads.map(read => [read.row, read.numRows, read.appended]),
        [[1, HISTORY_COUNT + 1, false], [HISTORY_COUNT + 2, 1, true]]);
      assert.equal(app.effects.filter(effect => effect === 'booking').length, 1);
      assert.equal(app.effects.includes('mail'), !queue);
      assert.equal(app.held(), false);
      app.calls.length = 0;
      const blocked = app.send({ code: 'LM-BLOCKED', reservationContext: { snapshot: { head: [], rows: [] } } });
      assert.equal(blocked.taken, true, '要求から渡されたsnapshotで空席確認を省略しない');
      assert.equal(app.calls.filter(call => call.name === '予約一覧' && call.method === 'values').length, 1);
      assert.equal(app.ledger.cells.length, HISTORY_COUNT + 2);
      assert.equal(app.held(), false);
    });
  }

  test(`${native ? 'native' : 'fallback'}：完全な見出しでも重複列は拒否し、古い不正な列を補完で隠さない`, () => {
    const app = fixture({ native });
    app.ledger.cells.forEach((row, index) => row.push(index ? '独自の不正値' : '開始'));
    const before = structuredClone(app.ledger.cells);
    const result = app.send();
    assert.equal(result.ok, false);
    assert.match(result.error, /予約台帳.*見出し/);
    assert.deepEqual(app.ledger.cells, before);
    assert.deepEqual(app.effects, []);
    assert.equal(app.held(), false);
  });

  for (const queue of [true, false]) {
    test(`${native ? 'native' : 'fallback'}・後送${queue}：旧列の補完でも取得済みの見出しを使い、補完後の新しい並びで保存する`, () => {
      const app = fixture({ native, queue, headers: ['独自列', '電話番号', '予約番号', '来店日', '開始', '終了'] });
      const before = structuredClone(app.ledger.cells);
      assert.equal(app.send().ok, true);
      const reads = app.calls.filter(call => call.name === '予約一覧' && call.method === 'values');
      assert.equal(reads.length, 3, '補完前・補完後・保存後の三取得だけにする');
      assert.deepEqual(reads.map(read => [read.row, read.numRows, read.appended]),
        [[1, 2, false], [1, 2, false], [3, 1, true]]);
      assert.deepEqual(app.ledger.cells[0].slice(0, before[0].length), before[0]);
      assert.deepEqual(app.ledger.cells[1], before[1]);
      const headers = app.ledger.cells[0];
      assert.equal(app.ledger.cells[2][headers.indexOf('来店日')], REQUEST.date);
      assert.equal(app.ledger.cells[2][headers.indexOf('合計金額')], REQUEST.totalPrice);
      assert.equal(app.ledger.cells[2][headers.indexOf('開始')], REQUEST.time);
      assert.equal(app.effects.filter(effect => effect === 'booking').length, 1);
      assert.equal(app.effects.includes('mail'), !queue);
      assert.equal(app.held(), false);
    });
  }

  test(`${native ? 'native' : 'fallback'}：空白だけの見出しは既存の実幅を読み直し、最初の独自列を消さない`, () => {
    const app = fixture({ native, headers: ['　'], records: [] });
    assert.equal(app.send().ok, true);
    const headers = app.ledger.cells[0];
    assert.equal(headers[0], '　');
    assert.equal(headers.length, Array.from(vm.runInContext('HEADERS', app.context)).length + 1);
    assert.equal(app.ledger.cells[1][headers.indexOf('予約番号')], REQUEST.code);
    assert.equal(app.ledger.cells[1][0], '');
    assert.equal(app.held(), false);
  });

  test(`${native ? 'native' : 'fallback'}：補完前に列幅が変わった場合は古い見出しで追加せず、新しい独自列を保持する`, () => {
    const app = fixture({ native, headers: ['独自列', '電話番号', '予約番号', '来店日', '開始', '終了'] });
    const originalRange = app.ledger.getRange.bind(app.ledger);
    let changed = false;
    app.ledger.getRange = (row, column, height = 1, width = 1) => {
      const range = originalRange(row, column, height, width);
      const originalValues = range.getValues.bind(range);
      range.getValues = () => {
        const values = originalValues();
        if (!changed && row === 1 && height > 1) {
          changed = true;
          app.ledger.cells[0].push('後から足した列');
          app.ledger.cells[1].push('別の新しい内容');
        }
        return values;
      };
      return range;
    };
    assert.equal(app.send().ok, true);
    assert.equal(changed, true);
    const headers = app.ledger.cells[0];
    assert.equal(headers[6], '後から足した列');
    assert.equal(app.ledger.cells[1][6], '別の新しい内容');
    assert.equal(headers.filter(header => header === '開始').length, 1);
    assert.equal(app.ledger.cells[2][headers.indexOf('開始')], REQUEST.time);
    assert.equal(app.ledger.cells[2][headers.indexOf('合計金額')], REQUEST.totalPrice);
    assert.equal(app.held(), false);
  });

  test(`${native ? 'native' : 'fallback'}：準備中の拒否と、読み取りが失敗した場合の未保存を保持する`, () => {
    const app = fixture({ native });
    const settings = app.sheets.get('設定');
    settings.cells.find(row => row[0] === '準備中の帯')[1] = '出す';
    assert.equal(app.send().draft, true);
    assert.deepEqual(app.effects, []);
    const failing = fixture({ native, failure: 'snapshot' });
    assert.equal(failing.send().ok, false);
    assert.deepEqual(failing.effects, []);
    assert.equal(app.held(), false);
    assert.equal(failing.held(), false);
  });

  for (const missing of [false, true]) {
    test(`${native ? 'native' : 'fallback'}：空台帳／欠落台帳の従来の初期化を勝手に取り除かない：${missing}`, () => {
      const app = fixture({ native, createLedger: true });
      if (missing) app.sheets.delete('予約一覧');
      else app.ledger.cells.length = 0;
      assert.equal(app.send().ok, true);
      const ledger = app.sheets.get('予約一覧');
      assert.equal(ledger.cells.length, 2);
      assert.deepEqual(ledger.cells[0], Array.from(vm.runInContext('HEADERS', app.context)));
      assert.equal(ledger.cells[1][ledger.cells[0].indexOf('予約番号')], REQUEST.code);
      assert.equal(app.effects.filter(effect => effect === 'header').length, 1);
      assert.equal(app.effects.filter(effect => effect === 'create').length, missing ? 1 : 0);
      assert.equal(app.effects.filter(effect => effect === 'booking').length, 1);
      assert.equal(app.held(), false);
    });
  }
}
