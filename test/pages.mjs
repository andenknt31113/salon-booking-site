/* 一覧系ページの試験
   お客様が最初に見る5ページ（サロンTOP / スタイル / スタッフ / メニュー / 口コミ）が、
   写真がまだ1枚も無い状態でも、口コミが0件でも、店がシートを書き換えたあとでも
   「ちゃんとした店だ」と思える見え方になっているかを確かめる。

   1項目 = 1つの「これが崩れているとお客様が誤解する／読めない」 */
/* Playwright の場所。
   ふつうは npm i -D playwright で入れた 'playwright' を使います。
   別の場所にある場合は PLAYWRIGHT に読み込み先を指定してください。 */
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const B = process.env.BASE || 'http://127.0.0.1:8820';
const PW = 'test1234';
const post = b => fetch(B + '/exec', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(b) }).then(r => r.json());

const br = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const jsErrors = [];
const results = [];

function check(g, label, actual, expected) {
  const ok = String(actual) === String(expected);
  results.push({ g, label, ok, actual, expected });
  console.log(`   ${ok ? '✅' : '❌'} ${label}` + (ok ? '' : `  期待=${expected} 実際=${actual}`));
  return ok;
}

/* お客様のスマホ。時間帯まで合わせるのは、日付の見え方が時計に左右されるため */
async function newPhone(label, opt = {}) {
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  /* 写真がまだ1枚も無い状態（いまの実態）を、確実に作るための細工。
     assets/*.jpg は置かれていないので普段も出ませんが、
     シートに写真を登録したあとでも「読めなかったとき」を再現できるようにしておく。 */
  if (opt.noPhoto) await ctx.route(/\.(jpg|jpeg|png|webp|svg)(\?|$)/i, r => r.abort());
  /* Apps Script を入れる前（いまの公開状態）。受信先が空の data.js に戻す。 */
  if (opt.noEndpoint) {
    await ctx.route('**/assets/js/data.js', async r => {
      const res = await r.fetch();
      const body = (await res.text()).replace(/reservationEndpoint: '[^']*'/, "reservationEndpoint: ''");
      await r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body });
    });
  }
  const p = await ctx.newPage();
  p.on('pageerror', e => jsErrors.push(`[${label}] ${e.message}`));
  return p;
}

/* シートを書き換える試験があるので、始める前の中身を控えて、最後に戻す。
   戻さないと、あとから流した別の試験が「メニューが違う」で落ちます。 */
let SHEET_BACKUP = null;
async function saveSheet(target, rows) {
  const d = await post({ type: 'adminData', password: PW });
  const r = await post({ type: 'adminSave', password: PW, target, stamp: d.stamps[target], rows });
  if (!r.ok) throw new Error(`シートを書き換えられませんでした（${target}）: ${r.error}`);
}

try {
/* 前に流した試験の予約・口コミが残っていると、空いているはずの時間が
   埋まって見えます。まっさらから始めます。 */
await post({ type: 'reset' }).catch(() => {});
{
  const d = await post({ type: 'adminData', password: PW }).catch(() => null);
  if (d && d.ok) SHEET_BACKUP = { menus: d.menus, coupons: d.coupons, styles: d.styles, settings: d.settings };
}

/* ============================================================
   【1】写真がまだ1枚も無い状態で、5ページが見苦しくないか
   ============================================================ */
console.log('\n【1】写真がまだ1枚も無い状態（いまの実態）');
{
  const p = await newPhone('1', { noPhoto: true });
  for (const page of ['index.html', 'gallery.html', 'staff.html', 'menu.html', 'reviews.html']) {
    /* 読めなかった写真は、すぐには消しません。Googleドライブは続けて読むと
       一時的に断ってくることがあり、1回で見限ると同じ写真が「出たり出なかったり」
       するためです（common.js の settlePhoto）。読み直しが尽きるまで待ってから
       数えます。ここを待たずに数えると、直しの途中の状態を失敗と呼んでしまいます。 */
    await p.goto(B + '/' + page); await p.waitForTimeout(4000);
    const r = await p.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      return {
        // 横スクロールが出ると、指で払うたびに画面が横にずれて読めない
        scrollW: document.documentElement.scrollWidth,
        // 読めなかった写真がそのまま残っていないか（壊れた画像アイコンが出る）
        壊れた画像: [...document.querySelectorAll('img')]
          .filter(i => vis(i) && i.complete && i.naturalWidth === 0).length,
        // 中身の無い一覧（空の箱）が出ていないか
        空の一覧: ['#home-coupons', '#home-styles', '#home-staff', '#style-list', '#staff-list',
                   '#coupon-list', '#menu-list', '#review-list']
          .filter(sel => { const el = document.querySelector(sel); return el && !el.children.length; })
      };
    });
    check('1', `${page}: 横にはみ出さない`, r.scrollW <= 391, true);
    check('1', `${page}: 壊れた写真が残っていない`, r.壊れた画像, 0);
    check('1', `${page}: 中身の無い箱が出ていない`, r.空の一覧.join(',') || 'なし', 'なし');
  }
  /* 写真の代わりの意匠（バーバーポールのストライプ）が、ちゃんと場所を持っているか。
     高さ0だと、写真の場所だけがぺしゃんこに潰れた一覧になる。 */
  await p.goto(B + '/gallery.html'); await p.waitForTimeout(1600);
  const thumb = await p.evaluate(() => {
    const el = document.querySelector('.style-thumb');
    return el ? Math.round(el.getBoundingClientRect().height) : 0;
  });
  check('1', 'スタイルの写真枠が潰れていない', thumb > 100, true);
  await p.context().close();
}

/* ============================================================
   【2】口コミが0件のとき（架空の口コミ・評価は絶対に作らない）
   ============================================================ */
console.log('\n【2】口コミが0件のとき');
{
  // Apps Script を入れる前。投稿フォーム自体を出していない状態
  const p = await newPhone('2', { noEndpoint: true });
  await p.goto(B + '/reviews.html'); await p.waitForTimeout(1500);
  const formShown = await p.locator('#review-form').isVisible();
  const emptyText = (await p.locator('#review-list').innerText()).replace(/\n/g, ' ');
  check('2', '受信先が無いあいだは投稿フォームを出していない', formShown, false);
  /* フォームを出していないのに「下のフォームから」と書くと、
     お客様は無いものを探すことになる。 */
  check('2', 'フォームが無いときに「下のフォーム」と案内していない', /下のフォーム/.test(emptyText), false);
  check('2', '口コミが0件だと伝えている', /まだ届いていません/.test(emptyText), true);
  check('2', '評価の数字を出していない', /\d\.\d/.test(emptyText), false);

  await p.goto(B + '/index.html'); await p.waitForTimeout(1500);
  const home = (await p.locator('#home-reviews').innerText()).replace(/\n/g, ' ');
  check('2', 'トップも同じく0件と伝えている', /まだ届いていません/.test(home), true);
  /* アンケートは送っていない。「お送りするアンケート」と書くと、
     届かないものを待たれて、いつまでもご感想をいただけない。 */
  check('2', '送っていないアンケートを案内していない', /アンケート/.test(home), false);
  check('2', '評価（星・数値）を出していない',
    await p.evaluate(() => !document.querySelector('.hero-rating').hidden), false);
  check('2', '架空の口コミを1件も出していない', await p.locator('#home-reviews .review').count(), 0);

  await p.goto(B + '/reviews.html'); await p.waitForTimeout(1200);
  check('2', '口コミページの説明文もアンケートに触れていない',
    /アンケート/.test(await p.locator('.page-head').innerText()), false);
  await p.context().close();
}

/* Apps Script を入れたあと。書ける場所があるなら、その場所を案内する */
{
  const p = await newPhone('2b');
  await p.goto(B + '/reviews.html'); await p.waitForTimeout(1600);
  check('2', '投稿できるときは口コミページで「下のフォーム」と案内する',
    /下のフォーム/.test(await p.locator('#review-list').innerText()), true);
  await p.goto(B + '/index.html'); await p.waitForTimeout(1600);
  check('2', 'トップでは書ける場所（口コミページ）へ案内する',
    /口コミページのフォーム/.test(await p.locator('#home-reviews').innerText()), true);
  await p.context().close();
}

/* ============================================================
   【3】店が口コミを掲載したら、トップの評価が出る
   ============================================================ */
console.log('\n【3】口コミが集まったとき');
{
  await saveSheet('reviews', [
    { 投稿日: '2026-08-10', 予約番号: 'LM-TEST1', ニックネーム: 'T.K', 年代: '30代', 性別: '',
      評価: 5, タイトル: '清潔感が続きます', 本文: '仕上がりに満足しています。', 担当: 'MATTEO',
      メニュー: 'カットコース', 状態: '掲載中' },
    { 投稿日: '2026-08-11', 予約番号: 'LM-TEST2', ニックネーム: 'S.M', 年代: '', 性別: '',
      評価: 4, タイトル: '', 本文: '落ち着いた雰囲気でした。', 担当: '', メニュー: '', 状態: '掲載中' }
  ]);
  const p = await newPhone('3');
  await p.goto(B + '/index.html'); await p.waitForTimeout(1800);
  /* 口コミはシートから届くので、最初に描いたあとに届く。
     「無いから隠す」の片道だけだと、集まった評価が一生出ない。 */
  check('3', '集まった評価がトップに出る',
    await p.evaluate(() => !document.querySelector('.hero-rating').hidden), true);
  check('3', '評価の数字が口コミから計算されている',
    await p.locator('#hero-score').innerText(), '4.5');
  check('3', '件数を出している', /2件/.test(await p.locator('#hero-count').innerText()), true);
  check('3', 'トップに口コミが並ぶ', await p.locator('#home-reviews .review').count(), 2);

  await p.goto(B + '/reviews.html'); await p.waitForTimeout(1600);
  check('3', '口コミページにも並ぶ', await p.locator('#review-list .review').count(), 2);
  /* 年代・担当が空の口コミで「（・）」「担当：」だけが残らないか */
  const second = (await p.locator('#review-list .review').nth(1).innerText()).replace(/\n/g, ' ');
  check('3', '空の項目でカッコだけが残らない', /（・|（）/.test(second), false);
  check('3', '担当が空なら「担当：」を出さない', /担当：\s*$|担当：\s*／/.test(second), false);
  await p.context().close();
  await saveSheet('reviews', []);
}

/* ============================================================
   【4】店がメニューを入れ替えたあと、絞り込みタブが正しく動くか
   ============================================================ */
console.log('\n【4】シート由来のメニューと絞り込みタブ');
{
  await saveSheet('menus', [
    { 区分: 'カット', メニュー名: 'メンズカット', 価格: '4000〜', '所要(分)': 50, 説明: '', 画像: '', 表示: '○' },
    { 区分: 'カット', メニュー名: 'キッズカット', 価格: 2500, '所要(分)': 30, 説明: '小学生以下', 画像: '', 表示: '○' },
    { 区分: 'スパ', メニュー名: '炭酸スパ', 価格: 3000, '所要(分)': 30, 説明: '', 画像: '', 表示: '○' },
    { 区分: 'スパ', メニュー名: '旧メニュー', 価格: 9999, '所要(分)': 30, 説明: '', 画像: '', 表示: '×' }
  ]);
  const p = await newPhone('4');
  await p.goto(B + '/menu.html'); await p.waitForTimeout(1800);
  const names = () => p.locator('#menu-list .menu-row-name').allInnerTexts();

  check('4', 'タブがシートの区分になっている',
    (await p.locator('#menu-tabs .tab').allInnerTexts()).join('/'), 'すべて/カット/スパ');
  check('4', '「表示×」のメニューは出さない', (await names()).includes('旧メニュー'), false);

  /* ここが抜けていると、絞り込んだ瞬間に一覧が真っ白になる。
     押した先の処理だけが古い一覧を見にいくため、目で見て気づきにくい。 */
  await p.locator('#menu-tabs .tab').nth(1).click(); await p.waitForTimeout(400);
  check('4', '区分で絞り込むと、その区分だけが並ぶ',
    (await names()).join('/'), 'メンズカット/キッズカット');

  await p.locator('#menu-tabs .tab').nth(2).click(); await p.waitForTimeout(400);
  check('4', 'もう一方の区分でも並ぶ', (await names()).join('/'), '炭酸スパ');

  /* 「すべて」に戻したときに掲載中の（＝店が直す前の）料金が出ると、
     お客様は違う金額を見て来店することになる。 */
  await p.locator('#menu-tabs .tab').nth(0).click(); await p.waitForTimeout(400);
  const all = await names();
  check('4', '「すべて」に戻すとシートの内容に戻る', all.join('/'), 'メンズカット/キッズカット/炭酸スパ');
  check('4', '古い掲載メニューが混ざらない', all.some(n => /メンテナンスカット|ラグジュアリー/.test(n)), false);

  check('4', '「4000〜」が「¥4,000〜」で出る',
    (await p.locator('#menu-list .menu-row-price').first().innerText()).trim(), '¥4,000〜');
  await p.context().close();
}

/* ============================================================
   【5】料金の書き方が、ページ間でぶれていないか
   ============================================================ */
console.log('\n【5】料金の書き方');
{
  /* 価格を空にした行は README で「カウンセリングでお見積り」と案内している。
     ページごとに別の言葉が出ると、値段の付け忘れのように見える。 */
  await saveSheet('menus', [
    { 区分: 'カット', メニュー名: '価格未定メニュー', 価格: '', '所要(分)': 50, 説明: '', 画像: '', 表示: '○' },
    { 区分: 'カット', メニュー名: 'メンズカット', 価格: '4000〜', '所要(分)': 50, 説明: '', 画像: '', 表示: '○' }
  ]);
  await saveSheet('coupons', [
    { 'メニュー名': 'デザインカラー', 価格: '', 通常価格: '', '所要(分)': 180,
      説明: 'カウンセリングでお見積りします', 条件: '', 対象: '全員', 画像: '', 表示: '○' },
    { 'メニュー名': '縮毛矯正コース', 価格: 22000, 通常価格: '', '所要(分)': 180,
      説明: '', 条件: '', 対象: '全員', 画像: '', 表示: '○' }
  ]);
  const p = await newPhone('5');
  await p.goto(B + '/menu.html'); await p.waitForTimeout(1800);
  const rowPrice = (await p.locator('#menu-list .menu-row-price').first().innerText()).trim();
  const cpPrice = (await p.locator('#coupon-list .price-now').first().innerText()).replace(/\s+/g, '');
  check('5', '価格未定の単品メニューは「お見積り」', rowPrice, 'お見積り');
  check('5', '「ご相談」など別の言葉が混ざらない', /ご相談|要相談|0円|¥0/.test(rowPrice), false);
  check('5', '価格未定のおすすめメニューは「お見積り」と読める', /お見積り/.test(cpPrice), true);
  check('5', 'おすすめメニューにも「¥0」が出ない', /¥0/.test(cpPrice), false);

  /* 予約ページ・予約確認ページも同じ言い方であること（担当は別だが、
     ここがずれるとお客様は同じメニューを別物だと思う） */
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1800);
  const reserveText = await p.locator('#coupon-choices').innerText();
  check('5', '予約ページでも「お見積り」で揃っている', /お見積り/.test(reserveText), true);
  check('5', '予約ページに「ご相談」が出ない', /ご相談/.test(reserveText), false);

  /* 値引きしていないのに「通常 ¥…」の取り消し線を出さない（有利誤認になる） */
  await p.goto(B + '/menu.html'); await p.waitForTimeout(1600);
  check('5', '通常価格を入れていないのに取り消し線を出さない',
    await p.locator('#coupon-list .price-list').count(), 0);

  /* 説明・条件が空の行で「※」だけが残らないか。
     書きかけのメニューを出しているように見える。 */
  const card = await p.locator('#coupon-list .coupon').nth(1).innerText();
  check('5', '条件が空のときに「※」だけを残さない', /※\s*$|※\s*\n/.test(card + '\n'), false);
  check('5', '説明が空でも中身のある表示になっている', /縮毛矯正コース/.test(card), true);
  await p.context().close();
}

/* ============================================================
   【6】スタイリストが1人の店で、「指名」の案内が不自然でないか
   ============================================================ */
console.log('\n【6】1人の店の「指名」まわり');
{
  const p = await newPhone('6');
  await p.goto(B + '/staff.html'); await p.waitForTimeout(1600);
  const solo = await p.evaluate(() => SALON.staff.length === 1);
  check('6', '在籍は1名（この店の前提）', solo, true);

  const note = (await p.locator('#staff-note').innerText()).replace(/\n/g, ' ');
  console.log('   案内文:', note);
  /* 予約画面には「指名なし」が出ない（reserve.js が1名のとき出さない）。
     出ない選択肢を案内すると、お客様は探して見つからず止まる。 */
  check('6', '出てこない「指名なし」を案内していない', /指名なし/.test(note), false);
  check('6', '他に空いているスタッフがいるように書いていない', /空いているスタッフ/.test(note), false);
  check('6', '担当が1名であることを伝えている', /1名|マンツーマン/.test(note), true);

  const btn = await p.locator('#staff-list .btn').first().innerText();
  check('6', 'ボタンが「指名して予約」になっていない', /指名して/.test(btn), false);
  check('6', 'ボタンから予約に進める', /予約/.test(btn), true);

  /* 案内と予約画面が食い違っていないことを、実際の予約画面で確かめる */
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1800);
  check('6', '予約画面にも「指名なし」の選択肢は無い',
    await p.locator('#staff-choices [data-staff=""]').count(), 0);
  await p.context().close();
}

/* ============================================================
   【7】店が管理ページから変えたことが、ちゃんと反映されるか
   ============================================================ */
console.log('\n【7】管理ページからの変更の反映');
{
  await saveSheet('styles', [
    { タイトル: '差し替えスタイル', 分類: 'ショート', タグ: 'ショート', 画像: '/mock-image.svg?seed=n1', 表示: '○' },
    { タイトル: '非表示にした写真', 分類: 'ショート', タグ: '', 画像: '', 表示: '×' }
  ]);
  const before = await post({ type: 'adminData', password: PW });
  await post({ type: 'adminSave', password: PW, target: 'settings', stamp: before.stamps.settings,
    rows: { ...before.settings, 'メイン写真': '/mock-image.svg?seed=hero',
            'お知らせ': '8月20日は出張のためお休みします。' } });

  const p = await newPhone('7');
  /* 掲載中のメイン写真（assets/hero.jpg）が置いてある状態を作る。
     置いてあるときにだけ起きる不具合があるため、ここは読める形で返す。 */
  await p.context().route('**/assets/hero.jpg', r => r.fulfill({ status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#333"/></svg>' }));

  await p.goto(B + '/index.html'); await p.waitForTimeout(2200);
  /* 描き直しのたびに写真を足していると、古い写真が上に重なって残り、
     店が差し替えたつもりでも画面は変わらない。 */
  check('7', 'メイン写真が二重に出ていない', await p.locator('.hero-photo').count(), 1);
  /* 重なっているときは、あとに置かれたほう（＝古い写真）が上に見える。
     店から見ると「差し替えたのに変わらない」画面になる。 */
  check('7', '差し替えた写真のほうが出ている',
    await p.locator('.hero-photo').last().getAttribute('src'), '/mock-image.svg?seed=hero');
  check('7', 'お知らせを入れると帯が出る', await p.locator('#shop-notice').isVisible(), true);
  check('7', 'お知らせの文章が出ている',
    (await p.locator('#shop-notice-text').innerText()).trim(), '8月20日は出張のためお休みします。');

  await p.goto(B + '/gallery.html'); await p.waitForTimeout(1800);
  check('7', '追加したスタイルが出る',
    (await p.locator('#style-list .style-title').allInnerTexts()).join('/'), '差し替えスタイル');
  check('7', '「表示×」のスタイルは出ない',
    (await p.locator('#style-list').innerText()).includes('非表示にした写真'), false);
  check('7', '分類がそのまま絞り込みタブになる',
    (await p.locator('#style-tabs .tab').allInnerTexts()).join('/'), 'すべて/ショート');

  await p.locator('#style-tabs .tab').nth(1).click(); await p.waitForTimeout(400);
  check('7', '分類で絞り込める', await p.locator('#style-list .style-card').count(), 1);

  // お知らせを空に戻すと帯も消える（入れても出ない／消しても残る、のどちらも困る）
  const mid = await post({ type: 'adminData', password: PW });
  await post({ type: 'adminSave', password: PW, target: 'settings', stamp: mid.stamps.settings,
    rows: { ...mid.settings, 'お知らせ': '' } });
  await p.goto(B + '/index.html'); await p.waitForTimeout(2000);
  check('7', 'お知らせを消すと帯も消える', await p.locator('#shop-notice').isVisible(), false);
  await p.context().close();
}

/* ============================================================
   【8】長い文字（メニュー名・タグ・口コミ本文）で崩れないか
   ============================================================ */
console.log('\n【8】長い文字（390px）');
{
  const LONG = 'ロングネームのメニューをここに入れて折り返しを確認するための非常に長い名前です';
  await saveSheet('menus', [
    { 区分: 'とてもながい区分名をここに入れてみる', メニュー名: LONG, 価格: 12000, '所要(分)': 60,
      説明: '説明もかなり長めに書いてみたときにどうなるかを確認します', 画像: '', 表示: '○' }
  ]);
  await saveSheet('coupons', [
    { 'メニュー名': LONG, 価格: 19800, 通常価格: 24000, '所要(分)': 150,
      説明: '説明も長めに書いてみます', 条件: '長い条件の文章をここに入れて折り返しを見ます',
      対象: '全員', 画像: '', 表示: '○' }
  ]);
  await saveSheet('styles', [
    { タイトル: LONG, 分類: 'とてもながい分類名', タグ: 'ながいタグをいれてみる,' + LONG, 画像: '', 表示: '○' }
  ]);
  await saveSheet('reviews', [
    { 投稿日: '2026-08-12', 予約番号: 'LM-TEST3', ニックネーム: 'とてもながいニックネームのかた',
      年代: '40代', 性別: '男性', 評価: 5, タイトル: 'とても長いタイトルをここに入れてみるとどうなるか',
      本文: 'あ'.repeat(400) + ' https://example.com/very/long/path/that/never/breaks',
      担当: 'MATTEO', メニュー: LONG, 状態: '掲載中' }
  ]);

  const p = await newPhone('8');
  for (const page of ['index.html', 'gallery.html', 'menu.html', 'reviews.html']) {
    await p.goto(B + '/' + page); await p.waitForTimeout(1800);
    const r = await p.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      // main の中身が画面の右端をはみ出していないか（意匠のストライプは枠外まで敷くので除く）
      はみ出し: [...document.querySelectorAll('main *')]
        .filter(el => !el.classList.contains('ph-stripes'))
        .filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.right > 391; })
        .map(el => el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0])
    }));
    check('8', `${page}: 横にはみ出さない`, r.scrollW <= 391, true);
    check('8', `${page}: 画面の外に出た部品が無い`, [...new Set(r.はみ出し)].join(',') || 'なし', 'なし');
  }
  // メニュー名と金額が重なって読めなくなっていないか
  await p.goto(B + '/menu.html'); await p.waitForTimeout(1800);
  check('8', 'メニュー名と金額が重なっていない', await p.evaluate(() => {
    let bad = 0;
    document.querySelectorAll('.menu-row').forEach(row => {
      const a = row.querySelector('.menu-row-name'), b = row.querySelector('.menu-row-meta');
      if (a && b && a.getBoundingClientRect().right > b.getBoundingClientRect().left + 0.5) bad++;
    });
    return bad;
  }), 0);
  await p.context().close();
  await saveSheet('reviews', []);
}

/* ============================================================
   【9】実際には無い割引・限定を書いていないか（景品表示法）
   ============================================================ */
console.log('\n【9】書いていることと、やっていることが合っているか');
{
  const p = await newPhone('9');
  await p.goto(B + '/index.html'); await p.waitForTimeout(1800);
  const home = await p.locator('main').innerText();
  /* おすすめメニューは値引きではなく、組み合わせの決まったコース（data.js）。
     「特別価格」「ネット予約限定」と書くと、安くなると思って来られる。 */
  check('9', '無い割引を「特別価格」と書いていない', /特別価格/.test(home), false);
  check('9', '「ネット予約限定」の価格をうたっていない', /予約限定/.test(home), false);
  check('9', 'おすすめメニューの見出しは出ている', /おすすめメニュー/.test(home), true);
  await p.goto(B + '/menu.html'); await p.waitForTimeout(1600);
  check('9', 'メニューページにも「特別価格」が無い',
    /特別価格|予約限定/.test(await p.locator('main').innerText()), false);
  await p.context().close();
}

/* ============================================================
   【10】掲載どおりの内容が、掲載どおりに出ているか

   メニューは店の言葉です。読みやすくしようとして言い換えると、
   お客様が掲載で見たものと違うものが出ます。誤字に見える箇所も
   そのままにしてあるので、勝手に直っていないことを確かめます。

   シートを読む前（＝いまの公開状態）を見たいので、受信先を空にします。
   ============================================================ */
console.log('\n【10】掲載どおりの内容（data.js）');
{
  const p = await newPhone('10', { noEndpoint: true });
  await p.goto(B + '/menu.html'); await p.waitForTimeout(1800);
  const main = await p.locator('main').innerText();

  check('10', 'おすすめメニューは掲載どおり14件', await p.locator('#coupon-list .coupon').count(), 14);
  check('10', '単品メニューは掲載どおり9件', await p.locator('#menu-list .menu-row').count(), 9);

  /* 掲載が「¥0」の2件。無料ではなく価格未定なので、¥0 と出してはいけない。
     無料だと思って来られると有利誤認になり、店が断る側に回ります。 */
  check('10', 'メニューページのどこにも「¥0」が出ない', /¥\s*0(?![\d,])/.test(main), false);
  check('10', '価格未定の2件が「お見積り」になっている',
    (main.match(/カウンセリングでお見積り/g) || []).length, 2);

  /* 「¥4,000〜」の「〜」。全角チルダ（～）で書くと priceFrom が立たず、
     「¥4,000」と言い切ってしまう。来店してから金額が違うことになる。 */
  check('10', '「¥4,000〜」の「〜」が出ている',
    (await p.locator('#menu-list .menu-row-price').first().innerText()).trim(), '¥4,000〜');
  check('10', '「〜から」が付く単品は掲載どおり5件',
    (main.match(/¥[\d,]+〜/g) || []).length, 5);

  /* 掲載の文言が、読みやすさのために書き換えられていないか。
     どれも「直したくなる」形なので、直っていたら気づけるようにしておく。 */
  check('10', '誤字に見える「こちも」を直していない', /こちも選択ください/.test(main), true);
  check('10', '句点の無い説明文をそのまま出している',
    /メンテナンスメニューになりますスキンフェードは＋500になります/.test(main), true);
  check('10', 'ヘアセットの「※シャンプーブロー込み」が消えていない',
    /ヘアセット ※シャンプーブロー込み/.test(main), true);
  /* 以前ここには前任が書いた「シャンプーは含まれません。」が入っていた。
     掲載は「込み」なので、逆のことを書いていた。 */
  check('10', '掲載と逆の「シャンプーは含まれません」が残っていない',
    /シャンプーは含まれません/.test(main), false);

  // トップにもおすすめメニューが出る。こちらにも ¥0 を出さない
  await p.goto(B + '/index.html'); await p.waitForTimeout(1800);
  check('10', 'トップにも「¥0」が出ない',
    /¥\s*0(?![\d,])/.test(await p.locator('main').innerText()), false);

  /* 掲載のスタッフ情報。持っているだけで画面に出ないと、
     あとから誰も気づけない（得意な技術・趣味は掲載にある文章）。 */
  await p.goto(B + '/staff.html'); await p.waitForTimeout(1800);
  const staff = await p.locator('#staff-list').innerText();
  check('10', '肩書きが掲載どおり', /owner/.test(staff), true);
  check('10', '経験年数が出ている', /経験6年/.test(staff), true);
  check('10', '掲載の「得意な技術」が画面に出ている', /得意な技術/.test(staff), true);
  check('10', '掲載の「趣味・マイブーム」が画面に出ている', /趣味・マイブーム/.test(staff), true);

  await p.goto(B + '/gallery.html'); await p.waitForTimeout(1800);
  check('10', 'スタイルは掲載どおり12件', await p.locator('#style-list .style-card').count(), 12);
  const gallery = await p.locator('#style-list').innerText();
  /* タイトルとタグだけだと語の羅列に見える。掲載の説明文が出ていること。 */
  check('10', 'スタイルの説明文が画面に出ている',
    /癖毛の方は曲がる縮毛矯正、直毛の方はニュアンスパーマで再現可能です/.test(gallery), true);
  check('10', '誤字に見える「感メッシュ」を直していない', /感メッシュ/.test(gallery), true);
  check('10', '誤字に見える「出ずらい」を直していない', /出ずらい/.test(gallery), true);

  /* 店舗情報。ここは来店できるかどうかに直結する。 */
  await p.goto(B + '/index.html'); await p.waitForTimeout(1800);
  const info = await p.locator('#salon-info').innerText();
  /* 掲載には「竜ヶ崎市」と「龍ケ崎市」が混在していた。住所は正しい字でないと、
     カーナビに入れた方がたどり着けない。 */
  check('10', '住所の「竜ヶ崎」が残っていない', /竜ヶ崎/.test(info), false);
  /* 曜日の定休日が無い店。「年中無休」「なし」と出すと、いつ行っても
     開いていると読まれる。掲載は不定休で、出張の週は出勤日数が減る。 */
  check('10', '定休日を「年中無休」と書いていない', /年中無休/.test(info), false);
  check('10', '掲載の定休日の注記が出ている', /不定休 都内出張/.test(info), true);
  /* スタイリスト1名の店で「男性スタッフが多い」と書くと、複数いると読まれる。
     同じ表の「スタッフ数 スタイリスト1名」と食い違う。 */
  check('10', '1名の店に「男性スタッフが多い」と書いていない', /男性スタッフが多い/.test(info), false);
  check('10', '掲載のこだわり条件は出ている', /店頭でのカード支払いOK/.test(info), true);
  await p.context().close();
}

/* ============================================================
   まとめ
   ============================================================ */
const ng = results.filter(r => !r.ok);
console.log('\n' + '='.repeat(52));
console.log(`確認 ${results.length} 項目 / 失敗 ${ng.length} 件`);
if (ng.length) ng.forEach(r => console.log(`  ❌ [${r.g}] ${r.label}（期待=${r.expected} 実際=${r.actual}）`));
console.log('JSエラー:', jsErrors.length ? jsErrors : 'なし');
} finally {
  /* 控えておいたシートの中身に戻す。
     戻さないと、このあと流す試験が「メニューが違う」で落ちます。 */
  if (SHEET_BACKUP) {
    for (const t of ['menus', 'coupons', 'styles']) {
      await saveSheet(t, SHEET_BACKUP[t]).catch(e => console.log('シートを戻せませんでした:', t, e.message));
    }
    const d = await post({ type: 'adminData', password: PW }).catch(() => null);
    if (d && d.ok) await post({ type: 'adminSave', password: PW, target: 'settings',
      stamp: d.stamps.settings, rows: SHEET_BACKUP.settings }).catch(() => {});
  }
  await br.close();
}

// 1件でも失敗したら、終了コードで知らせる（CIやスクリプトから使えるように）
if (results.some(r => !r.ok) || jsErrors.length) process.exitCode = 1;
