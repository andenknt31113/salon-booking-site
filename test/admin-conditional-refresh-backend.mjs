import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const SCRIPT = new vm.Script(SOURCE);
const NOW = Date.parse('2030-01-05T03:00:00.000Z');
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const REQUEST = { reservationsOnly: true, ifNoneMatch: '' };
const BOOKING = { 予約番号: 'LM-COND1', 来店日: '2030-01-06', 開始: '10:00', 終了: '11:00',
  メニュー: '架空カット', 担当: '架空担当', 合計金額: 4000, お名前: '架空のお客様',
  電話番号: "'00000000000", メール: 'customer@example.test', 来店回数: '再来',
  予約の入口: '電話', ご要望: '架空の要望', 施術メモ: '保持するメモ', 状態: '予約確定',
  店舗メール状態: '送信処理受付', お客様メール状態: '宛先なし' };

function fixture({ records = [BOOKING], delivery = false, denied = false, failure = '' } = {}) {
  let now = NOW;
  let held = false;
  let authorized = false;
  const reads = [];
  const accesses = [];
  const writes = [];
  const sheets = new Map();
  const forbidWrite = operation => () => { writes.push(operation); throw new Error('架空の書込禁止'); };
  const spreadsheet = { getSheetByName(name) {
    assert.ok(held && authorized);
    accesses.push(name);
    return sheets.get(name) || null;
  }, insertSheet: forbidWrite('insertSheet') };
  class ClockDate extends Date {
    constructor(...values) { super(...(values.length ? values : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({ Date: ClockDate,
    console: { log() {}, warn() {}, error() {} },
    SpreadsheetApp: { getActiveSpreadsheet() { assert.ok(held && authorized); return spreadsheet; },
      flush: forbidWrite('flush') },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'ADMIN_GOOGLE_ONLY'
      || delivery && key === 'BOOKING_EMAIL_QUEUE_ENABLED' ? 'true' : null,
      getKeys: () => [], setProperty: forbidWrite('setProperty'), deleteProperty: forbidWrite('deleteProperty') }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => text }) },
    Utilities: { DigestAlgorithm: { MD5: 'md5', SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, value) => Array.from(createHash(algorithm).update(value).digest()),
      formatDate(value, timezone, format) {
        assert.equal(timezone, 'Asia/Tokyo');
        const shifted = new Date(value.getTime() + JST_OFFSET_MS).toISOString();
        if (format === 'HH:mm') return shifted.slice(11, 16);
        assert.equal(format, 'yyyy-MM-dd');
        return shifted.slice(0, 10);
      } }
  });
  SCRIPT.runInContext(context);
  context.verifyGoogleAdmin_ = () => { if (denied) throw new Error('架空の本人確認拒否'); authorized = true; };
  const constants = name => Array.from(vm.runInContext(name, context));
  function add(name, headers, rows = []) {
    const cells = [headers.slice(), ...rows.map(row => Array.isArray(row) ? row.slice()
      : headers.map(header => row[header] ?? ''))];
    const range = (row, column, height = 1, width = 1) => ({ getValues() {
      assert.ok(held && authorized);
      reads.push(name);
      if (failure === name) throw new Error('架空の読込失敗');
      return Array.from({ length: height }, (_unused, rowIndex) =>
        Array.from({ length: width }, (_cell, columnIndex) => cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
    }, setValue: forbidWrite('setValue'), setValues: forbidWrite('setValues') });
    const sheet = { cells, getParent: () => spreadsheet, getLastRow: () => cells.length,
      getLastColumn: () => cells[0].length, getRange: range,
      getDataRange: () => range(1, 1, cells.length, cells[0].length), appendRow: forbidWrite('appendRow') };
    sheets.set(name, sheet);
    return sheet;
  }
  const ledger = add('予約一覧', constants('HEADERS'), records);
  const closed = add('休業日', constants('CLOSED_HEADERS'), [{ 休業日: '2030-01-07', 開始: '14:00', 終了: '15:00', メモ: '架空の部分休業' }]);
  let queue;
  let job;
  if (delivery) {
    job = { version: 1, code: context.codeKey_(BOOKING.予約番号), action: '新規予約', created: NOW,
      messages: Object.fromEntries(['shop', 'customer'].map(channel => [channel, { to: 'delivery@example.test',
        subject: '架空通知', body: '架空の本文', status: '配送待ち', updated: NOW }])) };
    queue = add('予約メール配送', constants('BOOKING_EMAIL_HEADERS'), [['conditional-job-0001',
      context.bookingEmailSignature_(ledger.cells[1], ledger.cells[0]), JSON.stringify(job)]]);
  }
  const send = (payload = REQUEST) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
    type: 'googleAdmin', action: 'adminData', payload }) } }));
  return { context, ledger, closed, queue, job, reads, accesses, writes, send,
    held: () => held, advance: duration => { now += duration; },
    change(field, value) { ledger.cells[1][ledger.cells[0].indexOf(field)] = value; } };
}

test('初回は全件と版を返し、同じ版の再読込でも最新台帳と休業を読み、内容一致時だけ短い応答を返す', () => {
  const app = fixture();
  const first = app.send();
  assert.equal(first.ok, true);
  assert.match(first.refreshVersion, /^[a-f0-9]{64}$/);
  assert.equal(first.reservations.length, 1);
  assert.equal(first.reservations[0].note, BOOKING.施術メモ);
  assert.deepEqual(app.reads, ['予約一覧', '休業日']);
  const next = app.send({ ...REQUEST, ifNoneMatch: first.refreshVersion });
  assert.deepEqual(next, { ok: true, unchanged: true, refreshVersion: first.refreshVersion });
  assert.deepEqual(app.reads, ['予約一覧', '休業日', '予約一覧', '休業日']);
  assert.deepEqual(app.writes, []);
  assert.equal(app.held(), false);
});

test('旧クライアントの取得形式を変えず、空台帳も条件付き再読込できる', () => {
  const app = fixture({ records: [] });
  const legacy = app.send({ reservationsOnly: true });
  assert.deepEqual(Object.keys(legacy).sort(), ['closedDates', 'ok', 'reservations']);
  const first = app.send();
  assert.deepEqual(first.reservations, []);
  assert.equal(app.send({ ...REQUEST, ifNoneMatch: first.refreshVersion }).unchanged, true);
});

for (const [field, value] of Object.entries({ 予約番号: 'LM-COND2', 来店日: '2030-01-08', 開始: '12:00', 終了: '13:00',
  メニュー: '別の架空施術', 担当: '別の架空担当', 合計金額: 6000, お名前: '別の架空名',
  電話番号: "'00000000001", メール: 'changed@example.test', 来店回数: '初来店',
  予約の入口: 'LINE', ご要望: '別の要望', 施術メモ: '保存後のメモ', 状態: 'キャンセル',
  店舗メール状態: '送信結果不明', お客様メール状態: '停止中' })) {
  test(`${field}を別要求で変更したら古い版で変更なしと言わず、全件を返す`, () => {
    const app = fixture();
    const first = app.send();
    app.change(field, value);
    const result = app.send({ ...REQUEST, ifNoneMatch: first.refreshVersion });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, undefined);
    assert.notEqual(result.refreshVersion, first.refreshVersion);
    assert.equal(result.reservations.length, 1);
    assert.deepEqual(app.writes, []);
  });
}

for (const mutate of [app => { app.ledger.cells.push(app.ledger.cells[1].map((value, index) =>
  app.ledger.cells[0][index] === '予約番号' ? 'LM-COND2' : value)); }, app => { app.ledger.cells.splice(1, 1); },
  app => { app.closed.cells[1][1] = '13:00'; }, app => { app.closed.cells[1][3] = '更新した休業メモ'; },
  app => { app.closed.cells.splice(1, 1); }]) {
  test('予約の追加・削除や休業の変更でも全件を返し、件数を切らない', () => {
    const app = fixture();
    const first = app.send();
    mutate(app);
    const result = app.send({ ...REQUEST, ifNoneMatch: first.refreshVersion });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, undefined);
    assert.notEqual(result.refreshVersion, first.refreshVersion);
    assert.equal(result.reservations.length, app.ledger.cells.length - 1);
    assert.equal(result.closedDates.length, app.closed.cells.length - 1);
  });
}

test('配送状態と期限切れを版へ含め、台帳本体が同じでも通知確認を省かない', () => {
  const app = fixture({ delivery: true });
  const first = app.send();
  assert.equal(first.ok, true);
  assert.match(first.reservations[0].shopMailStatus, /配送待ち/);
  app.job.messages.shop.status = '送信処理受付';
  app.queue.cells[1][2] = JSON.stringify(app.job);
  const changed = app.send({ ...REQUEST, ifNoneMatch: first.refreshVersion });
  assert.match(changed.reservations[0].shopMailStatus, /送信処理受付/);
  assert.notEqual(changed.refreshVersion, first.refreshVersion);
  app.advance(vm.runInContext('BOOKING_EMAIL_LEASE_MS', app.context) + 1);
  const stale = app.send({ ...REQUEST, ifNoneMatch: changed.refreshVersion });
  assert.match(stale.reservations[0].customerMailStatus, /配送状況を要確認/);
  assert.notEqual(stale.refreshVersion, changed.refreshVersion);
  assert.equal(app.reads.filter(name => name === '予約メール配送').length, 3);
});

test('詳細取得と索引取得の内容を混ぜず、日付境界でも未取得印を検査する', () => {
  const app = fixture({ records: [{ ...BOOKING, 来店日: '2030-01-05' }] });
  const first = app.send({ ...REQUEST, briefPast: true });
  assert.equal(first.reservations[0].note, BOOKING.施術メモ);
  app.advance(24 * 60 * 60 * 1000);
  const brief = app.send({ ...REQUEST, briefPast: true, ifNoneMatch: first.refreshVersion });
  assert.equal(brief.reservations[0].detailsPending, true);
  assert.notEqual(brief.refreshVersion, first.refreshVersion);
  const full = app.send({ ...REQUEST, ifNoneMatch: brief.refreshVersion });
  assert.equal(full.reservations[0].note, BOOKING.施術メモ);
  assert.equal(full.reservations[0].detailsPending, undefined);
});

test('省略している過去メモの内容が変わった場合も変更なしと言わず、表示中の古い詳細を再確認させる', () => {
  const app = fixture({ records: [{ ...BOOKING, 来店日: '2020-01-01' }] });
  const first = app.send({ ...REQUEST, briefPast: true });
  assert.equal(first.reservations[0].detailsPending, true);
  app.change('施術メモ', '別の端末で保存した過去メモ');
  const changed = app.send({ ...REQUEST, briefPast: true, ifNoneMatch: first.refreshVersion });
  assert.equal(changed.ok, true);
  assert.equal(changed.unchanged, undefined);
  assert.notEqual(changed.refreshVersion, first.refreshVersion);
  assert.equal(changed.reservations[0].detailsPending, true);
  assert.equal(changed.reservations[0].note, undefined);
});

for (const payload of [{ ifNoneMatch: '' }, { ...REQUEST, reservationsOnly: false },
  ...[null, [], {}, 1, true, 'short', 'F'.repeat(64), 'g'.repeat(64)].map(ifNoneMatch => ({ ...REQUEST, ifNoneMatch })),
  ...['notificationsOnly', 'startupOnly', 'deferMenus', 'editorTarget', 'reservationCodes'].map(key =>
    ({ ...REQUEST, [key]: key === 'editorTarget' ? 'menus' : key === 'reservationCodes' ? ['LM-COND1'] : false })),
  { ...REQUEST, briefPast: 'true' }]) {
  test('条件付き取得の不正な形式・別用途の混在は、認証後も台帳へ触れる前に断る', () => {
    const app = fixture();
    const result = app.send(payload);
    assert.equal(result.ok, false);
    assert.deepEqual(app.accesses, []);
    assert.deepEqual(app.writes, []);
  });
}

test('認証失敗は版が合っていても内容一致や顧客情報を返さない', () => {
  const app = fixture({ denied: true });
  const result = app.send({ ...REQUEST, ifNoneMatch: 'a'.repeat(64) });
  assert.equal(result.authDenied, true);
  assert.equal(result.refreshVersion, undefined);
  assert.equal(result.unchanged, undefined);
  assert.deepEqual(app.accesses, []);
});

for (const failure of ['予約一覧', '休業日', '予約メール配送']) {
  test(`${failure}を読めなければ一致したと返さず、ロックを解放する`, () => {
    const app = fixture({ failure, delivery: true });
    const result = app.send({ ...REQUEST, ifNoneMatch: 'a'.repeat(64) });
    assert.equal(result.ok, false);
    assert.equal(result.refreshVersion, undefined);
    assert.equal(result.unchanged, undefined);
    assert.equal(app.held(), false);
    assert.deepEqual(app.writes, []);
  });
}

test('5,000件の全履歴を保持し、変更なしの応答だけを小さくする', () => {
  const records = Array.from({ length: 5000 }, (_unused, index) => ({ ...BOOKING,
    予約番号: 'LM-COUNT' + index, 来店日: index % 2 ? '2020-01-01' : '2030-01-06',
    状態: index % 3 ? '予約確定' : 'キャンセル', 施術メモ: '架空の長い履歴'.repeat(20) }));
  const app = fixture({ records });
  const first = app.send();
  assert.equal(first.reservations.length, 5000);
  assert.equal(first.reservations.filter(row => row.status === 'キャンセル').length, 1667);
  const result = app.send({ ...REQUEST, ifNoneMatch: first.refreshVersion });
  assert.equal(result.unchanged, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(JSON.stringify(first)) / 100);
  assert.equal(app.ledger.cells.length, 5001);
  console.log(JSON.stringify({ fullBytes: Buffer.byteLength(JSON.stringify(first)),
    unchangedBytes: Buffer.byteLength(JSON.stringify(result)), reservations: first.reservations.length }));
});
