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
