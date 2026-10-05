import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(process.env.RESERVE_SOURCE || new URL('../assets/js/reserve.js', import.meta.url), 'utf8');
const backend = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const limitsSource = backend.match(/^const LIMITS = [^;]+;/m)?.[0];
const cellSource = backend.match(/^function cell_\([^]*?^}/m)?.[0];
assert.ok(limitsSource && cellSource);
const storage = vm.runInNewContext(limitsSource + '\n' + cellSource + ';({ limits: LIMITS, cell: cell_ })');
const start = source.indexOf('const CUSTOMER_TEXT_LIMITS') >= 0
  ? source.indexOf('const CUSTOMER_TEXT_LIMITS') : source.indexOf('const VALIDATORS');
const end = source.indexOf('\nconst TIDY', start);
assert.ok(start >= 0 && end > start);
const validators = vm.runInNewContext(source.slice(start, end) + ';VALIDATORS');
const text = (field, length) => field === 'email' ? 'a'.repeat(length - '@example.test'.length) + '@example.test'
  : (field === 'kana' ? 'ア' : 'あ').repeat(length);

for (const field of ['name', 'kana', 'email', 'request']) {
  test(`${field}：保存上限の一文字超過を確認前に拒否し、サーバーの切り詰めと食い違わない`, () => {
    assert.equal(typeof validators[field], 'function');
    const oversized = text(field, storage.limits[field] + 1);
    assert.notEqual(storage.cell(oversized, storage.limits[field]), oversized, '現行の保存上限を実際に確認する');
    assert.equal(validators[field](oversized), false);
    assert.equal(oversized.length, storage.limits[field] + 1, '入力を切り詰めて検査しない');
  });

  test(`${field}：上限ちょうどの入力と前後の空白は既存の正規化・保存で内容を失わない`, () => {
    assert.equal(typeof validators[field], 'function');
    const boundary = text(field, storage.limits[field]);
    assert.equal(validators[field](boundary), true);
    assert.equal(validators[field]('  ' + boundary + '　'), true);
    assert.equal(storage.cell(boundary, storage.limits[field]), boundary);
  });
}

test('必須・カタカナ・電話・メール・同意の既存検証を維持し、ご要望の空欄は許可する', () => {
  for (const field of ['name', 'kana', 'email', 'visit']) assert.equal(validators[field](''), false);
  assert.equal(validators.kana('ひらがな'), false);
  assert.equal(validators.tel('00000000000'), true);
  assert.equal(validators.tel('000'), false);
  assert.equal(validators.email('a@example'), false);
  assert.equal(validators.agree(false), false);
  assert.equal(validators.agree(true), true);
  assert.equal(typeof validators.request, 'function');
  assert.equal(validators.request(''), true);
});

test('UTF-16の保存上限を越える文字も黙って分割せず、元の入力のまま拒否する', () => {
  const input = 'あ'.repeat(storage.limits.name - 1) + '𠮷';
  assert.equal(input.length, storage.limits.name + 1);
  assert.equal(validators.name(input), false);
  assert.equal(input.endsWith('𠮷'), true);
});

const submitStart = source.indexOf('async function submitReservation()');
const submitEnd = source.indexOf('\n  let reservation;', submitStart);
assert.ok(submitStart >= 0 && submitEnd > submitStart);
const guard = source.slice(submitStart, submitEnd) + '\n}';
for (const changing of [null, { code: 'LM-INPUT' }]) {
  test(`送信直前も長い入力を検査するが、既存予約の日時変更は名前を直させない：${!!changing}`, async () => {
    const calls = [];
    const submit = vm.runInNewContext(guard + ';submitReservation', {
      submitting: false, SALON: { draft: false }, changing, catalogVerified: () => true,
      VALIDATORS: validators, state: { customer: { name: 'あ'.repeat(storage.limits.name + 1), kana: 'ア',
        tel: '00000000000', email: 'input@example.test', visit: '初めて', request: '', agree: true } },
      validateForm: show => { calls.push(['validate', show]); return false; },
      goTo: step => calls.push(['step', step]), $: () => ({ focus() { calls.push(['focus']); } })
    });
    await submit();
    assert.deepEqual(calls, changing ? [] : [['step', 4], ['validate', undefined]]);
  });
}
