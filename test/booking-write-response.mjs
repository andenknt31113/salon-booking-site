import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const begin = source.indexOf('async function sendToEndpoint(');
const end = source.indexOf('\n/* ===', begin);
assert.ok(begin >= 0 && end > begin);
function environment(fetch, { timeoutMs = 20, timers = new Set() } = {}) {
  return vm.runInNewContext(source.slice(begin, end) + ';sendToEndpoint', {
    SALON: { reservationEndpoint: 'https://example.test/exec', bookingTransport: { writeTimeoutMs: timeoutMs } }, fetch,
    AbortController,
    setTimeout(callback, duration) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, duration);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    console: { warn() {} }
  });
}

test('接続案内やHTTP失敗を予約・変更・取消の成功にせず、勝手に再送しない', async () => {
  for (const type of ['reserve', 'change', 'cancel']) {
    for (const [httpOK, data] of [[true, { ok: true, message: '受信先として動作しています' }], [false, { ok: true }]]) {
      let calls = 0;
      const send = environment(async () => { calls++; return { ok: httpOK, json: async () => data }; });
      assert.equal((await send({ type, code: 'LM-CHECK' })).ok, false);
      assert.equal(calls, 1);
    }
  }
});

test('通信例外でも同じ操作を自動再送せず、保存したか不明と返す', async () => {
  for (const type of ['reserve', 'change', 'cancel']) {
    let calls = 0;
    const send = environment(async () => { calls++; throw new Error('試験用の通信断'); });
    const result = await send({ type, code: 'LM-CHECK' });
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.equal(calls, 1);
    assert.match(result.error, /確認できません/);
  }
});

for (const stalled of ['fetch', 'body']) {
  test(`${stalled}が返事をしなくても待機を打ち切り、未登録とは断言しない`, async () => {
    for (const type of ['reserve', 'change', 'cancel']) {
      let calls = 0;
      let signal;
      const timers = new Set();
      const send = environment(async (_url, options) => {
        calls++;
        signal = options.signal;
        return stalled === 'fetch' ? new Promise(() => {})
          : { ok: true, json: () => new Promise(() => {}) };
      }, { timers });
      let guard;
      try {
        const result = await Promise.race([send({ type, code: 'LM-CHECK' }),
          new Promise(resolve => { guard = setTimeout(() => resolve('終了しない'), 200); })]);
        assert.notEqual(result, '終了しない');
        assert.equal(result.ok, false);
        assert.equal(result.unknown, true);
        assert.equal(signal.aborted, true);
        assert.equal(calls, 1);
        assert.equal(timers.size, 0);
      } finally { clearTimeout(guard); }
    }
  });
}

test('保存後にHTTP失敗・壊れたJSON・本文の読込失敗が起きたら、結果不明を返す', async () => {
  for (const response of [
    { ok: false, json: async () => ({ ok: true }) },
    { ok: true, json: async () => ({ message: '接続案内' }) },
    { ok: true, json: async () => { throw new Error('試験用の本文切断'); } }
  ]) {
    let saved = false;
    const timers = new Set();
    const send = environment(async () => { saved = true; return response; }, { timers });
    const result = await send({ type: 'reserve', code: 'LM-CHECK' });
    assert.equal(saved, true);
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.equal(timers.size, 0);
  }
});

test('正常な書込応答と確定的な拒否はそのまま返し、通信キャッシュを使わない', async () => {
  for (const data of [{ ok: true }, { ok: true, code: 'LM-CHECK' },
    { ok: true, alreadyCancelled: true, calendarWarning: false },
    { ok: false, deadline: true, error: '受付期限を過ぎています。' }]) {
    const send = environment(async (_url, options) => {
      assert.equal(options.cache, 'no-store');
      assert.deepEqual(JSON.parse(options.body), { type: 'cancel', code: 'LM-CHECK', tel: '00000000000' });
      return { ok: true, json: async () => data };
    });
    assert.equal(await send({ type: 'cancel', code: 'LM-CHECK', tel: '00000000000' }), data);
  }
});
