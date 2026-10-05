import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { publicationSite, serializePublishedMenus } from '../tools/publication-site.mjs';

const SOURCE = readFileSync(new URL('../tools/publish-menus.mjs', import.meta.url), 'utf8');
const LOAD = SOURCE.match(/async function loadCatalog\([^)]*\) {[\s\S]*?\n}\n/)[0]
  .replaceAll('import.meta.url', 'TOOL_URL');
const ENDPOINT = 'https://script.google.com/macros/s/fixture/exec';
const RESULT = 'https://script.googleusercontent.com/macros/echo?fixture=result';
const DATA = { ok: true, categories: [], coupons: [] };

function fixture(responses, endpoint = ENDPOINT) {
  const requests = [];
  const context = vm.createContext({ URL, JSON, Set, Object, Number, Error,
    TOOL_URL: new URL('../tools/publish-menus.mjs', import.meta.url), publicationSite, serializePublishedMenus,
    process: { env: { RESERVATION_ENDPOINT: endpoint } },
    AbortSignal: { timeout: () => ({ fixture: true }) },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      const response = responses.shift();
      assert.ok(response, '意図しない再送・転送をしない');
      return response;
    } });
  vm.runInContext('const TIMEOUT_MS = 15000; ' + LOAD, context);
  return { requests, load: () => context.loadCatalog() };
}

for (const status of [302, 303]) {
  test(`${status}のGAS応答は許可した結果取得先へ一度だけGETし、POST本文を転送しない`, async () => {
    const app = fixture([new Response('', { status, headers: { location: RESULT } }),
      new Response(JSON.stringify(DATA), { headers: { 'Content-Type': 'application/json' } })]);
    assert.match(await app.load(), /const PUBLISHED_MENUS/);
    assert.equal(app.requests.length, 2);
    assert.equal(app.requests[0].options.redirect, 'manual');
    assert.equal(app.requests[1].url, RESULT);
    assert.equal(app.requests[1].options.method, 'GET');
    assert.equal(app.requests[1].options.redirect, 'manual');
    assert.equal(app.requests[1].options.body, undefined);
    assert.equal(app.requests[1].options.headers, undefined);
    assert.equal(app.requests[1].options.signal, app.requests[0].options.signal);
    assert.equal(app.requests[1].options.credentials, 'omit');
  });
}

for (const location of [null, 'https://foreign.invalid/result', 'http://script.googleusercontent.com/macros/echo',
  'https://script.googleusercontent.com/other', 'https://fixture@script.googleusercontent.com/macros/echo',
  RESULT + '#fragment']) {
  test(`不正な結果取得先は本文を取得せず停止する：${location === null ? '未指定' : new URL(location).protocol + '／' + new URL(location).pathname}`, async () => {
    const app = fixture([new Response('', { status: 302, headers: location ? { location } : {} })]);
    await assert.rejects(app.load(), /転送先/);
    assert.equal(app.requests.length, 1);
  });
}

test('結果取得先からの再転送やHTTPエラーは追わず、予約送信を再実行しない', async () => {
  for (const response of [new Response('', { status: 302, headers: { location: RESULT } }),
    new Response('', { status: 503 })]) {
    const app = fixture([new Response('', { status: 303, headers: { location: RESULT } }), response]);
    await assert.rejects(app.load(), /取得できません/);
    assert.equal(app.requests.length, 2);
  }
});

test('接続先が同じローカル結果取得もGET一回で扱い、転送がない応答も維持する', async () => {
  const direct = fixture([new Response(JSON.stringify(DATA))]);
  assert.match(await direct.load(), /const PUBLISHED_MENUS/);
  assert.equal(direct.requests.length, 1);
  const local = fixture([new Response('', { status: 302, headers: { location: '/result' } }),
    new Response(JSON.stringify(DATA))], 'http://127.0.0.1:8000/exec');
  assert.match(await local.load(), /const PUBLISHED_MENUS/);
  assert.equal(local.requests.length, 2);
  assert.equal(local.requests[1].url, 'http://127.0.0.1:8000/result');
});
