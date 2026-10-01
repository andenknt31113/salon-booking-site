import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_PATH = fileURLToPath(new URL('../gas/Code.gs', import.meta.url));
const SOURCE = process.env.SHEET_READ_REVISION
  ? execFileSync('git', ['show', `${process.env.SHEET_READ_REVISION}:gas/Code.gs`],
    { cwd: ROOT, encoding: 'utf8' })
  : readFileSync(SOURCE_PATH, 'utf8');
const SCRIPT = new vm.Script(SOURCE, { filename: SOURCE_PATH });
const FUTURE_DATE = '2099-02-01';
const NEXT_DATE = '2099-02-02';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const INITIAL_REQUEST = { type: 'menu', booking: true, initialAvailability: true };
const SHEET_NAMES = ['メニュー', 'おすすめメニュー', '休業日', '設定', '予約一覧'];
const MENU_HEADERS = ['区分', 'メニュー名', '価格', '所要(分)', '説明', '画像', '表示'];
const COUPON_HEADERS = ['メニュー名', '価格', '通常価格', '所要(分)', '説明', '条件', '対象', 'タグ', '画像', '表示'];
const CLOSED_HEADERS = ['休業日', '開始', '終了', 'メモ'];
const SETTING_HEADERS = ['項目', '内容'];
const LEDGER_HEADERS = [
  '予約番号', '受付日時', '来店日', '開始', '終了', '所要(分)',
  'メニュー', '担当', '担当ID', '指名料', '合計金額',
  'お名前', 'フリガナ', '電話番号', 'メール', '来店回数', '予約の入口', 'ご要望',
  '状態', 'カレンダーID', '施術メモ', '電話受付ID', '電話受付内容',
  '店舗メール状態', 'お客様メール状態'
];
const BASE_BOOKED = [{ date: FUTURE_DATE, time: '10:00', minutes: 60, staffId: 'st01' }];

function recordsSheet(head, records = []) {
  return { head, rows: records.map(record => head.map(header => record[header.trim()] ?? '')) };
}

function menuRecord(overrides = {}) {
  return { 区分: 'カット', メニュー名: '試験カット', 価格: 4000, '所要(分)': 60, 表示: '○', ...overrides };
}

function couponRecord(overrides = {}) {
  return { メニュー名: '試験コース', 価格: 6900, 通常価格: 9000, '所要(分)': 90,
    対象: '全員', タグ: 'カット、カラー', 表示: '○', ...overrides };
}

function bookingRecord(overrides = {}) {
  return { 予約番号: 'SNAPSHOT-EXISTING', 来店日: FUTURE_DATE, 開始: '10:00', 終了: '11:00',
    '所要(分)': 60, 担当ID: 'st01', 状態: '予約確定', お名前: '非公開の試験客',
    電話番号: '09000000000', メール: 'customer@example.test', 施術メモ: '非公開の試験メモ', ...overrides };
}

function defaultSheets() {
  return {
    メニュー: recordsSheet(MENU_HEADERS, [menuRecord()]),
    おすすめメニュー: recordsSheet(COUPON_HEADERS, [couponRecord()]),
    休業日: recordsSheet(CLOSED_HEADERS, [{ 休業日: NEXT_DATE, 開始: '14:00', 終了: '16:00', メモ: '試験休業' }]),
    設定: { head: SETTING_HEADERS, rows: [
      ['準備中の帯', '出さない'], ['営業開始', '09:00'], ['営業終了', '20:00'],
      ['最終受付', '19:00'], ['電話番号', '03-0000-0000']
    ] },
    予約一覧: recordsSheet(LEDGER_HEADERS, [bookingRecord()])
  };
}

function formatDate(date, timezone, pattern) {
  assert.equal(timezone, 'Asia/Tokyo', 'Googleの日時変換は日本時間で行う');
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  const pad = value => String(value).padStart(2, '0');
  if (pattern === 'HH:mm') return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  assert.equal(pattern, 'yyyy-MM-dd', '試験で未対応の日時書式を黙って代用しない');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function fixture({ definitions = defaultSheets(), failure = null, occupied = false } = {}) {
  const events = [];
  const writes = [];
  const externalCalls = [];
  const cellsBySheet = new Map();
  const sheets = new Map();
  const fault = { current: failure };
  let activeLock = null;
  let lockSequence = 0;

  function recordRead(operation, sheet = '', details = {}) {
    events.push({ kind: 'read', operation, sheet, lockId: activeLock, ...details });
    assert.notEqual(activeLock, null, `${sheet || 'SpreadsheetApp'}の${operation}はロック内で行う`);
    if (fault.current?.operation === operation && (!fault.current.sheet || fault.current.sheet === sheet)) {
      throw new Error(`試験用の読取失敗：${sheet || 'SpreadsheetApp'}/${operation}`);
    }
  }

  function forbidWrite(operation, sheet = '') {
    return () => {
      writes.push({ operation, sheet, lockId: activeLock });
      throw new Error(`読取要求で書込を試みた：${sheet}/${operation}`);
    };
  }

  function forbiddenService(service) {
    return new Proxy({}, { get: (target, operation) => () => {
      externalCalls.push({ service, operation });
      throw new Error(`読取要求で外部サービスを試みた：${service}/${String(operation)}`);
    } });
  }

  function rangeFor(sheet, row, column, numRows = 1, numColumns = 1) {
    recordRead('getRange', sheet, { row, column, numRows, numColumns });
    for (const dimension of [row, column, numRows, numColumns]) {
      assert.ok(Number.isInteger(dimension) && dimension > 0, 'Google Rangeには正の整数を渡す');
    }
    const range = {
      getValues() {
        recordRead('getValues', sheet, { row, column, numRows, numColumns });
        const cells = cellsBySheet.get(sheet);
        return Array.from({ length: numRows }, (unusedRow, rowIndex) =>
          Array.from({ length: numColumns }, (unusedColumn, columnIndex) => {
            const value = cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? '';
            return value instanceof Date ? new Date(value.getTime()) : value;
          }));
      }
    };
    for (const operation of ['setValue', 'setValues', 'clearContent', 'clear', 'setNote',
      'setFontWeight', 'setBackground', 'setFontLine', 'setFontColor']) {
      range[operation] = forbidWrite(operation, sheet);
    }
    return range;
  }

  const spreadsheet = {
    getSheetByName(name) {
      recordRead('getSheetByName', name);
      return sheets.get(name) || null;
    },
    insertSheet: forbidWrite('insertSheet'),
    deleteSheet: forbidWrite('deleteSheet')
  };

  for (const [name, definition] of Object.entries(definitions)) {
    const cells = structuredClone([...(definition.head === null ? [] : [definition.head]), ...definition.rows]);
    cellsBySheet.set(name, cells);
    const lastRow = cells.reduce((last, row, rowIndex) => row.some(value => value !== '' && value != null)
      ? rowIndex + 1 : last, 0);
    const lastColumn = cells.reduce((width, row) => row.reduce((last, value, columnIndex) =>
      value !== '' && value != null ? Math.max(last, columnIndex + 1) : last, width), 0);
    const sheet = {
      getLastRow() { recordRead('getLastRow', name); return lastRow; },
      getLastColumn() { recordRead('getLastColumn', name); return lastColumn; },
      getName() { recordRead('getName', name); return name; },
      getParent() { recordRead('getParent', name); return spreadsheet; },
      getRange: (row, column, numRows, numColumns) => rangeFor(name, row, column, numRows, numColumns),
      getDataRange: () => rangeFor(name, 1, 1, Math.max(lastRow, 1), Math.max(lastColumn, 1))
    };
    for (const operation of ['appendRow', 'clear', 'deleteRows', 'insertRows', 'setFrozenRows', 'setColumnWidth']) {
      sheet[operation] = forbidWrite(operation, name);
    }
    sheets.set(name, sheet);
  }

  const initialCells = structuredClone([...cellsBySheet]);
  const context = vm.createContext({
    Date,
    console: { log() {}, warn() {}, error() {} },
    SpreadsheetApp: {
      getActiveSpreadsheet() { recordRead('getActiveSpreadsheet'); return spreadsheet; },
      flush: forbidWrite('flush')
    },
    LockService: { getScriptLock() {
      const lockId = ++lockSequence;
      events.push({ kind: 'lock-request', lockId });
      return {
        waitLock(timeout) {
          events.push({ kind: 'lock-wait', lockId });
          assert.ok(Number.isFinite(timeout) && timeout > 0, 'ロックの待機期限を保つ');
          if (occupied || activeLock !== null) throw new Error('試験用のロック待機失敗');
          activeLock = lockId;
          events.push({ kind: 'lock-acquired', lockId });
        },
        releaseLock() {
          assert.equal(activeLock, lockId, '取得した同じScriptLockだけを解放する');
          events.push({ kind: 'lock-released', lockId });
          activeLock = null;
        }
      };
    } },
    ContentService: { MimeType: { JSON: 'json' },
      createTextOutput: body => ({ setMimeType: () => body }) },
    Utilities: { formatDate },
    MailApp: forbiddenService('MailApp'),
    UrlFetchApp: forbiddenService('UrlFetchApp'),
    CalendarApp: forbiddenService('CalendarApp'),
    PropertiesService: { getScriptProperties: () => ({
      getProperty(key) { assert.equal(key, 'BOOKING_CHANGE_RECOVERY'); return null; },
      setProperty: forbidWrite('setProperty'), deleteProperty: forbidWrite('deleteProperty')
    }) },
    DriveApp: forbiddenService('DriveApp')
  });
  SCRIPT.runInContext(context);

  return {
    events, writes, externalCalls, fault,
    get reads() { return events.filter(event => event.kind === 'read'); },
    get valuesReads() { return events.filter(event => event.operation === 'getValues'); },
    send(request = INITIAL_REQUEST) {
      const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify(request) } }));
      assert.deepEqual(writes, [], '成功・拒否・例外のいずれでも台帳や設定へ書き込まない');
      assert.deepEqual(externalCalls, [], 'Googleへの実通信・通知・ファイル操作をしない');
      assert.deepEqual([...cellsBySheet], initialCells, '見出し・独自列・元の予約行を変更しない');
      assert.equal(activeLock, null, '取得したロックを応答前に解放する');
      return result;
    }
  };
}

function assertInitialBooking(result) {
  assert.equal(result.ok, true);
  assert.deepEqual(result.categories.flatMap(category => category.items.map(item => item.id)), ['sm0']);
  assert.deepEqual(result.coupons.map(coupon => coupon.id), ['sc0']);
  assert.deepEqual(result.booked, BASE_BOOKED);
  assert.deepEqual(result.closedDates, [{ date: NEXT_DATE, start: '14:00', end: '16:00' }]);
  assert.equal(result.settings['準備中の帯'], '出さない');
  assert.equal(Object.hasOwn(result, 'styles'), false, '予約で使わないスタイルを取得しない');
  assert.equal(Object.hasOwn(result, 'reviews'), false, '予約で使わない口コミを取得しない');
}

function assertReadFailure(result) {
  assert.equal(result.ok, false, '読取に失敗した要求を成功にしない');
  assert.ok(typeof result.error === 'string' && result.error.length > 0);
  assert.equal(Object.hasOwn(result, 'booked'), false, '未確認の台帳を空の成功一覧で補わない');
}

test('初回メニューと空席は五つのシートを各一回のgetValuesでまとめて読む', () => {
  const definitions = defaultSheets();
  const app = fixture({ definitions });
  assertInitialBooking(app.send());
  const counts = Object.fromEntries(SHEET_NAMES.map(name =>
    [name, app.valuesReads.filter(read => read.sheet === name).length]));
  assert.deepEqual(counts, Object.fromEntries(SHEET_NAMES.map(name => [name, 1])));
  assert.equal(app.valuesReads.length, SHEET_NAMES.length, '不要なシート読取を増やさない');
  for (const read of app.valuesReads) {
    assert.deepEqual([read.row, read.column, read.numRows, read.numColumns],
      [1, 1, definitions[read.sheet].rows.length + 1, definitions[read.sheet].head.length],
      `${read.sheet}の見出しと全データを一つの矩形で読む`);
  }
});

test('非表示・空行・名前欠落・不正所要の行を飛ばしてもメニューIDとおすすめIDを詰め直さない', () => {
  const definitions = defaultSheets();
  definitions.メニュー = recordsSheet(MENU_HEADERS, [
    menuRecord(), menuRecord({ メニュー名: '非表示', 表示: '×' }), {}, menuRecord({ メニュー名: '' }),
    menuRecord({ メニュー名: '表示空欄', 表示: '' }), menuRecord({ メニュー名: '所要不明', '所要(分)': '' }),
    menuRecord({ 区分: 'カラー', メニュー名: '追加カラー', '所要(分)': '９０分' })
  ]);
  definitions.おすすめメニュー = recordsSheet(COUPON_HEADERS, [
    couponRecord(), couponRecord({ メニュー名: '非公開', 表示: '非公開' }), {}, couponRecord({ メニュー名: '' }),
    couponRecord({ メニュー名: '表示空欄コース', 表示: '' }), couponRecord({ メニュー名: '所要不明', '所要(分)': 0 }),
    couponRecord({ メニュー名: '追加コース', '所要(分)': '９０分' })
  ]);
  const result = fixture({ definitions }).send();
  assert.equal(result.ok, true);
  assert.deepEqual(result.categories.map(category => [category.id, category.name]), [['cat0', 'カット'], ['cat1', 'カラー']]);
  assert.deepEqual(result.categories.flatMap(category => category.items.map(item => [item.id, item.name])),
    [['sm0', '試験カット'], ['sm4', '表示空欄'], ['sm6', '追加カラー']]);
  assert.deepEqual(result.coupons.map(coupon => [coupon.id, coupon.title]),
    [['sc0', '試験コース'], ['sc4', '表示空欄コース'], ['sc6', '追加コース']]);
});

for (const [label, minutes] of [
  ['空欄', ''], ['ゼロ', 0], ['小数', 60.5], ['時間表記', '1時間30分'],
  ['未定', '未定'], ['下限未満', 14], ['上限超過', 481], ['負数', -60]
]) {
  test(`所要が${label}の単品とおすすめは表示せず公開予約も書込前に拒否する`, () => {
    const definitions = defaultSheets();
    definitions.メニュー = recordsSheet(MENU_HEADERS, [menuRecord({ '所要(分)': minutes }),
      menuRecord({ メニュー名: '正常な単品' })]);
    definitions.おすすめメニュー = recordsSheet(COUPON_HEADERS, [couponRecord({ '所要(分)': minutes }),
      couponRecord({ メニュー名: '正常なコース' })]);
    definitions.予約一覧 = recordsSheet(LEDGER_HEADERS);
    const app = fixture({ definitions });
    const catalog = app.send();
    assert.equal(catalog.ok, true);
    assert.deepEqual(catalog.categories.flatMap(category => category.items.map(item => item.id)), ['sm1']);
    assert.deepEqual(catalog.coupons.map(coupon => coupon.id), ['sc1']);
    for (const [id, name, price] of [['sm0', '試験カット', 4000], ['sc0', '試験コース', 6900]]) {
      const result = app.send({ type: 'reserve', code: 'SNAPSHOT-INVALID', date: FUTURE_DATE, time: '13:00',
        menus: [{ id, name, price, minutes: 60, priceFrom: false }], totalPrice: price, totalMinutes: 60,
        staffId: 'st01', nominationFee: 0, customer: { name: '試験客', tel: '09000000000' } });
      assert.equal(result.ok, false);
      assert.equal(result.catalogChanged, true, '所要の不正を日時や入力の別エラーで代用しない');
    }
  });
}

test('並べ替えた見出しと途中の独自列でも価格と開始・終了を正しく読む', () => {
  const definitions = defaultSheets();
  definitions.メニュー = recordsSheet(['表示', '説明', '独自列', '所要(分)', '画像', ' 価格 ', '区分', 'メニュー名'],
    [menuRecord({ 価格: '¥4,500〜', '所要(分)': '９０分', 独自列: '¥1', 説明: '単品の説明' })]);
  definitions.おすすめメニュー = recordsSheet([
    '表示', '独自列', '対象', '通常価格', 'メニュー名', '所要(分)', '条件', 'タグ', '価格', '画像', '説明'
  ], [couponRecord({ 価格: '６，９００円', 独自列: 1, 条件: '試験条件', 説明: 'コースの説明' })]);
  definitions.休業日 = recordsSheet(['メモ', '終了', '独自列', '休業日', '開始'], [
    { 休業日: '２０９９年２月１日', 開始: '１４：３０', 終了: '１６時', 独自列: '23:50' },
    { 休業日: NEXT_DATE, 開始: '', 終了: '', 独自列: '23:50' }
  ]);
  const movedHeaders = ['状態', '終了', '独自列', '来店日', '担当ID', '開始', '所要(分)'];
  definitions.予約一覧 = recordsSheet(movedHeaders.concat(LEDGER_HEADERS.filter(header => !movedHeaders.includes(header))),
    [bookingRecord({ 来店日: new Date(`${NEXT_DATE}T12:00:00+09:00`),
      開始: new Date(`${NEXT_DATE}T09:15:00+09:00`), 終了: new Date(`${NEXT_DATE}T11:45:00+09:00`), 独自列: '23:50' })]);
  const result = fixture({ definitions }).send();
  assert.equal(result.ok, true);
  const item = result.categories[0].items[0];
  assert.deepEqual([item.id, item.name, item.price, item.priceFrom, item.minutes, item.note],
    ['sm0', '試験カット', 4500, true, 90, '単品の説明']);
  const coupon = result.coupons[0];
  assert.deepEqual([coupon.id, coupon.title, coupon.price, coupon.listPrice, coupon.minutes, coupon.detail, coupon.terms],
    ['sc0', '試験コース', 6900, 9000, 90, 'コースの説明', '試験条件']);
  assert.deepEqual(coupon.tags, ['カット', 'カラー']);
  assert.deepEqual(result.closedDates, [{ date: FUTURE_DATE, start: '14:30', end: '16:00' }, NEXT_DATE]);
  assert.deepEqual(result.booked, [{ date: NEXT_DATE, time: '09:15', minutes: 150, staffId: 'st01' }]);
});

test('空白の見出し行は既定の列順で読み本文の先頭行を失わない', () => {
  const definitions = defaultSheets();
  for (const name of SHEET_NAMES) definitions[name].head = definitions[name].head.map(() => ' ');
  assertInitialBooking(fixture({ definitions }).send());
});

test('列数が少ない古いシートでも既定幅まで読み価格と枠を保持する', () => {
  const definitions = defaultSheets();
  definitions.メニュー = recordsSheet(MENU_HEADERS.slice(0, 4), [menuRecord()]);
  definitions.おすすめメニュー = recordsSheet(COUPON_HEADERS.slice(0, 4), [couponRecord()]);
  definitions.休業日 = recordsSheet(['休業日'], [{ 休業日: NEXT_DATE }]);
  definitions.予約一覧 = recordsSheet(LEDGER_HEADERS.slice(0, 9), [bookingRecord()]);
  const app = fixture({ definitions });
  const result = app.send();
  assert.equal(result.ok, true);
  assert.deepEqual(result.categories.flatMap(category => category.items.map(item => [item.price, item.minutes])), [[4000, 60]]);
  assert.deepEqual(result.coupons.map(coupon => [coupon.price, coupon.minutes]), [[6900, 90]]);
  assert.deepEqual(result.closedDates, [NEXT_DATE]);
  assert.deepEqual(result.booked, BASE_BOOKED);
  for (const [sheet, width] of [
    ['メニュー', MENU_HEADERS.length], ['おすすめメニュー', COUPON_HEADERS.length],
    ['休業日', CLOSED_HEADERS.length], ['予約一覧', LEDGER_HEADERS.length]
  ]) {
    const reads = app.valuesReads.filter(read => read.sheet === sheet);
    assert.ok(reads.length > 0 && reads.every(read => read.numColumns === width), `${sheet}を既定の幅まで読む`);
  }
});

test('設定の時刻セルと準備中を保持し通知先と非公開設定を返さない', () => {
  const definitions = defaultSheets();
  definitions.設定 = { head: ['項目', '内容', '独自列'], rows: [
    [' 営業開始 ', new Date('2099-01-01T08:30:00+09:00'), '23:50'],
    ['営業終了', '２０時', '23:50'], ['最終受付', '１９：３０', '23:50'],
    ['準備中の帯', '出す', ''], ['準備中の文言', '試験の準備中', ''],
    ['電話番号', '03-0000-0000', ''], ['お知らせ', '', ''],
    ['問い合わせ先メール', 'public@example.test', ''],
    ['通知先メール', 'private-shop@example.test', ''], ['スタッフ通知先メール', 'private-staff@example.test', ''],
    ['ホットペッパー手数料率', 0.15, ''], ['ホットペッパー掲載料', 12345, ''],
    ['独自の非公開項目', 'private-value', ''], ['', '名前のない設定', '']
  ] };
  const app = fixture({ definitions });
  const result = app.send();
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings, { 営業開始: '08:30', 営業終了: '20:00', 最終受付: '19:30',
    準備中の帯: '出す', 準備中の文言: '試験の準備中', 電話番号: '03-0000-0000',
    お知らせ: '', 問い合わせ先メール: 'public@example.test' });
  assert.deepEqual(result.booked, BASE_BOOKED, '準備中でも存在する予約枠を消さない');
  const rejected = app.send({ type: 'reserve', code: 'SNAPSHOT-DRAFT' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.draft, true, '表示だけでなく実際の公開予約を止める');
});

test('未来予約だけを返し取消表記と日付欠落行を除外して個人情報を公開しない', () => {
  const definitions = defaultSheets();
  const cancellations = ['キャンセル', 'キャンセル済', 'キャンセル済み', '取消', '取り消し', '取消済', '中止'];
  definitions.予約一覧 = recordsSheet(LEDGER_HEADERS, [
    bookingRecord(), bookingRecord({ 来店日: NEXT_DATE, 開始: '13:00', 終了: '14:00', 担当ID: '' }),
    bookingRecord({ 来店日: '2000-01-01' }), bookingRecord({ 来店日: '' }),
    ...cancellations.map(状態 => bookingRecord({ 状態, 開始: '', 終了: '', '所要(分)': '' })),
    bookingRecord({ 状態: ' 取 消 済 ', 開始: '', 終了: '', '所要(分)': '' })
  ]);
  const result = fixture({ definitions }).send();
  assert.equal(result.ok, true);
  assert.deepEqual(result.booked, [...BASE_BOOKED, { date: NEXT_DATE, time: '13:00', minutes: 60, staffId: null }]);
  for (const booked of result.booked) assert.deepEqual(Object.keys(booked).sort(), ['date', 'minutes', 'staffId', 'time']);
});

for (const [label, start, end, storedMinutes, time, minutes] of [
  ['終了が所要より長い', '10:00', '12:30', 60, '10:00', 150],
  ['終了が所要より短い', '10:00', '10:30', 120, '10:00', 120],
  ['終了が空欄', '10:00', '', '１２０分', '10:00', 120],
  ['所要が空欄でも終了は読める', '10:00', '11:20', '', '10:00', 80],
  ['開始が空欄', '', '11:00', 60, '00:00', 1440],
  ['開始が不正', '25:00', '11:00', 60, '00:00', 1440],
  ['終了と所要が空欄', '10:00', '', '', '00:00', 1440],
  ['所要が不明で終了が開始以前', '10:00', '09:00', '未定', '00:00', 1440]
]) {
  test(`${label}：予約の保守的な枠確保を維持する`, () => {
    const definitions = defaultSheets();
    definitions.予約一覧 = recordsSheet(LEDGER_HEADERS, [bookingRecord({ 開始: start, 終了: end, '所要(分)': storedMinutes })]);
    const result = fixture({ definitions }).send();
    assert.equal(result.ok, true);
    assert.deepEqual(result.booked, [{ date: FUTURE_DATE, time, minutes, staffId: 'st01' }]);
  });
}

for (const [label, headless] of [['完全に空', true], ['見出しだけ', false]]) {
  test(`${label}のメニュー・おすすめ・休業日・設定は空のまま返し実在する予約枠を失わない`, () => {
    const definitions = defaultSheets();
    for (const name of SHEET_NAMES.filter(name => name !== '予約一覧')) {
      definitions[name] = { head: headless ? null : definitions[name].head, rows: [] };
    }
    const result = fixture({ definitions }).send();
    assert.equal(result.ok, true);
    assert.deepEqual([result.categories, result.coupons, result.closedDates, result.settings], [[], [], [], {}]);
    assert.deepEqual(result.booked, BASE_BOOKED);
  });

  test(`${label}の実在する予約台帳は空一覧を返し初期化の書込をしない`, () => {
    const definitions = defaultSheets();
    definitions.予約一覧 = { head: headless ? null : LEDGER_HEADERS, rows: [] };
    const result = fixture({ definitions }).send();
    assert.equal(result.ok, true);
    assert.deepEqual(result.booked, []);
    assert.deepEqual(result.categories.flatMap(category => category.items.map(item => item.id)), ['sm0']);
  });
}

for (const [sheet, field, expected] of [
  ['メニュー', 'categories', []], ['おすすめメニュー', 'coupons', []],
  ['休業日', 'closedDates', []], ['設定', 'settings', {}]
]) {
  test(`${sheet}シートが欠落しても勝手に作成せず実在する予約台帳を読む`, () => {
    const definitions = defaultSheets();
    delete definitions[sheet];
    const result = fixture({ definitions }).send();
    assert.equal(result.ok, true);
    assert.deepEqual(result[field], expected);
    assert.deepEqual(result.booked, BASE_BOOKED);
  });
}

for (const [label, allMissing] of [['予約台帳だけ', false], ['全シート', true]]) {
  test(`${label}が欠落した初回取得は空席確認の成功を捏造しない`, () => {
    const definitions = allMissing ? {} : defaultSheets();
    delete definitions.予約一覧;
    const result = fixture({ definitions }).send();
    assertReadFailure(result);
    assert.match(result.error, /予約台帳/);
  });
}

for (const sheet of SHEET_NAMES) {
  test(`${sheet}のgetValues失敗は空席の成功や空一覧へ置き換えない`, () => {
    const app = fixture({ failure: { sheet, operation: 'getValues' } });
    const result = app.send();
    assertReadFailure(result);
    assert.match(result.error, /試験用の読取失敗/);
    assert.ok(app.valuesReads.some(read => read.sheet === sheet), '対象の読取まで実際に到達する');
  });
}

for (const [label, failure] of [
  ['台帳の行数取得', { sheet: '予約一覧', operation: 'getLastRow' }],
  ['台帳の列数取得', { sheet: '予約一覧', operation: 'getLastColumn' }],
  ['Spreadsheetサービス取得', { operation: 'getActiveSpreadsheet' }],
  ['予約台帳の検索', { sheet: '予約一覧', operation: 'getSheetByName' }]
]) {
  test(`${label}の例外でも空席の成功を返さない`, () => {
    const result = fixture({ failure }).send();
    assertReadFailure(result);
    assert.match(result.error, /試験用の読取失敗/);
  });
}

test('初回メニューと空席の全読取を同じScriptLock内で行い最後に解放する', () => {
  const app = fixture();
  assertInitialBooking(app.send());
  const lockEvents = app.events.filter(event => event.kind.startsWith('lock-'));
  assert.deepEqual(lockEvents.map(event => event.kind), ['lock-request', 'lock-wait', 'lock-acquired', 'lock-released']);
  const lockId = lockEvents[0].lockId;
  assert.ok(lockEvents.every(event => event.lockId === lockId));
  assert.ok(app.reads.length > 0);
  assert.ok(app.reads.every(read => read.lockId === lockId));
  assert.equal(app.events[2].kind, 'lock-acquired');
  assert.equal(app.events.at(-1).kind, 'lock-released');
});

test('読取例外でも同じScriptLockを解放し復旧した次の初回取得で読み直す', () => {
  const app = fixture({ failure: { sheet: '予約一覧', operation: 'getValues' } });
  assertReadFailure(app.send());
  assert.equal(app.events.at(-1).kind, 'lock-released');
  const failedReadCount = app.valuesReads.length;
  app.fault.current = null;
  assertInitialBooking(app.send());
  assert.deepEqual([...new Set(app.valuesReads.slice(failedReadCount).map(read => read.sheet))].sort(), [...SHEET_NAMES].sort());
  const acquired = app.events.filter(event => event.kind === 'lock-acquired').map(event => event.lockId);
  const released = app.events.filter(event => event.kind === 'lock-released').map(event => event.lockId);
  assert.equal(acquired.length, 2);
  assert.deepEqual(released, acquired);
});

test('ScriptLockの待機失敗ではシートへ進まず他の処理のロックを解放しない', () => {
  const app = fixture({ occupied: true });
  assertReadFailure(app.send());
  assert.deepEqual(app.reads, []);
  assert.deepEqual(app.events.map(event => event.kind), ['lock-request', 'lock-wait']);
});
