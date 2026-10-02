import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');

function fixture({ stopped = false, rejected = false } = {}) {
  const sent = [];
  const context = vm.createContext({ console: { warn() {} }, MailApp: { sendEmail(to, subject, body) {
    if (rejected) throw new Error('架空の送信障害');
    sent.push({ to, subject, body });
  } } });
  vm.runInContext(stopped ? SOURCE.replace('const MAIL_TO_CUSTOMER = true;', 'const MAIL_TO_CUSTOMER = false;') : SOURCE, context);
  return { sent, send: email => context.mailCustomer_(email, '架空の件名', '架空の本文') };
}

for (const email of ['mail-customer@example.test', '  mail-customer@example.test  ', 'ｍａｉｌ－ｃｕｓｔｏｍｅｒ＠ｅｘａｍｐｌｅ．ｔｅｓｔ']) {
  test('受付検証と同じメール表記に揃えてから送信する：' + (email.includes('＠') ? '全角' : email.startsWith(' ') ? '周囲の空白' : '半角'), () => {
    const app = fixture();
    assert.equal(app.send(email), '送信処理受付');
    assert.equal(app.sent.length, 1);
    assert.equal(app.sent[0].to, 'mail-customer@example.test');
  });
}

test('未入力・不正アドレスは正規化後も送信しない', () => {
  const app = fixture();
  for (const email of [undefined, null, '', '　', 'メール', 'mail @example.test', 'mail@example', 'mail@example.test\nsecond@example.test']) {
    assert.equal(app.send(email), '宛先なし');
  }
  assert.equal(app.sent.length, 0);
});

test('停止中は正しいアドレスでも送信しない', () => {
  const app = fixture({ stopped: true });
  assert.equal(app.send('mail-customer@example.test'), '停止中');
  assert.equal(app.sent.length, 0);
});

test('送信サービスの失敗をメール受付済みと表示しない', () => {
  const app = fixture({ rejected: true });
  assert.equal(app.send('ｍａｉｌ－ｃｕｓｔｏｍｅｒ＠ｅｘａｍｐｌｅ．ｔｅｓｔ'), '送信失敗');
  assert.equal(app.sent.length, 0);
});
