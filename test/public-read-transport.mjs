import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const backend = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const requestId = '12345678-1234-4234-8234-123456789012';
const origin = 'https://example.test';

function backendFixture() {
  let held = false;
  const actions = [];
  const menuRequests = [];
  const context = vm.createContext({ Date,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    console: { error() {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    HtmlService: { XFrameOptionsMode: { ALLOWALL: '許可' }, createHtmlOutput: html => ({
      setXFrameOptionsMode: mode => { assert.equal(mode, '許可'); return { html }; }
    }) },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(held, false); held = true; actions.push('取得'); },
      releaseLock() { assert.equal(held, true); held = false; actions.push('解放'); }
    }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => ({}) }) }
  });
  vm.runInContext(backend, context);
  const readMenu = context.doMenu_;
  context.doMenu_ = payload => {
    assert.equal(held, true);
    assert.equal(payload.booking, true);
    menuRequests.push(payload);
    actions.push(payload.initialAvailability ? 'メニュー・空席' : 'メニュー');
    return { ok: true, categories: [], coupons: [], closedDates: [], settings: {},
      ...(payload.initialAvailability ? { booked: [] } : {}) };
  };
  context.doAvailability_ = () => { assert.equal(held, true); actions.push('空席'); return { ok: true, booked: [] }; };
  context.getSheet_ = () => { throw new Error('読取中に台帳を初期化しない'); };
  return { context, actions, menuRequests, readMenu, send: parameter => context.doGet({ parameter }) };
}

function frameResult(output) {
  assert.equal(typeof output.html, 'string');
  const sent = [];
  const script = output.html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { window: { top: { postMessage: (data, target) => sent.push({ data, target }) } } });
  assert.equal(sent.length, 1);
  return JSON.parse(JSON.stringify(sent[0]));
}

test('新しい読取経路は転送用JSONではなくHTMLで返し、最新メニュー・空席を同じロックで読む', () => {
  const app = backendFixture();
  const sent = frameResult(app.send({ transport: 'frame', type: 'menu', requestId, origin }));
  assert.equal(sent.target, origin);
  assert.equal(sent.data.requestId, requestId);
  assert.equal(sent.data.type, 'zer01-public-read');
  assert.equal(sent.data.result.ok, true);
  assert.deepEqual(sent.data.result.booked, []);
  assert.deepEqual(app.actions, ['取得', 'メニュー・空席', '解放']);
});

for (const initialAvailability of ['true', 'false']) {
  test(`メニュー読取は指定されたときだけ空席を返す：${initialAvailability}`, () => {
    const app = backendFixture();
    const sent = frameResult(app.send({ transport: 'frame', type: 'menu', requestId, origin, initialAvailability }));
    assert.equal(sent.data.result.ok, true);
    assert.equal(app.menuRequests[0].initialAvailability, initialAvailability === 'true');
    assert.equal(Object.hasOwn(sent.data.result, 'booked'), initialAvailability === 'true');
    assert.deepEqual(app.actions, ['取得', initialAvailability === 'true' ? 'メニュー・空席' : 'メニュー', '解放']);
  });
}

test('不正な空席取得指定は台帳もメニューも読まずに拒否する', () => {
  for (const initialAvailability of ['', 'False', 'TRUE', '0', '1', 'null', null, [], {}]) {
    const app = backendFixture();
    const result = JSON.parse(app.send({ transport: 'frame', type: 'menu', requestId, origin, initialAvailability }));
    assert.equal(result.ok, false);
    assert.deepEqual(app.actions, []);
    assert.deepEqual(app.menuRequests, []);
  }
});

for (const initialAvailability of ['true', 'false', undefined]) {
  test(`実メニュー処理で空席不要なら予約一覧へ触らず、料金・受付条件・休業日は取得する：${initialAvailability}`, () => {
    const app = backendFixture();
    const reads = [];
    const catalog = { categories: [{ name: '架空の分類', items: [] }], coupons: [],
      closedDates: ['2030-01-05'], settings: { '営業開始': '09:00' } };
    app.context.doMenu_ = app.readMenu;
    app.context.readMenuSheet_ = () => { reads.push('categories'); return catalog.categories; };
    app.context.readCouponSheet_ = () => { reads.push('coupons'); return catalog.coupons; };
    app.context.readClosedSheet_ = () => { reads.push('closed'); return catalog.closedDates; };
    app.context.readSettings_ = () => { reads.push('settings'); return catalog.settings; };
    app.context.readStyleSheet_ = app.context.readReviewSheet_ = () => { throw new Error('不要な写真・口コミ取得'); };
    app.context.SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheetByName() {
      reads.push('ledger');
      throw new Error('架空の予約台帳読込障害');
    } });
    const result = frameResult(app.send({ transport: 'frame', type: 'menu', requestId, origin,
      ...(initialAvailability === undefined ? {} : { initialAvailability }) })).data.result;
    if (initialAvailability === 'false') {
      assert.deepEqual(result, { ok: true, ...catalog });
      assert.deepEqual(reads, ['categories', 'coupons', 'closed', 'settings']);
    } else {
      assert.equal(result.ok, false, '空席必要・旧要求は台帳障害時に成功へ進めない');
      assert.deepEqual(reads, ['categories', 'coupons', 'closed', 'settings', 'ledger']);
    }
    assert.deepEqual(app.actions, ['取得', '解放']);
  });
}

test('空席の再確認も読取だけを行い、予約の追加・台帳初期化へ進まない', () => {
  const app = backendFixture();
  assert.deepEqual(frameResult(app.send({ transport: 'frame', type: 'availability', requestId, origin })).data.result.booked, []);
  assert.deepEqual(app.actions, ['取得', '空席', '解放']);
});

test('読取経路から管理・照会・予約変更・取消・登録は呼べない', () => {
  for (const type of ['googleAdmin', 'adminData', 'lookup', 'change', 'cancel', 'reserve', '']) {
    const app = backendFixture();
    const data = JSON.parse(app.send({ transport: 'frame', type, requestId, origin }));
    assert.equal(data.ok, false);
    assert.deepEqual(app.actions, []);
  }
});

test('不正な返送先・識別子を拒否し、送信先へ文字列を注入できない', () => {
  for (const fields of [
    { origin: '*' }, { origin: 'null' }, { origin: 'https://example.test/path' },
    { origin: 'javascript:alert(1)' }, { requestId: '</script><script>bad()</script>' },
    { requestId: '' }
  ]) {
    const app = backendFixture();
    const output = app.send({ transport: 'frame', type: 'menu', requestId, origin, ...fields });
    assert.equal(JSON.parse(output).ok, false);
    assert.deepEqual(app.actions, []);
  }
});

test('店舗の文章にscript終了文字や行区切りがあっても、実行せずデータとして返す', () => {
  const app = backendFixture();
  const text = '</script><script>bad()</script>\u2028\u2029&<>';
  app.context.doMenu_ = () => ({ ok: true, settings: { お知らせ: text } });
  const sent = frameResult(app.send({ transport: 'frame', type: 'menu', requestId, origin }));
  assert.equal(sent.data.result.settings.お知らせ, text);
});

test('読取障害では失敗を返してロックを解放し、空席を捏造しない', () => {
  const app = backendFixture();
  app.context.doMenu_ = () => { throw new Error('試験用の読取障害'); };
  const result = frameResult(app.send({ transport: 'frame', type: 'menu', requestId, origin })).data.result;
  assert.equal(result.ok, false);
  assert.equal(result.booked, undefined);
  assert.deepEqual(app.actions, ['取得', '解放']);
});

test('従来のURLを開く設置確認の応答は変えない', () => {
  const app = backendFixture();
  assert.deepEqual(JSON.parse(app.context.doGet()), { ok: true, message: '予約の受信先として動作しています' });
  assert.deepEqual(app.actions, []);
});
