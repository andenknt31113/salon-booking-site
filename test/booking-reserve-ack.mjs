import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const REQUEST = { type: 'reserve', code: 'LM-NEWACK', date: '2030-01-05', time: '10:00',
  totalMinutes: 60, totalPrice: 4000, menus: [{ id: 'm01', name: '試験カット', price: 4000, minutes: 60 }],
  staffId: 'st01', staffName: 'MATTEO', customer: { name: '保存確認試験', kana: 'ホゾンカクニンシケン',
    tel: '00000000000', email: 'reserve-ack@example.test' } };

function fixture({ fault = '', changed = null, coerce = false, previous = false } = {}) {
  const effects = [];
  const rows = [];
  let headers;
  let held = false;
  let attempted = false;
  let pending = null;
  const spreadsheet = { getSheetByName: () => null };
  const sheet = {
    getParent: () => spreadsheet,
    getLastRow: () => rows.length + 1, getLastColumn: () => headers.length,
    getRange(row, column, numRows = 1, numColumns = 1) {
      return { getValues() {
        assert.equal(held, true);
        if (attempted && row > 1 && numColumns === headers.length) {
          effects.push('read-reservation');
          if (fault === 'read-failure') throw new Error('試験用の読込失敗');
          if (fault === 'empty-read') return [];
        }
        const values = [headers, ...rows];
        return values.slice(row - 1, row - 1 + numRows).map(cells => cells.slice(column - 1, column - 1 + numColumns));
      } };
    },
    appendRow(values) {
      assert.equal(held, true);
      effects.push('append');
      attempted = true;
      if (fault === 'write-before') throw new Error('試験用の保存前失敗');
      if (fault === 'delayed') pending = Array.from(values);
      else if (fault !== 'discard') rows.push(Array.from(values));
      if (fault === 'write-after') throw new Error('試験用の保存後失敗');
    }
  };
  const context = vm.createContext({ Date, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { flush() {
      assert.equal(held, true);
      effects.push('flush');
      if (fault === 'flush-failure') throw new Error('試験用の反映失敗');
      if (pending) { rows.push(pending); pending = null; }
      const latest = rows.at(-1);
      if (changed && latest) for (const [header, value] of Object.entries(changed)) latest[headers.indexOf(header)] = value;
      if (coerce && latest) {
        latest[headers.indexOf('来店日')] = new Date('2030-01-05T12:00:00+09:00');
        latest[headers.indexOf('電話番号')] = REQUEST.customer.tel;
        latest[headers.indexOf('所要(分)')] = '60';
        latest[headers.indexOf('合計金額')] = '4000';
      }
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    Utilities: { formatDate: value => {
      const date = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000);
      return date.toISOString().slice(0, 10);
    } },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) }
  });
  vm.runInContext(SOURCE, context);
  headers = Array.from(vm.runInContext('HEADERS', context));
  if (previous) rows.push(headers.map(header => header === '予約番号' ? 'LM-PREV' : ''));
  context.getSheet_ = () => sheet;
  context.draftMode_ = () => false;
  context.readBookingSettings_ = () => ({});
  context.verifyReservationMenus_ = () => '';
  context.todayKey_ = () => '2030-01-01';
  context.nowMinJst_ = () => 9 * 60;
  context.recordMailStatus_ = () => {};
  for (const name of ['notify_', 'mailCustomer_', 'notifyLine_']) context[name] = () => {
    assert.equal(held, true);
    effects.push(name);
    return '送信処理受付';
  };
  return { rows, effects, headers, held: () => held,
    send: changes => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ ...REQUEST, ...changes }) } })) };
}

for (const fault of ['discard', 'write-before', 'write-after', 'flush-failure', 'read-failure', 'empty-read']) {
  test(`新規予約の${fault}では成立や通知を先取りせず、同じ番号の照会へ案内する`, () => {
    const app = fixture({ fault, previous: true });
    const result = app.send();
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.match(result.error, /保存結果.*予約確認/);
    assert.equal(result.error.includes('試験用'), false);
    assert.ok(!app.effects.some(effect => ['notify_', 'mailCustomer_', 'notifyLine_'].includes(effect)));
    assert.equal(app.held(), false);
  });
}

for (const changed of [{ 予約番号: 'LM-WRONG' }, { 来店日: '2030-01-06' }, { 開始: '14:00' },
  { 終了: '12:00' }, { '所要(分)': 90 }, { 合計金額: 9000 }, { 電話番号: '00000000001' },
  { 担当ID: 'st02' }, { 状態: 'キャンセル' }]) {
  test(`読み戻した内容が申込と違う場合は成立通知を送らない：${JSON.stringify(changed)}`, () => {
    const app = fixture({ changed });
    const result = app.send();
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.ok(!app.effects.some(effect => ['notify_', 'mailCustomer_', 'notifyLine_'].includes(effect)));
    assert.equal(app.rows.length, 1, '結果不明だからといって保存行を削除しない');
  });
}

for (const options of [{}, { fault: 'delayed' }, { coerce: true }]) {
  test(`正常な保存は反映・読み戻しを終えてから通知する：${JSON.stringify(options)}`, () => {
    const app = fixture(options);
    const result = app.send();
    assert.equal(result.ok, true);
    assert.equal(result.code, REQUEST.code);
    assert.deepEqual(app.effects, ['append', 'flush', 'read-reservation', 'notify_', 'notifyLine_', 'mailCustomer_']);
    assert.equal(app.rows.length, 1);
    assert.equal(app.held(), false);
  });
}

test('保存後の応答喪失は同じ番号で照会でき、再送も行や通知を増やさない', () => {
  const app = fixture({ fault: 'write-after' });
  assert.equal(app.send().unknown, true);
  const result = app.send({ type: 'lookup', tel: REQUEST.customer.tel });
  assert.equal(result.ok, true);
  assert.equal(result.reservation.status, '予約確定');
  assert.equal(app.send().duplicate, true);
  assert.equal(app.rows.length, 1);
  assert.deepEqual(app.effects.filter(effect => !effect.startsWith('read-')), ['append']);
});

test('保存されなかった場合も自動で追加せず、照会で見つからないことを確認できる', () => {
  const app = fixture({ fault: 'discard' });
  assert.equal(app.send().unknown, true);
  assert.equal(app.send({ type: 'lookup', tel: REQUEST.customer.tel }).ok, false);
  assert.equal(app.rows.length, 0);
  assert.equal(app.effects.filter(effect => effect === 'append').length, 1);
});
