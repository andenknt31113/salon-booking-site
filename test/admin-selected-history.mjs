import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const BASELINE_REF = '0b9b9dd';
const BASELINE_SOURCE = process.env.GAS_BASELINE_SOURCE
  ? readFileSync(process.env.GAS_BASELINE_SOURCE, 'utf8')
  : execFileSync('git', ['show', `${BASELINE_REF}:gas/Code.gs`], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8'
  });
const NOW = '2026-10-02T15:00:00.000Z';
const TODAY = '2026-10-03';
const PAST = '2025-10-02';
const FUTURE = '2026-10-04';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const CUSTOMER_COUNT = 250;
const BOOKINGS_PER_CUSTOMER = 20;
const SELECTED_CUSTOMER = 37;
const REQUIRED_HEADERS = ['予約番号', '来店日', '開始', '終了', 'お名前', '電話番号', '状態', '施術メモ', 'ご要望'];

function booking(overrides = {}) {
  return { 予約番号: 'LM-SELECTED', 来店日: PAST, 開始: '10:00', 終了: '11:00',
    '所要(分)': 60, メニュー: '架空カット', 担当: '架空担当', 担当ID: 'st01', 指名料: 500,
    合計金額: 4000, お名前: '架空 選択履歴', フリガナ: 'カクウ', 電話番号: "'00000000000",
    メール: 'history@example.test', 来店回数: '再来', 予約の入口: '電話', 状態: '予約確定',
    ご要望: '保持する要望', 施術メモ: '保持する施術メモ',
    店舗メール状態: '送信結果不明', お客様メール状態: '停止中', ...overrides };
}

const HISTORY = Array.from({ length: CUSTOMER_COUNT * BOOKINGS_PER_CUSTOMER }, (_unused, index) => {
  const customer = Math.floor(index / BOOKINGS_PER_CUSTOMER);
  return booking({ 予約番号: `LM-HISTORY-${index}`, お名前: `架空顧客${customer}`,
    電話番号: `'${String(customer).padStart(11, '0')}`, 施術メモ: `顧客${customer}だけのメモ${index}`,
    ご要望: `顧客${customer}だけの要望${index}`, 状態: index % 4 === 0 ? '取り消し' : '予約確定',
    来店日: [PAST, TODAY, FUTURE, '日付不明'][index % 4] });
});
const SELECTED_RECORDS = HISTORY.slice(SELECTED_CUSTOMER * BOOKINGS_PER_CUSTOMER,
  (SELECTED_CUSTOMER + 1) * BOOKINGS_PER_CUSTOMER);
const SELECTED_CODES = SELECTED_RECORDS.map(record => record.予約番号);

function fixture({ records = [booking()], source = SOURCE, denied = false, failure = '', deliveryIndices = [] } = {}) {
  let held = false;
  let authorized = false;
  const reads = [];
  const accesses = [];
  const writes = [];
  const mappedCodes = [];
  const sheets = new Map();
  const properties = new Map([['ADMIN_GOOGLE_ONLY', 'true']]);
  const forbid = operation => () => {
    writes.push(operation);
    throw new Error('架空の読取試験では変更・送信は禁止');
  };
  const spreadsheet = { getSheetByName(name) {
    accesses.push(name);
    assert.equal(authorized, true, '認証前に台帳へ触れない');
    assert.equal(held, true);
    return sheets.get(name) || null;
  }, insertSheet: forbid('insertSheet'), deleteSheet: forbid('deleteSheet') };
  const context = vm.createContext({
    Date: class extends Date {
      constructor(...values) { super(...(values.length ? values : [NOW])); }
      static now() { return Date.parse(NOW); }
    },
    console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null,
      setProperty: forbid('setProperty'), deleteProperty: forbid('deleteProperty'), setProperties: forbid('setProperties') }) },
    SpreadsheetApp: { getActiveSpreadsheet() {
      accesses.push('spreadsheet');
      assert.equal(authorized, true);
      assert.equal(held, true);
      return spreadsheet;
    }, flush: forbid('flush') },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    MailApp: { sendEmail: forbid('sendEmail') },
    UrlFetchApp: { fetch: forbid('fetch') },
    CalendarApp: { getCalendarById: forbid('getCalendarById'), getDefaultCalendar: forbid('getDefaultCalendar') },
    ScriptApp: { newTrigger: forbid('newTrigger'), deleteTrigger: forbid('deleteTrigger') },
    Utilities: { DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => Array.from(createHash('md5').update(value).digest()),
      formatDate(value, zone, format) {
        assert.equal(zone, 'Asia/Tokyo');
        const shifted = new Date(value.getTime() + JST_OFFSET_MS).toISOString();
        if (format === 'HH:mm') return shifted.slice(11, 16);
        assert.equal(format, 'yyyy-MM-dd');
        return shifted.slice(0, 10);
      } }
  });
  vm.runInContext(source, context);
  context.verifyGoogleAdmin_ = () => {
    if (denied) throw new Error('架空の管理権限拒否');
    authorized = true;
  };
  const originalMapper = context.adminReservation_;
  context.adminReservation_ = (row, column) => {
    mappedCodes.push(String(row[column('予約番号')]));
    return originalMapper(row, column);
  };
  const constants = name => Array.from(vm.runInContext(name, context));
  function add(name, headers, values = []) {
    const cells = [Array.from(headers), ...values.map(record => Array.isArray(record)
      ? Array.from(record) : headers.map(header => record[header] ?? ''))];
    const range = (row, column, height = 1, width = 1) => ({ getValues() {
      reads.push({ name, row, column, height, width });
      assert.equal(authorized, true);
      assert.equal(held, true);
      if (name === failure) throw new Error('架空の読込障害');
      return Array.from({ length: height }, (_unused, rowIndex) =>
        Array.from({ length: width }, (_cell, columnIndex) => {
          const value = cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? '';
          return value instanceof Date ? new context.Date(value.getTime()) : value;
        }));
    }, setValue: forbid('setValue'), setValues: forbid('setValues'), clear: forbid('clear') });
    const sheet = { cells, getParent: () => spreadsheet, getLastRow: () => cells.length,
      getLastColumn: () => cells[0]?.length || 0, getRange: range,
      getDataRange: () => range(1, 1, cells.length, cells[0]?.length || 0),
      appendRow: forbid('appendRow'), insertColumnsAfter: forbid('insertColumnsAfter'), deleteRow: forbid('deleteRow') };
    sheets.set(name, sheet);
    return sheet;
  }
  const ledger = add('予約一覧', constants('HEADERS'), records);
  add('メニュー', constants('MENU_HEADERS'));
  add('おすすめメニュー', constants('COUPON_HEADERS'));
  add('スタイル', constants('STYLE_HEADERS'));
  add('口コミ', constants('REVIEW_HEADERS'));
  add('休業日', constants('CLOSED_HEADERS'), [{ 休業日: FUTURE, メモ: '架空休業' }]);
  add('設定', ['項目', '内容'], constants('LISTED_SETTINGS'));
  if (deliveryIndices.length) {
    properties.set('BOOKING_EMAIL_QUEUE_ENABLED', 'true');
    add('予約メール配送', constants('BOOKING_EMAIL_HEADERS'), deliveryIndices.map(index => {
      const job = { version: 1, code: context.codeKey_(records[index].予約番号), action: '新規予約',
        created: Date.parse(NOW), messages: Object.fromEntries(['shop', 'customer'].map(channel => [channel,
          { to: 'delivery@example.test', subject: '架空配送', body: '配送本文は返さない',
            status: channel === 'shop' ? '送信処理受付' : '送信結果不明', updated: Date.parse(NOW) }])) };
      return [`selected-delivery-${String(index).padStart(4, '0')}`,
        context.bookingEmailSignature_(ledger.cells[index + 1], ledger.cells[0]), JSON.stringify(job)];
    }));
  }
  function sendRaw(body) {
    authorized = false;
    const before = structuredClone([...sheets].map(([name, sheet]) => [name, sheet.cells]));
    const response = JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }));
    assert.equal(held, false);
    assert.deepEqual(writes, [], '変更・通知送信・初期化・設定補完なし');
    assert.deepEqual([...sheets].map(([name, sheet]) => [name, sheet.cells]), before, '全シートを保持する');
    return response;
  }
  return { sheets, reads, accesses, mappedCodes,
    send: (payload = {}) => sendRaw({ type: 'googleAdmin', action: 'adminData', payload }),
    legacy: payload => sendRaw({ type: 'adminData', ...payload }) };
}

function selected(codes = ['LM-SELECTED']) {
  return { reservationsOnly: true, reservationCodes: codes };
}

function assertFailure(response) {
  assert.equal(response.ok, false);
  assert.ok(response.error);
  assert.equal(Object.hasOwn(response, 'reservations'), false);
}

test('selected scope: 250顧客5000予約から選択した1人20件だけをfull詳細と既存metadataで返す', () => {
  const full = fixture({ records: HISTORY }).send({ reservationsOnly: true });
  const app = fixture({ records: HISTORY });
  const response = app.send(selected(SELECTED_CODES.slice().reverse()));
  assert.equal(response.ok, true);
  assert.equal(response.reservations.length, BOOKINGS_PER_CUSTOMER);
  assert.deepEqual(response.reservations, full.reservations.filter(row => SELECTED_CODES.includes(row.code)));
  assert.deepEqual(response.closedDates, full.closedDates);
  assert.deepEqual(Object.keys(response).sort(), ['closedDates', 'ok', 'reservations']);
  const serialized = JSON.stringify(response);
  for (const record of HISTORY.filter(record => !SELECTED_CODES.includes(record.予約番号))) {
    assert.equal(serialized.includes(JSON.stringify(record.お名前)), false);
    assert.equal(serialized.includes(record.施術メモ), false);
    assert.equal(serialized.includes(record.ご要望), false);
  }
  assert.equal(response.reservations.filter(row => row.status === 'キャンセル').length, 5);
  assert.equal(response.reservations.filter(row => row.date === FUTURE).length, 5);
  assert.equal(response.reservations.filter(row => row.date === '日付不明').length, 5);
  assert.deepEqual(app.mappedCodes.sort(), SELECTED_CODES.slice().sort());
  assert.deepEqual(app.accesses, ['spreadsheet', '予約一覧', '休業日']);
  assert.equal(app.reads.length, 2);
  assert.equal(app.reads.filter(read => read.name === '予約一覧' && read.height === HISTORY.length + 1).length, 1);
});

test('旧HEADのselected scope失敗を保持し、現実装では20件に限定できる', () => {
  const payload = selected(SELECTED_CODES);
  const baseline = fixture({ records: HISTORY, source: BASELINE_SOURCE }).send(payload);
  assert.equal(baseline.reservations.length, HISTORY.length);
  assert.throws(() => assert.equal(baseline.reservations.length, BOOKINGS_PER_CUSTOMER), assert.AssertionError);
  assert.equal(fixture({ records: HISTORY }).send(payload).reservations.length, BOOKINGS_PER_CUSTOMER);
});

for (const fields of [{ 施術メモ: '', ご要望: '' }, { 施術メモ: '', ご要望: '要望だけ' },
  { 施術メモ: 'メモだけ', ご要望: '' }, { 施術メモ: "'=文字としてのメモ", ご要望: ' ' }]) {
  test(`空詳細を未取得と混同しない：${JSON.stringify(fields)}`, () => {
    const records = [booking(fields), booking({ 予約番号: 'LM-OTHER' })];
    const response = fixture({ records }).send(selected());
    assert.equal(response.ok, true);
    assert.equal(response.reservations.length, 1);
    assert.deepEqual(response.reservations[0], fixture({ records }).send({ reservationsOnly: true }).reservations[0]);
    assert.equal(Object.hasOwn(response.reservations[0], 'detailsPending'), false);
  });
}

test('同じ電話番号の別名と別予約番号を取り込まず、番号だけで選択する', () => {
  const records = [booking(), booking({ 予約番号: 'LM-FAMILY', お名前: '架空 同居家族', 施術メモ: '家族のメモ' }),
    booking({ 予約番号: 'LM-SAME-NAME', 電話番号: "'11111111111", 施術メモ: '別番号のメモ' })];
  const response = fixture({ records }).send(selected());
  assert.equal(response.ok, true);
  assert.deepEqual(response.reservations.map(row => row.code), ['LM-SELECTED']);
  assert.equal(response.reservations[0].note, booking().施術メモ);
});

test('旧形式・記号・object property名の予約番号と多数指定に件数上限を加えない', () => {
  const codes = ['旧予約/?', '???', '__proto__', 'constructor', 'toString', '42', ' code with spaces '];
  const records = codes.map(code => booking({ 予約番号: code }));
  const response = fixture({ records }).send(selected(codes));
  assert.equal(response.ok, true);
  assert.deepEqual(response.reservations.map(row => row.code), codes);
  const all = fixture({ records: HISTORY }).send(selected(HISTORY.map(record => record.予約番号)));
  assert.equal(all.ok, true);
  assert.equal(all.reservations.length, HISTORY.length);
});

const INVALID_PAYLOADS = [
  selected([]), selected(null), selected('LM-SELECTED'), selected({ code: 'LM-SELECTED' }), selected(1),
  selected(['']), selected([' \t\n']), selected([null]), selected([42]), selected([{}]), selected([[]]),
  selected(['LM-SELECTED', 'LM-SELECTED']), selected(['LM-SELECTED', '']),
  { ...selected(), briefPast: true }, { reservationCodes: ['LM-SELECTED'] },
  { reservationCodes: ['LM-SELECTED'], startupOnly: true },
  { ...selected(), reservationsOnly: false }, { ...selected(), reservationsOnly: 'true' },
  { ...selected(), notificationsOnly: true }, { reservationCodes: ['LM-SELECTED'], editorTarget: 'styles' }
];
for (const [index, payload] of INVALID_PAYLOADS.entries()) {
  test(`不正な選択引数${index + 1}を全量成功へfallbackせず台帳にも触れない`, () => {
    const app = fixture();
    assertFailure(app.send(payload));
    assert.deepEqual(app.reads, []);
    assert.deepEqual(app.accesses, []);
  });
}

for (const header of REQUIRED_HEADERS) {
  for (const corruption of ['missing', 'duplicate']) {
    test(`選択詳細の見出し${header}が${corruption}なら空詳細の成功にしない`, () => {
      const app = fixture();
      const headers = app.sheets.get('予約一覧').cells[0];
      if (corruption === 'missing') headers[headers.indexOf(header)] = '独自列';
      else headers.push(header);
      assertFailure(app.send(selected()));
    });
  }
}

for (const corruption of ['missing', 'empty', 'blank']) {
  test(`台帳${corruption}を選択ゼロ件の成功にしない`, () => {
    const app = fixture();
    if (corruption === 'missing') app.sheets.delete('予約一覧');
    else if (corruption === 'empty') app.sheets.get('予約一覧').cells.length = 0;
    else app.sheets.get('予約一覧').cells[0].fill('');
    assertFailure(app.send(selected()));
  });
}

for (const codes of [['LM-MISSING'], ['LM-SELECTED', 'LM-MISSING']]) {
  test(`要求した番号の欠落を部分成功にしない：${codes.join(',')}`, () => {
    assertFailure(fixture().send(selected(codes)));
    assertFailure(fixture({ records: [] }).send(selected(codes)));
  });
}

test('選択番号の重複を先頭行の成功にしない', () => {
  const records = [booking(), booking({ お名前: '架空 重複', 施術メモ: '重複側のメモ' })];
  assertFailure(fixture({ records }).send(selected()));
});

test('別番号の重複とその配送履歴が正しい選択を妨げず、選択側の配送metadataを保持する', () => {
  const records = [booking(), booking({ 予約番号: 'LM-OTHER' }), booking({ 予約番号: 'LM-OTHER' })];
  const app = fixture({ records, deliveryIndices: [0, 1] });
  const response = app.send(selected());
  assert.equal(response.ok, true);
  assert.equal(response.reservations.length, 1);
  assert.equal(response.reservations[0].shopMailStatus, '新規予約：送信処理受付');
  assert.equal(response.reservations[0].customerMailStatus, '新規予約：送信結果不明');
  assert.deepEqual(app.mappedCodes, ['LM-SELECTED']);
  assert.equal(JSON.stringify(response).includes('配送本文は返さない'), false);
  assert.equal(app.accesses.some(name => ['メニュー', 'おすすめメニュー', 'スタイル', '口コミ', '設定'].includes(name)), false);
});

for (const failure of ['予約一覧', '休業日', '予約メール配送']) {
  test(`選択取得の${failure}読込障害を成功にしない`, () => {
    assertFailure(fixture({ failure, deliveryIndices: failure === '予約メール配送' ? [0] : [] }).send(selected()));
  });
}

test('既存closedDatesの見出し検査を維持し、未作成なら空配列を返す', () => {
  for (const corruption of ['missing', 'duplicate']) {
    const app = fixture();
    const headers = app.sheets.get('休業日').cells[0];
    if (corruption === 'missing') headers[0] = '不明';
    else headers.push(headers[0]);
    assertFailure(app.send(selected()));
  }
  const app = fixture();
  app.sheets.delete('休業日');
  assert.deepEqual(app.send(selected()).closedDates, []);
});

for (const payload of [selected(), selected([]), { reservationCodes: ['LM-SELECTED'] }]) {
  test(`認証失敗で選択引数を解釈する前に拒否し、情報・台帳読込なし：${JSON.stringify(payload)}`, () => {
    const denied = fixture({ denied: true });
    const response = denied.send(payload);
    assertFailure(response);
    assert.equal(response.authDenied, true);
    assert.deepEqual(denied.accesses, []);
    assert.deepEqual(denied.reads, []);
    const legacy = fixture();
    assertFailure(legacy.legacy(payload));
    assert.deepEqual(legacy.accesses, []);
    assert.deepEqual(legacy.reads, []);
  });
}

test('指定なしの全量・briefPast・startup・編集・通知の既存契約を旧HEADと照合する', () => {
  const records = [booking(), booking({ 予約番号: 'LM-FUTURE', 来店日: FUTURE }),
    booking({ 予約番号: 'LM-CANCELLED', 状態: 'キャンセル済み' })];
  for (const deliveryIndices of [[], [0]]) {
    for (const payload of [{}, { startupOnly: true }, { startupOnly: true, briefPast: true },
      { reservationsOnly: true }, { reservationsOnly: true, briefPast: true }, { briefPast: true },
      { notificationsOnly: true }, { editorTarget: 'styles' }, { editorTarget: 'reviews' }]) {
      const app = fixture({ records, deliveryIndices });
      const baseline = fixture({ records, deliveryIndices, source: BASELINE_SOURCE });
      assert.deepEqual(app.send(payload), baseline.send(payload));
      const unchangedRead = read => read.name !== '設定' && !(read.name === '予約一覧' && read.height === 1);
      assert.deepEqual(app.reads.filter(unchangedRead), baseline.reads.filter(unchangedRead));
      const full = !payload.reservationsOnly && !payload.notificationsOnly && !payload.editorTarget;
      const deliveryReads = deliveryIndices.length ? 2 : 0;
      const expectedReads = full ? (payload.startupOnly ? 5 : 7) + deliveryReads
        : payload.editorTarget ? 1 : (payload.notificationsOnly ? 1 : 2) + deliveryReads;
      assert.equal(app.reads.length, expectedReads);
      assert.equal(app.reads.filter(read => read.name === '設定').length, full ? 1 : 0);
      assert.equal(app.reads.filter(read => read.name === '予約一覧' && read.height === 1).length, 0);
      for (const target of ['spreadsheet', '予約一覧']) {
        assert.equal(app.accesses.filter(name => name === target).length,
          baseline.accesses.filter(name => name === target).length - (full ? 1 : 0));
      }
      const otherAccess = name => !['spreadsheet', '予約一覧'].includes(name);
      assert.deepEqual(app.accesses.filter(otherAccess).toSorted(), baseline.accesses.filter(otherAccess).toSorted());
    }
  }
  for (const header of ['施術メモ', 'ご要望']) {
    const app = fixture();
    const baseline = fixture({ source: BASELINE_SOURCE });
    for (const target of [app, baseline]) {
      const headers = target.sheets.get('予約一覧').cells[0];
      headers[headers.indexOf(header)] = '旧形式の独自列';
    }
    assert.deepEqual(app.send({ reservationsOnly: true }), baseline.send({ reservationsOnly: true }));
  }
});
