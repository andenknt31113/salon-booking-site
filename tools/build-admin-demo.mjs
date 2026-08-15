/* 管理ページを1枚のHTMLにまとめた「さわれる見本」を作る。
   本物の admin.html / admin.js をそのまま使い、
   通信先だけ、このファイルの中の作りものの台帳に差し替える。
   （実物は Google Apps Script とスプレッドシートが相手です）

   使い方：
     node tools/build-admin-demo.mjs
     OUT=/どこか/admin-demo.html node tools/build-admin-demo.mjs
   できた1枚のHTMLはそのままスマホで開けます。パスワードは zer01。
   ※ サイトには置かないでください。中身は作りものです。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(R, f), 'utf8');
const OUT = process.env.OUT || '/tmp/admin-demo.html';

/* ---- 本物のHTMLから、外側のガワを外して中身だけ取り出す ---- */
const src = read('admin.html');
const body = src.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1]
  .replace(/<script src="[^"]*"><\/script>/g, '');

/* ---- 見本用の作りもののデータ ---- */
const day = n => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const demo = `
/* ============================================================
   見本専用：通信先を、このファイルの中の作りものの台帳に差し替える。
   本物は Google Apps Script（スプレッドシート）が相手です。
   ここで「保存」を押しても、実際のシートには何も起きません。
   ============================================================ */
(function () {
  const PW = 'zer01';

  const D = ${JSON.stringify({
    d0: day(0), d1: day(1), d2: day(2), d3: day(3), d5: day(5), d7: day(7),
    dm2: day(-2), dm40: day(-40), dm80: day(-80), dm120: day(-120)
  })};

  let 予約 = [
    { code:'LM-8K2QP', date:D.d0, time:'10:00', endTime:'11:10',
      menu:'【清潔感と品が続く】men\\'s骨格補正カット＋眉カット', staffName:'MATTEO', price:6900,
      name:'佐藤 健太', tel:'09012345678', email:'sato@example.com', visit:'2回目以降',
      request:'サイドは短めのフェードでお願いします。', status:'予約確定' },
    { code:'LM-3XR7T', date:D.d0, time:'13:30', endTime:'16:30',
      menu:'【地毛より綺麗】自然に柔らかく仕上げるメンズ縮毛矯正', staffName:'MATTEO', price:22000,
      name:'田中 亮', tel:'08098765432', email:'tanaka@example.com', visit:'初めて',
      request:'', status:'予約確定' },
    { code:'LM-QW9ZC', date:D.d1, time:'09:30', endTime:'11:30',
      menu:'【毎朝のセット1分】品よく決まるお悩み解決メンズパーマ', staffName:'MATTEO', price:14500,
      name:'鈴木 大輔', tel:'09055556666', email:'suzuki@example.com', visit:'2回目以降',
      request:'前回より少し長めで。', status:'予約確定' },
    { code:'LM-M4T1B', date:D.d1, time:'15:00', endTime:'16:10',
      menu:'メンズカット', staffName:'MATTEO', price:4000,
      name:'高橋 悠', tel:'07011112222', email:'takahashi@example.com', visit:'初めて',
      request:'', status:'予約確定' },
    { code:'LM-P7VN5', date:D.d2, time:'11:00', endTime:'13:30',
      menu:'【立体感で格が上がる】伸びても自然！白髪ぼかしホワイトメッシュ men\\'s',
      staffName:'MATTEO', price:19800,
      name:'伊藤 誠', tel:'09033334444', email:'ito@example.com', visit:'2回目以降',
      request:'白髪が気になってきたので、前回より少し明るめにできますか。', status:'予約確定' },
    { code:'LM-Z2H8D', date:D.d3, time:'18:30', endTime:'19:40',
      menu:'【シート追加】キッズカット', staffName:'MATTEO', price:2500,
      name:'渡辺 拓海', tel:'08077778888', email:'watanabe@example.com', visit:'初めて',
      request:'子ども（小2）です。じっとしていられないかもしれません。', status:'予約確定' },
    { code:'LM-6JF3K', date:D.d5, time:'10:00', endTime:'12:00',
      menu:'【彩で見せるワンランク上のお洒落を】カット＋カラー', staffName:'MATTEO', price:14500,
      name:'山本 涼介', tel:'09099990000', email:'yamamoto@example.com', visit:'2回目以降',
      request:'', status:'予約確定' },
    { code:'LM-T5RW2', date:D.d7, time:'14:00', endTime:'14:50',
      menu:'眉毛WAX ＆ 眉毛パーマ', staffName:'MATTEO', price:6600,
      name:'中村 慎一', tel:'08012341234', email:'nakamura@example.com', visit:'初めて',
      request:'', status:'予約確定' },
    { code:'LM-A1B2C', date:D.dm2, time:'16:00', endTime:'17:10',
      menu:'メンズカット', staffName:'MATTEO', price:4000,
      name:'小林 拓也', tel:'09088887777', email:'kobayashi@example.com', visit:'2回目以降',
      request:'', status:'キャンセル' },

    /* 佐藤さんは常連さん。「前どんなメニューだったっけ」を確かめられることを示すため、
       過去のご来店も入れてあります */
    { code:'LM-K9D4X', date:D.dm40, time:'10:30', endTime:'11:40',
      menu:'【清潔感と品が続く】men\\'s骨格補正カット＋眉カット', staffName:'MATTEO', price:6900,
      name:'佐藤 健太', tel:'09012345678', email:'sato@example.com', visit:'2回目以降',
      request:'前回より少し短めでお願いします。', status:'予約確定' },
    { code:'LM-R2G7N', date:D.dm80, time:'19:00', endTime:'21:00',
      menu:'【彩で見せるワンランク上のお洒落を】カット＋カラー', staffName:'MATTEO', price:14500,
      name:'佐藤 健太', tel:'09012345678', email:'sato@example.com', visit:'2回目以降',
      request:'暗すぎない範囲でお願いします。', status:'予約確定' },
    { code:'LM-W5C1M', date:D.dm120, time:'11:00', endTime:'12:10',
      menu:'メンズカット', staffName:'MATTEO', price:4000,
      name:'佐藤 健太', tel:'09012345678', email:'sato@example.com', visit:'初めて',
      request:'', status:'予約確定' }
  ];

  let メニュー = [
    { 区分:'カット', メニュー名:'メンズカット', 価格:'4000〜', '所要(分)':50, 説明:'骨格と髪質を見て、伸びても崩れない形に。', 画像:'', 表示:'○' },
    { 区分:'カット', メニュー名:'【シート追加】キッズカット', 価格:2500, '所要(分)':30, 説明:'小学生以下', 画像:'', 表示:'○' },
    { 区分:'カラー', メニュー名:'白髪ぼかし', 価格:'7700〜', '所要(分)':70, 説明:'', 画像:'', 表示:'○' },
    { 区分:'パーマ', メニュー名:'メンズパーマ', 価格:'9900〜', '所要(分)':90, 説明:'', 画像:'', 表示:'○' },
    { 区分:'ストレート', メニュー名:'メンズ縮毛矯正', 価格:'16500〜', '所要(分)':150, 説明:'', 画像:'', 表示:'○' },
    { 区分:'トリートメント', メニュー名:'炭酸スパ', 価格:3000, '所要(分)':30, 説明:'', 画像:'', 表示:'○' },
    { 区分:'トリートメント', メニュー名:'旧・クイックスパ', 価格:2000, '所要(分)':20, 説明:'いまは出していない', 画像:'', 表示:'×' }
  ];

  let おすすめ = [
    { クーポン名:'【清潔感と品が続く】men\\'s骨格補正カット＋眉カット', 価格:6900, 通常価格:'', '所要(分)':70,
      説明:'骨格・髪質・雰囲気を見極めた大人メンズカジュアル。', 条件:'', 対象:'全員', 画像:'', 表示:'○' },
    { クーポン名:'【地毛より綺麗】自然に柔らかく仕上げるメンズ縮毛矯正', 価格:22000, 通常価格:'', '所要(分)':180,
      説明:'クセや広がりを抑えつつ、不自然にならない自然な質感に。', 条件:'', 対象:'全員', 画像:'', 表示:'○' },
    { クーポン名:'【毎朝のセット1分】品よく決まるお悩み解決メンズパーマ', 価格:14500, 通常価格:'', '所要(分)':120,
      説明:'直毛や動きが出にくい髪も、扱いやすく自然なメンズパーマに。', 条件:'', 対象:'全員', 画像:'', 表示:'○' }
  ];

  let 写真 = [
    { タイトル:'フェード × ナチュラルショート', 分類:'ショート', タグ:'フェード,ショート', 画像:'', 表示:'○' },
    { タイトル:'白髪ぼかし ホワイトメッシュ', 分類:'カラー', タグ:'白髪ぼかし', 画像:'', 表示:'○' },
    { タイトル:'店内（半個室）', 分類:'店内', タグ:'半個室', 画像:'', 表示:'○' }
  ];

  let 口コミ = [
    { 投稿日:D.dm2, お名前:'佐藤', 評価:5, 本文:'骨格に合わせて考えてくれるので、伸びてきても形が崩れません。話しやすくて通いやすいです。', 予約番号:'LM-A1B2C', 状態:'掲載中' },
    { 投稿日:D.dm2, お名前:'匿名', 評価:5, 本文:'白髪ぼかしをお願いしました。染めましたという感じにならないのが良かったです。', 予約番号:'', 状態:'未承認' }
  ];

  let 休業日 = [{ '休業日': D.d3, 'メモ': '出張のため終日' }];

  let 店舗情報 = { '電話番号':'', '営業開始':'09:00', '営業終了':'22:00', '最終受付':'21:00',
    'キャッチコピー':'イタリア発、東京経由。本格バーバーを、日常に。',
    'お知らせ':'', '定休曜日':'', 'ロゴ画像':'', 'スタッフ写真':'', 'メイン写真':'' };

  const 印 = t => {
    const src = { menus:メニュー, coupons:おすすめ, styles:写真, reviews:口コミ, closed:休業日, settings:店舗情報 }[t];
    return String(JSON.stringify(src)).length;
  };
  const 全部の印 = () => Object.fromEntries(
    ['menus','coupons','styles','reviews','closed','settings'].map(t => [t, String(印(t))]));

  SALON.reservationEndpoint = 'demo://admin';

  window.fetch = function (url, opt) {
    const d = JSON.parse((opt && opt.body) || '{}');
    const 返す = o => Promise.resolve({ json: () => Promise.resolve(o) });

    if (d.type === 'adminLogin') {
      if (d.password !== PW) return 返す({ ok:false, error:'パスワードが違います。' });
      return 返す({ ok:true, token: d.remember ? 'demo-token' : '' });
    }
    if (d.password !== PW && d.token !== 'demo-token') {
      return 返す({ ok:false, error:'パスワードが違います。' });
    }
    if (d.type === 'adminData') {
      return 返す({ ok:true, stamps: 全部の印(), reservations: 予約,
        menus: メニュー, coupons: おすすめ, styles: 写真, reviews: 口コミ,
        closedDates: 休業日, settings: 店舗情報 });
    }
    if (d.type === 'adminSave') {
      if (d.stamp && d.stamp !== 全部の印()[d.target]) {
        return 返す({ ok:false, stale:true,
          error:'この内容は、別の端末から変更されています。いったん読み込み直してください。' });
      }
      const rows = d.rows || [];
      if (d.target === 'menus') メニュー = rows;
      if (d.target === 'coupons') おすすめ = rows;
      if (d.target === 'styles') 写真 = rows;
      if (d.target === 'reviews') 口コミ = rows;
      if (d.target === 'closed') 休業日 = rows;
      if (d.target === 'settings') 店舗情報 = d.rows || {};
      return 返す({ ok:true, stamps: 全部の印() });
    }
    if (d.type === 'adminUpload') {
      return 返す({ ok:true, url: d.dataBase64 });   // 見本ではその場の画像をそのまま使う
    }
    if (d.type === 'cancel') {
      const r = 予約.find(x => x.code === d.code);
      if (r) r.status = 'キャンセル';
      return 返す({ ok:true });
    }
    return 返す({ ok:false, error:'見本では扱っていない操作です。' });
  };

  /* この見本には管理ページしか入っていません。
     ヘッダーの「スタイル」などを押すと、隣に無いページを探しに行って
     エラーになるので、押しても何も起きないようにしておきます。 */
  document.addEventListener('click', function (e) {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href.includes('.html')) return;
    e.preventDefault();
    const note = document.getElementById('demo-nav-note');
    if (note) {
      note.hidden = false;
      note.scrollIntoView({ behavior: 'smooth', block: 'center' });
      clearTimeout(window.__navNoteTimer);
      window.__navNoteTimer = setTimeout(function () { note.hidden = true; }, 6000);
    }
  }, true);

  /* 見本であることを、開いた人に必ず分かるようにしておく */
  document.addEventListener('DOMContentLoaded', function () {
    const m = document.getElementById('gate-message');
    if (m) m.innerHTML = 'これは<b>さわれる見本</b>です。パスワードは <b>zer01</b>。'
      + '中の予約・メニューは作りもので、保存しても実際のシートには何も起きません。';
    const p = document.getElementById('passcode');
    if (p) p.value = 'zer01';
    const head = document.querySelector('.page-head p');
    if (head) {
      head.textContent = '【見本】実際の画面と同じものが動いています。データだけ作りものです。';
      head.insertAdjacentHTML('afterend',
        '<div class="notice is-warn" id="demo-nav-note" hidden style="margin-top:14px;">'
        + '<b>ご案内</b><span>この見本には管理ページだけが入っています。'
        + 'サロンTOPやスタイルなど他のページは、予約サイトのプレビューでご覧ください。</span></div>');
    }
  });
})();
`;

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#F1ECE0" />
<meta name="robots" content="noindex, nofollow" />
<title>ZER01 管理ページ（見本）</title>
<style>
${read('assets/css/style.css')}
</style>
</head>
<body data-page="admin">
${body}
<script>
${read('assets/js/data.js')}
</script>
<script>
${demo}
</script>
<script>
${read('assets/js/common.js')}
</script>
<script>
/* 見本のファイル名は admin-demo.html なので、
   共通処理には「管理ページを開いている」と伝えておく */
currentPage = () => 'admin.html';
</script>
<script>
${read('assets/js/admin.js')}
</script>
</body>
</html>`;

writeFileSync(OUT, html);
console.log(`bytes: ${html.length} / 予約件数: 9`);
