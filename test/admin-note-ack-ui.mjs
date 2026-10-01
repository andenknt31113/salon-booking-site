import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const begin = SOURCE.indexOf('async function saveNote(btn) {');
const end = SOURCE.indexOf('\nfunction mailNeedsAttention(', begin);
assert.ok(begin >= 0 && end > begin);

for (const response of [{ ok: false, unknown: true }, { ok: false, transportError: true }, { ok: false, conflict: true }]) {
  test(`メモ保存の${response.unknown ? '店舗側の結果不明' : response.transportError ? '通信結果不明' : '更新の競合'}で下書きと元の内容を残す`, async () => {
    const input = { value: '今回の下書き', defaultValue: '以前のメモ', disabled: false };
    const status = { textContent: '' };
    const button = { dataset: { noteSave: 'LM-NOTEUI' }, disabled: false };
    const box = { querySelector: selector => ({ '[data-note-input]': input,
      '[data-note-save]': button, '[data-note-status]': status })[selector] };
    button.closest = () => box;
    const alerts = [];
    const requests = [];
    let resolveResponse;
    const waiting = new Promise(resolve => { resolveResponse = resolve; });
    const context = vm.createContext({ CSS: { escape: value => value },
      $$: () => [box], pendingNoteSaves: new Set(),
      adminData: { reservations: [{ code: button.dataset.noteSave, note: input.defaultValue }] },
      adminPost(request) { requests.push(request); return waiting; },
      applyNoteToScreen: () => assert.fail('未確認のメモを保存済み表示へ渡さない'),
      alert: message => alerts.push(message) });
    vm.runInContext(SOURCE.slice(begin, end), context);
    const saving = context.saveNote(button);
    assert.equal(input.disabled, true);
    assert.equal(button.disabled, true);
    assert.equal(status.textContent, '保存中…');
    await context.saveNote(button);
    assert.equal(requests.length, 1, '保存中の二重操作は送信しない');
    assert.equal(requests[0].expectedNote, input.defaultValue);
    resolveResponse({ ...response, error: '入力をコピーしてから現在のメモを確認してください。' });
    await saving;
    assert.equal(input.disabled, false);
    assert.equal(button.disabled, false);
    assert.equal(input.value, '今回の下書き');
    assert.equal(input.defaultValue, '以前のメモ');
    assert.equal(context.adminData.reservations[0].note, '以前のメモ');
    assert.equal(requests.length, 1, '結果不明・競合を自動再送しない');
    if (response.conflict) assert.match(status.textContent, /別の画面.*入力は残っています/);
    else {
      assert.match(status.textContent, /保存結果を確認できません.*入力は残っています/);
      assert.doesNotMatch(status.textContent, /未保存/);
      assert.match(alerts[0], /保存結果を確認できません/);
      assert.doesNotMatch(alerts[0], /保存できませんでした/);
    }
  });
}
