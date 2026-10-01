import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const BOOKING = { 予約番号: 'LM-IDENTITY', 来店日: '2030-01-05', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 状態: '予約確定', お名前: '番号照合試験', 電話番号: '00000000000', メール: 'identity@example.test' };

function fixture({ records = [BOOKING], admin = true, headers: initialHeaders } = {}) {
  const writes = [];
  const notifications = [];
  const reads = [];
  let held = false;
  let headers;
  const copies = structuredClone(records);
  const sheet = {
    getParent: () => ({ getSheetByName: () => null }),
    getLastRow: () => copies.length ? copies.length + 1 : 0,
    getLastColumn: () => headers.length,
    getRange(row, column, numRows = 1, numColumns = 1) {
      const range = {
        getValues() {
          assert.equal(held, true);
          reads.push({ row, column, numRows, numColumns });
          const values = [headers, ...copies.map(record => headers.map(header => record[header] ?? ''))];
          return values.slice(row - 1, row - 1 + numRows).map(cells => cells.slice(column - 1, column - 1 + numColumns));
        },
        setValue(value) {
          assert.equal(held, true);
          writes.push({ row, column, value });
          copies[row - 2][headers[column - 1]] = value;
          return range;
        },
        setValues(values) {
          values.forEach((cells, rowIndex) => cells.forEach((value, columnIndex) => {
            writes.push({ row: row + rowIndex, column: column + columnIndex, value });
            copies[row - 2 + rowIndex][headers[column - 1 + columnIndex]] = value;
          }));
          return range;
        },
        setFontLine: () => range, setFontColor: () => range
      };
      return range;
    }
  };
  const context = vm.createContext({ Date, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  vm.runInContext(SOURCE, context);
  headers = initialHeaders || Array.from(vm.runInContext('HEADERS', context));
  context.getSheet_ = () => sheet;
  context.requireAdmin_ = () => { if (!admin) throw new Error('試験用の管理者拒否'); };
  context.isAdmin_ = () => admin;
  context.draftMode_ = () => false;
  context.readBookingSettings_ = () => ({});
  context.ensureHeaders_ = () => {};
  context.recordMailStatus_ = () => {};
  for (const name of ['notify_', 'mailCustomer_', 'notifyLine_']) context[name] = () => {
    notifications.push(name);
    return '送信処理受付';
  };
  return { copies, writes, notifications, reads, held: () => held,
    find: code => context.withLedgerLock_(() => context.findRowByCode_(sheet, code)),
    send: request => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
      code: BOOKING.予約番号, tel: BOOKING.電話番号, ...request
    }) } })) };
}

for (const type of ['lookup', 'cancel', 'change', 'adminChange', 'adminNote', 'review', 'reserve']) {
  test(`${type}で同じ番号の予約を先頭だけ選ばず、個人情報・更新・通知へ渡さない`, () => {
    const app = fixture({ records: [BOOKING, { ...BOOKING, 開始: '14:00', 終了: '15:00' }] });
    const before = structuredClone(app.copies);
    const result = app.send({ type, body: '試験のご感想', note: '新しいメモ', date: '2030-01-06', time: '14:00' });
    assert.equal(result.ok, false);
    assert.match(result.error, /予約番号.*重複/);
    assert.equal(result.reservation, undefined);
    assert.equal(JSON.stringify(result).includes(BOOKING.お名前), false);
    assert.equal(JSON.stringify(result).includes(BOOKING.メール), false);
    assert.deepEqual(app.copies, before);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.notifications, []);
    assert.equal(app.held(), false);
  });
}

for (const duplicate of [{ 予約番号: 'ｌｍーｉｄｅｎｔｉｔｙ' }, { 状態: 'キャンセル' },
  { 電話番号: '00000000001', お名前: '別の試験客' }]) {
  test(`表記・状態・お客様が違っても同じ正規化番号なら曖昧な照合を止める：${JSON.stringify(duplicate)}`, () => {
    const app = fixture({ records: [BOOKING, { ...BOOKING, ...duplicate }] });
    assert.throws(() => app.find(BOOKING.予約番号), /予約番号.*重複/);
    assert.deepEqual(app.writes, []);
    assert.equal(app.held(), false);
  });
}

test('一意な番号・表記ゆれ・存在しない番号・空欄の照合を保持する', () => {
  const app = fixture({ records: [BOOKING, { ...BOOKING, 予約番号: 'LM-OTHER' }] });
  assert.equal(app.find('ｌｍーｉｄｅｎｔｉｔｙ'), 2);
  assert.equal(app.find("'lm-other"), 3);
  assert.equal(app.find('LM-NONE'), -1);
  assert.equal(app.find(''), -1);
  assert.equal(app.send({ type: 'lookup' }).reservation.name, BOOKING.お名前);
  assert.deepEqual(app.writes, []);
});

test('別の番号の重複を理由に、正常な予約の照会を一律停止しない', () => {
  const app = fixture({ records: [BOOKING, { ...BOOKING, 予約番号: 'LM-OTHER' },
    { ...BOOKING, 予約番号: 'LM-OTHER', 開始: '14:00' }] });
  assert.equal(app.send({ type: 'lookup' }).ok, true);
  assert.equal(app.find(BOOKING.予約番号), 2);
});

test('一意な正常予約の取消と取消済みへの再送を保持する', () => {
  const app = fixture();
  assert.equal(app.send({ type: 'cancel' }).ok, true);
  assert.equal(app.copies[0].状態, 'キャンセル');
  assert.equal(app.writes.length, 1);
  assert.equal(app.notifications.length, 3);
  assert.equal(app.send({ type: 'cancel' }).alreadyCancelled, true);
  assert.equal(app.writes.length, 1);
  assert.equal(app.notifications.length, 3);
});

test('列を並べ替えた正常な台帳でも、予約番号の列で一意に照合する', () => {
  const app = fixture({ headers: ['電話番号', '独自列', '予約番号', '来店日', '開始', '終了'],
    records: [{ ...BOOKING, 独自列: 'LM-OTHER' }, { ...BOOKING, 予約番号: 'LM-OTHER' }] });
  assert.equal(app.find(BOOKING.予約番号), 2);
  assert.equal(app.find('LM-OTHER'), 3);
  assert.equal(app.reads.length, 4, '検査を増やしても列の読込回数は増やさない');
});

test('空の台帳と空欄の番号は見つからず、台帳へ書き込まない', () => {
  const app = fixture({ records: [] });
  assert.equal(app.find(BOOKING.予約番号), -1);
  assert.equal(app.find(null), -1);
  assert.deepEqual(app.reads, []);
  assert.deepEqual(app.writes, []);
});

test('管理者の認証拒否では、番号の重複を確認する前に止める', () => {
  const app = fixture({ admin: false, records: [BOOKING, BOOKING] });
  const result = app.send({ type: 'adminNote', note: '更新しない' });
  assert.equal(result.ok, false);
  assert.match(result.error, /管理者拒否/);
  assert.deepEqual(app.reads, []);
  assert.deepEqual(app.writes, []);
});
