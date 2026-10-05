import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/public-read.js', import.meta.url), 'utf8');
const GOOGLE_ENDPOINT = 'https://script.google.com/macros/s/test/exec';
const GOOGLE_ORIGIN = 'https://example-script.googleusercontent.com';
const FRAME_TIMEOUT_MS = 20;

function fixture({ endpoint = GOOGLE_ENDPOINT, origin = 'https://example.test' } = {}) {
  const messages = new Set();
  const frames = [];
  const requests = [];
  const host = {};
  const context = vm.createContext({
    SALON: { reservationEndpoint: endpoint, publicReadFrameTimeoutMs: FRAME_TIMEOUT_MS },
    URL, URLSearchParams, AbortController, DOMException, setTimeout, clearTimeout,
    crypto: { randomUUID: () => '12345678-1234-4234-8234-123456789012' },
    location: { origin },
    window: { addEventListener: (type, handler) => messages.add(handler),
      removeEventListener: (type, handler) => messages.delete(handler) },
    document: { createElement: tag => {
      assert.equal(tag, 'iframe');
      const frame = { contentWindow: {}, remove() { frame.removed = true; } };
      frames.push(frame);
      return frame;
    }, body: { append: frame => { frame.appended = true; } } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, booked: [], fallback: true }) };
    }
  });
  vm.runInContext(source, context);
  const send = (data = {}, { source = frames[0]?.contentWindow, origin = GOOGLE_ORIGIN } = {}) => {
    const query = new URL(frames[0].src).searchParams;
    for (const handler of messages) handler({ origin, source, data: {
      type: 'zer01-public-read', requestId: query.get('requestId'), result: { ok: true, booked: [] }, ...data
    } });
  };
  return { read: (payload = { type: 'availability' }, signal) => context.readPublicEndpoint(payload, signal),
    messages, frames, requests, send, host };
}

test('最新空席は一回だけHTMLで読み、送信元・識別子・所有フレームが揃った応答だけ受け取る', async () => {
  const app = fixture();
  const pending = app.read();
  const frame = app.frames[0];
  const query = new URL(frame.src).searchParams;
  assert.equal(query.get('type'), 'availability');
  assert.equal(query.get('origin'), 'https://example.test');
  assert.equal(query.get('transport'), 'frame');
  assert.equal(frame.hidden, true);
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.equal(frame.sandbox, 'allow-scripts allow-same-origin');
  app.send({ requestId: '古い応答' });
  app.send({}, { origin: 'https://script.googleusercontent.com.evil.test' });
  app.send({}, { source: { parent: {} } });
  assert.equal(app.messages.size, 1, '偽の応答ではまだ待機する');
  app.send();
  const response = await pending;
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await response.json())), { ok: true, booked: [] });
  assert.equal(app.requests.length, 0);
  assert.equal(app.messages.size, 0);
  assert.equal(frame.removed, true);
});

test('Googleの多重フレームでも、自分で作ったフレーム配下の応答だけを受け取る', async () => {
  const app = fixture();
  const pending = app.read({ type: 'menu', booking: true, initialAvailability: true });
  app.send({}, { source: { parent: { parent: app.frames[0].contentWindow } } });
  assert.equal((await pending).ok, true);
  assert.equal(app.requests.length, 0);
});

for (const initialAvailability of [true, false, undefined]) {
  test(`メニューの空席取得指定を読取URLへ引き継ぐ：${initialAvailability}`, async () => {
    const app = fixture();
    const payload = { type: 'menu', booking: true,
      ...(initialAvailability === undefined ? {} : { initialAvailability }) };
    const pending = app.read(payload);
    const query = new URL(app.frames[0].src).searchParams;
    assert.equal(query.get('initialAvailability'), String(initialAvailability === true));
    app.send();
    assert.equal((await pending).ok, true);
    assert.equal(app.requests.length, 0);
  });
}

test('空席だけの読取URLにメニュー用の指定を追加しない', async () => {
  const app = fixture();
  const pending = app.read();
  assert.equal(new URL(app.frames[0].src).searchParams.has('initialAvailability'), false);
  app.send();
  await pending;
});

for (const initialAvailability of [true, false]) {
  test(`メニューのフレームが止まってもPOSTで空席取得指定を変えない：${initialAvailability}`, async () => {
    const app = fixture();
    const payload = { type: 'menu', booking: true, initialAvailability };
    const response = await app.read(payload);
    assert.equal((await response.json()).fallback, true);
    assert.deepEqual(JSON.parse(app.requests[0].options.body), payload);
    assert.equal(app.requests.length, 1);
    assert.equal(app.frames[0].removed, true);
  });
}

test('空席取得の指定はbooleanだけを許可し、不正な指定をURLやPOSTへ送らない', async () => {
  for (const initialAvailability of ['false', '', null, 0, 1, [], {}]) {
    const app = fixture();
    await assert.rejects(app.read({ type: 'menu', booking: true, initialAvailability }));
    assert.equal(app.frames.length, 0);
    assert.equal(app.requests.length, 0);
  }
});

test('HTMLが止まった場合だけ従来の読取へ戻り、停止したフレームは片付ける', async () => {
  const app = fixture();
  const response = await app.read();
  assert.equal((await response.json()).fallback, true);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].options.method, 'POST');
  assert.equal(app.requests[0].options.cache, 'no-store');
  assert.deepEqual(JSON.parse(app.requests[0].options.body), { type: 'availability' });
  assert.equal(app.frames[0].removed, true);
  assert.equal(app.messages.size, 0);
});

test('中断した読取は別の通信で再送せず、タイマー・フレームを残さない', async () => {
  const app = fixture();
  const controller = new AbortController();
  const pending = app.read(undefined, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(app.requests.length, 0);
  assert.equal(app.messages.size, 0);
  assert.equal(app.frames[0].removed, true);
});

test('読取障害の返事を成功や再送へすり替えず、呼出元で受付を止められる', async () => {
  const app = fixture();
  const pending = app.read();
  app.send({ result: { ok: false, error: '読取できません' } });
  assert.equal((await (await pending).json()).ok, false);
  assert.equal(app.requests.length, 0);
});

test('登録・取消・照会・認証情報は新経路へ送らず、URLにも出さない', async () => {
  for (const payload of [{ type: 'reserve' }, { type: 'cancel' }, { type: 'lookup' },
    { type: 'availability', password: '試験値' }, { type: 'menu', idToken: '試験値' },
    { type: 'menu', booking: false }]) {
    const app = fixture();
    await assert.rejects(app.read(payload));
    assert.equal(app.frames.length, 0);
    assert.equal(app.requests.length, 0);
  }
});

test('ローカルの模擬受け口とfile表示は従来の読取を使い、Googleフレームを増やさない', async () => {
  for (const config of [{ endpoint: 'http://127.0.0.1:1234/exec' }, { origin: 'null' }]) {
    const app = fixture(config);
    assert.equal((await app.read()).ok, true);
    assert.equal(app.frames.length, 0);
    assert.equal(app.requests.length, 1);
  }
});
