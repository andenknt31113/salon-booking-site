import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const BOOKING = { 予約番号: 'LM-LOOKUP', 来店日: '2030-01-05', 開始: '10:00', 終了: '11:00',
  '所要(分)': 60, 状態: '予約確定', お名前: '照会試験のお客様', 電話番号: "'090-0000-0000",
  メニュー: '照会試験メニュー', 担当: '試験担当', 合計金額: 4000, メール: 'private@example.test',
  施術メモ: '店だけが見るメモ', ご要望: '非公開のご要望', 店舗メール状態: '配送待ち' };

function fixture({ records = [BOOKING], headers: initialHeaders, afterRead, failAt = 0,
  missing = false, empty = false, unavailable = false, occupied = false } = {}) {
  let held = false;
  let cells;
  const reads = [];
  const writes = [];
  const accesses = [];
  const context = vm.createContext({ Date, console: { error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) }
  });
  vm.runInContext(SOURCE, context);
  const canonical = Array.from(vm.runInContext('HEADERS', context));
  const setRecords = (nextRecords, headers = initialHeaders || canonical) => {
    cells = [Array.from(headers), ...nextRecords.map(record => headers.map(header => record[header] ?? ''))];
  };
  setRecords(records);
  if (empty || missing) cells = [];
  const before = structuredClone(cells);
  const sheet = {
    getLastRow: () => cells.length,
    getLastColumn: () => Math.max(0, ...cells.map(row => row.length)),
    getDataRange() { assert.fail('照会で全履歴の全列を取得しない'); },
    getRange(row, column, numRows = 1, numColumns = 1) {
      const range = { getValues() {
        assert.equal(held, true, '本人確認に使う値は予約ロック内で読む');
        assert.ok(numRows === 1 || numColumns === 1, '全件では予約番号の列だけを読む');
        reads.push({ row, column, numRows, numColumns });
        if (reads.length === failAt) throw new Error('試験用の照会読込失敗');
        const values = Array.from({ length: numRows }, (_unused, rowIndex) =>
          Array.from({ length: numColumns }, (_value, columnIndex) =>
            cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
        afterRead?.(reads.length, setRecords, canonical);
        return values;
      }, setValues(values) {
        assert.equal(held, true);
        writes.push('setValues');
        values.forEach((valuesRow, rowIndex) => valuesRow.forEach((value, columnIndex) => {
          cells[row - 1 + rowIndex] ||= [];
          cells[row - 1 + rowIndex][column - 1 + columnIndex] = value;
        }));
        return range;
      }, setFontWeight() { writes.push('setFontWeight'); return range; },
      setBackground() { writes.push('setBackground'); return range; } };
      return range;
    },
    appendRow(values) { writes.push('appendRow'); cells.push(Array.from(values)); },
    setFrozenRows() { writes.push('setFrozenRows'); },
    setColumnWidth() { writes.push('setColumnWidth'); }
  };
  let exists = !missing;
  const spreadsheet = {
    getSheetByName(name) {
      assert.equal(held, true);
      assert.equal(name, '予約一覧');
      accesses.push('sheet');
      if (unavailable) throw new Error('試験用の台帳取得失敗');
      return exists ? sheet : null;
    },
    insertSheet(name) { assert.equal(name, '予約一覧'); writes.push('insertSheet'); exists = true; return sheet; }
  };
  context.SpreadsheetApp = { getActiveSpreadsheet() { accesses.push('spreadsheet'); return spreadsheet; } };
  if (occupied) context.LockService.getScriptLock = () => ({
    waitLock() { throw new Error('試験用のロック待機失敗'); },
    releaseLock() { assert.fail('未取得のロックを解放しない'); }
  });
  return { reads, writes, accesses, before, cells: () => structuredClone(cells),
    replaceHeaders: headers => { cells[0] = Array.from(headers); }, held: () => held, setRecords, canonical,
    send: (changes = {}) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
      type: 'lookup', code: BOOKING.予約番号, tel: '09000000000', ...changes }) } })) };
}

test('照会は番号の列と対象1行だけを取得し、見出しの再照合を含め4回で完了する', () => {
  const app = fixture();
  const result = app.send();
  assert.equal(result.ok, true);
  assert.deepEqual(result.reservation, { code: BOOKING.予約番号, date: BOOKING.来店日,
    time: BOOKING.開始, endTime: BOOKING.終了, totalMinutes: 60, menuText: BOOKING.メニュー,
    staffName: BOOKING.担当, totalPrice: 4000, name: BOOKING.お名前, status: BOOKING.状態 });
  assert.equal(app.reads.length, 4);
  assert.deepEqual(app.reads.map(read => read.numRows), [1, 1, 1, 1]);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.cells(), app.before);
  assert.equal(app.held(), false);
});

test('履歴1万件でも全列を読まず、末尾の予約と全件の番号重複を調べる', () => {
  const history = Array.from({ length: 10000 }, (_unused, index) => ({ ...BOOKING,
    予約番号: `LM-HISTORY${index}`, 施術メモ: '長い非公開メモ'.repeat(100) }));
  const app = fixture({ records: [...history, BOOKING] });
  assert.equal(app.send().ok, true);
  assert.equal(app.reads.length, 4);
  assert.equal(app.reads[1].numRows, 10001);
  assert.equal(app.reads[1].numColumns, 1);
  assert.equal(app.reads[2].row, 10002);
  assert.equal(app.reads.reduce((total, read) => total + read.numRows * read.numColumns, 0),
    10001 + 3 * app.canonical.length);
});

for (const [code, tel] of [['ｌｍ－ｌｏｏｋｕｐ', '０９０－００００－００００'],
  ['lm lookup', '(090) 0000-0000'], ["'LM-LOOKUP", "'090-0000-0000"]]) {
  test(`番号と電話の表記揺れを維持する：${code}`, () => {
    const app = fixture();
    assert.equal(app.send({ code, tel }).reservation.name, BOOKING.お名前);
  });
}

for (const changes of [{ code: '' }, { code: '---' }, { tel: '' }, { tel: '---' }]) {
  test(`無効な本人確認は台帳を読まず同じ案内で拒否する：${JSON.stringify(changes)}`, () => {
    const app = fixture();
    assert.deepEqual(app.send(changes), { ok: false, error: 'ご予約が見つかりませんでした。' });
    assert.equal(app.reads.length, 0);
    assert.deepEqual(app.accesses, []);
    assert.deepEqual(app.writes, []);
    assert.equal(app.held(), false);
  });
}

test('電話違い・番号なし・重複番号では顧客情報を返さない', () => {
  for (const changes of [{ tel: '09099999999' }, { code: 'LM-MISSING' }]) {
    const app = fixture();
    assert.equal(app.send(changes).ok, false);
    assert.equal(app.send(changes).reservation, undefined);
  }
  const app = fixture({ records: [BOOKING, { ...BOOKING, 予約番号: 'ＬＭ－ｌｏｏｋｕｐ' }] });
  const result = app.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /重複/);
  assert.equal(result.reservation, undefined);
});

test('正常な列の並べ替えと独自列を保持する', () => {
  const app = fixture();
  app.setRecords([BOOKING], ['独自列', ...app.canonical.slice().reverse()]);
  assert.equal(app.send().reservation.name, BOOKING.お名前);
  assert.equal(app.send().reservation.date, BOOKING.来店日);
});

for (const changedAt of [1, 2, 3]) {
  test(`照会の読込${changedAt}回目の直後に列が変わったら混ざった結果を返さない`, () => {
    const app = fixture({ afterRead(count, setRecords, canonical) {
      if (count === changedAt) {
        const headers = canonical.slice();
        const first = headers.indexOf('来店日');
        const second = headers.indexOf('開始');
        [headers[first], headers[second]] = [headers[second], headers[first]];
        setRecords([BOOKING], headers);
      }
    } });
    const result = app.send();
    assert.equal(result.ok, false);
    assert.equal(result.reservation, undefined);
    assert.equal(app.held(), false);
  });
}

test('番号検索後に行が変わった場合も本人の予約と誤認しない', () => {
  const app = fixture({ afterRead(count, setRecords) {
    if (count === 2) setRecords([{ ...BOOKING, 予約番号: 'LM-OTHER' }]);
  } });
  assert.deepEqual(app.send(), { ok: false, error: 'ご予約が見つかりませんでした。' });
});

for (const failAt of [1, 2, 3, 4]) {
  test(`照会の読込${failAt}回目の失敗を成功や取消済みとせずロックを解放する`, () => {
    const app = fixture({ failAt });
    const result = app.send();
    assert.equal(result.ok, false);
    assert.equal(result.reservation, undefined);
    assert.equal(app.held(), false);
  });
}

test('次の照会では最新の予約と取消を読み直し、メモ・メール・通知状態を公開しない', () => {
  const app = fixture();
  assert.equal(app.send().reservation.time, '10:00');
  app.setRecords([{ ...BOOKING, 開始: '14:00', 状態: 'キャンセル済み' }]);
  const result = app.send();
  assert.equal(result.reservation.time, '14:00');
  assert.equal(result.reservation.status, 'キャンセル');
  for (const privateValue of [BOOKING.メール, BOOKING.施術メモ, BOOKING.ご要望, BOOKING.店舗メール状態]) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
  assert.equal(app.reads.length, 8);
});

test('旧台帳の任意列を照会で足さず、同じ予約を返す', () => {
  const headers = fixture().canonical.slice(0, 20);
  const app = fixture({ headers });
  const result = app.send();
  assert.equal(result.ok, true);
  assert.equal(result.reservation.name, BOOKING.お名前);
  assert.equal(result.reservation.menuText, BOOKING.メニュー);
  assert.equal(app.reads.length, 4);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.cells(), app.before);
});

test('台帳が消えている時は作り直さず、見つからない予約と区別する', () => {
  const app = fixture({ missing: true });
  const result = app.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /予約台帳.*確認できません/);
  assert.equal(result.reservation, undefined);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.cells(), []);
  assert.equal(app.held(), false);
});

test('空の台帳・見出しだけの台帳は読取で初期化しない', () => {
  for (const options of [{ empty: true }, { records: [] }]) {
    const app = fixture(options);
    assert.deepEqual(app.send(), { ok: false, error: 'ご予約が見つかりませんでした。' });
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.cells(), app.before);
    assert.equal(app.held(), false);
  }
});

for (const missingHeader of ['予約番号', '来店日', '開始', '電話番号']) {
  test(`照会の${missingHeader}が不明でも、列を補完したり別の列を使って本人確認しない`, () => {
    const headers = fixture().canonical.map(header => header === missingHeader ? '独自の値' : header);
    const app = fixture({ headers, records: [{ ...BOOKING, 独自の値: BOOKING[missingHeader] }] });
    const result = app.send();
    assert.equal(result.ok, false);
    assert.match(result.error, /予約台帳.*見出し/);
    assert.equal(result.reservation, undefined);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.cells(), app.before);
    assert.equal(app.held(), false);
  });
}

for (const shape of ['blank', 'duplicate']) {
  test(`不明な${shape}見出しで正常な予約情報を返さず、台帳を変更しない`, () => {
    const app = fixture();
    app.replaceHeaders(shape === 'blank' ? app.canonical.map(() => '')
      : app.canonical.map(header => header === '施術メモ' ? '電話番号' : header));
    const before = app.cells();
    const result = app.send();
    assert.equal(result.ok, false);
    assert.match(result.error, /予約台帳.*見出し/);
    assert.equal(result.reservation, undefined);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.cells(), before);
    assert.equal(app.held(), false);
  });
}

test('欠けた公開項目を独自の非公開列で代用せず、空欄で返す', () => {
  const app = fixture();
  app.setRecords([{ ...BOOKING, 店内専用: '公開しない値' }],
    app.canonical.map(header => header === 'メニュー' ? '店内専用' : header));
  const before = app.cells();
  const result = app.send();
  assert.equal(result.ok, true);
  assert.equal(result.reservation.menuText, '');
  assert.equal(JSON.stringify(result).includes('公開しない値'), false);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.cells(), before);
});

test('台帳取得やロック待機の失敗では作り直し・成功表示・未取得ロックの解放をしない', () => {
  for (const options of [{ unavailable: true }, { occupied: true }]) {
    const app = fixture(options);
    const result = app.send();
    assert.equal(result.ok, false);
    assert.equal(result.reservation, undefined);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.cells(), app.before);
    assert.equal(app.held(), false);
    if (options.occupied) assert.deepEqual(app.accesses, []);
  }
});
