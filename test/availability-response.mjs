import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const begin = source.indexOf('const Remote =');
const end = source.indexOf('\n/* ===', begin);
const timeout = source.match(/const AVAILABILITY_REQUEST_TIMEOUT_MS = \d+;/)?.[0] || '';
const deadline = source.match(/^async function readJsonWithDeadline\([^]*?^}/m)?.[0] || '';
assert.ok(begin >= 0 && end > begin);
function environment(fetch, timing = {}) {
  return vm.runInNewContext(deadline + '\n' + timeout + source.slice(begin, end) + ';Remote', {
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

for (const stage of ['接続', '本文']) {
  test(`中断を無視する${stage}でも空席の待機を終了し、遅い応答で再確認結果を戻さない`, async () => {
    let release;
    let stop;
    let signal;
    let retry = false;
    let cleared = 0;
    const stale = { ok: true, booked: [{ date: '2030-01-07', time: '10:00', minutes: 60, staffId: 'st01' }] };
    const pending = new Promise(resolve => { release = resolve; });
    const remote = environment(async (_url, options) => {
      if (retry) return { ok: true, json: async () => ({ ok: true, booked: [] }) };
      signal = options.signal;
      return stage === '接続' ? pending : { ok: true, json: () => pending };
    }, { setTimeout: callback => { stop = callback; return '空席タイマー'; }, clearTimeout: () => { cleared++; } });
    let settled = false;
    const result = remote.load().then(value => { settled = true; return value; });
    stop();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'AbortSignalの応答を待たず有限時間で戻る');
    assert.equal(await result, false);
    assert.equal(signal.aborted, true);
    assert.equal(remote.booked, null);
    assert.equal(remote.loaded, true);
    assert.equal(remote.loading, null);
    retry = true;
    assert.equal(await remote.load(true), true);
    release(stage === '接続' ? { ok: true, json: async () => stale } : stale);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(remote.booked, [], '期限後の応答で最新の空席を巻き戻さない');
    assert.equal(cleared, 2);
  });
}

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
