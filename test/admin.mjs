/* 管理ページの試験

   使うのは、50代の理容師がひとりで回している店の店主です。
   施術の合間に、片手でスマホを開いて見ます（390px）。
   「開いてすぐ今日が読めるか」「電話で受けた予約を入れられるか」
   「入れた結果が見えるか」を、実際の順番どおりに確かめます。

   使い方は ユースケース.md を参照。
   node test/mock-gas.mjs のあと node test/admin.mjs */
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const B = process.env.BASE || 'http://127.0.0.1:8820';
const PW = process.env.ADMIN_PW || 'test1234';
const post = b => fetch(B + '/exec', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(b) }).then(r => r.json());

/* 店主のスマホは日本時間です。この機械はUTCで動いているので、
   new Date() のままだと「今日」が1日ずれ、本日の予約が明日に見えます。 */
const jstToday = () => new Date(Date.now() + 9 * 3600e3);
const key = off => { const d = jstToday(); d.setUTCDate(d.getUTCDate() + off); return d.toISOString().slice(0, 10); };

const results = [];
const jsErrors = [];
function check(g, label, actual, expected) {
  const ok = String(actual) === String(expected);
  results.push({ g, label, ok, actual, expected });
  console.log(`   ${ok ? '✅' : '❌'} ${label}` + (ok ? '' : `  期待=${expected} 実際=${actual}`));
  return ok;
}

/* 途中で止まっても、残りの確認は続けます。
   直す前のコードでは、そもそも要る部品が無くて止まるためです。 */
async function group(name, fn) {
  console.log('\n' + name);
  try { await fn(); } catch (e) {
    const why = String(e.message || e).split('\n')[0];
    results.push({ g: name, label: '最後まで動かなかった', ok: false, actual: why, expected: '最後まで動く' });
    console.log('   ❌ 最後まで動かなかった — ' + why);
  }
}

const br = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

/* 店主のスマホ。片手・縦持ち・日本時間 */
async function newPhone(label) {
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  const p = await ctx.newPage();
  /* 無いものを待ち続けないように短くします（既定の30秒だと1件で試験が止まります） */
  p.setDefaultTimeout(5000);
  p.on('pageerror', e => jsErrors.push(`[${label}] ${e.message}`));
  p.__dialogs = [];
  p.__answer = 'dismiss';
  p.on('dialog', d => { p.__dialogs.push(d.message()); d[p.__answer === 'accept' ? 'accept' : 'dismiss'](); });
  return p;
}
/* 直前に出た確認・お知らせの文言 */
const lastDialog = p => p.__dialogs[p.__dialogs.length - 1] || '';

async function login(p) {
  await p.goto(B + '/admin.html'); await p.waitForTimeout(900);
  await p.fill('#passcode', PW);
  await p.locator('#remember-me').setChecked(false);
  await p.click('#gate-btn'); await p.waitForTimeout(1500);
}

const tab = (p, name) => p.locator('#admin-tabs .tab', { hasText: name }).first().click();

/* 店舗情報タブは、34項目を見出しで畳んであります。
   店主も試験も、まず見出しを押して開くところから始めます。 */
async function openSettingGroup(p, title) {
  await tab(p, '店舗情報'); await p.waitForTimeout(300);
  const head = p.locator('#setting-rows summary', { hasText: title }).first();
  // 押すたびに開閉するので、すでに開いていれば触りません（押すと畳んでしまいます）
  if (!await head.evaluate(el => el.parentElement.open)) {
    await head.click();
    await p.waitForTimeout(300);
  }
}
/** 店舗情報を保存して、受け口に入った内容を返す */
async function saveSettings(p) {
  await p.locator('[data-save="settings"]').click();
  await p.waitForTimeout(1500);
  return (await post({ type: 'adminData', password: PW })).settings || {};
}
/** お客様の画面を開いて、出ている文字をぜんぶ読む（見た目の作りに引きずられないように） */
async function visitorText(page, file) {
  await page.goto(B + '/' + file);
  await page.waitForTimeout(1200);
  return page.locator('body').innerText();
}

/* 台帳に1件入れる。電話で受けた予約と同じ入口を使います。
   画面から入れると時間がかかるうえ、予約ページの作りに引きずられるためです。 */
const add = o => post({ type: 'adminAdd', password: PW, force: true, minutes: 60, price: 4000, ...o });

/* 全角のまま打てるか。type=number の欄は受け取れずに例外になるので、
   「打てなかった」という結果として返します。 */
async function fillLoose(p, sel, value) {
  try { await p.fill(sel, value); } catch (e) { return false; }
  return (await p.inputValue(sel)) === value;
}

/** 画面の中に見えているか（下に隠れていないか）。無いものは「見えない」 */
const inView = async loc => await loc.count() ? loc.evaluate(el => {
  const r = el.getBoundingClientRect();
  return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
}) : false;
/** 無ければ空文字。直す前のコードでも、そこで止まらずに続けるため */
const textOf = async loc => await loc.count() ? (await loc.innerText()) : '';

try {
/* 前に流した試験の予約が残っていると、件数も並び順も変わります */
await post({ type: 'reset' });

/* ============================================================
   台帳を用意する。3か月前からの履歴があり、今日と先の予約が入っている、
   開店から半年ほど経った店の状態です。
   ============================================================ */
for (const off of [-90, -60, -30, -14, -7, -2]) {
  await add({ date: key(off), time: '10:00', name: '常連 一郎', tel: '09011112222', menu: 'カット' });
}
await add({ date: key(0), time: '14:00', name: '本日 太郎', tel: '09033334444', menu: 'カット' });
await add({ date: key(1), time: '11:00', name: '明日 次郎', tel: '09055556666', menu: 'カット＋顔そり' });
await add({ date: key(5), time: '09:00', name: '山田　三郎', tel: '09077778888', menu: 'カット' });
await add({ date: key(6), time: '16:00', name: 'ヤマモト 四郎', tel: '09099990000', menu: 'カラー' });
/* 家族で1つの番号を使う。理容室ではふつうにあります（固定電話・親子） */
await add({ date: key(7), time: '13:00', name: '田中 太郎', tel: '0297001111', menu: 'カット' });
await add({ date: key(8), time: '13:00', name: '田中 花子', tel: '0297-00-1111', menu: 'カラー', price: 6000 });
/* 電話番号を全角で控えた行。シートに直接書かれることもあります */
await add({ date: key(9), time: '10:00', name: '全角 五郎', tel: '０９０１１１１２２２２', menu: 'カット' });
/* キャンセルが混ざった日 */
const off1 = await add({ date: key(10), time: '15:00', name: 'キャンセル 六郎', tel: '09012341234', menu: 'カット' });
await post({ type: 'cancel', password: PW, code: off1.code });

const p = await newPhone('管理');
await login(p);

/* ============================================================
   【管1】朝いちばんに開いて、今日の予定を読む
   ============================================================ */
await group('【管1】朝いちばんに開いて、今日の予定を読む', async () => {
  const heads = await p.locator('#admin-rows .day-heading').allInnerTexts();
  check('管1', '一覧の先頭が本日になっている', /本日/.test(heads[0] || ''), true);
  /* 施術の合間に片手で開きます。指をひと送りしても今日が出てこないと、
     そこから何十回も送り続けることになります。
     （このサイトは scroll-behavior:smooth なので instant で送ります） */
  await p.evaluate(() => window.scrollTo({ top: window.innerHeight, behavior: 'instant' }));
  await p.waitForTimeout(400);
  check('管1', '本日の予定が指ひと送りで出る',
    await inView(p.locator('#admin-rows .day-heading', { hasText: '本日' }).first()), true);
  await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  // 過去は捨てるのではなく、押せば出る
  const pastBtn = p.locator('[data-toggle-past]');
  check('管1', '過去のご予約を開くボタンがある', await pastBtn.count(), 1);
  check('管1', 'ボタンに過去の件数が書いてある', /6/.test(await textOf(pastBtn.first())), true);
  if (await pastBtn.count()) { await pastBtn.first().click(); await p.waitForTimeout(400); }
  const heads2 = await p.locator('#admin-rows .day-heading').allInnerTexts();
  check('管1', '押すと過去の予約が出る', heads2.length > heads.length, true);
  const oldest = key(-90).split('-').map(Number);
  check('管1', '過去を出すと、いちばん古い日が先頭になる',
    (heads2[0] || '').includes(`${oldest[0]}年${oldest[1]}月${oldest[2]}日`), true);
  if (await pastBtn.count()) { await pastBtn.first().click(); await p.waitForTimeout(400); }
  check('管1', 'もう一度押すと畳める',
    (await p.locator('#admin-rows .day-heading').allInnerTexts()).length, heads.length);

  /* 台帳にあるのは 本日・+1・+5・+6（7日目まで）と、+7 以降。
     「今後7日間」に +7 の日が混ざると、その日ぶんの売上を先に数えてしまいます。 */
  const stats = (await p.locator('#stats').innerText()).replace(/\n/g, ' ');
  console.log('   統計:', stats);
  check('管1', '「今後7日間」が今日から7日ぶんになっている', /今後7日間 4件/.test(stats), true);
  check('管1', '本日のご予約が数えられている', /本日のご予約 1件/.test(stats), true);
  check('管1', 'キャンセルの件数が出ている', /キャンセル 1件/.test(stats), true);
});

/* ============================================================
   【管2】絞り込みと、何も出ないときの伝え方
   ============================================================ */
await group('【管2】絞り込みと、何も出ないときの伝え方', async () => {
  await p.fill('#filter-date', key(-30)); await p.waitForTimeout(400);
  check('管2', '過ぎた日を選べば、その日の予約は出る',
    await p.locator('#admin-rows .booking-card').count(), 1);

  await p.fill('#filter-date', key(11)); await p.waitForTimeout(400);
  const empty = await p.locator('#admin-rows').innerText();
  check('管2', '絞り込みで0件のとき、絞り込み中だと分かる', /条件/.test(empty), true);

  await p.click('#filter-reset'); await p.waitForTimeout(400);
  check('管2', '条件をクリアすると本日に戻る',
    /本日/.test((await p.locator('#admin-rows .day-heading').first().innerText())), true);

  // キャンセルだけの日は、件数の書き方でそれと分かる
  await p.fill('#filter-date', key(10)); await p.waitForTimeout(400);
  check('管2', 'キャンセルだけの日はそう書いてある',
    /キャンセル1件のみ/.test(await p.locator('#admin-rows .day-count').first().innerText()), true);
  await p.click('#filter-reset'); await p.waitForTimeout(300);
});

/* ============================================================
   【管3】お客様を探す（店主は全角で打ちます）
   ============================================================ */
await group('【管3】お客様を探す（店主は全角で打ちます）', async () => {
  await tab(p, 'お客様'); await p.waitForTimeout(400);
  const rows = () => p.locator('#customer-rows .booking-card').count();

  await p.fill('#customer-search', '０９０３３３３４４４４'); await p.waitForTimeout(300);
  check('管3', '全角の電話番号で探せる', await rows(), 1);

  await p.fill('#customer-search', '090-3333-4444'); await p.waitForTimeout(300);
  check('管3', 'ハイフン入りでも探せる', await rows(), 1);

  await p.fill('#customer-search', '山田 三郎'); await p.waitForTimeout(300);
  check('管3', '全角スペースのお名前を半角スペースで探せる', await rows(), 1);

  await p.fill('#customer-search', 'やまもと'); await p.waitForTimeout(300);
  check('管3', 'ひらがなでカタカナのお名前を探せる', await rows(), 1);

  await p.fill('#customer-search', ''); await p.waitForTimeout(300);
  const all = await p.locator('#customer-rows').innerText();
  check('管3', '電話番号を全角で控えた行もお客様に出る', /全角 五郎/.test(all), true);
});

/* ============================================================
   【管4】同じ電話番号のご家族
   ============================================================ */
await group('【管4】同じ電話番号のご家族', async () => {
  await p.fill('#customer-search', '田中 太郎'); await p.waitForTimeout(300);
  check('管4', '古いほうのお名前でも見つかる',
    await p.locator('#customer-rows .booking-card').count(), 1);
  const card = await textOf(p.locator('#customer-rows .booking-card').first());
  check('管4', 'この番号を使っているお名前が両方出る',
    /田中 太郎/.test(card) && /田中 花子/.test(card), true);

  const summary = p.locator('#customer-rows .customer-history summary').first();
  if (await summary.count()) { await summary.click(); await p.waitForTimeout(300); }
  const hist = await textOf(p.locator('#customer-rows .customer-history').first());
  check('管4', '履歴のどれが誰のご来店か分かる',
    /田中 太郎/.test(hist) && /田中 花子/.test(hist), true);
  await p.fill('#customer-search', ''); await p.waitForTimeout(300);
});

/* ============================================================
   【管5】電話で受けたご予約を入れる（店主は全角で打ちます）
   ============================================================ */
await group('【管5】電話で受けたご予約を入れる', async () => {
  await tab(p, '予約一覧'); await p.waitForTimeout(300);
  await p.click('#add-booking'); await p.waitForTimeout(300);
  await p.fill('#ab-date', key(12));
  await p.fill('#ab-time', '10:00');
  await p.fill('#ab-name', '電話 花子');
  check('管5', '電話番号を全角で打てる', await fillLoose(p, '#ab-tel', '０９０５５５５６６６６'), true);
  check('管5', '金額を全角で打てる', await fillLoose(p, '#ab-price', '４５００'), true);
  check('管5', '所要（分）を全角で打てる', await fillLoose(p, '#ab-minutes', '９０'), true);
  await p.click('#ab-save'); await p.waitForTimeout(1400);

  const led = (await post({ type: 'adminData', password: PW })).reservations;
  const row = led.find(r => r.name === '電話 花子') || {};
  check('管5', '電話番号が半角で台帳に入る', row.tel, '09055556666');
  check('管5', '金額が台帳に入る', row.price, 4500);
  check('管5', '所要90分ぶんの枠が押さえられる', row.endTime, '11:30');
  check('管5', '入れた結果が画面の中に見えている', await inView(p.locator('#add-result')), true);
  check('管5', '予約番号が伝えられている', /LM-/.test(await textOf(p.locator('#add-result'))), true);
});

/* ============================================================
   【管6】電話予約の打ち間違い
   ============================================================ */
await group('【管6】電話予約の打ち間違い', async () => {
  // 日付をスマホの目盛りで回して、去年に飛んでしまった
  await p.click('#add-booking'); await p.waitForTimeout(300);
  await p.fill('#ab-date', key(-40));
  await p.fill('#ab-time', '10:00');
  await p.fill('#ab-name', '打ち間違い 太郎');
  p.__answer = 'dismiss';
  await p.click('#ab-save'); await p.waitForTimeout(1000);
  check('管6', '過ぎた日付には確認が出る', /過ぎ|過去/.test(lastDialog(p)), true);
  const led = (await post({ type: 'adminData', password: PW })).reservations;
  check('管6', 'やめれば台帳に入らない', led.some(r => r.name === '打ち間違い 太郎'), false);

  /* 承知のうえで過ぎた日に入れることもあります（先週ぶんの記録など）。
     そのとき畳んだ過去側に入って消えると、入っていないと思って二重に入れます。 */
  if (await p.locator('#add-booking-form').isHidden()) { await p.click('#add-booking'); await p.waitForTimeout(300); }
  await p.fill('#ab-name', '先週の 分');
  p.__answer = 'accept';
  await p.click('#ab-save'); await p.waitForTimeout(1400);
  p.__answer = 'dismiss';
  check('管6', '承知で入れた過ぎた日の予約は、一覧にも出る',
    /先週の 分/.test(await textOf(p.locator('#admin-rows'))), true);

  // 所要が0や負の数だと、押さえる枠が消えるか逆さまになる
  if (await p.locator('#add-booking-form').isHidden()) { await p.click('#add-booking'); await p.waitForTimeout(300); }
  await p.fill('#ab-date', key(13));
  const typed = await fillLoose(p, '#ab-minutes', '-30');
  if (!typed) await p.locator('#ab-minutes').fill('-30').catch(() => {});
  await p.fill('#ab-name', '所要おかしい');
  await p.click('#ab-save'); await p.waitForTimeout(1000);
  const led2 = (await post({ type: 'adminData', password: PW })).reservations;
  const bad = led2.find(r => r.name === '所要おかしい');
  check('管6', '所要が0以下なら断る', !bad, true);
  check('管6', '断った理由が読める', /所要/.test(await textOf(p.locator('#ab-error'))), true);

  // 絞り込み中に、別の日の予約を入れた
  if (await p.locator('#add-booking-form').isHidden()) { await p.click('#add-booking'); await p.waitForTimeout(300); }
  await p.locator('#ab-minutes').fill('60');
  await p.locator('#ab-cancel').click(); await p.waitForTimeout(200);
  await p.fill('#filter-date', key(0)); await p.waitForTimeout(300);
  await p.click('#add-booking'); await p.waitForTimeout(300);
  await p.fill('#ab-date', key(14));
  await p.fill('#ab-time', '10:00');
  await p.fill('#ab-name', '別の日 次郎');
  await p.click('#ab-save'); await p.waitForTimeout(1400);
  const msg = await textOf(p.locator('#add-result'));
  check('管6', '絞り込み中で一覧に出ないことを伝えている', /絞り込|表示されていません|出ていません/.test(msg), true);
  await p.click('#filter-reset'); await p.waitForTimeout(300);
});

/* ============================================================
   【管7】お客様から当日キャンセルの電話が入る
   ============================================================ */
await group('【管7】お客様から当日キャンセルの電話が入る', async () => {
  await p.fill('#filter-date', key(0)); await p.waitForTimeout(400);
  p.__answer = 'accept';
  await p.locator('[data-admin-cancel]').first().click(); await p.waitForTimeout(1400);
  const told = lastDialog(p);
  console.log('   お知らせ:', told.replace(/\n/g, ' '));
  check('管7', '断られたとき、店として何をすればよいか分かる',
    /台帳|スプレッドシート|状態/.test(told), true);

  // 先の予約は、店からキャンセルできる
  await p.fill('#filter-date', key(7)); await p.waitForTimeout(400);
  await p.locator('[data-admin-cancel]').first().click(); await p.waitForTimeout(1800);
  check('管7', '先のご予約は店からキャンセルできる',
    await p.locator('#admin-rows .status-chip.is-cancelled').count(), 1);
});

/* ============================================================
   【管8】キャンセルは通ったが、読み直しで通信が切れた
   ============================================================ */
await group('【管8】キャンセルは通ったが、読み直しで通信が切れた', async () => {
  await p.route('**/exec', route => {
    const body = route.request().postData() || '';
    if (body.includes('"adminData"')) return route.abort('failed');
    return route.continue();
  });
  await p.fill('#filter-date', key(8)); await p.waitForTimeout(400);
  p.__dialogs.length = 0;
  p.__answer = 'accept';
  await p.locator('[data-admin-cancel]').first().click(); await p.waitForTimeout(1600);
  check('管8', '読み直せなかったことを黙っていない',
    p.__dialogs.length >= 2 && /読み込|通信/.test(lastDialog(p)), true);
  await p.unroute('**/exec');
  await p.click('#filter-reset'); await p.waitForTimeout(300);
});

/* ============================================================
   【管9】CSVを会計用に落とす
   ============================================================ */
await group('【管9】CSVを会計用に落とす', async () => {
  await p.evaluate(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { window.__csv = b; return orig(b); };
  });
  await p.click('#export-csv'); await p.waitForTimeout(600);
  const csv = await p.evaluate(() => window.__csv.text());
  /* text() は先頭のBOMを外して返すので、バイトのまま確かめます */
  const head = await p.evaluate(async () => [...new Uint8Array(await window.__csv.arrayBuffer())].slice(0, 3));
  check('管9', 'Excel用の目印（BOM）が付いている', head.join(','), '239,187,191');
  check('管9', '過去のご予約も落ちてくる', csv.includes(key(-90)), true);
  check('管9', 'キャンセルも状態つきで落ちてくる',
    /キャンセル 六郎[^\n]*キャンセル/.test(csv), true);
  const lines = csv.split('\r\n');
  check('管9', '1行目が見出し', lines[0].startsWith('"予約番号"'), true);
  check('管9', '列数が見出しとそろっている',
    lines.slice(1).every(l => !l || (l.match(/","/g) || []).length === 12), true);
});

/* ============================================================
   【管10】片手のスマホで押せるか
   ============================================================ */
await group('【管10】片手のスマホで押せるか', async () => {
  for (const name of ['予約一覧', 'お客様', '休業日', '単品メニュー', 'おすすめメニュー', '写真', '口コミ', '店舗情報']) {
    await tab(p, name); await p.waitForTimeout(250);
    const w = await p.evaluate(() => document.documentElement.scrollWidth);
    check('管10', `${name}タブが画面からはみ出さない`, w <= 390, true);
  }
  // タブの列に混じっている「記憶を消す」を、タブのつもりで押してしまう
  await tab(p, '予約一覧'); await p.waitForTimeout(200);
  p.__dialogs.length = 0;
  p.__answer = 'dismiss';
  await p.click('#forget-device'); await p.waitForTimeout(600);
  check('管10', '記憶を消す前に確認する', /記憶|パスワード/.test(lastDialog(p)), true);
  check('管10', 'やめれば画面はそのまま', await p.locator('#dashboard').isVisible(), true);
});

/* ============================================================
   【管11】まだ1件も予約が無い開店初日
   ============================================================ */
await group('【管11】まだ1件も予約が無い開店初日', async () => {
  await post({ type: 'reset' });
  /* 試験用サーバーは休業日を1日ぶん持ったまま立ち上がります。
     「1件も無い」状態を作るために外し、あとの試験のために戻します。 */
  const before = await post({ type: 'adminData', password: PW });
  await post({ type: 'adminSave', password: PW, target: 'closed', rows: [], stamp: before.stamps.closed });

  const q = await newPhone('開店初日');
  await login(q);
  const empty = await q.locator('#admin-rows').innerText();
  check('管11', '予約0件でも画面が出る', await q.locator('#dashboard').isVisible(), true);
  check('管11', '0件のときは絞り込みのせいだと誤解させない', /まだ/.test(empty), true);
  check('管11', '過去を開くボタンは出ない', await q.locator('[data-toggle-past]').count(), 0);
  check('管11', '統計が0件で出る', /0件/.test(await q.locator('#stats').innerText()), true);
  await tab(q, 'お客様'); await q.waitForTimeout(300);
  check('管11', 'お客様タブも空で壊れない',
    /ご予約が入ると/.test(await q.locator('#customer-rows').innerText()), true);
  await q.context().close();

  const now = await post({ type: 'adminData', password: PW });
  await post({ type: 'adminSave', password: PW, target: 'closed',
    rows: before.closedDates, stamp: now.stamps.closed });
});

/* ============================================================
   【管12】メニューを直す（一覧 → 押した1件だけ開く）

   作り替える前は、1件ぶんの入力欄（区分・メニュー名・価格・所要・説明・画像・表示）が
   件数ぶん縦に並んでいるだけでした。メニュー4件で単品メニュータブは
   縦2892px（ページ全体で3648px）、画面は844pxです。
   ・どんなメニューがあるのか、一覧では見えない
   ・カードの先頭が「区分」なので、何を編集中なのか2つ目の欄まで読まないと分からない
   ・保存がいちばん下にあるので、1件の値段を直すだけで長い往復になる
   使うのは50代の理容師で、施術の合間に片手でスマホを見ます。
   ============================================================ */
await group('【管12】メニューを直す（一覧→押した1件だけ開く）', async () => {
  await post({ type: 'reset' });        // シートを初期値（メニュー4件）に戻す
  const m = await newPhone('メニュー');
  await login(m);
  await tab(m, '単品メニュー'); await m.waitForTimeout(400);

  const rows = m.locator('#menu-rows .admin-row');
  const editor = m.locator('#menu-rows .admin-editor');
  const paneH = () => m.evaluate(() => Math.round(
    document.querySelector('.admin-pane[data-pane="menus"]').getBoundingClientRect().height));

  /* まず一覧。ここに全件が出ていないと、そもそも探せません。
     「表示」を外した行（旧メニュー）も出します。隠すと、消したつもりが無いのに
     消えたように見えて、同じメニューをもう1件作ってしまいます。 */
  check('管12', '一覧に全件（非表示のものも）出る', await rows.count(), 4);
  const listText = await textOf(m.locator('#menu-rows .admin-list'));
  check('管12', '非表示のメニューも一覧に残る', /旧メニュー/.test(listText), true);
  check('管12', '非表示だと分かる印が付く',
    await m.locator('#menu-rows .admin-row .admin-mark.is-off').count(), 1);

  /* 1行だけ見れば、それが何か分かること */
  const first = await textOf(rows.first());
  console.log('   一覧の1行目:', first.replace(/\n/g, ' / '));
  check('管12', '行の先頭がメニュー名', /^メンズカット/.test(first.trim()), true);
  check('管12', '行に値段が出ている', /¥4,000〜/.test(first), true);
  check('管12', '行に所要時間が出ている', /50分/.test(first), true);

  /* 開いているのは1件だけ。ここが崩れると元の3648pxに逆戻りします */
  check('管12', '入力欄は1件ぶんしか出ていない', await editor.count(), 1);
  check('管12', '開いた1件の名前が入力欄の先頭に出る',
    /メンズカット/.test(await textOf(m.locator('#menu-rows .admin-editor-title'))), true);

  // 3件目（炭酸スパ）を押す
  await rows.nth(2).click(); await m.waitForTimeout(500);
  check('管12', '押した1件が開く',
    /炭酸スパ/.test(await textOf(m.locator('#menu-rows .admin-editor-title'))), true);
  check('管12', '開くのはやはり1件だけ', await editor.count(), 1);
  check('管12', '開いた1件の入力欄に、その1件の値が入っている',
    await m.locator('#menu-rows input[data-col="メニュー名"]').inputValue(), '【シート追加】炭酸スパ');
  check('管12', '押した行だけ開いた印が付く',
    await m.locator('#menu-rows .admin-row.is-open').count(), 1);

  // 閉じれば一覧に戻る
  await m.locator('#menu-rows [data-close-editor]').first().click(); await m.waitForTimeout(400);
  check('管12', '閉じると入力欄が消えて一覧に戻る', await editor.count(), 0);
  check('管12', '閉じても一覧は全件そのまま', await rows.count(), 4);

  /* 一覧だけなら、直したい1件を画面1つぶんで見つけられること。
     直す前は、ここが2892pxありました（画面は844px）。 */
  const listOnly = await paneH();
  console.log('   一覧だけのときのタブの高さ:', listOnly + 'px（直す前 2892px）');
  check('管12', '一覧だけなら画面1つぶん（844px）に収まる', listOnly <= 844, true);

  // 1件開いた状態でも、全部を開いていた直す前より短いこと
  await rows.first().click(); await m.waitForTimeout(500);
  const openedH = await paneH();
  console.log('   1件開いたときのタブの高さ:', openedH + 'px（直す前 2892px）');
  check('管12', '1件開いても、直す前の全部開きより短い', openedH < 2892, true);

  await m.context().close();
});

/* ============================================================
   【管13】直したのに保存を押していない

   保存は「溜めておいて、保存ボタンで一括」です。1件直して一覧に戻ると
   画面が落ち着くので、そこで手が離れます。押さないまま閉じると、
   直した値段は消えて元のままになります。
   ============================================================ */
await group('【管13】直したのに保存を押していない', async () => {
  const m = await newPhone('未保存');
  await login(m);
  await tab(m, '単品メニュー'); await m.waitForTimeout(400);

  check('管13', '直す前は未保存の印が無い',
    await m.locator('#menu-rows .admin-mark.is-dirty').count(), 0);

  await m.locator('#menu-rows input[data-col="価格"]').first().fill('5500');
  await m.waitForTimeout(400);

  check('管13', '直すと、その行に未保存の印が出る',
    await m.locator('#menu-rows .admin-row .admin-mark.is-dirty').count(), 1);
  check('管13', '直していない行には印が出ない',
    await m.locator('#menu-rows .admin-row .admin-mark.is-dirty').count() < 4, true);
  check('管13', '保存していないことが文でも出る',
    /保存/.test(await textOf(m.locator('[data-note="menus"]'))), true);
  /* タブを離れても気づけること。別のタブに移ると、一覧の印は見えなくなります */
  check('管13', 'タブそのものにも印が付く',
    await m.locator('#admin-tabs .tab[data-pane="menus"].admin-tab-dirty').count(), 1);
  await tab(m, '写真'); await m.waitForTimeout(300);
  check('管13', '別のタブへ移っても、その印は残る',
    await m.locator('#admin-tabs .tab[data-pane="menus"].admin-tab-dirty').count(), 1);
  await tab(m, '単品メニュー'); await m.waitForTimeout(300);

  /* 保存ボタンは画面の下に貼り付いていて、どこまで送っても押せること。
     いちばん下に置いていたころは、1件直すだけで長い往復になりました。 */
  await m.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await m.waitForTimeout(300);
  check('管13', '一覧の先頭にいても保存ボタンが画面に見えている',
    await inView(m.locator('[data-save="menus"]')), true);

  await m.locator('[data-save="menus"]').click(); await m.waitForTimeout(1600);

  const saved = (await post({ type: 'adminData', password: PW })).menus || [];
  check('管13', '保存すると受け口に届く', String((saved[0] || {})['価格']), '5500');
  check('管13', '保存すると未保存の印が消える',
    await m.locator('#menu-rows .admin-mark.is-dirty').count(), 0);
  check('管13', '保存するとタブの印も消える',
    await m.locator('#admin-tabs .tab[data-pane="menus"].admin-tab-dirty').count(), 0);
  check('管13', '保存できたことが伝わる',
    /保存しました/.test(await textOf(m.locator('[data-note="menus"]'))), true);

  await m.context().close();
});

/* ============================================================
   【管14】メニューを足す・消す
   ============================================================ */
await group('【管14】メニューを足す・消す', async () => {
  const m = await newPhone('追加削除');
  await login(m);
  await tab(m, '単品メニュー'); await m.waitForTimeout(400);
  const rows = m.locator('#menu-rows .admin-row');

  await m.locator('[data-add="menus"]').click(); await m.waitForTimeout(500);
  check('管14', '足すと一覧が1件増える', await rows.count(), 5);
  check('管14', '足した1件が開いて、すぐ打てる',
    await m.locator('#menu-rows .admin-editor').count(), 1);
  check('管14', '名前が空でも一覧から消えない',
    /名前がまだ入っていません/.test(await textOf(m.locator('#menu-rows .admin-list'))), true);

  await m.locator('#menu-rows input[data-col="メニュー名"]').fill('眉カット');
  await m.waitForTimeout(400);
  check('管14', '打った名前が一覧にもすぐ出る',
    /眉カット/.test(await textOf(m.locator('#menu-rows .admin-list'))), true);

  /* 削除は確かめてから。指がすべって消えると、説明も写真も打ち直せません */
  m.__dialogs.length = 0;
  m.__answer = 'dismiss';
  await m.locator('#menu-rows [data-remove="menus"]').click(); await m.waitForTimeout(500);
  check('管14', '削除の前に確認が出る', /削除/.test(lastDialog(m)), true);
  check('管14', '何を消すのかが確認に書いてある', /眉カット/.test(lastDialog(m)), true);
  check('管14', 'やめれば消えない', await rows.count(), 5);

  m.__answer = 'accept';
  await m.locator('#menu-rows [data-remove="menus"]').click(); await m.waitForTimeout(500);
  m.__answer = 'dismiss';
  check('管14', 'はいを押せば消える', await rows.count(), 4);

  /* 元からあった1件を消したとき。保存を押すまでサイトは変わりません。
     ここで「消えた＝終わった」と思って画面を離れると、メニューは戻ります。 */
  m.__answer = 'accept';
  await rows.first().click(); await m.waitForTimeout(400);
  await m.locator('#menu-rows [data-remove="menus"]').click(); await m.waitForTimeout(500);
  m.__answer = 'dismiss';
  check('管14', '元からあった1件を消すと一覧から減る', await rows.count(), 3);
  check('管14', '消した時点ではまだ保存していないと分かる',
    /保存/.test(await textOf(m.locator('[data-note="menus"]'))), true);
  check('管14', '保存を押すまで受け口の中身は変わらない',
    ((await post({ type: 'adminData', password: PW })).menus || []).length, 4);

  await m.context().close();
});

/* ============================================================
   【管15】写真とおすすめメニューも、同じように直せる
   ============================================================ */
await group('【管15】写真とおすすめメニューも同じように直せる', async () => {
  const m = await newPhone('写真');
  await login(m);

  await tab(m, '写真'); await m.waitForTimeout(400);
  const srows = m.locator('#style-rows .admin-row');
  check('管15', '写真も全件（非表示のものも）一覧に出る', await srows.count(), 4);
  /* タイトルだけ並べても、どの写真のことか思い出せません */
  check('管15', '一覧に写真の見本が出る',
    await m.locator('#style-rows .admin-row-thumb img').count(), 2);
  check('管15', '写真が無い行も一覧に出る',
    await m.locator('#style-rows .admin-row-thumb:has-text("写真なし")').count(), 2);
  await srows.nth(1).click(); await m.waitForTimeout(500);
  check('管15', '押した1件だけ開く', await m.locator('#style-rows .admin-editor').count(), 1);
  check('管15', '開いたのは押した写真',
    await m.locator('#style-rows input[data-col="タイトル"]').inputValue(), 'スパイキーショート');

  await tab(m, 'おすすめメニュー'); await m.waitForTimeout(400);
  check('管15', 'おすすめメニューも一覧で出る',
    await m.locator('#coupon-rows .admin-row').count(), 2);
  check('管15', 'おすすめメニューも開くのは1件だけ',
    await m.locator('#coupon-rows .admin-editor').count(), 1);

  /* 片手のスマホ（390px）。1件開いた状態でも横に漏れないこと */
  for (const name of ['単品メニュー', 'おすすめメニュー', '写真']) {
    await tab(m, name); await m.waitForTimeout(300);
    check('管15', `${name}タブが、1件開いても横にはみ出さない`,
      await m.evaluate(() => document.documentElement.scrollWidth) <= 390, true);
  }
  await m.context().close();
  /* あと片付け。この試験でメニューの値段を書き換えたままにすると、
     次に流す試験が「サイトのせいではない失敗」を出します。 */
  await post({ type: 'reset' });
});

/* ============================================================
   【管17】カレンダーで、いつ予約が入っているかを見る

   店主の言葉：「予約画面みたいな感じで、視覚的にいつ予約入ってるか
   分かりやすく見たい」。ホットペッパーのサロンボードに慣れているので、
   お客様向けの空席カレンダーと同じ「横＝日付／縦＝時間」のマス目です。

   ここで確かめたいのは「読めるか」です。
   埋まっている所が埋まって見え、空いている所が空いて見えること。
   キャンセル済みを埋まったままにすると、その枠にお客様を入れられません。
   ============================================================ */
await group('【管17】カレンダーで、いつ予約が入っているかを見る', async () => {
  await post({ type: 'reset' });

  /* 休業日を、確かめたい2つの形で入れておきます。
     終日（出張）と、時間帯だけ（仕入れ）です。 */
  const before = await post({ type: 'adminData', password: PW });
  await post({ type: 'adminSave', password: PW, target: 'closed', stamp: before.stamps.closed, rows: [
    { '休業日': key(3), '開始': '', '終了': '', 'メモ': '' },
    { '休業日': key(2), '開始': '14:00', '終了': '16:00', 'メモ': '仕入れ' }
  ] });

  // 本日の90分。1枠（30分）では終わらないので、続きの枠まで埋まります
  await add({ date: key(0), time: '14:00', minutes: 90, name: '中村 太郎', tel: '09033334444', menu: 'カット＋カラー' });
  await add({ date: key(1), time: '11:00', name: '佐藤 次郎', tel: '09055556666', menu: 'カット' });
  await add({ date: key(-1), time: '10:00', name: '田村 四郎', tel: '09077778888', menu: 'カット' });
  // キャンセルされた1件。この枠は空いています
  const gone = await add({ date: key(5), time: '16:00', name: '高橋 三郎', tel: '09012341234', menu: 'カット' });
  await post({ type: 'cancel', password: PW, code: gone.code });

  const q = await newPhone('管17');
  await login(q);

  /* まだ何も選んでいない端末では一覧から始まります。
     電話を受けている最中に開くのがいちばん切実な使い方で、
     そのとき要るお名前・電話番号が並んでいるのは一覧のほうです。 */
  check('管17', '初めて開いた端末は一覧から始まる', await q.locator('#admin-rows').isVisible(), true);
  check('管17', 'カレンダーは畳まれている', await q.locator('#admin-calendar').isHidden(), true);

  const toCal = () => q.locator('#reserve-view .tab', { hasText: 'カレンダー' }).click();
  const toList = () => q.locator('#reserve-view .tab', { hasText: '一覧' }).click();
  const cell = (date, time) => q.locator(`#acal-body td[data-date="${date}"][data-time="${time}"]`);

  await toCal(); await q.waitForTimeout(400);
  check('管17', 'カレンダーに切り替えられる', await q.locator('#admin-calendar').isVisible(), true);

  // 予約が入っている時間のマスに、その予約が出る
  check('管17', '予約の時間のマスにお名前が出る',
    await textOf(cell(key(0), '14:00').locator('.cal-book')), '中村');
  check('管17', '施術が続く時間も埋まっている（90分は3枠）',
    await cell(key(0), '14:30').locator('.cal-book').count()
      + await cell(key(0), '15:00').locator('.cal-book').count(), 2);
  /* 続きのマスにお名前を繰り返さないこと。
     繰り返すと、縦に並んだお名前を何件と数えてよいのか分かりません。 */
  check('管17', '続きのマスにお名前は繰り返さない',
    await textOf(cell(key(0), '14:30').locator('.cal-book')), '');
  check('管17', '終わったあとの時間は空いている',
    await cell(key(0), '15:30').locator('.cal-book').count(), 0);
  check('管17', '空いているマスに「×」を並べない',
    /[×✕]/.test(await q.locator('#acal-body').innerText()), false);

  // キャンセル済みは「埋まっている」として描かない
  check('管17', 'キャンセル済みは埋まっているとして出ない',
    await cell(key(5), '16:00').locator('.cal-book').count(), 0);
  /* ただし消してもいけません。店主が「あれ、消えた？」と探すことになります。
     薄く取り消し線で、空いていることが分かる形にしてあります。 */
  check('管17', 'キャンセル済みは取り消し線で残る',
    await textOf(cell(key(5), '16:00').locator('.cal-off')), '高橋');
  check('管17', '取り消し線が実際に引かれている',
    /line-through/.test(await cell(key(5), '16:00').locator('.cal-off')
      .evaluate(el => getComputedStyle(el).textDecorationLine)), true);

  // 休業日・臨時休業の塗り分け
  const closedCells = await q.locator(`#acal-body td[data-date="${key(3)}"]`).count();
  check('管17', '終日お休みの日は、その列が全部塗られる',
    await q.locator(`#acal-body td[data-date="${key(3)}"].is-off`).count(), closedCells);
  check('管17', '時間帯だけのお休みも塗られる',
    await cell(key(2), '14:00').getAttribute('class'), 'is-off');
  check('管17', 'その手前の時間は塗らない',
    await cell(key(2), '13:30').getAttribute('class'), '');

  // 今日が一目で分かる
  check('管17', '今日の列に「本日」と出る',
    /本日/.test(await textOf(q.locator('#acal-head th.is-today'))), true);
  check('管17', '今日のマスにも印が付く',
    await cell(key(0), '09:00').getAttribute('class'), 'is-today');

  /* マスに出すのは姓だけ。カレンダーは施術中に開くので、
     お客様から画面が見えることがあります。 */
  const grid = await q.locator('#acal-body').innerText();
  check('管17', 'マスに電話番号を出さない', /\d{3}-?\d{4}|090|0297/.test(grid), false);
  check('管17', 'マスにメールを出さない', /@/.test(grid), false);

  // 片手のスマホ（390px）。横に送るのは表の中だけ
  check('管17', 'ページ本体が横にはみ出さない',
    await q.evaluate(() => document.documentElement.scrollWidth) <= 390, true);
  const scroll = await q.evaluate(() => {
    const s = document.querySelector('#admin-calendar .calendar-scroll');
    return { inner: s.scrollWidth > s.clientWidth, page: document.body.scrollWidth };
  });
  check('管17', '横に送るのは表の中だけ', scroll.inner, true);
  check('管17', '本体は揺れない', scroll.page <= 390, true);
  const box = await cell(key(0), '14:00').locator('.cal-book').boundingBox();
  check('管17', 'マスは指の幅（44px）以上', box.height >= 44, true);

  // 過ぎた日。薄くはするが、読めなくはしない
  await q.click('#acal-prev'); await q.waitForTimeout(300);
  check('管17', '前の7日に戻れる',
    await textOf(cell(key(-1), '10:00').locator('.cal-book')), '田村');
  check('管17', '過ぎた日は薄くする', await cell(key(-1), '10:00').getAttribute('class'), 'is-past');
  check('管17', 'ただし読めなくはしない',
    Number(await cell(key(-1), '10:00').evaluate(el => getComputedStyle(el).opacity)) >= .5, true);
  await q.click('#acal-next'); await q.waitForTimeout(300);

  /* マスを押したら、その予約の詳細（一覧のカード）まで送ります。
     マスの中に電話番号まで詰めると読めないので、詳細はカードに任せています。 */
  await cell(key(0), '14:00').locator('.cal-book').click();
  await q.waitForTimeout(500);
  const card = await textOf(q.locator('#admin-rows .booking-card.is-focus'));
  check('管17', '押した予約の詳細が出る', /中村 太郎/.test(card), true);
  check('管17', '詳細には電話番号も出る', /09033334444/.test(card), true);
  check('管17', '押すと一覧に戻る', await q.locator('#admin-rows').isVisible(), true);

  // 一覧とカレンダーを行き来できる（一覧は消えていない）
  await toCal(); await q.waitForTimeout(300);
  check('管17', 'またカレンダーに戻れる', await q.locator('#admin-calendar').isVisible(), true);
  await toList(); await q.waitForTimeout(300);
  check('管17', '一覧に戻ると予定が並んでいる',
    /中村 太郎/.test(await q.locator('#admin-rows').innerText()), true);
  check('管17', '一覧のときカレンダーは畳まれる', await q.locator('#admin-calendar').isHidden(), true);
  await q.context().close();

  /* 開店初日。予約が1件も無くても、格子だけは出て壊れないこと */
  await post({ type: 'reset' });
  const z = await newPhone('管17-開店初日');
  await login(z);
  await z.locator('#reserve-view .tab', { hasText: 'カレンダー' }).click();
  await z.waitForTimeout(400);
  check('管17', '予約0件でもカレンダーが出る', await z.locator('#admin-calendar').isVisible(), true);
  check('管17', '予約0件でも時間の目盛りは並ぶ',
    await z.locator('#acal-body tr').count() > 1, true);
  check('管17', '予約0件ならお名前は1つも出ない', await z.locator('#acal-body .cal-book').count(), 0);
  await z.context().close();

  // あと片付け。休業日を、この試験に入る前の状態に戻します
  const now = await post({ type: 'adminData', password: PW });
  await post({ type: 'adminSave', password: PW, target: 'closed',
    rows: before.closedDates, stamp: now.stamps.closed });
});

/* ============================================================
   管16 受け口がまだ読めていないとき、店主が前に進めるか

   実際に起きたこと：Apps Script の設置は済んでいたのに、ブラウザが
   古い data.js を握っていたため管理ページが「未設置」と判断し、
   パスワード欄を disabled にしました。設置した本人が
   「文字が入れられない」で止まりました。

   欄が死んでいる理由は案内文からは読み取れず、しかもその案内文
   （「設置してから使えます」）はこの状況では嘘です。
   ============================================================ */
await group('管16 受け口が読めていないとき', async () => {
  const p = await newPhone('管16');
  /* 設置前、または古い data.js を掴んだ状態を作る */
  await p.route('**/assets/js/data.js', async r => {
    const res = await r.fetch();
    const body = (await res.text()).replace(/reservationEndpoint: '[^']*'/, "reservationEndpoint: ''");
    await r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body });
  });
  await p.goto(B + '/admin.html'); await p.waitForTimeout(900);

  check('管16', 'パスワード欄は入力できる（理由が分からないまま固まらない）',
    await p.locator('#passcode').isDisabled(), false);
  check('管16', 'ログインボタンも押せる',
    await p.locator('#gate-btn').isDisabled(), false);

  /* 打てて、押せて、押したときに次にやることが分かること */
  await p.fill('#passcode', PW);
  check('管16', '打った文字が入る', await p.inputValue('#passcode'), PW);
  await p.click('#gate-btn'); await p.waitForTimeout(400);
  const err = await p.locator('#gate-error').innerText();
  check('管16', '押すと理由が出る', await p.locator('#gate-error').isVisible(), true);
  check('管16', 'まず読み込み直すよう伝えている', /読み込み直|Shift\+R/.test(err), true);
  check('管16', '未設置の可能性にも触れている', /設置/.test(err), true);
  /* 「設置がまだです」と言い切らないこと。設置済みの人を誤った方へ送ります */
  check('管16', '未設置と決めつけていない', /^この管理ページは、Google Apps Script を設置してから/.test(err), false);
  await p.context().close();
});

/* ============================================================
   管18 休業日を「終日」と「時間帯だけ」で取り違えない

   実際に起きたこと：店主が休業日を登録したのに、お客様の画面から
   その日が予約できてしまいました。原因は、開始・終了に時刻を入れると
   「その帯だけ止める」指定になり、日付そのものは選べたまま残るためです。
   入力欄が4つ並ぶだけの画面からは、この違いが読み取れませんでした。

   「休みにしたのに予約が入った」は、店にとっていちばん起きてはいけない
   事故なので、画面で先に休み方を選ばせ、選んだ結果を文で見せます。
   ============================================================ */
await group('管18 休業日の「終日」と「時間帯だけ」', async () => {
  const p = await newPhone('管18');
  await login(p);
  await tab(p, '休業日'); await p.waitForTimeout(500);

  await p.locator('[data-add="closed"]').first().click(); await p.waitForTimeout(400);
  const card = p.locator('#closed-rows .booking-card').first();

  check('管18', '休み方を選ばせている',
    await card.locator('[data-closed-mode]').count(), 2);
  check('管18', '既定は終日休み',
    await card.locator('[data-closed-mode][value="allday"]').isChecked(), true);
  /* 終日のあいだは時刻の欄そのものを出さない。
     出しておくと、入れたまま残って効いてしまいます。 */
  check('管18', '終日のときは時刻の欄を出さない',
    await card.locator('[data-col="開始"]').count(), 0);

  await card.locator('[data-col="休業日"]').fill(key(12)); await p.waitForTimeout(300);
  check('管18', '終日だと分かる文が出る',
    /終日お休み/.test(await card.innerText()), true);
  check('管18', 'お客様が選べなくなると書いてある',
    /選べません/.test(await card.innerText()), true);

  // 「時間帯だけ」に切り替えると、時刻の欄が出る
  await card.locator('[data-closed-mode][value="range"]').check(); await p.waitForTimeout(400);
  const card2 = p.locator('#closed-rows .booking-card').first();
  check('管18', '時間帯だけにすると時刻の欄が出る',
    await card2.locator('[data-col="開始"]').count(), 1);

  /* 初期値は営業時間そのものなので、実質は終日休みなのに
     お客様の画面には「選べる日」として残ります。ここを黙って通さない。 */
  check('管18', '営業時間を丸ごと覆う指定だと警告する',
    /丸ごと覆って/.test(await card2.innerText()), true);
  check('管18', '「選べる日として残る」と伝えている',
    /選べる日/.test(await card2.innerText()), true);
  check('管18', '終日休みを選び直すよう促している',
    /「終日休み」を選んで/.test(await card2.innerText()), true);

  // 一部だけの時間帯なら、他の時間は予約できると伝える
  await card2.locator('[data-col="開始"]').fill('14:00');
  await card2.locator('[data-col="終了"]').fill('16:00'); await p.waitForTimeout(300);
  const card3 = p.locator('#closed-rows .booking-card').first();
  check('管18', '一部の時間帯だと分かる文になる',
    /14:00〜16:00 だけ受け付けません/.test(await card3.innerText()), true);
  check('管18', '他の時間は予約できると伝えている',
    /他の時間は/.test(await card3.innerText()), true);
  check('管18', '丸ごと覆う警告は消えている',
    /丸ごと覆って/.test(await card3.innerText()), false);

  // 終日に戻したら、入れた時刻が残らない
  await card3.locator('[data-closed-mode][value="allday"]').check(); await p.waitForTimeout(400);
  check('管18', '終日に戻すと時刻が消える', await p.evaluate(
    () => !edits.closed[0]['開始'] && !edits.closed[0]['終了']), true);

  check('管18', '片手のスマホで横にはみ出さない',
    await p.evaluate(() => document.documentElement.scrollWidth) <= 390, true);
  await p.context().close();
  await post({ type: 'reset' });
});

/* ============================================================
   管19 予約の通知先を、店の人が自分で変えられる

   通知先はコードに直書きしてありました。変えるにはコードを貼り直して
   再デプロイが要ります。店の人にはできません。ところが宛先を変えたい
   場面は必ず来ます。作業者のアドレスから店のアドレスへ移すとき、
   従業員にも届けたいとき、機種変更でアドレスが変わったとき。
   どれも、その日のうちに直せないと予約が誰にも届きません。
   ============================================================ */
await group('管19 予約の通知先を店の人が変えられる', async () => {
  const p = await newPhone('管19');
  await login(p);
  await openSettingGroup(p, 'お知らせ・ご連絡先');

  const field = p.locator('[data-setting="通知先メール"]');
  check('管19', '通知先の欄が管理ページにある', await field.count(), 1);
  check('管19', 'いまの宛先が読める', await field.inputValue(), 'shop@example.com');
  /* 空にすると誰にも届かなくなる、という一番大事なことが書いてあるか */
  const box = p.locator('.form-field', { has: p.locator('[data-setting="通知先メール"]') }).first();
  check('管19', '空にすると届かないと書いてある',
    /誰にも届きません/.test(await box.innerText()), true);
  check('管19', '複数入れられると書いてある',
    /複数|カンマ/.test(await box.innerText()), true);

  // 2件に増やして保存できる
  await field.fill('tenshu@example.com, staff@example.com');
  await p.locator('[data-save="settings"]').click(); await p.waitForTimeout(1500);
  const saved = (await post({ type: 'adminData', password: PW })).settings || {};
  check('管19', '複数の宛先を保存できる',
    String(saved['通知先メール']), 'tenshu@example.com, staff@example.com');

  await p.context().close();
  await post({ type: 'reset' });
});

/* ============================================================
   管20 店舗情報タブから、目的の欄にたどり着けるか

   触れる項目を11から34に増やしました。そのまま縦に並べると、
   電話番号を直すのに住所も紹介文も通り過ぎることになり、
   片手のスマホ（390px）では目的の欄が見つかりません。
   見出しで畳んで、開いた最初の画面が目次になるようにしてあります。
   ============================================================ */
await group('管20 店舗情報タブから、目的の欄にたどり着けるか', async () => {
  const p = await newPhone('管20');
  await login(p);
  await tab(p, '店舗情報'); await p.waitForTimeout(500);

  const heads = p.locator('#setting-rows > details > summary');
  const n = await heads.count();
  console.log('   見出しの数:', n);
  check('管20', '見出しで区切ってある', n >= 6, true);

  /* 開いた直後に全部畳まれていること。1つでも開いていると、
     その中身が目次の下半分を押し出します。 */
  check('管20', '開いた直後は、どの見出しも畳まれている',
    await p.locator('#setting-rows > details[open]').count(), 0);
  /* 中の欄は、畳まれているあいだ触れない（＝見えていない）こと */
  check('管20', '畳んでいるあいだ、中の入力欄は出ていない',
    await p.locator('[data-setting="住所"]').isVisible(), false);

  const paneH = await p.evaluate(() => Math.round(
    document.querySelector('.admin-pane[data-pane="settings"]').getBoundingClientRect().height));
  console.log('   目次だけのときのタブの高さ:', paneH + 'px（画面は844px）');
  check('管20', '目次だけなら画面1つぶん（844px）に収まる', paneH <= 844, true);

  // 指で押せる大きさか
  const box = await heads.first().boundingBox();
  check('管20', '見出しは指の幅（44px）以上', box.height >= 44, true);

  // 押せば開き、もう一度押せば畳める
  await heads.nth(0).click(); await p.waitForTimeout(300);
  check('管20', '押すと開く', await p.locator('#setting-rows > details[open]').count(), 1);
  await heads.nth(0).click(); await p.waitForTimeout(300);
  check('管20', 'もう一度押すと畳める', await p.locator('#setting-rows > details[open]').count(), 0);

  /* 空欄にしたときどうなるかは欄ごとに違うので、欄ごとに書いてあること。
     タブの先頭にまとめて書くと、いま見ている欄がどちらか分かりません。 */
  await openSettingGroup(p, '場所・行き方');
  const addr = p.locator('.form-field', { has: p.locator('[data-setting="住所"]') }).first();
  check('管20', '消せる欄には「空欄にすると消えます」と書いてある',
    /空欄にすると、サイトから消えます/.test(await addr.innerText()), true);
  await openSettingGroup(p, '営業時間・ご予約の受付');
  const open = p.locator('.form-field', { has: p.locator('[data-setting="営業開始"]') }).first();
  check('管20', '消せない欄には「いまの内容のまま」と書いてある',
    /いま出ている内容のまま/.test(await open.innerText()), true);

  // 片手のスマホ。開いても畳んでも横に漏れない
  check('管20', '見出しを開いても横にはみ出さない',
    await p.evaluate(() => document.documentElement.scrollWidth) <= 390, true);

  /* 畳んだままだと、どの見出しの中を直したのか分かりません。 */
  await openSettingGroup(p, '場所・行き方');
  await p.locator('[data-setting="住所"]').fill('茨城県テスト市1-2-3');
  await p.waitForTimeout(400);
  const marks = await p.locator('#setting-rows [data-setting-mark]').allInnerTexts();
  check('管20', '直した見出しに印が付く', marks.filter(t => t.trim()).length, 1);
  check('管20', 'タブそのものにも印が付く',
    await p.locator('#admin-tabs .tab[data-pane="settings"].admin-tab-dirty').count(), 1);
  await saveSettings(p);
  check('管20', '保存すると見出しの印が消える',
    (await p.locator('#setting-rows [data-setting-mark]').allInnerTexts()).filter(t => t.trim()).length, 0);

  await p.context().close();
  await post({ type: 'reset' });
});

/* ============================================================
   管21 事業者名・代表者名・問い合わせ先を、店主が埋められるか

   ここはいま全部空です。お客様の氏名・電話番号・メールをお預かりするのに、
   誰が預かっているのかを書いていない状態です。コードの中にあるままだと、
   店主には埋められず、永久に空のままになります。
   ============================================================ */
await group('管21 事業者の情報を店主が埋められる', async () => {
  const p = await newPhone('管21');
  await login(p);
  await openSettingGroup(p, '事業者の情報');

  for (const key of ['事業者名', '代表者名', '問い合わせ先メール', 'プライバシーポリシー制定日']) {
    check('管21', `${key}の欄がある`, await p.locator(`[data-setting="${key}"]`).count(), 1);
  }
  await p.locator('[data-setting="事業者名"]').fill('ゼロウーノ理容室');
  await p.locator('[data-setting="代表者名"]').fill('山田 太郎');
  await p.locator('[data-setting="問い合わせ先メール"]').fill('info@example.com');
  await p.locator('[data-setting="プライバシーポリシー制定日"]').fill('2026年9月1日');
  const saved = await saveSettings(p);
  check('管21', '事業者名がシートに入る', saved['事業者名'], 'ゼロウーノ理容室');
  check('管21', '制定日がシートに入る', saved['プライバシーポリシー制定日'], '2026年9月1日');

  // お客様が見るページに、実際に出ること
  const v = await newPhone('管21-お客様');
  const text = await visitorText(v, 'privacy.html');
  check('管21', 'プライバシーポリシーに事業者名が出る', /ゼロウーノ理容室/.test(text), true);
  check('管21', '代表者名も出る', /山田 太郎/.test(text), true);
  check('管21', '問い合わせ先も出る', /info@example\.com/.test(text), true);
  check('管21', '制定日が「準備中」から変わる', /制定日：2026年9月1日/.test(text), true);
  await v.context().close();

  await p.context().close();
  await post({ type: 'reset' });
});

/* ============================================================
   管22 「準備中」の帯を、店主が自分で下ろせるか

   公開スイッチがコードの中にありました。つまり店主は、自分の店のサイトを
   自分で公開できませんでした。オン／オフと文言を管理ページから。
   ============================================================ */
await group('管22 「準備中」の帯を店主が下ろせる', async () => {
  const p = await newPhone('管22');
  await login(p);
  await openSettingGroup(p, 'サイトの公開');

  const sw = p.locator('[data-setting="準備中の帯"]');
  check('管22', '公開スイッチが管理ページにある', await sw.count(), 1);
  /* 「はい」「オン」「TRUE」と書かれるたびに読み方が増えるので、打たせない */
  check('管22', '打たせずに選ばせている',
    await sw.evaluate(el => el.tagName.toLowerCase()), 'select');

  const v = await newPhone('管22-お客様');
  check('管22', 'はじめは帯が出ている',
    /準備中/.test(await visitorText(v, 'mypage.html')), true);

  await sw.selectOption('出さない');
  await p.waitForTimeout(300);
  const saved = await saveSettings(p);
  check('管22', '「出さない」がシートに入る', saved['準備中の帯'], '出さない');
  check('管22', '帯が消える', /準備中/.test(await visitorText(v, 'mypage.html')), false);

  // 戻せること。文言も変えられること
  await sw.selectOption('出す');
  await p.locator('[data-setting="準備中の文言"]').fill('9月1日まで改装のためお休みします');
  await saveSettings(p);
  const back = await visitorText(v, 'mypage.html');
  check('管22', '「出す」に戻すと帯も戻る', /改装のためお休み/.test(back), true);

  await v.context().close();
  await p.context().close();
  await post({ type: 'reset' });
});

/* ============================================================
   管23 住所・支払い方法・こだわり条件・スタッフ紹介
   移転、PayPay導入、席を増やした、1年経って経験年数が変わった。
   どれも普通に起きることです。
   ============================================================ */
await group('管23 店舗情報とスタッフ紹介を書き換えられる', async () => {
  const p = await newPhone('管23');
  await login(p);

  await openSettingGroup(p, '場所・行き方');
  await p.locator('[data-setting="住所"]').fill('茨城県龍ケ崎市引越しました2-2-2');
  await p.locator('[data-setting="アクセス"]').fill('新しい最寄りはテスト駅から徒歩3分');
  await openSettingGroup(p, '店内・お支払い');
  await p.locator('[data-setting="支払い方法"]').fill('現金／PayPay／各種カード');
  await p.locator('[data-setting="席数"]').fill('セット面3席');
  await openSettingGroup(p, 'お店の紹介');
  /* こだわり条件に「PayPay」を入れないのは、下で支払い方法を空にしたとき、
     消えたかどうかを別の欄の文字で確かめてしまわないためです。 */
  await p.locator('[data-setting="こだわり条件"]').fill('駐車場あり\n完全予約制\nテスト条件です');
  await openSettingGroup(p, 'スタッフ紹介');
  await p.locator('[data-setting="スタッフの経験年数"]').fill('7');
  await p.locator('[data-setting="スタッフの得意分野"]').fill('メンズカット\nテスト技術');
  await p.locator('[data-setting="スタッフの紹介文"]').fill('入れ替えた紹介文です。');
  const saved = await saveSettings(p);
  check('管23', '住所がシートに入る', saved['住所'], '茨城県龍ケ崎市引越しました2-2-2');
  check('管23', 'こだわり条件がシートに入る（1行1件）',
    /テスト条件です/.test(String(saved['こだわり条件'])), true);

  const v = await newPhone('管23-お客様');
  const text = await visitorText(v, 'index.html');
  check('管23', '新しい住所がサイトに出る', /引越しました2-2-2/.test(text), true);
  check('管23', '新しいアクセスが出る', /テスト駅から徒歩3分/.test(text), true);
  check('管23', 'PayPay が支払い方法に出る', /PayPay/.test(text), true);
  check('管23', '席数が出る', /セット面3席/.test(text), true);
  check('管23', 'こだわり条件が出る（1行1件で並ぶ）', /テスト条件です/.test(text), true);
  check('管23', '経験年数が出る', /経験7年/.test(text), true);
  check('管23', 'スタッフの紹介文が出る', /入れ替えた紹介文です/.test(text), true);
  check('管23', '得意分野の札が出る', /テスト技術/.test(text), true);
  /* 消したいときは空欄。空欄にできないと、いちど入れた案内を消せません。 */
  await openSettingGroup(p, '店内・お支払い');
  await p.locator('[data-setting="支払い方法"]').fill('');
  await saveSettings(p);
  check('管23', '空欄にすれば、その項目はサイトから消える',
    /PayPay/.test(await visitorText(v, 'index.html')), false);

  await v.context().close();
  await p.context().close();
  await post({ type: 'reset' });
});

/* ============================================================
   管24 変更・キャンセルの受付期限

   ここは gas/Code.gs と画面の2か所に書いてあり、片方だけ変えられる
   状態でした。いまは設定シートが正で、画面も受け口も同じ行を読みます。
   （受け口側と同じ値になるかは test/settings.mjs で突き合わせています）
   ============================================================ */
await group('管24 受付期限を店主が変えられる', async () => {
  const p = await newPhone('管24');
  await login(p);
  await openSettingGroup(p, '営業時間・ご予約の受付');

  const v = await newPhone('管24-お客様');
  check('管24', 'はじめは前日18時と案内している',
    /前日18時まで/.test(await visitorText(v, 'mypage.html')), true);

  await p.locator('[data-setting="変更・キャンセル期限（何日前）"]').fill('2');
  await p.locator('[data-setting="変更・キャンセル期限（何時）"]').fill('12');
  const saved = await saveSettings(p);
  check('管24', '期限がシートに入る', String(saved['変更・キャンセル期限（何日前）']), '2');
  check('管24', 'お客様への案内も変わる',
    /2日前の12時まで/.test(await visitorText(v, 'mypage.html')), true);

  /* 打ち間違いで画面が壊れないこと。読めない値は掲載中の値に戻します。 */
  await p.locator('[data-setting="変更・キャンセル期限（何時）"]').fill('９９');
  await saveSettings(p);
  const bad = await visitorText(v, 'mypage.html');
  check('管24', 'ありえない値（99時）でも案内は壊れない', /99時/.test(bad), false);
  /* 読めなかったのは「何時」だけなので、そこだけ掲載中の18時に戻ります
     （「何日前」は店主が入れた2日前のまま） */
  check('管24', '読めない側だけ掲載中の値に戻る', /2日前の18時まで/.test(bad), true);

  await v.context().close();
  await p.context().close();
  await post({ type: 'reset' });
});

/* ============================================================
   管25 手で書く場所なので、壊れた値が来ます

   設定シートは店主が直接打つ場所です。全角、改行、記号、
   貼り付けそこねた長い文字列。1つ入っただけで画面が崩れてはいけません。
   ============================================================ */
await group('管25 壊れた値でも画面が壊れない', async () => {
  const p = await newPhone('管25');
  await login(p);

  const long = 'あ'.repeat(3000);
  const noBreak = 'https://example.com/' + 'x'.repeat(500);
  await openSettingGroup(p, 'お店の紹介');
  await p.locator('[data-setting="店の紹介文"]').fill(long);
  await p.locator('[data-setting="こだわり条件"]').fill(
    ['<script>alert(1)</script>', '＆＜＞"\'', '　', '', '★'.repeat(200)].join('\n'));
  await openSettingGroup(p, '場所・行き方');
  await p.locator('[data-setting="住所"]').fill(noBreak);
  await p.locator('[data-setting="道案内"]').fill('1行目\n2行目\n\n\n4行目');
  await openSettingGroup(p, 'スタッフ紹介');
  await p.locator('[data-setting="スタッフの経験年数"]').fill('６');   // 全角
  await saveSettings(p);

  check('管25', '壊れた値でも保存できる',
    /保存しました/.test(await textOf(p.locator('[data-note="settings"]'))), true);
  check('管25', '管理ページが横にはみ出さない',
    await p.evaluate(() => document.documentElement.scrollWidth) <= 390, true);

  const v = await newPhone('管25-お客様');
  const text = await visitorText(v, 'index.html');
  check('管25', 'お客様の画面が出る', text.length > 200, true);
  check('管25', '全角で打った経験年数も読める', /経験6年/.test(text), true);
  /* 書いた文字がそのまま「動く」ことがないこと */
  check('管25', '書き込まれた印が文字として出る', /<script>alert\(1\)<\/script>/.test(text), true);
  check('管25', 'お客様の画面が横にはみ出さない',
    await v.evaluate(() => document.documentElement.scrollWidth) <= 390, true);
  check('管25', '長すぎる文でも横にはみ出さない',
    await v.evaluate(() => document.body.scrollWidth) <= 390, true);
  await v.context().close();

  await p.context().close();
  await post({ type: 'reset' });
});

/* ============================================================
   まとめ
   ============================================================ */
const ng = results.filter(r => !r.ok);
console.log('\n' + '='.repeat(52));
console.log(`確認 ${results.length} 項目 / 失敗 ${ng.length} 件`);
if (ng.length) ng.forEach(r => console.log(`  ❌ [${r.g}] ${r.label}（期待=${r.expected} 実際=${r.actual}）`));
console.log('JSエラー:', jsErrors.length ? jsErrors : 'なし');
} finally {
  await br.close();
}

if (results.some(r => !r.ok) || jsErrors.length) process.exitCode = 1;
