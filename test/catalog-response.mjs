import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const begin = source.indexOf('const STATIC_CATALOG_PAGES');
const end = source.indexOf('const SALON_DEFAULT_HOURS', begin);
const deadline = source.match(/^async function readJsonWithDeadline\([^]*?^}/m)?.[0] || '';
assert.ok(begin >= 0 && end > begin);

function environment(fetch, timing = {}) {
  return vm.runInNewContext(deadline + '\n' + source.slice(begin, end) + ';Catalog', {
    SALON: { reservationEndpoint: 'https://example.test/exec', business: {} }, fetch,
    document: { body: { dataset: { page: 'reserve' } }, dispatchEvent() {} },
    AbortController, setTimeout, clearTimeout, CustomEvent: class {},
    Availability: { _blocks: new Map() },
    normalizeItem: value => value, applySettings() {}, renderHeader() {}, renderFooter() {}, wireImageFallbacks() {},
    console: { warn() {} }, ...timing
  });
}

test('メニュー読込はキャッシュを使わず、終了時にタイマーを片付ける', async () => {
  let cleared = false;
  const catalog = environment(async (_url, options) => {
    assert.equal(options.cache, 'no-store');
    assert.equal(JSON.parse(options.body).type, 'menu');
    assert.equal(JSON.parse(options.body).booking, true);
    return { ok: true, json: async () => ({ ok: true, categories: [], coupons: [], closedDates: [], settings: {} }) };
  }, { setTimeout: () => '読込タイマー', clearTimeout: handle => { assert.equal(handle, '読込タイマー'); cleared = true; } });
  assert.equal(await catalog.load(), 'sheet');
  assert.equal(cleared, true);
});

for (const stage of ['接続', '本文']) {
  test(`中断を無視するメニューの${stage}でも受付を止め、期限後の応答で料金を戻さない`, async () => {
    let release;
    let stop;
    let signal;
    let retry = false;
    let cleared = 0;
    const salon = { reservationEndpoint: 'https://example.test/exec', business: {},
      menuCategories: [{ id: '掲載済み' }], coupons: [] };
    const response = id => ({ ok: true, categories: [{ id, items: [] }], coupons: [], closedDates: [], settings: {} });
    const pending = new Promise(resolve => { release = resolve; });
    const catalog = environment(async (_url, options) => {
      if (retry) return { ok: true, json: async () => response('最新料金') };
      signal = options.signal;
      return stage === '接続' ? pending : { ok: true, json: () => pending };
    }, { SALON: salon, setTimeout: callback => { stop = callback; return '読込タイマー'; },
      clearTimeout: () => { cleared++; } });
    let settled = false;
    const result = catalog.load().then(value => { settled = true; return value; });
    stop();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, '読取本文が終わらなくても待機を解除する');
    assert.equal(await result, 'local');
    assert.equal(signal.aborted, true);
    assert.equal(catalog.loaded, true);
    assert.equal(catalog.loading, null);
    assert.equal(salon.menuCategories[0].id, '掲載済み');
    retry = true;
    assert.equal(await catalog._fetch(), 'sheet');
    release(stage === '接続' ? { ok: true, json: async () => response('古い料金') } : response('古い料金'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(salon.menuCategories[0].id, '最新料金', '期限後のメニューを反映しない');
    assert.equal(cleared, 2);
  });
}

test('メニューの接続・本文読込が止まっても待ち続けず、受付確認済みにしない', async () => {
  for (const stage of ['接続', '本文']) {
    let abort;
    let signal;
    let cleared = false;
    const pending = new Promise((_resolve, reject) => { abort = reject; });
    const catalog = environment(async (_url, options) => {
      signal = options.signal;
      signal.addEventListener('abort', () => abort(new Error('中止')));
      return stage === '接続' ? pending : { ok: true, json: () => pending };
    }, {
      setTimeout: callback => { queueMicrotask(callback); return '読込タイマー'; },
      clearTimeout: () => { cleared = true; }
    });
    assert.equal(await catalog.load(), 'local');
    assert.equal(catalog.loaded, true);
    assert.equal(catalog.loading, null);
    assert.equal(signal.aborted, true);
    assert.equal(cleared, true);
  }
});
