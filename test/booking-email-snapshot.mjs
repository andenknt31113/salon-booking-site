import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const QUEUE_HEADERS = ['通知ID', '予約照合', '配送内容'];
const FIXED_TIME = Date.parse('2030-01-01T10:00:00+09:00');
const BOOKING_CODE = 'LMSNAPSHOT';

function fixture({ native = true, realSheet = false } = {}) {
  const calls = [];
  const writes = [];
  const sent = [];
  let held = false;
  let failing = false;
  let afterHeader;
  let beforeSnapshot;
  let afterRelease;
  let onSend;
  let ledgerFailure = false;
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
        if (ledgerFailure && name === '予約一覧') throw new Error('架空の台帳読込障害');
        if (failing && name === '予約メール配送') throw new Error('架空の配送読込障害');
        if (name === '予約メール配送' && row === 1 && height > 1 && beforeSnapshot) {
          const action = beforeSnapshot;
          beforeSnapshot = null;
          action(cells);
        }
        const values = Array.from({ length: height }, (_unused, rowIndex) => Array.from({ length: columns }, (_cell, columnIndex) =>
          cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
        if (name === '予約メール配送' && row === 1 && afterHeader) {
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
      },
      setValues(values) {
        record(name, 'setValues');
        values.forEach((line, rowIndex) => line.forEach((value, columnIndex) => {
          cells[row - 1 + rowIndex] ||= [];
          cells[row - 1 + rowIndex][column - 1 + columnIndex] = value;
        }));
        return this;
      }, setFontWeight() { return this; }, setBackground() { return this; }
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value) }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; if (afterRelease) afterRelease(); } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() { assert.equal(held, true); } },
    Utilities: { getUuid: randomUUID },
    MailApp: { sendEmail(...arguments_) {
      assert.equal(held, false, 'メール送信で予約の台帳lockを保持しない');
      sent.push(arguments_);
      if (onSend) onSend();
    } }
  });
  vm.runInContext(SOURCE, context);
  const bookingHeaders = Array.from(vm.runInContext('HEADERS', context));
  const bookingValues = bookingHeaders.map(header => ({ 予約番号: BOOKING_CODE,
    来店日: '2030-01-05', 開始: '10:00', 終了: '11:00', '所要(分)': 60,
    指名料: 0, 合計金額: 4000, お名前: '架空 配送確認', 電話番号: '00000000000',
    メール: 'customer@example.test', 状態: '予約確定' })[header] ?? '');
  const booking = makeSheet('予約一覧', [bookingHeaders, bookingValues]);
  const queue = makeSheet('予約メール配送', [QUEUE_HEADERS]);
  if (!realSheet) context.getSheet_ = () => booking;
  const jobRow = (status = '配送待ち') => {
    const message = { to: 'customer@example.test', subject: '架空の確認', body: '架空の控え', status, updated: FIXED_TIME };
    const job = { version: 1, code: BOOKING_CODE, action: '新規予約', created: FIXED_TIME,
      messages: { shop: { ...message, to: 'shop@example.test' }, customer: { ...message } } };
    return [randomUUID(), context.bookingEmailSignature_(bookingValues, bookingHeaders), JSON.stringify(job)];
  };
  const lock = operation => context.withLedgerLock_(operation);
  return { context, booking, queue, calls, writes, sent, jobRow, properties, sheets, held: () => held,
    fail: () => { failing = true; }, failLedger: () => { ledgerFailure = true; },
    afterRelease: action => { afterRelease = action; }, onSend: action => { onSend = action; },
    afterHeader: action => { afterHeader = action; },
    beforeSnapshot: action => { beforeSnapshot = action; },
    read: () => lock(() => Array.from(context.readBookingEmailJobs_(queue), record => JSON.parse(JSON.stringify(record)))),
    summary: (rows, headers) => lock(() => JSON.parse(JSON.stringify(context.bookingEmailSummary_(booking, rows, headers)))),
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
    test(`${mode}：配送記録を取得する直前に変わった列を${operation}で拒否する`, () => {
      const app = fixture({ native });
      const row = app.jobRow();
      app.queue.cells.push(row);
      app.beforeSnapshot(cells => { cells[0][1] = '通知ID'; });
      assert.throws(() => operation === 'summary' ? app.summary() : app.claim(row[0]), /メール配送の記録を確認できません/);
      assert.equal(app.held(), false);
      assert.equal(JSON.parse(app.queue.cells[1][2]).messages.shop.status, '配送待ち');
      assert.deepEqual(app.writes, []);
      assert.deepEqual(app.sent, []);
    });
  }

  test(`${mode}：配送の書込経路は先行する見出し確認の直後の列変更も拒否する`, () => {
    const app = fixture({ native });
    const row = app.jobRow();
    app.queue.cells.push(row);
    app.afterHeader(cells => { cells[0][1] = '通知ID'; });
    assert.throws(() => app.claim(row[0]), /メール配送の記録を確認できません/);
    assert.equal(app.held(), false);
    assert.equal(JSON.parse(app.queue.cells[1][2]).messages.shop.status, '配送待ち');
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
  });

  test(`${mode}：管理の配送状態は見出しと本文を一度だけ読み、渡された予約を再取得しない`, () => {
    const app = fixture({ native });
    const row = app.jobRow('送信処理受付');
    app.queue.cells.push(row);
    const originalCells = structuredClone(app.queue.cells);
    const originalProperties = Array.from(app.properties);
    const result = app.summary(app.booking.cells.slice(1), app.booking.cells[0]);
    assert.equal(result[BOOKING_CODE].id, row[0]);
    assert.equal(result[BOOKING_CODE].row, 2);
    assert.equal(result[BOOKING_CODE].raw, row[2]);
    assert.equal(result[BOOKING_CODE].signature, row[1]);
    assert.equal(result[BOOKING_CODE].job.messages.shop.status, '送信処理受付');
    assert.deepEqual(app.calls, native
      ? ['予約メール配送:getDataRange', '予約メール配送:getValues']
      : ['予約メール配送:getLastRow', '予約メール配送:getLastColumn', '予約メール配送:getRange', '予約メール配送:getValues']);
    assert.deepEqual(app.queue.cells, originalCells);
    assert.deepEqual(Array.from(app.properties), originalProperties);
    assert.equal(app.held(), false);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
  });

  test(`${mode}：予約の取得方法を変えても管理の配送状態と最新の一致依頼は同じ`, () => {
    const app = fixture({ native });
    const first = app.jobRow();
    const last = app.jobRow('送信結果不明');
    app.queue.cells.push(first, last);
    const full = app.summary();
    app.calls.length = 0;
    const selected = app.summary(app.booking.cells.slice(1), app.booking.cells[0]);
    assert.deepEqual(selected, full);
    assert.equal(selected[BOOKING_CODE].id, last[0]);
    assert.equal(selected[BOOKING_CODE].row, 3);
    assert.equal(app.calls.filter(call => call === '予約メール配送:getValues').length, 1);
    assert.equal(app.calls.some(call => call.startsWith('予約一覧:')), false);
    assert.equal(app.held(), false);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
  });

  test(`${mode}：見出しだけの配送記録も一回の取得で空の管理状態を返す`, () => {
    const app = fixture({ native });
    assert.deepEqual(app.summary(app.booking.cells.slice(1), app.booking.cells[0]), {});
    assert.equal(app.calls.filter(call => call === '予約メール配送:getValues').length, 1);
    assert.equal(app.held(), false);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
  });

  test(`${mode}：管理の状態確認も要求ごとに読み直し、古い一致や配送状態を使わない`, () => {
    const app = fixture({ native });
    app.queue.cells.push(app.jobRow());
    assert.equal(app.summary()[BOOKING_CODE].job.messages.shop.status, '配送待ち');
    app.queue.cells[1] = app.jobRow('送信結果不明');
    assert.equal(app.summary()[BOOKING_CODE].job.messages.shop.status, '送信結果不明');
    app.booking.cells[1][app.booking.cells[0].indexOf('状態')] = 'キャンセル';
    assert.deepEqual(app.summary(), {});
    app.properties.set('BOOKING_EMAIL_QUEUE_ENABLED', 'false');
    const reads = app.calls.length;
    assert.equal(app.summary(), null);
    assert.equal(app.calls.length, reads);
    assert.equal(app.held(), false);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
  });

  for (const [label, corrupt] of [
    ['シート欠落', app => { app.sheets.delete('予約メール配送'); }],
    ['見出し削除', app => { app.queue.cells.length = 0; }],
    ['見出し空白', app => { app.queue.cells[0] = ['', '', '']; }],
    ['見出し入替', app => { app.queue.cells[0] = ['予約照合', '通知ID', '配送内容']; }],
    ['見出し欠落', app => { app.queue.cells[0][1] = ''; }],
    ['見出し重複', app => { app.queue.cells[0][1] = '通知ID'; }],
    ['見出しだけの追加列', app => { app.queue.cells[0].push('独自列'); }],
    ['本文だけの追加列', app => { app.queue.cells[1].push('残す'); }],
    ['壊れたJSON', app => { app.queue.cells[1][2] = '配送JSON不正'; }],
    ['重複ID', app => { app.queue.cells.push(app.queue.cells[1].slice()); }],
    ['読込障害', app => { app.fail(); }]
  ]) {
    test(`${mode}：${label}を管理の配送成功や正常な空状態に置き換えない`, () => {
      const app = fixture({ native });
      app.queue.cells.push(app.jobRow());
      assert.equal(Object.keys(app.summary()).length, 1);
      corrupt(app);
      const originalCells = structuredClone(app.queue.cells);
      const originalProperties = Array.from(app.properties);
      assert.throws(app.summary);
      assert.deepEqual(app.queue.cells, originalCells);
      assert.deepEqual(Array.from(app.properties), originalProperties);
      assert.equal(app.held(), false);
      assert.deepEqual(app.writes, []);
      assert.deepEqual(app.sent, []);
    });
  }

  for (const [label, corrupt] of [
    ['一致しない依頼の壊れたJSON', app => { app.queue.cells[1][2] = '配送JSON不正'; }],
    ['一致しない依頼の重複ID', app => { app.queue.cells.push(app.queue.cells[1].slice()); }]
  ]) {
    test(`${mode}：${label}も確認し、対象外という理由で正常な空状態にしない`, () => {
      const app = fixture({ native });
      app.queue.cells.push(app.jobRow());
      app.booking.cells[1][app.booking.cells[0].indexOf('状態')] = 'キャンセル';
      assert.deepEqual(app.summary(), {});
      corrupt(app);
      assert.throws(app.summary, /メール配送の記録を確認できません/);
      assert.equal(app.held(), false);
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

for (const native of [true, false]) {
  const mode = native ? '使用範囲' : '互換範囲';
  const realFixture = () => fixture({ native, realSheet: true });
  const bookingReads = app => app.calls.filter(call => call === '予約一覧:getValues').length;

  test(`${mode}：実配送確保は見出し確認と予約照合で最新の台帳を一度だけ取得する`, () => {
    const app = realFixture();
    const row = app.jobRow();
    app.queue.cells.push(row);
    const original = structuredClone(app.booking.cells);
    const delivery = app.claim(row[0]);
    assert.equal(delivery.id, row[0]);
    assert.equal(bookingReads(app), 1);
    assert.equal(JSON.parse(app.queue.cells[1][2]).messages.shop.status, '配送処理中');
    assert.equal(app.calls.filter(call => call === '予約メール配送:getValues').length, 5);
    assert.deepEqual(app.booking.cells, original);
    assert.equal(app.held(), false);
    assert.deepEqual(app.sent, []);
  });

  test(`${mode}：実workerは候補一覧と各配送確保で別の最新snapshotを取得する`, () => {
    const app = realFixture();
    app.queue.cells.push(app.jobRow());
    const original = structuredClone(app.booking.cells);
    assert.deepEqual(JSON.parse(JSON.stringify(app.context.deliverBookingEmails())), { processed: 2 });
    assert.equal(bookingReads(app), 3);
    assert.equal(app.calls.filter(call => call === '予約メール配送:getValues').length, 21,
      '候補・二回の確保・二回の完了は各一回の配送snapshotと既存の保存確認を使う');
    assert.deepEqual(app.sent.map(message => message[0]), ['shop@example.test', 'customer@example.test']);
    const messages = JSON.parse(app.queue.cells[1][2]).messages;
    assert.equal(messages.shop.status, '送信処理受付');
    assert.equal(messages.customer.status, '送信処理受付');
    assert.deepEqual(app.booking.cells, original);
    assert.equal(app.held(), false);
  });

  test(`${mode}：配送対象がなくても最新台帳を一度確認し、監査後のidleでは再取得しない`, () => {
    const app = realFixture();
    assert.equal(app.context.deliverBookingEmails().processed, 0);
    assert.equal(bookingReads(app), 1);
    assert.equal(app.calls.filter(call => call === '予約メール配送:getValues').length, 1);
    const reads = app.calls.length;
    assert.equal(app.context.deliverBookingEmails().idle, true);
    assert.equal(app.calls.length, reads);
    assert.equal(app.properties.get(vm.runInContext('BOOKING_EMAIL_DIRTY', app.context)), 'false');
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
  });

  test(`${mode}：5,000件の履歴も切り捨てず一括照合して同じ配送を確保する`, () => {
    const app = realFixture();
    const headers = app.booking.cells[0];
    for (let index = 0; index < 5000; index++) {
      const values = app.booking.cells[1].slice();
      values[headers.indexOf('予約番号')] = `LMHISTORY${index}`;
      app.booking.cells.push(values);
    }
    const row = app.jobRow();
    app.queue.cells.push(row);
    const original = structuredClone(app.booking.cells);
    assert.equal(app.claim(row[0]).id, row[0]);
    assert.equal(bookingReads(app), 1);
    assert.deepEqual(app.booking.cells, original);
    assert.deepEqual(app.sent, []);
    assert.equal(app.held(), false);
  });

  test(`${mode}：配送IDが変わった場合も一回の最新取得で中止し、状態を保存しない`, () => {
    const app = realFixture();
    const current = app.jobRow();
    app.queue.cells.push(current);
    const before = structuredClone(app.queue.cells);
    assert.equal(app.claim(randomUUID()), null);
    assert.equal(bookingReads(app), 1);
    assert.equal(app.calls.filter(call => call === '予約メール配送:getValues').length, 1);
    assert.deepEqual(app.queue.cells, before);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
    assert.equal(app.held(), false);
  });

  test(`${mode}：配送完了は全記録を一回取得し、確保の照合と書込前後の確認を残す`, () => {
    const app = realFixture();
    const row = app.jobRow();
    app.queue.cells.push(row);
    const delivery = app.claim(row[0]);
    const booking = structuredClone(app.booking.cells);
    app.calls.length = 0;
    app.context.finishBookingEmail_(delivery, '送信処理受付');
    assert.equal(app.calls.filter(call => call === '予約メール配送:getValues').length, 5);
    assert.equal(bookingReads(app), 0);
    const messages = JSON.parse(app.queue.cells[1][2]).messages;
    assert.equal(messages.shop.status, '送信処理受付');
    assert.equal(messages.shop.claim, delivery.claim);
    assert.equal(messages.customer.status, '配送待ち');
    assert.deepEqual(app.booking.cells, booking);
    assert.deepEqual(app.sent, []);
    assert.equal(app.held(), false);
  });

  test(`${mode}：候補取得後の取消を配送確保時に読み直し、古い控えを送らない`, () => {
    const app = realFixture();
    const row = app.jobRow();
    app.queue.cells.push(row);
    let releases = 0;
    app.afterRelease(() => {
      releases++;
      if (releases === 1) app.booking.cells[1][app.booking.cells[0].indexOf('状態')] = 'キャンセル';
    });
    assert.equal(app.context.deliverBookingEmails().processed, 0);
    assert.equal(bookingReads(app), 3);
    assert.equal(app.queue.cells[1][2], row[2]);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
    assert.equal(app.held(), false);
  });

  test(`${mode}：候補取得後の最新依頼を読み直し、古い通知IDを確保しない`, () => {
    const app = realFixture();
    const row = app.jobRow();
    app.queue.cells.push(row);
    let releases = 0;
    app.afterRelease(() => { if (++releases === 1) app.queue.cells.push(app.jobRow()); });
    assert.equal(app.context.deliverBookingEmails().processed, 0);
    assert.equal(bookingReads(app), 3);
    assert.equal(app.queue.cells[1][2], row[2]);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
    assert.equal(app.held(), false);
  });

  test(`${mode}：店舗通知後の取消をお客様通知の確保前に読み直す`, () => {
    const app = realFixture();
    app.queue.cells.push(app.jobRow());
    app.onSend(() => { app.booking.cells[1][app.booking.cells[0].indexOf('状態')] = 'キャンセル'; });
    assert.equal(app.context.deliverBookingEmails().processed, 1);
    assert.equal(bookingReads(app), 3);
    assert.deepEqual(app.sent.map(message => message[0]), ['shop@example.test']);
    const messages = JSON.parse(app.queue.cells[1][2]).messages;
    assert.equal(messages.shop.status, '送信処理受付');
    assert.equal(messages.customer.status, '配送待ち');
    assert.equal(app.held(), false);
  });

  test(`${mode}：送信例外は結果不明を記録し、次の監査で自動再送しない`, () => {
    const app = realFixture();
    app.queue.cells.push(app.jobRow());
    app.onSend(() => { throw new Error('架空の送信結果不明'); });
    assert.equal(app.context.deliverBookingEmails().processed, 2);
    assert.equal(bookingReads(app), 3);
    const messages = JSON.parse(app.queue.cells[1][2]).messages;
    assert.equal(messages.shop.status, '送信結果不明');
    assert.equal(messages.customer.status, '送信結果不明');
    assert.equal(app.context.deliverBookingEmails().processed, 0);
    assert.equal(app.sent.length, 2);
    assert.equal(app.held(), false);
  });

  test(`${mode}：期限切れの確保は送信結果不明にして自動再送しない`, () => {
    const app = realFixture();
    const row = app.jobRow();
    const job = JSON.parse(row[2]);
    job.messages.shop = { ...job.messages.shop, status: '配送処理中', updated: Date.now() - 60 * 60 * 1000, claim: randomUUID() };
    row[2] = JSON.stringify(job);
    app.queue.cells.push(row);
    assert.equal(app.claim(row[0]), null);
    assert.equal(bookingReads(app), 1);
    assert.equal(JSON.parse(app.queue.cells[1][2]).messages.shop.status, '送信結果不明');
    assert.equal(app.claim(row[0]), null);
    assert.deepEqual(app.sent, []);
    assert.equal(app.held(), false);
  });

  test(`${mode}：列補完が必要な旧台帳は補完後の予約を新しく取得する`, () => {
    const app = realFixture();
    const missing = app.booking.cells[0].indexOf('施術メモ');
    app.booking.cells.forEach(values => values.splice(missing, 1));
    const row = app.jobRow();
    app.queue.cells.push(row);
    assert.equal(app.claim(row[0]).id, row[0]);
    assert.equal(bookingReads(app), 2);
    assert.equal(app.booking.cells[0].at(-1), '施術メモ');
    assert.equal(app.booking.cells[1][app.booking.cells[0].indexOf('予約番号')], BOOKING_CODE);
    assert.deepEqual(app.sent, []);
    assert.equal(app.held(), false);
  });

  for (const [label, corrupt] of [
    ['重複見出し', app => { app.booking.cells[0][0] = '開始'; }],
    ['重複予約番号', app => { app.booking.cells.push(app.booking.cells[1].slice()); }],
    ['対象外予約の非有限料金', app => {
      const values = app.booking.cells[1].slice();
      values[app.booking.cells[0].indexOf('予約番号')] = 'LMUNRELATED';
      values[app.booking.cells[0].indexOf('合計金額')] = Infinity;
      app.booking.cells.push(values);
    }],
    ['台帳読込障害', app => { app.failLedger(); }],
    ['配送JSON破損', app => { app.queue.cells[1][2] = '不正'; }]
  ]) {
    test(`${mode}：実配送確保でも${label}を正常扱いせず書込・送信しない`, () => {
      const app = realFixture();
      const row = app.jobRow();
      app.queue.cells.push(row);
      corrupt(app);
      const original = structuredClone(app.booking.cells);
      const queue = structuredClone(app.queue.cells);
      assert.throws(() => app.claim(row[0]));
      assert.deepEqual(app.booking.cells, original);
      assert.deepEqual(app.queue.cells, queue);
      assert.deepEqual(app.writes, []);
      assert.deepEqual(app.sent, []);
      assert.equal(app.held(), false);
    });
  }

  test(`${mode}：配送無効時は台帳を読まず既存記録や設定を変更しない`, () => {
    const app = realFixture();
    const row = app.jobRow();
    app.queue.cells.push(row);
    app.properties.set('BOOKING_EMAIL_QUEUE_ENABLED', 'false');
    assert.equal(app.context.deliverBookingEmails().disabled, true);
    assert.equal(app.claim(row[0]), null);
    assert.deepEqual(app.calls, []);
    assert.equal(app.queue.cells[1][2], row[2]);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.sent, []);
  });
}
