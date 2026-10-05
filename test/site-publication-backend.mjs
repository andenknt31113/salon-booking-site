import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');

function fixture(native = true) {
  let held = false;
  const reads = [];
  const writes = [];
  const sheets = new Map();
  const spreadsheet = { getSheetByName: name => sheets.get(name) || null,
    insertSheet() { writes.push('insertSheet'); throw new Error('初期化は禁止'); } };
  const forbid = operation => () => { writes.push(operation); throw new Error('書込・通知は禁止'); };
  const context = vm.createContext({ Date, console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: forbid('property') }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush: forbid('flush') },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; } }) },
    MailApp: { sendEmail: forbid('mail') }, UrlFetchApp: { fetch: forbid('fetch') }
  });
  vm.runInContext(SOURCE, context);
  const constants = name => Array.from(vm.runInContext(name, context));
  const add = (name, headers, records) => {
    const cells = [headers, ...records.map(record => headers.map(header => record[header] ?? ''))];
    const width = () => Math.max(0, ...cells.map(row => row.length));
    const range = (row, column, height = 1, columns = 1) => ({ getValues() {
      assert.equal(held, true);
      reads.push({ name, row, column, height, columns });
      return Array.from({ length: height }, (_unused, rowIndex) => Array.from({ length: columns }, (_cell, columnIndex) =>
        cells[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? ''));
    }, setValues: forbid('setValues'), setValue: forbid('setValue') });
    const sheet = { cells, getLastRow: () => cells.length, getLastColumn: width,
      getRange: range, appendRow: forbid('appendRow'), getParent: () => spreadsheet };
    if (native) sheet.getDataRange = () => range(1, 1, Math.max(1, cells.length), Math.max(1, width()));
    sheets.set(name, sheet);
  };
  add('メニュー', constants('MENU_HEADERS'), [{ 区分: 'カット', メニュー名: '架空カット',
    価格: 4000, '所要(分)': 60, 説明: '保持する説明', 画像: 'assets/style1.jpg', 表示: '表示' }]);
  add('おすすめメニュー', constants('COUPON_HEADERS'), []);
  add('スタイル', constants('STYLE_HEADERS'), [{ タイトル: '架空スタイル', 分類: 'ショート',
    タグ: 'カット,ショート', 説明: 'そのまま掲載する説明', 画像: 'assets/style1.jpg', 表示: '表示' }]);
  const publicKeys = constants('PUBLIC_SETTING_KEYS');
  const settings = publicKeys.map(key => ({ 項目: key, 内容: ({ 電話番号: '00000000000',
    営業開始: '09:00', 営業終了: '19:00', 最終受付: '18:00', 店の紹介文: '架空の紹介',
    '準備中の帯': '出さない' })[key] ?? '' }));
  settings.push({ 項目: '通知先メール', 内容: 'private@example.test' });
  add('設定', ['項目', '内容'], settings);
  const send = (payload = { type: 'menu', publication: true }) => {
    const before = structuredClone([...sheets].map(([name, sheet]) => [name, sheet.cells]));
    const response = JSON.parse(context.doPost({ postData: { contents: JSON.stringify(payload) } }));
    assert.equal(held, false);
    assert.deepEqual(writes, []);
    assert.deepEqual([...sheets].map(([name, sheet]) => [name, sheet.cells]), before);
    return response;
  };
  return { send, sheets, reads, publicKeys };
}

for (const native of [true, false]) {
  const mode = native ? '使用範囲' : '互換範囲';
  test(`${mode}：メニュー・店舗情報・写真を同じ要求で読み、公開対象だけを返す`, () => {
    const app = fixture(native);
    const result = app.send();
    assert.equal(result.ok, true);
    assert.equal(result.publicationReady, true);
    assert.deepEqual(app.reads.map(read => read.name), ['メニュー', 'おすすめメニュー', 'スタイル', '設定']);
    assert.equal(result.categories[0].items[0].price, 4000);
    assert.equal(result.styles[0].title, '架空スタイル');
    assert.deepEqual(result.styles[0].tags, ['カット', 'ショート']);
    assert.equal(result.settings['店の紹介文'], '架空の紹介');
    assert.deepEqual(Object.keys(result.settings).toSorted(), app.publicKeys.toSorted());
    assert.equal(JSON.stringify(result).includes('private@example.test'), false);
    for (const field of ['booked', 'closedDates', 'reservations', 'reviews', 'stamp']) assert.equal(result[field], undefined);
  });

  for (const name of ['メニュー', 'おすすめメニュー', 'スタイル', '設定']) {
    for (const fault of ['missing', 'empty', 'header-missing', 'header-duplicate']) {
      test(`${mode}：${name}の${fault}を正常な空一覧として公開しない`, () => {
        const app = fixture(native);
        const sheet = app.sheets.get(name);
        if (fault === 'missing') app.sheets.delete(name);
        if (fault === 'empty') sheet.cells.length = 0;
        if (fault === 'header-missing') sheet.cells[0][0] = '旧形式';
        if (fault === 'header-duplicate') sheet.cells[0][1] = sheet.cells[0][0];
        const result = app.send();
        assert.equal(result.ok, false);
        assert.match(result.error, /公開/);
        assert.equal(result.publicationReady, undefined);
        assert.equal(result.styles, undefined);
      });
    }
  }

  test(`${mode}：見出しの並び替えと独自列は尊重し、値を取り違えない`, () => {
    const app = fixture(native);
    for (const sheet of app.sheets.values()) {
      for (const row of sheet.cells) {
        [row[0], row[1]] = [row[1], row[0]];
        row.push('公開しない独自の値');
      }
      sheet.cells[0][sheet.cells[0].length - 1] = '独自列';
    }
    const result = app.send();
    assert.equal(result.ok, true);
    assert.equal(result.categories[0].items[0].name, '架空カット');
    assert.equal(result.styles[0].title, '架空スタイル');
    assert.equal(result.settings['店の紹介文'], '架空の紹介');
    assert.equal(JSON.stringify(result).includes('公開しない独自の値'), false);
  });

  for (const empty of ['header-only', 'hidden']) {
    test(`${mode}：${empty}の写真一覧は明示的な空配列にし、古い写真へ戻さない`, () => {
      const app = fixture(native);
      const sheet = app.sheets.get('スタイル');
      if (empty === 'header-only') sheet.cells.length = 1;
      else sheet.cells[1][sheet.cells[0].indexOf('表示')] = '非表示';
      const result = app.send();
      assert.equal(result.ok, true);
      assert.equal(result.publicationReady, true);
      assert.deepEqual(result.styles, []);
    });
  }

  for (const name of ['メニュー', 'おすすめメニュー']) {
    for (const shown of [true, false]) {
      test(`${mode}：${name}の不正な所要時間は掲載する場合だけ公開を止める`, () => {
        const app = fixture(native);
        const sheet = app.sheets.get(name);
        sheet.cells[1] = sheet.cells[0].map(header => ({ メニュー名: '架空メニュー',
          '所要(分)': '未確認', 表示: shown ? '表示' : '非表示' })[header] ?? '');
        const response = app.send();
        assert.equal(response.ok, !shown);
        if (shown) assert.match(response.error, /所要時間/);
        else assert.deepEqual(name === 'メニュー' ? response.categories : response.coupons, []);
      });
    }
  }

  for (const fault of ['missing', 'duplicate']) {
    test(`${mode}：公開用設定の${fault}は掲載中の値で補わず拒否する`, () => {
      const app = fixture(native);
      const sheet = app.sheets.get('設定');
      const position = sheet.cells.findIndex(row => row[0] === '店の紹介文');
      if (fault === 'missing') sheet.cells.splice(position, 1);
      else sheet.cells.push(sheet.cells[position].slice());
      const result = app.send();
      assert.equal(result.ok, false);
      assert.match(result.error, /公開/);
    });
  }

  test(`${mode}：変更後の要求を読み直し、過去の写真や設定をキャッシュしない`, () => {
    const app = fixture(native);
    assert.equal(app.send().styles[0].title, '架空スタイル');
    const style = app.sheets.get('スタイル');
    style.cells[1][style.cells[0].indexOf('タイトル')] = '変更した架空スタイル';
    const settings = app.sheets.get('設定');
    settings.cells.find(row => row[0] === '店の紹介文')[1] = '';
    const result = app.send();
    assert.equal(result.styles[0].title, '変更した架空スタイル');
    assert.equal(result.settings['店の紹介文'], '');
  });
}

test('公開内容の要求へ空席取得を混ぜず、実予約台帳を読まない', () => {
  const app = fixture();
  const response = app.send({ type: 'menu', publication: true, booking: true, initialAvailability: true });
  assert.equal(response.ok, false);
  assert.equal(response.booked, undefined);
  assert.deepEqual(app.reads, []);
});
