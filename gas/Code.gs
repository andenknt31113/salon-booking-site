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
const SHEET_NAME    = '予約一覧';                // 台帳にするシート名
const NOTIFY_EMAIL  = 'salon@example.com';       // 店舗の通知先メール（空にすると通知しません）
const SALON_NAME    = 'ZER01 barber/lounge';     // メール件名の先頭に入ります
const SALON_TEL     = '';                        // ★要確認（未確認のうちは空のまま）
const SALON_ADDRESS = '茨城県龍ケ崎市中根台1丁目1-1 ロイヤルヤエ 002';
const SITE_URL      = 'https://andenknt31113.github.io/salon-booking-site/';

/* お客様へ予約確認メールを送るか（false にすると店舗への通知のみ） */
const MAIL_TO_CUSTOMER = true;

/* 台帳の列。順番を変えるとスクリプトも直す必要があるのでそのままを推奨 */
const HEADERS = [
  '予約番号', '受付日時', '来店日', '開始', '終了', '所要(分)',
  'メニュー', '担当', '担当ID', '指名料', '合計金額',
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

    if (data.type === 'availability') return json_(doAvailability_(sheet));
    if (data.type === 'cancel')       return json_(doCancel_(sheet, data));
    return json_(doReserve_(sheet, data));

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
    d.staffId || '',
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

  mailCustomer_(c.email, `ご予約を承りました（${d.date} ${d.time}）`, [
    `${c.name} 様`,
    '',
    `この度は${SALON_NAME}へのご予約をありがとうございます。`,
    '下記の内容で承りました。',
    '',
    '───────────────',
    `ご予約番号：${d.code}`,
    `ご来店日時：${d.date} ${d.time}〜${d.endTime}`,
    `メニュー　：${menuText}`,
    `ご担当　　：${d.staffName}`,
    `合計金額　：${Number(d.totalPrice).toLocaleString()}円（税込）`,
    '───────────────',
    '',
    '【ご予約の確認・キャンセル】',
    `${SITE_URL}mypage.html`,
    'ご予約時と同じ端末・ブラウザからご確認いただけます。',
    '前日18時を過ぎてからのご変更・キャンセルは、お手数ですがお電話ください。',
    '',
    `${SALON_NAME}`,
    SALON_TEL ? `TEL ${SALON_TEL}` : '',
    SALON_ADDRESS
  ].filter(Boolean).join('\n'));

  return { ok: true, code: d.code };
}

/* ============================================================
   空席状況の応答（ダブルブッキング防止）
   埋まっている枠だけを返します。
   氏名・電話番号などの個人情報は一切含めません。
   ============================================================ */
function doAvailability_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return { ok: true, booked: [] };

  const rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const col = name => HEADERS.indexOf(name);
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  const booked = rows
    .filter(r => String(r[col('状態')]).trim() !== 'キャンセル')
    .map(r => ({
      date: normalizeDate_(r[col('来店日')]),
      time: normalizeTime_(r[col('開始')]),
      minutes: Number(r[col('所要(分)')]) || 30,
      staffId: String(r[col('担当ID')] || '') || null
    }))
    .filter(b => b.date && b.time && b.date >= today);

  return { ok: true, booked: booked };
}

/** シートの値が Date になっていても 'YYYY-MM-DD' に揃える */
function normalizeDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(v || '').trim();
}

/** シートの値が Date になっていても 'HH:mm' に揃える */
function normalizeTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'HH:mm');
  return String(v || '').trim();
}

/* ============================================================
   キャンセルの反映
   ============================================================ */
function doCancel_(sheet, d) {
  const row = findRowByCode_(sheet, d.code);
  if (row === -1) return { ok: false, error: '該当する予約が見つかりません: ' + d.code };

  // メールを送るため、書き換える前にお客様の情報を控えておく
  const before = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  const email = String(before[HEADERS.indexOf('メール')] || '');

  sheet.getRange(row, HEADERS.indexOf('状態') + 1).setValue('キャンセル');
  sheet.getRange(row, 1, 1, HEADERS.length)
    .setFontLine('line-through')
    .setFontColor('#999999');

  mailCustomer_(email, `ご予約をキャンセルしました（${d.date} ${d.time}）`, [
    `${d.name} 様`,
    '',
    '下記のご予約をキャンセルいたしました。',
    '',
    `ご予約番号：${d.code}`,
    `ご来店日時：${d.date} ${d.time}〜`,
    '',
    'またのご利用をお待ちしております。',
    `ご予約はこちら： ${SITE_URL}`,
    '',
    `${SALON_NAME}`,
    SALON_TEL ? `TEL ${SALON_TEL}` : ''
  ].filter(Boolean).join('\n'));

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

/** お客様へのメール送信（アドレスが無い・無効なときは黙って何もしない） */
function mailCustomer_(email, subject, body) {
  if (!MAIL_TO_CUSTOMER) return;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) return;
  try {
    MailApp.sendEmail(String(email).trim(), `【${SALON_NAME}】${subject}`, body);
  } catch (err) {
    console.warn('お客様へのメール送信に失敗しました', err);
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
   前日リマインドメール（任意）

   使う場合は Apps Script の「トリガー」で
   ・実行する関数 → sendReminders
   ・イベントのソース → 時間主導型
   ・タイプ → 日付ベースのタイマー（例：午後6時〜7時）
   を追加してください。翌日ご来店のお客様にメールが届きます。
   ============================================================ */
function sendReminders() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const target = Utilities.formatDate(tomorrow, 'Asia/Tokyo', 'yyyy-MM-dd');

  const rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const col = name => HEADERS.indexOf(name);
  let sent = 0;

  rows.forEach(r => {
    if (String(r[col('状態')]).trim() === 'キャンセル') return;
    if (normalizeDate_(r[col('来店日')]) !== target) return;

    mailCustomer_(r[col('メール')], `明日のご予約のご案内（${normalizeTime_(r[col('開始')])}〜）`, [
      `${r[col('お名前')]} 様`,
      '',
      '明日のご予約をご案内いたします。お気をつけてお越しください。',
      '',
      `ご予約番号：${r[col('予約番号')]}`,
      `ご来店日時：${target} ${normalizeTime_(r[col('開始')])}〜`,
      `メニュー　：${r[col('メニュー')]}`,
      `ご担当　　：${r[col('担当')]}`,
      '',
      'ご都合が変わられた場合は、お手数ですがお電話ください。',
      '',
      `${SALON_NAME}`,
      SALON_TEL ? `TEL ${SALON_TEL}` : '',
      SALON_ADDRESS
    ].filter(Boolean).join('\n'));
    sent++;
  });

  console.log(`リマインド送信: ${sent}件（対象日 ${target}）`);
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
    date: '2026-09-01', time: '11:00', endTime: '12:10', totalMinutes: 70,
    menus: [{ name: '【清潔感と品が続く】men\'s骨格補正カット＋眉カット' }],
    staffId: 'st01', staffName: 'MATTEO', nominationFee: 0, totalPrice: 6900,
    customer: {
      name: 'テスト 太郎', kana: 'テスト タロウ',
      tel: '09000000000', email: 'test@example.com',
      visit: '初めて', request: 'これはテストです'
    }
  });
}
