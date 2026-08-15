/**
 * サロン予約サイト 受信スクリプト（Google Apps Script）
 *
 * 予約サイトから届いた予約を、このスクリプトを紐づけた
 * スプレッドシートに1行ずつ追記し、店舗宛にメールで通知します。
 * キャンセルが届いたときは、その行の状態を「キャンセル」に更新します。
 *
 * 設置手順は README.md の「予約を店舗に届ける」を参照してください。
 */

/* ============================================================
   設定：ここだけ書き換えてください
   ============================================================ */
const SHEET_NAME   = '予約一覧';                // 台帳にするシート名
const NOTIFY_EMAIL = 'salon@example.com';       // 通知先メール（空にすると通知しません）
const SALON_NAME   = 'Salon LUMIÈRE 表参道店';  // メール件名の先頭に入ります

/* 台帳の列。順番を変えるとスクリプトも直す必要があるのでそのままを推奨 */
const HEADERS = [
  '予約番号', '受付日時', '来店日', '開始', '終了', '所要(分)',
  'メニュー', '担当', '指名料', '合計金額',
  'お名前', 'フリガナ', '電話番号', 'メール', '来店回数', 'ご要望', '状態'
];

/* ============================================================
   受信の入口
   ============================================================ */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // 同時に予約が来ても行が壊れないよう順番待ちさせる
    lock.waitLock(20000);

    const data = JSON.parse(e.postData.contents);
    const sheet = getSheet_();
    return json_(data.type === 'cancel' ? doCancel_(sheet, data) : doReserve_(sheet, data));

  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** 設置確認用。ブラウザでURLを開くとこれが返ります */
function doGet() {
  return json_({ ok: true, message: '予約の受信先として動作しています' });
}

/* ============================================================
   予約の追記
   ============================================================ */
function doReserve_(sheet, d) {
  const c = d.customer || {};
  const menuText = (d.menus || []).map(m => m.name).join(' / ');

  sheet.appendRow([
    d.code,
    formatTime_(d.createdAt),
    d.date,
    d.time,
    d.endTime,
    d.totalMinutes,
    menuText,
    d.staffName,
    d.nominationFee,
    d.totalPrice,
    c.name,
    c.kana,
    "'" + (c.tel || ''),   // 先頭の0が消えないよう文字列として保存
    c.email,
    c.visit,
    c.request || '',
    '予約確定'
  ]);

  notify_(
    `【新規予約】${d.date} ${d.time} ${c.name}様`,
    [
      `予約番号：${d.code}`,
      `来店日時：${d.date} ${d.time}〜${d.endTime}（約${d.totalMinutes}分）`,
      `メニュー：${menuText}`,
      `担当　　：${d.staffName}`,
      '',
      `お名前　：${c.name} 様（${c.kana}）`,
      `電話番号：${c.tel}`,
      `メール　：${c.email}`,
      `来店回数：${c.visit}`,
      `合計金額：${Number(d.totalPrice).toLocaleString()}円（税込）`,
      `ご要望　：${c.request || 'なし'}`
    ].join('\n')
  );

  return { ok: true, code: d.code };
}

/* ============================================================
   キャンセルの反映
   ============================================================ */
function doCancel_(sheet, d) {
  const row = findRowByCode_(sheet, d.code);
  if (row === -1) return { ok: false, error: '該当する予約が見つかりません: ' + d.code };

  sheet.getRange(row, HEADERS.indexOf('状態') + 1).setValue('キャンセル');
  sheet.getRange(row, 1, 1, HEADERS.length)
    .setFontLine('line-through')
    .setFontColor('#999999');

  notify_(
    `【キャンセル】${d.date} ${d.time} ${d.name}様`,
    [
      `予約番号：${d.code}`,
      `来店日時：${d.date} ${d.time}〜`,
      `お名前　：${d.name} 様`,
      '',
      'キャンセルにより枠が空きました。'
    ].join('\n')
  );

  return { ok: true };
}

/* ============================================================
   補助
   ============================================================ */
function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  // 初回だけ見出し行を作る
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#f3efea');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(HEADERS.indexOf('メニュー') + 1, 240);
    sheet.setColumnWidth(HEADERS.indexOf('ご要望') + 1, 260);
  }
  return sheet;
}

function findRowByCode_(sheet, code) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const codes = sheet.getRange(2, 1, last - 1, 1).getValues();
  const i = codes.findIndex(r => String(r[0]).trim() === String(code).trim());
  return i === -1 ? -1 : i + 2;
}

function notify_(subject, body) {
  if (!NOTIFY_EMAIL) return;
  try {
    MailApp.sendEmail(NOTIFY_EMAIL, `${SALON_NAME} ${subject}`, body);
  } catch (err) {
    // メールの失敗で予約の記録まで止めない
    console.warn('メール送信に失敗しました', err);
  }
}

function formatTime_(iso) {
  const d = iso ? new Date(iso) : new Date();
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   動作確認用
   サイトを触らずに、この関数を実行して1件テスト登録できます。
   （エディタ上部の実行ボタン → 関数に testReserve を選んで実行）
   ============================================================ */
function testReserve() {
  doReserve_(getSheet_(), {
    code: 'LM-TEST1',
    createdAt: new Date().toISOString(),
    date: '2026-09-01', time: '11:00', endTime: '13:30', totalMinutes: 150,
    menus: [{ name: '【人気No.1】カット + イルミナカラー + トリートメント' }],
    staffName: '佐藤 美咲', nominationFee: 1100, totalPrice: 12100,
    customer: {
      name: 'テスト 太郎', kana: 'テスト タロウ',
      tel: '09000000000', email: 'test@example.com',
      visit: '初めて', request: 'これはテストです'
    }
  });
}
