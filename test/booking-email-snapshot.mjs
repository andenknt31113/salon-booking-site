import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const QUEUE_HEADERS = ['通知ID', '予約照合', '配送内容'];
const FIXED_TIME = Date.parse('2030-01-01T10:00:00+09:00');
const BOOKING_CODE = 'LMSNAPSHOT';

function fixture({ native = true } = {}) {
  const calls = [];
  const writes = [];
  const sent = [];
  let held = false;
  let failing = false;
  let afterHeader;
  const properties = new Map([['BOOKING_EMAIL_QUEUE_ENABLED', 'true']]);
  const sheets = new Map();
  const spreadsheet = { getSheetByName: name => sheets.get(name) || null };
  const record = (sheet, method) => {
    assert.equal(held, true);
    calls.push(`${sheet}:${method}`);
  };
  const makeSheet = (name, initial) => {
    const cells = initial.map(row => row.slice());
    const width = () => Math.max(0, ...cells.map(row => row.length));
    const range = (row, column, height = 1, columns = 1) => ({
      getValues() {
        record(name, 'getValues');
        if (failing && name === '予約メール配送') throw new Error('架空の配送読込障害');
        const values = Array.from({ length: height }, (_unused, rowIndex) => Array.from({ length: columns }, (_cell, columnIndex) =>
          cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
        if (name === '予約メール配送' && row === 1 && height === 1 && afterHeader) {
          const action = afterHeader;
          afterHeader = null;
          action(cells);
        }
        return values;
      },
      setValue(value) {
        record(name, 'setValue');
        writes.push({ name, row, column });
        cells[row - 1][column - 1] = value;
      }
    });
    const sheet = { cells, getParent: () => spreadsheet,
      getLastRow() { record(name, 'getLastRow'); return cells.length; },
      getLastColumn() { record(name, 'getLastColumn'); return width(); },
      getRange(...arguments_) { record(name, 'getRange'); return range(...arguments_); }
    };
    if (native) sheet.getDataRange = () => {
      record(name, 'getDataRange');
      return range(1, 1, Math.max(1, cells.length), Math.max(1, width()));
    };
    sheets.set(name, sheet);
    return sheet;
  };
  const context = vm.createContext({ Date,
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || null }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() { assert.equal(held, true); } },
    Utilities: { getUuid: randomUUID },
    MailApp: { sendEmail(...arguments_) { sent.push(arguments_); } }
  });
  vm.runInContext(SOURCE, context);
  const bookingHeaders = Array.from(vm.runInContext('HEADERS', context));
  const bookingValues = bookingHeaders.map(header => ({ 予約番号: BOOKING_CODE,
    来店日: '2030-01-05', 開始: '10:00', 終了: '11:00', '所要(分)': 60,
    指名料: 0, 合計金額: 4000, お名前: '架空 配送確認', 電話番号: '00000000000',
    メール: 'customer@example.test', 状態: '予約確定' })[header] ?? '');
  const booking = makeSheet('予約一覧', [bookingHeaders, bookingValues]);
  const queue = makeSheet('予約メール配送', [QUEUE_HEADERS]);
  context.getSheet_ = () => booking;
  const jobRow = (status = '配送待ち') => {
    const message = { to: 'customer@example.test', subject: '架空の確認', body: '架空の控え', status, updated: FIXED_TIME };
    const job = { version: 1, code: BOOKING_CODE, action: '新規予約', created: FIXED_TIME,
      messages: { shop: { ...message, to: 'shop@example.test' }, customer: { ...message } } };
    return [randomUUID(), context.bookingEmailSignature_(bookingValues, bookingHeaders), JSON.stringify(job)];
  };
  const lock = operation => context.withLedgerLock_(operation);
  return { context, booking, queue, calls, writes, sent, jobRow, held: () => held,
    fail: () => { failing = true; }, afterHeader: action => { afterHeader = action; },
    read: () => lock(() => Array.from(context.readBookingEmailJobs_(queue), record => JSON.parse(JSON.stringify(record)))),
    summary: () => lock(() => JSON.parse(JSON.stringify(context.bookingEmailSummary_(booking)))),
    claim: id => context.claimBookingEmail_(BOOKING_CODE, id, 'shop') };
}

for (const native of [true, false]) {
  const mode = native ? '使用範囲' : '互換範囲';
  test(`${mode}：正常な見出しだけの配送記録は空一覧として読む`, () => {
    const app = fixture({ native });
    assert.deepEqual(app.read(), []);
    assert.equal(app.held(), false);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
  });

  test(`${mode}：行番号・ID・照合・rawと最新の一致状態を保持する`, () => {
    const app = fixture({ native });
    const first = app.jobRow();
    const last = app.jobRow('送信処理受付');
    app.queue.cells.push(first, last);
    const result = app.read();
    assert.equal(result.length, 2);
    assert.equal(result[0].row, 2);
    assert.equal(result[1].row, 3);
    assert.equal(result[1].id, last[0]);
    assert.equal(result[1].signature, last[1]);
    assert.equal(result[1].raw, last[2]);
    assert.equal(app.summary()[BOOKING_CODE].id, last[0]);
    assert.equal(app.summary()[BOOKING_CODE].job.messages.shop.status, '送信処理受付');
    assert.equal(app.held(), false);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
  });

  for (const [label, corrupt] of [
    ['見出し削除', cells => { cells.length = 0; }],
    ['見出し空白', cells => { cells[0] = ['', '', '']; }],
    ['見出し欠落', cells => { cells[0][1] = ''; }],
    ['見出し重複', cells => { cells[0][1] = '通知ID'; }],
    ['見出し入替', cells => { [cells[0][0], cells[0][1]] = [cells[0][1], cells[0][0]]; }],
    ['追加列', cells => { cells[0].push('独自列'); }],
    ['本文だけの追加列', cells => { cells[1].push('残す'); }]
  ]) {
    test(`${mode}：${label}を正常な空一覧や配送記録として扱わない`, () => {
      const app = fixture({ native });
      app.queue.cells.push(app.jobRow());
      corrupt(app.queue.cells);
      assert.throws(app.read, /メール配送の記録を確認できません/);
      assert.equal(app.held(), false);
      assert.deepEqual(app.writes, []);
      assert.deepEqual(app.sent, []);
    });
  }

  for (const operation of ['summary', 'claim']) {
    test(`${mode}：先行する見出し確認の直後に変わった列を${operation}で拒否する`, () => {
      const app = fixture({ native });
      const row = app.jobRow();
      app.queue.cells.push(row);
      app.afterHeader(cells => { cells[0][1] = '通知ID'; });
      assert.throws(() => operation === 'summary' ? app.summary() : app.claim(row[0]), /メール配送の記録を確認できません/);
      assert.equal(app.held(), false);
      assert.equal(JSON.parse(app.queue.cells[1][2]).messages.shop.status, '配送待ち');
      assert.deepEqual(app.writes, []);
      assert.deepEqual(app.sent, []);
    });
  }

  for (const [label, corrupt] of [
    ['壊れたJSON', cells => { cells[1][2] = '配送JSON不正'; }],
    ['重複ID', cells => { cells.push(cells[1].slice()); }],
    ['不正な状態', cells => {
      const job = JSON.parse(cells[1][2]);
      job.messages.shop.status = '不正な配送状態';
      cells[1][2] = JSON.stringify(job);
    }]
  ]) {
    test(`${mode}：${label}の拒否を維持する`, () => {
      const app = fixture({ native });
      app.queue.cells.push(app.jobRow());
      corrupt(app.queue.cells);
      assert.throws(app.read, /メール配送の記録を確認できません/);
      assert.equal(app.held(), false);
      assert.deepEqual(app.writes, []);
      assert.deepEqual(app.sent, []);
    });
  }

  test(`${mode}：前回の配送状態を要求間で再利用しない`, () => {
    const app = fixture({ native });
    app.queue.cells.push(app.jobRow());
    const first = app.read();
    app.queue.cells[1] = app.jobRow('送信結果不明');
    const second = app.read();
    assert.notEqual(second[0].id, first[0].id);
    assert.equal(second[0].job.messages.shop.status, '送信結果不明');
    assert.equal(app.held(), false);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
  });

  test(`${mode}：読込障害で前回の状態や空一覧を返さない`, () => {
    const app = fixture({ native });
    app.queue.cells.push(app.jobRow());
    assert.equal(app.read().length, 1);
    app.fail();
    assert.throws(app.read);
    assert.equal(app.held(), false);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
  });

  test(`${mode}：最新の一致依頼だけを確保し、その同じ行へ配送結果を保存する`, () => {
    const app = fixture({ native });
    const first = app.jobRow();
    const last = app.jobRow();
    app.queue.cells.push(first, last);
    const delivery = app.claim(last[0]);
    assert.equal(delivery.id, last[0]);
    assert.equal(delivery.to, 'shop@example.test');
    assert.equal(app.queue.cells[1][2], first[2]);
    assert.equal(JSON.parse(app.queue.cells[2][2]).messages.shop.status, '配送処理中');
    app.context.finishBookingEmail_(delivery, '送信処理受付');
    assert.equal(app.queue.cells[1][2], first[2]);
    const messages = JSON.parse(app.queue.cells[2][2]).messages;
    assert.equal(messages.shop.status, '送信処理受付');
    assert.equal(messages.customer.status, '配送待ち');
    assert.deepEqual(app.writes, [
      { name: '予約メール配送', row: 3, column: 3 },
      { name: '予約メール配送', row: 3, column: 3 }
    ]);
    assert.equal(app.held(), false);
    assert.deepEqual(app.sent, []);
  });
}

test('通常の配送記録は見出しと本文を一度に取得し、別の行数・列数を調べない', () => {
  const app = fixture();
  app.queue.cells.push(app.jobRow());
  assert.equal(app.read().length, 1);
  assert.deepEqual(app.calls, ['予約メール配送:getDataRange', '予約メール配送:getValues']);
  assert.equal(app.held(), false);
});

test('見出し周辺の空白は従来の確認と同じように読む', () => {
  const app = fixture();
  app.queue.cells[0] = QUEUE_HEADERS.map(header => ` ${header} `);
  app.queue.cells.push(app.jobRow());
  assert.equal(app.read().length, 1);
  assert.equal(Object.keys(app.summary()).length, 1);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.sent, []);
});
