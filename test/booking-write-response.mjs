import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const begin = source.indexOf('async function sendToEndpoint(');
const end = source.indexOf('\nconst AVAILABILITY_REQUEST_TIMEOUT_MS', begin);
assert.ok(begin >= 0 && end > begin);
const REJECTION_FLAGS = ['noEndpoint', 'restored', 'deadline', 'taken', 'stale', 'cancelled',
  'invalid', 'closed', 'scheduleChanged', 'catalogChanged', 'conflict', 'draft', 'authDenied'];
const REQUEST = { type: 'reserve', code: 'LM-CHECK', customer: { tel: '00000000000' } };

function environment(data, { status = 200, endpoint = 'https://example.test/exec',
  timeoutMs = 1250, pending = '', error = false } = {}) {
  const requests = [];
  const timers = new Map();
  const cleared = [];
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const response = { ok: status >= 200 && status < 300, status,
    json: () => pending === 'body' ? wait : Promise.resolve(data) };
  const send = vm.runInNewContext(source.slice(begin, end) + ';sendToEndpoint', {
    SALON: { reservationEndpoint: endpoint, bookingTransport: { writeTimeoutMs: timeoutMs } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (error) throw new Error('内部用の通信エラー');
      return pending === 'connection' ? wait : response;
    }, AbortController,
    setTimeout(callback, delay) {
      const handle = `timer-${timers.size}`;
      timers.set(handle, { callback, delay });
      return handle;
    },
    clearTimeout(handle) { cleared.push(handle); timers.delete(handle); }
  });
  return { send, requests, timers, cleared,
    expire() { for (const timer of timers.values()) timer.callback(); },
    release() { release(pending === 'connection' ? response : data); } };
}

async function expectUnknown(data, options) {
  const app = environment(data, options);
  const result = await app.send(REQUEST);
  assert.equal(result.ok, false);
  assert.equal(result.unknown, true);
  assert.match(result.error, /予約番号.*最新の状態/);
  assert.equal(result.error.includes('内部用'), false);
  for (const flag of REJECTION_FLAGS) assert.equal(result[flag], undefined);
  assert.equal(app.requests.length, 1);
  assert.equal(app.timers.size, 0);
  assert.equal(app.cleared.length, 1);
}

for (const flag of ['unknown', ...REJECTION_FLAGS]) {
  test(`成功と${flag}が矛盾する応答を完了や確定拒否にしない`, () =>
    expectUnknown({ ok: true, code: REQUEST.code, [flag]: true }));
}

for (const flag of REJECTION_FLAGS) {
  test(`結果不明と${flag}が矛盾する応答は番号保持を優先する`, () =>
    expectUnknown({ ok: false, unknown: true, [flag]: true, error: '確認用の応答' }));
}

for (const flag of ['unknown', ...REJECTION_FLAGS]) {
  test(`${flag}の文字列を確定結果の真偽値に代用しない`, () =>
    expectUnknown({ ok: false, [flag]: 'false', error: '確認用の応答' }));
}

for (const data of [null, [], '成功', {}, { ok: 'true' }, { ok: 1 },
  { ok: true, code: REQUEST.code, error: '保存結果が不明です' },
  { ok: true, code: REQUEST.code, error: {} },
  { ok: false, error: {} }, { ok: false, unknown: null },
  { ok: true, code: REQUEST.code, message: '受信先の設置確認' }]) {
  test(`不正な受付結果を完了にしない：${JSON.stringify(data)}`, () => expectUnknown(data));
}

for (const type of ['reserve', 'change', 'cancel']) {
  test(`${type}の正常応答と既存の確定拒否・結果不明をそのまま保持する`, async () => {
    const responses = [
      { ok: true, code: REQUEST.code },
      { ok: true, code: REQUEST.code, duplicate: true, calendarWarning: true },
      { ok: true, unchanged: true, notificationsQueued: true, calendarWarning: false },
      { ok: true, alreadyCancelled: true },
      { ok: true, error: '', unknown: false, ...Object.fromEntries(REJECTION_FLAGS.map(flag => [flag, false])) },
      { ok: false, unknown: true, error: '保存の結果を確認できません。' },
      { ok: false, error: '台帳を確認できません。' },
      ...REJECTION_FLAGS.map(flag => ({ ok: false, [flag]: true, error: '確定した拒否です。' }))
    ];
    for (const data of responses) {
      const app = environment(data);
      const request = { ...REQUEST, type };
      assert.deepEqual(JSON.parse(JSON.stringify(await app.send(request))), data);
      assert.equal(app.requests.length, 1);
      assert.equal(app.requests[0].url, 'https://example.test/exec');
      const options = app.requests[0].options;
      assert.equal(options.method, 'POST');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.headers['Content-Type'], 'text/plain;charset=utf-8');
      assert.deepEqual(JSON.parse(options.body), request);
      assert.equal(options.signal.aborted, false);
      assert.equal(app.timers.size, 0);
      assert.equal(app.cleared.length, 1);
    }
  });
}

for (const pending of ['connection', 'body']) {
  test(`${pending}が中止に応答しなくても送信待ちを終え、自動で再送しない`, async () => {
    const app = environment({ ok: true, code: REQUEST.code }, { pending });
    const waiting = app.send(REQUEST);
    await Promise.resolve();
    assert.equal([...app.timers.values()][0].delay, 1250);
    app.expire();
    const result = await waiting;
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.equal(app.requests[0].options.signal.aborted, true);
    assert.equal(app.timers.size, 0);
    app.release();
    await Promise.resolve();
    assert.equal(result.unknown, true);
    assert.equal(app.requests.length, 1);
  });
}

test('接続先未設定だけは送信前の拒否とし、通信やタイマーを開始しない', async () => {
  const app = environment(null, { endpoint: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(await app.send(REQUEST))), { ok: false, noEndpoint: true });
  assert.equal(app.requests.length, 0);
  assert.equal(app.timers.size, 0);
  assert.equal(app.cleared.length, 0);
});

test('HTTP失敗や通信例外は未確認とし、内部エラーを利用者へ出さない', async () => {
  await expectUnknown({ ok: true, code: REQUEST.code }, { status: 503 });
  await expectUnknown(null, { error: true });
});
