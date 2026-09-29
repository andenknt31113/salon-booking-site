import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const begin = source.indexOf('async function sendToEndpoint(');
const end = source.indexOf('\n/* ===', begin);
assert.ok(begin >= 0 && end > begin);
function environment(fetch) {
  return vm.runInNewContext(source.slice(begin, end) + ';sendToEndpoint', {
    SALON: { reservationEndpoint: 'https://example.test/exec' }, fetch,
    setTimeout, console: { warn() {} }
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
