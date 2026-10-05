import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const PASSWORD = process.env.MOCK_ADMIN_PASSWORD;
const TOKEN = process.env.MOCK_ADMIN_TOKEN;
if (!PASSWORD || !TOKEN) throw new Error('MOCK_ADMIN_PASSWORD と MOCK_ADMIN_TOKEN を設定してください。');
const source = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const oldHeaders = ['独自列', '予約番号', '受付日時', '来店日', '開始', '終了', '所要(分)', 'メニュー', '担当', '担当ID', '指名料', '合計金額', 'お名前', 'フリガナ', '電話番号', 'メール', '来店回数', '予約の入口', 'ご要望', '状態', 'カレンダーID', '施術メモ'];
const values = [oldHeaders.slice(), oldHeaders.map(key => ({ 独自列: '残す値', 予約番号: '既存予約', 来店日: '2025-01-01', 開始: '10:00', 終了: '11:00', '所要(分)': 60, 状態: '予約確定' })[key] || '')];
const events = [];
let locked = false;
let rejectAppend = false;
let rejectCalendar = false;
let loseAppendResponse = false;
const sheet = {
  getLastRow: () => values.length,
  getLastColumn: () => values[0].length,
  appendRow(row) {
    assert.ok(locked, '登録はロックの内側で行う');
    if (rejectAppend) throw new Error('試験用の台帳書込失敗');
    values.push(row.slice());
    if (loseAppendResponse) throw new Error('試験用の記録後の応答不明');
  },
  getRange(row, column, height = 1, width = 1) {
    const range = {
      getValues: () => Array.from({ length: height }, (_, rowOffset) => Array.from({ length: width }, (_, columnOffset) => values[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? '')),
      setValues(rows) {
        rows.forEach((cells, rowOffset) => cells.forEach((value, columnOffset) => {
          values[row - 1 + rowOffset] ||= [];
          values[row - 1 + rowOffset][column - 1 + columnOffset] = value;
        }));
        return range;
      },
      setValue(value) { return range.setValues([[value]]); },
      setFontWeight() { return range; }, setBackground() { return range; }
    };
    return range;
  },
  setFrozenRows() {}, setColumnWidth() {}
};
const spreadsheet = { getSheetByName: name => name === '予約一覧' ? sheet : null };
sheet.getParent = () => spreadsheet;
function loadBackend(random) {
  const context = vm.createContext({
    Math: random ? Object.assign(Object.create(Math), { random }) : Math,
    console: { log() {}, error() {}, warn() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() { assert.ok(locked); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => name === 'ADMIN_PASSWORD' ? PASSWORD : name === 'ADMIN_GOOGLE_ONLY' ? 'true' : null, deleteProperty() {}, setProperty() {}, getKeys: () => [] }) },
    LockService: { getScriptLock: () => ({ waitLock() { locked = true; }, releaseLock() { locked = false; } }) },
    ContentService: { createTextOutput: text => ({ setMimeType: () => text }), MimeType: { JSON: 'json' } },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent(title, start, end, options) { if (rejectCalendar) throw new Error('試験用のカレンダー障害'); events.push({ title, start, end, options }); return { getId: () => `予定-${events.length}` }; } }) },
    Utilities: {
      formatDate(date, timezone, format) {
        const shifted = new Date(new Date(date).getTime() + 9 * 3600000).toISOString();
        return format === 'HH:mm' ? shifted.slice(11, 16) : shifted.slice(0, 10);
      }
    }
  });
  vm.runInContext(source.replace(/const CALENDAR_ID\s*=\s*'';/, "const CALENDAR_ID = 'primary';"), context);
  context.verifyGoogleAdmin_ = token => {
    if (token !== TOKEN) throw new Error('模擬本人確認の拒否');
  };
  return body => {
    const { type, idToken, ...payload } = body;
    const request = idToken === undefined ? body : { type: 'googleAdmin', action: type, idToken, payload };
    return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(request) } }));
  };
}
let send = loadBackend();
const headersBeforeLogin = values[0].slice();
assert.equal(send({ type: 'adminAddStatus', requestId: 'unauthorized-request-01' }).ok, false, '未認証の結果確認は断る');
assert.equal(send({ type: 'adminAddStatus', password: PASSWORD, requestId: 'legacy-auth-request-0001' }).ok, false, '旧パスワードの結果確認は断る');
assert.equal(send({ type: 'adminAddStatus', idToken: '', requestId: 'invalid-auth-request-001' }).authDenied, true, 'Googleの本人確認に失敗したら結果確認を断る');
assert.deepEqual(values[0], headersBeforeLogin, '認証前には台帳の列も変更しない');
const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const payload = { type: 'adminAdd', idToken: TOKEN, requestId: 'retry-request-first-0001', date: future, time: '10:00', minutes: 90, price: 5000, name: '受付再送のお客様', tel: '09011112222', menu: '試験用カット', memo: '電話で確認済み' };
const first = send(payload);
assert.equal(first.ok, true, '新しい電話予約を登録できる');
assert.equal(first.requestId, payload.requestId, '受付IDを応答で確認できる');
assert.equal(values.length, 3, '予約は1件だけ増える');
assert.equal(values[1][0], '残す値', '既存の独自列を壊さない');
assert.ok(values[0].includes('電話受付ID'), '古い台帳に受付IDの列を追加する');
assert.equal(events.length, 1, 'カレンダーに予定を1件追加する');
assert.equal((events[0].end - events[0].start) / 60000, 90, '電話予約のカレンダーも実際の所要時間を使う');
assert.ok(events[0].options.description.includes(first.code), 'カレンダーに照合用の予約番号を残す');
const again = send({ ...payload, force: true });
assert.equal(again.ok, true, '応答が途切れた後も同じ受付を確認できる');
assert.equal(again.code, first.code, '再送で予約番号を変えない');
assert.equal(again.duplicate, true, '再送だと分かる');
assert.equal(values.length, 3, '承認付き再送でも二重登録しない');
assert.equal(events.length, 1, '再送でカレンダーの予定も増やさない');
const conflict = send({ ...payload, time: '15:00', force: true });
assert.equal(conflict.ok, false, '同じIDで内容を変えた要求を断る');
assert.equal(conflict.requestConflict, true, '入力の不一致を知らせる');
assert.equal(values.length, 3, '内容不一致で別の予約を作らない');

send = loadBackend();
assert.equal(send(payload).code, first.code, '処理の再起動後も台帳に残したIDで照合する');
values[2][values[0].indexOf('開始')] = '12:00';
assert.equal(send(payload).reservation.time, '12:00', '日時変更後は元の送信内容でなく現在の台帳を返す');
values[2][values[0].indexOf('状態')] = 'キャンセル';
const cancelled = send(payload);
assert.equal(cancelled.reservation.status, 'キャンセル', '取り消した後の再送で予約を復活させない');
assert.equal(values.length, 3, '取消後も再送で増やさない');
const status = send({ type: 'adminAddStatus', idToken: TOKEN, requestId: payload.requestId });
assert.equal(status.found, true, '再読込後に受付IDだけで結果を確認できる');
assert.equal(status.reservation.code, first.code, '確認結果は台帳の予約');
assert.equal(status.reservation.status, 'キャンセル', '結果確認は現在の状態を返す');
const missing = send({ type: 'adminAddStatus', idToken: TOKEN, requestId: 'retry-request-missing-01' });
assert.equal(missing.found, false, '未登録と通信失敗を区別する');
const anonymous = send({ type: 'adminAddStatus', requestId: payload.requestId });
assert.equal(anonymous.ok, false, '受付IDだけでは顧客情報を見せない');
assert.equal(anonymous.reservation, undefined, '認証失敗の応答に顧客情報を入れない');

for (const invalid of [{ minutes: 0 }, { minutes: -1 }, { minutes: 60.5 }, { minutes: 'Infinity' }, { time: '23:00', minutes: 90 }, { date: '2026-02-31' }, { requestId: '短い' }]) {
  const before = values.length;
  const result = send({ ...payload, requestId: 'retry-request-invalid-01', ...invalid, force: true });
  assert.equal(result.ok, false, '不正な日時・所要時間・受付IDを断る');
  assert.equal(values.length, before, '不正な入力を台帳に書かない');
}
rejectAppend = true;
assert.equal(send({ ...payload, requestId: 'retry-request-failure-01', force: true }).ok, false, '台帳へ書けなければ成功と言わない');
assert.equal(events.length, 1, '台帳への書込失敗でカレンダーだけ増やさない');
rejectAppend = false;
assert.equal(send({ ...payload, requestId: 'retry-request-failure-01', force: true }).ok, true, '同じIDで書込失敗から再試行できる');
const legacy = send({ ...payload, requestId: undefined, time: '13:00' });
assert.equal(legacy.ok, true, '旧管理クライアントの登録APIは削除しない');
rejectCalendar = true;
const calendarFailure = send({ ...payload, requestId: 'calendar-failure-request-01', force: true });
assert.equal(calendarFailure.ok, true, 'カレンダー障害でも台帳の記録は維持');
assert.equal(calendarFailure.calendarWarning, true, 'カレンダーまで成功したと表示しない');
rejectCalendar = false;
const eventCount = events.length;
assert.equal(send({ ...payload, requestId: 'calendar-failure-request-01', force: true }).calendarWarning, true, '再送でも未確認を成功に変えない');
assert.equal(events.length, eventCount, '再送時に外部の予定だけ作り直さない');
loseAppendResponse = true;
const uncertainPayload = { ...payload, requestId: 'append-response-lost-01', force: true };
assert.equal(send(uncertainPayload).ok, false, '台帳記録後に応答を失った状況を再現');
const rowCount = values.length;
loseAppendResponse = false;
assert.equal(send(uncertainPayload).duplicate, true, '記録済みなら書込エラーの再送でも以前の結果を返す');
assert.equal(values.length, rowCount, '書込応答不明からの再送でも台帳を増やさない');
const publicLookup = send({ type: 'lookup', code: first.code, tel: payload.tel });
assert.equal(publicLookup.ok, true, '本人の予約照会は維持');
assert.ok(!JSON.stringify(publicLookup).includes(payload.requestId), '公開照会に電話受付IDを含めない');
assert.ok(!JSON.stringify(publicLookup).includes(TOKEN), '公開照会に模擬認証情報を含めない');
assert.equal(publicLookup.reservation.phoneContent, undefined, '照会に内部の照合内容を含めない');
values.push(values[0].map(key => key === '予約番号' ? 'LM-AAAAA' : ''));
send = loadBackend(() => 0);
const beforeCollision = values.length;
assert.equal(send({ ...payload, requestId: 'code-collision-request-01', force: true }).ok, false, '予約番号の重複候補しか出せないときは登録を止める');
assert.equal(values.length, beforeCollision, '一意性を確認できない番号で台帳を増やさない');
console.log('電話受付ID：再送・不一致・取消後・再読込・認証・既存台帳・カレンダー・書込失敗を確認しました。');
