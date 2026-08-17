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
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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
    if (String(r.表示).trim() === '×') return;
    /* 区分が空でも、本物と同じ既定名でまとめます。
       ここを本番より緩くすると、本番では起きない不具合を試験で作れてしまいます。 */
    const catName = String(r.区分 || 'メニュー').trim();
    let g = groups.find(x => x.name === catName);
    if (!g) { g = { id: 'cat' + groups.length, name: catName, items: [] }; groups.push(g); }
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
    id: 'ss' + i, title: r.タイトル, length: String(r.分類 || 'スタイル').trim(), staffId: null,
    tags: String(r.タグ || '').split(/[,、・\s]+/).filter(Boolean), detail: String(r.説明 || ''),
    image: String(r.画像 || ''), hue: (i * 37) % 360
  }));
  return out.length ? out : null;
}

function buildCoupons() {
  const out = SHEET_COUPON.filter(r => String(r.表示).trim() !== '×').map((r, i) => {
    const p = parsePrice(r.価格);
    return { id: 'sc' + i, badge: String(r.対象 || '全員').trim(), title: r.メニュー名, detail: r.説明,
      tags: String(r.タグ || '').split(/[,、・\s]+/).filter(Boolean),
      price: p.value, priceFrom: p.from, listPrice: Number(r.通常価格) || null,
      minutes: r['所要(分)'], terms: r.条件, image: String(r.画像 || '') };
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
        const authed = d.password === ADMIN_PW || (d.token && TOKENS.has(d.token));
        if (!authed) return reply(res, { ok:false, error:'パスワードが違います。' });
        if (d.type === 'adminLogin') {
          if (!d.remember) return reply(res, { ok:true });
          const t = 'tok-' + Math.random().toString(36).slice(2) + Date.now();
          TOKENS.add(t);
          return reply(res, { ok:true, token:t });
        }
        if (d.type === 'adminAdd') {
          const toMin = t => { const m=String(t||'').match(/^(\d{1,2}):(\d{2})/); return m?+m[1]*60+ +m[2]:0; };
          const mins = Number(d.minutes) || 60;
          if (!d.date || !d.time) return reply(res, { ok:false, error:'来店日と開始時刻をご確認ください。' });
          if (!String(d.name||'').trim()) return reply(res, { ok:false, error:'お名前をご入力ください。' });
          const start = toMin(d.time), end = start + mins;
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
            source:'電話・来店', cancelled:false });
          return reply(res, { ok:true, code, endTime });
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
            note: (n => /^'[=+\-@]/.test(n) ? n.slice(1) : n)(String(r.note||'')),
            source: r.source || '',
            status: r.cancelled ? 'キャンセル' : '予約確定' })),
          menus: SHEET_MENU, coupons: SHEET_COUPON, styles: SHEET_STYLE, reviews: SHEET_REVIEW,
          closedDates: SHEET_CLOSED.map(c=> typeof c==='string' ? { '休業日': c, '開始':'', '終了':'', 'メモ':'' } : { '休業日': c.date, '開始': c.start, '終了': c.end, 'メモ':'' }),
          settings: SHEET_SETTINGS });
        if (d.type === 'adminSave') {
          /* 本番と同じで、印の無い保存も断ります */
          if (d.stamp !== stampOf(d.target)) {
            return reply(res, { ok:false, stale:true,
              error:'この内容は、別の端末から変更されています。いったん読み込み直してください。' });
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
        if (!r || digits(r.customer?.tel) !== digits(d.tel)) {
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
        if (d.tel && digits(r.customer?.tel) !== digits(d.tel)) {
          return reply(res, { ok:false, error:'ご予約が確認できませんでした。' });
        }
        if (r.cancelled) return reply(res, { ok:false, error:'キャンセル済みのご予約は変更できません。' });
        if (!withinDeadline(r.date)) return reply(res, { ok:false, deadline:true, error:deadlineMsg() });
        // 同じ担当の同じ時間に別の予約がないか
        const toMin = t => { const m=String(t||'').match(/^(\d{1,2}):(\d{2})/); return m?+m[1]*60+ +m[2]:0; };
        const start = toMin(d.time), end = start + (Number(d.minutes)||30);
        const taken = LEDGER.some(x => !x.cancelled && !sameCode(x.code, d.code)
          && x.date === d.date   /* 席は1つ：担当が誰でも、重なれば埋まっている */
          && start < toMin(x.endTime) && toMin(x.time) < end);
        if (taken) return reply(res, { ok:false, error:'ご希望の時間は、ちょうど他のお客様のご予約が入りました。' });
        if (hitsClosed(d.date, d.time, d.minutes)) {
          return reply(res, { ok:false,
            error:'ご希望の時間は、店舗の都合により受付を止めております。別の日時をお選びください。' });
        }

        r.changedFrom = { date: r.date, time: r.time };
        r.date = d.date; r.time = d.time; r.endTime = d.endTime;
        r.totalMinutes = Number(d.minutes) || r.totalMinutes;
        return reply(res, { ok:true });
      }

      if (d.type === 'lookup') {
        const r = LEDGER.find(x => sameCode(x.code, d.code));
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
        const t = LEDGER.find(r => sameCode(r.code, d.code));
        if (!t) return reply(res, { ok: false, error: 'not found' });
        /* 電話番号は必ず確認する（本物と同じ。省略できると他人がキャンセルできる）。
           ただし店（管理ページ）からは、パスワードで通す。 */
        const asAdmin = d.password === ADMIN_PW || (d.token && TOKENS.has(d.token));
        if (!asAdmin && (!digits(d.tel) || digits(t.customer?.tel) !== digits(d.tel))) {
          return reply(res, { ok: false, error: 'ご予約が確認できませんでした。電話番号をご確認ください。' });
        }
        if (t.cancelled) return reply(res, { ok:true, alreadyCancelled:true });
        if (!withinDeadline(t.date)) return reply(res, { ok:false, deadline:true, error:deadlineMsg() });
        t.cancelled = true;
        return reply(res, { ok: true });
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
        if (start === null || start < open || start > last || start + (Number(d.totalMinutes) || 30) > close) {
          return reply(res, { ok:false, error:'営業時間外のご予約は承れません。' });
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
          return reply(res, { ok:false,
            error:'当日のご予約は2時間前までとなっております。お手数ですが店舗までお電話ください。' });
        }
        // 定休曜日（本物と同じ読み方）
        const days = String(SHEET_SETTINGS['定休曜日'] || '').trim()
          .split(/[,、・\s]+/).map(t => ['日','月','火','水','木','金','土'].indexOf(t.replace(/曜日?$/, '')))
          .filter(i => i >= 0);
        const q = String(d.date).split('-').map(Number);
        if (days.length && q[0] && days.includes(new Date(Date.UTC(q[0], q[1]-1, q[2], 12)).getUTCDay())) {
          return reply(res, { ok:false, error:'その日は定休日のため、ご予約を承れません。' });
        }
      }

      // 休業日・受けない時間帯（画面を通さず送られてきた場合の砦）
      if (hitsClosed(d.date, d.time, d.totalMinutes)) {
        return reply(res, { ok:false,
          error:'ご希望の時間は、店舗の都合により受付を止めております。別の日時をお選びください。' });
      }

      // 本物と同じ枠の最終確認（同時に押された場合は片方を弾く）
      {
        const toMin = t => { const m=String(t||'').match(/^(\d{1,2}):(\d{2})/); return m?+m[1]*60+ +m[2]:0; };
        const start = toMin(d.time), end = start + (Number(d.totalMinutes)||30);
        const taken = LEDGER.some(x => !x.cancelled && !sameCode(x.code, d.code)
          && x.date === d.date   /* 席は1つ：担当が誰でも、重なれば埋まっている */
          && start < toMin(x.endTime) && toMin(x.time) < end);
        if (taken) return reply(res, { ok:false, taken:true,
          error:'ご希望の時間は、ちょうど他のお客様のご予約が入りました。別の日時をお選びください。' });
      }

      // 本物と同じ重複・衝突の扱い
      {
        const dup = LEDGER.find(r => sameCode(r.code, d.code));
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
      /* 予約の入口も、本物と同じで一覧にある言葉だけ受け取ります */
      LEDGER.push({ ...d, source: sourceLabel(d.source), cancelled: false });
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
  res.end(readFileSync(p));
}).listen(PORT, () => console.log('テスト用サーバー起動: http://127.0.0.1:' + PORT));
