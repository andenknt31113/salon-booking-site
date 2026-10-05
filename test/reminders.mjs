import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const NOW = Date.parse('2030-01-05T14:59:59.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
class ClockDate extends Date {
  constructor(...values) { super(...(values.length ? values : [NOW])); }
  static now() { return NOW; }
}
const dateText = date => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(date);
const target = dateText(new Date(NOW + DAY_MS));
const headers = ['予約番号', '来店日', '開始', 'メニュー', '担当', 'お名前', 'メール', '状態'];
const records = [
  { 予約番号: 'LM-REM01', 来店日: target, 開始: '10:00', メニュー: 'カット',
    担当: 'MATTEO', お名前: '試験 太郎', メール: 'ready@example.test', 状態: '予約確定' },
  { 予約番号: 'LM-REM02', 来店日: target, 開始: '11:00', メニュー: 'カット',
    担当: 'MATTEO', お名前: '試験 花子', メール: '', 状態: '予約確定' },
  { 予約番号: 'LM-REM03', 来店日: target, 開始: '12:00', メニュー: 'カット',
    担当: 'MATTEO', お名前: '試験 次郎', メール: 'fail@example.test', 状態: '予約確定' },
  { 予約番号: 'LM-REM04', 来店日: target, 開始: '13:00', メニュー: 'カット',
    担当: 'MATTEO', お名前: '試験 三郎', メール: 'cancelled@example.test', 状態: 'キャンセル' }
];

function harness({ failRead = false, reenter = false } = {}) {
  const values = [headers, ...records.map(record => headers.map(header => record[header] || ''))];
  const properties = {};
  const sent = [];
  const logs = [];
  let held = false;
  let nested = false;
  let nestedError = '';
  const sheet = {
    getLastRow: () => values.length,
    getLastColumn: () => headers.length,
    getRange: (row, column, height = 1, width = headers.length) => ({
      getValues: () => {
        if (failRead && row > 1) throw new Error('試験用の台帳読込失敗');
        return values.slice(row - 1, row - 1 + height)
          .map(cells => Array.from({ length: width }, (_, offset) => cells[column - 1 + offset] || ''));
      }
    })
  };
  const context = vm.createContext({
    Date: ClockDate,
    console: { log: message => logs.push(String(message)), warn() {}, error() {} },
    LockService: { getScriptLock: () => ({
      waitLock() { if (held) throw new Error('処理中'); held = true; },
      releaseLock() { held = false; }
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty(key) {
        if (reenter && key === 'REMINDED_DATE' && !nested) {
          nested = true;
          try { context.sendReminders(); } catch (error) { nestedError = error.message; }
        }
        return properties[key] || null;
      },
      setProperty(key, value) { properties[key] = value; }
    }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => null }) },
    MailApp: { sendEmail(to) {
      if (to === 'fail@example.test') throw new Error('試験用のメール送信失敗');
      sent.push(to);
    } },
    Utilities: { formatDate: date => dateText(date) }
  });
  vm.runInContext(source, context);
  context.getSheet_ = () => sheet;
  return { context, properties, sent, logs, held: () => held,
    nested: () => nested, nestedError: () => nestedError };
}

const concurrent = harness({ reenter: true });
concurrent.context.sendReminders();
assert.equal(concurrent.nested(), true, '記録前に別の実行が重なる条件を再現する');
assert.equal(concurrent.nestedError(), '処理中', '同時実行はロック内へ入れない');
assert.deepEqual(concurrent.sent, ['ready@example.test'], '同じお客様に二通送らない');
assert.equal(concurrent.properties.REMINDED_DATE, undefined, '失敗分を含む日全体は送信済みにしない');
assert.deepEqual(JSON.parse(concurrent.properties.REMINDER_DELIVERY_PROGRESS),
  { date: target, sent: ['LM-REM01'], pending: [] }, '成功した予約だけを控える');
assert.equal(concurrent.held(), false, '処理後にロックを解放する');
assert.ok(concurrent.logs.some(message => /送信処理受付.*1件.*未送信.*2件/.test(message)),
  'メールなしと送信失敗を成功件数に加えない');
concurrent.context.sendReminders();
assert.deepEqual(concurrent.sent, ['ready@example.test'], '同じ日の再実行でも二通目を送らない');

const unreadable = harness({ failRead: true });
assert.throws(() => unreadable.context.sendReminders(), /台帳読込失敗/, '台帳を読めない場合は送信しない');
assert.equal(unreadable.properties.REMINDED_DATE, undefined, '読込失敗時に送信済みと記録しない');
assert.equal(unreadable.held(), false, '読込失敗時もロックを解放する');

console.log('前日リマインド：同時実行・再実行・送信件数・台帳読込失敗を確認しました。');
