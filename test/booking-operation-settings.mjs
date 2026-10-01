import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const DAY_MS = 24 * 60 * 60 * 1000;
const futureDate = days => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

function fixture({ admin = false, calendar = false, failRead = false } = {}) {
  const settings = { 営業開始: '09:00', 営業終了: '20:00', 最終受付: '19:00', 定休曜日: '',
    通知先メール: 'shop@example.test', 電話番号: '03-0000-0000', 住所: '設定試験住所',
    '変更・キャンセル期限（何日前）': 1, '変更・キャンセル期限（何時）': 18 };
  const record = { 予約番号: 'LM-SETTINGS', 来店日: futureDate(6), 開始: '10:00', 終了: '11:00',
    '所要(分)': 60, 状態: '予約確定', メニュー: '試験カット', 担当: 'MATTEO', 担当ID: 'st01',
    合計金額: 4000, お名前: '設定試験', 電話番号: '09011112222', メール: 'customer@example.test' };
  const reads = [];
  const writes = [];
  const messages = [];
  const events = [];
  let held = false;
  let canonical;
  const settingSheet = {
    getLastRow: () => Object.keys(settings).length + 1,
    getLastColumn: () => 2,
    getRange: () => ({ getValues() {
      assert.equal(held, true);
      reads.push({ ...settings });
      if (failRead) throw new Error('試験用の設定読込失敗');
      return [['項目', '内容'], ...Object.entries(settings)];
    } })
  };
  const spreadsheet = { getSheetByName(name) { assert.equal(name, '設定'); return settingSheet; } };
  const ledger = { getParent: () => spreadsheet, getRange(_row, column) {
    const range = { getValues() {
      assert.equal(held, true);
      return [[record[canonical[column - 1]] ?? '']];
    }, setValue(value) {
      assert.equal(held, true);
      record[canonical[column - 1]] = value;
      writes.push({ column, value });
      return range;
    }, setFontLine: () => range, setFontColor: () => range };
    return range;
  } };
  const context = vm.createContext({ Date, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() { assert.equal(held, true); } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    MailApp: { sendEmail(...args) { assert.equal(held, true); messages.push(args); } },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent(...args) {
      assert.equal(held, true);
      events.push(args);
      return { getId: () => 'test-calendar-event' };
    } }) }
  });
  const source = calendar ? SOURCE.replace("const CALENDAR_ID = '';", "const CALENDAR_ID = 'primary';") : SOURCE;
  if (calendar) assert.notEqual(source, SOURCE);
  vm.runInContext(source, context);
  canonical = Array.from(vm.runInContext('HEADERS', context));
  context.getSheet_ = () => ledger;
  context.findRowByCode_ = () => 2;
  context.colIndex_ = () => header => canonical.indexOf(header);
  context.headerRow_ = () => canonical;
  context.readRow_ = () => canonical.map(header => record[header] ?? '');
  context.isAdmin_ = () => admin;
  context.todayKey_ = () => futureDate(0);
  context.nowMinJst_ = () => 9 * 60;
  context.isTaken_ = () => false;
  context.hitsClosed_ = () => false;
  context.recordMailStatus_ = () => {};
  context.writeBookingWindow_ = (_sheet, _row, _code, values) => {
    assert.equal(held, true);
    ['来店日', '開始', '終了'].forEach((header, index) => { record[header] = values[index]; });
    writes.push({ window: Array.from(values) });
  };
  return { settings, record, reads, writes, messages, events, context, held: () => held,
    send: (type, changes = {}) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
      type, code: record.予約番号, tel: record.電話番号, fromDate: record.来店日, fromTime: record.開始,
      date: futureDate(7), time: '14:00', ...changes
    }) } })) };
}

for (const operation of ['change', 'cancel']) {
  for (const admin of [false, true]) {
    test(`${admin ? '店' : 'お客様'}の${operation}は最新の設定を1回読み、検査と通知へ同じ値を使う`, () => {
      const app = fixture({ admin });
      assert.equal(app.send(operation).ok, true);
      assert.equal(app.reads.length, 1);
      assert.equal(app.writes.length, 1);
      assert.equal(app.messages.length, 2);
      assert.match(app.messages[0][2], /03-0000-0000/);
      assert.equal(app.messages[1][0], 'shop@example.test');
      assert.equal(app.held(), false);
    });
  }
}

test('カレンダー有効の日時変更も設定を取り直さず、同じ住所で予定を作る', () => {
  const app = fixture({ calendar: true });
  assert.equal(app.send('change').ok, true);
  assert.equal(app.reads.length, 1);
  assert.equal(app.events.length, 1);
  assert.equal(app.events[0][3].location, app.settings.住所);
});

for (const operation of ['change', 'cancel']) {
  test(`${operation}の設定読込が失敗したら、既定期限や別の通知先で保存を続けない`, () => {
    for (const admin of [false, true]) {
      const app = fixture({ failRead: true, admin });
      const before = { ...app.record };
      assert.equal(app.send(operation).ok, false);
      assert.deepEqual(app.record, before);
      assert.equal(app.writes.length, 0);
      assert.equal(app.messages.length, 0);
      assert.equal(app.held(), false);
    }
  });

  test(`${operation}の本人確認失敗では設定や通知先を読まない`, () => {
    const app = fixture();
    assert.equal(app.send(operation, { tel: '09099998888' }).ok, false);
    assert.equal(app.reads.length, 0);
    assert.equal(app.writes.length, 0);
    assert.equal(app.messages.length, 0);
  });

  test(`${operation}は送信者の期限設定を信用せず、店舗の最新の期限で断る`, () => {
    const app = fixture();
    app.settings['変更・キャンセル期限（何日前）'] = 30;
    const response = app.send(operation, { settings: { '変更・キャンセル期限（何日前）': 0 } });
    assert.equal(response.deadline, true);
    assert.match(response.error, /30日前の18時/);
    assert.match(response.error, /03-0000-0000/);
    assert.equal(app.reads.length, 1, '拒否の文面にも同じ最新の設定を使う');
    assert.equal(app.writes.length, 0);
    assert.equal(app.messages.length, 0);
  });
}

test('次の日時変更は新しい営業時間・電話番号・通知先を読む', () => {
  const app = fixture();
  assert.equal(app.send('change').ok, true);
  app.settings.営業開始 = '15:00';
  assert.equal(app.send('change', { date: futureDate(8), time: '14:00' }).scheduleChanged, true);
  assert.equal(app.writes.length, 1);
  app.settings.営業開始 = '09:00';
  app.settings.通知先メール = 'new-shop@example.test';
  app.settings.電話番号 = '03-1111-1111';
  assert.equal(app.send('change', { date: futureDate(8), time: '15:00' }).ok, true);
  assert.equal(app.reads.length, 3);
  assert.match(app.messages[2][2], /03-1111-1111/);
  assert.equal(app.messages[3][0], 'new-shop@example.test');
});

test('個別に使う期限の確認・案内も、次の呼び出しで新しい設定を読む', () => {
  const app = fixture();
  const first = app.context.withLedgerLock_(() => app.context.deadlineMessage_());
  app.settings['変更・キャンセル期限（何日前）'] = 30;
  app.settings.電話番号 = '03-2222-2222';
  const second = app.context.withLedgerLock_(() => app.context.deadlineMessage_());
  assert.match(first, /前日18時/);
  assert.match(second, /30日前の18時/);
  assert.match(second, /03-2222-2222/);
  assert.equal(app.context.withLedgerLock_(() => app.context.withinDeadline_(app.record.来店日)), false);
});
