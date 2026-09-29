import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const begin = source.indexOf('const Remote =');
const end = source.indexOf('\n/* ===', begin);
const timeout = source.match(/const AVAILABILITY_REQUEST_TIMEOUT_MS = \d+;/)?.[0] || '';
assert.ok(begin >= 0 && end > begin);
function environment(fetch, timing = {}) {
  return vm.runInNewContext(timeout + source.slice(begin, end) + ';Remote', {
    SALON: { reservationEndpoint: 'https://example.test/exec' }, fetch,
    AbortController, setTimeout, clearTimeout, console: { warn() {} }, ...timing
  });
}

test('空席取得はキャッシュを使わず最新の枠を読み、タイマーを片付ける', async () => {
  let cleared = false;
  const remote = environment(async (_url, options) => {
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(JSON.parse(options.body), { type: 'availability' });
    return { ok: true, json: async () => ({ ok: true, booked: [] }) };
  }, { setTimeout: () => '空席タイマー', clearTimeout: handle => { assert.equal(handle, '空席タイマー'); cleared = true; } });
  assert.equal(await remote.load(), true);
  assert.deepEqual(remote.booked, []);
  assert.equal(cleared, true);
});

test('接続・本文読込が止まれば空席を未確認に戻し、手動で再確認できる', async () => {
  for (const stage of ['接続', '本文']) {
    let abort;
    let retry = false;
    let stop;
    let cleared = 0;
    const pending = new Promise((_resolve, reject) => { abort = reject; });
    const remote = environment(async (_url, options) => {
      if (retry) return { ok: true, json: async () => ({ ok: true, booked: [] }) };
      options.signal.addEventListener('abort', () => abort(new Error('中止')));
      return stage === '接続' ? pending : { ok: true, json: () => pending };
    }, { setTimeout: callback => { stop = callback; return '空席タイマー'; }, clearTimeout: () => { cleared++; } });
    const result = remote.load();
    assert.equal(typeof stop, 'function');
    stop();
    assert.equal(await result, false);
    assert.equal(remote.booked, null);
    assert.equal(remote.loaded, true);
    assert.equal(remote.loading, null);
    retry = true;
    assert.equal(await remote.load(true), true);
    assert.equal(cleared, 2);
  }
});
