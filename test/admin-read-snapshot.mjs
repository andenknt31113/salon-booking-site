import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const DATA_SOURCE = readFileSync(new URL('../assets/js/admin-data.js', import.meta.url), 'utf8');
const BOOKINGS = [
  { 予約番号: 'LM-SNAPSHOT', 来店日: '2030-01-05', 開始: '10:00', 終了: '11:00',
    '所要(分)': 60, お名前: '架空 読取試験', 電話番号: "'00000000000", メール: 'customer@example.test',
    状態: '予約確定', 施術メモ: '保持するメモ', 合計金額: 4000, メニュー: '試験カット', 担当ID: 'st01' },
  { 予約番号: 'LM-HISTORY', 来店日: '2020-01-05', 開始: '12:00', 終了: '13:00',
    お名前: '架空 過去試験', 状態: 'キャンセル済み' }
];

function digest(values) {
  return createHash('md5').update(JSON.stringify(values)).digest('hex').slice(0, 12);
}

function fixture({ failure = '', afterRead, denied = false, repairBookings = false, headerFault = '' } = {}) {
  let held = false;
  const reads = [];
  const writes = [];
  const sheets = new Map();
  const spreadsheet = { getSheetByName: name => sheets.get(name) || null,
    insertSheet(name) {
      assert.ok(repairBookings && name === '予約一覧' && held);
      const sheet = add(name, []);
      sheet.cells.length = 0;
      writes.push({ name, operation: 'insert' });
      return sheet;
    } };
  const context = vm.createContext({ Date,
    console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'ADMIN_GOOGLE_ONLY' ? 'true' : null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    Utilities: { DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => Array.from(createHash('md5').update(value).digest()),
      formatDate: (value, _zone, format) => {
        const date = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000);
        return format === 'HH:mm' ? date.toISOString().slice(11, 16) : date.toISOString().slice(0, 10);
      } }
  });
  vm.runInContext(SOURCE, context);
  context.verifyGoogleAdmin_ = () => { if (denied) throw new Error('架空の権限拒否'); };
  const constants = name => Array.from(vm.runInContext(name, context));
  function add(name, headers, records = []) {
    const cells = [Array.from(headers), ...records.map(record => Array.isArray(record)
      ? Array.from(record) : headers.map(header => record[header.trim()] ?? ''))];
    const width = () => Math.max(0, ...cells.map(line => line.reduce((last, value, index) =>
      value !== '' && value != null ? index + 1 : last, 0)));
    const range = (row, column, height = 1, columns = 1) => ({
      getValues() {
        assert.equal(held, true, '管理の台帳読込は本人確認後の共通ロック内');
        reads.push({ name, row, column, height, columns });
        if (failure === name) throw new Error('架空の読込失敗');
        const values = Array.from({ length: height }, (_unused, rowIndex) =>
          Array.from({ length: columns }, (_cell, columnIndex) => cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
        afterRead?.({ name, row, height, cells, values, count: reads.filter(read => read.name === name).length });
        return values;
      },
      setValues(values) {
        assert.ok(repairBookings && name === '予約一覧' && held && row === 1,
          '補完を明示した架空台帳の見出し以外には書かない');
        writes.push({ name, operation: 'headers', column, values: structuredClone(values) });
        if (headerFault === 'discard') return this;
        if (headerFault === 'partial') values = values.map(line => line.slice(0, 1));
        values.forEach((line, rowIndex) => line.forEach((value, columnIndex) => {
          cells[row - 1 + rowIndex] ||= [];
          cells[row - 1 + rowIndex][column - 1 + columnIndex] = value;
        }));
        return this;
      },
      setFontWeight() { return this; }, setBackground() { return this; }
    });
    const sheet = { cells, getParent: () => spreadsheet, getLastRow: () => cells.length,
      getLastColumn: width, getRange: range,
      getDataRange: () => range(1, 1, cells.length, width()),
      appendRow(values) {
        assert.ok(repairBookings && name === '予約一覧' && held && cells.length === 0,
          '初期化する架空台帳へ見出しだけを書く');
        writes.push({ name, operation: 'headers', column: 1, values: [Array.from(values)] });
        if (headerFault === 'discard') return;
        cells.push(Array.from(values));
      }, setFrozenRows() {}, setColumnWidth() {} };
    sheets.set(name, sheet);
    return sheet;
  }
  add('予約一覧', constants('HEADERS'), BOOKINGS);
  add('メニュー', constants('MENU_HEADERS'), [{ 区分: 'カット', メニュー名: '試験カット', 価格: '4000〜', '所要(分)': 60, 表示: '○' }]);
  add('おすすめメニュー', constants('COUPON_HEADERS'), [{ メニュー名: '試験コース', 価格: 6900, '所要(分)': 90 }]);
  add('スタイル', constants('STYLE_HEADERS'), [{ タイトル: '試験スタイル', 分類: 'ショート', 画像: 'assets/style1.jpg' }]);
  add('口コミ', constants('REVIEW_HEADERS'), [{ 投稿日: '2030-01-01', 予約番号: 'LM-SNAPSHOT', 本文: '試験の本文', 状態: '非掲載' }]);
  add('休業日', constants('CLOSED_HEADERS'), [{ 休業日: '2030-01-06', 開始: '14:00', 終了: '16:00', メモ: '試験休業' }]);
  add('設定', ['項目', '内容'], constants('LISTED_SETTINGS').map(row => [row[0], row[1]])
    .concat([['独自設定', '保持する値']]));
  const send = (payload = {}) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
    type: 'googleAdmin', action: 'adminData', payload
  }) } }));
  return { context, sheets, reads, writes, send, held: () => held,
    count: name => reads.filter(read => read.name === name).length,
    fullReads: name => reads.filter(read => read.name === name && read.row === 1 && read.height > 1).length };
}

test('初回管理取得は編集対象五シートと設定を各一回読み、同じ値から表示と更新印を作る', () => {
  const app = fixture();
  const result = app.send();
  assert.equal(result.ok, true);
  assert.equal(vm.runInNewContext(DATA_SOURCE + '\nAdminData.validStartup(result)', { result }), true);
  for (const name of ['メニュー', 'おすすめメニュー', 'スタイル', '口コミ', '休業日']) {
    assert.equal(app.count(name), 1, `${name}は表示と更新印のために取り直さない`);
  }
  assert.equal(app.count('設定'), 1);
  assert.equal(app.count('予約一覧'), 1, '完成した見出しの検査と全行の表示を一回の取得から作る');
  assert.equal(app.reads.length, 7);
  assert.equal(result.reservations.length, 2, '過去の予約・取消を省略しない');
  assert.equal(result.reservations[0].note, '保持するメモ');
  assert.equal(result.reservations[0].email, 'customer@example.test');
  assert.equal(result.settings.独自設定, '保持する値');
  assert.deepEqual(Object.keys(result.stamps).sort(), ['closed', 'coupons', 'menus', 'reviews', 'settings', 'styles']);
  assert.equal(app.held(), false);
});

test('起動用の取得は写真と口コミを読まず、予約全履歴と日常管理の内容を省略しない', () => {
  const full = fixture().send();
  const app = fixture();
  const result = app.send({ startupOnly: true });
  assert.equal(result.ok, true);
  assert.equal(vm.runInNewContext(DATA_SOURCE + '\nAdminData.validStartup(result)', { result }), true);
  assert.deepEqual(result.pendingEditors, ['styles', 'reviews']);
  for (const key of ['reservations', 'closedDates', 'menus', 'coupons', 'settings', 'capabilities']) {
    assert.deepEqual(result[key], full[key], key);
  }
  assert.equal(Object.hasOwn(result, 'styles'), false);
  assert.equal(Object.hasOwn(result, 'reviews'), false);
  assert.equal(app.count('スタイル'), 0);
  assert.equal(app.count('口コミ'), 0);
  assert.equal(app.reads.length, 5);
  assert.deepEqual(Object.keys(result.stamps).sort(), ['closed', 'coupons', 'menus', 'settings']);
  assert.equal(app.held(), false);
});

for (const payload of [{}, { startupOnly: true, briefPast: true }]) {
  test(`完成した台帳は独自列・列順・空白見出しを保持して一回だけ読む：${JSON.stringify(payload)}`, () => {
    const app = fixture();
    const cells = app.sheets.get('予約一覧').cells;
    cells.forEach((row, index) => {
      row.push(index ? '残す独自の値' : '独自列');
      row.reverse();
    });
    cells[0] = cells[0].map(header => ' ' + header + ' ');
    const before = structuredClone(cells);
    const result = app.send(payload);
    assert.equal(result.ok, true);
    assert.equal(app.count('予約一覧'), 1);
    assert.equal(result.reservations.length, BOOKINGS.length);
    const reservation = result.reservations.find(row => row.code === 'LM-SNAPSHOT');
    assert.equal(reservation.tel, '00000000000');
    assert.equal(reservation.price, 4000);
    assert.equal(reservation.note, '保持するメモ');
    assert.deepEqual(cells, before);
    assert.deepEqual(app.writes, []);
  });

  test(`足りない任意列は右端へ補完して再取得し、既存の予約・独自列を動かさない：${JSON.stringify(payload)}`, () => {
    const app = fixture({ repairBookings: true });
    const cells = app.sheets.get('予約一覧').cells;
    const noteColumn = cells[0].indexOf('施術メモ');
    cells.forEach((row, index) => {
      row.splice(noteColumn, 1);
      row.push(index ? '保持する独自の値' : '独自列');
    });
    const before = structuredClone(cells);
    const result = app.send(payload);
    assert.equal(result.ok, true);
    assert.equal(cells[0].at(-1), '施術メモ');
    assert.deepEqual(cells.map(row => row.slice(0, before[0].length)), before);
    assert.equal(result.reservations.length, BOOKINGS.length);
    const reservation = result.reservations.find(row => row.code === 'LM-SNAPSHOT');
    assert.equal(reservation.tel, '00000000000');
    assert.equal(reservation.email, 'customer@example.test');
    assert.equal(reservation.note, '');
    assert.deepEqual(app.writes, [{ name: '予約一覧', operation: 'headers',
      column: before[0].length + 1, values: [['施術メモ']] }]);
    assert.equal(app.held(), false);
  });
}

for (const state of ['未作成', '空シート', '見出しだけ']) {
  test(`起動時は未準備の台帳を拒否し、準備済みの空一覧は表示する：${state}`, () => {
    const app = fixture({ repairBookings: true });
    if (state === '未作成') app.sheets.delete('予約一覧');
    else app.sheets.get('予約一覧').cells.length = state === '空シート' ? 0 : 1;
    const result = app.send({ startupOnly: true, briefPast: true });
    if (state === '見出しだけ') {
      assert.equal(result.ok, true);
      assert.deepEqual(result.reservations, []);
      assert.deepEqual(app.sheets.get('予約一覧').cells, [Array.from(vm.runInContext('HEADERS', app.context))]);
    } else {
      assert.equal(result.ok, false);
      assert.match(result.error, /予約台帳.*確認できません/);
      assert.equal(Object.hasOwn(result, 'reservations'), false);
      assert.deepEqual(app.sheets.get('予約一覧')?.cells, state === '未作成' ? undefined : []);
      assert.deepEqual(app.reads, []);
    }
    assert.deepEqual(app.writes, []);
    assert.equal(app.held(), false);
  });
}

for (const headerFault of ['discard', 'partial']) {
  test(`任意列の補完が${headerFault}なら初回表示を開始せず、既存の予約行を保持する`, () => {
    const app = fixture({ repairBookings: true, headerFault });
    const cells = app.sheets.get('予約一覧').cells;
    for (const header of ['施術メモ', '電話受付内容']) {
      const column = cells[0].indexOf(header);
      cells.forEach(row => row.splice(column, 1));
    }
    cells.forEach((row, index) => row.push(index ? 'メモへ転用しない独自値' : '独自列'));
    const before = structuredClone(cells);
    const result = app.send({ startupOnly: true, briefPast: true });
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, 'reservations'), false);
    assert.deepEqual(cells.slice(1), before.slice(1));
    assert.deepEqual(cells[0].slice(0, before[0].length), before[0]);
    assert.equal(app.held(), false);
  });
}

test('明示準備で見出しが実保存されなければ、初回取得で成功と返さない', () => {
  const app = fixture({ repairBookings: true, headerFault: 'discard' });
  app.sheets.get('予約一覧').cells.length = 0;
  app.context.withLedgerLock_(() => app.context.getSheet_(null, { initialize: true }));
  assert.equal(app.writes.length, 1);
  const result = app.send({ startupOnly: true, briefPast: true });
  assert.equal(result.ok, false);
  assert.equal(Object.hasOwn(result, 'reservations'), false);
  assert.deepEqual(app.sheets.get('予約一覧').cells, []);
  assert.deepEqual(app.reads, []);
  assert.equal(app.writes.length, 1, '失敗した初期準備を初回取得で再試行しない');
  assert.equal(app.held(), false);
});

test('5,000件の過去・未来・取消を切り捨てず、一回の予約取得から起動する', () => {
  const app = fixture();
  const cells = app.sheets.get('予約一覧').cells;
  const headers = cells[0];
  const originals = cells.slice(1);
  const count = 5000;
  cells.splice(1, cells.length - 1, ...Array.from({ length: count }, (_unused, index) => {
    const row = Array.from(originals[index % originals.length]);
    row[headers.indexOf('予約番号')] = 'LM-SNAPSHOT-' + index;
    return row;
  }));
  const before = structuredClone(cells);
  const result = app.send({ startupOnly: true, briefPast: true });
  assert.equal(result.ok, true);
  assert.equal(result.reservations.length, count);
  assert.equal(new Set(result.reservations.map(row => row.code)).size, count);
  assert.equal(result.reservations.filter(row => row.status === 'キャンセル').length, count / 2);
  assert.equal(app.count('予約一覧'), 1);
  assert.deepEqual(cells, before);
  assert.deepEqual(app.writes, []);
});

test('初回の予約読込失敗は補完・再読込で成功へ置き換えず、入力元へ書かない', () => {
  const app = fixture({ failure: '予約一覧', repairBookings: true });
  assert.equal(app.send({ startupOnly: true, briefPast: true }).ok, false);
  assert.equal(app.count('予約一覧'), 1);
  assert.deepEqual(app.writes, []);
  assert.equal(app.held(), false);
});

test('起動時の権限拒否では初期化・予約読込を一切行わない', () => {
  const app = fixture({ denied: true, repairBookings: true });
  app.sheets.delete('予約一覧');
  assert.equal(app.send({ startupOnly: true, briefPast: true }).ok, false);
  assert.deepEqual(app.reads, []);
  assert.deepEqual(app.writes, []);
});

for (const state of ['必須列の欠落', '必須列の重複', '無名の見出し']) {
  test(`初回でも不正な見出しは空台帳へ置き換えず補完で直したことにしない：${state}`, () => {
    const app = fixture({ repairBookings: true });
    const cells = app.sheets.get('予約一覧').cells;
    if (state === '必須列の欠落') {
      const startColumn = cells[0].indexOf('開始');
      cells.forEach(row => row.splice(startColumn, 1));
    }
    else if (state === '必須列の重複') cells.forEach((row, index) => row.push(index ? row[0] : '予約番号'));
    else cells[0].fill('');
    const before = structuredClone(cells);
    const result = app.send({ startupOnly: true, briefPast: true });
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, 'reservations'), false);
    assert.deepEqual(cells, before);
    assert.deepEqual(app.writes, []);
    assert.equal(app.held(), false);
  });
}

test('初回の見出しと表示は同じsnapshotを使い、次の要求では新しい予約を読む', () => {
  let changed = false;
  const app = fixture({ afterRead({ name, cells }) {
    if (name !== '予約一覧' || changed) return;
    changed = true;
    cells[1][cells[0].indexOf('お名前')] = '次の要求で確認するお名前';
    cells.forEach(row => row.reverse());
  } });
  const first = app.send({ startupOnly: true, briefPast: true });
  assert.equal(first.ok, true);
  assert.equal(first.reservations.find(row => row.code === 'LM-SNAPSHOT').name, BOOKINGS[0].お名前);
  assert.equal(first.reservations.find(row => row.code === 'LM-SNAPSHOT').note, '保持するメモ');
  const second = app.send({ startupOnly: true, briefPast: true });
  assert.equal(second.ok, true);
  assert.equal(second.reservations.find(row => row.code === 'LM-SNAPSHOT').name, '次の要求で確認するお名前');
  assert.equal(second.reservations.find(row => row.code === 'LM-SNAPSHOT').note, '保持するメモ');
  assert.equal(app.count('予約一覧'), 2, '二要求で一回ずつ読み、前の要求の結果を使い回さない');
  assert.deepEqual(app.writes, []);
});

for (const [target, name] of [['styles', 'スタイル'], ['reviews', '口コミ']]) {
  test(`${name}の編集用取得は対象一シートだけを読み、表示と更新印を同じ結果から作る`, () => {
    let changed = false;
    const app = fixture({ afterRead({ name: current, cells }) {
      if (current === name && !changed) { changed = true; cells[1][0] = '次の読込で確認する値'; }
    } });
    const before = structuredClone(app.sheets.get(name).cells);
    const result = app.send({ editorTarget: target });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result).sort(), ['editorTarget', 'ok', 'rows', 'stamp']);
    assert.equal(result.editorTarget, target);
    assert.equal(result.stamp, digest(before));
    assert.equal(Object.values(result.rows[0]).includes('次の読込で確認する値'), false);
    assert.equal(app.reads.length, 1);
    assert.equal(app.count(name), 1);
    assert.equal(app.held(), false);
    const next = app.send({ editorTarget: target });
    assert.equal(Object.values(next.rows[0]).includes('次の読込で確認する値'), true);
    assert.notEqual(next.stamp, result.stamp);
  });

  test(`${name}の空・未作成シートは更新印付きの空配列、読込障害と認証拒否は成功にしない`, () => {
    const empty = fixture();
    empty.sheets.get(name).cells.splice(1);
    assert.deepEqual(empty.send({ editorTarget: target }).rows, []);
    const absent = fixture();
    absent.sheets.delete(name);
    assert.deepEqual(absent.send({ editorTarget: target }), { ok: true, editorTarget: target, rows: [], stamp: '0' });
    const broken = fixture({ failure: name });
    assert.equal(broken.send({ editorTarget: target }).ok, false);
    assert.equal(broken.held(), false);
    const denied = fixture({ denied: true });
    assert.equal(denied.send({ editorTarget: target }).ok, false);
    assert.equal(denied.reads.length, 0);
  });
}

test('編集用取得では未知の対象や他の保存対象を読めず、通常の全件APIも維持する', () => {
  for (const target of ['settings', 'closed', '__proto__', '', null]) {
    const app = fixture();
    assert.equal(app.send({ editorTarget: target }).ok, false);
    assert.equal(app.reads.length, 0);
  }
  const full = fixture().send();
  assert.equal(Object.hasOwn(full, 'pendingEditors'), false);
  assert.equal(full.styles.length, 1);
  assert.equal(full.reviews.length, 1);
});

test('表示データと更新印を同じ読込結果から作り、以前の更新印と互換にする', () => {
  const app = fixture();
  const result = app.send();
  for (const [key, name] of Object.entries({ menus: 'メニュー', coupons: 'おすすめメニュー',
    styles: 'スタイル', reviews: '口コミ', closed: '休業日', settings: '設定' })) {
    assert.equal(result.stamps[key], digest(app.sheets.get(name).cells));
  }
});

test('表示読込後の別編集を更新印へ混ぜず、次の取得では新しい値を読む', () => {
  let changed = false;
  const app = fixture({ afterRead({ name, row, height, cells }) {
    if (name === 'メニュー' && !changed && (row > 1 || height > 1)) {
      changed = true;
      cells[1][cells[0].indexOf('メニュー名')] = '変更後の試験カット';
    }
  } });
  const before = structuredClone(app.sheets.get('メニュー').cells);
  const result = app.send();
  assert.equal(result.ok, true);
  assert.equal(result.menus[0].メニュー名, '試験カット');
  assert.equal(result.stamps.menus, digest(before), '古い表示に新しい更新印を付けない');
  const next = app.send();
  assert.equal(next.menus[0].メニュー名, '変更後の試験カット');
  assert.notEqual(next.stamps.menus, result.stamps.menus);
});

test('日常更新は予約と休業を各一回読み、列の独自追加と並べ替えも保持する', () => {
  const app = fixture();
  for (const name of ['予約一覧', '休業日']) {
    const cells = app.sheets.get(name).cells;
    cells.forEach((row, index) => { row.push(index ? '保持する独自値' : '独自列'); row.reverse(); });
  }
  const result = app.send({ reservationsOnly: true });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), ['closedDates', 'ok', 'reservations']);
  assert.equal(app.reads.length, 2);
  assert.equal(app.count('予約一覧'), 1);
  assert.equal(app.count('休業日'), 1);
  assert.equal(result.reservations[0].code, 'LM-SNAPSHOT');
  assert.equal(result.reservations[0].tel, '00000000000');
  assert.equal(result.reservations[1].status, 'キャンセル');
  assert.deepEqual(result.closedDates, [{ 休業日: '2030-01-06', 開始: '14:00', 終了: '16:00', メモ: '試験休業' }]);
});

test('通知取得は予約全体を一回だけ読み、電話・メール・施術メモを返さない', () => {
  const app = fixture();
  const result = app.send({ notificationsOnly: true });
  assert.equal(result.ok, true);
  assert.equal(app.reads.length, 1);
  assert.equal(app.fullReads('予約一覧'), 1);
  assert.equal(result.reservations.length, 2);
  for (const record of result.reservations) {
    assert.deepEqual(Object.keys(record).sort(), ['code', 'date', 'endTime', 'name', 'status', 'time']);
  }
  assert.equal(JSON.stringify(result).includes('保持するメモ'), false);
  assert.equal(JSON.stringify(result).includes('customer@example.test'), false);
});

test('通知の見出しと行を同じ読込で照合し、取得直後の列変更を取り違えない', () => {
  let moved = false;
  const app = fixture({ afterRead({ name, cells }) {
    if (name === '予約一覧' && !moved) { moved = true; cells.forEach(row => row.reverse()); }
  } });
  for (const result of [app.send({ notificationsOnly: true }), app.send({ notificationsOnly: true })]) {
    assert.equal(result.ok, true);
    assert.equal(result.reservations[0].code, 'LM-SNAPSHOT');
    assert.equal(result.reservations[0].name, '架空 読取試験');
  }
});

for (const payload of [{}, { reservationsOnly: true }, { notificationsOnly: true }]) {
  test(`未認証の管理取得はシートを一度も読まない：${JSON.stringify(payload)}`, () => {
    const app = fixture({ denied: true });
    assert.equal(app.send(payload).authDenied, true);
    assert.deepEqual(app.reads, []);
  });
}

for (const payload of [{ reservationsOnly: true }, { notificationsOnly: true }]) {
  test(`空・欠落・曖昧な見出しを予約ゼロの成功にしない：${JSON.stringify(payload)}`, () => {
    for (const damage of ['missing', 'empty', 'blank', 'duplicate', 'no-status']) {
      const app = fixture();
      const cells = app.sheets.get('予約一覧').cells;
      if (damage === 'missing') app.sheets.delete('予約一覧');
      if (damage === 'empty') cells.length = 0;
      if (damage === 'blank') cells[0].fill('');
      if (damage === 'duplicate') cells[0].push('予約番号');
      if (damage === 'no-status') cells[0][cells[0].indexOf('状態')] = '独自列';
      const result = app.send(payload);
      assert.equal(result.ok, false, damage);
      assert.equal(result.reservations, undefined);
      assert.equal(app.held(), false);
    }
  });
}

test('正しい見出しだけの台帳と未作成の休業シートは空の一覧として返す', () => {
  const app = fixture();
  app.sheets.get('予約一覧').cells.length = 1;
  app.sheets.delete('休業日');
  assert.deepEqual(app.send({ reservationsOnly: true }), { ok: true, reservations: [], closedDates: [] });
  assert.deepEqual(app.send({ notificationsOnly: true }), { ok: true, reservations: [] });
});

test('空シート・旧形式の短い列・空の見出しでも更新印の互換性を崩さない', () => {
  const app = fixture();
  app.sheets.get('スタイル').cells.length = 0;
  app.sheets.get('メニュー').cells.splice(0, 2, ['区分', 'メニュー名', '価格'], ['カット', '旧形式', 4000]);
  app.sheets.get('口コミ').cells[0].fill('');
  const result = app.send();
  assert.equal(result.ok, true);
  assert.deepEqual(result.styles, []);
  assert.equal(result.stamps.styles, '0');
  assert.equal(result.stamps.menus, digest(app.sheets.get('メニュー').cells));
  assert.equal(result.stamps.reviews, digest(app.sheets.get('口コミ').cells));
  assert.equal(result.menus[0].メニュー名, '旧形式');
});

test('日付・時刻の表示を整え、更新印には元のセル型と独自列も含める', () => {
  const app = fixture();
  const cells = app.sheets.get('休業日').cells;
  cells[1][0] = new Date('2030-01-06T00:00:00+09:00');
  cells[1][1] = new Date('1899-12-30T14:00:00+09:00');
  cells[1][2] = new Date('1899-12-30T16:00:00+09:00');
  cells[0].push('独自の値'); cells[1].push(false);
  const result = app.send();
  assert.equal(result.ok, true);
  assert.equal(result.closedDates[0].休業日, '2030-01-06');
  assert.equal(result.closedDates[0].開始, '14:00');
  assert.equal(result.closedDates[0].終了, '16:00');
  const typedCells = cells.map(row => row.map(value => value instanceof Date ? ['date', String(value.getTime())] : value));
  assert.equal(result.stamps.closed, digest(typedCells));
  assert.notEqual(result.stamps.closed, digest(cells), '日付セルをISO文字列と同じ印にしない');
});

for (const [failure, payload] of [['メニュー', {}], ['設定', {}], ['予約一覧', { notificationsOnly: true }],
  ['休業日', { reservationsOnly: true }]]) {
  test(`読込失敗は成功データを返さず取得したロックを解放する：${failure}`, () => {
    const app = fixture({ failure });
    const result = app.send(payload);
    assert.equal(result.ok, false);
    assert.equal(result.reservations, undefined);
    assert.equal(result.stamps, undefined);
    assert.equal(app.held(), false);
  });
}

test('明示した初回読込は予約・休業・設定だけを読み、未取得メニューを空一覧として返さない', () => {
  const app = fixture();
  const before = Object.fromEntries([...app.sheets].map(([name, sheet]) => [name, structuredClone(sheet.cells)]));
  const result = app.send({ startupOnly: true, briefPast: true, deferMenus: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pendingEditors, ['menus', 'coupons', 'styles', 'reviews']);
  assert.deepEqual(Object.keys(result.stamps).sort(), ['closed', 'settings']);
  for (const target of result.pendingEditors) assert.equal(Object.hasOwn(result, target), false);
  assert.deepEqual(app.reads.map(read => read.name).sort(), ['休業日', '予約一覧', '設定'].sort());
  assert.deepEqual(result.reservations, fixture().send({ startupOnly: true, briefPast: true }).reservations);
  assert.deepEqual(result.closedDates, fixture().send({ startupOnly: true }).closedDates);
  assert.deepEqual(result.settings, fixture().send({ startupOnly: true }).settings);
  assert.deepEqual(Object.fromEntries([...app.sheets].map(([name, sheet]) => [name, sheet.cells])), before);
  assert.deepEqual(app.writes, []);
  assert.equal(app.held(), false);
});

for (const [target, name] of [['menus', 'メニュー'], ['coupons', 'おすすめメニュー']]) {
  test(`遅延した${target}は開いた一つのシートと同じsnapshotの更新印だけを返す`, () => {
    let changed = false;
    const app = fixture({ afterRead({ name: current, cells }) {
      if (current === name && !changed) { changed = true; cells[1][cells[0].indexOf('メニュー名')] = '次の読込の名前'; }
    } });
    const cells = structuredClone(app.sheets.get(name).cells);
    const expected = fixture().send({})[target];
    const result = app.send({ editorTarget: target });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result).sort(), ['editorTarget', 'ok', 'rows', 'stamp']);
    assert.equal(result.editorTarget, target);
    assert.deepEqual(result.rows, expected);
    assert.equal(result.stamp, digest(cells));
    assert.deepEqual(app.reads.map(read => read.name), [name]);
    assert.deepEqual(app.writes, []);
    const next = app.send({ editorTarget: target });
    assert.equal(next.rows[0]['メニュー名'], '次の読込の名前');
    assert.notEqual(next.stamp, result.stamp);
  });

  test(`未作成・空の${target}も他の編集内容を取得せず、空一覧とstamp 0を区別して返す`, () => {
    const missing = fixture();
    missing.sheets.delete(name);
    assert.deepEqual(missing.send({ editorTarget: target }), { ok: true, editorTarget: target, rows: [], stamp: '0' });
    assert.deepEqual(missing.reads, []);
    const empty = fixture();
    empty.sheets.get(name).cells.length = 0;
    assert.deepEqual(empty.send({ editorTarget: target }), { ok: true, editorTarget: target, rows: [], stamp: '0' });
    assert.deepEqual(empty.reads.map(read => read.name), [name]);
    assert.deepEqual(empty.writes, []);
  });

  test(`${target}の読込障害は初回予定を妨げず、編集取得だけを失敗として保存印を返さない`, () => {
    const app = fixture({ failure: name });
    assert.equal(app.send({ startupOnly: true, briefPast: true, deferMenus: true }).ok, true);
    const result = app.send({ editorTarget: target });
    assert.equal(result.ok, false);
    assert.equal(result.rows, undefined);
    assert.equal(result.stamp, undefined);
    assert.equal(app.held(), false);
    assert.deepEqual(app.writes, []);
  });

  test(`${target}の取得も認証より前にシートへ触れず、未取得で保存を始めない`, () => {
    const app = fixture({ denied: true });
    const result = app.send({ editorTarget: target });
    assert.equal(result.ok, false);
    assert.equal(result.rows, undefined);
    assert.deepEqual(app.reads, []);
    assert.deepEqual(app.writes, []);
  });
}

test('新しい遅延指定はbooleanの初回だけに作用し、従来全量・日常更新・通知を変更しない', () => {
  for (const payload of [{}, { startupOnly: 'true' }, { reservationsOnly: true }, { notificationsOnly: true }]) {
    assert.deepEqual(fixture().send({ ...payload, deferMenus: true }), fixture().send(payload));
  }
  for (const deferMenus of [false, 'true', 1, null]) {
    assert.deepEqual(fixture().send({ startupOnly: true, briefPast: true, deferMenus }),
      fixture().send({ startupOnly: true, briefPast: true }));
  }
});

for (const failure of ['予約一覧', '休業日', '設定']) {
  test(`必要な${failure}が読めなければ、編集を遅延しても起動を成功扱いしない`, () => {
    const app = fixture({ failure });
    const result = app.send({ startupOnly: true, briefPast: true, deferMenus: true });
    assert.equal(result.ok, false);
    assert.equal(result.reservations, undefined);
    assert.equal(app.held(), false);
    assert.deepEqual(app.writes, []);
  });
}

test('電話メニューは本人確認後に二シートを一回ずつ読み、同じsnapshotの更新印を返す', () => {
  const app = fixture();
  const expected = { menus: fixture().send({ editorTarget: 'menus' }), coupons: fixture().send({ editorTarget: 'coupons' }) };
  for (const name of ['予約一覧', '休業日', '設定', 'スタイル', '口コミ']) app.sheets.delete(name);
  const result = app.send({ phoneCatalogOnly: true });
  assert.deepEqual(result, { ok: true, phoneCatalog: true, editors: expected });
  assert.deepEqual(app.reads.map(read => read.name), ['メニュー', 'おすすめメニュー']);
  assert.deepEqual(app.writes, []);
  assert.equal(app.held(), false);
});

test('電話メニューの並び替えと読込直後の変更でも、返す値と更新印は同じsnapshotを使う', () => {
  const app = fixture({ afterRead({ name, cells }) {
    if (['メニュー', 'おすすめメニュー'].includes(name)) cells[1][cells[0].indexOf('メニュー名')] = '次回の値';
  } });
  const originals = {};
  for (const [target, name] of [['menus', 'メニュー'], ['coupons', 'おすすめメニュー']]) {
    app.sheets.get(name).cells.forEach(row => row.reverse());
    originals[target] = structuredClone(app.sheets.get(name).cells);
  }
  const result = app.send({ phoneCatalogOnly: true });
  assert.equal(result.ok, true);
  for (const target of ['menus', 'coupons']) {
    assert.equal(result.editors[target].stamp, digest(originals[target]));
    assert.equal(result.editors[target].rows[0]['メニュー名'], target === 'menus' ? '試験カット' : '試験コース');
  }
  const next = app.send({ phoneCatalogOnly: true });
  assert.equal(next.editors.menus.rows[0]['メニュー名'], '次回の値');
  assert.notEqual(next.editors.menus.stamp, result.editors.menus.stamp);
  assert.deepEqual(app.writes, []);
});

for (const name of ['メニュー', 'おすすめメニュー']) {
  test(`電話一括取得の${name}が読めなければ片方の結果も返さず、書かずにロックを解放する`, () => {
    const app = fixture({ failure: name });
    const result = app.send({ phoneCatalogOnly: true });
    assert.equal(result.ok, false);
    assert.equal(result.editors, undefined);
    assert.equal(result.phoneCatalog, undefined);
    assert.deepEqual(app.writes, []);
    assert.equal(app.held(), false);
  });
}

test('二種類のメニューが空・未作成でも一括で空とstamp 0を返し、台帳を初期化しない', () => {
  for (const missing of [false, true]) {
    const app = fixture();
    for (const name of ['メニュー', 'おすすめメニュー']) {
      if (missing) app.sheets.delete(name);
      else app.sheets.get(name).cells.length = 0;
    }
    const result = app.send({ phoneCatalogOnly: true });
    assert.equal(result.ok, true);
    for (const target of ['menus', 'coupons']) {
      assert.deepEqual(result.editors[target], { ok: true, editorTarget: target, rows: [], stamp: '0' });
    }
    assert.deepEqual(app.writes, []);
  }
});

for (const phoneCatalogOnly of [false, 'true', 1, null]) {
  test(`電話取得指定 ${JSON.stringify(phoneCatalogOnly)} を通常起動と誤認せず、シートへ触れない`, () => {
    const app = fixture();
    assert.equal(app.send({ phoneCatalogOnly }).ok, false);
    assert.deepEqual(app.reads, []);
    assert.deepEqual(app.writes, []);
    assert.equal(app.held(), false);
  });
}

for (const [key, value] of [['notificationsOnly', true], ['reservationsOnly', true], ['reservationCodes', ['LM-SNAPSHOT']],
  ['editorTarget', 'menus'], ['startupOnly', true], ['briefPast', true], ['deferMenus', true], ['editorTarget', null]]) {
  test(`電話取得と${key}の混在を拒否し、別データや部分結果を返さない ${JSON.stringify(value)}`, () => {
    const app = fixture();
    const result = app.send({ phoneCatalogOnly: true, [key]: value });
    assert.equal(result.ok, false);
    assert.equal(result.editors, undefined);
    assert.equal(result.reservations, undefined);
    assert.deepEqual(app.reads, []);
    assert.deepEqual(app.writes, []);
    assert.equal(app.held(), false);
  });
}

test('電話一括取得も権限確認が先で、認証拒否時はメニューや台帳を読まない', () => {
  const app = fixture({ denied: true });
  const result = app.send({ phoneCatalogOnly: true });
  assert.equal(result.ok, false);
  assert.equal(result.authDenied, true);
  assert.equal(result.editors, undefined);
  assert.deepEqual(app.reads, []);
  assert.deepEqual(app.writes, []);
  assert.equal(app.held(), false);
});

test('新しい受け口は電話一括取得能力を起動時に明示する', () => {
  assert.equal(fixture().send({ startupOnly: true, briefPast: true, deferMenus: true }).capabilities.phoneCatalog, true);
});
