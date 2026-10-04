import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const begin = SOURCE.indexOf('async function saveNote(btn) {');
const end = SOURCE.indexOf('\nfunction mailNeedsAttention(', begin);
assert.ok(begin >= 0 && end > begin);

const code = 'LM-NOTEUI';
const draft = '今回の下書き';
const uncertainResponses = [
  null, {}, { ok: true }, { ok: true, code }, { ok: true, code, note: null },
  { ok: true, code, note: 123 }, { ok: true, code: 'LM-OTHER', note: draft },
  { ok: true, code, note: '別のメモ' }, { ok: true, code, note: '' },
  { ok: true, code, note: draft, unknown: true },
  { ok: true, code, note: draft, conflict: true },
  { ok: true, code, note: draft, transportError: true }
];

for (const [index, response] of [{ ok: false, unknown: true }, { ok: false, transportError: true },
  { ok: false, conflict: true }, ...uncertainResponses].entries()) {
  test(`メモ保存の未確認応答${index + 1}で下書きと元の内容を残す`, async () => {
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
      $$: () => [box], pendingNoteSaves: new Set(), NOTE_MAX: 1000,
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
    resolveResponse(response);
    await saving;
    assert.equal(input.disabled, false);
    assert.equal(button.disabled, false);
    assert.equal(input.value, '今回の下書き');
    assert.equal(input.defaultValue, '以前のメモ');
    assert.equal(context.adminData.reservations[0].note, '以前のメモ');
    assert.equal(requests.length, 1, '結果不明・競合を自動再送しない');
    if (response?.conflict && response.ok === false) assert.match(status.textContent, /別の画面.*入力は残っています/);
    else {
      assert.match(status.textContent, /保存結果を確認できません.*入力は残っています/);
      assert.doesNotMatch(status.textContent, /未保存/);
      assert.match(alerts[0], /保存結果を確認できません/);
      assert.doesNotMatch(alerts[0], /保存できませんでした/);
    }
  });
}

for (const note of ['', '今回のメモ', '=数式ではないメモ', "'文字のメモ", ' 前回\r\n次回 ', 'あ'.repeat(1100)]) {
  test(`番号と保存内容を照合した正常応答だけを反映する：${note.slice(0, 12) || '空欄'}`, async () => {
    const input = { value: note, defaultValue: '以前のメモ' };
    const status = { textContent: '' };
    const button = { dataset: { noteSave: code } };
    const box = { querySelector: selector => ({ '[data-note-input]': input,
      '[data-note-save]': button, '[data-note-status]': status })[selector] };
    button.closest = () => box;
    const saved = note.trim().slice(0, 1000).replace(/\r\n?/g, '\n').trim();
    const applied = [];
    const context = vm.createContext({ CSS: { escape: value => value },
      $$: () => [box], pendingNoteSaves: new Set(), NOTE_MAX: 1000,
      adminData: { reservations: [{ code, note: input.defaultValue }] },
      adminPost: async () => ({ ok: true, code, note: saved }),
      applyNoteToScreen: (...values) => applied.push(values),
      alert: () => assert.fail('正しい保存応答では警告しない') });
    vm.runInContext(SOURCE.slice(begin, end), context);
    await context.saveNote(button);
    assert.equal(context.adminData.reservations[0].note, saved);
    assert.deepEqual(applied, [[code, saved, box]]);
    assert.equal(status.textContent, '保存しました');
    assert.equal(context.pendingNoteSaves.size, 0);
    assert.equal(input.disabled, false);
    assert.equal(button.disabled, false);
  });
}
