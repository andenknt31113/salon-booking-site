import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const QUEUE_NAME = '予約メール配送';
const REQUEST = { type: 'reserve', code: 'LM-QUEUE1', date: '2030-01-05', time: '10:00',
  totalMinutes: 60, totalPrice: 4000, menus: [{ id: 'm01', name: '配送試験カット', price: 4000, minutes: 60 }],
  staffId: 'st01', staffName: 'MATTEO', customer: { name: '架空 配送試験', kana: 'カクウハイソウシケン',
    tel: '00000000000', email: 'queue-customer@example.test' } };

function fixture({ enabled = true, queueFault = '', bookingFault = '', missingQueue = false, coerce = false,
  sourcePatch = source => source } = {}) {
  let clock = Date.parse('2030-01-01T10:00:00+09:00');
  class FixedDate extends Date {
    constructor(...values) { super(...(values.length ? values : [clock])); }
    static now() { return clock; }
  }
  const effects = [];
  const sent = [];
  const properties = new Map(enabled ? [['BOOKING_EMAIL_QUEUE_ENABLED', 'true'], ['BOOKING_EMAIL_WORKER_AT', String(clock)]] : []);
  let held = false;
  let onMail;
  let mailFailure = false;
  let statusFault = false;
  let statusWrite = 0;
  let bookingWrite = 0;
  let badWrite = false;
  let flushes = 0;
  const triggers = [];
  const makeSheet = (name, headers) => {
    const cells = [Array.from(headers)];
    return { name, cells, getParent: () => spreadsheet,
      getLastRow: () => cells.length, getLastColumn: () => cells[0]?.length || 0,
      appendRow(values) {
        assert.equal(held, true);
        effects.push(name === QUEUE_NAME ? 'stage' : 'booking');
        if (name !== QUEUE_NAME) bookingWrite++;
        const fault = name === QUEUE_NAME ? queueFault : bookingFault;
        if (fault === 'write-before') throw new Error('架空の保存前障害');
        if (fault !== 'discard') cells.push(Array.from(values).map(value => name !== QUEUE_NAME && coerce && typeof value === 'string'
          ? value.replace(/^'/, '') : value));
        if (fault === 'write-after') throw new Error('架空の保存後障害');
      },
      getRange(row, column, height = 1, width = 1) {
        return { getValues() {
          assert.equal(held, true);
          if (name === QUEUE_NAME && row > 1 && queueFault === 'read-failure') throw new Error('架空の読込障害');
          if (name !== QUEUE_NAME && row > 1 && bookingWrite && bookingFault === 'read-failure') throw new Error('架空の読込障害');
          return Array.from({ length: height }, (_unused, offset) => Array.from({ length: width }, (_cell, index) =>
            cells[row - 1 + offset]?.[column - 1 + index] ?? ''));
        },
        getFormulas: () => Array.from({ length: height }, () => Array.from({ length: width }, () => '')),
        setValues(values) {
          assert.equal(held, true);
          if (name !== QUEUE_NAME && row > 1 && column === 3) {
            bookingWrite++;
            if (badWrite) { badWrite = false; cells[row - 1][column - 1] = values[0][0]; throw new Error('架空の部分保存'); }
          }
          values.forEach((line, offset) => line.forEach((value, index) => {
            cells[row - 1 + offset] ||= [];
            cells[row - 1 + offset][column - 1 + index] = value;
          }));
        },
        setValue(value) {
          assert.equal(held, true);
          if (name === QUEUE_NAME && column === 3) {
            statusWrite++;
            if (statusFault && statusWrite > 1) throw new Error('架空の配送結果保存障害');
          }
          if (name !== QUEUE_NAME && bookingFault === 'discard') return;
          cells[row - 1][column - 1] = value;
        }, setFontLine() { return this; }, setFontColor() { return this; } };
      } };
  };
  const sheets = new Map();
  const spreadsheet = { getSheetByName: name => sheets.get(name) || null,
    insertSheet: name => { const sheet = makeSheet(name, []); sheet.cells.length = 0; sheets.set(name, sheet); return sheet; } };
  const context = vm.createContext({ Date: FixedDate,
    console: { log() {}, error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value), deleteProperty: key => properties.delete(key) }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {
      assert.equal(held, true);
      flushes++;
      if (queueFault === 'flush-failure' && flushes === 1) throw new Error('架空の反映障害');
    } },
    ScriptApp: { getProjectTriggers: () => triggers,
      newTrigger: handler => ({ timeBased() { return this; }, everyMinutes(value) { assert.equal(value, 1); return this; },
        create() { const trigger = { getHandlerFunction: () => handler }; triggers.push(trigger); return trigger; } }) },
    Utilities: { getUuid: () => randomUUID(), formatDate(value, _zone, format) {
      const date = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000);
      return format === 'HH:mm' ? date.toISOString().slice(11, 16) : date.toISOString().slice(0, 10);
    } },
    MailApp: { sendEmail(to, subject, body) {
      assert.equal(held, false, '外部メール処理で予約用ロックを持たない');
      sent.push({ to, subject, body });
      if (onMail) onMail({ to, subject, body });
      if (mailFailure) throw new Error('架空の送信受付後の障害');
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) }
  });
  vm.runInContext(sourcePatch(SOURCE), context);
  const headers = Array.from(vm.runInContext('HEADERS', context));
  const booking = makeSheet('予約一覧', headers);
  const queue = makeSheet(QUEUE_NAME, ['通知ID', '予約照合', '配送内容']);
  sheets.set('予約一覧', booking);
  if (!missingQueue) sheets.set(QUEUE_NAME, queue);
  context.getSheet_ = () => booking;
  context.draftMode_ = () => false;
  context.verifyReservationMenus_ = () => '';
  context.readBookingSettings_ = () => ({ 通知先メール: 'queue-shop@example.test' });
  context.todayKey_ = () => '2030-01-01';
  context.nowMinJst_ = () => 10 * 60;
  const send = overrides => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ ...REQUEST, ...overrides }) } }));
  const change = overrides => send({ type: 'change', tel: REQUEST.customer.tel, date: '2030-01-06', time: '14:00', ...overrides });
  const cancel = overrides => send({ type: 'cancel', tel: REQUEST.customer.tel, ...overrides });
  return { context, properties, sheets, booking, queue, headers, effects, sent, triggers, send, change, cancel,
    jobs: () => queue.cells.slice(1).map(values => JSON.parse(values[2])),
    advance: milliseconds => { clock += milliseconds; },
    onMail: callback => { onMail = callback; }, mailFailure: () => { mailFailure = true; },
    failStatus: () => { statusFault = true; statusWrite = 0; },
    recoverStatus: () => { statusFault = false; },
    failWindow: () => { badWrite = true; }, held: () => held,
    summary: () => context.withLedgerLock_(() => context.applyBookingEmailSummary_(
      booking.cells.slice(1).map(values => context.adminReservation_(values, header => headers.indexOf(header))),
      context.bookingEmailSummary_(booking))) };
}

test('予約応答をメール待ちから切り離し、配送依頼を予約保存より前に永続化する', () => {
  const app = fixture();
  assert.equal(app.send().notificationsQueued, true);
  assert.deepEqual(app.effects, ['stage', 'booking']);
  assert.equal(app.sent.length, 0);
  assert.equal(app.booking.cells.length, 2);
  assert.equal(app.jobs()[0].messages.customer.status, '配送待ち');
  assert.equal(app.held(), false);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
  assert.ok(app.sent.some(message => /ご予約を承りました/.test(message.subject)));
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2, '定期実行で成功済みを再送しない');
});

for (const queueFault of ['discard', 'write-before', 'write-after', 'read-failure', 'flush-failure']) {
  test(`配送依頼の${queueFault}では予約を先に成立させない`, () => {
    const app = fixture({ queueFault });
    const response = app.send();
    assert.equal(response.ok, false);
    assert.equal(app.booking.cells.length, 1);
    assert.equal(app.sent.length, 0);
    assert.equal(response.error.includes('架空'), false);
    assert.equal(app.held(), false);
  });
}

for (const bookingFault of ['discard', 'write-before', 'write-after']) {
  test(`予約保存の${bookingFault}から、台帳の実状態だけを使って配送する`, () => {
    const app = fixture({ bookingFault });
    assert.equal(app.send().unknown, true);
    assert.equal(app.sent.length, 0);
    app.context.deliverBookingEmails();
    assert.equal(app.sent.length, bookingFault === 'write-after' ? 2 : 0);
    assert.equal(app.booking.cells.length, bookingFault === 'write-after' ? 2 : 1);
  });
}

test('成立済みの同一番号・内容への再送は通知依頼と予約を増やさない', () => {
  const app = fixture();
  assert.equal(app.send().ok, true);
  assert.equal(app.send().duplicate, true);
  assert.equal(app.queue.cells.length, 2);
  assert.equal(app.booking.cells.length, 2);
});

test('シートが数式よけの先頭引用符を除いて返しても、成立した予約の通知を配送する', () => {
  const app = fixture({ coerce: true });
  assert.equal(app.send({ customer: { ...REQUEST.customer, request: '=試験のご要望' } }).ok, true);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
});

test('全角メールを受け付けた予約でも、半角へ揃えた宛先に確認メールを配送する', () => {
  const app = fixture();
  const email = REQUEST.customer.email.replace(/[!-~]/g, character => String.fromCharCode(character.charCodeAt(0) + 0xFEE0));
  assert.equal(app.send({ customer: { ...REQUEST.customer, email } }).ok, true);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.filter(message => message.to === REQUEST.customer.email).length, 1);
});

test('送信中にも空席照会を処理でき、他の配送実行が同じメールを横取りしない', () => {
  const app = fixture();
  app.send();
  let checked = false;
  app.onMail(() => {
    if (checked) return;
    checked = true;
    assert.equal(app.send({ type: 'availability' }).ok, true);
    app.context.deliverBookingEmails();
  });
  app.context.deliverBookingEmails();
  assert.equal(checked, true);
  assert.equal(app.sent.length, 2);
  assert.equal(app.held(), false);
});

test('配送前の変更・取消では古い通知を送らず、最新の操作だけを配送する', () => {
  const app = fixture();
  app.send();
  assert.equal(app.change().notificationsQueued, true);
  assert.equal(app.cancel().notificationsQueued, true);
  assert.equal(app.sent.length, 0);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
  assert.ok(app.sent.every(message => /キャンセル/.test(message.subject)));
  assert.ok(app.sent.every(message => message.body.includes('2030-01-06 14:00')));
});

test('候補の取得後・配送権の取得前に日時が変わった場合も、古い依頼は送らない', () => {
  const app = fixture();
  app.send();
  const original = app.context.claimBookingEmail_;
  let changed = false;
  app.context.claimBookingEmail_ = (...arguments_) => {
    if (!changed) { changed = true; assert.equal(app.change().ok, true); }
    return original(...arguments_);
  };
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 0);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
  assert.ok(app.sent.every(message => message.body.includes('2030-01-06 14:00')));
});

test('外部受付を始めた後の取消は次の旧メールを止め、古い結果で最新状態を上書きしない', () => {
  const app = fixture();
  app.send();
  let cancelled = false;
  app.onMail(() => {
    if (cancelled) return;
    cancelled = true;
    assert.equal(app.cancel().ok, true);
  });
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 1, '既に外部サービスへ渡したメールを無かったことにはしない');
  assert.match(app.summary()[0].shopMailStatus, /キャンセル：配送待ち/);
  assert.equal(app.jobs()[0].messages.customer.status, '配送待ち');
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 3);
  assert.ok(app.sent.slice(1).every(message => /キャンセル/.test(message.subject)));
  assert.match(app.summary()[0].shopMailStatus, /キャンセル：送信処理受付/);
});

test('変更後に元の日時へ戻した場合も最新の通知だけを配送する', () => {
  const app = fixture();
  app.send();
  app.change();
  assert.equal(app.change({ date: REQUEST.date, time: REQUEST.time }).ok, true);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
  assert.ok(app.sent.every(message => /日時変更|日時を変更/.test(message.subject)));
});

test('日時変更の部分保存から復旧した場合は、成立しなかった変更通知を送らない', () => {
  const app = fixture();
  app.send();
  app.failWindow();
  assert.equal(app.change().restored, true);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
  assert.ok(app.sent.every(message => /新規予約|ご予約を承りました/.test(message.subject)));
});

test('取消が反映されなかった場合は取消メールを送らない', () => {
  const app = fixture({ bookingFault: 'discard' });
  const original = fixture();
  original.send();
  app.booking.cells.push(original.booking.cells[1].slice());
  assert.equal(app.cancel().unknown, true);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 0);
});

test('送信受付後の例外は結果不明とし、自動再送しない', () => {
  const app = fixture();
  app.send();
  app.mailFailure();
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
  assert.equal(app.jobs()[0].messages.customer.status, '送信結果不明');
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
  assert.match(app.summary()[0].customerMailStatus, /結果不明/);
});

test('配送結果の保存前に停止したメールを、時間切れ後も盲目的に再送しない', () => {
  const app = fixture();
  app.send();
  app.failStatus();
  assert.throws(() => app.context.deliverBookingEmails(), /配送の記録/);
  assert.equal(app.sent.length, 1);
  app.advance(11 * 60 * 1000);
  assert.match(app.summary()[0].shopMailStatus, /要確認/);
  app.recoverStatus();
  app.context.deliverBookingEmails();
  assert.equal(app.sent.filter(message => message.to === 'queue-shop@example.test').length, 1);
  assert.equal(app.jobs()[0].messages.shop.status, '送信結果不明');
  assert.equal(app.jobs()[0].messages.customer.status, '送信処理受付');
});

test('配送が止まっている・保存先が無いときは、通知できない予約を追加しない', () => {
  for (const missingQueue of [false, true]) {
    const app = fixture({ missingQueue });
    if (!missingQueue) app.advance(11 * 60 * 1000);
    assert.equal(app.send().ok, false);
    assert.equal(app.booking.cells.length, 1);
    assert.equal(app.sent.length, 0);
  }
});

test('曖昧な番号・壊れた通知記録は配送せず、送信内容を例外に出さない', () => {
  for (const corruption of ['duplicate-code', 'duplicate-id', 'invalid-json', 'headers']) {
    const app = fixture();
    app.send();
    if (corruption === 'duplicate-code') app.booking.cells.push(app.booking.cells[1].slice());
    if (corruption === 'duplicate-id') app.queue.cells.push(app.queue.cells[1].slice());
    if (corruption === 'invalid-json') app.queue.cells[1][2] = '壊れた配送情報';
    if (corruption === 'headers') app.queue.cells[0][0] = '不正な見出し';
    assert.throws(() => app.context.deliverBookingEmails(), /配送の記録/);
    assert.equal(app.sent.length, 0);
  }
});

test('非同期化の設定前は旧方式を維持し、依頼を新しい保存先へ追加しない', () => {
  const app = fixture({ enabled: false });
  app.context.notify_ = () => '送信処理受付';
  app.context.mailCustomer_ = () => '送信処理受付';
  assert.equal(app.send().ok, true);
  assert.equal(app.queue.cells.length, 1);
});

test('一回の配送件数と実行時間を区切り、次回に残りを処理して成功分を再送しない', () => {
  const app = fixture();
  for (let index = 0; index < 6; index++) {
    assert.equal(app.send({ code: 'LM-LIMIT' + index, time: `${10 + index}:00` }).ok, true);
  }
  assert.equal(app.context.deliverBookingEmails().processed, 10);
  assert.equal(app.sent.length, 10);
  assert.equal(app.context.deliverBookingEmails().processed, 2);
  assert.equal(app.sent.length, 12);
  assert.equal(app.context.deliverBookingEmails().processed, 0);
  const slow = fixture();
  slow.send();
  slow.onMail(() => slow.advance(5 * 60 * 1000));
  assert.equal(slow.context.deliverBookingEmails().processed, 1);
  assert.equal(slow.sent.length, 1);
  slow.onMail(null);
  assert.equal(slow.context.deliverBookingEmails().processed, 1);
  assert.equal(slow.sent.length, 2);
});

test('配送処理や導入処理は、公開の予約受け口から起動できない', () => {
  const app = fixture({ enabled: false });
  for (const type of ['enableBookingEmailQueue', 'deliverBookingEmails']) {
    const response = app.send({ type });
    assert.equal(response.ok, false);
    assert.equal(response.invalid, true);
  }
  assert.equal(app.properties.has('BOOKING_EMAIL_QUEUE_ENABLED'), false);
  assert.equal(app.sent.length, 0);
  assert.equal(app.triggers.length, 0);
});

test('導入処理はトリガーを重複作成せず、既存予約の通知依頼を作らない', () => {
  const app = fixture({ enabled: false, missingQueue: true });
  app.context.notify_ = () => '送信処理受付';
  app.context.mailCustomer_ = () => '送信処理受付';
  app.send();
  assert.equal(app.context.enableBookingEmailQueue().ok, true);
  assert.equal(app.context.enableBookingEmailQueue().ok, true);
  assert.equal(app.triggers.length, 1);
  assert.equal(app.sheets.get(QUEUE_NAME).cells.length, 1);
  assert.equal(app.sent.length, 0);
});

test('停止中に配送記録が残る場合の再導入は、記録確認なしに実行しない', () => {
  const app = fixture();
  app.send();
  app.properties.delete('BOOKING_EMAIL_QUEUE_ENABLED');
  assert.throws(() => app.context.enableBookingEmailQueue(), /既存の配送記録/);
  assert.equal(app.sent.length, 0);
  assert.equal(app.triggers.length, 0);
});

for (const afterCreation of [false, true]) {
  test(`トリガー作成${afterCreation ? '直後' : '前'}の障害では受付方式を切り替えず、既存予約・通知先を変更しない`, () => {
    const app = fixture({ enabled: false });
    const original = app.context.ScriptApp.newTrigger;
    app.context.ScriptApp.newTrigger = handler => {
      const builder = original(handler);
      const create = builder.create;
      builder.create = () => {
        if (afterCreation) create();
        throw new Error('架空のトリガー保存障害');
      };
      return builder;
    };
    const before = structuredClone(app.booking.cells);
    assert.throws(() => app.context.enableBookingEmailQueue(), /トリガー保存障害/);
    assert.notEqual(app.properties.get('BOOKING_EMAIL_QUEUE_ENABLED'), 'true');
    assert.deepEqual(app.booking.cells, before);
    assert.equal(app.sent.length, 0);
    assert.equal(app.triggers.length, afterCreation ? 1 : 0);
    app.context.ScriptApp.newTrigger = original;
    assert.equal(app.context.enableBookingEmailQueue().ok, true);
    assert.equal(app.triggers.length, 1, '途中まで作られたトリガーを二重作成しない');
  });
}

test('重複したトリガーや確認できない作成結果では有効化せず、勝手な削除もしない', () => {
  const app = fixture({ enabled: false });
  app.triggers.push({ getHandlerFunction: () => 'deliverBookingEmails' }, { getHandlerFunction: () => 'deliverBookingEmails' });
  assert.throws(() => app.context.enableBookingEmailQueue(), /重複/);
  assert.equal(app.triggers.length, 2);
  assert.notEqual(app.properties.get('BOOKING_EMAIL_QUEUE_ENABLED'), 'true');
  const invisible = fixture({ enabled: false });
  invisible.context.ScriptApp.getProjectTriggers = () => [];
  assert.throws(() => invisible.context.enableBookingEmailQueue(), /トリガーを確認できません/);
  assert.notEqual(invisible.properties.get('BOOKING_EMAIL_QUEUE_ENABLED'), 'true');
});

test('有効化設定の保存が破棄された場合は完了と扱わず、再実行でトリガーを増やさない', () => {
  const app = fixture({ enabled: false });
  const original = app.context.PropertiesService.getScriptProperties;
  app.context.PropertiesService.getScriptProperties = () => {
    const props = original();
    return { ...props, setProperty(key, value) { if (key !== 'BOOKING_EMAIL_QUEUE_ENABLED') props.setProperty(key, value); } };
  };
  assert.throws(() => app.context.enableBookingEmailQueue(), /配送の記録/);
  assert.notEqual(app.properties.get('BOOKING_EMAIL_QUEUE_ENABLED'), 'true');
  assert.equal(app.triggers.length, 1);
  app.context.PropertiesService.getScriptProperties = original;
  assert.equal(app.context.enableBookingEmailQueue().ok, true);
  assert.equal(app.triggers.length, 1);
});

test('既に有効な配送先に壊れた記録がある場合も、再導入を成功と案内しない', () => {
  const app = fixture();
  app.send();
  app.queue.cells[1][2] = '壊れた配送記録';
  assert.throws(() => app.context.enableBookingEmailQueue(), /配送の記録/);
  assert.equal(app.triggers.length, 0);
  assert.equal(app.sent.length, 0);
});

test('予定連携を使う設置先では、連携を削除したりメール方式だけ切り替えたりしない', () => {
  const app = fixture({ enabled: false, sourcePatch: source => source.replace("const CALENDAR_ID = '';", "const CALENDAR_ID = 'calendar-fixture';") });
  assert.throws(() => app.context.enableBookingEmailQueue(), /予定・LINE連携/);
  assert.equal(app.triggers.length, 0);
  assert.notEqual(app.properties.get('BOOKING_EMAIL_QUEUE_ENABLED'), 'true');
});

test('待機処理への引渡し印が保存されなければ、通知依頼や予約を追加しない', () => {
  const app = fixture();
  const original = app.context.PropertiesService.getScriptProperties;
  app.context.PropertiesService.getScriptProperties = () => {
    const props = original();
    return { ...props, setProperty(key, value) { if (key !== 'BOOKING_EMAIL_WORK_PENDING') props.setProperty(key, value); } };
  };
  assert.equal(app.send().ok, false);
  assert.equal(app.queue.cells.length, 1);
  assert.equal(app.booking.cells.length, 1);
  assert.equal(app.sent.length, 0);
});

test('停止設定中は既存トリガーが動いても配送せず、配送記録を消さない', () => {
  const app = fixture();
  app.send();
  app.properties.delete('BOOKING_EMAIL_QUEUE_ENABLED');
  assert.equal(app.context.deliverBookingEmails().disabled, true);
  assert.equal(app.sent.length, 0);
  assert.equal(app.queue.cells.length, 2);
});

test('配送を途中で停止した場合、処理済みの結果を記録し、未着手のメールを送らない', () => {
  const app = fixture();
  app.send();
  app.onMail(() => app.properties.delete('BOOKING_EMAIL_QUEUE_ENABLED'));
  assert.equal(app.context.deliverBookingEmails().processed, 1);
  assert.equal(app.sent.length, 1);
  assert.equal(app.jobs()[0].messages.shop.status, '送信処理受付');
  assert.equal(app.jobs()[0].messages.customer.status, '配送待ち');
  assert.equal(app.context.deliverBookingEmails().disabled, true);
  assert.equal(app.sent.length, 1);
});

test('配送待ちがない毎分実行では台帳を全走査せず、定期監査と新しい依頼では確認する', () => {
  const app = fixture();
  app.context.deliverBookingEmails();
  app.context.getSheet_ = () => { throw new Error('不要な台帳アクセス'); };
  assert.equal(app.context.deliverBookingEmails().idle, true);
  app.advance(31 * 60 * 1000);
  assert.throws(() => app.context.deliverBookingEmails(), /不要な台帳アクセス/);
  app.context.getSheet_ = () => app.booking;
  app.context.deliverBookingEmails();
  assert.equal(app.send().notificationsQueued, true);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
});

test('管理に配送状態だけを返し、宛先・本文・配送IDは公開照会へ出さない', () => {
  const app = fixture();
  app.send();
  assert.match(app.summary()[0].shopMailStatus, /配送待ち/);
  const lookup = app.send({ type: 'lookup', tel: REQUEST.customer.tel });
  assert.equal(lookup.ok, true);
  assert.equal(JSON.stringify(lookup).includes('queue-shop@example.test'), false);
  assert.equal(JSON.stringify(lookup).includes(app.queue.cells[1][0]), false);
});

test('管理用に読込済みの予約があれば、配送表示のために台帳を全件再取得しない', () => {
  const app = fixture();
  app.send();
  app.context.withLedgerLock_(() => {
    const rows = app.context.readRows_(app.booking);
    app.context.readRows_ = () => assert.fail('予約の全件読込を重複しない');
    const summary = app.context.bookingEmailSummary_(app.booking, rows);
    assert.equal(Object.keys(summary).length, 1);
  });
});

test('認証済みの軽量通知では配送状態だけを追加し、匿名の照会には返さない', () => {
  const app = fixture();
  app.send();
  const request = vm.runInContext('({ notificationsOnly: true, googleAdminContext: GOOGLE_ADMIN_CONTEXT })', app.context);
  const result = app.context.withLedgerLock_(() => app.context.doAdminData_(request));
  assert.equal(result.mailStatuses, true);
  assert.match(result.reservations[0].shopMailStatus, /配送待ち/);
  assert.deepEqual(Object.keys(result.reservations[0]).sort(),
    ['code', 'customerMailStatus', 'date', 'endTime', 'name', 'shopMailStatus', 'status', 'time']);
  assert.equal(app.send({ type: 'adminData', notificationsOnly: true }).ok, false);
  assert.equal(JSON.stringify(result).includes(REQUEST.customer.email), false);
});
