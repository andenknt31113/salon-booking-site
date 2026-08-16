/* 予約確認ページ（mypage.html / assets/js/mypage.js）の試験
   お客様が「予約を見る・変えるのをやめる・日時を変える」ためにここへ来ます。
   1シナリオ = 1つの「誰が・何をして・どうなってほしいか」 */
/* Playwright の場所。
   ふつうは npm i -D playwright で入れた 'playwright' を使います。
   別の場所にある場合は PLAYWRIGHT に読み込み先を指定してください。 */
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const B = process.env.BASE || 'http://127.0.0.1:8820';
const PW = 'test1234';
const post = b => fetch(B + '/exec', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(b) }).then(r => r.json());

/* 日付は「日本時間の今日」から数えます。この機械はUTCで動いているので、
   new Date().getDate() のままだと、夜のあいだ1日ずれます。 */
const jstNow = new Date(Date.now() + 9 * 3600e3);
const day = off => new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate() + off))
  .toISOString().slice(0, 10);
const jstTime = (dateKey, hhmmss) => new Date(`${dateKey}T${hhmmss}+09:00`);

const br = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const jsErrors = [];
const results = [];

function check(uc, label, actual, expected) {
  const ok = String(actual) === String(expected);
  results.push({ uc, label, ok, actual, expected });
  console.log(`   ${ok ? '✅' : '❌'} ${label}` + (ok ? '' : `  期待=${expected} 実際=${actual}`));
  return ok;
}

/* 画面の文字を読む。
   直す前のコードには無い置き場所も見にいくので、
   見つからないときは待たずに空で返します（待って落ちると、
   そのあとの項目がまとめて確かめられなくなります）。 */
const text = (p, sel) => p.evaluate(s => {
  const el = document.querySelector(s);
  return el ? el.innerText : '';
}, sel);

async function newPhone(label) {
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    /* お客様のスマホは日本時間です。この機械の時間帯のままだと、
       受付期限のような「いま何時か」で変わる判定がずれます。 */
    timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  const p = await ctx.newPage();
  p.on('pageerror', e => jsErrors.push(`[${label}] ${e.message}`));
  return p;
}

/* この端末に残っている予約の記録（localStorage）を作る。
   予約ページを一通り操作するより速く、日付も自由に置けます。
   形は reserve.js の buildReservation に合わせています。 */
function record(over = {}) {
  return {
    code: 'LM-AAAA1', status: 'reserved', createdAt: new Date().toISOString(),
    date: day(4), time: '10:00', endTime: '11:00',
    staffId: 'st01', staffName: 'MATTEO',
    menus: [{ id: 'm1', name: 'メンズカット', price: 4000, minutes: 60 }],
    nominationFee: 0, totalPrice: 4000, totalLabel: '¥4,000', totalMinutes: 60,
    customer: { name: 'テスト太郎', tel: '09011112222', email: 't@example.com', visit: '初めて', request: '' },
    ...over
  };
}
const seedInto = (p, list) =>
  p.addInitScript(v => localStorage.setItem('salon.reservations.v1', v), JSON.stringify(list));

/* 店が電話で受けた予約を台帳に入れる（管理ページと同じ入り口）。
   別の端末から照会する試験は、台帳に実物が無いと始まりません。

   force を付けるのは、休業日や重なりの確認をここでは見たくないためです。
   試験用サーバーの休業日は他の試験が書き換えることがあり、そのままだと
   「この日は休みです」と断られて、確かめたいことに辿り着けません。 */
const addToLedger = async o => {
  const r = await post({ type: 'adminAdd', password: PW, minutes: 60, force: true, ...o });
  if (!r.ok) throw new Error(`台帳に予約を入れられませんでした（${r.error}）`);
  return r;
};

try {
/* 試験用サーバーを立ち上げっぱなしにしていると、前回の予約が残ります。
   照会の試験で別人の予約を引いてしまうので、まっさらから始めます。 */
await post({ type: 'reset' }).catch(() => {});

/* ============================================================
   MP1 夕方に開いた確認画面を、夜そのまま使う（この端末の予約）
   ============================================================ */
console.log('\n【MP1】受付期限（前日18時）をまたいで、画面を開いたままにする');
{
  /* スマホは、ほかの用事のあいだ画面をそのまま残します。
     17時50分に開いた画面を夜に見ると、期限を過ぎたご予約に
     「キャンセルする」「日時を変更する」が並んだままです。
     押せば店舗側で断られますが、それは押してみるまで分かりません。 */
  const p = await newPhone('MP1');
  await p.clock.install({ time: jstTime(day(0), '17:50:00') });
  await seedInto(p, [record({ date: day(1), code: 'LM-DEAD1' })]);
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);

  check('MP1', '期限前は日時変更を出している', await p.locator('[data-change]').count(), 1);
  check('MP1', '期限前はキャンセルを出している', await p.locator('[data-cancel]').count(), 1);

  await p.clock.fastForward('00:20:00');   // 18:10
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(600);

  check('MP1', '期限後は日時変更が消えている', await p.locator('[data-change]').count(), 0);
  check('MP1', '期限後はキャンセルが消えている', await p.locator('[data-cancel]').count(), 0);
  const txt = await text(p, '#upcoming-list');
  check('MP1', '期限を過ぎたことを書いている', /前日18時までです/.test(txt), true);
  check('MP1', '期限後の連絡先を出している', /080-4498-7036/.test(txt), true);
  check('MP1', 'ご予約そのものは消していない', await p.locator('.booking-card').count(), 1);
  await p.context().close();
}

/* ============================================================
   MP2 期限をまたいだ直後に、日時変更を押してしまう
   ============================================================ */
console.log('\n【MP2】期限を過ぎた直後に「日時を変更する」を押す');
{
  /* 見直しが入る前に押されることがあります。そのまま予約画面へ送ると、
     日時を選び直し、お名前と電話番号まで確かめた最後の最後で断られます。
     いちばん徒労なので、押した時点で止まってほしい。 */
  const p = await newPhone('MP2');
  let told = '';
  p.on('dialog', d => { told = d.message(); d.dismiss(); });
  // 期限（今日18時）の30秒前に開く。見直しは毎分なので、まだ走っていない
  await p.clock.install({ time: jstTime(day(0), '17:59:30') });
  await seedInto(p, [record({ date: day(1), code: 'LM-RACE1' })]);
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);
  await p.clock.fastForward('00:00:40');   // 18:00:10（見直しの前）

  check('MP2', '見直し前なのでボタンはまだ出ている', await p.locator('[data-change]').count(), 1);
  await p.locator('[data-change]').click();
  await p.waitForTimeout(600);
  check('MP2', '予約画面へは進ませない', /mypage\.html/.test(p.url()), true);
  check('MP2', '期限を過ぎたと伝えている', /前日18時まで/.test(told), true);
  check('MP2', '連絡先も添えている', /080-4498-7036/.test(told), true);
  check('MP2', '押せない見た目に直している', await p.locator('[data-change]').count(), 0);
  console.log('   お知らせ:', told.replace(/\n/g, ' ') || '（なし）');
  await p.context().close();
}

/* ============================================================
   MP3 台帳のほうが「期限切れ」と答えた（端末の時計がずれている）
   ============================================================ */
console.log('\n【MP3】端末の時計がずれていて、店舗の台帳に断られる');
{
  /* 画面の計算では期限内でも、台帳は期限切れと答えることがあります。
     断られたのに同じボタンが残っていると、お客様は何度でも押します。 */
  const add = await addToLedger({ date: day(0), time: '15:00', name: 'ずれ 太郎', tel: '09012340001', menu: 'メンズカット' });
  const p = await newPhone('MP3');
  const said = [];
  p.on('dialog', d => { said.push(d.message()); d.accept(); });
  // 端末の時計が2日遅れている＝画面の計算では、まだ期限内に見える
  await p.clock.install({ time: jstTime(day(-2), '12:00:00') });
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);
  await p.fill('#lookup-code', add.code);
  await p.fill('#lookup-tel', '09012340001');
  await p.click('#lookup-btn'); await p.waitForTimeout(1200);
  check('MP3', '画面の計算では、まだ押せる', await p.locator('[data-lookup-cancel]').count(), 1);

  await p.locator('[data-lookup-cancel]').click(); await p.waitForTimeout(1500);
  check('MP3', '台帳の断り文句をそのまま伝えている', /前日18時まで/.test(said.join('\n')), true);
  check('MP3', '断られたキャンセルは消している', await p.locator('[data-lookup-cancel]').count(), 0);
  check('MP3', '同じ理由の日時変更も消している', await p.locator('[data-change]').count(), 0);
  const after = await post({ type: 'lookup', code: add.code, tel: '09012340001' });
  check('MP3', '台帳はキャンセルされていない', after.reservation.status, '予約確定');
  await p.context().close();
}

/* ============================================================
   MP4 キャンセルが店舗に届かなかった
   ============================================================ */
console.log('\n【MP4】キャンセルを押したが、店舗に届かなかった');
{
  /* いちばん困るのは「できたつもり」です。画面だけキャンセル済みにすると、
     お客様は来ないのに席は空かず、店は無断キャンセルとして扱います。 */
  const okOne = await addToLedger({ date: day(5), time: '09:30', name: '通る 太郎', tel: '09011112222', menu: 'メンズカット' });
  const p = await newPhone('MP4');
  const said = [];
  p.on('dialog', d => { said.push(d.message()); d.accept(); });
  /* 2件持っている方です。1件目は通り、2件目で電波が切れます。
     1件目の「承りました」が残ったままだと、2件とも済んだと読めます。 */
  await seedInto(p, [
    record({ date: day(5), time: '09:30', endTime: '10:30', code: okOne.code }),
    record({ date: day(5), code: 'LM-FAIL1' })
  ]);
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);
  await p.locator(`[data-cancel="${okOne.code}"]`).click(); await p.waitForTimeout(1500);
  check('MP4', '1件目は承っている', await p.locator('#flash').isVisible(), true);

  await post({ type: 'failmode', on: true });
  await p.locator('[data-cancel="LM-FAIL1"]').click(); await p.waitForTimeout(2500);

  check('MP4', '送れなかったことを伝えている', /送信できませんでした/.test(said.join('\n')), true);
  check('MP4', 'やり直しの道を書いている', /もう一度お試し|店舗までご連絡/.test(said.join('\n')), true);
  check('MP4', '送れなかったほうは、キャンセル済みにしていない',
    await p.locator('.booking-card.is-cancelled').count(), 1);
  check('MP4', 'この端末の記録も書き換えていない',
    await p.evaluate(() => JSON.parse(localStorage.getItem('salon.reservations.v1'))
      .find(r => r.code === 'LM-FAIL1').status), 'reserved');
  check('MP4', '1件目の「承りました」を消している',
    await p.locator('#flash').isVisible(), false);
  check('MP4', 'もう一度押せる状態に戻している', await p.locator('[data-cancel]').isDisabled(), false);
  await post({ type: 'failmode', on: false });
  await p.context().close();
}

/* ============================================================
   MP5 通信が遅いあいだ、押せたのかどうか分かる
   ============================================================ */
console.log('\n【MP5】電波が細い場所でキャンセルを押す');
{
  /* 押しても何も変わらないと「効いていない」と読んで何度も押されます。
     そのあいだに画面を閉じられると、届いたかどうかも分かりません。 */
  await post({ type: 'slowmode', ms: 2500 });
  const p = await newPhone('MP5');
  p.on('dialog', d => d.accept());
  await seedInto(p, [record({ date: day(5), code: 'LM-SLOW1' })]);
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(2600);
  await p.locator('[data-cancel]').click(); await p.waitForTimeout(500);

  check('MP5', '送信中だと見せている', await text(p, '[data-cancel]'), '送信中…');
  check('MP5', '送信中は二度押しできない', await p.locator('[data-cancel]').isDisabled(), true);
  await p.waitForTimeout(3500);
  await post({ type: 'slowmode', ms: 0 });
  await p.context().close();
}

/* ============================================================
   MP6 キャンセルを承ったことが分かる
   ============================================================ */
console.log('\n【MP6】キャンセルしたあと、それで合っているのか分かる');
{
  /* キャンセルするとカードは「これからのご予約」から
     「過去・キャンセルのご予約」へ移ります。押した場所から消えるだけだと
     「効かなかった」とも「予約ごと消えた」とも読めます。 */
  const add = await addToLedger({ date: day(5), time: '11:00', name: '承り 太郎', tel: '09012340002', menu: 'メンズカット' });
  const p = await newPhone('MP6');
  p.on('dialog', d => d.accept());
  await seedInto(p, [record({ date: day(5), code: add.code,
    customer: { name: '承り 太郎', tel: '09012340002', email: '', visit: '初めて', request: '' } })]);
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);
  await p.locator('[data-cancel]').click(); await p.waitForTimeout(1500);

  check('MP6', '承ったことを言葉で伝えている', await p.locator('#flash').isVisible(), true);
  check('MP6', 'その文面が読める', /キャンセルを承りました/.test(await text(p, '#flash')), true);
  check('MP6', 'カードはキャンセル済みになっている',
    await p.locator('.booking-card.is-cancelled').count(), 1);
  check('MP6', 'キャンセル済みには操作ボタンを出さない',
    await p.locator('.booking-card.is-cancelled [data-cancel], .booking-card.is-cancelled [data-change]').count(), 0);
  const after = await post({ type: 'lookup', code: add.code, tel: '09012340002' });
  check('MP6', '店舗の台帳にも届いている', after.reservation.status, 'キャンセル');
  await p.context().close();
}

/* ============================================================
   MP7 照会したあと、電話番号の欄を触ってしまう
   ============================================================ */
console.log('\n【MP7】照会してから、電話番号の欄を消してキャンセルする');
{
  /* 照会が終わったあと、欄を消す方も、打ち直す方もいます。
     そのたびに「ご予約が確認できませんでした」と断られると、
     何が悪いのか分かりません。照会に使った番号で通してほしい。 */
  const add = await addToLedger({ date: day(6), time: '13:00', name: '書換 太郎', tel: '09012340003', menu: 'メンズカット' });
  const p = await newPhone('MP7');
  p.on('dialog', d => d.accept());
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);
  await p.fill('#lookup-code', add.code);
  await p.fill('#lookup-tel', '09012340003');
  await p.click('#lookup-btn'); await p.waitForTimeout(1200);
  await p.fill('#lookup-tel', '');   // お客様が消してしまった
  await p.locator('[data-lookup-cancel]').click(); await p.waitForTimeout(1500);

  const after = await post({ type: 'lookup', code: add.code, tel: '09012340003' });
  check('MP7', '照会に使った番号でキャンセルできている', after.reservation.status, 'キャンセル');
  check('MP7', '画面もキャンセル済みになっている',
    /キャンセル済み/.test(await text(p, '#lookup-result')), true);
  await p.context().close();
}

/* ============================================================
   MP8 全角で打つ／予約番号の欄で確定キーを押す
   ============================================================ */
console.log('\n【MP8】日本語入力のまま打ち、予約番号の欄で確定キーを押す');
{
  const add = await addToLedger({ date: day(6), time: '16:00', name: '全角 太郎', tel: '09012340004', menu: 'メンズカット' });
  const p = await newPhone('MP8');
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);
  await p.fill('#lookup-tel', '０９０ー１２３４ー０００４');
  await p.fill('#lookup-code', 'ＬＭー' + add.code.slice(3));
  /* 番号を打ったあと、そのまま確定キー（改行）を押す方がいます。
     電話番号の欄にしか反応が無いと、その方は何も起きない画面を見ます。 */
  await p.locator('#lookup-code').press('Enter');
  await p.waitForTimeout(1300);

  check('MP8', '予約番号の欄でも照会が始まる',
    (await text(p, '#lookup-result')).includes(add.code), true);
  check('MP8', '全角で打った電話番号も通る', await p.locator('#lookup-error').isVisible(), false);
  await p.context().close();
}

/* ============================================================
   MP9 番号が違う・機種変更で記録が無い（行き止まりを作らない）
   ============================================================ */
console.log('\n【MP9】番号が見つからない／この端末に記録が無い');
{
  const p = await newPhone('MP9');
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);

  const empty = await text(p, '#upcoming-list');
  check('MP9', '記録が無いことを書いている', /記録はありません/.test(empty), true);
  check('MP9', '照会の入り口へ案内している', /ご予約番号でお調べする/.test(empty), true);

  await p.fill('#lookup-code', 'LM-ZZZZZ');
  await p.fill('#lookup-tel', '09099990000');
  await p.click('#lookup-btn'); await p.waitForTimeout(1400);
  const err = await text(p, '#lookup-error');
  check('MP9', '見つからなかったと伝えている', /見つかりません/.test(err), true);
  check('MP9', '予約番号のありかを書いている', /メール|完了画面/.test(err), true);
  check('MP9', '連絡先で行き止まりを塞いでいる', /080-4498-7036/.test(err), true);

  /* 上の照会欄とすぐ下の絞り込み欄は、どちらも「予約番号」を打つ場所です。
     取り違えて絞り込み欄に打った方に「見つかりません」とだけ返すと、
     ご予約そのものが無いように読めます。 */
  await p.fill('#search-code', 'LM-ZZZZZ');
  await p.click('#search-btn'); await p.waitForTimeout(400);
  const filtered = await text(p, '#upcoming-list');
  check('MP9', '絞り込みは「この端末の中で」と断っている', /この端末の記録の中/.test(filtered), true);
  check('MP9', '絞り込み0件でも照会へ案内している', /ご予約番号でお調べする/.test(filtered), true);
  check('MP9', '過去側も絞り込み中だと分かる',
    /この端末の記録の中/.test(await text(p, '#past-list')), true);
  await p.context().close();
}

/* ============================================================
   MP10 受け口がまだ用意できていない
   ============================================================ */
console.log('\n【MP10】オンライン受付の準備が終わっていない状態で開く');
{
  /* 照会が使えないうえに連絡先も無いと、この端末に記録が無い方は
     そこで手が止まります。公開直後に必ず通る道です。 */
  const p = await newPhone('MP10');
  await p.route('**/data.js', async route => {
    const r = await route.fetch();
    const body = (await r.text()).replace(/reservationEndpoint: '[^']*'/, "reservationEndpoint: ''");
    route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body });
  });
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);
  const box = await text(p, '#lookup-box');
  check('MP10', '準備中であることを書いている', /準備が整い次第/.test(box), true);
  check('MP10', '連絡先を添えている', /080-4498-7036/.test(box), true);
  check('MP10', '一覧側も連絡先へ案内している',
    /080-4498-7036/.test(await text(p, '#upcoming-list')), true);
  await p.context().close();
}

/* ============================================================
   MP11 金額が決まっていないご予約
   ============================================================ */
console.log('\n【MP11】金額が決まっていないご予約を見る');
{
  /* カウンセリングでお見積りするメニューや、店が電話で受けて価格欄を
     空けたままの予約があります。そこで「¥0」と出すと無料だと読めます。 */
  const add = await addToLedger({ date: day(6), time: '18:00', name: '見積 太郎', tel: '09012340005', menu: 'メンズ縮毛矯正' });
  const p = await newPhone('MP11');
  await seedInto(p, [record({ code: 'LM-QUOTE', totalPrice: 0, totalLabel: '', date: day(5) })]);
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);
  const card = await text(p, '.booking-card');
  check('MP11', 'この端末の一覧で ¥0 と出さない', /¥0/.test(card), false);
  check('MP11', '「お見積り」と書いている', /お見積り/.test(card), true);

  await p.fill('#lookup-code', add.code);
  await p.fill('#lookup-tel', '09012340005');
  await p.click('#lookup-btn'); await p.waitForTimeout(1200);
  const look = await text(p, '#lookup-result');
  check('MP11', '照会結果でも ¥0 と出さない', /¥0/.test(look), false);
  check('MP11', '照会結果も「お見積り」', /お見積り/.test(look), true);
  await p.context().close();
}

/* ============================================================
   MP12 施術中に開く／過去とキャンセルの並び
   ============================================================ */
console.log('\n【MP12】施術中に開く／過去とキャンセル済みの見え方');
{
  const p = await newPhone('MP12');
  /* ご予約は10時〜11時。10時30分は、まだ席に座っている時間です。
     ここで「ご来店済み」に変えて「ご感想を書く」を出すのは早すぎます。 */
  await p.clock.install({ time: jstTime(day(0), '10:30:00') });
  await seedInto(p, [
    record({ code: 'LM-NOW01', date: day(0), time: '10:00', endTime: '11:00' }),
    record({ code: 'LM-OLD01', date: day(-5) }),
    record({ code: 'LM-CAN01', date: day(9), status: 'cancelled' })
  ]);
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);

  const up = await text(p, '#upcoming-list');
  check('MP12', '施術中はまだ「これからのご予約」に置く', /LM-NOW01/.test(up), true);
  check('MP12', '施術中に感想を求めない',
    await p.locator('#upcoming-list [data-review]').count(), 0);

  const past = await text(p, '#past-list');
  check('MP12', '済んだご予約は過去側にある', /LM-OLD01/.test(past), true);
  check('MP12', '済んだご予約には感想を書ける',
    await p.locator('#past-list [data-review]').count(), 1);
  check('MP12', 'キャンセル済みも過去側にある', /LM-CAN01/.test(past), true);
  check('MP12', 'キャンセル済みには感想を求めない',
    await p.locator('.booking-card.is-cancelled [data-review]').count(), 0);
  /* キャンセル済みはご来店日が先でも過去側に入ります。
     見出しが「過去のご予約」だけだと、来週のキャンセル分が読めません。 */
  check('MP12', '見出しがキャンセル分も含むと書いている',
    await p.locator('h2:has-text("過去・キャンセルのご予約")').count(), 1);
  check('MP12', '過去・キャンセルには変更もキャンセルも出さない',
    await p.locator('#past-list [data-change], #past-list [data-cancel]').count(), 0);
  await p.context().close();
}

/* ============================================================
   MP13 店が電話番号を変えた
   ============================================================ */
console.log('\n【MP13】店が管理ページから電話番号を変えた');
{
  /* 期限を過ぎたお客様が最後に頼るのが、このページの「お電話ください」です。
     ここが古い番号のままだと、そこで行き止まりになります。 */
  const before = (await post({ type: 'adminData', password: PW })).settings;
  const stamp = (await post({ type: 'adminData', password: PW })).stamps.settings;
  await post({ type: 'adminSave', password: PW, target: 'settings', stamp,
    rows: { ...before, '電話番号': '0297-00-1234' } });

  const p = await newPhone('MP13');
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1800);
  const note = await text(p, '#deadline-note');
  check('MP13', '変えた番号で案内している', /0297-00-1234/.test(note), true);
  check('MP13', '古い番号は残っていない', /080-4498-7036/.test(note), false);
  check('MP13', '押せる電話リンクになっている',
    await p.locator('#deadline-note a[href="tel:0297001234"]').count(), 1);
  await p.context().close();

  // あと片付け（ほかの試験が古い番号のまま動くと、原因の分からない失敗になる）
  await post({ type: 'adminSave', password: PW, target: 'settings',
    stamp: (await post({ type: 'adminData', password: PW })).stamps.settings, rows: before });
}

/* ============================================================
   MP14 幅390pxのスマホで操作する
   ============================================================ */
console.log('\n【MP14】幅390pxのスマホで、はみ出さずに押せる');
{
  const p = await newPhone('MP14');
  await seedInto(p, [
    record({ code: 'LM-W0001', date: day(5),
      customer: { name: 'テスト太郎', tel: '09011112222', email: '', visit: '初めて',
        request: 'サイドは短めで、トップは長さを残してお願いします' } }),
    record({ code: 'LM-W0002', date: day(-2) })
  ]);
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);

  const m = await p.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad = [];
    document.querySelectorAll('main button, main a.btn, main input, main .booking-card').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      if (r.left < -0.5 || r.right > w + 0.5) bad.push('はみ出し:' + (el.id || el.className));
      if (el.matches('button, a.btn, input') && r.height < 32) bad.push('小さすぎ:' + (el.id || el.className));
    });
    return { w, scrollW: document.documentElement.scrollWidth, bad };
  });
  check('MP14', '横スクロールが出ない', m.scrollW <= m.w, true);
  check('MP14', '押せない・はみ出す部品がない', m.bad.join(' / ') || 'なし', 'なし');

  // 実際に指で押せるか（画面外・重なりがあるとここで落ちる）
  await p.locator('[data-change]').click({ trial: true });
  await p.locator('[data-cancel]').click({ trial: true });
  await p.locator('[data-review]').click({ trial: true });
  check('MP14', '変更・キャンセル・感想がすべて押せる', true, true);
  await p.context().close();
}

/* ============================================================
   まとめ
   ============================================================ */
const ng = results.filter(r => !r.ok);
console.log('\n' + '='.repeat(52));
console.log(`確認 ${results.length} 項目 / 失敗 ${ng.length} 件`);
if (ng.length) ng.forEach(r => console.log(`  ❌ [${r.uc}] ${r.label}（期待=${r.expected} 実際=${r.actual}）`));
console.log('JSエラー:', jsErrors.length ? jsErrors : 'なし');
} finally {
  await br.close();
}

// 1件でも失敗したら、終了コードで知らせる（CIやスクリプトから使えるように）
if (results.some(r => !r.ok) || jsErrors.length) process.exitCode = 1;
