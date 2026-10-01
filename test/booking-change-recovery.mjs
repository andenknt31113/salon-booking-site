import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const ORIGINAL = ['2030-01-02', '10:00', '11:00'];
const CHANGED = ['2030-01-03', '14:00', '15:00'];
const WINDOW_HEADERS = ['来店日', '開始', '終了'];

function environment({ separated = false, failWrite = 0, partial = false,
  failFlush = false, failRestore = false, discardWrite = false, failJournal = false, coerceDates = false } = {}) {
  const properties = new Map();
  const effects = [];
  const writes = [];
  let failed = false;
  let flushes = 0;
  let held = false;
  let broken = true;
  let cells;
  let headers;
  const context = vm.createContext({ Date, console: { warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty(key, value) {
        if (failJournal && broken) throw new Error('記録サービスの試験障害');
        properties.set(key, value);
      },
      deleteProperty: key => properties.delete(key)
    }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }),
      flush() {
        flushes++;
        if (failFlush && flushes === 1) { failed = true; throw new Error('反映確定の試験障害'); }
      } },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; }
    }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    Utilities: { formatDate: date => new Date(date).toISOString().slice(0, 10) }
  });
  vm.runInContext(source, context);
  headers = Array.from(vm.runInContext('HEADERS', context));
  if (separated) {
    headers.splice(headers.indexOf('開始'), 0, '独自列1');
    headers.splice(headers.indexOf('終了'), 0, '独自列2');
  }
  const booking = { 予約番号: 'LM-REC01', 来店日: ORIGINAL[0], 開始: ORIGINAL[1], 終了: ORIGINAL[2],
    '所要(分)': 60, メニュー: '試験用カット', 担当: '試験担当', 担当ID: 'st01',
    お名前: '架空のお客様', 電話番号: '00000000000', 状態: '予約確定',
    独自列1: '=1+1', 独自列2: 'そのまま残す', 施術メモ: '前回の申し送り' };
  cells = [headers, headers.map(header => booking[header] ?? '')];
  const sheet = {
    getParent: () => ({ getSheetByName: () => null }),
    getLastRow: () => cells.length,
    getLastColumn: () => headers.length,
    getRange(row, column, height = 1, width = 1) {
      const raw = () => Array.from({ length: height }, (_unused, offset) =>
        Array.from({ length: width }, (_cell, index) => cells[row - 1 + offset]?.[column - 1 + index] ?? ''));
      const write = values => {
        assert.equal(held, true, '保存と復旧は同じロック内');
        writes.push({ column, width });
        const shouldFail = broken && (writes.length === failWrite || (failed && failRestore));
        if (!discardWrite && (!shouldFail || partial)) {
          values.forEach((line, offset) => line.forEach((value, index) => {
            if (!shouldFail || index === 0) {
              cells[row - 1 + offset][column - 1 + index] = coerceDates && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
                ? new Date(value + 'T12:00:00Z') : value;
            }
          }));
        }
        if (shouldFail) { failed = true; throw new Error('台帳保存の試験障害'); }
      };
      return {
        getValues: () => raw().map(line => line.map(value => value === '="10:00"' ? '10:00'
          : typeof value === 'string' && value.startsWith('=') ? 2 : value)),
        getFormulas: () => raw().map(line => line.map(value => typeof value === 'string' && value.startsWith('=') ? value : '')),
        setValue: value => write([[value]]), setValues: write
      };
    }
  };
  context.getSheet_ = () => sheet;
  context.todayKey_ = () => '2030-01-01';
  context.nowMinJst_ = () => 9 * 60;
  context.isAdmin_ = request => request.testAdmin === true;
  context.requireAdmin_ = request => assert.equal(request.testAdmin, true);
  context.addToCalendar_ = () => { effects.push('カレンダー'); return ''; };
  context.mailCustomer_ = () => { effects.push('お客様通知'); return '送信処理受付'; };
  context.notify_ = () => { effects.push('店舗通知'); return '送信処理受付'; };
  context.notifyLine_ = () => effects.push('LINE通知');
  context.recordMailStatus_ = () => {};
  const send = payload => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(payload) } }));
  const request = { type: 'change', code: booking.予約番号, tel: booking.電話番号,
    date: CHANGED[0], time: CHANGED[1], fromDate: ORIGINAL[0], fromTime: ORIGINAL[1] };
  return { context, properties, cells, headers, writes, effects, send,
    change: overrides => send({ ...request, ...overrides }),
    interval: () => WINDOW_HEADERS.map(header => cells[1][headers.indexOf(header)]),
    recover: () => { broken = false; }, held: () => held };
}

test('通常の3列は一度に保存し、反映確認後にだけ通知する', () => {
  const app = environment();
  assert.equal(app.change().ok, true);
  assert.deepEqual(app.interval(), CHANGED);
  assert.deepEqual(app.writes, [{ column: app.headers.indexOf('来店日') + 1, width: 3 }]);
  assert.deepEqual(app.effects, ['お客様通知', 'LINE通知', '店舗通知']);
  assert.equal(app.properties.size, 0);
  assert.equal(app.held(), false);
});

for (const failWrite of [1, 2, 3]) {
  test(`独自列を挟む${failWrite}回目の保存失敗で日時を全部戻し、他の予約と重ねない`, () => {
    const app = environment({ separated: true, failWrite });
    const second = app.cells[1].slice();
    second[app.headers.indexOf('予約番号')] = 'LM-REC02';
    second[app.headers.indexOf('来店日')] = CHANGED[0];
    app.cells.push(second);
    const before = structuredClone(app.cells);
    const response = app.change();
    assert.equal(response.ok, false);
    assert.equal(response.restored, true);
    assert.match(response.error, /元の日時に戻/);
    assert.deepEqual(app.cells, before);
    assert.deepEqual(app.effects, []);
    assert.equal(app.properties.size, 0);
    assert.equal(app.held(), false);
    assert.ok(app.writes.every(write => !['独自列1', '独自列2'].includes(app.headers[write.column - 1])));
  });
}

for (const options of [{ failWrite: 1, partial: true }, { failFlush: true }, { discardWrite: true }]) {
  test(`一括書込の部分反映・確定失敗・反映漏れでも成功と案内しない：${JSON.stringify(options)}`, () => {
    const app = environment(options);
    const response = app.change();
    assert.equal(response.ok, false);
    assert.equal(response.restored, true);
    assert.deepEqual(app.interval(), ORIGINAL);
    assert.deepEqual(app.effects, []);
  });
}

test('復旧不能なら次の処理を止め、障害が解消してから元の日時を確認して再開する', () => {
  const app = environment({ failWrite: 1, partial: true, failRestore: true });
  const response = app.change();
  assert.equal(response.ok, false);
  assert.equal(response.unknown, true);
  assert.match(response.error, /復旧.*確認できません/);
  assert.ok(app.properties.size > 0, '未確認の復旧記録を消さない');
  let operations = 0;
  app.context.doReserve_ = () => { operations++; return { ok: true }; };
  app.context.doAvailability_ = () => { operations++; return { ok: true }; };
  for (const type of ['reserve', 'availability']) assert.equal(app.send({ type }).ok, false);
  assert.equal(operations, 0, '未確認の台帳を使って受付・空席の成功を返さない');
  assert.deepEqual(app.effects, []);
  app.recover();
  assert.equal(app.send({ type: 'availability' }).ok, true);
  assert.deepEqual(app.interval(), ORIGINAL);
  assert.equal(app.properties.size, 0);
  assert.equal(operations, 1);
});

test('復旧記録を保存できない場合は、台帳を書き換えない', () => {
  const app = environment({ failJournal: true });
  assert.equal(app.change().ok, false);
  assert.deepEqual(app.interval(), ORIGINAL);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.effects, []);
});

test('Google認証後の管理日時変更も同じ復旧経路を使う', () => {
  const app = environment({ separated: true, failWrite: 2 });
  const result = app.change({ type: 'adminChange', testAdmin: true });
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.deepEqual(app.interval(), ORIGINAL);
  assert.deepEqual(app.effects, []);
});

test('日時変更を再送しても保存と通知を繰り返さない', () => {
  const app = environment();
  assert.equal(app.change().ok, true);
  const repeated = app.change();
  assert.equal(repeated.ok, true);
  assert.equal(repeated.unchanged, true);
  assert.equal(app.writes.length, 1);
  assert.equal(app.effects.length, 3);
});

test('復旧待ちの状態でも、認証前の管理要求から台帳の復旧を実行しない', () => {
  const app = environment({ failWrite: 1, partial: true, failRestore: true });
  assert.equal(app.change().unknown, true);
  const count = app.writes.length;
  app.recover();
  assert.equal(app.send({ type: 'adminData' }).ok, false);
  assert.equal(app.writes.length, count, '認証されていない操作は台帳を読み書きしない');
  assert.ok(app.properties.size > 0);
});

test('復旧待ちの記録を次の実行へ引き継いでも、元の予約に戻してから処理する', () => {
  const first = environment({ failWrite: 1, partial: true, failRestore: true });
  assert.equal(first.change().unknown, true);
  const next = environment();
  first.properties.forEach((value, key) => next.properties.set(key, value));
  next.cells[1].splice(0, next.headers.length, ...first.cells[1]);
  next.context.doAvailability_ = () => {
    assert.deepEqual(next.interval(), ORIGINAL, '新しい実行は混在した日時を空席に使わない');
    return { ok: true };
  };
  assert.equal(next.send({ type: 'availability' }).ok, true);
  assert.equal(next.properties.size, 0);
});

test('元の日時が日付セル・数式でも、文字列へ勝手に変えず復旧する', () => {
  const app = environment({ separated: true, failWrite: 3 });
  app.cells[1][app.headers.indexOf('来店日')] = new Date('2030-01-02T00:00:00Z');
  app.cells[1][app.headers.indexOf('開始')] = '="10:00"';
  const before = structuredClone(app.cells);
  assert.equal(app.change().restored, true);
  assert.deepEqual(app.cells, before);
});

test('復旧待ちの予約を使って前日通知を送らない', () => {
  const app = environment({ failWrite: 1, partial: true, failRestore: true });
  assert.equal(app.change().unknown, true);
  assert.throws(() => app.context.sendReminders(), /復旧.*確認できません/);
  assert.deepEqual(app.effects, []);
});

test('シートの既存書式で日付セルとして読み直されても、正しい日時の保存を確認できる', () => {
  const app = environment({ coerceDates: true });
  assert.equal(app.change().ok, true);
  const saved = app.interval();
  assert.equal(app.context.normalizeDate_(saved[0]), CHANGED[0]);
  assert.deepEqual(saved.slice(1), CHANGED.slice(1));
  assert.equal(app.properties.size, 0);
});

test('復旧する予約番号が重複したら別の予約へ勝手に書かず、受付を止める', () => {
  const app = environment({ failWrite: 1, partial: true, failRestore: true });
  assert.equal(app.change().unknown, true);
  app.cells.push(app.cells[1].slice());
  app.recover();
  const count = app.writes.length;
  assert.equal(app.send({ type: 'availability' }).unknown, true);
  assert.equal(app.writes.length, count);
  assert.ok(app.properties.size > 0);
});
