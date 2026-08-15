/* GAS を模した受信サーバー
   - CORS プリフライト(OPTIONS)には応答しない（GAS と同じ挙動）
   - reserve / cancel / availability / menu / lookup を処理する
   - 台帳・メニュー・クーポンをサーバー側で保持する（スプレッドシート相当） */
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* このファイルの1つ上（リポジトリの直下）をサイトの置き場所として配信する */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8820);
const LEDGER = [];

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
  { クーポン名: '【シート】men\'s骨格補正カット＋眉カット', 価格: 6900, 通常価格: '', '所要(分)': 70, 説明: 'シート由来', 条件: '', 対象: '全員', 画像: '/mock-image.svg?seed=cp', 表示: '○' },
  { クーポン名: '【シート】メンズ縮毛矯正', 価格: 22000, 通常価格: 24000, '所要(分)': 180, 説明: 'シート由来', 条件: '', 対象: '全員', 画像: '', 表示: '○' }
];

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};
const reply = (res, obj) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
};
const ADMIN_PW = 'test1234';
const TOKENS = new Set();
const FAIL = { on: false };
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
let SHEET_SETTINGS = { '電話番号': '', '営業開始': '09:00', '営業終了': '22:00', '最終受付': '21:00',
  'キャッチコピー': '', 'お知らせ': '', '定休曜日': '', 'ロゴ画像': '', 'スタッフ写真': '', 'メイン写真': '' };
/* 本物の GAS と同じ価格の読み方 */
function parsePrice(v) {
  const t = String(v ?? '').trim();
  const n = Number(t.replace(/[^0-9.]/g, ''));
  return { value: isNaN(n) ? 0 : n, from: /[〜~]/.test(t) };
}
const digits = v => String(v ?? '').replace(/\D/g, '');

/* シート行を GAS と同じ形に変換する */
function buildMenu() {
  const groups = [];
  SHEET_MENU.forEach((r, i) => {
    if (String(r.表示).trim() === '×') return;
    let g = groups.find(x => x.name === r.区分);
    if (!g) { g = { id: 'cat' + groups.length, name: r.区分, items: [] }; groups.push(g); }
    const p = parsePrice(r.価格);
    g.items.push({ id: 'sm' + i, name: r.メニュー名, price: p.value, priceFrom: p.from,
      minutes: r['所要(分)'], note: r.説明, image: String(r.画像 || '') });
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
    id: 'ss' + i, title: r.タイトル, length: r.分類, staffId: null,
    tags: String(r.タグ || '').split(/[,、・\s]+/).filter(Boolean),
    image: String(r.画像 || ''), hue: (i * 37) % 360
  }));
  return out.length ? out : null;
}

function buildCoupons() {
  const out = SHEET_COUPON.filter(r => String(r.表示).trim() !== '×').map((r, i) => {
    const p = parsePrice(r.価格);
    return { id: 'sc' + i, badge: r.対象, title: r.クーポン名, detail: r.説明,
      price: p.value, priceFrom: p.from, listPrice: Number(r.通常価格) || null,
      minutes: r['所要(分)'], terms: r.条件, image: String(r.画像 || '') };
  });
  return out.length ? out : null;
}

http.createServer((req, res) => {
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
      const d = JSON.parse(body);

      // テスト用：受信側が失敗を返す状態を作る
      if (d.type === 'failmode') { FAIL.on = !!d.on; return reply(res, { ok:true, fail: FAIL.on }); }
      if (FAIL.on && (d.type === 'reserve' || !d.type || d.type === 'change' || d.type === 'cancel')) {
        return reply(res, { ok:false, error:'台帳が混み合っています。しばらくしてお試しください。' });
      }

      // ---- 管理ページ ----
      if (d.type && d.type.startsWith('admin')) {
        const authed = d.password === ADMIN_PW || (d.token && TOKENS.has(d.token));
        if (!authed) return reply(res, { ok:false, error:'パスワードが違います。' });
        if (d.type === 'adminLogin') {
          if (!d.remember) return reply(res, { ok:true });
          const t = 'tok-' + Math.random().toString(36).slice(2) + Date.now();
          TOKENS.add(t);
          return reply(res, { ok:true, token:t });
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
        if (d.type === 'adminData') return reply(res, { ok:true, stamps: allStamps(),
          reservations: LEDGER.map(r=>({ code:r.code, date:r.date, time:r.time, endTime:r.endTime,
            menu:(r.menus||[]).map(m=>m.name).join(' / '), staffName:r.staffName, price:r.totalPrice,
            name:r.customer?.name||'', tel:r.customer?.tel||'', email:r.customer?.email||'',
            visit:r.customer?.visit||'', request:r.customer?.request||'',
            status: r.cancelled ? 'キャンセル' : '予約確定' })),
          menus: SHEET_MENU, coupons: SHEET_COUPON, styles: SHEET_STYLE, reviews: SHEET_REVIEW,
          closedDates: SHEET_CLOSED.map(d=>({ '休業日': d, 'メモ':'' })),
          settings: SHEET_SETTINGS });
        if (d.type === 'adminSave') {
          if (d.stamp && d.stamp !== stampOf(d.target)) {
            return reply(res, { ok:false, stale:true,
              error:'この内容は、別の端末から変更されています。いったん読み込み直してください。' });
          }
          if (d.target === 'closed') { SHEET_CLOSED.length = 0; (d.rows||[]).forEach(r=>{ if(r['休業日']) SHEET_CLOSED.push(r['休業日']); }); }
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
        return reply(res, { ok: true, categories: buildMenu(), coupons: buildCoupons(), styles: buildStyles(), reviews: buildReviews(), closedDates: SHEET_CLOSED, settings: SHEET_SETTINGS });
      }

      if (d.type === 'availability') {
        const today = new Date().toISOString().slice(0, 10);
        return reply(res, {
          ok: true,
          booked: LEDGER.filter(r => !r.cancelled && r.date >= today)
            .map(r => ({ date: r.date, time: r.time, minutes: r.totalMinutes, staffId: r.staffId || null }))
        });
      }

      // テスト用：来店済みの状態を作る
      if (d.type === 'backdate') {
        const r = LEDGER.find(x => x.code === d.code);
        if (r) { const y = new Date(); y.setDate(y.getDate()-1); r.date = y.toISOString().slice(0,10); }
        return reply(res, { ok:!!r });
      }

      if (d.type === 'review') {
        const body = String(d.body||'').trim();
        if (!body) return reply(res, { ok:false, error:'ご感想をご入力ください。' });
        const r = LEDGER.find(x => x.code === d.code);
        if (!r || digits(r.customer?.tel) !== digits(d.tel)) {
          return reply(res, { ok:false, error:'ご予約が確認できませんでした。' });
        }
        if (r.cancelled) return reply(res, { ok:false, error:'キャンセルされたご予約には投稿いただけません。' });
        const visit = new Date(r.date + 'T' + r.time + ':00');
        if (visit.getTime() > Date.now()) return reply(res, { ok:false, error:'ご来店後にご投稿いただけます。' });
        if (SHEET_REVIEW.some(x => x['予約番号'] === d.code)) {
          return reply(res, { ok:false, error:'このご予約にはすでにご感想をいただいています。ありがとうございます。' });
        }
        SHEET_REVIEW.push({ 投稿日: new Date().toISOString().slice(0,10), 予約番号: d.code,
          ニックネーム: d.nickname || 'お客様', 年代: d.age || '', 性別: '',
          評価: Math.min(5, Math.max(1, Number(d.score)||5)), タイトル: d.title || '', 本文: body,
          担当: r.staffName || '', メニュー: (r.menus||[]).map(m=>m.name).join(' / '), 状態: '未承認' });
        return reply(res, { ok:true });
      }

      if (d.type === 'change') {
        const r = LEDGER.find(x => x.code === d.code);
        if (!r) return reply(res, { ok:false, error:'該当する予約が見つかりません' });
        if (d.tel && digits(r.customer?.tel) !== digits(d.tel)) {
          return reply(res, { ok:false, error:'ご予約が確認できませんでした。' });
        }
        if (r.cancelled) return reply(res, { ok:false, error:'キャンセル済みのご予約は変更できません。' });
        if (!withinDeadline(r.date)) return reply(res, { ok:false, deadline:true, error:deadlineMsg() });
        // 同じ担当の同じ時間に別の予約がないか
        const toMin = t => { const m=String(t||'').match(/^(\d{1,2}):(\d{2})/); return m?+m[1]*60+ +m[2]:0; };
        const start = toMin(d.time), end = start + (Number(d.minutes)||30);
        const taken = LEDGER.some(x => !x.cancelled && x.code !== d.code
          && x.date === d.date && (x.staffId||null) === (r.staffId||null)
          && start < toMin(x.endTime) && toMin(x.time) < end);
        if (taken) return reply(res, { ok:false, error:'ご希望の時間は、ちょうど他のお客様のご予約が入りました。' });

        r.changedFrom = { date: r.date, time: r.time };
        r.date = d.date; r.time = d.time; r.endTime = d.endTime;
        r.totalMinutes = Number(d.minutes) || r.totalMinutes;
        return reply(res, { ok:true });
      }

      if (d.type === 'lookup') {
        const r = LEDGER.find(x => x.code === d.code);
        if (!r || digits(r.customer?.tel) !== digits(d.tel)) {
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
        const t = LEDGER.find(r => r.code === d.code);
        if (!t) return reply(res, { ok: false, error: 'not found' });
        if (d.tel && digits(t.customer?.tel) !== digits(d.tel)) {
          return reply(res, { ok: false, error: 'ご予約が確認できませんでした。' });
        }
        if (t.cancelled) return reply(res, { ok:true, alreadyCancelled:true });
        if (!withinDeadline(t.date)) return reply(res, { ok:false, deadline:true, error:deadlineMsg() });
        t.cancelled = true;
        return reply(res, { ok: true });
      }

      // 本物と同じ枠の最終確認（同時に押された場合は片方を弾く）
      {
        const toMin = t => { const m=String(t||'').match(/^(\d{1,2}):(\d{2})/); return m?+m[1]*60+ +m[2]:0; };
        const start = toMin(d.time), end = start + (Number(d.totalMinutes)||30);
        const taken = LEDGER.some(x => !x.cancelled && x.code !== d.code
          && x.date === d.date && (x.staffId||'') === (d.staffId||'')
          && start < toMin(x.endTime) && toMin(x.time) < end);
        if (taken) return reply(res, { ok:false, taken:true,
          error:'ご希望の時間は、ちょうど他のお客様のご予約が入りました。別の日時をお選びください。' });
      }

      // 本物と同じ重複・衝突の扱い
      {
        const dup = LEDGER.find(r => r.code === d.code);
        if (dup) {
          const same = digits(dup.customer?.tel) === digits(d.customer?.tel)
            && dup.date === d.date && dup.time === d.time;
          if (same) return reply(res, { ok: true, code: d.code, duplicate: true });
          const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
          let c2;
          do { c2 = 'LM-' + Array.from({length:5}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
          while (LEDGER.some(r => r.code === c2));
          d.code = c2;
        }
      }
      LEDGER.push({ ...d, cancelled: false });
      return reply(res, { ok: true, code: d.code });
    });
    return;
  }

  const p = ROOT + (req.url === '/' ? '/index.html' : req.url.split('?')[0]);
  if (!existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': types[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });

  if (p.endsWith('/data.js')) {
    res.end(readFileSync(p, 'utf8')
      .replace("reservationEndpoint: ''", `reservationEndpoint: 'http://127.0.0.1:${PORT}/exec'`));
    return;
  }
  res.end(readFileSync(p));
}).listen(PORT, () => console.log('テスト用サーバー起動: http://127.0.0.1:' + PORT));
