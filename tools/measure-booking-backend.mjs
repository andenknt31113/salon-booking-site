import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const DEFAULTS = Object.freeze({ attempts: 2, maxAttempts: 6, timeoutMs: 15000, deadlineMs: 120000, intervalMs: 1000 });
const HARD_MAX_ATTEMPTS = 12;
const MAX_TIMER_MS = 2147483647;
const RESULT_REDIRECT_LIMIT = 1;
const P95_QUANTILE = 0.95;
const ENDPOINT_HOST = 'script.google.com';
const RESULT_HOST = 'script.googleusercontent.com';
const TIMING_KEYS = ['lockMs', 'catalogMs', 'totalMs'];
const REDIRECT_STATUSES = [302, 303];
const NUMERIC_OPTIONS = {
  '--attempts': 'attempts', '--max-attempts': 'maxAttempts', '--timeout-ms': 'timeoutMs',
  '--deadline-ms': 'deadlineMs', '--interval-ms': 'intervalMs'
};
const CASES = [
  { name: 'menu', payload: { type: 'menu', booking: true, measure: true } },
  { name: 'menuWithAvailability', payload: { type: 'menu', booking: true, measure: true, initialAvailability: true } },
  { name: 'availability', payload: { type: 'availability' } }
];
const DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function secureUrl(value) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new Error('invalid-endpoint');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new Error('invalid-endpoint');
  }
  return url;
}

function endpointUrl(value) {
  try {
    const url = secureUrl(value);
    if (url.hostname !== ENDPOINT_HOST || url.search || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) {
      throw new Error();
    }
    return url.href;
  } catch {
    throw new Error('invalid-endpoint');
  }
}

function parseOptions(argumentsList) {
  const options = { ...DEFAULTS, run: false, help: false, endpoint: null };
  const seen = new Set();
  for (let index = 0; index < argumentsList.length; index++) {
    const option = argumentsList[index];
    if (seen.has(option)) throw new Error('duplicate-option');
    seen.add(option);
    if (option === '--run') options.run = true;
    else if (option === '--help') options.help = true;
    else if (option === '--dry-run') options.run = false;
    else if (option === '--endpoint' || Object.hasOwn(NUMERIC_OPTIONS, option)) {
      const value = argumentsList[++index];
      if (option === '--endpoint') options.endpoint = endpointUrl(value);
      else {
        const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_TIMER_MS) throw new Error('invalid-number');
        options[NUMERIC_OPTIONS[option]] = number;
      }
    } else throw new Error('unknown-option');
  }
  if (seen.has('--run') && seen.has('--dry-run')) throw new Error('conflicting-modes');
  if (options.maxAttempts > HARD_MAX_ATTEMPTS || options.attempts * CASES.length > options.maxAttempts) {
    throw new Error('attempt-limit');
  }
  if (options.run && !options.help && !options.endpoint) throw new Error('endpoint-required');
  return options;
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0;
const date = value => typeof value === 'string' && DATE_PATTERN.test(value);
const time = value => typeof value === 'string' && TIME_PATTERN.test(value);

function validBooked(value) {
  return Array.isArray(value) && value.every(slot => record(slot) && date(slot.date) && time(slot.time)
    && nonnegative(slot.minutes) && slot.minutes > 0 && (slot.staffId === null || typeof slot.staffId === 'string'));
}

function validResponse(data, scenario) {
  if (!record(data) || data.ok !== true) return false;
  if (scenario.name === 'availability') return validBooked(data.booked);
  const item = (value, titleKey) => record(value) && text(value.id) && text(value[titleKey])
    && nonnegative(value.price) && nonnegative(value.minutes) && value.minutes > 0;
  return Array.isArray(data.categories) && data.categories.every(category => record(category)
    && text(category.id) && text(category.name) && Array.isArray(category.items)
    && category.items.every(value => item(value, 'name')))
    && Array.isArray(data.coupons) && data.coupons.every(value => item(value, 'title'))
    && Array.isArray(data.closedDates) && data.closedDates.every(value => date(value)
      || (record(value) && date(value.date) && time(value.start) && time(value.end) && value.start < value.end))
    && record(data.settings)
    && (!scenario.payload.initialAvailability || validBooked(data.booked));
}

async function readResponse(endpoint, scenario, fetch, signal, checkExpiry) {
  let target = endpoint;
  let options = {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(scenario.payload), redirect: 'manual', credentials: 'omit', cache: 'no-store', signal
  };
  let redirects = 0;
  while (true) {
    checkExpiry();
    const response = await fetch(target, options);
    checkExpiry();
    if (response.redirected) return { outcome: 'redirect-rejected' };
    if (response.status >= 300 && response.status < 400) {
      if (!REDIRECT_STATUSES.includes(response.status) || redirects >= RESULT_REDIRECT_LIMIT) {
        return { outcome: 'redirect-rejected' };
      }
      try {
        const destination = secureUrl(response.headers.get('location'));
        if (destination.hostname !== RESULT_HOST || destination.pathname !== '/macros/echo') throw new Error();
        target = destination.href;
      } catch {
        return { outcome: 'redirect-rejected' };
      }
      redirects++;
      options = { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal };
      continue;
    }
    if (!response.ok) return { outcome: 'http-error', httpStatus: response.status };
    const body = await response.text();
    checkExpiry();
    if (/\btext\/html\b/i.test(response.headers.get('content-type') || '') || /^\s*</.test(body)) {
      return { outcome: 'html' };
    }
    let data;
    try { data = JSON.parse(body); } catch { return { outcome: 'invalid-json' }; }
    if (record(data) && data.ok === false) return { outcome: 'api-error' };
    if (!validResponse(data, scenario)) return { outcome: 'invalid-response' };
    const timing = {};
    for (const key of TIMING_KEYS) {
      if (record(data.timing) && nonnegative(data.timing[key])) timing[key] = data.timing[key];
    }
    return { outcome: 'success', timing };
  }
}

async function measureAttempt(options, scenario, dependencies, deadlineAt) {
  const started = dependencies.now();
  const remainingMs = deadlineAt - started;
  if (remainingMs <= 0) return null;
  const timeoutMs = Math.min(options.timeoutMs, remainingMs);
  const expiry = remainingMs <= options.timeoutMs ? 'deadline' : 'timeout';
  const controller = new AbortController();
  let expired = false;
  let timer;
  const checkExpiry = () => {
    if (dependencies.now() - started >= timeoutMs) {
      expired = true;
      controller.abort();
    }
    controller.signal.throwIfAborted();
  };
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      reject(new Error());
    }, timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([
      readResponse(options.endpoint, scenario, dependencies.fetch, controller.signal, checkExpiry), timeout
    ]);
  } catch {
    result = { outcome: expired ? expiry : 'network-error' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  const ended = dependencies.now();
  const roundTripMs = Math.max(0, ended - started);
  if (ended >= deadlineAt || roundTripMs >= timeoutMs) {
    result = { outcome: ended >= deadlineAt ? 'deadline' : expiry };
  }
  return { ...result, roundTripMs };
}

function distribution(values) {
  const sorted = values.filter(nonnegative).sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, min: null, max: null, mean: null, median: null, p95: null };
  const middle = Math.floor(sorted.length / 2);
  const mean = sorted.reduce((average, value, index) => average + (value - average) / (index + 1), 0);
  const median = sorted.length % 2 ? sorted[middle]
    : sorted[middle - 1] + (sorted[middle] - sorted[middle - 1]) / 2;
  return { count: sorted.length, min: sorted[0], max: sorted.at(-1), mean, median,
    p95: sorted[Math.ceil(sorted.length * P95_QUANTILE) - 1] };
}

function groups(samples, value) {
  return {
    all: distribution(samples.map(value)),
    first: distribution(samples.filter(sample => sample.attempt === 1).map(value)),
    later: distribution(samples.filter(sample => sample.attempt > 1).map(value))
  };
}

function summarize(samples) {
  const successful = samples.filter(sample => sample.outcome === 'success');
  const failed = samples.filter(sample => sample.outcome !== 'success');
  const failures = {};
  const httpStatuses = {};
  for (const sample of failed) {
    failures[sample.outcome] = (failures[sample.outcome] || 0) + 1;
    if (Number.isInteger(sample.httpStatus)) httpStatuses[sample.httpStatus] = (httpStatuses[sample.httpStatus] || 0) + 1;
  }
  return {
    attempts: samples.length, successes: successful.length, failures, httpStatuses,
    roundTripMs: groups(successful, sample => sample.roundTripMs),
    failedRoundTripMs: distribution(failed.map(sample => sample.roundTripMs)),
    serverTimingMs: Object.fromEntries(TIMING_KEYS.map(key => [key, groups(successful, sample => sample.timing[key])]))
  };
}

async function measure(options, dependencies) {
  const started = dependencies.now();
  const deadlineAt = started + options.deadlineMs;
  const samples = Object.fromEntries(CASES.map(scenario => [scenario.name, []]));
  let attempts = 0;
  let stopReason = 'completed';
  let firstRequest = null;
  measurements: for (let attempt = 1; attempt <= options.attempts; attempt++) {
    for (const scenario of CASES) {
      let remainingMs = deadlineAt - dependencies.now();
      if (attempts) {
        if (remainingMs <= options.intervalMs) { stopReason = 'deadline'; break measurements; }
        await dependencies.sleep(options.intervalMs);
        remainingMs = deadlineAt - dependencies.now();
      }
      if (remainingMs <= 0) { stopReason = 'deadline'; break measurements; }
      const sample = await measureAttempt(options, scenario, dependencies, deadlineAt);
      if (!sample) { stopReason = 'deadline'; break measurements; }
      samples[scenario.name].push({ ...sample, attempt });
      attempts++;
      if (!firstRequest) firstRequest = { case: scenario.name, outcome: sample.outcome, roundTripMs: sample.roundTripMs };
      if (sample.outcome === 'deadline' || sample.outcome === 'timeout') {
        stopReason = sample.outcome;
        break measurements;
      }
    }
  }
  const cases = Object.fromEntries(CASES.map(scenario => [scenario.name, summarize(samples[scenario.name])]));
  return {
    mode: 'run', plannedAttempts: options.attempts * CASES.length, attempts,
    successes: Object.values(cases).reduce((count, scenario) => count + scenario.successes, 0),
    stopReason, elapsedMs: Math.max(0, dependencies.now() - started), firstRequest,
    order: 'round-robin', firstAttemptScope: 'per-case', percentileMethod: 'nearest-rank', coldStartEstimate: false, cases
  };
}

export async function main(argumentsList = [], dependencies = {}) {
  let options;
  try { options = parseOptions(argumentsList); } catch (error) { return { mode: 'error', error: error.message }; }
  const limits = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, options[key]]));
  if (options.help) {
    return {
      mode: 'help',
      usage: 'node tools/measure-booking-backend.mjs [--dry-run | --run --endpoint <GAS exec URL>] [--attempts N] [--max-attempts N] [--timeout-ms N] [--deadline-ms N] [--interval-ms N]',
      defaults: DEFAULTS, hardMaxAttempts: HARD_MAX_ATTEMPTS,
      notes: [
        '既定は通信しない。--attempts は各ケースの回数、--max-attempts は全体の上限。',
        'menu・初期空席ありmenu・availabilityを少数ずつ逐次計測する。失敗時の自動再送はしない。',
        '接続先はHTTPSのGAS /exec。302/303はGoogleの結果取得先へ一度だけGETする。',
        'timeoutは本文取得まで、deadlineは間隔を含む全体期限。期限後に新しい要求を送らない。',
        'timeout時は以後の計測も止める。送信済みGASの実行終了は保証しない。',
        '成功した往復時間とGASが報告したtimingを別集計。firstは各ケースの最初の試行。',
        '少数試行のp95はnearest-rank。失敗・欠落・不正なtimingは成功時間へ混ぜない。',
        '往復時間には通信と本文読込が含まれる。初回との差からcold start時間は特定できない。',
        'URL・応答本文・個人情報・未知のtiming項目は出力しない。'
      ]
    };
  }
  if (!options.run) return { mode: 'dry-run', endpointProvided: Boolean(options.endpoint),
    plannedAttempts: options.attempts * CASES.length, cases: CASES.map(scenario => scenario.name), limits };
  try {
    return await measure(options, {
      fetch: dependencies.fetch ?? globalThis.fetch,
      now: dependencies.now ?? (() => performance.now()),
      sleep: dependencies.sleep ?? delay
    });
  } catch {
    return { mode: 'error', error: 'measurement-failed' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await main(process.argv.slice(2));
  console.log(JSON.stringify(summary));
  if (summary.mode === 'error' || (summary.mode === 'run'
      && (summary.stopReason !== 'completed' || summary.successes !== summary.plannedAttempts))) process.exitCode = 1;
}
