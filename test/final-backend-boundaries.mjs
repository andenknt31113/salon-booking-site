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
