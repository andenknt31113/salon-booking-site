import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const REQUEST = { type: 'reserve', code: 'LM-READS', date: '2030-01-05', time: '10:00',
  createdAt: '2030-01-01T00:00:00Z', totalMinutes: 60, totalPrice: 4000,
  menus: [{ name: '試験カット', price: 4000 }], staffName: 'MATTEO', staffId: 'st01',
  customer: { name: '読込試験', kana: 'ヨミコミシケン', tel: '09011112222', email: 'customer@example.test' } };

function fixture({ calendar = false, failureAt = 0 } = {}) {
  const settings = { 準備中の帯: '出さない', 営業開始: '09:00', 営業終了: '20:00',
    最終受付: '19:00', 定休曜日: '', 通知先メール: 'shop@example.test',
    電話番号: '03-0000-0000', 住所: '試験住所', LINE友だち追加URL: 'https://example.test/line',
    '変更・キャンセル期限（何日前）': 2, '変更・キャンセル期限（何時）': 16 };
  const reads = [];
  const rows = [];
  const messages = [];
  const events = [];
  let held = false;
  let headers;
  const settingSheet = {
    getLastRow: () => Object.keys(settings).length + 1,
    getLastColumn: () => 2,
    getRange() {
      assert.equal(held, true, '予約を検査する設定は同じロック内で読む');
      reads.push({ ...settings });
      if (failureAt && reads.length === failureAt) throw new Error('試験用の設定読込失敗');
      return { getValues: () => [['項目', '内容'], ...Object.entries(settings)] };
    }
  };
  const spreadsheet = { getSheetByName: name => {
    assert.equal(name, '設定');
    return settingSheet;
  } };
  const ledger = { getParent: () => spreadsheet, appendRow: record => {
    assert.equal(held, true);
    rows.push(record);
  }, getLastRow: () => rows.length + 1, getLastColumn: () => headers.length,
  getRange(row, column, numRows = 1, numColumns = 1) {
    return { getValues() {
      assert.equal(held, true);
      return [headers, ...rows].slice(row - 1, row - 1 + numRows)
        .map(cells => cells.slice(column - 1, column - 1 + numColumns));
    }, setValue(value) { rows[row - 2][column - 1] = value; } };
  } };
  const context = vm.createContext({ Date, console: { error() {}, warn() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() { assert.equal(held, true); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    Utilities: { formatDate: () => '2030-01-01' },
    MailApp: { sendEmail(...args) {
      assert.equal(held, true, '通知受付中も元のロックを保持する');
      messages.push(args);
    } },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent(...args) {
      assert.equal(held, true);
      events.push(args);
      return { getId: () => 'test-event' };
    } }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  const source = calendar ? SOURCE.replace("const CALENDAR_ID = '';", "const CALENDAR_ID = 'primary';") : SOURCE;
  if (calendar) assert.notEqual(source, SOURCE);
  vm.runInContext(source, context);
  headers = Array.from(vm.runInContext('HEADERS', context));
  context.getSheet_ = () => ledger;
  context.findRowByCode_ = () => -1;
  context.verifyReservationMenus_ = () => '';
  context.isTaken_ = () => false;
  context.hitsClosed_ = () => false;
  context.recordMailStatus_ = () => {};
  context.todayKey_ = () => '2030-01-01';
  context.nowMinJst_ = () => 9 * 60;
  return { settings, reads, rows, messages, events, context, held: () => held,
    send: (changes = {}) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ ...REQUEST, ...changes }) } })) };
}

for (const calendar of [false, true]) {
  test(`予約の設定を検査時にまとめて読み、通知${calendar ? 'とカレンダー' : ''}で何度も取り直さない`, () => {
    const app = fixture({ calendar });
    const response = app.send();
    assert.equal(response.ok, true);
    assert.equal(app.reads.length, 2, '受付停止の確認と最新の受付条件をそれぞれ1回読む');
    assert.equal(app.rows.length, 1);
    assert.equal(app.messages.length, 2);
    assert.equal(app.messages[0][0], 'shop@example.test');
    assert.match(app.messages[1][2], /2日前の16時/);
    assert.match(app.messages[1][2], /03-0000-0000/);
    assert.match(app.messages[1][2], /試験住所/);
    assert.match(app.messages[1][2], /https:\/\/example\.test\/line/);
    assert.equal(app.events.length, calendar ? 1 : 0);
    if (calendar) assert.equal(app.events[0][3].location, '試験住所');
    assert.equal(app.held(), false);
    assert.equal(JSON.stringify(response).includes('shop@example.test'), false);
  });
}

test('次の予約は前回の設定を持ち越さず、新しい営業時間と通知先を使う', () => {
  const app = fixture();
  assert.equal(app.send().ok, true);
  app.settings.営業開始 = '11:00';
  app.settings.通知先メール = 'new-shop@example.test';
  app.settings.電話番号 = '03-1111-1111';
  assert.equal(app.send({ code: 'LM-EARLY' }).scheduleChanged, true);
  assert.equal(app.rows.length, 1);
  assert.equal(app.messages.length, 2);
  assert.equal(app.send({ code: 'LM-LATER', time: '12:00' }).ok, true);
  assert.equal(app.reads.length, 6);
  assert.equal(app.rows.length, 2);
  assert.equal(app.messages[2][0], 'new-shop@example.test');
  assert.match(app.messages[3][2], /03-1111-1111/);
  assert.equal(app.held(), false);
});

test('送信者が受付条件を渡しても、店舗の停止・定休日・営業時間を置き換えられない', () => {
  for (const [key, value, expected] of [['準備中の帯', '出す', 'draft'], ['定休曜日', '土', 'scheduleChanged'],
    ['営業開始', '12:00', 'scheduleChanged']]) {
    const app = fixture();
    app.settings[key] = value;
    const response = app.send({ settings: { 準備中の帯: '出さない', 定休曜日: '', 営業開始: '00:00' } });
    assert.equal(response.ok, false);
    assert.equal(response[expected], true);
    assert.equal(app.rows.length, 0);
    assert.equal(app.messages.length, 0);
    assert.equal(app.events.length, 0);
    assert.equal(app.held(), false);
  }
});

for (const failureAt of [1, 2]) {
  test(`${failureAt}回目の設定読込失敗は、既定時間へ戻して予約を受け付けない`, () => {
    const app = fixture({ failureAt });
    assert.equal(app.send().ok, false);
    assert.equal(app.rows.length, 0);
    assert.equal(app.messages.length, 0);
    assert.equal(app.events.length, 0);
    assert.equal(app.held(), false);
  });
}

test('予約以外から個別に呼ぶ既存の設定関数も、変更した値を次の呼出しで読む', () => {
  const app = fixture();
  assert.equal(app.send().ok, true);
  const first = app.context.withLedgerLock_(() => app.context.salonSignature_());
  app.settings.電話番号 = '03-2222-2222';
  app.settings.住所 = '変更した試験住所';
  const second = app.context.withLedgerLock_(() => app.context.salonSignature_());
  assert.match(first, /03-0000-0000/);
  assert.match(second, /03-2222-2222/);
  assert.match(second, /変更した試験住所/);
  assert.equal(app.held(), false);
});
