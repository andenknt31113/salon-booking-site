import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const SCRIPT = new vm.Script(SOURCE);
const NOW = '2026-10-02T15:00:00.000Z';
const TODAY = '2026-10-03';
const PAST = '2025-10-02';
const FUTURE = '2026-10-04';
const HISTORY_COUNT = 5000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const STATUSES = ['予約確定', 'キャンセル済み', '来店記録なし', ''];
const PRICES = [4000, 0, 8800, -2000];
const BRIEF_REQUESTS = [{ startupOnly: true, briefPast: true }, { reservationsOnly: true, briefPast: true }];

function booking(overrides = {}) {
  return { 予約番号: 'LM-BRIEF', 来店日: PAST, 開始: '10:00', 終了: '11:00',
    '所要(分)': 60, メニュー: '架空カット', 担当: '架空担当', 担当ID: 'st01', 指名料: 500,
    合計金額: 4000, お名前: '架空 過去履歴', フリガナ: 'カクウ', 電話番号: "'00000000000",
    メール: 'history@example.test', 来店回数: '再来', 予約の入口: '電話', 状態: '予約確定',
    ご要望: '過去の要望本文', 施術メモ: '過去の施術メモ本文',
    店舗メール状態: '送信結果不明', お客様メール状態: '停止中', ...overrides };
}

function formatDate(value, zone, format) {
  assert.equal(zone, 'Asia/Tokyo');
  const shifted = new Date(value.getTime() + JST_OFFSET_MS).toISOString();
  if (format === 'HH:mm') return shifted.slice(11, 16);
  assert.equal(format, 'yyyy-MM-dd');
  return shifted.slice(0, 10);
}

function fixture({ records = [booking()], now = NOW, denied = false, failure = '', delivery = false, repairSettings = false } = {}) {
  let held = false;
  let authorized = false;
  const reads = [];
  const accesses = [];
  const writes = [];
  const sheets = new Map();
  const properties = new Map([['ADMIN_GOOGLE_ONLY', 'true']]);
  const forbidWrite = operation => () => {
    writes.push(operation);
    throw new Error('架空シートへの書込は禁止');
  };
  const settingWrite = (operation, name, coordinates = {}) => {
    if (!repairSettings || name !== '設定') return forbidWrite(operation)();
    assert.equal(held, true);
    assert.equal(authorized, true);
    writes.push({ operation, name, ...coordinates });
  };
  const spreadsheet = { getSheetByName(name) {
    accesses.push(name);
    assert.equal(held, true);
    assert.equal(authorized, true, '認証前に架空シートへ触れない');
    return sheets.get(name) || null;
  }, insertSheet(name) {
    settingWrite('insertSheet', name);
    const sheet = add(name, []);
    sheet.cells.length = 0;
    return sheet;
  } };
  const context = vm.createContext({
    Date: class extends Date {
      constructor(...values) { super(...(values.length ? values : [now])); }
      static now() { return Date.parse(now); }
    },
    console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) ?? null,
      setProperty: forbidWrite('setProperty'), deleteProperty: forbidWrite('deleteProperty')
    }) },
    SpreadsheetApp: { getActiveSpreadsheet() {
      accesses.push('spreadsheet');
      assert.equal(held, true);
      assert.equal(authorized, true);
      return spreadsheet;
    }, flush: forbidWrite('flush') },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; }
    }) },
    Utilities: { formatDate, DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => Array.from(createHash('md5').update(value).digest()) }
  });
  SCRIPT.runInContext(context);
  context.verifyGoogleAdmin_ = () => {
    if (denied) throw new Error('架空の管理権限拒否');
    authorized = true;
  };
  const constants = name => Array.from(vm.runInContext(name, context));
  function add(name, headers, values = []) {
    const cells = [Array.from(headers), ...values.map(record => Array.isArray(record)
      ? Array.from(record) : headers.map(header => record[header] ?? ''))];
    const range = (row, column, height = 1, width = 1) => ({
      getValues() {
        reads.push({ name, row, column, height, width });
        assert.equal(held, true);
        assert.equal(authorized, true);
        if (name === failure) throw new Error('架空の読込障害');
        return Array.from({ length: height }, (_unused, rowIndex) =>
          Array.from({ length: width }, (_cell, columnIndex) => {
            const value = cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? '';
            return value instanceof Date ? new context.Date(value.getTime()) : value;
          }));
      },
      setValue: forbidWrite('setValue'),
      setValues(values) {
        settingWrite('setValues', name, { row, column });
        values.forEach((line, rowIndex) => line.forEach((value, columnIndex) => {
          cells[row - 1 + rowIndex] ||= [];
          cells[row - 1 + rowIndex][column - 1 + columnIndex] = value;
        }));
      },
      setNote() {
        settingWrite('setNote', name, { row, column });
      },
      setFontWeight() { settingWrite('setFontWeight', name); return this; },
      setBackground() { settingWrite('setBackground', name); return this; }
    });
    const sheet = { cells, getParent: () => spreadsheet, getLastRow: () => cells.length,
      getLastColumn: () => cells[0].length, getRange: range,
      getDataRange: () => range(1, 1, cells.length, cells[0]?.length || 0),
      appendRow(values) {
        settingWrite('appendRow', name);
        cells.push(Array.from(values));
      }, setFrozenRows() { settingWrite('setFrozenRows', name); },
      setColumnWidth() { settingWrite('setColumnWidth', name); } };
    sheets.set(name, sheet);
    return sheet;
  }
  const ledger = add('予約一覧', constants('HEADERS'), records);
  add('メニュー', constants('MENU_HEADERS'), [{ メニュー名: '架空カット', 価格: 4000, '所要(分)': 60 }]);
  add('おすすめメニュー', constants('COUPON_HEADERS'));
  add('スタイル', constants('STYLE_HEADERS'), [{ タイトル: '架空写真', 画像: 'assets/style1.jpg' }]);
  add('口コミ', constants('REVIEW_HEADERS'), [{ 本文: '架空口コミ', 状態: '非掲載' }]);
  add('休業日', constants('CLOSED_HEADERS'), [{ 休業日: FUTURE, メモ: '架空休業' }]);
  add('設定', ['項目', '内容'], constants('LISTED_SETTINGS'));
  if (delivery) {
    properties.set('BOOKING_EMAIL_QUEUE_ENABLED', 'true');
    const job = { version: 1, code: context.codeKey_(records[0].予約番号), action: '新規予約',
      created: Date.parse(now), messages: Object.fromEntries(['shop', 'customer'].map(channel => [channel,
        { to: 'delivery@example.test', subject: '架空配送', body: '架空の配送本文',
          status: channel === 'shop' ? '送信処理受付' : '送信結果不明', updated: Date.parse(now) }])) };
    add('予約メール配送', constants('BOOKING_EMAIL_HEADERS'), [['brief-delivery-0001',
      context.bookingEmailSignature_(ledger.cells[1], ledger.cells[0]), JSON.stringify(job)]]);
  }
  function sendRaw(body) {
    authorized = false;
    const response = JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }));
    assert.equal(held, false, '応答後にロックを残さない');
    if (!repairSettings) assert.deepEqual(writes, [], '読取・拒否された変更で書込を行わない');
    return response;
  }
  return { sheets, reads, accesses, writes, context,
    send: (payload = {}, action = 'adminData') => sendRaw({ type: 'googleAdmin', action, payload }),
    legacy: payload => sendRaw({ type: 'adminData', ...payload }) };
}

for (const delivery of [false, true]) {
  test(`初回の完成済み設定を重複取得せず、配送の見出しも予約のsnapshotから読む：${delivery}`, testContext => {
    const app = fixture({ delivery });
    const result = app.send({ startupOnly: true, briefPast: true });
    assert.equal(result.ok, true);
    testContext.diagnostic(`架空シートのgetValues: ${app.reads.length}回`);
    assert.equal(app.reads.filter(read => read.name === '設定').length, 1);
    assert.equal(app.reads.filter(read => read.name === '予約一覧' && read.height === 1).length, 1,
      'getSheet_の列確認だけにし、配送表示用には読み直さない');
    assert.equal(app.reads.length, delivery ? 8 : 6);
    assert.equal(result.reservations.length, 1);
    assertPending(result.reservations[0]);
    if (delivery) assert.match(result.reservations[0].customerMailStatus, /送信結果不明/);
  });
}

for (const payload of [{}, { reservationsOnly: true }, { reservationsOnly: true, reservationCodes: ['LM-BRIEF'] },
  { notificationsOnly: true }]) {
  test(`配送表示に読込済みの見出しを渡し、既存の応答範囲を保つ：${JSON.stringify(payload)}`, () => {
    const app = fixture({ delivery: true });
    const result = app.send(payload);
    assert.equal(result.ok, true);
    assert.match(result.reservations[0].customerMailStatus, /送信結果不明/);
    assert.equal(app.reads.filter(read => read.name === '予約一覧' && read.height === 1).length,
      Object.keys(payload).length ? 0 : 1);
    if (payload.notificationsOnly) {
      assert.equal(Object.hasOwn(result.reservations[0], 'note'), false);
      assert.equal(Object.hasOwn(result.reservations[0], 'email'), false);
    } else assert.equal(result.reservations[0].note, booking().施術メモ);
  });
}

test('不足する設定行を補完した場合だけ取り直し、空欄・0・false・独自の行は書き換えない', () => {
  const app = fixture({ repairSettings: true });
  const sheet = app.sheets.get('設定');
  const missing = sheet.cells.find(row => row[0] === '電話番号');
  assert.ok(missing);
  sheet.cells.splice(sheet.cells.indexOf(missing), 1);
  sheet.cells.find(row => row[0] === '店の紹介文')[1] = '';
  sheet.cells.push(['独自の数値', 0], ['独自の選択', false]);
  const before = structuredClone(sheet.cells);
  const result = app.send({ startupOnly: true });
  assert.equal(result.ok, true);
  assert.deepEqual(sheet.cells.slice(0, before.length), before);
  assert.equal(result.settings.電話番号, missing[1]);
  assert.equal(result.settings.店の紹介文, '');
  assert.equal(result.settings.独自の数値, 0);
  assert.equal(result.settings.独自の選択, false);
  assert.equal(app.reads.filter(read => read.name === '設定').length, 2);
  assert.deepEqual(app.writes.filter(write => write.operation === 'setValues'),
    [{ operation: 'setValues', name: '設定', row: before.length + 1, column: 1 }]);
  const width = sheet.cells[0].length;
  assert.equal(result.stamps.settings, app.context.stampValues_(sheet.cells.map(row => row.slice(0, width))));
});

test('設定の独自列をstampへ含め、次の要求は変更後の実データを新しく取得する', () => {
  const app = fixture();
  const sheet = app.sheets.get('設定');
  sheet.cells[0].push('独自の控え');
  for (const row of sheet.cells.slice(1)) row[2] = '架空の控え';
  const before = structuredClone(sheet.cells);
  const initial = app.send({ startupOnly: true });
  assert.equal(initial.ok, true);
  assert.equal(initial.stamps.settings, app.context.stampValues_(before));
  assert.deepEqual(sheet.cells, before);
  sheet.cells.find(row => row[0] === '店の紹介文')[1] = '変更後の試験紹介文';
  const next = app.send({ startupOnly: true });
  assert.equal(next.ok, true);
  assert.equal(next.settings.店の紹介文, '変更後の試験紹介文');
  assert.notEqual(next.stamps.settings, initial.stamps.settings);
  assert.equal(app.reads.filter(read => read.name === '設定').length, 2);
});

for (const missing of [false, true]) {
  test(`設定sheetが空か未作成でも従来の初期化と補完後の読み直しを維持する：${missing}`, () => {
    const app = fixture({ repairSettings: true });
    if (missing) app.sheets.delete('設定');
    else app.sheets.get('設定').cells.length = 0;
    const result = app.send({ startupOnly: true });
    assert.equal(result.ok, true);
    const sheet = app.sheets.get('設定');
    const defaults = Array.from(vm.runInContext('LISTED_SETTINGS', app.context));
    assert.deepEqual(sheet.cells, [['項目', '内容'], ...defaults.map(row => Array.from(row).slice(0, 2))]);
    assert.equal(result.settings.電話番号, defaults.find(row => row[0] === '電話番号')[1]);
    assert.equal(result.stamps.settings, app.context.stampValues_(sheet.cells));
    assert.ok(app.writes.every(write => write.name === '設定'));
  });
}

function withoutDetails(reservation) {
  const { note, request, detailsPending, ...fields } = reservation;
  return fields;
}

function assertPending(reservation) {
  assert.equal(Object.hasOwn(reservation, 'note'), false);
  assert.equal(Object.hasOwn(reservation, 'request'), false);
  assert.equal(reservation.detailsPending, true);
}

test('架空の過去5000件を全件保持し、件数・価格・状態・全項目を変えず初回JSONを減らす', testContext => {
  const records = Array.from({ length: HISTORY_COUNT }, (_unused, index) => booking({
    予約番号: `LM-HISTORY-${index}`, お名前: `架空顧客${index}`, 状態: STATUSES[index % STATUSES.length],
    合計金額: PRICES[index % PRICES.length], 予約の入口: index % 2 ? '電話' : '直接',
    施術メモ: '初回から外す過去の施術メモ：'.repeat(20), ご要望: '初回から外す過去の要望：'.repeat(20)
  })).concat([booking({ 予約番号: 'LM-TODAY', 来店日: TODAY }), booking({ 予約番号: 'LM-FUTURE', 来店日: FUTURE })]);
  const full = fixture({ records }).send({ startupOnly: true });
  const app = fixture({ records });
  const brief = app.send(BRIEF_REQUESTS[0]);
  assert.equal(brief.ok, true);
  assert.equal(brief.reservations.length, HISTORY_COUNT + 2);
  assert.deepEqual(brief.reservations.map(withoutDetails), full.reservations.map(withoutDetails));
  assert.equal(brief.reservations.reduce((total, row) => total + row.price, 0),
    full.reservations.reduce((total, row) => total + row.price, 0));
  for (const status of STATUSES.concat('キャンセル')) {
    assert.equal(brief.reservations.filter(row => row.status === status).length,
      full.reservations.filter(row => row.status === status).length);
  }
  for (const row of brief.reservations.filter(row => row.date === PAST)) assertPending(row);
  for (const row of brief.reservations.filter(row => row.date !== PAST)) {
    assert.deepEqual(row, full.reservations.find(original => original.code === row.code));
  }
  const { reservations: fullRows, ...fullOther } = full;
  const { reservations: briefRows, ...briefOther } = brief;
  assert.deepEqual(briefOther, fullOther);
  const fullSize = Buffer.byteLength(JSON.stringify(full));
  const briefSize = Buffer.byteLength(JSON.stringify(brief));
  assert.ok(briefSize < fullSize, '同じstartupOnly応答の転送量が減る');
  assert.equal(JSON.stringify(brief).includes('初回から外す過去'), false);
  assert.equal(app.reads.filter(read => read.name === '予約一覧' && read.height === records.length + 1).length, 1);
  testContext.diagnostic(`架空5002件のJSON: ${fullSize} → ${briefSize} bytes`);
});

for (const payload of BRIEF_REQUESTS) {
  test(`今日と未来を一切省略せず、過去の非空詳細だけ遅延する：${JSON.stringify(payload)}`, () => {
    const records = [booking(), booking({ 予約番号: 'LM-TODAY', 来店日: TODAY }),
      booking({ 予約番号: 'LM-FUTURE', 来店日: FUTURE })];
    const full = fixture({ records }).send({ reservationsOnly: true });
    const brief = fixture({ records }).send(payload);
    assert.equal(brief.ok, true);
    assertPending(brief.reservations.find(row => row.date === PAST));
    for (const row of brief.reservations.filter(row => row.date !== PAST)) {
      assert.deepEqual(row, full.reservations.find(original => original.code === row.code));
    }
  });

  test(`詳細取得と従来全量APIでnote/requestが戻り、架空シートの値を変えない：${JSON.stringify(payload)}`, () => {
    const app = fixture();
    const before = structuredClone(app.sheets.get('予約一覧').cells);
    assertPending(app.send(payload).reservations[0]);
    for (const fullRequest of [{}, { startupOnly: true }, { reservationsOnly: true }, { briefPast: true }]) {
      const full = app.send(fullRequest);
      assert.equal(full.ok, true);
      assert.equal(full.reservations[0].note, booking().施術メモ);
      assert.equal(full.reservations[0].request, booking().ご要望);
      assert.equal(Object.hasOwn(full.reservations[0], 'detailsPending'), false);
    }
    assert.deepEqual(app.sheets.get('予約一覧').cells, before);
  });

  test(`省略前後で既存の全行読込回数を保持する：${JSON.stringify(payload)}`, () => {
    const app = fixture();
    const full = fixture();
    const { briefPast, ...fullPayload } = payload;
    assert.equal(app.send(payload).ok, true);
    assert.equal(full.send(fullPayload).ok, true);
    assert.deepEqual(app.reads, full.reads);
    assert.deepEqual(app.accesses, full.accesses);
    assert.equal(app.reads.length, payload.startupOnly ? 6 : 2);
  });

  test(`配送結果は実配送記録を維持し、配送シートの読込も増やさない：${JSON.stringify(payload)}`, () => {
    const app = fixture({ delivery: true });
    const fullApp = fixture({ delivery: true });
    const { briefPast, ...fullPayload } = payload;
    const full = fullApp.send(fullPayload);
    const brief = app.send(payload);
    assert.equal(brief.ok, true);
    assert.equal(full.ok, true);
    assertPending(brief.reservations[0]);
    assert.deepEqual(withoutDetails(brief.reservations[0]), withoutDetails(full.reservations[0]));
    assert.equal(brief.reservations[0].shopMailStatus, '新規予約：送信処理受付');
    assert.equal(brief.reservations[0].customerMailStatus, '新規予約：送信結果不明');
    assert.deepEqual(app.reads, fullApp.reads);
  });
}

for (const fields of [{ 施術メモ: '', ご要望: '' }, { 施術メモ: '', ご要望: '片方の要望' },
  { 施術メモ: '片方のメモ', ご要望: '' }, { 施術メモ: ' ', ご要望: '' }, { 施術メモ: "'=数式ではないメモ", ご要望: '' }]) {
  test(`空欄と片方だけ非空を区別する：${JSON.stringify(fields)}`, () => {
    for (const payload of BRIEF_REQUESTS) {
      const records = [booking(fields)];
      const full = fixture({ records }).send({ reservationsOnly: true }).reservations[0];
      const brief = fixture({ records }).send(payload).reservations[0];
      if (fields.施術メモ || fields.ご要望) assertPending(brief);
      else assert.deepEqual(brief, full);
    }
  });
}

for (const now of ['2026-10-02T14:59:59.999Z', '2026-10-02T15:00:00.000Z']) {
  test(`東京の午前0時境界で今日が切り替わる：${now}`, () => {
    const records = [booking({ 来店日: '2026-10-02' })];
    for (const payload of BRIEF_REQUESTS) {
      const result = fixture({ records, now }).send(payload);
      assert.equal(result.ok, true);
      if (now === NOW) assertPending(result.reservations[0]);
      else assert.deepEqual(result.reservations, fixture({ records, now }).send({ reservationsOnly: true }).reservations);
    }
  });
}

test('不正日付・空番号・不正番号・重複番号を削除や合計・状態の捏造で処理しない', () => {
  const dates = ['', '不明', '2025-02-29', '2024-02-30', '2025-04-31', '2025-13-01', '2025-00-01', '2025-01-00', '0'];
  const records = dates.map((date, index) => booking({ 来店日: date, 予約番号: `LM-INVALID-${index}` }))
    .concat(['', '???', 'LM-DUPLICATE', 'LM-DUPLICATE'].map(code => booking({ 予約番号: code, 状態: '独自状態', 合計金額: '不明' })));
  for (const payload of BRIEF_REQUESTS) {
    const full = fixture({ records }).send({ reservationsOnly: true });
    const brief = fixture({ records }).send(payload);
    assert.equal(brief.ok, true);
    assert.equal(brief.reservations.length, records.length);
    assert.deepEqual(brief.reservations.map(withoutDetails), full.reservations.map(withoutDetails));
    brief.reservations.forEach((row, index) => {
      if (row.date === PAST) assertPending(row);
      else assert.deepEqual(row, full.reservations[index]);
    });
  }
});

test('有効なうるう日・表記ゆれ・Dateセルの東京の日付も正しく判定する', () => {
  const records = [booking({ 予約番号: 'LM-LEAP', 来店日: '2024-02-29' }),
    booking({ 予約番号: 'LM-JAPANESE', 来店日: '２０２５年１０月２日' }),
    booking({ 予約番号: 'LM-DATE-PAST', 来店日: new Date('2026-10-01T15:00:00Z') }),
    booking({ 予約番号: 'LM-DATE-TODAY', 来店日: new Date(NOW) })];
  for (const payload of BRIEF_REQUESTS) {
    const result = fixture({ records }).send(payload);
    assert.equal(result.ok, true);
    assert.equal(result.reservations.length, records.length);
    for (const row of result.reservations) {
      if (row.date === TODAY) assert.equal(row.note, booking().施術メモ);
      else assertPending(row);
    }
  }
});

for (const briefPast of [undefined, false, 'true', 1, {}, []]) {
  test(`boolean true以外のbriefPastは互換全量：${JSON.stringify(briefPast)}`, () => {
    for (const payload of BRIEF_REQUESTS) {
      const { briefPast: ignored, ...fullPayload } = payload;
      assert.deepEqual(fixture().send({ ...fullPayload, briefPast }), fixture().send(fullPayload));
    }
  });
}

test('briefPast単独・非booleanのstartupOnly/reservationsOnlyとその他の読取は互換を保つ', () => {
  for (const payload of [{}, { startupOnly: 'true' }, { reservationsOnly: 'true' },
    { notificationsOnly: true }, { notificationsOnly: true, startupOnly: true }, { editorTarget: 'styles', startupOnly: true }]) {
    assert.deepEqual(fixture().send({ ...payload, briefPast: true }), fixture().send(payload));
  }
});

for (const payload of BRIEF_REQUESTS.concat([{ briefPast: true }])) {
  test(`認証拒否ではSpreadsheetに触れず予約情報を返さない：${JSON.stringify(payload)}`, () => {
    const denied = fixture({ denied: true });
    const response = denied.send(payload);
    assert.equal(response.ok, false);
    assert.equal(response.authDenied, true);
    assert.equal(Object.hasOwn(response, 'reservations'), false);
    assert.deepEqual(denied.reads, []);
    assert.deepEqual(denied.accesses, []);
    const legacy = fixture();
    assert.equal(legacy.legacy(payload).ok, false);
    assert.deepEqual(legacy.reads, []);
    assert.deepEqual(legacy.accesses, []);
  });
}

for (const payload of BRIEF_REQUESTS) {
  test(`読込障害と曖昧な見出しを軽量応答の成功にしない：${JSON.stringify(payload)}`, () => {
    for (const failure of ['予約一覧', '休業日']) {
      const result = fixture({ failure }).send(payload);
      assert.equal(result.ok, false);
      assert.equal(Object.hasOwn(result, 'reservations'), false);
    }
    const app = fixture();
    app.sheets.get('予約一覧').cells[0].push('予約番号');
    assert.equal(app.send(payload).ok, false);
  });
}

test('要約受取後もmemoの元内容確認・取消と変更の元日時確認を省略できない', () => {
  const app = fixture();
  const summary = app.send(BRIEF_REQUESTS[0]).reservations[0];
  assertPending(summary);
  for (const expectedNote of [undefined, '', '古い施術メモ']) {
    const result = app.send({ code: summary.code, note: '上書きしてはいけないメモ', expectedNote,
      briefPast: true, detailsPending: true }, 'adminNote');
    assert.equal(result.ok, false);
    if (expectedNote !== undefined) assert.equal(result.conflict, true);
  }
  for (const action of ['cancel', 'adminChange']) {
    const stale = app.send({ code: summary.code, fromDate: TODAY, fromTime: summary.time,
      date: FUTURE, time: '12:00', detailsPending: true, briefPast: true }, action);
    assert.equal(stale.ok, false);
    assert.equal(stale.stale, true);
  }
  assert.equal(app.send({ code: summary.code, fromDate: summary.date, fromTime: summary.time,
    date: FUTURE, time: '12:00' }, 'adminChange').ok, false, '過去の予約変更も引き続き拒否する');
  assert.equal(app.send({ code: '???', note: '不正番号へのメモ' }, 'adminNote').ok, false);
  const full = app.send({ reservationsOnly: true }).reservations[0];
  assert.equal(full.note, booking().施術メモ);
  assert.equal(full.status, booking().状態);
  assert.equal(full.date, booking().来店日);
});
