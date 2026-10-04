import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const ADMIN_PASSWORD = process.env.MOCK_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('MOCK_ADMIN_PASSWORD を設定してください。');
const VISIT_DATE = '2030-01-05';
const CLOCK_START = Date.parse('2030-01-01T09:00:00+09:00');
const LEASE_EXPIRY_MS = 11 * 60 * 1000;
const CHANGE_HISTORY_SIZE = 2000;
const BOOKING_REQUEST = { type: 'reserve', code: 'LM-FINAL', date: VISIT_DATE, time: '10:00',
  totalMinutes: 60, totalPrice: 4000,
  menus: [{ id: 'sm0', name: '試験カット', price: 4000, minutes: 60 }],
  staffId: 'st01', staffName: 'MATTEO',
  customer: { name: '架空の監査客', tel: '00000000000', email: 'audit-customer@example.test' } };
const PHONE_REQUEST = { type: 'adminAdd', requestId: 'final-phone-request-0001', date: VISIT_DATE,
  time: '12:00', minutes: 60, price: 4000, name: '架空の電話監査客', tel: '00000000000',
  menu: '試験カット', memo: '架空の受付', force: true };

function fixture({ queue = true } = {}) {
  let clock = CLOCK_START;
  let held = false;
  let fault;
  let onMail;
  const sent = [];
  const effects = [];
  const sheets = new Map();
  const properties = new Map([['ADMIN_PASSWORD', ADMIN_PASSWORD]]);
  class FixedDate extends Date {
    constructor(...values) { super(...(values.length ? values : [clock])); }
    static now() { return clock; }
  }
  const signal = event => {
    effects.push(event);
    if (fault) fault(event);
  };
  const assertHeld = () => assert.equal(held, true, '台帳と配送記録は取得したロック内で操作する');
  const makeSheet = (name, headers, records = []) => {
    const cells = [Array.from(headers), ...records.map(record => headers.map(header => record[header] ?? ''))];
    const sheet = { cells, getParent: () => spreadsheet,
      getLastRow() { assertHeld(); return cells.length; },
      getLastColumn() { assertHeld(); return Math.max(...cells.map(row => row.length)); },
      appendRow(values) {
        assertHeld();
        signal({ name, operation: 'append', phase: 'before' });
        cells.push(Array.from(values));
        signal({ name, operation: 'append', phase: 'after' });
      },
      getRange(row, column, height = 1, width = 1) {
        const range = {
          getValues() {
            assertHeld();
            signal({ name, operation: 'read', row, column, height, width });
            return Array.from({ length: height }, (_unused, rowOffset) =>
              Array.from({ length: width }, (_value, columnOffset) =>
                cells[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? ''));
          },
          getFormulas() {
            assertHeld();
            return Array.from({ length: height }, () => Array.from({ length: width }, () => ''));
          },
          setValues(values) {
            assertHeld();
            const event = { name, operation: 'write', row, column, values };
            signal({ ...event, phase: 'before' });
            values.forEach((line, rowOffset) => line.forEach((value, columnOffset) => {
              cells[row - 1 + rowOffset] ||= [];
              cells[row - 1 + rowOffset][column - 1 + columnOffset] = value;
            }));
            signal({ ...event, phase: 'after' });
            return range;
          },
          setValue(value) { return range.setValues([[value]]); },
          setFontWeight: () => range, setBackground: () => range,
          setFontLine: () => range, setFontColor: () => range
        };
        return range;
      },
      setFrozenRows() {}, setColumnWidth() {}
    };
    sheets.set(name, sheet);
    return sheet;
  };
  const spreadsheet = { getSheetByName(name) { assertHeld(); return sheets.get(name) || null; },
    insertSheet() { throw new Error('監査対象外のシート作成'); } };
  const context = vm.createContext({ Date: FixedDate, console: { log() {}, error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) ?? null,
      setProperty(key, value) {
        signal({ name: 'properties', operation: 'set', key, phase: 'before' });
        properties.set(key, value);
        signal({ name: 'properties', operation: 'set', key, phase: 'after' });
      },
      deleteProperty(key) {
        signal({ name: 'properties', operation: 'delete', key, phase: 'before' });
        properties.delete(key);
        signal({ name: 'properties', operation: 'delete', key, phase: 'after' });
      },
      getKeys: () => Array.from(properties.keys())
    }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {
      assertHeld(); signal({ name: 'spreadsheet', operation: 'flush' });
    } },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(held, false, '監査fixtureで取得済みのロックを重ねない'); held = true; },
      releaseLock() { assertHeld(); held = false; }
    }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    Utilities: { getUuid: randomUUID, formatDate(value, _timezone, format) {
      const shifted = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString();
      return format === 'HH:mm' ? shifted.slice(11, 16) : shifted.slice(0, 10);
    } },
    MailApp: { sendEmail(to, subject, body) {
      assert.equal(held, false, '外部メール受付中は台帳ロックを解放する');
      sent.push({ to, subject, body });
      if (onMail) onMail({ to, subject, body });
    } }
  });
  vm.runInContext(SOURCE, context);
  const canonical = Array.from(vm.runInContext('HEADERS', context));
  const ledger = makeSheet('予約一覧', ['独自列', ...canonical]);
  const delivery = makeSheet('予約メール配送', Array.from(vm.runInContext('BOOKING_EMAIL_HEADERS', context)));
  makeSheet('設定', ['項目', '内容'], Object.entries({ 準備中の帯: '出さない', 営業開始: '09:00',
    営業終了: '20:00', 最終受付: '19:00', 定休曜日: '', 通知先メール: 'audit-shop@example.test' })
    .map(([項目, 内容]) => ({ 項目, 内容 })));
  makeSheet('メニュー', Array.from(vm.runInContext('MENU_HEADERS', context)),
    [{ 区分: 'カット', メニュー名: '試験カット', 価格: 4000, '所要(分)': 60, 表示: '表示' }]);
  makeSheet('おすすめメニュー', Array.from(vm.runInContext('COUPON_HEADERS', context)));
  makeSheet('休業日', Array.from(vm.runInContext('CLOSED_HEADERS', context)));
  if (queue) {
    properties.set('BOOKING_EMAIL_QUEUE_ENABLED', 'true');
    properties.set('BOOKING_EMAIL_WORKER_AT', String(clock));
  }
  const send = request => {
    const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify(request) } }));
    assert.equal(held, false, '応答時に今回取得したロックを残さない');
    return result;
  };
  return { context, ledger, delivery, properties, sent, effects,
    send, reserve: overrides => send({ ...BOOKING_REQUEST, ...overrides }),
    phone: overrides => send({ ...PHONE_REQUEST, password: ADMIN_PASSWORD, ...overrides }),
    change: overrides => send({ type: 'change', code: BOOKING_REQUEST.code, tel: BOOKING_REQUEST.customer.tel,
      fromDate: VISIT_DATE, fromTime: BOOKING_REQUEST.time, date: '2030-01-06', time: '14:00', ...overrides }),
    cancel: () => send({ type: 'cancel', code: BOOKING_REQUEST.code, tel: BOOKING_REQUEST.customer.tel }),
    jobs: () => delivery.cells.slice(1).map(row => JSON.parse(row[2])),
    field: (name, row = 1) => ledger.cells[row][ledger.cells[0].indexOf(name)],
    setFault: callback => { fault = callback; },
    setOnMail: callback => { onMail = callback; },
    advance: milliseconds => { clock += milliseconds; },
    reorder: () => {
      const indices = ledger.cells[0].map((_header, index) => index).reverse();
      ledger.cells.splice(0, ledger.cells.length, ...ledger.cells.map(row => indices.map(index => row[index] ?? '')));
    }
  };
}

function deliveryTargetFixture(phase, mutation) {
  const app = fixture();
  assert.equal(app.reserve().ok, true);
  assert.equal(app.reserve({ code: 'LM-OTHER', time: '12:00', customer: {
    ...BOOKING_REQUEST.customer, name: '別の架空配送客', email: 'other-customer@example.test'
  } }).ok, true);
  const ledger = structuredClone(app.ledger.cells);
  const readJobs = app.context.readBookingEmailJobs_;
  let reads = 0;
  let afterMutation;
  app.context.readBookingEmailJobs_ = queue => {
    const jobs = readJobs(queue);
    if (++reads === (phase === 'claim' ? 2 : 3)) {
      const cells = app.delivery.cells;
      if (mutation === 'rows') [cells[1], cells[2]] = [cells[2], cells[1]];
      else if (mutation === 'remove') cells.splice(1, 1);
      else if (mutation === 'headers') cells.forEach(row => { [row[0], row[2]] = [row[2], row[0]]; });
      else if (mutation === 'id') cells[1][0] = randomUUID();
      else if (mutation === 'signature') cells[1][1] = cells[2][1];
      else if (mutation === 'raw') {
        const job = JSON.parse(cells[1][2]);
        job.messages.customer.status = '停止中';
        cells[1][2] = JSON.stringify(job);
      } else throw new Error('不明な架空配送変更');
      afterMutation = structuredClone(cells);
    }
    return jobs;
  };
  return { ...app, ledgerBefore: ledger, mutatedQueue: () => afterMutation };
}

for (const phase of ['claim', 'finish']) {
  for (const mutation of ['rows', 'remove', 'headers', 'id', 'signature', 'raw']) {
    test(`配送${phase}の読込後に${mutation}が変わっても、別の依頼や新しい配送状態へ書かない`, () => {
      const app = deliveryTargetFixture(phase, mutation);
      assert.throws(() => app.context.deliverBookingEmails(), /メール配送の記録/);
      assert.ok(app.mutatedQueue(), '実際の記録読込後に架空の変更を挟む');
      assert.deepEqual(app.delivery.cells, app.mutatedQueue(), '古い行番号・本文・状態で上書きしない');
      assert.deepEqual(app.ledger.cells, app.ledgerBefore, '予約を取り消したり書き戻したりしない');
      assert.equal(app.sent.length, phase === 'claim' ? 0 : 1,
        '配送開始確認の失敗では送信せず、結果保存の失敗では既に受け付けた一通を隠さない');
      assert.ok(app.sent.every(message => message.to === 'audit-shop@example.test'
        && message.body.includes(BOOKING_REQUEST.code)));
    });
  }
}

for (const mutation of ['rows', 'raw']) {
  test(`配送結果保存中の${mutation}変更後も、受付済みメールを再送せず依頼を探し直す`, () => {
    const app = deliveryTargetFixture('finish', mutation);
    assert.throws(() => app.context.deliverBookingEmails(), /メール配送の記録/);
    assert.equal(app.sent.length, 1);
    app.advance(LEASE_EXPIRY_MS);
    app.context.deliverBookingEmails();
    assert.equal(app.sent.filter(message => message.to === 'audit-shop@example.test'
      && message.body.includes(BOOKING_REQUEST.code)).length, 1);
    assert.equal(app.sent.filter(message => message.to === BOOKING_REQUEST.customer.email).length,
      mutation === 'rows' ? 1 : 0);
    assert.equal(app.sent.length, mutation === 'rows' ? 4 : 3);
    const target = app.jobs().find(job => job.code === app.context.codeKey_(BOOKING_REQUEST.code));
    assert.equal(target.messages.shop.status, '送信結果不明');
    assert.equal(target.messages.customer.status, mutation === 'rows' ? '送信処理受付' : '停止中');
    const other = app.jobs().find(job => job.code === 'LMOTHER');
    assert.equal(other.messages.shop.status, '送信処理受付');
    assert.equal(other.messages.customer.status, '送信処理受付');
    assert.deepEqual(app.ledger.cells, app.ledgerBefore);
  });
}

for (const discard of [false, true]) {
  test(`配送開始の保存${discard ? '未反映' : '反映済み'}と行入替が重なっても、別依頼の同じ本文を保存確認にしない`, () => {
    const app = fixture();
    assert.equal(app.reserve().ok, true);
    assert.equal(app.reserve({ code: 'LM-OTHER', time: '12:00', customer: {
      ...BOOKING_REQUEST.customer, email: 'other-customer@example.test'
    } }).ok, true);
    const beforeLedger = structuredClone(app.ledger.cells);
    const targetId = app.delivery.cells[1][0];
    const getRange = app.delivery.getRange;
    let afterMutation;
    app.delivery.getRange = (row, column, ...size) => {
      const range = getRange(row, column, ...size);
      if (row !== 2 || column !== 3 || afterMutation) return range;
      return { ...range, setValue(value) {
        if (!discard) range.setValue(value);
        app.delivery.cells[2][2] = value;
        [app.delivery.cells[1], app.delivery.cells[2]] = [app.delivery.cells[2], app.delivery.cells[1]];
        afterMutation = structuredClone(app.delivery.cells);
        return range;
      } };
    };
    assert.throws(() => app.context.deliverBookingEmails(), /メール配送の記録/);
    assert.ok(afterMutation);
    assert.equal(app.sent.length, 0, '対象のID・照合・本文の保存確認までは外部送信しない');
    assert.deepEqual(app.delivery.cells, afterMutation);
    assert.deepEqual(app.ledger.cells, beforeLedger);
    const target = JSON.parse(app.delivery.cells.slice(1).find(row => row[0] === targetId)[2]);
    assert.equal(target.messages.shop.status, discard ? '配送待ち' : '配送処理中');
    assert.equal(target.messages.customer.status, '配送待ち');
    assert.throws(() => app.context.deliverBookingEmails(), /メール配送の記録/);
    assert.equal(app.sent.length, 0, '壊れた依頼を推測で修復して自動配送しない');
    assert.deepEqual(app.delivery.cells, afterMutation);
  });
}

test('日時変更の復旧記録を削除した直後の例外を、元の日時への復旧と誤認しない', () => {
  const app = fixture();
  assert.equal(app.reserve().ok, true);
  app.setFault(event => {
    if (event.name === 'properties' && event.operation === 'delete'
        && event.key === 'BOOKING_CHANGE_RECOVERY' && event.phase === 'after') {
      app.setFault(null);
      throw new Error('架空の削除後応答喪失');
    }
  });
  const result = app.change();
  if (result.restored === true) {
    assert.equal(app.field('来店日'), VISIT_DATE, '復旧を案内した応答と実際の保存日時が一致する');
    assert.equal(app.field('開始'), BOOKING_REQUEST.time);
  } else {
    assert.ok(result.ok === true || result.unknown === true, '保存後の不確実性を通常の入力拒否にしない');
  }
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
  const expectedDate = app.field('来店日');
  assert.ok(app.sent.every(message => message.body.includes(expectedDate)), '配送は実際に保存された日時だけを案内する');
});

for (const type of ['adminAddStatus', 'adminAdd']) {
  test(`電話受付IDが一意でも予約番号が重複する台帳で${type}を成功と返さない`, () => {
    const app = fixture();
    const first = app.phone();
    assert.equal(first.ok, true);
    const duplicate = app.ledger.cells[1].slice();
    duplicate[app.ledger.cells[0].indexOf('電話受付ID')] = 'final-phone-request-other-0002';
    duplicate[app.ledger.cells[0].indexOf('電話受付内容')] = '';
    app.ledger.cells.push(duplicate);
    const before = structuredClone(app.ledger.cells);
    const response = app.phone({ type });
    assert.equal(response.ok, false, '同じ予約番号から予約を一意に特定できない結果を断る');
    assert.equal(response.reservation, undefined, '曖昧な予約を登録済みの成功データとして返さない');
    assert.deepEqual(app.ledger.cells, before);
    assert.equal(app.sent.length, 0);
  });
}

test('電話受付IDの行から予約番号が欠けた場合も、結果照会を成功にしない', () => {
  const app = fixture();
  assert.equal(app.phone().ok, true);
  app.ledger.cells[1][app.ledger.cells[0].indexOf('予約番号')] = '';
  const before = structuredClone(app.ledger.cells);
  const result = app.phone({ type: 'adminAddStatus' });
  assert.equal(result.ok, false, '後続の照会・変更・取消へ渡せない予約を成功として返さない');
  assert.equal(result.reservation, undefined);
  assert.deepEqual(app.ledger.cells, before);
});

test('別の予約番号が重複していても、一意な電話受付の結果まで停止しない', () => {
  const app = fixture();
  const first = app.phone();
  assert.equal(first.ok, true);
  const unrelated = app.ledger.cells[1].slice();
  unrelated[app.ledger.cells[0].indexOf('予約番号')] = 'LM-UNRELATED';
  unrelated[app.ledger.cells[0].indexOf('電話受付ID')] = 'final-phone-unrelated-0002';
  app.ledger.cells.push(unrelated, unrelated.slice());
  const before = structuredClone(app.ledger.cells);
  const result = app.phone({ type: 'adminAddStatus' });
  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.equal(result.reservation.code, first.code);
  assert.deepEqual(app.ledger.cells, before);
});

for (const header of ['メール', 'メニュー']) {
  test(`新規予約の保存読戻しで${header}が欠けた場合、成立と通知後送を成功にしない`, () => {
    const app = fixture();
    app.setFault(event => {
      if (event.name === '予約一覧' && event.operation === 'append' && event.phase === 'after') {
        app.ledger.cells.at(-1)[app.ledger.cells[0].indexOf(header)] = '';
        app.setFault(null);
      }
    });
    const result = app.reserve();
    app.context.deliverBookingEmails();
    assert.equal(app.sent.length, 0, '実台帳と一致しない通知依頼は配送しない');
    assert.equal(result.ok, false, '台帳と一致せず配送されない申込を保存・配送成功として案内しない');
    assert.equal(result.unknown, true);
    assert.equal(app.ledger.cells.length, 2, '不確実な保存行を推測で消さない');
  });
}

for (const header of ['お名前', 'フリガナ', '担当', '指名料', '来店回数', '予約の入口', 'ご要望']) {
  test(`保存読戻しの${header}が変わった場合も、成功や配送待ちと案内しない`, () => {
    const app = fixture();
    app.setFault(event => {
      if (event.name === '予約一覧' && event.operation === 'append' && event.phase === 'after') {
        app.ledger.cells.at(-1)[app.ledger.cells[0].indexOf(header)] = header === '指名料' ? 123 : '破損した架空値';
        app.setFault(null);
      }
    });
    const result = app.reserve();
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    app.context.deliverBookingEmails();
    assert.equal(app.sent.length, 0);
  });
}

test('復旧記録の残る日時変更が失敗した後、列を並べ替えても元の予約だけを復旧する', () => {
  const app = fixture();
  assert.equal(app.reserve().ok, true);
  app.ledger.cells[1][0] = '保持する独自列';
  app.setFault(event => {
    if (event.name === '予約一覧' && event.operation === 'write' && event.row > 1
        && event.values.flat().some(value => /^2030-/.test(String(value)))) {
      throw new Error('架空の日時書込・復旧障害');
    }
  });
  assert.equal(app.change().unknown, true);
  assert.ok(app.properties.has('BOOKING_CHANGE_RECOVERY'));
  app.reorder();
  app.setFault(null);
  const lookup = app.send({ type: 'lookup', code: BOOKING_REQUEST.code, tel: BOOKING_REQUEST.customer.tel });
  assert.equal(lookup.ok, true);
  assert.equal(lookup.reservation.date, VISIT_DATE);
  assert.equal(lookup.reservation.time, BOOKING_REQUEST.time);
  assert.equal(app.field('独自列'), '保持する独自列');
  assert.equal(app.properties.has('BOOKING_CHANGE_RECOVERY'), false);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
  assert.ok(app.sent.every(message => message.body.includes(VISIT_DATE)));
});

test('通知を保存してから台帳の列を並べ替えても、同じ予約・宛先へ一度だけ配送する', () => {
  const app = fixture();
  assert.equal(app.reserve().ok, true);
  app.ledger.cells[1][0] = '配送へ含めない独自値';
  app.reorder();
  app.context.deliverBookingEmails();
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
  assert.deepEqual(app.sent.map(message => message.to).sort(),
    ['audit-customer@example.test', 'audit-shop@example.test']);
  assert.ok(app.sent.every(message => !message.body.includes('配送へ含めない独自値')));
  assert.equal(app.field('独自列'), '配送へ含めない独自値');
});

for (const reordered of [false, true]) {
  test(`Google管理の日時変更結果は二千件の履歴を再読込せず、確認済みの予約と配送を返す（列順変更${reordered}）`, () => {
    const app = fixture();
    assert.equal(app.reserve().ok, true);
    const headers = app.ledger.cells[0];
    const original = app.ledger.cells[1].slice();
    for (let index = 0; index < CHANGE_HISTORY_SIZE; index++) {
      const record = original.slice();
      record[headers.indexOf('予約番号')] = `LM-HISTORY-${index}`;
      record[headers.indexOf('来店日')] = '2029-01-05';
      record[headers.indexOf('お名前')] = `過去の架空客${index}`;
      record[headers.indexOf('施術メモ')] = `返さない過去のメモ${index}`;
      app.ledger.cells.push(record);
    }
    if (reordered) app.reorder();
    const before = structuredClone(app.ledger.cells.slice(2));
    app.properties.set('ADMIN_GOOGLE_ONLY', 'true');
    app.context.verifyGoogleAdmin_ = () => {};
    const count = app.effects.length;
    const result = app.send({ type: 'googleAdmin', action: 'adminChange', payload: {
      code: BOOKING_REQUEST.code, fromDate: VISIT_DATE, fromTime: BOOKING_REQUEST.time,
      date: '2030-01-06', time: '14:00' } });
    assert.equal(result.ok, true);
    assert.equal(result.notificationsQueued, true);
    assert.equal(result.reservation.code, BOOKING_REQUEST.code);
    assert.equal(result.reservation.name, BOOKING_REQUEST.customer.name);
    assert.equal(result.reservation.date, '2030-01-06');
    assert.equal(result.reservation.time, '14:00');
    assert.equal(result.reservation.shopMailStatus, '日時変更：配送待ち');
    assert.equal(result.reservation.customerMailStatus, '日時変更：配送待ち');
    const scans = app.effects.slice(count).filter(event => event.name === '予約一覧' && event.operation === 'read'
      && event.row === 1 && event.height === app.ledger.cells.length && event.width === app.ledger.cells[0].length);
    assert.equal(scans.length, 1, '全履歴の一括読込は最終の枠照合だけ。成功結果のためにもう一度読まない');
    assert.deepEqual(app.ledger.cells.slice(2), before, '履歴を削除・間引き・書換して取得量を減らさない');
    assert.equal(app.sent.length, 0);
  });

  test(`Google管理の日時変更結果と配送状態は同じ行snapshotに照合する（列順変更${reordered}）`, () => {
    const app = fixture();
    assert.equal(app.reserve().ok, true);
    if (reordered) app.reorder();
    app.properties.set('ADMIN_GOOGLE_ONLY', 'true');
    app.context.verifyGoogleAdmin_ = () => {};
    let saved = false;
    let mutated = false;
    app.setFault(event => {
      if (event.name === 'properties' && event.operation === 'delete'
          && event.key === 'BOOKING_CHANGE_RECOVERY' && event.phase === 'after') saved = true;
      if (!saved || event.name !== '予約メール配送' || event.operation !== 'read' || event.row !== 1) return;
      app.setFault(null);
      mutated = true;
      const row = app.ledger.cells[1];
      row[app.ledger.cells[0].indexOf('開始')] = '16:00';
      row[app.ledger.cells[0].indexOf('終了')] = '17:00';
      const job = JSON.parse(app.delivery.cells.at(-1)[2]);
      job.messages.shop.status = '送信結果不明';
      job.messages.customer.status = '送信結果不明';
      app.delivery.cells.push([randomUUID(), app.context.bookingEmailSignature_(row, app.ledger.cells[0]), JSON.stringify(job)]);
    });
    const result = app.send({ type: 'googleAdmin', action: 'adminChange', payload: {
      code: BOOKING_REQUEST.code, fromDate: VISIT_DATE, fromTime: BOOKING_REQUEST.time,
      date: '2030-01-06', time: '14:00' } });
    assert.equal(mutated, true, '成功確認の後、配送情報を読む境界に別の変更を差し込む');
    assert.equal(result.ok, true);
    assert.equal(result.reservation.time, '14:00');
    assert.equal(result.reservation.shopMailStatus, '日時変更：配送待ち', '別の日時の配送状態を混ぜない');
    assert.equal(result.reservation.customerMailStatus, '日時変更：配送待ち');
    assert.equal(app.field('開始'), '16:00', '別の変更を戻したり書き換えて成功させない');
    assert.equal(app.jobs().at(-1).messages.customer.status, '送信結果不明');
    assert.equal(app.sent.length, 0);
  });
}

test('管理変更後の配送照合が失敗しても、行snapshotの再利用で成功確認を省略しない', () => {
  const app = fixture();
  assert.equal(app.reserve().ok, true);
  app.properties.set('ADMIN_GOOGLE_ONLY', 'true');
  app.context.verifyGoogleAdmin_ = () => {};
  let saved = false;
  app.setFault(event => {
    if (event.name === 'properties' && event.operation === 'delete'
        && event.key === 'BOOKING_CHANGE_RECOVERY' && event.phase === 'after') saved = true;
    if (saved && event.name === '予約メール配送' && event.operation === 'read') {
      app.setFault(null);
      throw new Error('架空の配送照合障害');
    }
  });
  const result = app.send({ type: 'googleAdmin', action: 'adminChange', payload: {
    code: BOOKING_REQUEST.code, fromDate: VISIT_DATE, fromTime: BOOKING_REQUEST.time,
    date: '2030-01-06', time: '14:00' } });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, true);
  assert.equal(result.reservation, undefined);
  assert.equal(result.notificationsQueued, undefined);
  assert.equal(app.field('来店日'), '2030-01-06');
  assert.equal(app.field('開始'), '14:00');
  assert.equal(app.sent.length, 0);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
  assert.ok(app.sent.every(message => /日時(?:を)?変更/.test(message.subject)
    && /変更後\s*：2030-01-06 14:00/.test(message.body)));
});

for (const action of [{ type: 'change' }, { type: 'cancel' },
  { type: 'adminChange', google: true }, { type: 'cancel', google: true }]) {
  for (const mutation of ['rows', 'headers', 'phone']) {
    test(`${action.google ? 'Google管理' : 'お客様'}の${action.type}の通知後送保存中に${mutation}が変わったら、別予約の保存・配送へ進まない`, () => {
      const app = fixture();
      assert.equal(app.reserve().ok, true);
      app.context.deliverBookingEmails();
      assert.equal(app.sent.length, 2);
      const other = app.ledger.cells[1].slice();
      const headers = app.ledger.cells[0].slice();
      other[headers.indexOf('予約番号')] = 'LM-OTHER';
      other[headers.indexOf('お名前')] = '別の架空客';
      other[headers.indexOf('メール')] = 'other@example.test';
      app.ledger.cells.push(other);
      const before = structuredClone(app.ledger.cells);
      const count = app.effects.length;
      let mutated = false;
      app.setFault(event => {
        if (event.name !== '予約メール配送' || event.operation !== 'append' || event.phase !== 'after') return;
        mutated = true;
        app.setFault(null);
        if (mutation === 'rows') [app.ledger.cells[1], app.ledger.cells[2]] = [app.ledger.cells[2], app.ledger.cells[1]];
        else if (mutation === 'headers') app.reorder();
        else app.ledger.cells[1][headers.indexOf('電話番号')] = '00000000001';
      });
      if (action.google) {
        app.properties.set('ADMIN_GOOGLE_ONLY', 'true');
        app.context.verifyGoogleAdmin_ = () => {};
      }
      const payload = { code: BOOKING_REQUEST.code, tel: BOOKING_REQUEST.customer.tel,
        fromDate: VISIT_DATE, fromTime: BOOKING_REQUEST.time, date: '2030-01-06', time: '14:00' };
      const result = app.send(action.google
        ? { type: 'googleAdmin', action: action.type, payload } : { type: action.type, ...payload });
      assert.equal(mutated, true, '模擬の通知ではなく、実配送記録の保存を通す');
      assert.equal(result.ok, false);
      assert.equal(result.invalid, true);
      assert.equal(result.reservation, undefined);
      assert.equal(result.notificationsQueued, undefined);
      assert.ok(!app.effects.slice(count).some(event => event.name === '予約一覧' && event.operation === 'write'));
      for (const record of before.slice(1)) {
        const current = app.ledger.cells.slice(1).find(row =>
          row[app.ledger.cells[0].indexOf('予約番号')] === record[headers.indexOf('予約番号')]);
        for (const [index, header] of headers.entries()) {
          const expected = mutation === 'phone' && header === '電話番号'
            && record[headers.indexOf('予約番号')] === BOOKING_REQUEST.code ? '00000000001' : record[index];
          assert.equal(current[app.ledger.cells[0].indexOf(header)], expected, header);
        }
      }
      assert.equal(app.jobs().length, 2, '保存前に追加済みの配送記録は、なかったことにしない');
      assert.equal(app.jobs().at(-1).code, 'LMFINAL');
      app.context.deliverBookingEmails();
      app.context.deliverBookingEmails();
      assert.equal(app.sent.length, 2, '台帳へ反映されなかった変更・取消は、再実行でも配送しない');
      assert.ok(app.sent.every(message => message.to !== 'other@example.test'));
    });
  }
}

for (const operation of ['claim', 'finish']) {
  test(`配送${operation === 'claim' ? '権' : '結果'}の保存後に応答を失っても、再送を推測で始めない`, () => {
    const app = fixture();
    assert.equal(app.reserve().ok, true);
    app.setFault(event => {
      if (event.name !== '予約メール配送' || event.operation !== 'write' || event.phase !== 'after') return;
      const record = JSON.parse(event.values[0][0]);
      const status = operation === 'claim' ? '配送処理中' : '送信処理受付';
      if (record.messages.shop.status !== status) return;
      app.setFault(null);
      throw new Error('架空の配送保存後応答喪失');
    });
    assert.throws(() => app.context.deliverBookingEmails(), /メール配送の記録/);
    assert.equal(app.sent.length, operation === 'claim' ? 0 : 1);
    app.advance(LEASE_EXPIRY_MS);
    app.context.deliverBookingEmails();
    assert.equal(app.jobs()[0].messages.shop.status,
      operation === 'claim' ? '送信結果不明' : '送信処理受付');
    assert.equal(app.sent.filter(message => message.to === 'audit-shop@example.test').length,
      operation === 'claim' ? 0 : 1);
    assert.equal(app.sent.filter(message => message.to === 'audit-customer@example.test').length, 1);
    app.context.deliverBookingEmails();
    assert.equal(app.sent.length, operation === 'claim' ? 1 : 2);
  });
}

test('外部受付中に配送権の期限が切れても、別実行は同じメールを再送しない', () => {
  const app = fixture();
  assert.equal(app.reserve().ok, true);
  let expired = false;
  app.setOnMail(() => {
    if (expired) return;
    expired = true;
    app.advance(LEASE_EXPIRY_MS);
    app.context.deliverBookingEmails();
  });
  assert.throws(() => app.context.deliverBookingEmails(), /メール配送の記録/);
  assert.equal(expired, true);
  assert.equal(app.jobs()[0].messages.shop.status, '送信結果不明');
  assert.equal(app.jobs()[0].messages.customer.status, '送信処理受付');
  assert.equal(app.sent.length, 2);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 2);
});

test('配送権取得直後の取消では取得済みの一通が残り、次の旧メールは止まる', () => {
  const app = fixture();
  assert.equal(app.reserve().ok, true);
  const original = app.context.claimBookingEmail_;
  let cancelled = false;
  app.context.claimBookingEmail_ = (...arguments_) => {
    const claimed = original(...arguments_);
    if (claimed && !cancelled) {
      cancelled = true;
      assert.equal(app.sent.length, 0, '取消は外部サービスへの引渡し前に完了した条件を再現する');
      assert.equal(app.cancel().ok, true);
    }
    return claimed;
  };
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 1, '取得済み配送権の一通は、ロック解放と外部受付の間で回収できない');
  assert.match(app.sent[0].subject, /新規予約/);
  app.context.deliverBookingEmails();
  assert.equal(app.sent.length, 3);
  assert.ok(app.sent.slice(1).every(message => /キャンセル/.test(message.subject)));
  assert.equal(app.field('状態'), 'キャンセル');
  assert.equal(app.jobs().at(-1).messages.customer.status, '送信処理受付');
});
