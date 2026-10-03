import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../assets/js/admin-publication.js', import.meta.url), 'utf8');
const CATALOG = { categories: [{ id: 'cat0', name: '試験カット', items: [
  { id: 'sm0', name: '架空カット', price: 4000, priceFrom: false, minutes: 60, note: '', image: '' }
] }], coupons: [{ id: 'sc0', title: '架空おすすめ', badge: '全員', tags: ['カット'], detail: '',
  price: 6000, priceFrom: false, listPrice: 7000, minutes: 90, terms: '', image: '' }] };

function fixture({ booking = CATALOG, published = CATALOG, responseOk = true, bookingOk = true, source,
  json, text, fail = false, hidden = false } = {}) {
  const requests = [];
  const timers = new Set();
  const notes = Array.from({ length: 2 }, () => ({ textContent: '', dataset: {} }));
  const buttons = Array.from({ length: 2 }, () => ({ disabled: true, addEventListener() {} }));
  const dashboard = { hidden };
  let bodyReadStarted;
  const bodyStarted = new Promise(resolve => { bodyReadStarted = resolve; });
  let sourceReadStarted;
  const sourceStarted = new Promise(resolve => { sourceReadStarted = resolve; });
  const context = vm.createContext({
    URL, AbortController, Date,
    SALON: { reservationEndpoint: 'https://example.test/exec' },
    location: { href: 'https://example.test/site/admin.html?google=1' },
    adminData: { fixture: '入力を保持' }, dashboardGeneration: 1, pendingSaves: new Set(), CATALOG_REQUEST_TIMEOUT_MS: 45000,
    document: { addEventListener() {}, querySelector: () => dashboard,
      querySelectorAll: selector => selector === '[data-publication-note]' ? notes : buttons },
    setTimeout: callback => { timers.add(callback); return callback; },
    clearTimeout: callback => timers.delete(callback),
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      if (fail) throw new Error('架空の通信障害');
      if (String(url).endsWith('/exec')) return { ok: responseOk,
        json: () => {
          bodyReadStarted();
          return json ? json() : Promise.resolve({ ok: bookingOk, ...structuredClone(booking), settings: { 私有: '比較対象にしない' } });
        } };
      return { ok: responseOk, text: () => {
        sourceReadStarted();
        return text ? text() : Promise.resolve(source ?? 'const PUBLISHED_MENUS = ' + JSON.stringify(published) + ';\n');
      } };
    }
  });
  vm.runInContext(SOURCE, context);
  return { context, requests, timers, notes, buttons, dashboard, bodyStarted, sourceStarted,
    check: () => context.checkPublishedMenus(), invalidate: () => context.invalidatePublicMenuCheck(),
    same: (first, second) => context.samePublicationCatalog(first, second) };
}

test('起動時に予約側を読まず、照合は公開読取と静的データだけで状態を書き換えない', async () => {
  const app = fixture();
  app.invalidate();
  assert.equal(app.requests.length, 0);
  assert.equal(app.notes[0].dataset.state, 'unknown');
  const before = app.context.adminData;
  await app.check();
  assert.equal(app.requests.length, 2);
  const request = app.requests.find(entry => entry.url.endsWith('/exec'));
  assert.deepEqual(JSON.parse(request.options.body), { type: 'menu', booking: true });
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.cache, 'no-store');
  const published = app.requests.find(entry => entry.url.endsWith('/published-menus.js'));
  assert.equal(published.url, 'https://example.test/site/assets/js/published-menus.js');
  assert.equal(published.options.method, undefined);
  assert.equal(published.options.cache, 'no-store');
  assert.equal(published.options.credentials, 'omit');
  assert.equal(app.context.adminData, before);
  assert.ok(app.notes.every(note => note.dataset.state === 'same'));
  assert.ok(app.buttons.every(button => !button.disabled));
  assert.equal(app.timers.size, 0);
});

test('JSONのkey順と私有の余分な項目を比較に混ぜず、掲載順・全件非表示は照合する', () => {
  const app = fixture();
  const reordered = JSON.parse(JSON.stringify(CATALOG, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value));
  assert.equal(app.same(CATALOG, reordered), true);
  assert.equal(app.same({ ...CATALOG, settings: { 私有: '反映対象外' }, reviews: ['反映対象外'] }, CATALOG), true);
  assert.equal(app.same({ categories: [], coupons: [] }, { categories: [], coupons: [] }), true);
  assert.equal(app.same({ categories: [], coupons: [] }, CATALOG), false);
  const order = structuredClone(CATALOG);
  order.coupons.push({ ...order.coupons[0], id: 'sc1' });
  const reversed = structuredClone(order);
  reversed.coupons.reverse();
  assert.equal(app.same(order, reversed), false);
});

for (const [field, value] of Object.entries({ name: '別のカット', price: 5000, priceFrom: true, minutes: 90, note: '条件の変更', image: 'assets/new.jpg' })) {
  test('単品の' + field + 'の変更を公開済みと誤認しない', async () => {
    const booking = structuredClone(CATALOG);
    booking.categories[0].items[0][field] = value;
    const app = fixture({ booking });
    await app.check();
    assert.equal(app.notes[0].dataset.state, 'different');
  });
}

for (const [field, value] of Object.entries({ title: '別のおすすめ', badge: '再来', tags: ['カラー'], detail: '説明変更',
  price: 7000, priceFrom: true, listPrice: 8000, minutes: 120, terms: '条件変更', image: 'assets/new.jpg' })) {
  test('おすすめの' + field + 'の変更を公開済みと誤認しない', async () => {
    const booking = structuredClone(CATALOG);
    booking.coupons[0][field] = value;
    const app = fixture({ booking });
    await app.check();
    assert.equal(app.notes[0].dataset.state, 'different');
  });
}

for (const config of [{ responseOk: false }, { bookingOk: false }, { fail: true }, { source: 'const PUBLISHED_MENUS = (() => bad())();' },
  { source: 'const PUBLISHED_MENUS = null;' }, { source: '<html>未取得</html>' },
  { published: { categories: '不正', coupons: [] } }, { published: { categories: [], coupons: [{ id: 'sc0' }] } }]) {
  test('不正・失敗の読取を一致や差分として断言しない：' + Object.keys(config)[0], async () => {
    const app = fixture(config);
    await app.check();
    assert.equal(app.notes[0].dataset.state, 'unknown');
    assert.match(app.notes[0].textContent, /確認できません/);
    assert.ok(app.buttons.every(button => !button.disabled));
    assert.equal(app.timers.size, 0);
  });
}

test('重複ID・不正価格・不正所要時間を信用しない', () => {
  const app = fixture();
  for (const mutate of [catalog => { catalog.coupons[0].id = 'sm0'; },
    catalog => { catalog.coupons[0].price = -1; }, catalog => { catalog.categories[0].items[0].minutes = '不明'; }]) {
    const invalid = structuredClone(CATALOG);
    mutate(invalid);
    assert.throws(() => app.same(invalid, CATALOG));
  }
});

test('照合の本文待ちも期限で終わり、中断を無視する通信でも操作へ戻れる', async () => {
  for (const waiting of ['json', 'text']) {
    const app = fixture({ [waiting]: () => new Promise(() => {}) });
    const checking = app.check();
    await Promise.all([app.bodyStarted, app.sourceStarted]);
    assert.equal(app.timers.size, 1);
    for (const timeout of app.timers) timeout();
    await checking;
    assert.equal(app.notes[0].dataset.state, 'unknown');
    assert.ok(app.requests.every(request => request.options.signal.aborted));
    assert.ok(app.buttons.every(button => !button.disabled));
    assert.equal(app.timers.size, 0);
  }
});

test('保存中・未ログイン・非表示では読取を始めず、二重確認も送らない', async () => {
  for (const modify of [app => { app.context.adminData = null; }, app => { app.dashboard.hidden = true; },
    app => { app.context.pendingSaves.add('menus'); }, app => { app.context.pendingSaves.add('coupons'); }]) {
    const app = fixture();
    modify(app);
    await app.check();
    assert.equal(app.requests.length, 0);
  }
  let resolve;
  const app = fixture({ json: () => new Promise(done => { resolve = done; }) });
  const checking = app.check();
  await app.check();
  assert.equal(app.requests.length, 2);
  await app.bodyStarted;
  resolve({ ok: true, ...structuredClone(CATALOG) });
  await checking;
  assert.equal(app.notes[0].dataset.state, 'same');
});

test('保存・再ログイン・画面終了後の遅い応答を採用しない', async () => {
  for (const change of [app => app.invalidate(), app => { app.context.dashboardGeneration += 1; app.invalidate(); },
    app => { app.dashboard.hidden = true; }]) {
    let resolve;
    const app = fixture({ json: () => new Promise(done => { resolve = done; }) });
    const checking = app.check();
    await app.bodyStarted;
    change(app);
    resolve({ ok: true, ...structuredClone(CATALOG) });
    await checking;
    assert.notEqual(app.notes[0].dataset.state, 'same');
    assert.ok(app.buttons.every(button => !button.disabled));
    assert.equal(app.timers.size, 0);
  }
});

test('古い確認の終了で、新しい確認の待ち状態や期限を解除しない', async () => {
  const pending = [];
  let nextBodyRead;
  const nextBodyStarted = new Promise(resolve => { nextBodyRead = resolve; });
  const app = fixture({ json: () => new Promise(resolve => {
    pending.push(resolve);
    if (pending.length === 2) nextBodyRead();
  }) });
  const previous = app.check();
  await app.bodyStarted;
  app.invalidate();
  const current = app.check();
  await nextBodyStarted;
  pending[0]({ ok: true, ...structuredClone(CATALOG) });
  await previous;
  assert.equal(app.notes[0].dataset.state, 'loading');
  assert.ok(app.buttons.every(button => button.disabled));
  assert.equal(app.timers.size, 1);
  pending[1]({ ok: true, ...structuredClone(CATALOG) });
  await current;
  assert.equal(app.notes[0].dataset.state, 'same');
  assert.ok(app.buttons.every(button => !button.disabled));
  assert.equal(app.timers.size, 0);
});
