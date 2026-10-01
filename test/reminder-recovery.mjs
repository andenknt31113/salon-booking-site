import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const TARGET = '2030-01-02';
const PROGRESS_KEY = 'REMINDER_DELIVERY_PROGRESS';
const HEADERS = ['予約番号', '来店日', '開始', 'メニュー', '担当', 'お名前', 'メール', '状態'];
class FixedDate extends Date {
  constructor(...values) { super(...(values.length ? values : ['2030-01-01T10:00:00+09:00'])); }
  static now() { return Date.parse('2030-01-01T10:00:00+09:00'); }
}

function environment({ cancelAtLock = false, failPropertyWrite = 0, discardPropertyWrite = false } = {}) {
  const records = [
    { 予約番号: 'LM-REM01', 来店日: TARGET, 開始: '10:00', メニュー: '試験カット', 担当: '試験担当',
      お名前: '試験 太郎', メール: 'first@example.test', 状態: '予約確定' },
    { 予約番号: 'LM-REM02', 来店日: TARGET, 開始: '11:00', メニュー: '試験カット', 担当: '試験担当',
      お名前: '試験 花子', メール: 'second@example.test', 状態: '予約確定' }
  ];
  const properties = new Map();
  const attempts = [];
  const accepted = [];
  const logs = [];
  let held = false;
  let writes = 0;
  let failMail = false;
  let failRead = false;
  let onMail;
  let onAcquire;
  let acquisitions = 0;
  const sheet = {
    getLastRow: () => records.length + 1,
    getLastColumn: () => HEADERS.length,
    getRange(row, column, height = 1, width = HEADERS.length) {
      return { getValues() {
        if (failRead) throw new Error('試験用の読込障害');
        const cells = [HEADERS, ...records.map(record => HEADERS.map(header => record[header] ?? ''))];
        return cells.slice(row - 1, row - 1 + height).map(line => line.slice(column - 1, column - 1 + width));
      } };
    }
  };
  const context = vm.createContext({ Date: FixedDate,
    console: { log: message => logs.push(message), warn() {}, error() {} },
    LockService: { getScriptLock: () => ({
      waitLock() {
        if (held) throw new Error('処理中');
        acquisitions++;
        if (onAcquire) onAcquire(acquisitions);
        if (cancelAtLock) records.forEach(record => { record.状態 = 'キャンセル'; });
        held = true;
      },
      releaseLock() { held = false; }
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty(key, value) {
        writes++;
        if (writes === failPropertyWrite) throw new Error('試験用の進捗記録障害');
        if (!discardPropertyWrite) properties.set(key, value);
      },
      deleteProperty: key => properties.delete(key)
    }) },
    Utilities: { formatDate: date => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date) },
    MailApp: { sendEmail(address, subject, body) {
      attempts.push(address);
      if (onMail) onMail({ address, subject, body, held });
      if (failMail && address === 'second@example.test') throw new Error('試験用のメール障害');
      accepted.push(address);
    } }
  });
  vm.runInContext(source, context);
  context.getSheet_ = () => sheet;
  return { context, records, properties, attempts, accepted, logs, held: () => held,
    failMail: value => { failMail = value; }, failRead: value => { failRead = value; },
    onMail: callback => { onMail = callback; }, onAcquire: callback => { onAcquire = callback; } };
}

test('前日通知の失敗分だけを再試行し、成功済みのお客様へ二通目を送らない', () => {
  const app = environment();
  app.failMail(true);
  app.context.sendReminders();
  assert.deepEqual(app.accepted, ['first@example.test']);
  assert.notEqual(app.properties.get('REMINDED_DATE'), TARGET, '未送信を日全体の送信済みにしない');
  app.failMail(false);
  app.context.sendReminders();
  assert.deepEqual(app.accepted, ['first@example.test', 'second@example.test']);
  app.context.sendReminders();
  assert.deepEqual(app.accepted, ['first@example.test', 'second@example.test']);
  assert.equal(app.held(), false);
});

test('ロック待ち中に取消された予約を、読込済みの古い内容で通知しない', () => {
  const app = environment({ cancelAtLock: true });
  app.context.sendReminders();
  assert.deepEqual(app.records.map(record => record.状態), ['キャンセル', 'キャンセル']);
  assert.deepEqual(app.attempts, []);
});

test('送信直前の状態確認とメール受付まで同じロックで守り、処理後には解放する', () => {
  const app = environment();
  app.onMail(({ held }) => {
    assert.equal(held, true);
    assert.throws(() => app.context.withLedgerLock_(() => {}), /処理中/);
  });
  app.context.sendReminders();
  assert.equal(app.accepted.length, 2);
  assert.equal(app.held(), false);
});

test('同日分の処理後に増えた予約も、過去の成功分を再送せず通知できる', () => {
  const app = environment();
  app.context.sendReminders();
  app.records.push({ ...app.records[0], 予約番号: 'LM-REM03', 開始: '13:00', メール: 'new@example.test' });
  app.context.sendReminders();
  assert.deepEqual(app.accepted, ['first@example.test', 'second@example.test', 'new@example.test']);
});

test('候補を集めた後でも、一件ずつロックを取り直して取消と最新の時刻を確認する', () => {
  for (const cancel of [true, false]) {
    const app = environment();
    app.onAcquire(count => {
      if (count !== 3) return;
      if (cancel) app.records[1].状態 = 'キャンセル';
      else app.records[1].開始 = '14:00';
    });
    app.onMail(({ address, body }) => {
      if (address === 'second@example.test') assert.match(body, /14:00/);
    });
    app.context.sendReminders();
    assert.deepEqual(app.accepted, cancel ? ['first@example.test'] : ['first@example.test', 'second@example.test']);
  }
});

test('以前の形式で当日分が送信済みなら、移行時に同じ通知を送り直さない', () => {
  const app = environment();
  app.properties.set('REMINDED_DATE', TARGET);
  app.context.sendReminders();
  assert.deepEqual(app.attempts, []);
});

test('宛先なし・停止中を成功として控えず、送信可能になった後に再確認できる', () => {
  const app = environment();
  app.records[1].メール = '';
  const original = app.context.mailCustomer_;
  app.context.mailCustomer_ = () => '停止中';
  app.context.sendReminders();
  assert.deepEqual(app.accepted, []);
  app.context.mailCustomer_ = original;
  app.context.sendReminders();
  assert.deepEqual(app.accepted, ['first@example.test']);
  app.records[1].メール = 'second@example.test';
  app.context.sendReminders();
  assert.deepEqual(app.accepted, ['first@example.test', 'second@example.test']);
});

test('送信前の進捗記録を確認できなければ、メールを送り出さない', () => {
  for (const options of [{ failPropertyWrite: 1 }, { discardPropertyWrite: true }]) {
    const app = environment(options);
    assert.throws(() => app.context.sendReminders());
    assert.deepEqual(app.attempts, []);
    assert.equal(app.held(), false);
  }
});

test('送信後の記録に失敗したら結果不明を保ち、再実行で盲目的に再送しない', () => {
  const app = environment({ failPropertyWrite: 2 });
  app.records.pop();
  assert.throws(() => app.context.sendReminders());
  assert.deepEqual(app.accepted, ['first@example.test']);
  const progress = JSON.parse(app.properties.get(PROGRESS_KEY));
  assert.deepEqual(progress.pending, ['LM-REM01']);
  assert.throws(() => app.context.sendReminders(), /確認/);
  assert.deepEqual(app.attempts, ['first@example.test']);
  assert.equal(app.held(), false);
});

test('壊れた進捗と重複予約番号を送信済みの空リストへ変換せず、通知を止める', () => {
  for (const corrupt of ['{', JSON.stringify({ date: TARGET, sent: '壊れた一覧', pending: [] })]) {
    const app = environment();
    app.properties.set(PROGRESS_KEY, corrupt);
    assert.throws(() => app.context.sendReminders());
    assert.deepEqual(app.attempts, []);
    assert.equal(app.held(), false);
  }
  const duplicate = environment();
  duplicate.records[1].予約番号 = duplicate.records[0].予約番号;
  assert.throws(() => duplicate.context.sendReminders());
  assert.deepEqual(duplicate.attempts, []);
});

test('台帳を読み取れない場合は通知も送信済み記録も作らない', () => {
  const app = environment();
  app.failRead(true);
  assert.throws(() => app.context.sendReminders(), /読込障害/);
  assert.deepEqual(app.attempts, []);
  assert.equal(app.properties.get('REMINDED_DATE'), undefined);
  assert.equal(app.properties.get(PROGRESS_KEY), undefined);
  assert.equal(app.held(), false);
});

test('進捗には予約番号だけを残し、お客様の氏名・メール・本文を保存しない', () => {
  const app = environment();
  app.context.sendReminders();
  const raw = app.properties.get(PROGRESS_KEY);
  assert.ok(raw);
  assert.doesNotMatch(raw, /example\.test|試験 太郎|試験 花子|試験カット/);
  assert.deepEqual(JSON.parse(raw), { date: TARGET, sent: ['LM-REM01', 'LM-REM02'], pending: [] });
});
