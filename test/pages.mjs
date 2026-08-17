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
  /* いちばん明るい写真が入ったときを作る。
     店主は管理ページから写真を差し替えます。いま入っている1枚（暗い店内）に
     合わせて覆いを決めると、明るい写真に替えた日に本文が読めなくなります。 */
  if (opt.whitePhoto) await ctx.route(/\.(jpg|jpeg|png|webp)(\?|$)/i, r => r.fulfill({
    status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1000">'
      + '<rect width="1200" height="1000" fill="#ffffff"/></svg>' }));
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
   【11】最初の3秒で「何の店か」が伝わるか

   トップの上半分は、英字のロゴ・ESTD の行・「イタリア発、東京経由。」でした。
   龍ケ崎で「フェード」「白髪ぼかし」を探して流れてきた方は、
   ここまで読んでも自分向きの店かどうかが分かりません。

   出しているのは、店が掲載名に自分で書いている専門と、住所の市名だけです。
   こちらで文章を作ると、店が言っていないことを店の言葉として書くことになります。
   ============================================================ */
console.log('\n【11】トップの最初の1画面');
{
  const p = await newPhone('11', { noPhoto: true, noEndpoint: true });
  await p.goto(B + '/index.html'); await p.waitForTimeout(2000);

  const line = (await p.locator('#hero-tagline').innerText()).trim();
  console.log('   1行目:', line);
  check('11', '何の店かを日本語で出している', !!line, true);
  check('11', '探している人の言葉（専門）が入っている', /縮毛矯正/.test(line) && /白髪ぼかし/.test(line), true);
  check('11', 'どこの店かが日本語で分かる', /龍ケ崎市/.test(line), true);
  /* 店が言っていないことを足していないか。
     出している文字が、掲載名と住所の中にある文字だけでできていることを確かめる。 */
  check('11', '掲載名と住所にある言葉しか使っていない', await p.evaluate(() => {
    const src = String(SALON.fullName) + String(SALON.address);
    return [...document.querySelector('#hero-tagline').textContent]
      .filter(c => c !== '｜' && !src.includes(c)).join('') || 'なし';
  }), 'なし');
  /* 指を動かす前の1画面（844px）に入っていないと、最初の3秒には間に合わない */
  check('11', '1画面目に入っている', await p.evaluate(() => {
    const r = document.querySelector('#hero-tagline').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= 844;
  }), true);
  /* 掲載名の書き方が変わって「」が無くなったときは、何も出さない
     （半端な文字列を出すより、出さないほうがましなため） */
  check('11', '掲載名に専門の記載が無ければ何も出さない', await p.evaluate(() => {
    const before = SALON.fullName;
    SALON.fullName = 'ZER01 barber/lounge';
    const out = heroTaglineParts().join('｜');
    SALON.fullName = before;
    return /メンズカット/.test(out);
  }), false);
  /* 日本語はどこでも折り返せるので、1つの文字列で出すと
     「茨城県龍ケ崎市｜メンズカ／ット/縮毛矯正…」と語の途中で折れる。
     地名と専門を別の箱にして、そのあいだで折り返させている。 */
  check('11', '語の途中で折り返さないように区切ってある',
    await p.locator('#hero-tagline span').count(), 2);
  await p.context().close();
}

/* ============================================================
   【12】口コミ0件の行き止まりを作らないか

   0件なのに「口コミをすべて見る」と書いてあると、押した先には
   「まだ届いていません」の一文しかありません。
   架空の口コミは作らないと決めている以上、必ず通る道です。
   ============================================================ */
console.log('\n【12】口コミ0件のときの行き先');
{
  // 受信先がまだ無い（＝投稿フォームも出していない）とき
  const p = await newPhone('12', { noEndpoint: true });
  await p.goto(B + '/index.html'); await p.waitForTimeout(1600);
  /* 押した先が「まだ届いていません」の一文だけ、という道を作らない */
  check('12', '0件のとき「すべて見る」と書かない',
    /口コミをすべて見る/.test(await p.locator('#home-reviews').locator('xpath=../..').innerText()), false);
  /* 書ける場所が無いのに「ご感想を」と誘っても、また行き止まりになる */
  check('12', '投稿できないあいだはボタンごと出さない',
    await p.locator('#home-review-link').isVisible(), false);
  await p.context().close();
}
{
  // 受信先を入れたあと。0件でも、書ける場所へは行ける
  const p = await newPhone('12b');
  await p.goto(B + '/index.html'); await p.waitForTimeout(1800);
  check('12', '投稿できるときは書ける場所へ誘う',
    (await p.locator('#home-review-link').innerText()).trim(), 'ご感想をお寄せください');
  check('12', '行き先が投稿フォームになっている',
    /reviews\.html#write$/.test(await p.locator('#home-review-link').getAttribute('href')), true);
  await p.context().close();
}
{
  /* 口コミが届いたら「すべて見る」に戻る。片道だけ直すと、
     せっかく集まった口コミへの入口が一生出ない（【3】と同じ落とし穴）。 */
  await saveSheet('reviews', [
    { 投稿日: '2026-08-10', 予約番号: 'LM-TEST9', ニックネーム: 'K.I', 年代: '40代', 性別: '',
      評価: 5, タイトル: '', 本文: '丁寧に切ってもらえました。', 担当: 'MATTEO',
      メニュー: 'カットコース', 状態: '掲載中' }
  ]);
  const p = await newPhone('12c');
  await p.goto(B + '/index.html'); await p.waitForTimeout(2000);
  check('12', '口コミが届いたら「すべて見る」に戻る',
    (await p.locator('#home-review-link').innerText()).trim(), '口コミをすべて見る');
  check('12', '行き先も口コミページに戻る',
    await p.locator('#home-review-link').getAttribute('href'), 'reviews.html');
  await p.context().close();
  await saveSheet('reviews', []);
}

/* ============================================================
   【13】写真が0枚のときのスタイル一覧と、メニューの探しやすさ
   ============================================================ */
console.log('\n【13】一覧の見渡しやすさ（390px）');
{
  const p = await newPhone('13', { noPhoto: true, noEndpoint: true });
  await p.goto(B + '/gallery.html'); await p.waitForTimeout(2500);
  /* 1列だと写真の枠（3:4）が477pxになり、写真の無いいまは
     意匠のストライプだけで1画面が埋まります。12件続くと「準備中の店」に見えます。 */
  const grid = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('#style-list .style-card')];
    const tops = cards.map(c => Math.round(c.getBoundingClientRect().top));
    return {
      件数: cards.length,
      横に並ぶ枚数: tops.filter(t => t === tops[0]).length,
      写真枠の高さ: Math.round(document.querySelector('.style-thumb').getBoundingClientRect().height)
    };
  });
  check('13', 'スタイルは掲載どおり12件', grid.件数, 12);
  check('13', '390pxで2列に並ぶ', grid.横に並ぶ枚数, 2);
  /* 高さ0だと潰れている（【1】で見ている）。逆に大きすぎると1件で画面が埋まる */
  check('13', '写真枠が1件で画面を埋めない', grid.写真枠の高さ > 100 && grid.写真枠の高さ < 320, true);

  /* おすすめメニュー14件。掲載のタグで絞れないと、単品メニューに着くまでに
     14件を全部通り過ぎることになる。 */
  await p.goto(B + '/menu.html'); await p.waitForTimeout(2200);
  const tabs = await p.locator('#coupon-tabs .tab').allInnerTexts();
  check('13', 'おすすめメニューを掲載のタグで絞れる', tabs[0], 'すべて');
  check('13', 'タグは掲載にあるものが並ぶ', tabs.includes('縮毛矯正') && tabs.includes('カラー'), true);
  check('13', '絞る前は掲載どおり14件', await p.locator('#coupon-list .coupon').count(), 14);

  const idx = tabs.indexOf('カラー');
  await p.locator('#coupon-tabs .tab').nth(idx).click(); await p.waitForTimeout(400);
  const colored = await p.locator('#coupon-list .coupon').count();
  check('13', '絞ると件数が減る', colored > 0 && colored < 14, true);
  check('13', '絞った結果に、そのタグのものだけが残る',
    /カラー/.test(await p.locator('#coupon-list').innerText()), true);

  await p.locator('#coupon-tabs .tab').nth(0).click(); await p.waitForTimeout(400);
  check('13', '「すべて」に戻すと14件に戻る', await p.locator('#coupon-list .coupon').count(), 14);

  /* おすすめ14件を通り過ぎずに単品メニューへ行けるか */
  await p.locator('.page-jump a').nth(1).click();
  /* 決め打ちの秒数で測らないこと。この近道は滑らかに動くので、
     測る時点でまだ動いている途中だと、着く位置ではなく通過点を見ることになります。
     写真を1枚増減させただけで結果が変わり、飛べているのに落ちます。
     止まったのを見てから測ります。 */
  await p.waitForFunction(() => {
    const y = Math.round(window.scrollY);
    const done = window.__lastY === y;
    window.__lastY = y;
    return done && y > 0;
  }, null, { timeout: 5000, polling: 250 });
  check('13', '近道から単品メニューまで飛べる', await p.evaluate(() => {
    const r = document.querySelector('#single').getBoundingClientRect();
    // 貼りついたヘッダーの下に隠れていないこと（scroll-padding-top ぶんを見る）
    return r.top >= -2 && r.top < 240;
  }), true);
  await p.context().close();
}
{
  /* 店がシートでおすすめメニューを管理すると、タグの欄がありません。
     絞る材料が無いのにタブだけ出ていると、押しても何も起きない箱になります。 */
  await saveSheet('coupons', [
    { 'メニュー名': 'カット＋カラー', 価格: 14500, 通常価格: '', '所要(分)': 120,
      説明: '', 条件: '', 対象: '全員', 画像: '', 表示: '○' },
    { 'メニュー名': 'カット＋パーマ', 価格: 14900, 通常価格: '', '所要(分)': 130,
      説明: '', 条件: '', 対象: '全員', 画像: '', 表示: '○' }
  ]);
  const p = await newPhone('13b');
  await p.goto(B + '/menu.html'); await p.waitForTimeout(2200);
  check('13', 'タグが無いおすすめメニューでは絞り込みを出さない',
    await p.locator('#coupon-tabs').isVisible(), false);
  check('13', 'それでもおすすめメニューは並ぶ', await p.locator('#coupon-list .coupon').count(), 2);
  await p.context().close();
}

/* ============================================================
   【13c】できない約束をしていないか／トップの節が一覧の写しになっていないか
   ============================================================ */
console.log('\n【13c】ボタンの文言と、トップのスタイル節');
{
  const p = await newPhone('13c', { noEndpoint: true });
  await p.goto(B + '/gallery.html'); await p.waitForTimeout(2600);
  /* 以前は一覧の下に1つあるだけで、どのスタイルも指していませんでした。
     「このイメージで予約する」は、押した本人にも何を指すのか分からない文言です。 */
  const cta = await p.locator('main a[href^="reserve.html"]').last().innerText();
  check('13c', 'どれも指していないボタンに「このイメージで」と書かない', /このイメージ/.test(cta), false);
  check('13c', 'スタイルを決めない方の道も残っている', /予約/.test(cta), true);

  // スタイルごとに、そのスタイルで進めるボタンがある
  check('13c', 'カードごとに予約のボタンがある',
    await p.locator('#style-list .style-book').count(), 12);
  const label = (await p.locator('#style-list .style-book').first().innerText()).replace(/\s+/g, '');
  check('13c', 'ボタンが「このスタイル」を指している', label, 'このスタイルで予約');
  /* 幅171pxのカードに入ります。語の途中で折り返すと「このスタイルで予／約」になります。 */
  check('13c', 'ボタンの文字が語の途中で折り返さない', await p.evaluate(() => {
    const a = document.querySelector('#style-list .style-book');
    // 中の箱それぞれが1行に収まっていれば、割れているのは箱と箱のあいだだけ
    return [...a.querySelectorAll('span')]
      .every(s => s.getBoundingClientRect().height <= parseFloat(getComputedStyle(s).lineHeight) + 1);
  }), true);

  /* 押したスタイルの名前が、予約ページのご要望欄まで運ばれること。
     ここが効いていないと、お客様は結局スタイル名を書き写すことになります。
     受け渡しは common.js の rememberStyleRequest / takeStyleRequest です。 */
  const 押したスタイル = await p.locator('#style-list .style-book').first().getAttribute('data-style');
  await p.locator('#style-list .style-book').first().click();
  await p.waitForTimeout(2600);
  check('13c', '押すと予約ページに着く', new URL(p.url()).pathname.endsWith('/reserve.html'), true);
  const 要望 = await p.evaluate(() => {
    const t = document.querySelector('textarea[name="request"], #request');
    return t ? t.value : '(欄が見つかりません)';
  });
  console.log('   ご要望欄:', 要望);
  check('13c', 'スタイル名がご要望欄まで運ばれている', 要望.includes(押したスタイル), true);
  /* 予約の中身をURLに載せない方針（DECISIONS.md）。履歴に残さないため。 */
  check('13c', 'スタイル名をURLに載せていない', /[?#]/.test(p.url()), false);

  await p.goto(B + '/gallery.html'); await p.waitForTimeout(2200);
  /* ボタンが名前を運ぶようになったので、「ご要望欄に書いてください」と
     お願いし続けると、要らない手間をかけさせることになります。 */
  const 案内 = await p.locator('.page-head p').innerText();
  check('13c', '手で書き写してくださいと言っていない',
    /書いていただければ|ご記入ください/.test(案内), false);

  /* トップの「ヘアスタイル」は一覧ではなく、店の幅を見せる節。
     先頭から4件そのまま出すと、gallery.html の1画面目と同じ並びになる。 */
  await p.goto(B + '/index.html'); await p.waitForTimeout(2000);
  await p.locator('#home-styles').scrollIntoViewIfNeeded(); await p.waitForTimeout(2200);
  check('13c', 'トップは4点だけ見せる', await p.locator('#home-styles .style-card').count(), 4);
  const 分類 = await p.evaluate(() =>
    [...document.querySelectorAll('#home-styles .style-meta')]
      .filter((_, i) => i % 3 === 0).map(e => e.textContent.split('／')[0]));
  check('13c', '4点が別々の分類から選ばれている', new Set(分類).size, 4);
  check('13c', '一覧へ行ける', await p.locator('main a[href="gallery.html"]').count() > 0, true);
  await p.context().close();
}

/* 届いた写真が、枠に対して切れすぎていないか。
   届いたスタッフ写真は 853×1280 の縦位置です。狭い画面では枠を横長（4:3）に
   していたため、上下が半分切り落とされ、頭の上半分が枠の外に出ていました。
   バーバーは人で選ばれるので、顔が切れているのはいちばん困ります。

   1枚ごとに位置を調整すると、店主が差し替えた日にまた切れます。
   写真の向きと枠の向きが合っているか、という形で見ます。 */
console.log('\n【13b】届いた写真の切り取られ方');
{
  const p = await newPhone('13b', { noEndpoint: true });
  for (const [page, sel, label] of [['staff.html', '.staff-card .avatar', 'スタッフ'],
                                    ['index.html', '#home-staff .avatar', 'トップのスタッフ'],
                                    ['gallery.html', '.style-thumb', 'スタイル']]) {
    await p.goto(B + '/' + page); await p.waitForTimeout(1500);
    /* 写真は loading="lazy" なので、画面に入るまで読み込まれません。
       送らずに測ると naturalWidth が 0 のままで、写真が無いと言ってしまいます。 */
    await p.locator(sel).first().scrollIntoViewIfNeeded();
    await p.waitForTimeout(2500);
    const r = await p.evaluate(s => {
      const box = document.querySelector(s);
      const img = box && box.querySelector('img');
      if (!img || !img.naturalWidth) return null;
      const b = box.getBoundingClientRect();
      const 写真の比 = img.naturalWidth / img.naturalHeight;
      const 枠の比 = b.width / b.height;
      // object-fit: cover なので、はみ出した側が切り落とされる
      return Math.round((枠の比 > 写真の比 ? 写真の比 / 枠の比 : 枠の比 / 写真の比) * 100) / 100;
    }, sel);
    check('13b', `${label}の写真が読めている`, r !== null, true);
    /* 4分の1までの切り落としなら、寄った構図として成り立ちます。
       半分切ると、縦位置の写真では顔が枠の外に出ます。 */
    check('13b', `${label}の写真が切れすぎていない（残り${r}）`, r >= 0.75, true);
  }
  await p.context().close();
}

/* ============================================================
   【14】読めること・押せること（390pxで実測）

   お客様は10代から50代まで、外の明るさの中で片手で見ます。
   小さい文字に必要なのは 4.5:1、タップ対象は44px角が目安です。
   直したのは主に --muted（#857C6D）で書かれていた行で、
   クリーム色の地に対して 3.16〜3.88 : 1 しかありませんでした。

   数えるのは main の中だけです。ヘッダーとフッターは別の作業者の担当で、
   ここで落とすと直せない試験になります。
   ============================================================ */
console.log('\n【14】文字の濃さと、指の届く大きさ');
{
  const measure = () => {
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const nums = s => (s.match(/[\d.]+/g) || []).map(Number);
    // 透けている親をさかのぼって、実際に後ろにある色を探す
    const bgOf = el => {
      let n = el;
      while (n && n !== document.documentElement) {
        const c = nums(getComputedStyle(n).backgroundColor);
        if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5)) return c.slice(0, 3);
        n = n.parentElement;
      }
      return [255, 255, 255];
    };
    const 薄い = [], 小さい = [];
    document.querySelectorAll('main *').forEach(el => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || cs.visibility === 'hidden') return;
      /* 写真を入れたヒーローだけは、この測り方では見られない。
         暗い膜は ::before / ::after で敷いていて、要素の背景色としては
         読み取れないため、白い文字が「地と同じ色」に見えてしまう。
         この状態の色は style.css の .hero.has-photo で明るい側に
         そろえてあり、下の【14b】で別に確かめている。 */
      if (el.closest('.hero.has-photo')) return;
      const 直接の文字 = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (!直接の文字) return;
      const l1 = lum(nums(cs.color).slice(0, 3)), l2 = lum(bgOf(el));
      const 比 = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize);
      // 大きい文字（24px以上、太字なら18.66px以上）だけは 3:1 でよい
      const 必要 = (size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700)) ? 3 : 4.5;
      if (比 < 必要) 薄い.push(`${el.className || el.tagName}(${size}px ${Math.round(比 * 100) / 100}:1)`);
    });
    document.querySelectorAll('main a[href], main button, .breadcrumb a').forEach(el => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (r.height < 43.5 || r.width < 43.5) 小さい.push(`${el.className || el.tagName}(${Math.round(r.width)}x${Math.round(r.height)})`);
    });
    return { 薄い: [...new Set(薄い)], 小さい: [...new Set(小さい)] };
  };

  /* 3つの状態で見ます。
       写真0枚 … 写真が届く前の状態。この形でも公開に耐えること
       掲載の写真あり … いまの実態（assets に25枚入っています）
       シート反映後 … 店が管理ページから入れ替えたあと。口コミや条件の行は
                      ここでしか画面に出ません */
  for (const [label, opt] of [['写真0枚', { noPhoto: true, noEndpoint: true }],
                              ['掲載の写真あり', { noEndpoint: true }],
                              ['シート反映後', {}]]) {
    if (!opt.noEndpoint) {
      await saveSheet('reviews', [
        { 投稿日: '2026-08-10', 予約番号: 'LM-TEST8', ニックネーム: 'T.K', 年代: '30代', 性別: '男性',
          評価: 5, タイトル: '清潔感が続きます', 本文: '仕上がりに満足しています。', 担当: 'MATTEO',
          メニュー: 'カットコース', 状態: '掲載中' }
      ]);
      await saveSheet('coupons', [
        { 'メニュー名': 'カット＋カラー', 価格: 14500, 通常価格: '', '所要(分)': 120,
          説明: '説明の行です', 条件: '他のメニューとの併用はできません', 対象: '全員', 画像: '', 表示: '○' }
      ]);
    }
    const p = await newPhone('14', opt);
    for (const page of ['index.html', 'gallery.html', 'staff.html', 'menu.html', 'reviews.html']) {
      await p.goto(B + '/' + page); await p.waitForTimeout(2200);
      const r = await p.evaluate(measure);
      check('14', `${label} ${page}: 4.5:1 に足りない文字が無い`, r.薄い.join(',') || 'なし', 'なし');
      check('14', `${label} ${page}: 44pxに足りないタップ対象が無い`, r.小さい.join(',') || 'なし', 'なし');
    }
    await p.context().close();
  }
  await saveSheet('reviews', []);
}

/* 店がメイン写真を入れたときのトップ。
   地が暗くなるので、文字を明るい側へ入れ替えないと読めなくなる。
   実際「BARBER/LOUNGE」だけ臙脂色のまま残っていて 1.65:1 だった。 */
console.log('\n【14b】メイン写真を入れたときのトップ');
{
  const before = await post({ type: 'adminData', password: PW });
  await post({ type: 'adminSave', password: PW, target: 'settings', stamp: before.stamps.settings,
    rows: { ...before.settings, 'メイン写真': '/mock-image.svg?seed=hero' } });

  const p = await newPhone('14b');
  await p.goto(B + '/index.html'); await p.waitForTimeout(2400);
  check('14b', '写真が読めたときだけ暗い膜をかける',
    await p.evaluate(() => document.querySelector('.hero').classList.contains('has-photo')), true);
  /* 暗い地の上に置くものは、すべて明るい側（--on-ink 系）に寄っていること。
     1つでも取り残されると、そこだけ読めない行になる。 */
  check('14b', '暗い地の上の文字が明るい側にそろっている', await p.evaluate(() => {
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lum = s => { const [r, g, b] = (s.match(/[\d.]+/g) || []).map(Number);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
    return ['#hero-catch', '#hero-tagline', '.hero .wm-name', '.hero .wm-sub',
            '.hero-label', '.hero-desc', '.hero-meta']
      .filter(sel => { const el = document.querySelector(sel);
        // 暗い膜（黒の不透明度 .35〜.62）の上なので、明るい文字でないと読めない
        return el && lum(getComputedStyle(el).color) < 0.4; })
      .join(',') || 'なし';
  }), 'なし');

  const mid = await post({ type: 'adminData', password: PW });
  await post({ type: 'adminSave', password: PW, target: 'settings', stamp: mid.stamps.settings,
    rows: { ...mid.settings, 'メイン写真': '' } });
  await p.context().close();
}

/* ============================================================
   【14c】トップに写真が入ったとき、その上の文字が読めるか

   写真が届いて初めて出た問題です。ストライプの意匠だったころは起きませんでした。

   覆い（スクリム）は2枚あるように見えて、写真の上に乗るのは ::after だけです。
   ::before は写真より先に描かれるので、あとから重なる写真に完全に隠れます。
   ここでも ::after しか勘定に入れません。::before を数えると、
   実際には効いていない濃さを「足りている」と数えてしまいます。

   測り方：覆いの濃さを CSS から読み、いちばん明るい写真（真っ白）に
   重ねた地の色を出して、その上の文字との比を計算します。
   1枚の写真で目視するのではなく、どんな写真が来ても成り立つかを見ます。
   ============================================================ */
console.log('\n【14c】写真の上の文字（いちばん明るい写真で）');
{
  const p = await newPhone('14c', { whitePhoto: true, noEndpoint: true });
  await p.goto(B + '/index.html'); await p.waitForTimeout(3200);

  const r = await p.evaluate(() => {
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const hero = document.querySelector('.hero');
    /* 覆いの停止点。濃さと位置（%）が両方書いてあることが前提です。
       位置を省いた書き方に変えると、ここで読み取れなくなって下の項目が落ちます。
       黙って通り抜けるより、気づける形にしてあります。 */
    const stops = [...getComputedStyle(hero, '::after').backgroundImage
      .matchAll(/rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)\s*([\d.]+)%/g)]
      .map(m => ({ a: Number(m[1]), at: Number(m[2]) / 100 }));
    const alphaAt = t => {
      if (t <= stops[0].at) return stops[0].a;
      for (let i = 1; i < stops.length; i++) if (t <= stops[i].at) {
        const s = stops[i - 1], e = stops[i];
        return s.a + (e.a - s.a) * (t - s.at) / (e.at - s.at);
      }
      return stops[stops.length - 1].a;
    };

    const hb = hero.getBoundingClientRect();
    const 足りない = [];
    if (stops.length >= 2) hero.querySelectorAll('*').forEach(el => {
      if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return;
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return;
      // 自前の地を持つもの（黒いボタン）は写真の上に乗っていない
      const own = (cs.backgroundColor.match(/[\d.]+/g) || []).map(Number);
      if (own.length >= 3 && (own[3] === undefined || own[3] > 0.5)) return;

      // その文字がかかっている範囲のうち、いちばん薄いところで見る
      const a = Math.min(alphaAt((box.top - hb.top) / hb.height),
                         alphaAt((box.bottom - hb.top) / hb.height));
      const bg = 255 * (1 - a);                     // 真っ白な写真 × 黒の覆い
      const fg = (cs.color.match(/[\d.]+/g) || []).map(Number);
      const fa = fg.length > 3 ? fg[3] : 1;
      // 文字が透けていれば、そのぶん地の明るさが混ざって比が下がる
      const 比 = (lum(fg.slice(0, 3).map(v => fa * v + (1 - fa) * bg)) + 0.05)
        / (lum([bg, bg, bg]) + 0.05);
      const size = parseFloat(cs.fontSize);
      const 必要 = (size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700)) ? 3 : 4.5;
      if (比 < 必要) 足りない.push(
        `${el.id || el.className || el.tagName}(${size}px 覆い${Math.round(a * 100) / 100} ${Math.round(比 * 100) / 100}:1)`);
    });
    return { 停止点: stops.length, 足りない, 一番薄い: stops.length ? Math.min(...stops.map(s => s.a)) : 0 };
  });

  check('14c', '写真が読めたときだけ暗い膜をかける',
    await p.evaluate(() => document.querySelector('.hero').classList.contains('has-photo')), true);
  check('14c', '覆いの濃さを CSS から読み取れている', r.停止点 >= 2, true);
  /* 小さい文字が 4.5:1 を満たすには、真っ白な写真の上で黒 0.58 以上が要ります。
     文字のある範囲がそれを下回っていないこと。 */
  console.log('   覆いのいちばん薄いところ:', r.一番薄い);
  check('14c', 'いちばん明るい写真でも、読めない文字が無い', r.足りない.join(',') || 'なし', 'なし');
  await p.context().close();
}

/* いま入っている写真（暗い店内）でも、当然読めること。
   覆いを濃くしすぎて写真が真っ黒になっていないことも、ここで見ます。 */
{
  const p = await newPhone('14d', { noEndpoint: true });
  await p.goto(B + '/index.html'); await p.waitForTimeout(3200);
  check('14c', '掲載の写真でも暗い膜がかかっている',
    await p.evaluate(() => document.querySelector('.hero').classList.contains('has-photo')), true);
  /* 覆いは、写真がまったく見えなくなるほど濃くしない。
     0.85 を超えると、何の店なのかが写真から伝わらなくなる。 */
  check('14c', '写真が見えなくなるほど覆っていない', await p.evaluate(() => {
    const stops = [...getComputedStyle(document.querySelector('.hero'), '::after').backgroundImage
      .matchAll(/rgba?\([^)]*,\s*([\d.]+)\s*\)/g)].map(m => Number(m[1]));
    return stops.length ? Math.max(...stops) <= 0.85 : false;
  }), true);
  await p.context().close();
}

/* ============================================================
   【15】ご案内の行き止まり（連絡先・戻る道）
   ============================================================ */
console.log('\n【15】連絡先と戻る道');
{
  const p = await newPhone('15', { noPhoto: true, noEndpoint: true });
  await p.goto(B + '/index.html'); await p.waitForTimeout(1800);
  /* スマホ幅ではヘッダーのTEL表示が消える（style.css の .header-tel）。
     番号が出ているのはサロン情報の表だけなので、そこが押せないと、
     当日の遅れを伝えたい方は番号を選んで写すことになる。 */
  const tel = p.locator('#salon-info a[href^="tel:"]');
  check('15', 'サロン情報の電話番号がそのまま掛けられる', await tel.count(), 1);
  check('15', '掛け先が掲載の番号になっている',
    await tel.getAttribute('href'), 'tel:08044987036');

  // どのページからも予約に行ける（行き止まりを作らない）
  for (const page of ['gallery.html', 'staff.html', 'menu.html', 'reviews.html']) {
    await p.goto(B + '/' + page); await p.waitForTimeout(1500);
    check('15', `${page}: 本文から予約に行ける`,
      await p.locator('main a[href^="reserve.html"]').count() > 0, true);
    check('15', `${page}: トップに戻れる`,
      await p.locator('.breadcrumb a[href="index.html"]').count(), 1);
  }
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
