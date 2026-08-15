/**
 * ZER01 barber/lounge 予約サイト 受信スクリプト（Google Apps Script）
 *
 * このスプレッドシートが、サロンボードにあたる管理画面になります。
 *   ・予約一覧  … 入った予約が1行ずつ溜まります
 *   ・メニュー  … 行を足すとサイトのメニューが増えます
 *   ・おすすめメニュー … 同上
 *
 * 予約が入ると、店舗へのメール通知・お客様への確認メール・
 * Googleカレンダーへの登録（任意）が同時に行われます。
 *
 * 設置手順は README.md を参照してください。
 */

/* ============================================================
   設定：ここだけ書き換えてください
   ============================================================ */
const SHEET_NAME    = '予約一覧';
const MENU_SHEET    = 'メニュー';
const COUPON_SHEET  = 'おすすめメニュー';
const CLOSED_SHEET  = '休業日';
const SETTING_SHEET = '設定';
const STYLE_SHEET   = 'スタイル';

/* 管理者ページのパスワード。
   ここに直接書かず、スクリプトプロパティに保存します。
   Apps Script の「プロジェクトの設定 → スクリプト プロパティ」で
   ADMIN_PASSWORD という名前で登録してください。
   （サイトのソースには一切現れないため、パスワードが漏れません） */
function adminPassword_() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || '';
}

/** 管理操作の認証。合っていなければ例外を投げる。
    パスワードそのものか、ログイン時に発行した端末トークンのどちらかで通ります。 */
function requireAdmin_(d) {
  const pw = adminPassword_();
  if (!pw) throw new Error('管理パスワードが未設定です。スクリプトプロパティに ADMIN_PASSWORD を登録してください。');
  if (String(d.password || '') === pw) return;
  if (d.token && validToken_(String(d.token))) return;
  throw new Error('パスワードが違います。');
}

/* ---- 端末トークン ----
   「この端末を記憶する」を選ぶと、パスワードの代わりに使える文字列を発行します。
   パスワード本体を端末に残さずに済み、店側が使うたびに入力しなくてよくなります。
   スクリプトプロパティに保管し、期限切れは読み出し時に捨てます。 */
const TOKEN_PROP = 'ADMIN_TOKENS';
const TOKEN_DAYS = 60;

function readTokens_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(TOKEN_PROP) || '{}'); }
  catch (e) { return {}; }
}
function issueToken_() {
  const tokens = readTokens_();
  const now = Date.now();
  // 期限切れを捨ててから足す（貯まりっぱなしにしない）
  Object.keys(tokens).forEach(k => { if (tokens[k] < now) delete tokens[k]; });
  const t = Utilities.getUuid() + '-' + Utilities.getUuid();
  tokens[t] = now + TOKEN_DAYS * 24 * 60 * 60 * 1000;
  PropertiesService.getScriptProperties().setProperty(TOKEN_PROP, JSON.stringify(tokens));
  return t;
}
function validToken_(t) {
  const tokens = readTokens_();
  return !!tokens[t] && tokens[t] > Date.now();
}
/** 端末を全部ログアウトさせたいときに、エディタから手で実行します */
function revokeAllAdminTokens() {
  PropertiesService.getScriptProperties().deleteProperty(TOKEN_PROP);
  console.log('記憶させた端末をすべて解除しました');
}

const NOTIFY_EMAIL  = 'salon@example.com';       // 店舗の通知先メール（空にすると通知しません）
const SALON_NAME    = 'ZER01 barber/lounge';
const SALON_TEL     = '';                        // ★要確認（未確認のうちは空のまま）
const SALON_ADDRESS = '茨城県龍ケ崎市中根台1丁目1-1 ロイヤルヤエ 002';
const SITE_URL      = 'https://andenknt31113.github.io/salon-booking-site/';

/* お客様へ予約確認メールを送るか（false にすると店舗への通知のみ） */
const MAIL_TO_CUSTOMER = true;

/* 予約をGoogleカレンダーにも入れる場合はカレンダーIDを設定。
   自分のメインカレンダーに入れるなら 'primary'。
   空にすると連携しません。
   予約用のカレンダーを分けたい場合は、Googleカレンダーで新しいカレンダーを作り、
   設定画面の「カレンダーの統合」にあるカレンダーIDを貼ってください。 */
const CALENDAR_ID = '';

/* LINE公式アカウントに通知を送る場合のみ設定します。
   LINE Developers の Messaging API チャネルで発行する
   「チャネルアクセストークン（長期）」を入れてください。
   空のままなら何もしません。

   LINE_TO には送信先のユーザーIDまたはグループIDを入れます。
   自分（店舗）宛に届けるだけなら、公式アカウントを友だち追加したうえで
   Webhookで取得したユーザーIDを入れてください。

   ▼ 設定する前に一度ご検討ください
   無料プラン（コミュニケーションプラン）の配信上限は月200通です。
   ここを設定すると、予約1件ごとに1通を消費します。
   予約が月100件あれば、それだけで100通です。

   店舗への通知はメールとGoogleカレンダーで足りているため、
   200通はお客様への再来のご案内に取っておくことをおすすめします。
   （1:1トークの返信や自動応答は通数を消費しません） */
const LINE_TOKEN = '';
const LINE_TO    = '';

/* ============================================================
   シートの列（順番を変えるとスクリプトも直す必要があります）
   ============================================================ */
const HEADERS = [
  '予約番号', '受付日時', '来店日', '開始', '終了', '所要(分)',
  'メニュー', '担当', '担当ID', '指名料', '合計金額',
  'お名前', 'フリガナ', '電話番号', 'メール', '来店回数', 'ご要望',
  '状態', 'カレンダーID'
];

const MENU_HEADERS   = ['区分', 'メニュー名', '価格', '所要(分)', '説明', '画像', '表示'];
const COUPON_HEADERS = ['メニュー名', '価格', '通常価格', '所要(分)', '説明', '条件', '対象', '画像', '表示'];
const STYLE_HEADERS  = ['タイトル', '分類', 'タグ', '画像', '表示'];

/* ============================================================
   受信の入口
   ============================================================ */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // 同時に予約が来ても行が壊れないよう順番待ちさせる
    lock.waitLock(20000);

    const data = JSON.parse(e.postData.contents);

    if (data.type === 'menu')         return json_(doMenu_());
    if (data.type === 'adminLogin')   return json_(doAdminLogin_(data));
    if (data.type === 'adminData')    return json_(doAdminData_(data));
    if (data.type === 'adminSave')    return json_(doAdminSave_(data));
    if (data.type === 'adminUpload')  return json_(doAdminUpload_(data));
    if (data.type === 'availability') return json_(doAvailability_(getSheet_()));
    if (data.type === 'lookup')       return json_(doLookup_(getSheet_(), data));
    if (data.type === 'cancel')       return json_(doCancel_(getSheet_(), data));
    return json_(doReserve_(getSheet_(), data));

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
  const eventId = addToCalendar_(d, c, menuText);

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
    '予約確定',
    eventId
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

  notifyLine_([
    '【新規予約】',
    `${d.date} ${d.time}〜${d.endTime}`,
    `${c.name} 様（${c.visit}）`,
    menuText,
    `${Number(d.totalPrice).toLocaleString()}円`,
    `TEL ${c.tel}`,
    c.request ? `ご要望：${c.request}` : ''
  ].filter(Boolean).join('\n'));

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
    'ご予約番号と電話番号を入力すると、どの端末からでもご確認いただけます。',
    '前日18時を過ぎてからのご変更・キャンセルは、お手数ですが店舗までご連絡ください。',
    '',
    `${SALON_NAME}`,
    SALON_TEL ? `TEL ${SALON_TEL}` : '',
    SALON_ADDRESS
  ].filter(Boolean).join('\n'));

  return { ok: true, code: d.code };
}

/* ============================================================
   Googleカレンダー連携（CALENDAR_ID が空なら何もしない）
   ============================================================ */
function addToCalendar_(d, c, menuText) {
  if (!CALENDAR_ID) return '';
  try {
    const cal = CALENDAR_ID === 'primary'
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(CALENDAR_ID);
    if (!cal) return '';

    const start = parseDateTime_(d.date, d.time);
    const end = new Date(start.getTime() + (Number(d.totalMinutes) || 30) * 60000);

    const event = cal.createEvent(
      `${c.name || 'お客様'}様 / ${menuText}`,
      start, end,
      {
        description: [
          `予約番号：${d.code}`,
          `メニュー：${menuText}`,
          `担当：${d.staffName}`,
          `電話：${c.tel || ''}`,
          `メール：${c.email || ''}`,
          `来店回数：${c.visit || ''}`,
          `ご要望：${c.request || 'なし'}`,
          `金額：${Number(d.totalPrice).toLocaleString()}円`
        ].join('\n'),
        location: SALON_ADDRESS
      }
    );
    return event.getId();
  } catch (err) {
    // カレンダーの失敗で予約の記録まで止めない
    console.warn('カレンダー登録に失敗しました', err);
    return '';
  }
}

function removeFromCalendar_(eventId) {
  if (!CALENDAR_ID || !eventId) return;
  try {
    const cal = CALENDAR_ID === 'primary'
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(CALENDAR_ID);
    if (!cal) return;
    const event = cal.getEventById(eventId);
    if (event) event.deleteEvent();
  } catch (err) {
    console.warn('カレンダーの削除に失敗しました', err);
  }
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

/* ============================================================
   メニューの応答
   「メニュー」「おすすめメニュー」シートの内容をサイトに反映します。
   シートが無い場合は空を返し、サイトは data.js の内容で動きます。
   ============================================================ */
function doMenu_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    ok: true,
    categories: readMenuSheet_(ss),
    coupons: readCouponSheet_(ss),
    styles: readStyleSheet_(ss),
    closedDates: readClosedSheet_(ss),
    settings: readSettings_(ss)
  };
}

/* 「休業日」シートに書いた日付を、予約できない日としてサイトに渡します。
   出張や臨時休業はここに1行足すだけで塞げます。 */
function readClosedSheet_(ss) {
  const sheet = ss.getSheetByName(CLOSED_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
    .map(r => normalizeDate_(r[0]))
    .filter(Boolean);
}

function readMenuSheet_(ss) {
  const sheet = ss.getSheetByName(MENU_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, MENU_HEADERS.length).getValues();
  const col = n => MENU_HEADERS.indexOf(n);
  const groups = [];

  rows.forEach((r, i) => {
    const name = String(r[col('メニュー名')] || '').trim();
    if (!name) return;
    if (!isShown_(r[col('表示')])) return;

    const catName = String(r[col('区分')] || 'メニュー').trim();
    let group = groups.find(g => g.name === catName);
    if (!group) {
      group = { id: 'cat' + groups.length, name: catName, items: [] };
      groups.push(group);
    }
    const p = parsePrice_(r[col('価格')]);
    group.items.push({
      id: 'sm' + i,
      name: name,
      price: p.value,
      priceFrom: p.from,
      minutes: Number(r[col('所要(分)')]) || 30,
      note: String(r[col('説明')] || ''),
      image: String(r[col('画像')] || '').trim()
    });
  });

  return groups.length ? groups : null;
}

function readCouponSheet_(ss) {
  const sheet = ss.getSheetByName(COUPON_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, COUPON_HEADERS.length).getValues();
  const col = n => COUPON_HEADERS.indexOf(n);
  const out = [];

  rows.forEach((r, i) => {
    const title = String(r[col('メニュー名')] || '').trim();
    if (!title) return;
    if (!isShown_(r[col('表示')])) return;

    const list = Number(r[col('通常価格')]) || null;
    const p = parsePrice_(r[col('価格')]);
    out.push({
      id: 'sc' + i,
      badge: String(r[col('対象')] || '全員').trim(),
      title: title,
      detail: String(r[col('説明')] || ''),
      price: p.value,
      priceFrom: p.from,
      listPrice: list,
      minutes: Number(r[col('所要(分)')]) || 30,
      terms: String(r[col('条件')] || ''),
      image: String(r[col('画像')] || '').trim()
    });
  });

  return out.length ? out : null;
}

/* 「スタイル」シート。ヘアカタログと店内写真をここで差し替えます。
   分類はギャラリーの絞り込みタブになります（ショート／カラー／店内 など）。 */
function readStyleSheet_(ss) {
  const sheet = ss.getSheetByName(STYLE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, STYLE_HEADERS.length).getValues();
  const col = n => STYLE_HEADERS.indexOf(n);
  const out = [];

  rows.forEach((r, i) => {
    const title = String(r[col('タイトル')] || '').trim();
    if (!title) return;
    if (!isShown_(r[col('表示')])) return;
    out.push({
      id: 'ss' + i,
      title: title,
      length: String(r[col('分類')] || 'スタイル').trim(),
      staffId: null,
      tags: String(r[col('タグ')] || '').split(/[,、・\s]+/).filter(Boolean),
      image: String(r[col('画像')] || '').trim(),
      // 写真がまだ無い枠は、意匠の色みを少しずつ変えて並べる
      hue: (i * 37) % 360
    });
  });

  return out.length ? out : null;
}

/* 価格セルの読み取り。
   数値のほか「4000〜」「¥4,000〜」のような書き方も受け取ります。
   「〜」を付けると、サイトでも「¥4,000〜」と出ます。
   空欄・0 は「カウンセリングでお見積り」として扱われます。 */
function parsePrice_(v) {
  const s = String(v == null ? '' : v).trim();
  const from = /[〜~]/.test(s);
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return { value: isNaN(n) ? 0 : n, from: from };
}

/** 「表示」列の判定。空欄は表示扱い。×・✕・x・非表示・FALSE は非表示 */
function isShown_(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '') return true;
  return !['×', '✕', 'x', '✗', '非表示', 'false', 'no', 'off', '0'].includes(s);
}

/* ============================================================
   予約の照会（予約番号 + 電話番号）
   ログイン機能の代わりです。両方が一致した場合だけ返します。
   ============================================================ */
function doLookup_(sheet, d) {
  const row = findRowByCode_(sheet, d.code);
  if (row === -1) return { ok: false, error: 'ご予約が見つかりませんでした。' };

  const r = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  const col = n => HEADERS.indexOf(n);

  if (digits_(r[col('電話番号')]) !== digits_(d.tel)) {
    return { ok: false, error: 'ご予約が見つかりませんでした。' };
  }

  return {
    ok: true,
    reservation: {
      code: String(r[col('予約番号')]),
      date: normalizeDate_(r[col('来店日')]),
      time: normalizeTime_(r[col('開始')]),
      endTime: normalizeTime_(r[col('終了')]),
      totalMinutes: Number(r[col('所要(分)')]) || 30,
      menuText: String(r[col('メニュー')] || ''),
      staffName: String(r[col('担当')] || ''),
      totalPrice: Number(r[col('合計金額')]) || 0,
      name: String(r[col('お名前')] || ''),
      status: String(r[col('状態')] || '')
    }
  };
}

/** 数字だけを取り出して比較する（ハイフン・全角・先頭の ' を無視） */
function digits_(v) {
  return String(v == null ? '' : v)
    .replace(/^'/, '')
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/\D/g, '');
}

/* ============================================================
   キャンセルの反映
   ============================================================ */
function doCancel_(sheet, d) {
  const row = findRowByCode_(sheet, d.code);
  if (row === -1) return { ok: false, error: '該当する予約が見つかりません: ' + d.code };

  const before = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  const col = n => HEADERS.indexOf(n);

  // 照会経由のキャンセルは電話番号の一致を確認する
  if (d.tel && digits_(before[col('電話番号')]) !== digits_(d.tel)) {
    return { ok: false, error: 'ご予約が確認できませんでした。' };
  }

  const email = String(before[col('メール')] || '');
  const name = d.name || String(before[col('お名前')] || '');

  sheet.getRange(row, col('状態') + 1).setValue('キャンセル');
  sheet.getRange(row, 1, 1, HEADERS.length)
    .setFontLine('line-through')
    .setFontColor('#999999');

  removeFromCalendar_(String(before[col('カレンダーID')] || ''));

  mailCustomer_(email, `ご予約をキャンセルしました（${d.date} ${d.time}）`, [
    `${name} 様`,
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

  notifyLine_([
    '【キャンセル】',
    `${d.date} ${d.time}〜`,
    `${name} 様`,
    '枠が空きました。'
  ].join('\n'));

  notify_(
    `【キャンセル】${d.date} ${d.time} ${name}様`,
    [
      `予約番号：${d.code}`,
      `来店日時：${d.date} ${d.time}〜`,
      `お名前　：${name} 様`,
      '',
      'キャンセルにより枠が空きました。'
    ].join('\n')
  );

  return { ok: true };
}

/* ============================================================
   管理者ページ用
   ============================================================ */
function doAdminLogin_(d) {
  requireAdmin_(d);
  // 「この端末を記憶する」が選ばれたときだけ発行する
  return d.remember ? { ok: true, token: issueToken_() } : { ok: true };
}

/** 管理者ページに必要な情報をまとめて返す */
function doAdminData_(d) {
  requireAdmin_(d);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  const col = n => HEADERS.indexOf(n);

  const reservations = last < 2 ? [] :
    sheet.getRange(2, 1, last - 1, HEADERS.length).getValues().map(r => ({
      code: String(r[col('予約番号')]),
      date: normalizeDate_(r[col('来店日')]),
      time: normalizeTime_(r[col('開始')]),
      endTime: normalizeTime_(r[col('終了')]),
      menu: String(r[col('メニュー')] || ''),
      staffName: String(r[col('担当')] || ''),
      price: Number(r[col('合計金額')]) || 0,
      name: String(r[col('お名前')] || ''),
      tel: String(r[col('電話番号')] || '').replace(/^'/, ''),
      email: String(r[col('メール')] || ''),
      visit: String(r[col('来店回数')] || ''),
      request: String(r[col('ご要望')] || ''),
      status: String(r[col('状態')] || '')
    })).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));

  return {
    ok: true,
    reservations: reservations,
    menus: readSheetRows_(ss, MENU_SHEET, MENU_HEADERS),
    coupons: readSheetRows_(ss, COUPON_SHEET, COUPON_HEADERS),
    styles: readSheetRows_(ss, STYLE_SHEET, STYLE_HEADERS),
    closedDates: readSheetRows_(ss, CLOSED_SHEET, ['休業日', 'メモ']),
    settings: readSettings_(ss)
  };
}

/** 管理者ページからの保存。シートまるごと書き換える */
function doAdminSave_(d) {
  requireAdmin_(d);
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (d.target === 'menus')   writeSheetRows_(ss, MENU_SHEET, MENU_HEADERS, d.rows);
  else if (d.target === 'coupons') writeSheetRows_(ss, COUPON_SHEET, COUPON_HEADERS, d.rows);
  else if (d.target === 'styles')  writeSheetRows_(ss, STYLE_SHEET, STYLE_HEADERS, d.rows);
  else if (d.target === 'closed')  writeSheetRows_(ss, CLOSED_SHEET, ['休業日', 'メモ'], d.rows);
  else if (d.target === 'settings') writeSettings_(ss, d.rows);
  else return { ok: false, error: '不明な保存先です: ' + d.target };

  return { ok: true };
}

/* ============================================================
   画像のアップロード

   管理者ページで選んだ写真を Google ドライブに保存し、
   サイトから表示できるURLを返します。
   写真は「ZER01サイト画像」フォルダに入り、リンクを知っていれば
   誰でも閲覧できる設定になります（サイトに載せる写真のため）。
   ============================================================ */
const IMAGE_FOLDER = 'ZER01サイト画像';

function imageFolder_() {
  const found = DriveApp.getFoldersByName(IMAGE_FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(IMAGE_FOLDER);
}

function doAdminUpload_(d) {
  requireAdmin_(d);

  const raw = String(d.dataBase64 || '');
  if (!raw) return { ok: false, error: '画像が空です。' };

  // "data:image/jpeg;base64,...." の形で来ても受け取れるようにする
  const body = raw.indexOf(',') >= 0 ? raw.slice(raw.indexOf(',') + 1) : raw;
  const mime = String(d.mimeType || 'image/jpeg');
  if (mime.indexOf('image/') !== 0) return { ok: false, error: '画像ファイルを選んでください。' };

  // 元のファイル名は日本語や重複でつまずくので、用途＋日時で付け直す
  const ext  = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const slot = String(d.slot || 'image').replace(/[^A-Za-z0-9_-]/g, '') || 'image';
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
  const name = slot + '-' + stamp + '.' + ext;

  const blob = Utilities.newBlob(Utilities.base64Decode(body), mime, name);
  const file = imageFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return {
    ok: true,
    name: name,
    // <img> から直接読める形式。ドライブの共有リンクそのままでは画像として表示できません。
    url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1200'
  };
}

/** シートを見出し付きの配列として読む */
function readSheetRows_(ss, name, headers) {
  const sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
    .map(r => {
      const o = {};
      headers.forEach((h, i) => {
        o[h] = (h === '休業日') ? normalizeDate_(r[i]) : (r[i] === '' ? '' : r[i]);
      });
      return o;
    })
    .filter(o => String(o[headers[0]] || '').trim() !== '');
}

/** 見出しを残して中身を入れ替える */
function writeSheetRows_(ss, name, headers, rows) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f3efea');
    sheet.setFrozenRows(1);
  }
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).clearContent();
  }
  const body = (rows || [])
    .map(r => headers.map(h => (r[h] === undefined || r[h] === null) ? '' : r[h]))
    .filter(cells => String(cells[0]).trim() !== '');
  if (body.length) sheet.getRange(2, 1, body.length, headers.length).setValues(body);
}

/** 設定シート（項目 / 内容 の2列） */
function readSettings_(ss) {
  const sheet = ss.getSheetByName(SETTING_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return {};
  const out = {};
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(r => {
    const k = String(r[0] || '').trim();
    if (k) out[k] = r[1] === '' ? '' : r[1];
  });
  return out;
}

function writeSettings_(ss, obj) {
  const rows = Object.keys(obj || {}).map(k => ({ '項目': k, '内容': obj[k] }));
  writeSheetRows_(ss, SETTING_SHEET, ['項目', '内容'], rows);
}

/* ============================================================
   補助
   ============================================================ */
function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#f3efea');
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
    console.warn('メール送信に失敗しました', err);
  }
}

/** LINE公式アカウントへ通知を送る（LINE_TOKEN が空なら何もしない） */
function notifyLine_(text) {
  if (!LINE_TOKEN || !LINE_TO) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + LINE_TOKEN },
      payload: JSON.stringify({
        to: LINE_TO,
        messages: [{ type: 'text', text: text.slice(0, 4900) }]
      }),
      muteHttpExceptions: true
    });
  } catch (err) {
    // 通知の失敗で予約の記録まで止めない
    console.warn('LINE通知に失敗しました', err);
  }
}

function mailCustomer_(email, subject, body) {
  if (!MAIL_TO_CUSTOMER) return;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) return;
  try {
    MailApp.sendEmail(String(email).trim(), `【${SALON_NAME}】${subject}`, body);
  } catch (err) {
    console.warn('お客様へのメール送信に失敗しました', err);
  }
}

function normalizeDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(v || '').trim();
}

function normalizeTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'HH:mm');
  return String(v || '').trim();
}

function parseDateTime_(dateKey, time) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const [hh, mm] = String(time).split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0);
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
   ★ 最初にこれだけ実行してください ★

   エディタ上部の関数選択で「はじめの準備」を選んで実行すると、
   次のことをまとめて行います。

   1. 予約台帳・単品メニュー・おすすめメニュー・スタイル・休業日・設定 の6枚を作る
   2. 管理ページのパスワードを決める（下の PASSWORD に書いた文字列）
   3. 足りない設定があれば、実行ログに残りの手順を出す

   実行前に、下の PASSWORD をお好きな文字列に変えてください。
   実行が終わったら、この行は空 '' に戻して構いません
   （パスワードはスクリプトプロパティに保存済みのため、消しても動きます）。
   ============================================================ */
const PASSWORD = '';   // 例）'zer01-2026' のように決めてください

function はじめの準備() {
  const log = [];

  // 1. シートをそろえる
  getSheet_();          // 予約台帳
  setupMenuSheets();    // 単品メニュー・おすすめメニュー・スタイル・休業日・設定
  log.push('✅ シートを作成しました（予約一覧／メニュー／おすすめメニュー／スタイル／休業日／設定）');

  // 2. 管理ページのパスワード
  const props = PropertiesService.getScriptProperties();
  if (PASSWORD) {
    props.setProperty('ADMIN_PASSWORD', PASSWORD);
    log.push('✅ 管理ページのパスワードを設定しました');
    log.push('   → 保存できたので、上の PASSWORD の行は空 \'\' に戻してください。'
      + 'コードに書いたまま誰かに画面を見せると、そのまま読まれてしまいます。');
  } else if (props.getProperty('ADMIN_PASSWORD')) {
    log.push('✅ 管理ページのパスワードは設定済みです');
  } else {
    log.push('❌ 管理ページのパスワードが未設定です。'
      + 'このファイル上部の PASSWORD にお好きな文字列を書いて、もう一度実行してください。');
  }

  // 3. 残りの手順
  if (!NOTIFY_EMAIL || NOTIFY_EMAIL === 'salon@example.com') {
    log.push('⚠️ 通知先メールが初期値のままです。上部の NOTIFY_EMAIL を変更してください。');
  }
  log.push('');
  log.push('--- このあとの手順 ---');
  log.push('1. 「デプロイ → 新しいデプロイ → ウェブアプリ」を開く');
  log.push('2. 次のユーザーとして実行 → 自分／アクセスできるユーザー → 全員');
  log.push('   （「全員」にしないとお客様の予約が届きません）');
  log.push('3. 発行された .../exec のURLを、サイトの assets/js/data.js の');
  log.push('   reservationEndpoint に貼る');

  const text = log.join('\n');
  console.log(text);
  // スプレッドシートから実行したときは画面にも出す
  try { SpreadsheetApp.getUi().alert(text); } catch (e) { /* エディタ実行時は出せない */ }
  return text;
}

/* ============================================================
   初回だけ実行：メニューまわりのシートを作る
   （エディタ上部の関数選択で setupMenuSheets を選んで実行）

   実行すると現在サイトに入っている内容が書き込まれます。
   以降は、このシートの行を足す／消すだけでサイトのメニューが変わります。
   ============================================================ */
function setupMenuSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const menu = ss.getSheetByName(MENU_SHEET) || ss.insertSheet(MENU_SHEET);
  if (menu.getLastRow() === 0) {
    menu.appendRow(MENU_HEADERS);
    menu.getRange(1, 1, 1, MENU_HEADERS.length).setFontWeight('bold').setBackground('#f3efea');
    menu.setFrozenRows(1);
    menu.appendRow(['カット', 'メンテナンスカット', '4000〜', 40, 'ツーブロック・刈り上げ・フェードのメンテナンス', '', '○']);
    menu.setColumnWidth(2, 260);
    menu.setColumnWidth(5, 260);
    menu.setColumnWidth(6, 280);
    menu.getRange('C2').setNote('「4000〜」と書くと、サイトでも「¥4,000〜」と出ます。空欄はお見積り扱いです。');
    menu.getRange('F1').setNote('画像のURL。管理者ページから写真を選べば自動で入ります。');
  }

  const closed = ss.getSheetByName(CLOSED_SHEET) || ss.insertSheet(CLOSED_SHEET);
  if (closed.getLastRow() === 0) {
    closed.appendRow(['休業日', 'メモ']);
    closed.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#f3efea');
    closed.setFrozenRows(1);
    closed.setColumnWidth(1, 130);
    closed.setColumnWidth(2, 260);
    closed.getRange('A2').setNote('日付を入れるとその日は予約できなくなります（例 2026-09-15）');
  }

  const setting = ss.getSheetByName(SETTING_SHEET) || ss.insertSheet(SETTING_SHEET);
  if (setting.getLastRow() === 0) {
    setting.appendRow(['項目', '内容']);
    setting.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#f3efea');
    setting.setFrozenRows(1);
    setting.setColumnWidth(1, 150);
    setting.setColumnWidth(2, 420);
    [['電話番号', ''], ['営業開始', '09:00'], ['営業終了', '22:00'], ['最終受付', '21:00'],
     ['キャッチコピー', ''], ['お知らせ', ''], ['定休曜日', ''],
     ['ロゴ画像', ''], ['スタッフ写真', ''], ['メイン写真', '']].forEach(r => setting.appendRow(r));
    setting.getRange('B8').setNote('休みにする曜日を「日,水」のように書きます。毎週その曜日が予約できなくなります。');
  }

  const style = ss.getSheetByName(STYLE_SHEET) || ss.insertSheet(STYLE_SHEET);
  if (style.getLastRow() === 0) {
    style.appendRow(STYLE_HEADERS);
    style.getRange(1, 1, 1, STYLE_HEADERS.length).setFontWeight('bold').setBackground('#f3efea');
    style.setFrozenRows(1);
    style.setColumnWidth(1, 300);
    style.setColumnWidth(4, 300);
    style.getRange('B2').setNote('ギャラリーの絞り込みタブになります。「ショート」「カラー」「店内」など。');
    [['白髪ぼかし・ホワイトメッシュ', 'カラー', '白髪ぼかし,ホワイトメッシュ', '', '○'],
     ['スパイキーショート', 'ショート', 'ショート,フェード', '', '○'],
     ['シャドウパーマ・マッシュ', 'パーマ', 'パーマ,マッシュ', '', '○'],
     ['店内', '店内', '半個室,ドリンクサービス', '', '○']].forEach(r => style.appendRow(r));
  }

  const coupon = ss.getSheetByName(COUPON_SHEET) || ss.insertSheet(COUPON_SHEET);
  if (coupon.getLastRow() === 0) {
    coupon.appendRow(COUPON_HEADERS);
    coupon.getRange(1, 1, 1, COUPON_HEADERS.length).setFontWeight('bold').setBackground('#f3efea');
    coupon.setFrozenRows(1);
    [
      ["【清潔感と品が続く】men's骨格補正カット＋眉カット", 6900, '', 70,
        '骨格・髪質・雰囲気を見極めた大人メンズカジュアル。眉カットまで整えます。', '', '全員', '', '○'],
      ['【全ての身嗜み整える＋最高の体験を】ラグジュアリーカットコース', 10000, '', 110,
        'カットに加え、トリートメントとヘッドスパまで。身だしなみをトータルで整えます。', '', '全員', '', '○'],
      ['【毎朝のセット1分】品よく決まるお悩み解決メンズパーマ', 14500, '', 120,
        '直毛や動きが出にくい髪も、扱いやすく自然なメンズパーマに。', '', '全員', '', '○'],
      ['【彩で見せるワンランク上のお洒落を】カット＋カラー', 14500, '', 120,
        '髪の状態と仕上がりに合わせて薬剤を選び、品のある色味に仕上げます。', '', '全員', '', '○'],
      ["【立体感で格が上がる】伸びても自然！白髪ぼかしホワイトメッシュ men's", 19800, '', 150,
        '白髪を隠すのではなく活かす白髪ぼかし。伸びても境目が出にくい仕上がりに。', '', '全員', '', '○'],
      ['【地毛より綺麗】自然に柔らかく仕上げるメンズ縮毛矯正', 22000, '', 180,
        'クセや広がりを抑えつつ、不自然にならない自然な質感に。', '', '全員', '', '○']
    ].forEach(r => coupon.appendRow(r));
    coupon.setColumnWidth(1, 320);
    coupon.setColumnWidth(5, 300);
  }

  SpreadsheetApp.getUi
    ? console.log('メニューのシートを作成しました')
    : null;
}

/* ============================================================
   前日リマインドメール（任意）

   使う場合は「トリガー」で
   ・実行する関数 → sendReminders
   ・イベントのソース → 時間主導型
   ・タイプ → 日付ベースのタイマー（例：午後6時〜7時）
   ============================================================ */
function sendReminders() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const target = Utilities.formatDate(tomorrow, 'Asia/Tokyo', 'yyyy-MM-dd');

  const rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const col = n => HEADERS.indexOf(n);
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
      'ご都合が変わられた場合は、お手数ですがご連絡ください。',
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
   動作確認用：サイトを触らずに1件テスト登録する
   ============================================================ */
function testReserve() {
  doReserve_(getSheet_(), {
    code: 'LM-TEST1',
    createdAt: new Date().toISOString(),
    date: '2026-09-01', time: '11:00', endTime: '12:10', totalMinutes: 70,
    menus: [{ name: "【清潔感と品が続く】men's骨格補正カット＋眉カット" }],
    staffId: 'st01', staffName: 'MATTEO', nominationFee: 0, totalPrice: 6900,
    customer: {
      name: 'テスト 太郎', kana: 'テスト タロウ',
      tel: '09000000000', email: 'test@example.com',
      visit: '初めて', request: 'これはテストです'
    }
  });
}
