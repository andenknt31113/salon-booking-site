/* GAS を模した受信サーバー
   - CORS プリフライト(OPTIONS)には応答しない（GAS と同じ挙動）
   - reserve / cancel / availability / menu / lookup を処理する
   - 台帳・メニュー・クーポンをサーバー側で保持する（スプレッドシート相当） */
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { demoCatalog, demoReservations, demoHtml } from '../tools/demo-support.mjs';

/* このファイルの1つ上（リポジトリの直下）をサイトの置き場所として配信する */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_HOST = '127.0.0.1';
export function createMockHandler({ port = 8820, demoMode = false, apiOnly = false } = {}) {
const PORT = port;
const DEMO_MODE = demoMode;
const DEMO_PAGES = new Set(['index.html', 'admin.html', 'design-a.html', 'reserve.html', 'mypage.html',
  'menu.html', 'gallery.html', 'staff.html', 'reviews.html', 'privacy.html', 'favicon.svg']);
const SITE_PAGES = new Set([...DEMO_PAGES, '404.html', 'robots.txt', 'sitemap.xml']);
const LEDGER = [];
const issueCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = 'LM-' + Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    if (!LEDGER.some(row => sameCode(row.code, code))) return code;
  }
  throw new Error('予約番号を発行できませんでした。');
};
const PHONE_REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{16,80}$/;
const PHONE_MINUTES_PER_DAY = 24 * 60;
const phoneContent = data => JSON.stringify({ date: data.date, time: data.time, minutes: Number(data.minutes),
  price: Number(data.price || 0), name: String(data.name || '').trim(), tel: String(data.tel || ''),
  menu: String(data.menu || '').trim() || '（電話予約）', memo: String(data.memo || '').trim() });
const adminReservation = reservation => ({ code: reservation.code, date: reservation.date, time: reservation.time,
  endTime: reservation.endTime, menu: (reservation.menus || []).map(menu => menu.name).join(' / '),
  staffName: reservation.staffName, price: reservation.totalPrice, name: reservation.customer?.name || '',
  tel: reservation.customer?.tel || '', email: reservation.customer?.email || '', visit: reservation.customer?.visit || '',
  request: reservation.customer?.request || '', note: String(reservation.note || '').replace(/^'(?=[=+\-@])/, ''),
  source: reservation.source || '', status: reservation.cancelled ? 'キャンセル' : '予約確定' });
const phoneResult = (reservation, duplicate) => ({ ok: true, code: reservation.code, endTime: reservation.endTime,
  requestId: reservation.phoneRequestId || '', duplicate, reservation: adminReservation(reservation) });

/* スプレッドシートの「メニュー」「クーポン」シート相当 */
const SHEET_MENU = [
  { 区分: 'カット', メニュー名: 'メンズカット', 価格: '4000〜', '所要(分)': 50, 説明: 'カット価格はこちらから', 画像: '', 表示: '○' },
  { 区分: 'カット', メニュー名: '【シート追加】キッズカット', 価格: 2500, '所要(分)': 30, 説明: '小学生以下', 画像: '', 表示: '○' },
  { 区分: 'スパ', メニュー名: '【シート追加】炭酸スパ', 価格: 3000, '所要(分)': 30, 説明: '', 画像: '/mock-image.svg?seed=spa', 表示: '○' },
  { 区分: 'スパ', メニュー名: '【非表示テスト】旧メニュー', 価格: 9999, '所要(分)': 30, 説明: '', 画像: '', 表示: '×' }
];
/* 「休業日」シート相当：3日後を休みにしてみる */
const d = new Date(); d.setDate(d.getDate()+3);
const SHEET_CLOSED = [`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`];

const SHEET_REVIEW = [];

const SHEET_STYLE = [
  { タイトル:'白髪ぼかし・ホワイトメッシュ', 分類:'カラー', タグ:'白髪ぼかし,ホワイトメッシュ', 画像:'/mock-image.svg?seed=s1', 表示:'○' },
  { タイトル:'スパイキーショート', 分類:'ショート', タグ:'ショート,フェード', 画像:'', 表示:'○' },
  { タイトル:'店内', 分類:'店内', タグ:'半個室', 画像:'/mock-image.svg?seed=s3', 表示:'○' },
  { タイトル:'【非表示】古い写真', 分類:'ショート', タグ:'', 画像:'', 表示:'×' }
];

const SHEET_COUPON = [
  { メニュー名: '【シート】men\'s骨格補正カット＋眉カット', 価格: 6900, 通常価格: '', '所要(分)': 70, 説明: 'シート由来', 条件: '', 対象: '全員', タグ: 'カット', 画像: '/mock-image.svg?seed=cp', 表示: '○' },
  { メニュー名: '【シート】メンズ縮毛矯正', 価格: 22000, 通常価格: 24000, '所要(分)': 180, 説明: 'シート由来', 条件: '', 対象: '全員', タグ: 'カット,縮毛矯正', 画像: '', 表示: '○' }
];

/* 初期値の控え。reset で全部ここに戻します。

   このサーバーは立ち上げっぱなしにできるので、先に流した試験が
   休業日やメニューを書き換えたまま次の試験に入ります。すると
   「今日は休業日です」と断られるなど、サイトのせいではない失敗が出ます。
   台帳（LEDGER）だけ空にしても足りません。 */

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};
/* テスト用：応答をわざと遅らせる（通信が遅い状況の再現）。
   {"type":"slowmode","ms":2000} を送ると以降の応答が遅くなる。 */
const SLOW = { ms: 0 };
const reply = (res, obj) => {
  const send = () => {
    res.writeHead(200, { 'Content-Type': 'application/json', ...(apiOnly ? {} : { 'Access-Control-Allow-Origin': '*' }) });
    res.end(JSON.stringify(obj));
  };
  SLOW.ms ? setTimeout(send, SLOW.ms) : send();
};
const ADMIN_PW = 'test1234';
const TOKENS = new Set();
const FAIL = { on: false };
const HTML = { on: false };
/* 本物と同じ受付期限（前日18時） */
const DEADLINE_DAYS = 1, DEADLINE_HOUR = 18;
function withinDeadline(dateKey) {
  const [y,m,dd] = String(dateKey).split('-').map(Number);
  if (!y) return true;
  const limit = new Date(y, m-1, dd);
  limit.setDate(limit.getDate() - DEADLINE_DAYS);
  limit.setHours(DEADLINE_HOUR, 0, 0, 0);
  return Date.now() < limit.getTime();
}
const deadlineMsg = () => 'ネットでの変更・キャンセルは前日' + DEADLINE_HOUR
  + '時までとなっております。お手数ですが店舗までご連絡ください。';
const UPLOADS = [];
/* 「準備中の帯」を出していると、本物は新規予約を断ります（gas/Code.gs の draftMode_）。
   この模擬サーバーは**すでに公開している店**として動かします。出したままだと
   予約の試験が全部断られて、何を試しているのか分からなくなるためです。
   準備中そのものの振る舞いは、UC32 が値を「出す」に変えて確かめます。 */
let SHEET_SETTINGS = { '準備中の帯': '出さない',
  '電話番号': '', '営業開始': '09:00', '営業終了': '22:00', '最終受付': '21:00',
  'LINE友だち追加URL': '', 'Google口コミURL': '',
  'キャッチコピー': '', 'お知らせ': '', '定休曜日': '', '通知先メール': 'shop@example.com', 'ロゴ画像': '', 'スタッフ写真': '', 'メイン写真': '',
  'ホットペッパー手数料率（％）': '', 'ホットペッパー掲載料（月額・円）': '' };

const INITIAL = JSON.parse(JSON.stringify({
  menu: SHEET_MENU, closed: SHEET_CLOSED, style: SHEET_STYLE, coupon: SHEET_COUPON,
  settings: SHEET_SETTINGS
}));
if (DEMO_MODE) {
  const catalog = demoCatalog();
  SHEET_MENU.splice(0, SHEET_MENU.length, ...catalog.menus);
  SHEET_COUPON.splice(0, SHEET_COUPON.length, ...catalog.coupons);
  SHEET_STYLE.splice(0, SHEET_STYLE.length, ...catalog.styles);
  INITIAL.menu = catalog.menus;
  INITIAL.coupon = catalog.coupons;
  INITIAL.style = catalog.styles;
  LEDGER.push(...demoReservations());
}
/* 本物の GAS と同じ価格の読み方 */
function parsePrice(v) {
  const t = String(v ?? '').trim();
  const n = Number(t.replace(/[^0-9.]/g, ''));
  return { value: isNaN(n) ? 0 : n, from: /[〜~]/.test(t) };
}
/* 本番（gas/Code.gs）と同じ読み取り方をします。
   ここを甘くすると、試験は通るのに本番では通らない、という
   いちばん困る食い違いが起きます。 */
const halfWidth = v => String(v ?? '')
  .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/　/g, ' ');
const parseBookableMinutes = value => {
  const match = halfWidth(value).trim().match(/^(\d+)\s*分?$/);
  const minutes = match ? Number(match[1]) : NaN;
  return Number.isInteger(minutes) && minutes >= 15 && minutes <= 480 ? minutes : null;
};
const isShown = value => {
  const display = halfWidth(value).trim().toLowerCase();
  return !['×', '✕', '✖', '✗', 'x', '非表示', '非公開', '休止', '停止', 'false', 'no', 'off', '0'].includes(display);
};
const digits = v => halfWidth(v).replace(/\D/g, '');
/* 予約番号は英数字だけを見て、大文字に揃えて突き合わせます */
const codeKey = v => halfWidth(v).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const sameCode = (a, b) => !!codeKey(a) && codeKey(a) === codeKey(b);

/* 予約の入口。本物（gas/Code.gs の SOURCE_LABELS）と同じ一覧で、
   知らない言葉は空にします。ここを素通しにすると、
   受け口が断るはずのものが試験では通ってしまいます。 */
const SOURCE_LABELS = ['LINE', 'Googleマップ', '名刺・店内QR', 'Instagram',
                       'ホットペッパー', '検索', 'ほかのサイト', '直接', '電話・来店'];
const sourceLabel = v => {
  const t = String(v ?? '').trim();
  return SOURCE_LABELS.includes(t) ? t : '';
};

/* 合言葉なしの応答に入れてよい設定。本物（gas/Code.gs の PUBLIC_SETTING_KEYS）と
   同じ並びにしてください（test/settings.mjs が突き合わせています）。
   ここを素通しにすると、本番では店の契約条件が漏れるのに、試験は通ります。 */
const PUBLIC_SETTING_KEYS = [
  '準備中の帯', '準備中の文言',
  '電話番号', '営業開始', '営業終了', '最終受付', '定休曜日',
  '変更・キャンセル期限（何日前）', '変更・キャンセル期限（何時）',
  'キャッチコピー', 'お知らせ', '店の紹介文', 'こだわり条件',
  '住所', '地図の検索文字列', 'アクセス', '道案内', '駐車場', '支払い方法', '席数',
  'スタッフの肩書き', 'スタッフの経験年数', 'スタッフの得意分野', 'スタッフの紹介文',
  'ロゴ画像', 'スタッフ写真', 'メイン写真',
  'LINE友だち追加URL', 'Google口コミURL',
  '事業者名', '代表者名', '問い合わせ先メール', 'プライバシーポリシー制定日'
];
const publicSettings = st => Object.fromEntries(
  PUBLIC_SETTING_KEYS.filter(k => k in st).map(k => [k, st[k]]));

/* シート行を GAS と同じ形に変換する */
function buildMenu() {
  const groups = [];
  SHEET_MENU.forEach((r, i) => {
    if (!String(r.メニュー名 || '').trim() || !isShown(r.表示)) return;
    const minutes = parseBookableMinutes(r['所要(分)']);
    if (minutes === null) return;
    /* 区分が空でも、本物と同じ既定名でまとめます。
       ここを本番より緩くすると、本番では起きない不具合を試験で作れてしまいます。 */
    const catName = String(r.区分 || 'メニュー').trim();
    let g = groups.find(x => x.name === catName);
    if (!g) { g = { id: 'cat' + groups.length, name: catName, items: [] }; groups.push(g); }
    const p = parsePrice(r.価格);
    g.items.push({ id: 'sm' + i, name: r.メニュー名, price: p.value, priceFrom: p.from,
      minutes, note: r.説明, image: String(r.画像 || '') });
  });
  return groups.length ? groups : null;
}
function buildReviews() {
  const out = SHEET_REVIEW.filter(r => String(r.状態).trim() === '掲載中').map((r, i) => ({
    id: 'rv' + i, score: Number(r.評価)||5, nickname: r.ニックネーム, age: r.年代||'', gender: r.性別||'',
    date: r.投稿日, title: r.タイトル||'', body: r.本文, staffId: null,
    staffName: r.担当||'', menu: r.メニュー||''
  }));
  return out.length ? out : null;
}

function buildStyles() {
  const out = SHEET_STYLE.filter(r => String(r.表示).trim() !== '×').map((r, i) => ({
    id: 'ss' + i, title: r.タイトル, length: String(r.分類 || 'スタイル').trim(), staffId: null,
    tags: String(r.タグ || '').split(/[,、・\s]+/).filter(Boolean), detail: String(r.説明 || ''),
    image: String(r.画像 || ''), hue: (i * 37) % 360
  }));
  return out.length ? out : null;
}

function buildCoupons() {
  const out = [];
  SHEET_COUPON.forEach((r, i) => {
    if (!String(r.メニュー名 || '').trim() || !isShown(r.表示)) return;
    const minutes = parseBookableMinutes(r['所要(分)']);
    if (minutes === null) return;
    const p = parsePrice(r.価格);
    out.push({ id: 'sc' + i, badge: String(r.対象 || '全員').trim(), title: r.メニュー名, detail: r.説明,
      tags: String(r.タグ || '').split(/[,、・\s]+/).filter(Boolean),
      price: p.value, priceFrom: p.from, listPrice: Number(r.通常価格) || null,
      minutes, terms: r.条件, image: String(r.画像 || '') });
  });
  return out.length ? out : null;
}

/* 本物の GAS と同じ、休業日・受けない時間帯の判定 */
function hitsClosed(dateKey, time, minutes) {
  const toMin = t => { const m = String(t||'').match(/^(\d{1,2}):(\d{2})/); return m ? +m[1]*60 + +m[2] : 0; };
  const start = toMin(time), end = start + (Number(minutes) || 30);
  return SHEET_CLOSED.some(c => {
    if (typeof c === 'string') return c === dateKey;
    if (c.date !== dateKey) return false;
    return start < toMin(c.end) && toMin(c.start) < end;
  });
}

function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const date = new Date(value + 'T12:00:00+09:00');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function changeTarget(reservation, data, asAdmin) {
  const start = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(data.time))
    ? Number(data.time.slice(0, 2)) * 60 + Number(data.time.slice(3)) : NaN;
  if (!validDateKey(data.date) || !Number.isFinite(start)) {
    return { ok: false, error: '日時が正しくありません。' };
  }
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const ahead = Math.round((Date.parse(data.date + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
  if (ahead < 0) return { ok: false, error: 'すでに過ぎた日付には変更できません。' };
  if (ahead > 60) return { ok: false, error: 'ご予約は60日先まで承っております。' };
  const currentMinute = (now.getUTCHours() * 60 + now.getUTCMinutes() + 9 * 60) % PHONE_MINUTES_PER_DAY;
  if (asAdmin && ahead === 0 && start < currentMinute) {
    return { ok: false, error: 'すでに過ぎた時刻には変更できません。' };
  }
  if (!asAdmin && ahead * PHONE_MINUTES_PER_DAY + start - currentMinute < 2 * 60 - 15) {
    return { ok: false, error: '当日のご予約は2時間前までとなっております。お手数ですが店舗までお電話ください。' };
  }
  const minutes = Number(reservation.totalMinutes);
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 480) {
    return { ok: false, error: '所要時間が正しくありません。' };
  }
  const toMinute = time => Number(String(time).slice(0, 2)) * 60 + Number(String(time).slice(3, 5));
  const open = toMinute(SHEET_SETTINGS['営業開始'] || '09:00');
  const close = toMinute(SHEET_SETTINGS['営業終了'] || '22:00');
  const last = toMinute(SHEET_SETTINGS['最終受付'] || '21:00');
  if (start < open || start > Math.min(last, close) || start + minutes > close) {
    return { ok: false, error: '営業時間外のご予約は承れません。' };
  }
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][new Date(data.date + 'T12:00:00Z').getUTCDay()];
  if (String(SHEET_SETTINGS['定休曜日'] || '').split(/[,、・\s]+/).some(value => value.replace(/曜日?$/, '') === weekday)) {
    return { ok: false, error: 'その日は定休日のため、ご予約を承れません。' };
  }
  if (hitsClosed(data.date, data.time, minutes)) {
    return { ok: false, error: 'ご希望の時間は、店舗の都合により受付を止めております。別の日時をお選びください。' };
  }
  if (LEDGER.some(row => !row.cancelled && !sameCode(row.code, data.code) && row.date === data.date
      && start < toMinute(row.endTime) && toMinute(row.time) < start + minutes)) {
    return { ok: false, error: 'ご希望の時間は、ちょうど他のお客様のご予約が入りました。' };
  }
  return { ok: true, start, minutes };
}

return (req, res) => {
  if (apiOnly && (req.url !== '/exec' || req.method !== 'POST')) { res.writeHead(404).end(); return; }
  if (DEMO_MODE && !apiOnly) {
    const origin = `http://${LOCAL_HOST}:${PORT}`;
    if (req.headers.host !== `${LOCAL_HOST}:${PORT}` || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end(); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; form-action 'none'; object-src 'none'; base-uri 'self'");
    if (req.url === '/demo-ui.js') {
      res.writeHead(200, { 'Content-Type': types['.js'] });
      res.end(readFileSync(join(ROOT, 'tools/demo-ui.js'))); return;
    }
    if (req.url.startsWith('/exec') && req.method !== 'POST') { res.writeHead(405).end(); return; }
  }
  if (!apiOnly && req.url.split('?')[0] !== '/exec' && !req.url.startsWith('/mock-image.svg')) {
    try {
      const path = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
      const asset = path.startsWith('assets/') && !path.split('/').some(part => part.startsWith('.'));
      const pages = DEMO_MODE ? DEMO_PAGES : SITE_PAGES;
      if ((!pages.has(path) && !asset) || !['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(404).end(); return;
      }
      const file = realpathSync(resolve(ROOT, path));
      if (!file.startsWith(resolve(ROOT) + sep) || (asset && !file.startsWith(resolve(ROOT, 'assets') + sep)) || !statSync(file).isFile()) {
        res.writeHead(404).end(); return;
      }
    } catch (error) { res.writeHead(404).end(); return; }
  }
  if (req.url.startsWith('/mock-image.svg')) {
    res.writeHead(200, { 'Content-Type':'image/svg+xml', 'Access-Control-Allow-Origin':'*' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#7B2B22"/></svg>');
    return;
  }
  if (req.url.startsWith('/exec')) {
    if (req.method === 'OPTIONS') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let d;
      try { d = JSON.parse(body); } catch (error) { res.writeHead(400).end(); return; }
      if (!d || typeof d !== 'object' || Array.isArray(d)
          || (d.type !== undefined && typeof d.type !== 'string')) { res.writeHead(400).end(); return; }
      if (DEMO_MODE && ['slowmode', 'failmode', 'htmlmode'].includes(d.type)) {
        res.writeHead(400).end(); return;
      }
      if (d.type === 'slowmode') { SLOW.ms = Number(d.ms) || 0; const t = SLOW.ms; SLOW.ms = 0; const r = { ok: true, ms: t }; reply(res, r); SLOW.ms = t; return; }

      /* テスト用：台帳を空に戻す。

         このサーバーは立ち上げっぱなしにできるので、前に流した試験の
         予約が残ります。すると「空いているはずの時間が埋まっている」と
         いう、サイトのせいではない失敗が出ます。
         試験のはじめにここを呼んで、まっさらから始めます。 */
      if (d.type === 'reset') {
        LEDGER.length = 0; SHEET_REVIEW.length = 0; UPLOADS.length = 0;
        TOKENS.clear(); SLOW.ms = 0; FAIL.on = false; HTML.on = false;
        // シートの中身も初期値に戻す（前の試験の書き換えを持ち越さない）
        const restore = (arr, init) => { arr.length = 0; JSON.parse(JSON.stringify(init)).forEach(x => arr.push(x)); };
        restore(SHEET_MENU, INITIAL.menu);
        restore(SHEET_CLOSED, INITIAL.closed);
        restore(SHEET_STYLE, INITIAL.style);
        restore(SHEET_COUPON, INITIAL.coupon);
        /* 設定も戻します。初期値は1か所（INITIAL.settings）にしてあります。
           2か所に書いていたころは、片方に項目を足すともう片方が古いままになり、
           reset のあとだけ設定が欠ける、という追いにくい壊れ方をしました。 */
        SHEET_SETTINGS = JSON.parse(JSON.stringify(INITIAL.settings));
        if (DEMO_MODE) LEDGER.push(...demoReservations());
        return reply(res, { ok: true });
      }

      // テスト用：受信側が失敗を返す状態を作る
      if (d.type === 'failmode') { FAIL.on = !!d.on; return reply(res, { ok:true, fail: FAIL.on }); }

      /* テスト用：Apps Script がJSONではなくHTMLを返す状態を作る。

         公開の設定を「全員」以外にして入れ直すと、実際にこれが起きます。
         受け取る側にはログイン画面のHTMLが返り、JSONとして読めません。
         お客様には「送れませんでした」と分かる必要があります。 */
      if (d.type === 'htmlmode') { HTML.on = !!d.on; return reply(res, { ok:true, html: HTML.on }); }
      if (HTML.on && d.type !== 'reset') {
        res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Access-Control-Allow-Origin':'*' });
        res.end('<!doctype html><html><body>Googleアカウントでログインしてください</body></html>');
        return;
      }
      /* 準備中のあいだは新規予約を受けない（本物の draftMode_ と同じ読み方）。
         変更・キャンセルと、店から入れる電話予約は止めない。 */
      if (d.type === 'reserve' || !d.type) {
        /* 「出さない」と読めるとき以外は準備中。空欄も、知らない文字も準備中です。
           本物（gas/Code.gs の draftMode_）は既定を定数で持っているぶん
           「出す」側の判定も要りますが、こちらは既定が固定なので1行で足ります。 */
        const v = String(SHEET_SETTINGS['準備中の帯'] ?? '').trim();
        const on = !/^(出さない|表示しない|しない|いいえ|false|off|no|×|x)/i.test(v);
        if (on) return reply(res, { ok:false, draft:true,
          error:'ただいま準備中のため、ネットでのご予約はお受けしておりません。'
            + 'お手数ですが、お電話でお問い合わせください。' });
      }
      if (FAIL.on && (d.type === 'reserve' || !d.type || d.type === 'change' || d.type === 'cancel')) {
        return reply(res, { ok:false, error:'台帳が混み合っています。しばらくしてお試しください。' });
      }

      // ---- 管理ページ ----
      if (d.type && d.type.startsWith('admin')) {
        const authed = DEMO_MODE || d.password === ADMIN_PW || (d.token && TOKENS.has(d.token));
        if (!authed) return reply(res, { ok:false, error:'パスワードが違います。' });
        if (d.type === 'adminLogin') {
          if (!d.remember) return reply(res, { ok:true });
          const t = 'tok-' + Math.random().toString(36).slice(2) + Date.now();
          TOKENS.add(t);
          return reply(res, { ok:true, token:t });
        }
        if (d.type === 'adminAdd') {
          const toMin = t => { const m=String(t||'').match(/^(\d{1,2}):(\d{2})/); return m?+m[1]*60+ +m[2]:0; };
          const mins = d.minutes == null || d.minutes === '' ? 60 : Number(d.minutes);
          if (!d.date || !d.time) return reply(res, { ok:false, error:'来店日と開始時刻をご確認ください。' });
          if (!String(d.name||'').trim()) return reply(res, { ok:false, error:'お名前をご入力ください。' });
          const start = toMin(d.time), end = start + mins;
          const date = new Date(d.date + 'T12:00:00+09:00');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== d.date
              || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time) || !Number.isInteger(mins) || mins < 15 || mins > 480
              || end >= PHONE_MINUTES_PER_DAY || !Number.isFinite(Number(d.price || 0)) || Number(d.price || 0) < 0 || Number(d.price || 0) > 1000000) {
            return reply(res, { ok: false, error: '日時・所要時間・金額をご確認ください。' });
          }
          if (d.requestId && !PHONE_REQUEST_ID_PATTERN.test(d.requestId)) return reply(res, { ok: false, error: '受付IDが正しくありません。' });
          const content = phoneContent(d);
          const previous = d.requestId && LEDGER.find(row => row.phoneRequestId === d.requestId);
          if (previous) return reply(res, previous.phoneContent === content ? phoneResult(previous, true)
            : { ok: false, requestConflict: true, error: 'この受付は別の内容で登録済みです。登録結果を確認してください。' });
          if (!d.force) {
            const taken = LEDGER.some(x => !x.cancelled && x.date === d.date
              && start < toMin(x.endTime) && toMin(x.time) < end);
            if (taken) return reply(res, { ok:false, confirm:true,
              error:'この時間には、すでに別のご予約が入っています。それでも登録しますか？' });
            if (hitsClosed(d.date, d.time, mins)) return reply(res, { ok:false, confirm:true,
              error:'この時間は、休業日または受付を止めている時間帯です。それでも登録しますか？' });
          }
          const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
          let code;
          do { code = 'LM-' + Array.from({length:5}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
          while (LEDGER.some(r => r.code === code));
          const endTime = ('0'+Math.floor(end/60)%24).slice(-2)+':'+('0'+end%60).slice(-2);
          LEDGER.push({ code, date:d.date, time:d.time, endTime, totalMinutes:mins,
            menus:[{ name: d.menu || '（電話予約）' }], staffName:'MATTEO', staffId:'st01',
            totalPrice:Number(d.price)||0,
            customer:{ name:d.name, tel:d.tel||'', email:'', visit:'電話・来店', request:d.memo||'' },
            /* 電話・来店で受けた分は、サイト経由と混ぜません（本物と同じ） */
            source:'電話・来店', cancelled:false, phoneRequestId: d.requestId || '', phoneContent: content });
          return reply(res, phoneResult(LEDGER[LEDGER.length - 1], false));
        }
        if (d.type === 'adminAddStatus') {
          if (!PHONE_REQUEST_ID_PATTERN.test(String(d.requestId || ''))) return reply(res, { ok: false, error: '受付IDが正しくありません。' });
          const reservation = LEDGER.find(row => row.phoneRequestId === d.requestId);
          return reply(res, reservation ? { ...phoneResult(reservation, true), found: true }
            : { ok: true, requestId: d.requestId, found: false });
        }
        /* 施術メモ（次回への申し送り）。店だけが書き、店だけが読みます。
           本番と同じで、長さを切り詰め、数式に見える文字列は文字として扱います。 */
        if (d.type === 'adminNote') {
          const r = LEDGER.find(x => x.code === d.code);
          if (!r) return reply(res, { ok:false, error:'該当する予約が見つかりません: ' + d.code });
          let note = String(d.note == null ? '' : d.note).trim().slice(0, 1000);
          if (/^[=+\-@]/.test(note)) note = "'" + note;
          r.note = note;
          return reply(res, { ok:true, code:r.code, note: /^'[=+\-@]/.test(note) ? note.slice(1) : note });
        }
        if (d.type === 'adminChange') {
          const reservation = LEDGER.find(row => sameCode(row.code, d.code));
          if (!reservation) return reply(res, { ok: false, error: '該当する予約が見つかりません。最新の予定を読み込んでください。' });
          if (!d.fromDate || !d.fromTime) return reply(res, { ok: false, error: '変更前の日時が必要です。最新の予定を読み込んでください。' });
          if (reservation.date !== d.fromDate || reservation.time !== d.fromTime) {
            return reply(res, { ok: false, stale: true, error: '別の画面で予約日時が変わりました。最新の予定を確認してください。' });
          }
          if (reservation.cancelled) return reply(res, { ok: false, error: 'キャンセル済みのご予約は変更できません。' });
          const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
          if (reservation.date < today) return reply(res, { ok: false, error: '過ぎたご予約の日時は変更できません。' });
          if (reservation.date === d.date && reservation.time === d.time) return reply(res, { ok: false, error: '変更前と同じ日時です。' });
          const target = changeTarget(reservation, d, true);
          if (!target.ok) return reply(res, target);
          reservation.changedFrom = { date: reservation.date, time: reservation.time };
          reservation.date = d.date;
          reservation.time = d.time;
          reservation.endTime = `${String(Math.floor((target.start + target.minutes) / 60)).padStart(2, '0')}:${String((target.start + target.minutes) % 60).padStart(2, '0')}`;
          return reply(res, { ok: true, reservation: adminReservation(reservation) });
        }
        if (d.type === 'adminUpload') {
          const raw = String(d.dataBase64 || '');
          if (!raw) return reply(res, { ok:false, error:'画像が空です。' });
          const bytes = Buffer.from(raw.slice(raw.indexOf(',')+1), 'base64').length;
          const name = String(d.slot||'image').replace(/[^A-Za-z0-9_-]/g,'') + '-' + UPLOADS.length + '.jpg';
          UPLOADS.push({ name, mimeType: d.mimeType, bytes });
          // 本番は Google ドライブのURL。ここでは表示できる代用の画像を返す
          return reply(res, { ok:true, name, url:'/mock-image.svg?n=' + UPLOADS.length });
        }
        const stampOf = t => {
          const src = { menus:SHEET_MENU, coupons:SHEET_COUPON, styles:SHEET_STYLE,
                        reviews:SHEET_REVIEW, closed:SHEET_CLOSED, settings:SHEET_SETTINGS }[t];
          return String(JSON.stringify(src)).length + ':' +
            [...JSON.stringify(src)].reduce((h,c)=>((h*31+c.charCodeAt(0))>>>0), 7).toString(16);
        };
        const allStamps = () => Object.fromEntries(
          ['menus','coupons','styles','reviews','closed','settings'].map(t => [t, stampOf(t)]));
        if (d.type === 'adminData') return reply(res, { ok:true, stamps: allStamps(), capabilities: { phoneRequestIds: true, adminChange: true },
          reservations: LEDGER.map(adminReservation),
          menus: SHEET_MENU, coupons: SHEET_COUPON, styles: SHEET_STYLE, reviews: SHEET_REVIEW,
          closedDates: SHEET_CLOSED.map(c=> typeof c==='string' ? { '休業日': c, '開始':'', '終了':'', 'メモ':'' } : { '休業日': c.date, '開始': c.start, '終了': c.end, 'メモ':'' }),
          settings: SHEET_SETTINGS });
        if (d.type === 'adminSave') {
          /* 本番と同じで、印の無い保存も断ります */
          if (d.stamp !== stampOf(d.target)) {
            return reply(res, { ok:false, stale:true,
              error:'この内容は、別の端末から変更されています。いったん読み込み直してください。' });
          }
          if (d.target === 'menus' || d.target === 'coupons') {
            const invalidIndex = (d.rows || []).findIndex(row => row
              && String(row['メニュー名'] || '').trim() && isShown(row.表示)
              && parseBookableMinutes(row['所要(分)']) === null);
            if (invalidIndex >= 0) {
              return reply(res, { ok:false, invalidDuration:true, invalidRow:invalidIndex,
                error:'予約に出すメニューの' + (invalidIndex + 1)
                  + '件目の所要時間をご確認ください。15〜480分の整数を入力するか、表示を外してください。' });
            }
          }
          if (d.target === 'closed') { SHEET_CLOSED.length = 0; (d.rows||[]).forEach(r=>{
            if (!r['休業日']) return;
            if (r['開始'] && r['終了']) SHEET_CLOSED.push({ date:r['休業日'], start:r['開始'], end:r['終了'] });
            else SHEET_CLOSED.push(r['休業日']);
          }); }
          if (d.target === 'menus') { SHEET_MENU.length = 0; (d.rows||[]).forEach(r=>SHEET_MENU.push(r)); }
          if (d.target === 'coupons') { SHEET_COUPON.length = 0; (d.rows||[]).forEach(r=>SHEET_COUPON.push(r)); }
          if (d.target === 'styles') { SHEET_STYLE.length = 0; (d.rows||[]).forEach(r=>SHEET_STYLE.push(r)); }
          if (d.target === 'reviews') { SHEET_REVIEW.length = 0; (d.rows||[]).forEach(r=>SHEET_REVIEW.push(r)); }
          if (d.target === 'settings') SHEET_SETTINGS = d.rows || {};
          return reply(res, { ok:true, stamps: allStamps() });
        }
      }

      if (d.type === 'uploads') return reply(res, { ok:true, uploads: UPLOADS });

      if (d.type === 'menu') {
        return reply(res, { ok: true, categories: buildMenu(), coupons: buildCoupons(), styles: buildStyles(), reviews: buildReviews(), closedDates: SHEET_CLOSED, settings: publicSettings(SHEET_SETTINGS) });
      }

      if (d.type === 'availability') {
        const today = new Date().toISOString().slice(0, 10);
        return reply(res, {
          ok: true,
          booked: LEDGER.filter(r => !r.cancelled && r.date >= today)
            .map(r => ({ date: r.date, time: r.time, minutes: r.totalMinutes, staffId: r.staffId || null }))
        });
      }

      /* テスト用：台帳に1行そのまま置く。
         数字タブの試験で、先月ぶんや入口ごとの件数を作るのに使います。
         受け口の確認（営業時間・直前すぎる予約）を通さずに置けるので、
         ここは試験専用です。本物の Code.gs にはありません。 */
      if (d.type === 'seed') {
        LEDGER.push({ code: d.code, date: d.date, time: d.time, endTime: d.endTime,
          totalMinutes: Number(d.totalMinutes) || 60,
          menus: [{ name: d.menu || 'カット' }], staffName: 'MATTEO', staffId: 'st01',
          totalPrice: Number(d.price) || 0,
          customer: { name: d.name || 'テスト', tel: d.tel || '09000000000', email: '',
                      visit: d.visit || '', request: '' },
          source: sourceLabel(d.source), cancelled: !!d.cancelled });
        return reply(res, { ok: true, code: d.code });
      }

      // テスト用：来店済みの状態を作る
      if (d.type === 'backdate') {
        const r = LEDGER.find(x => sameCode(x.code, d.code));
        if (r) { const y = new Date(); y.setDate(y.getDate()-1); r.date = y.toISOString().slice(0,10); }
        return reply(res, { ok:!!r });
      }

      if (d.type === 'review') {
        const body = String(d.body||'').trim();
        if (!body) return reply(res, { ok:false, error:'ご感想をご入力ください。' });
        const r = LEDGER.find(x => sameCode(x.code, d.code));
        if (!r || !digits(d.tel) || digits(r.customer?.tel) !== digits(d.tel)) {
          return reply(res, { ok:false, error:'ご予約が確認できませんでした。' });
        }
        if (r.cancelled) return reply(res, { ok:false, error:'キャンセルされたご予約には投稿いただけません。' });
        const visit = new Date(r.date + 'T' + r.time + ':00');
        if (visit.getTime() > Date.now()) return reply(res, { ok:false, error:'ご来店後にご投稿いただけます。' });
        if (SHEET_REVIEW.some(x => sameCode(x['予約番号'], d.code))) {
          return reply(res, { ok:false, error:'このご予約にはすでにご感想をいただいています。ありがとうございます。' });
        }
        SHEET_REVIEW.push({ 投稿日: new Date().toISOString().slice(0,10), 予約番号: d.code,
          ニックネーム: d.nickname || 'お客様', 年代: d.age || '', 性別: '',
          評価: Math.min(5, Math.max(1, Number(d.score)||5)), タイトル: d.title || '', 本文: body,
          担当: r.staffName || '', メニュー: (r.menus||[]).map(m=>m.name).join(' / '), 状態: '未承認' });
        return reply(res, { ok:true });
      }

      if (d.type === 'change') {
        const r = LEDGER.find(x => sameCode(x.code, d.code));
        if (!r) return reply(res, { ok:false, error:'該当する予約が見つかりません' });
        const asAdmin = d.password === ADMIN_PW || (d.token && TOKENS.has(d.token));
        if (!asAdmin && (!digits(d.tel) || digits(r.customer?.tel) !== digits(d.tel))) {
          return reply(res, { ok:false, error:'ご予約が確認できませんでした。' });
        }
        if (r.cancelled) return reply(res, { ok:false, error:'キャンセル済みのご予約は変更できません。' });
        if (!asAdmin && !withinDeadline(r.date)) return reply(res, { ok:false, deadline:true, error:deadlineMsg() });
        const target = changeTarget(r, d, asAdmin);
        if (!target.ok) return reply(res, target);
        const hasPrevious = d.fromDate !== undefined || d.fromTime !== undefined;
        if (hasPrevious && (!d.fromDate || !d.fromTime)) {
          return reply(res, { ok: false, error: '変更前の日時が必要です。予約確認画面を開き直してください。' });
        }
        if (r.date === d.date && r.time === d.time) return reply(res, { ok:true, unchanged:true });
        if (hasPrevious && (r.date !== d.fromDate || r.time !== d.fromTime)) {
          return reply(res, { ok: false, stale: true,
            error: '別の画面で予約日時が変わりました。予約確認画面を開き直して最新の予定を確認してください。' });
        }

        r.changedFrom = { date: r.date, time: r.time };
        r.date = d.date;
        r.time = d.time;
        r.endTime = `${String(Math.floor((target.start + target.minutes) / 60)).padStart(2, '0')}:${String((target.start + target.minutes) % 60).padStart(2, '0')}`;
        return reply(res, { ok:true });
      }

      if (d.type === 'lookup') {
        const r = LEDGER.find(x => sameCode(x.code, d.code));
        if (!r || !digits(d.tel) || digits(r.customer?.tel) !== digits(d.tel)) {
          return reply(res, { ok: false, error: 'ご予約が見つかりませんでした。' });
        }
        return reply(res, {
          ok: true,
          reservation: {
            code: r.code, date: r.date, time: r.time, endTime: r.endTime,
            totalMinutes: r.totalMinutes,
            menuText: (r.menus || []).map(m => m.name).join(' / '),
            staffName: r.staffName, totalPrice: r.totalPrice,
            name: r.customer?.name || '', status: r.cancelled ? 'キャンセル' : '予約確定'
          }
        });
      }

      if (d.type === 'cancel') {
        const t = LEDGER.find(r => sameCode(r.code, d.code));
        if (!t) return reply(res, { ok: false, error: 'not found' });
        /* 電話番号は必ず確認する（本物と同じ。省略できると他人がキャンセルできる）。
           ただし店（管理ページ）からは、パスワードで通す。 */
        const asAdmin = DEMO_MODE || d.password === ADMIN_PW || (d.token && TOKENS.has(d.token));
        if (!asAdmin && (!digits(d.tel) || digits(t.customer?.tel) !== digits(d.tel))) {
          return reply(res, { ok: false, error: 'ご予約が確認できませんでした。電話番号をご確認ください。' });
        }
        if (t.cancelled) return reply(res, { ok:true, alreadyCancelled:true });
        if (!asAdmin && !withinDeadline(t.date)) return reply(res, { ok:false, deadline:true, error:deadlineMsg() });
        t.cancelled = true;
        return reply(res, { ok: true });
      }

      if (typeof d.code !== 'string' || !/^[A-Za-z0-9-]{1,20}$/.test(d.code)
          || !sameCode(d.code, d.code)) d.code = issueCode();
      {
        const dup = LEDGER.find(r => sameCode(r.code, d.code));
        if (dup) {
          const tel = digits(d.customer?.tel);
          const sameCustomer = /^0\d{9,10}$/.test(tel)
            && digits(dup.customer?.tel) === tel;
          const menuText = reservation => (Array.isArray(reservation.menus) ? reservation.menus : [])
            .map(menu => menu && menu.name).filter(Boolean).join(' / ') || String(reservation.menuText || '').trim();
          if (sameCustomer && dup.cancelled) return reply(res, { ok: false, cancelled: true,
            error: 'この予約番号はキャンセル済みです。予約確認ページで現在の内容を確認してください。' });
          const sameContent = dup.date === d.date && dup.time === d.time
            && Number(dup.totalMinutes) === Number(d.totalMinutes)
            && menuText(dup) === menuText(d)
            && Number(dup.nominationFee || 0) === Number(d.nominationFee || 0)
            && Number(dup.totalPrice || 0) === Number(d.totalPrice || 0)
            && String(dup.customer?.name || '').trim() === String(d.customer?.name || '').trim()
            && String(dup.customer?.kana || '').trim() === String(d.customer?.kana || '').trim()
            && String(dup.customer?.email || '').trim() === String(d.customer?.email || '').trim()
            && String(dup.customer?.visit || '').trim() === String(d.customer?.visit || '').trim()
            && String(dup.customer?.request || '').trim() === String(d.customer?.request || '').trim()
            && String(dup.staffName || '').trim() === String(d.staffName || '').trim()
            && String(dup.staffId || '').trim() === String(d.staffId || '').trim()
            && sourceLabel(dup.source) === sourceLabel(d.source);
          if (sameCustomer && sameContent) return reply(res, { ok: true, code: d.code, duplicate: true });
          if (sameCustomer) return reply(res, { ok: false, conflict: true,
            error: '同じ予約番号の内容が台帳と一致しません。予約確認ページで現在の内容を確認してください。' });
          d.code = issueCode();
        }
      }

      if (Array.isArray(d.menus) && d.menus.some(menu => menu && Object.hasOwn(menu, 'id'))) {
        const available = (buildMenu() || []).flatMap(group => group.items)
          .concat((buildCoupons() || []).map(coupon => ({ ...coupon, name: coupon.title, isCoupon: true })));
        const chosen = [];
        const seen = new Set();
        for (const input of d.menus) {
          const item = input && available.find(candidate => candidate.id === input.id);
          if (!item || seen.has(item.id) || input.name !== item.name
              || Number(input.price) !== Number(item.price || 0)
              || Number(input.minutes) !== Number(item.minutes)
              || !!input.priceFrom !== !!item.priceFrom) {
            return reply(res, { ok:false, catalogChanged:true,
              error:'メニュー・料金・所要時間を確認できません。ページを再読み込みしてメニューを選び直してください。' });
          }
          seen.add(item.id);
          chosen.push(item);
        }
        if (chosen.filter(item => item.isCoupon).length > 1
            || Number(d.totalPrice) !== chosen.reduce((sum, item) => sum + Number(item.price || 0), 0)
            || Number(d.totalMinutes) !== chosen.reduce((sum, item) => sum + item.minutes, 0)
            || Number(d.nominationFee || 0) !== 0
            || (d.staffId && d.staffId !== 'st01')) {
          return reply(res, { ok:false, catalogChanged:true,
            error:'メニュー・料金・所要時間を確認できません。ページを再読み込みしてメニューを選び直してください。' });
        }
      }

      if (!validDateKey(d.date)) return reply(res, { ok: false, invalid: true, error: '来店日が正しくありません。' });
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
      const ahead = Math.round((Date.parse(d.date + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
      if (ahead < 0) return reply(res, { ok: false, invalid: true, error: 'すでに過ぎた日付です。' });
      if (ahead > 60) return reply(res, { ok: false, invalid: true, error: 'ご予約は60日先まで承っております。' });
      const reservationMinutes = Number(d.totalMinutes);
      if (!Number.isInteger(reservationMinutes) || reservationMinutes < 15 || reservationMinutes > 480) {
        return reply(res, { ok: false, invalid: true, error: '所要時間が正しくありません。' });
      }
      if (!/^0\d{9,10}$/.test(digits(d.customer?.tel))) {
        return reply(res, { ok: false, invalid: true, error: '電話番号をご確認ください。' });
      }

      /* 営業時間の外（画面を通さず送られてきた場合の砦）。
         本物の Code.gs は設定シートの営業開始・営業終了を見て断ります。
         ここを省くと、試験は通るのに本番では断られる（またはその逆）
         という食い違いになります。 */
      {
        const toMin = t => { const m = String(t||'').match(/^(\d{1,2}):(\d{2})/); return m ? +m[1]*60 + +m[2] : null; };
        const open = toMin(SHEET_SETTINGS['営業開始']) ?? toMin('09:00');
        const close = toMin(SHEET_SETTINGS['営業終了']) ?? toMin('22:00');
        const last = Math.min(toMin(SHEET_SETTINGS['最終受付']) ?? close, close);
        const start = toMin(d.time);
        if (start === null || start < open || start > last || start + reservationMinutes > close) {
          return reply(res, { ok:false, scheduleChanged:true, error:'営業時間外のご予約は承れません。' });
        }
        /* 直前すぎる予約（本物と同じ2時間前まで、時計のずれ15分ぶんの余裕つき）。
           店が電話で受けた予約（adminAdd）はここを通りません。
           目の前のお客様を今から入れられないと、使えないためです。 */
        const q0 = String(d.date).split('-').map(Number);
        const jst = new Date(Date.now() + 9 * 3600e3);
        const today0 = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) / 864e5;
        const until = (Date.UTC(q0[0], q0[1] - 1, q0[2]) / 864e5 - today0) * 1440
          + start - (jst.getUTCHours() * 60 + jst.getUTCMinutes());
        if (until < 2 * 60 - 15) {
          return reply(res, { ok:false, invalid:true,
            error:'当日のご予約は2時間前までとなっております。お手数ですが店舗までお電話ください。' });
        }
        // 定休曜日（本物と同じ読み方）
        const days = String(SHEET_SETTINGS['定休曜日'] || '').trim()
          .split(/[,、・\s]+/).map(t => ['日','月','火','水','木','金','土'].indexOf(t.replace(/曜日?$/, '')))
          .filter(i => i >= 0);
        const q = String(d.date).split('-').map(Number);
        if (days.length && q[0] && days.includes(new Date(Date.UTC(q[0], q[1]-1, q[2], 12)).getUTCDay())) {
          return reply(res, { ok:false, scheduleChanged:true, error:'その日は定休日のため、ご予約を承れません。' });
        }
      }

      // 休業日・受けない時間帯（画面を通さず送られてきた場合の砦）
      if (hitsClosed(d.date, d.time, reservationMinutes)) {
        return reply(res, { ok:false, closed:true,
          error:'ご希望の時間は、店舗の都合により受付を止めております。別の日時をお選びください。' });
      }

      {
        const toMin = t => { const m=String(t||'').match(/^(\d{1,2}):(\d{2})/); return m?+m[1]*60+ +m[2]:0; };
        const start = toMin(d.time), end = start + reservationMinutes;
        const taken = LEDGER.some(x => !x.cancelled && !sameCode(x.code, d.code)
          && x.date === d.date
          && start < toMin(x.endTime) && toMin(x.time) < end);
        if (taken) return reply(res, { ok:false, taken:true,
          error:'ご希望の時間は、ちょうど他のお客様のご予約が入りました。別の日時をお選びください。' });
      }
      /* 予約の入口も、本物と同じで一覧にある言葉だけ受け取ります */
      const startParts = String(d.time).match(/^(\d{1,2}):(\d{2})/);
      const endMinute = Number(startParts[1]) * 60 + Number(startParts[2]) + reservationMinutes;
      const endTime = `${String(Math.floor(endMinute / 60)).padStart(2, '0')}:${String(endMinute % 60).padStart(2, '0')}`;
      LEDGER.push({ ...d, endTime, totalMinutes: reservationMinutes,
        source: sourceLabel(d.source), cancelled: false });
      return reply(res, { ok: true, code: d.code });
    });
    return;
  }

  const p = ROOT + (req.url === '/' ? '/index.html' : req.url.split('?')[0]);
  if (!existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': types[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });

  if (p.endsWith('/data.js')) {
    /* 受け口を、この試験用サーバーに向け直します。

       以前は空文字（reservationEndpoint: ''）だけを置き換えていました。
       本物の Apps Script のURLを data.js に入れた日に置き換えが効かなくなり、
       試験がまるごと本物のGoogleへ飛びました。全部落ちたので気づけましたが、
       もし通っていたら「試験は緑なのに、実は本番の台帳を書き換えていた」という
       いちばん怖い形になっていました。中身が何であっても向け直します。 */
    res.end(readFileSync(p, 'utf8')
      .replace(/reservationEndpoint: '[^']*'/, `reservationEndpoint: 'http://127.0.0.1:${PORT}/exec'`));
    return;
  }
  if (DEMO_MODE && p.endsWith('.html')) {
    res.end(demoHtml(readFileSync(p, 'utf8'))); return;
  }
  res.end(readFileSync(p));
};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8820);
  const demoMode = process.argv.includes('--demo');
  http.createServer(createMockHandler({ port, demoMode })).listen(port, LOCAL_HOST,
    () => console.log(`${demoMode ? '架空データのデモ' : 'テスト用サーバー'}起動: http://${LOCAL_HOST}:${port}`));
}
