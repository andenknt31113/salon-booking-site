import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const BOOKING = { code: 'LM-ROUTE', date: '2030-10-08', time: '10:00', endTime: '11:00',
  totalMinutes: 60, totalPrice: 4000, staffId: 'st01',
  customer: { name: '操作試験', kana: 'ソウサシケン', tel: '00000000000', email: 'route@example.test' } };
const ROUTES = {
  menu: 'doMenu_', adminLogin: 'doAdminLogin_', adminData: 'doAdminData_',
  adminSave: 'doAdminSave_', adminUpload: 'doAdminUpload_', adminAdd: 'doAdminAdd_',
  adminAddStatus: 'doAdminAddStatus_', adminNote: 'doAdminNote_', adminChange: 'doAdminChange_',
  availability: 'doAvailability_', lookup: 'doLookup_', cancel: 'doCancel_',
  change: 'doChange_', review: 'doReview_', reserve: 'doReserve_'
};

function fixture({ occupied = false } = {}) {
  const events = [];
  const logs = [];
  const calls = [];
  const ledger = {};
  let held = false;
  const context = vm.createContext({
    console: { error: error => logs.push(String(error)), warn() {}, log() {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    LockService: { getScriptLock() {
      events.push('lock');
      return { waitLock() {
        if (occupied) throw new Error('試験用のロック待機失敗');
        assert.equal(held, false);
        held = true;
      }, releaseLock() { assert.equal(held, true); held = false; events.push('release'); } };
    } }
  });
  vm.runInContext(SOURCE, context);
  context.recoverBookingChange_ = () => { assert.equal(held, true); events.push('recovery'); };
  context.requireAdmin_ = () => { assert.equal(held, true); events.push('authorization'); };
  context.getSheet_ = () => { assert.equal(held, true); events.push('ledger'); return ledger; };
  context.googleAdminConfig_ = () => { assert.equal(held, false); events.push('config'); return { projectId: 'route-test' }; };
  context.doGoogleAdmin_ = request => {
    assert.equal(held, false);
    calls.push({ handler: 'doGoogleAdmin_', request });
    return { ok: true, handler: 'doGoogleAdmin_' };
  };
  for (const handler of Object.values(ROUTES)) {
    context[handler] = (...args) => {
      assert.equal(held, true);
      const request = args[0] === ledger ? args[1] : args[0];
      calls.push({ handler, request, args });
      return { ok: true, handler };
    };
  }
  return { events, calls, logs, held: () => held,
    send: request => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(request) } })) };
}

for (const type of ['', ' ', 'booking', 'Reserve', 'reservee', 'adminDelete', '__proto__', 'constructor']) {
  test(`未対応の操作 ${JSON.stringify(type)} は予約・台帳・ロックへ進めない`, () => {
    const app = fixture();
    const result = app.send({ ...BOOKING, type });
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.match(result.error, /操作/);
    assert.deepEqual(app.calls, []);
    assert.deepEqual(app.events, []);
    assert.deepEqual(app.logs, []);
    assert.equal(JSON.stringify(result).includes(BOOKING.customer.email), false);
  });
}

test('ロックが埋まっていても、未対応の操作を通信障害として待たせない', () => {
  const app = fixture({ occupied: true });
  const result = app.send({ ...BOOKING, type: 'reserv' });
  assert.equal(result.invalid, true);
  assert.deepEqual(app.events, []);
  assert.deepEqual(app.calls, []);
});

test('操作種別のない旧予約と明示reserveは既存の最終検査へ送る', () => {
  for (const request of [BOOKING, { ...BOOKING, type: 'reserve' }]) {
    const app = fixture();
    assert.equal(app.send(request).handler, 'doReserve_');
    assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0].request)), request);
    assert.equal(app.calls[0].args[2], true);
    assert.deepEqual(app.events, ['lock', 'recovery', 'ledger', 'release']);
    assert.equal(app.held(), false);
  }
});

test('既存の公開・管理操作はそれぞれの入口へ送り、予約へ取り違えない', () => {
  for (const [type, handler] of Object.entries(ROUTES)) {
    const app = fixture();
    const request = { ...BOOKING, type };
    assert.equal(app.send(request).handler, handler, type);
    assert.equal(app.calls.length, 1, type);
    if (type === 'availability') assert.equal(app.calls[0].request, undefined);
    else assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0].request)), request, type);
    assert.equal(app.held(), false, type);
    assert.equal(app.events[0], 'lock', type);
    assert.equal(app.events.at(-1), 'release', type);
  }
});

test('Google接続案内とGoogle管理の本人確認は台帳ロックの前のまま', () => {
  for (const type of ['adminAuthConfig', 'googleAdmin']) {
    const app = fixture({ occupied: true });
    assert.equal(app.send({ type }).ok, true);
    assert.equal(app.events.includes('lock'), false);
    assert.equal(app.events.includes('recovery'), false);
    assert.equal(app.events.includes('ledger'), false);
  }
});

test('未対応の操作を拒否した後も、正常な予約と空席照会へ進める', () => {
  const app = fixture();
  assert.equal(app.send({ type: 'unsupported' }).invalid, true);
  assert.equal(app.send({ ...BOOKING, type: 'reserve' }).handler, 'doReserve_');
  assert.equal(app.send({ type: 'availability' }).handler, 'doAvailability_');
  assert.deepEqual(app.calls.map(call => call.handler), ['doReserve_', 'doAvailability_']);
  assert.equal(app.held(), false);
});
