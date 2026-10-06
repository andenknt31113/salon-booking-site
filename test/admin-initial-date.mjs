import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const COMMON_SOURCE = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const DATE_KEY = COMMON_SOURCE.match(/^function toKey\(d\) \{[^]*?^}/m)[0];
const PAD = COMMON_SOURCE.match(/^const pad2 = .*;$/m)[0];
const INITIALIZER = SOURCE.match(/^function initializeReservationDate\(\) \{[^]*?^}/m)?.[0];
const MIDNIGHTS = ['2030-01-14T14:59:59.999Z', '2030-01-14T15:00:00.000Z', '2030-12-31T15:00:00.000Z'];

function fixture({ value = '', now = MIDNIGHTS[0] } = {}) {
  const field = { value };
  const calls = [];
  const context = vm.createContext({
    $: selector => { assert.equal(selector, '#filter-date'); return field; },
    Date: class extends Date { constructor() { super(now); } }
  });
  vm.runInContext([PAD, DATE_KEY, INITIALIZER || ''].join('\n'), context);
  const dateKey = context.toKey;
  context.toKey = date => { calls.push(date.getTime()); return dateKey(date); };
  return { context, field, calls };
}

for (const now of MIDNIGHTS) {
  test(`初回は共通の日付基準で当日を表示し、日付・年の境界を取り違えない：${now}`, () => {
    const app = fixture({ now });
    assert.equal(typeof app.context.initializeReservationDate, 'function');
    app.context.initializeReservationDate();
    assert.equal(app.field.value, new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)));
    assert.deepEqual(app.calls, [Date.parse(now)]);
    app.context.initializeReservationDate();
    assert.deepEqual(app.calls, [Date.parse(now)], '設定済みの日付を計算し直さない');
  });
}

for (const value of ['2029-12-01', '2030-01-15', '2030-02-01']) {
  test(`初回前に指定した過去・当日・未来の日付は上書きしない：${value}`, () => {
    const app = fixture({ value });
    app.context.initializeReservationDate();
    assert.equal(app.field.value, value);
    assert.deepEqual(app.calls, []);
  });
}

test('当日を求められない場合に不正な日付を表示へ書き込まない', () => {
  const app = fixture();
  app.context.toKey = () => { throw new Error('架空の日付取得障害'); };
  assert.throws(() => app.context.initializeReservationDate(), /架空の日付取得障害/);
  assert.equal(app.field.value, '');
});

test('日付の初期化は画面起動で一度だけ行い、更新や再ログインで絞り込みを戻さない', () => {
  assert.equal((SOURCE.match(/initializeReservationDate\(\);/g) || []).length, 1);
  assert.match(SOURCE, /document\.addEventListener\('DOMContentLoaded', \(\) => \{\s*initializeReservationDate\(\);/);
  const open = SOURCE.match(/^async function openDashboard\([^]*?^}/m)[0];
  assert.doesNotMatch(open, /initializeReservationDate|#filter-date/);
});

const EMPTY_DATE = '2030-01-15';
const EMPTY_RENDER = SOURCE.match(/^function renderReservations\(\) \{[^]*?^}/m)[0];
for (const scenario of [
  { label: '初回の今日', date: EMPTY_DATE, status: 'all', rows: [], global: true },
  { label: '日付なし', date: '', status: 'all', rows: [], global: true },
  { label: '日付と状態で絞る', date: EMPTY_DATE, status: 'cancelled', rows: [], global: true },
  { label: '他の日の予約はある', date: EMPTY_DATE, status: 'all', rows: [{ date: '2030-01-16' }], global: false },
  { label: '状態の異なる予約はある', date: '', status: 'cancelled', rows: [{ date: EMPTY_DATE }], global: false }
]) {
  test(`台帳全体の0件と絞込の0件を区別し、選択条件を保持する：${scenario.label}`, () => {
    const fields = { '#filter-date': { value: scenario.date }, '#filter-status': { value: scenario.status },
      '#admin-rows': { innerHTML: '' } };
    const context = vm.createContext({
      $: selector => { assert.ok(fields[selector], selector); return fields[selector]; },
      adminData: { reservations: scenario.rows, closedDates: [] },
      renderedReservationFilters: null, showPast: false,
      reconcilePhoneResult() {}, renderMailAlert() {}, renderReservationFilterSummary() {},
      guardNoteFilters: () => true, filteredReservations: () => [],
      hasPendingReservationDetails: () => false,
      toKey: () => EMPTY_DATE, esc: text => text
    });
    vm.runInContext(EMPTY_RENDER, context);
    context.renderReservations();
    assert.equal(fields['#admin-rows'].innerHTML.includes('まだご予約はありません'), scenario.global);
    assert.equal(fields['#admin-rows'].innerHTML.includes('この条件に合うご予約はありません'), !scenario.global);
    assert.equal(fields['#filter-date'].value, scenario.date);
    assert.equal(fields['#filter-status'].value, scenario.status);
  });
}
