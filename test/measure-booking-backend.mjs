import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../tools/measure-booking-backend.mjs';

const ENDPOINT = 'https://script.google.com/macros/s/FIXTURE_DEPLOYMENT/exec';
const RESULT_URL = 'https://script.googleusercontent.com/macros/echo?user_content_key=fixture-secret';
const PRIVATE_TEXT = '非公開の試験客・メニュー本文・private@example.invalid';
const RUN = ['--run', '--endpoint', ENDPOINT, '--interval-ms', '1'];
const ONCE = [...RUN, '--attempts', '1'];

function catalog(initialAvailability = false) {
  return {
    ok: true,
    categories: [{ id: 'cat0', name: PRIVATE_TEXT, items: [{ id: 'sm0', name: PRIVATE_TEXT, price: 1000, minutes: 30 }] }],
    coupons: [{ id: 'cp0', title: PRIVATE_TEXT, price: 2000, minutes: 60 }],
    closedDates: ['2099-01-01', { date: '2099-01-02', start: '10:00', end: '11:00' }],
    settings: { 'LINE友だち追加URL': RESULT_URL, '通知先メール': PRIVATE_TEXT },
    ...(initialAvailability ? { booked: [{ date: '2099-01-03', time: '10:00', minutes: 60, staffId: null }] } : {}),
    timing: { lockMs: 0, catalogMs: 4, totalMs: 5, [PRIVATE_TEXT]: 123, token: RESULT_URL }
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function fixture(handler = payload => jsonResponse(payload.type === 'menu'
  ? catalog(payload.initialAvailability) : { ok: true, booked: [] })) {
  let clock = 0;
  let active = 0;
  const requests = [];
  const waits = [];
  return {
    requests, waits,
    advance: milliseconds => { clock += milliseconds; },
    dependencies: {
      now: () => clock,
      sleep: async milliseconds => { assert.equal(active, 0); waits.push(milliseconds); clock += milliseconds; },
      fetch: async (url, options) => {
        assert.equal(active, 0, '同時に複数の要求を送らない');
        active++;
        const payload = options.body ? JSON.parse(options.body) : null;
        requests.push({ url, options, payload });
        try { return await handler(payload, options, requests.length, url); } finally { active--; }
      }
    }
  };
}

function privateFree(summary) {
  const output = JSON.stringify(summary);
  for (const value of [ENDPOINT, RESULT_URL, 'fixture-secret', PRIVATE_TEXT, 'private@example.invalid']) {
    assert.equal(output.includes(value), false, 'URL・秘密値・氏名・メニュー本文を出力しない');
  }
}

test('既定・明示dry-run・helpはfetchも待機も呼ばない', async () => {
  const dependencies = {
    fetch: () => assert.fail('通信しない'), now: () => assert.fail('計測しない'), sleep: () => assert.fail('待機しない')
  };
  for (const argumentsList of [[], ['--endpoint', ENDPOINT], ['--dry-run', '--endpoint', ENDPOINT]]) {
    const result = await main(argumentsList, dependencies);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.plannedAttempts, 6);
    assert.equal(result.limits.maxAttempts, 6);
    assert.deepEqual(result.cases, ['menu', 'menuWithAvailability', 'availability']);
    privateFree(result);
  }
  for (const argumentsList of [['--help'], ['--help', '--run']]) {
    assert.equal((await main(argumentsList, dependencies)).mode, 'help');
  }
});

test('実際のCLI入口も既定dry-run・help・不正引数を安全なJSONで返す', () => {
  const script = fileURLToPath(new URL('../tools/measure-booking-backend.mjs', import.meta.url));
  for (const [argumentsList, mode, status] of [[[], 'dry-run', 0], [['--help'], 'help', 0],
    [['--run'], 'error', 1], [['--endpoint', 'https://private-secret.invalid/token'], 'error', 1]]) {
    const result = spawnSync(process.execPath, [script, ...argumentsList], { encoding: 'utf8' });
    assert.equal(result.status, status);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).mode, mode);
    assert.equal(result.stdout.includes('private-secret'), false);
  }
});

test('--runは固定した3種の読取POSTだけを逐次送り、初回・後続とserver timingを分ける', async () => {
  const durations = [90, 30, 12, 20, 18, 8];
  const app = fixture((payload, options, index) => {
    app.advance(durations[index - 1]);
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    return jsonResponse(payload.type === 'menu' ? catalog(payload.initialAvailability) : { ok: true, booked: [] });
  });
  const result = await main(RUN, app.dependencies);
  assert.deepEqual(app.requests.map(request => request.payload), [
    { type: 'menu', booking: true, measure: true },
    { type: 'menu', booking: true, measure: true, initialAvailability: true },
    { type: 'availability' },
    { type: 'menu', booking: true, measure: true },
    { type: 'menu', booking: true, measure: true, initialAvailability: true },
    { type: 'availability' }
  ]);
  assert.ok(app.requests.every(request => request.url === ENDPOINT));
  assert.deepEqual(app.waits, [1, 1, 1, 1, 1]);
  assert.equal(result.attempts, 6);
  assert.equal(result.successes, 6);
  assert.equal(result.elapsedMs, 183);
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.coldStartEstimate, false);
  assert.equal(result.firstAttemptScope, 'per-case');
  assert.deepEqual(result.firstRequest, { case: 'menu', outcome: 'success', roundTripMs: 90 });
  assert.deepEqual(result.cases.menu.roundTripMs.all, { count: 2, min: 20, max: 90, mean: 55, median: 55, p95: 90 });
  assert.equal(result.cases.menu.roundTripMs.first.mean, 90);
  assert.equal(result.cases.menu.roundTripMs.later.mean, 20);
  assert.equal(result.cases.menuWithAvailability.roundTripMs.first.mean, 30);
  assert.equal(result.cases.availability.roundTripMs.later.mean, 8);
  assert.equal(result.cases.menu.serverTimingMs.totalMs.all.mean, 5);
  assert.equal(result.cases.menu.serverTimingMs.lockMs.all.count, 2);
  assert.equal(result.cases.menu.serverTimingMs.lockMs.all.mean, 0);
  assert.equal(result.cases.availability.serverTimingMs.totalMs.all.count, 0);
  privateFree(result);
});

test('各ケース4回・全体12回までの指定を守り、奇数medianとnearest-rankを算出する', async () => {
  const values = [3, 1, 8];
  let menuAttempts = 0;
  const app = fixture(payload => {
    if (payload.type === 'menu' && !payload.initialAvailability) app.advance(values[menuAttempts++]);
    return jsonResponse(payload.type === 'menu' ? catalog(payload.initialAvailability) : { ok: true, booked: [] });
  });
  const result = await main([...RUN, '--attempts', '3', '--max-attempts', '9'], app.dependencies);
  assert.equal(result.attempts, 9);
  assert.deepEqual(result.cases.menu.roundTripMs.all, { count: 3, min: 1, max: 8, mean: 4, median: 3, p95: 8 });
  const maximum = fixture();
  assert.equal((await main([...RUN, '--attempts', '4', '--max-attempts', '12'], maximum.dependencies)).attempts, 12);
});

test('302/303は許可したGoogle結果URLへ一度だけGETし、POST本文を転送しない', async () => {
  for (const status of [302, 303]) {
    const app = fixture((payload, options, index, url) => {
      if (options.method === 'POST') return new Response(null, { status, headers: { Location: RESULT_URL } });
      assert.equal(url, RESULT_URL);
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      assert.equal(options.headers, undefined);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'manual');
      const request = app.requests[index - 2];
      return jsonResponse(request.payload.type === 'menu'
        ? catalog(request.payload.initialAvailability) : { ok: true, booked: [] });
    });
    const result = await main(ONCE, app.dependencies);
    assert.equal(result.attempts, 3);
    assert.equal(result.successes, 3);
    assert.equal(app.requests.length, 6);
    privateFree(result);
  }
});

test('外部・ログイン・HTTP・資格情報・別パスへの転送と307/308・転送ループを拒否する', async () => {
  const locations = [
    'https://accounts.google.com/login', 'https://private-secret.invalid/token',
    'https://script.googleusercontent.com.evil.invalid/macros/echo',
    'http://script.googleusercontent.com/macros/echo', 'https://token@script.googleusercontent.com/macros/echo',
    'https://script.googleusercontent.com:444/macros/echo', 'https://script.googleusercontent.com/login',
    RESULT_URL + '#token', '/macros/echo', null
  ];
  for (const location of locations) {
    const app = fixture(() => new Response(null, { status: 302, headers: location ? { Location: location } : {} }));
    const result = await main(ONCE, app.dependencies);
    assert.equal(result.cases.menu.failures['redirect-rejected'], 1);
    assert.equal(result.successes, 0);
    assert.equal(app.requests.length, 3);
    privateFree(result);
  }
  for (const status of [301, 307, 308]) {
    const app = fixture(() => new Response(null, { status, headers: { Location: RESULT_URL } }));
    assert.equal((await main(ONCE, app.dependencies)).cases.menu.failures['redirect-rejected'], 1);
    assert.equal(app.requests.length, 3);
  }
  const loop = fixture(() => new Response(null, { status: 302, headers: { Location: RESULT_URL } }));
  assert.equal((await main(ONCE, loop.dependencies)).successes, 0);
  assert.equal(loop.requests.length, 6);
  const followed = fixture(() => ({ ok: true, status: 200, redirected: true,
    text: () => assert.fail('自動転送された応答の本文を読まない') }));
  assert.equal((await main(ONCE, followed.dependencies)).cases.menu.failures['redirect-rejected'], 1);
  assert.equal(followed.requests.length, 3);
});

test('HTTP・API失敗・HTML・JSON不正・形不正・ネットワーク障害は別々に数え、本文や例外を出さない', async () => {
  const variants = [
    ['http-error', () => new Response(PRIVATE_TEXT, { status: 503 })],
    ['api-error', () => jsonResponse({ ok: false, error: PRIVATE_TEXT, token: RESULT_URL })],
    ['html', () => new Response(PRIVATE_TEXT, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })],
    ['html', () => new Response('<!DOCTYPE html><html>' + PRIVATE_TEXT)],
    ['invalid-json', () => new Response(PRIVATE_TEXT)],
    ['invalid-response', () => jsonResponse({ ok: true })],
    ['network-error', () => { throw new Error(RESULT_URL + PRIVATE_TEXT); }],
    ['network-error', () => ({ ok: true, status: 200, headers: new Headers(),
      text: async () => { throw new Error(PRIVATE_TEXT); } })]
  ];
  for (const [outcome, response] of variants) {
    const app = fixture(response);
    const result = await main(ONCE, app.dependencies);
    assert.equal(result.attempts, 3);
    assert.equal(result.successes, 0);
    assert.equal(result.cases.menu.failures[outcome], 1);
    assert.equal(result.cases.menu.roundTripMs.all.count, 0);
    assert.equal(result.cases.menu.failedRoundTripMs.count, 1);
    assert.equal(result.cases.menu.serverTimingMs.totalMs.all.count, 0);
    assert.deepEqual(result.cases.menu.httpStatuses, outcome === 'http-error' ? { 503: 1 } : {});
    assert.equal(app.requests.length, 3, '失敗直後の追加再送をしない');
    privateFree(result);
  }
});

test('okだけの応答・壊れた配列要素・初期空席欠落を成功にせず、正しい空配列は受け入れる', async () => {
  const mutations = [
    data => { data.categories = null; }, data => { data.categories = [null]; },
    data => { data.categories[0].items = 'arrayではない'; },
    data => { data.categories[0].items[0].minutes = -1; },
    data => { data.coupons = {}; }, data => { data.coupons[0].price = '1000'; },
    data => { data.closedDates = null; }, data => { data.closedDates = [{ date: '2099-01-01' }]; },
    data => { data.settings = []; }, data => { delete data.booked; },
    data => { data.booked = [PRIVATE_TEXT]; }, data => { data.booked = [{ date: '2099-01-03', time: '25:00', minutes: 60, staffId: null }]; }
  ];
  for (const mutate of mutations) {
    const app = fixture(payload => {
      const data = payload.type === 'menu' ? catalog(payload.initialAvailability) : { ok: true, booked: [] };
      if (payload.initialAvailability) mutate(data);
      return jsonResponse(data);
    });
    const result = await main(ONCE, app.dependencies);
    assert.equal(result.cases.menuWithAvailability.failures['invalid-response'], 1);
    assert.equal(result.successes, 2);
    privateFree(result);
  }
  const empty = fixture(payload => jsonResponse(payload.type === 'menu'
    ? { ok: true, categories: [], coupons: [], closedDates: [], settings: {}, ...(payload.initialAvailability ? { booked: [] } : {}) }
    : { ok: true, booked: [] }));
  assert.equal((await main(ONCE, empty.dependencies)).successes, 3);
});

test('availabilityもokの型・booked配列と各要素を検証する', async () => {
  for (const data of [null, [], { ok: 'true', booked: [] }, { ok: true, booked: null },
    { ok: true, booked: [null] }, { ok: true, booked: [{ date: '2099-01-03', time: '10:00', minutes: -1, staffId: null }] }]) {
    const app = fixture(payload => jsonResponse(payload.type === 'menu' ? catalog(payload.initialAvailability) : data));
    const result = await main(ONCE, app.dependencies);
    assert.equal(result.cases.availability.failures['invalid-response'], 1);
    assert.equal(result.successes, 2);
  }
});

test('有限の非負numberだけをtimingへ集計し、未知のキー・負数・文字列・nullを除外する', async () => {
  for (const value of [-1, '12', null, true, NaN, Infinity, -Infinity, { value: 12 }]) {
    const app = fixture(payload => {
      const data = payload.type === 'menu' ? catalog(payload.initialAvailability) : { ok: true, booked: [] };
      data.timing = { lockMs: value, catalogMs: 0, totalMs: 7, [PRIVATE_TEXT]: 10 };
      return jsonResponse(data);
    });
    const result = await main(RUN, app.dependencies);
    assert.equal(result.successes, 6);
    assert.equal(result.cases.menu.serverTimingMs.lockMs.all.count, 0);
    assert.equal(result.cases.menu.serverTimingMs.catalogMs.all.mean, 0);
    assert.equal(result.cases.menu.serverTimingMs.totalMs.all.mean, 7);
    assert.deepEqual(Object.keys(result.cases.menu.serverTimingMs), ['lockMs', 'catalogMs', 'totalMs']);
    privateFree(result);
  }
  for (const timing of [undefined, null, [], PRIVATE_TEXT]) {
    const app = fixture(payload => {
      const data = payload.type === 'menu' ? catalog(payload.initialAvailability) : { ok: true, booked: [] };
      data.timing = timing;
      return jsonResponse(data);
    });
    const result = await main(ONCE, app.dependencies);
    assert.equal(result.successes, 3);
    assert.equal(result.cases.menu.serverTimingMs.totalMs.all.count, 0);
  }
});

test('大きい有限timingの平均・中央値もoverflowせず、欠落をゼロ扱いしない', async () => {
  const app = fixture(payload => {
    const data = payload.type === 'menu' ? catalog(payload.initialAvailability) : { ok: true, booked: [] };
    data.timing = { totalMs: 1e308 };
    return jsonResponse(data);
  });
  const result = await main(RUN, app.dependencies);
  assert.equal(result.cases.menu.serverTimingMs.totalMs.all.mean, 1e308);
  assert.equal(result.cases.menu.serverTimingMs.totalMs.all.median, 1e308);
  assert.equal(result.cases.menu.serverTimingMs.lockMs.all.mean, null);
});

test('欠落・負数が混ざったtimingの分母は有効な値の件数だけにする', async () => {
  let menuAttempts = 0;
  const app = fixture(payload => {
    const data = payload.type === 'menu' ? catalog(payload.initialAvailability) : { ok: true, booked: [] };
    if (payload.type === 'menu' && !payload.initialAvailability) {
      data.timing = { totalMs: [5, -1, undefined][menuAttempts++] };
    }
    return jsonResponse(data);
  });
  const result = await main([...RUN, '--attempts', '3', '--max-attempts', '9'], app.dependencies);
  assert.equal(result.cases.menu.successes, 3);
  assert.equal(result.cases.menu.serverTimingMs.totalMs.all.count, 1);
  assert.equal(result.cases.menu.serverTimingMs.totalMs.all.mean, 5);
  assert.equal(result.cases.menu.serverTimingMs.totalMs.first.count, 1);
  assert.equal(result.cases.menu.serverTimingMs.totalMs.later.count, 0);
});

test('初回が失敗しても後続成功を初回へ繰り上げない', async () => {
  const app = fixture((payload, options, index) => index === 1
    ? jsonResponse({ ok: false, error: PRIVATE_TEXT })
    : jsonResponse(payload.type === 'menu' ? catalog(payload.initialAvailability) : { ok: true, booked: [] }));
  const result = await main(RUN, app.dependencies);
  assert.equal(result.successes, 5);
  assert.equal(result.cases.menu.roundTripMs.first.count, 0);
  assert.equal(result.cases.menu.roundTripMs.later.count, 1);
  assert.equal(result.firstRequest.outcome, 'api-error');
});

test('fetchと本文がabortを無視して止まってもtimeoutし、同じsignalを中止する', async () => {
  for (const stage of ['fetch', 'body', 'redirect']) {
    let signal;
    const app = fixture((payload, options) => {
      signal = options.signal;
      if (stage === 'redirect' && options.method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: RESULT_URL } });
      }
      const pending = new Promise(() => {});
      return stage === 'body' ? { ok: true, status: 200, headers: new Headers(), text: () => pending } : pending;
    });
    const result = await main([...ONCE, '--timeout-ms', '5'], app.dependencies);
    assert.equal(result.attempts, 1);
    assert.equal(result.successes, 0);
    assert.equal(result.stopReason, 'timeout');
    assert.equal(result.cases.menu.failures.timeout, 1);
    assert.equal(signal.aborted, true);
    assert.equal(app.requests.length, stage === 'redirect' ? 2 : 1);
    privateFree(result);
  }
});

test('timeout後に遅れて転送応答が届いても結果URLへ新しい要求を送らない', async () => {
  let complete;
  const app = fixture(() => new Promise(resolve => { complete = resolve; }));
  const result = await main([...ONCE, '--timeout-ms', '5'], app.dependencies);
  assert.equal(result.stopReason, 'timeout');
  complete(new Response(null, { status: 302, headers: { Location: RESULT_URL } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.requests.length, 1);
});

test('全体deadlineを接続・本文の期限にも適用し、期限後の要求を送らない', async () => {
  for (const stage of ['fetch', 'body']) {
    const signals = [];
    const app = fixture((payload, options) => {
      signals.push(options.signal);
      const pending = new Promise(() => {});
      return stage === 'body' ? { ok: true, status: 200, headers: new Headers(), text: () => pending } : pending;
    });
    const result = await main([...ONCE, '--timeout-ms', '100', '--deadline-ms', '5'], app.dependencies);
    assert.equal(result.stopReason, 'deadline');
    assert.equal(result.attempts, 1);
    assert.equal(app.requests.length, 1);
    assert.equal(signals[0].aborted, true);
    assert.equal(result.cases.menu.failures.deadline, 1);
  }
});

test('開始直前にdeadlineを越えた場合はfetchも試行件数への加算も行わない', async () => {
  const ticks = [0, 4, 6];
  const result = await main([...ONCE, '--deadline-ms', '5'], {
    now: () => ticks.shift() ?? 6,
    fetch: () => assert.fail('期限後に送信しない'),
    sleep: () => assert.fail('初回前には待機しない')
  });
  assert.equal(result.stopReason, 'deadline');
  assert.equal(result.attempts, 0);
  assert.equal(result.firstRequest, null);
});

test('期限までに間隔を確保できなければ次を送らず、待機中に期限を越えても次を送らない', async () => {
  const app = fixture(payload => {
    app.advance(4);
    return jsonResponse(catalog(payload.initialAvailability));
  });
  const result = await main([...ONCE, '--deadline-ms', '5'], app.dependencies);
  assert.equal(result.stopReason, 'deadline');
  assert.equal(result.attempts, 1);
  assert.deepEqual(app.waits, []);
  const oversleep = fixture();
  oversleep.dependencies.sleep = async () => oversleep.advance(10);
  const delayed = await main([...ONCE, '--deadline-ms', '5'], oversleep.dependencies);
  assert.equal(delayed.stopReason, 'deadline');
  assert.equal(oversleep.requests.length, 1);
});

test('timer発火が遅れても計測上のtimeout・deadline超過を成功扱いにしない', async () => {
  for (const [argumentsList, outcome] of [
    [[...ONCE, '--timeout-ms', '5'], 'timeout'], [[...ONCE, '--deadline-ms', '5'], 'deadline']
  ]) {
    const app = fixture(payload => { app.advance(6); return jsonResponse(catalog(payload.initialAvailability)); });
    const result = await main(argumentsList, app.dependencies);
    assert.equal(result.cases.menu.failures[outcome], 1);
    assert.equal(result.cases.menu.successes, 0);
    assert.equal(app.requests[0].options.signal.aborted, true);
  }
});

test('転送応答が期限後に届いた場合も、timer発火を待たずGETを止める', async () => {
  for (const [argumentsList, outcome] of [
    [[...ONCE, '--timeout-ms', '5'], 'timeout'], [[...ONCE, '--deadline-ms', '5'], 'deadline']
  ]) {
    const app = fixture(() => {
      app.advance(6);
      return new Response(null, { status: 302, headers: { Location: RESULT_URL } });
    });
    const result = await main(argumentsList, app.dependencies);
    assert.equal(result.stopReason, outcome);
    assert.equal(result.cases.menu.failures[outcome], 1);
    assert.equal(app.requests.length, 1);
  }
});

test('不正endpointはdry-runでも拒否し、資格情報や入力値を出力しない', async () => {
  const endpoints = [
    '', 'not a URL', 'http://script.google.com/macros/s/FIXTURE_DEPLOYMENT/exec',
    'https://private-secret.invalid/exec', ENDPOINT.replace('script.google.com', 'script.google.com.evil.invalid'),
    ENDPOINT.replace('https://', 'https://token:password@'), ENDPOINT + '?token=fixture-secret',
    ENDPOINT + '#fixture-secret', ENDPOINT.replace('/exec', '/dev'), ENDPOINT.replace('.com/', '.com:444/'),
    ENDPOINT + '\n', ENDPOINT.replace('/macros/', '/macros\\'), 'file:///private-secret',
    'https://script.google.com/macros/s/%2e%2e/exec'
  ];
  for (const endpoint of endpoints) {
    for (const mode of [[], ['--run']]) {
      const result = await main([...mode, '--endpoint', endpoint], { fetch: () => assert.fail('通信しない') });
      assert.deepEqual(result, { mode: 'error', error: 'invalid-endpoint' });
      privateFree(result);
    }
  }
});

test('未指定endpoint・不正数値・試行上限・重複・未知操作を通信前に拒否する', async () => {
  const invalid = [
    [['--run'], 'endpoint-required'], [['--endpoint'], 'invalid-endpoint'],
    [['--run', '--dry-run'], 'conflicting-modes'], [['--attempts', '3'], 'attempt-limit'],
    [['--max-attempts', '13'], 'attempt-limit'], [['--max-attempts', '2'], 'attempt-limit'],
    [['--attempts', '2', '--attempts', '2'], 'duplicate-option'], [['--reserve'], 'unknown-option'],
    [['--token', 'fixture-secret'], 'unknown-option']
  ];
  for (const option of ['--attempts', '--max-attempts', '--timeout-ms', '--deadline-ms', '--interval-ms']) {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '2147483648', 'fixture-secret']) {
      invalid.push([[option, value], 'invalid-number']);
    }
    invalid.push([[option], 'invalid-number']);
  }
  for (const [argumentsList, error] of invalid) {
    const result = await main(argumentsList, { fetch: () => assert.fail('通信しない') });
    assert.deepEqual(result, { mode: 'error', error });
    privateFree(result);
  }
});
