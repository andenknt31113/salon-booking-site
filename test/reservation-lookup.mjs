import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const begin = source.indexOf('async function lookupReservation(');
const end = source.indexOf('\n/** キャンセルを受信先へ通知する', begin);
assert.ok(begin >= 0 && end > begin);
const reservation = {
  code: 'LM-CHECK', date: '2026-10-08', time: '10:00', endTime: '11:00',
  totalMinutes: 60, menuText: '確認用カット', staffName: '担当者', totalPrice: 4000,
  name: '確認用', status: '予約確定'
};

function environment(fetch, timing = {}) {
  return vm.runInNewContext(source.slice(begin, end) + ';lookupReservation', {
    SALON: { reservationEndpoint: 'https://example.test/exec' }, fetch,
    normalizeCode: value => String(value).replace(/[^a-z0-9]/gi, '').toUpperCase(),
    fromKey: value => new Date(value + 'T00:00:00Z'),
    toKey: value => Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10),
    AbortController, setTimeout, clearTimeout,
    LOOKUP_REQUEST_TIMEOUT_MS: 30000,
    console: { warn() {} }, ...timing
  });
}

test('照会は対象の予約が揃った正常な応答だけを返す', async () => {
  for (const status of ['予約確定', 'キャンセル', '']) {
    const lookup = environment(async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), { type: 'lookup', code: 'lm-check', tel: '00000000000' });
      return { ok: true, json: async () => ({ ok: true, reservation: { ...reservation, status } }) };
    });
    assert.equal((await lookup('lm-check', '00000000000')).reservation.status, status);
  }
});

test('HTTP失敗・別の応答・壊れた予約を成功にしない', async () => {
  const cases = [
    { ok: true, message: '受信先として動作しています' },
    { ok: true, reservation: null },
    ...[
      { code: 'LM-OTHER' }, { date: '2026-02-30' }, { time: '25:00' },
      { endTime: '11:90' }, { endTime: 0 }, { totalMinutes: null }, { totalMinutes: -1 },
      { totalPrice: '不明' }, { name: {} }, { status: null }
    ].map(change => ({ ok: true, reservation: { ...reservation, ...change } }))
  ];
  for (const payload of cases) {
    const result = await environment(async () => ({ ok: true, json: async () => payload }))('LM-CHECK', '00000000000');
    assert.equal(result.ok, false);
    assert.match(result.error, /応答|内容/);
  }
  const unavailable = await environment(async () => ({ ok: false, status: 503,
    json: async () => ({ ok: true, reservation }) }))('LM-CHECK', '00000000000');
  assert.equal(unavailable.ok, false);
});

test('通信待ちと本文読込待ちには上限があり、タイマーを片付ける', async () => {
  for (const stage of ['接続', '本文']) {
    let abortRequest;
    let cleared = false;
    let signal;
    const pending = new Promise((_resolve, reject) => { abortRequest = reject; });
    const lookup = environment(async (_url, options) => {
      signal = options.signal;
      signal.addEventListener('abort', () => abortRequest(new Error('中止')));
      return stage === '接続' ? pending : { ok: true, json: () => pending };
    }, {
      setTimeout: callback => { queueMicrotask(callback); return '照会タイマー'; },
      clearTimeout: handle => { assert.equal(handle, '照会タイマー'); cleared = true; }
    });
    const result = await lookup('LM-CHECK', '00000000000');
    assert.equal(result.ok, false);
    assert.match(result.error, /時間|もう一度/);
    assert.equal(signal.aborted, true);
    assert.equal(cleared, true);
  }
});

test('見つからない応答と通信断は予約内容を返さない', async () => {
  const missing = await environment(async () => ({ ok: true,
    json: async () => ({ ok: false, error: 'ご予約が見つかりませんでした。' }) }))('LM-CHECK', '00000000000');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /見つかりません/);
  const failed = await environment(async () => { throw new Error('試験用の通信断'); })('LM-CHECK', '00000000000');
  assert.equal(failed.ok, false);
  assert.equal(failed.reservation, undefined);
});
