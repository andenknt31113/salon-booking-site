import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const FALLBACK = ['項目', '内容', '追加列'];

function fixture(initial = [], native = true) {
  let cells = structuredClone(initial);
  let held = false;
  let fail = false;
  const calls = [];
  const context = vm.createContext({ Date, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    Utilities: { DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, text) => [...createHash(algorithm).update(text).digest()] } });
  vm.runInContext(SOURCE, context);
  const width = () => Math.max(0, ...cells.map(row => row.length));
  const record = method => { assert.equal(held, true); calls.push(method); };
  const range = (row, column, height, columns) => ({ getValues() {
    record('getValues');
    if (fail) throw new Error('架空のシート読込失敗');
    return Array.from({ length: height }, (_unused, rowIndex) => Array.from({ length: columns }, (_value, columnIndex) =>
      cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
  } });
  const sheet = {
    getLastRow() { record('getLastRow'); return cells.length; },
    getLastColumn() { record('getLastColumn'); return width(); },
    getRange(...args) { record('getRange'); return range(...args); }
  };
  if (native) sheet.getDataRange = () => {
    record('getDataRange');
    return range(1, 1, Math.max(1, cells.length), Math.max(1, width()));
  };
  return { context, sheet, calls, held: () => held,
    replace: next => { cells = structuredClone(next); }, fail: () => { fail = true; },
    read: (fallback = FALLBACK, withStamp = true) => JSON.parse(JSON.stringify(
      context.withLedgerLock_(() => context.readSheetSnapshot_(sheet, fallback, withStamp)))) };
}

for (const [label, cells] of [
  ['空シート', []],
  ['見出しのみ', [['項目', '内容']]],
  ['通常の値', [['項目', '内容'], ['営業開始', '09:00'], ['定休日', '土']]],
  ['少ない列', [['項目'], ['独自項目']]],
  ['独自列・並べ替え', [['内容', '独自列', ' 項目 '], ['09:00', '残す', '営業開始']]],
  ['見出しのない旧シート', [['', '', ''], ['09:00', '', '残す']]],
  ['空文字を返すセル', [['']]],
  ['日付・数値・数式文字', [['項目', '内容'], ['日時', new Date('2030-01-01T09:00:00+09:00')], ['料金', 4000], ['文字', '=試験']]]
]) {
  test(`使用範囲取得と従来の範囲取得は同じ値・欠けた列・競合印を返す：${label}`, () => {
    const direct = fixture(cells);
    const previous = fixture(cells, false);
    assert.deepEqual(direct.read(), previous.read());
    assert.equal(direct.held(), false);
    assert.equal(previous.held(), false);
  });
}

test('通常シートは2回のAPI呼出しで読め、行数・列数を個別取得しない', () => {
  const app = fixture([['項目', '内容'], ['営業開始', '09:00']]);
  const result = app.read();
  assert.deepEqual(app.calls, ['getDataRange', 'getValues']);
  assert.deepEqual(result.rows, [['営業開始', '09:00', '']]);
  assert.equal(result.head.length, FALLBACK.length);
});

test('要求ごとに新しい値・使用範囲・競合印を取得し、前の結果をキャッシュしない', () => {
  const app = fixture([['項目', '内容'], ['営業開始', '09:00']]);
  const first = app.read();
  app.replace([['項目', '内容', '独自列'], ['営業開始', '11:00', '残す']]);
  const second = app.read();
  assert.deepEqual(second.rows, [['営業開始', '11:00', '残す']]);
  assert.notEqual(second.stamp, first.stamp);
  app.replace([]);
  assert.equal(app.read().stamp, '0');
});

for (const native of [true, false]) {
  test(`${native ? 'native' : 'fallback'}：日付セルと同じISO文字列を別の競合印にし、同じ日時の再取得は維持する`, () => {
    const date = new Date('2030-01-04T15:00:00Z');
    const app = fixture([['項目', '内容'], ['日時', date]], native);
    const first = app.read();
    app.replace([['項目', '内容'], ['日時', new Date(date.getTime())]]);
    assert.equal(app.read().stamp, first.stamp);
    app.replace([['項目', '内容'], ['日時', date.toISOString()]]);
    assert.notEqual(app.read().stamp, first.stamp);
    app.replace([['項目', '内容'], ['日時', new Date(date.getTime() + 1)]]);
    assert.notEqual(app.read().stamp, first.stamp);
  });

  test(`${native ? 'native' : 'fallback'}：通常の文字・数値・真偽値の競合印は以前の印と同じにする`, () => {
    const cells = [['項目', '内容'], ['空欄', ''], ['営業開始', '09:00'],
      ['料金', 4000], ['表示', true], ['表示なし', false], ['文字', '["date","1893778800000"]']];
    const app = fixture(cells, native);
    const legacy = createHash('md5').update(JSON.stringify(cells)).digest('hex').slice(0, 12);
    assert.equal(app.read().stamp, legacy);
  });
}

for (const [label, value] of [['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
  ['undefined', undefined], ['不正な日付', new Date(NaN)]]) {
  test(`JSONではnullになる${label}を本物のnullと同じ印にしない`, () => {
    const app = fixture();
    assert.notEqual(app.context.stampValues_([['項目', '内容'], ['値', value]]),
      app.context.stampValues_([['項目', '内容'], ['値', null]]));
  });
}

test('使用範囲の読込が失敗したら旧結果や空一覧に置き換えずロックを解放する', () => {
  const app = fixture([['項目', '内容'], ['営業開始', '09:00']]);
  app.read();
  app.fail();
  assert.throws(() => app.read(), /架空のシート読込失敗/);
  assert.equal(app.held(), false);
});

test('通知の照合も見出しと全予約を一度に取得し、取消・変更・番号重複を取り落とさない', () => {
  const app = fixture();
  const headers = Array.from(vm.runInContext('HEADERS', app.context));
  const values = headers.map(header => ({ 予約番号: 'LM-NATIVE', 来店日: '2030-01-05', 開始: '10:00', 終了: '11:00',
    '所要(分)': 60, 指名料: 0, 合計金額: 4000, 電話番号: '00000000000', 状態: '予約確定' })[header] ?? '');
  const record = { id: '架空配送ID', signature: app.context.bookingEmailSignature_(values, headers), job: { code: 'LMNATIVE' } };
  app.context.readBookingEmailJobs_ = () => [record];
  const read = () => app.context.withLedgerLock_(() => app.context.currentBookingEmailJobs_(app.sheet, {}));
  app.replace([headers, values]);
  assert.equal(read().LMNATIVE.id, record.id);
  assert.deepEqual(app.calls, ['getDataRange', 'getValues']);
  const changed = Array.from(values);
  changed[headers.indexOf('状態')] = 'キャンセル';
  app.replace([headers, changed]);
  assert.deepEqual(Object.keys(read()), []);
  app.replace([headers, values, values]);
  assert.throws(read, /メール配送の記録/);
  assert.equal(app.held(), false);
});
