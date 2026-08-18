/* ユースケース試験
   実際の使われ方をそのまま順に再現する。
   1シナリオ = 1つの「誰が・何をして・どうなってほしいか」 */
/* Playwright の場所。
   ふつうは npm i -D playwright で入れた 'playwright' を使います。
   別の場所にある場合は PLAYWRIGHT に読み込み先を指定してください。 */
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const B = process.env.BASE || 'http://127.0.0.1:8820';
const PW = 'test1234';
const post = b => fetch(B + '/exec', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(b) }).then(r => r.json());
const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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

async function newPhone(label) {
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    /* お客様のスマホは日本時間です。この機械の時間帯のままだと、
       当日の締め切りのような「いま何時か」で変わる判定がずれます。 */
    timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  const p = await ctx.newPage();
  p.on('pageerror', e => jsErrors.push(`[${label}] ${e.message}`));
  return p;
}

/* お客様が1件予約する。使い回すのでまとめておく */
/* start を渡すと、そのURLから始めます（入口の印を付けたURLの確認に使います） */
async function book(p, { name, tel, menuIndex = 0, slotIndex = 0, start = '' }) {
  await p.goto(start || (B + '/reserve.html')); await p.waitForTimeout(1400);
  // 印付きのURLは予約ページ以外のこともあるので、そのときは移ってもらう
  if (start && !start.includes('reserve.html')) {
    await p.goto(B + '/reserve.html'); await p.waitForTimeout(1400);
  }
  await p.locator('#coupon-choices .selectable').nth(menuIndex).click(); await p.waitForTimeout(400);
  await p.locator('[data-next="2"]').first().click(); await p.waitForTimeout(700);
  await p.locator('[data-next="3"]').first().click(); await p.waitForTimeout(900);
  const slots = p.locator('button[data-date][data-time]:not([disabled])');
  const slot = slots.nth(slotIndex);
  const date = await slot.getAttribute('data-date');
  const time = await slot.getAttribute('data-time');
  await slot.click(); await p.waitForTimeout(400);
  await p.locator('[data-next="4"]').first().click(); await p.waitForTimeout(400);
  // 前回の入力を覚えている端末では入力欄が畳まれているので開く
  const saved = p.locator('#saved-profile');
  if (await saved.isVisible()) { await p.click('#profile-edit'); await p.waitForTimeout(200); }
  await p.fill('#f-name', name); await p.fill('#f-kana', 'テスト');
  await p.fill('#f-tel', tel); await p.fill('#f-email', 'test@example.com');
  await p.locator('label.radio-chip:has-text("初めて")').first().click();
  // 実際のお客様と同じく、文言のほう（ラベル）を押して同意する
  await p.locator('.checkbox-line > span').click();
  await p.locator('[data-next="5"]').first().click(); await p.waitForTimeout(600);
  await p.locator('#submit-reservation').click(); await p.waitForTimeout(1800);

  const code = (await p.locator('#done-code').innerText()).trim();
  if (!code) {
    // 予約が完了していない。原因が分かるように、その時点の画面を出す。
    const step = await p.evaluate(() =>
      [...document.querySelectorAll('.reserve-panel.is-active')].map(x => x.dataset.panel).join());
    throw new Error(`予約が完了しませんでした（${name} / ${date} ${time} / 表示中のSTEP=${step}）`);
  }
  return { code, date, time };
}

try {
/* 試験用サーバーを立ち上げっぱなしにしていると、前回の予約が残ります。
   空いているはずの時間が埋まって見え、サイトのせいではない失敗が出ます。
   まっさらから始めます。 */
await post({ type: 'reset' }).catch(() => {});

/* ============================================================
   UC1 はじめてのお客様が、料金を見てから予約する
   ============================================================ */
console.log('\n【UC1】はじめてのお客様が、料金を見てから予約する');
{
  const p = await newPhone('UC1');
  await p.goto(B + '/index.html'); await p.waitForTimeout(1400);
  check('UC1', 'トップから「メニュー」へ行ける', await p.locator('a[href="menu.html"]').count() > 0, true);
  await p.goto(B + '/menu.html'); await p.waitForTimeout(1400);
  check('UC1', '料金が読める', (await p.locator('.price-now').first().innerText()).includes('¥'), true);
  check('UC1', '所要時間が出ている', (await p.locator('.price-min').first().innerText()).includes('所要'), true);

  const r = await book(p, { name: '初回 太郎', tel: '09011110001' });
  check('UC1', '予約番号が発行される', /^LM-[A-Z0-9]{5}$/.test(r.code), true);
  check('UC1', '警告は出ていない', await p.locator('#done-warning').isVisible(), false);
  check('UC1', 'カレンダーに追加できる', await p.locator('#add-to-calendar').isVisible(), true);
  await p.context().close();
}

/* ============================================================
   UC2 予約したことを、あとで同じ端末から確認する
   ============================================================ */
console.log('\n【UC2】予約したことを、あとで同じ端末から確認する');
{
  const p = await newPhone('UC2');
  const r = await book(p, { name: '確認 花子', tel: '09011110002', slotIndex: 3 });
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1300);
  check('UC2', '予約が1件出ている', await p.locator('.booking-card').count(), 1);
  check('UC2', '予約番号が一致する', (await p.locator('.booking-code').first().innerText()).includes(r.code), true);
  check('UC2', '変更ボタンがある', await p.locator('[data-change]').count(), 1);
  await p.context().close();
}

/* ============================================================
   UC3 機種変更したので、別の端末から予約を確認する
   ============================================================ */
console.log('\n【UC3】別の端末から、予約番号と電話番号で確認する');
{
  const old = await newPhone('UC3-旧');
  const r = await book(old, { name: '機種 変更', tel: '09011110003', slotIndex: 6 });
  await old.context().close();

  const now = await newPhone('UC3-新');
  await now.goto(B + '/mypage.html'); await now.waitForTimeout(1300);
  check('UC3', 'この端末には何も残っていない', await now.locator('.booking-card').count(), 0);
  await now.fill('#lookup-code', r.code);
  await now.fill('#lookup-tel', '09011110003');
  await now.click('#lookup-btn'); await now.waitForTimeout(1600);
  check('UC3', '照会できる', await now.locator('#lookup-result .booking-card').count(), 1);

  // 電話番号が違えば見えない
  await now.fill('#lookup-tel', '09099999999');
  await now.click('#lookup-btn'); await now.waitForTimeout(1600);
  check('UC3', '電話番号が違うと見えない', await now.locator('#lookup-result .booking-card').count(), 0);
  await now.context().close();
}

/* ============================================================
   UC4 予定が変わったので日時だけ変更する
   ============================================================ */
console.log('\n【UC4】予定が変わったので日時だけ変更する');
{
  const p = await newPhone('UC4');
  const r = await book(p, { name: '変更 次郎', tel: '09011110004', slotIndex: 9 });
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1300);
  await p.locator('[data-change]').first().click(); await p.waitForTimeout(1700);

  const slots = p.locator('button[data-date][data-time]:not([disabled])');
  let picked = null;
  for (let i = 0; i < await slots.count(); i++) {
    const d = await slots.nth(i).getAttribute('data-date');
    const t = await slots.nth(i).getAttribute('data-time');
    if (d !== r.date || t !== r.time) { picked = { d, t }; await slots.nth(i).click(); break; }
  }
  await p.waitForTimeout(400);
  await p.locator('[data-next="4"]').first().click(); await p.waitForTimeout(700);
  check('UC4', 'お客様情報の入力を求められない', await p.locator('[data-panel="5"].is-active').count(), 1);
  await p.locator('#submit-reservation').click(); await p.waitForTimeout(1800);
  check('UC4', '予約番号は変わらない', (await p.locator('#done-code').innerText()).trim(), r.code);

  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1300);
  check('UC4', '新しい日時になっている',
    (await p.locator('.booking-when').first().innerText()).includes(picked.t), true);
  check('UC4', '予約は1件のまま（増えていない）', await p.locator('.booking-card').count(), 1);
  await p.context().close();
}

/* ============================================================
   UC5 行けなくなったのでキャンセルする
   ============================================================ */
console.log('\n【UC5】行けなくなったのでキャンセルする');
{
  const p = await newPhone('UC5');
  p.on('dialog', d => d.accept());
  const r = await book(p, { name: 'キャンセル 三郎', tel: '09011110005', slotIndex: 12 });
  await p.goto(B + '/mypage.html'); await p.waitForTimeout(1300);
  await p.locator('[data-cancel]').first().click(); await p.waitForTimeout(1800);
  check('UC5', 'キャンセル済みになる',
    (await p.locator('.status-chip').first().innerText()).includes('キャンセル'), true);

  const info = await post({ type: 'adminData', password: PW });
  const row = info.reservations.find(x => x.code === r.code);
  check('UC5', '台帳もキャンセルになっている', row && row.status, 'キャンセル');

  // 空いた枠がまた予約できる
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1400);
  const free = await p.evaluate(async ([d, t]) => {
    await Remote.load(true);
    return Availability.slotInfo(d, t, 'st01', 70).available;
  }, [r.date, r.time]);
  check('UC5', '空いた枠がまた予約できる', free, true);
  await p.context().close();
}

/* ============================================================
   UC6 来店後に感想を書き、店が承認して掲載される
   ============================================================ */
console.log('\n【UC6】来店後に感想を書き、店が承認して掲載される');
{
  const p = await newPhone('UC6');
  const r = await book(p, { name: '感想 四郎', tel: '09011110006', slotIndex: 15 });
  await post({ type: 'backdate', code: r.code });   // 来店済みにする

  await p.goto(B + '/reviews.html'); await p.waitForTimeout(1400);
  await p.fill('#rv-code', r.code);
  await p.fill('#rv-tel', '09011110006');
  await p.fill('#rv-nickname', 'S.Y');
  const MARK = 'UC6-' + Math.random().toString(36).slice(2, 8);
  await p.fill('#rv-body', `丁寧に切ってもらえました。（${MARK}）`);
  await p.click('#rv-submit'); await p.waitForTimeout(1700);
  check('UC6', 'お礼が出る', await p.locator('#review-thanks').isVisible(), true);

  await p.goto(B + '/reviews.html'); await p.waitForTimeout(1400);
  check('UC6', '承認前はサイトに出ない',
    (await p.locator('.review-body').allInnerTexts()).some(t => t.includes(MARK)), false);

  const a = await newPhone('UC6-店');
  await a.goto(B + '/admin.html'); await a.waitForTimeout(900);
  await a.fill('#passcode', PW); await a.locator('#remember-me').setChecked(false);
  await a.click('#gate-btn'); await a.waitForTimeout(1700);
  await a.locator('.tab[data-pane="reviews"]').click(); await a.waitForTimeout(600);
  check('UC6', '店に届いている', await a.locator('#review-rows .booking-card').count() > 0, true);
  await a.locator('#review-rows .booking-card').last().locator('label:has-text("掲載中")').click();
  await a.locator('[data-save="reviews"]').click(); await a.waitForTimeout(1600);

  await p.goto(B + '/reviews.html'); await p.waitForTimeout(1500);
  check('UC6', '承認後はサイトに出る',
    (await p.locator('.review-body').allInnerTexts()).some(t => t.includes(MARK)), true);
  await p.context().close(); await a.context().close();
}

/* ============================================================
   UC7 店主が、急に明日を休みにする
   ============================================================ */
console.log('\n【UC7】店主が、急に明日を休みにする');
{
  const t = new Date(); t.setDate(t.getDate() + 5);
  const day = key(t);
  const a = await newPhone('UC7-店');
  await a.goto(B + '/admin.html'); await a.waitForTimeout(900);
  await a.fill('#passcode', PW); await a.locator('#remember-me').setChecked(false);
  await a.click('#gate-btn'); await a.waitForTimeout(1700);
  await a.locator('.tab[data-pane="closed"]').click(); await a.waitForTimeout(500);
  await a.locator('[data-add="closed"]').click(); await a.waitForTimeout(400);
  await a.locator('#closed-rows input[data-col="休業日"]').last().fill(day);
  await a.locator('[data-save="closed"]').click(); await a.waitForTimeout(1600);
  check('UC7', '保存できた', (await a.locator('#save-ok').innerText()).includes('保存'), true);

  const p = await newPhone('UC7-客');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1500);
  const closed = await p.evaluate(d => !Availability.isBookableDate(d), day);
  check('UC7', 'その日は予約できなくなる', closed, true);
  await a.context().close(); await p.context().close();
}

/* ============================================================
   UC8 店主が、メニューの値段を変える
   ============================================================ */
console.log('\n【UC8】店主が、メニューの値段を変える');
{
  const a = await newPhone('UC8-店');
  await a.goto(B + '/admin.html'); await a.waitForTimeout(900);
  await a.fill('#passcode', PW); await a.locator('#remember-me').setChecked(false);
  await a.click('#gate-btn'); await a.waitForTimeout(1700);
  await a.locator('.tab[data-pane="menus"]').click(); await a.waitForTimeout(500);
  await a.locator('#menu-rows input[data-col="価格"]').first().fill('5500');
  await a.locator('[data-save="menus"]').click(); await a.waitForTimeout(1600);

  const p = await newPhone('UC8-客');
  await p.goto(B + '/menu.html'); await p.waitForTimeout(1500);
  check('UC8', 'サイトの値段が変わる',
    (await p.locator('.menu-row-price').allInnerTexts()).some(t => t.includes('5,500')), true);
  await a.context().close(); await p.context().close();
}

/* ============================================================
   UC9 2人が同時に同じ枠を取ろうとする
   ============================================================ */
console.log('\n【UC9】2人が同時に同じ枠を取ろうとする');
{
  const t = new Date(); t.setDate(t.getDate() + 30);
  const mk = (code, tel) => ({
    type: 'reserve', code, date: key(t), time: '15:00', endTime: '16:10', totalMinutes: 70,
    menus: [{ name: 'テスト' }], staffId: 'st01', staffName: 'MATTEO', nominationFee: 0,
    totalPrice: 6900, createdAt: new Date().toISOString(),
    customer: { name: '同時', kana: 'ドウジ', tel, email: 'a@b.c', visit: '初めて', request: '' }
  });
  const [x, y] = await Promise.all([post(mk('LM-UC901', '09011110009')), post(mk('LM-UC902', '09011110010'))]);
  check('UC9', '通るのは1件だけ', [x, y].filter(v => v.ok).length, 1);
  check('UC9', '断られた側に理由が返る', [x, y].find(v => !v.ok).taken, true);
}

/* ============================================================
   UC10 期限を過ぎてからキャンセルしようとする
   ============================================================ */
console.log('\n【UC10】期限を過ぎてからキャンセルしようとする');
{
  const today = key(new Date());
  /* 当日の予約は、何時のものでも受付期限（前日18時）を過ぎています。
     お客様の受け口からは当日の直前2時間ぶんを受けないので、
     ここは店が電話で受けた予約として入れます。何時に試験を流しても作れます。 */
  const made = await post({ type: 'adminAdd', password: PW, force: true,
    date: today, time: '21:00', minutes: 20, name: '期限 五郎', tel: '09011110011', price: 4000 });
  const res = await post({ type: 'cancel', code: made.code, tel: '09011110011' });
  check('UC10', 'キャンセルは断られる', res.ok, false);
  check('UC10', '電話するよう案内される', String(res.error).includes('店舗までご連絡'), true);
}

/* ============================================================
   UC11 店が予約一覧を見て、電話で受けた分をキャンセルにする
   ============================================================ */
console.log('\n【UC11】店が予約一覧を見て、キャンセル扱いにする');
{
  const p = await newPhone('UC11-客');
  const r = await book(p, { name: '電話 六郎', tel: '09011110012', slotIndex: 18 });
  await p.context().close();

  const a = await newPhone('UC11-店');
  a.on('dialog', d => d.accept());
  await a.goto(B + '/admin.html'); await a.waitForTimeout(900);
  await a.fill('#passcode', PW); await a.locator('#remember-me').setChecked(false);
  await a.click('#gate-btn'); await a.waitForTimeout(1700);
  check('UC11', '予約一覧に出ている',
    !!r.code && (await a.locator('#admin-rows').innerText()).includes(r.code), true);
  await a.locator(`[data-admin-cancel="${r.code}"]`).click(); await a.waitForTimeout(2000);
  const info = await post({ type: 'adminData', password: PW });
  check('UC11', '台帳がキャンセルになる',
    (info.reservations.find(x => x.code === r.code) || {}).status, 'キャンセル');
  await a.context().close();
}

/* ============================================================
   UC12 通信が切れて、店に届かなかった
   ============================================================ */
console.log('\n【UC12】通信が切れて、店に届かなかった');
{
  await post({ type: 'failmode', on: true });
  const p = await newPhone('UC12');
  const r = await book(p, { name: '不通 七郎', tel: '09011110013', slotIndex: 21 });
  check('UC12', '「完了しました」で終わらせない', await p.locator('#done-warning').isVisible(), true);
  check('UC12', '連絡するよう案内される',
    (await p.locator('#done-warning').innerText()).includes('ご連絡'), true);
  check('UC12', '予約番号は控えられる', /^LM-/.test(r.code), true);
  await post({ type: 'failmode', on: false });
  await p.context().close();
}

/* ============================================================
   UC13 2回目のお客様が、LINEから来て入力せずに予約する
   ============================================================ */
console.log('\n【UC13】2回目のお客様が、前回の入力のまま予約する');
{
  const p = await newPhone('UC13');
  await book(p, { name: '常連 八郎', tel: '09011110014', slotIndex: 24 });

  // LINEのメッセージから予約ページを開いた想定（同じ端末・同じブラウザ）
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1400);
  await p.locator('#coupon-choices .selectable').nth(1).click(); await p.waitForTimeout(400);
  await p.locator('[data-next="2"]').first().click(); await p.waitForTimeout(700);
  await p.locator('[data-next="3"]').first().click(); await p.waitForTimeout(900);
  await p.locator('button[data-date][data-time]:not([disabled])').nth(27).click(); await p.waitForTimeout(400);
  await p.locator('[data-next="4"]').first().click(); await p.waitForTimeout(500);

  check('UC13', '前回の内容が出ている', await p.locator('#saved-profile').isVisible(), true);
  const card = await p.locator('#saved-profile-body').innerText();
  check('UC13', '名前が入っている', card.includes('常連 八郎'), true);
  check('UC13', '電話番号が入っている', card.includes('09011110014'), true);
  check('UC13', '名前の入力欄は畳まれている', await p.locator('#f-name').isVisible(), false);
  check('UC13', '来店回数が2回目以降になっている',
    await p.locator('input[name="visit"][value="2回目以降"]').isChecked(), true);
  check('UC13', 'それでも同意チェックは自分で押す', await p.locator('#f-agree').isChecked(), false);

  // 同意だけ押して、そのまま予約できる
  await p.locator('.checkbox-line > span').click();
  check('UC13', '同意チェックが入る', await p.locator('#f-agree').isChecked(), true);
  await p.locator('[data-next="5"]').first().click(); await p.waitForTimeout(700);
  check('UC13', '入力し直さずに確認へ進める',
    (await p.locator('#confirm-body').innerText()).includes('常連 八郎'), true);
  await p.locator('#submit-reservation').click(); await p.waitForTimeout(1900);
  check('UC13', '2件目が取れる', /^LM-[A-Z0-9]{5}$/.test((await p.locator('#done-code').innerText()).trim()), true);

  // 「この端末から消す」で本当に消える
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1400);
  await p.locator('#coupon-choices .selectable').nth(1).click(); await p.waitForTimeout(300);
  await p.locator('[data-next="2"]').first().click(); await p.waitForTimeout(600);
  await p.locator('[data-next="3"]').first().click(); await p.waitForTimeout(800);
  await p.locator('button[data-date][data-time]:not([disabled])').nth(30).click(); await p.waitForTimeout(300);
  await p.locator('[data-next="4"]').first().click(); await p.waitForTimeout(400);
  await p.click('#profile-clear'); await p.waitForTimeout(300);
  check('UC13', '消したら入力欄に戻る', await p.locator('#f-name').isVisible(), true);
  check('UC13', '消したら名前も残らない', await p.inputValue('#f-name'), '');
  await p.reload(); await p.waitForTimeout(1400);
  check('UC13', '開き直しても戻ってこない',
    await p.evaluate(() => localStorage.getItem('salon.customer.v1')), 'null');
  await p.context().close();
}

/* ============================================================
   UC14 LINE公式アカウントを開設し、店がその日のうちに反映する
   ============================================================ */
console.log('\n【UC14】LINEを開設し、店がコードを触らずに反映する');
{
  const p = await newPhone('UC14');
  await p.goto(B + '/index.html'); await p.waitForTimeout(1300);
  check('UC14', '入れる前は案内が出ていない',
    await p.locator('.site-footer a[href*="lin.ee"]').count(), 0);

  // 店が管理ページの「店舗情報」からURLを貼る
  const a = await newPhone('UC14-店');
  await a.goto(B + '/admin.html'); await a.waitForTimeout(900);
  await a.fill('#passcode', PW); await a.locator('#remember-me').setChecked(false);
  await a.click('#gate-btn'); await a.waitForTimeout(1700);
  await a.locator('.tab', { hasText: '店舗情報' }).first().click(); await a.waitForTimeout(500);
  /* 店舗情報タブは項目が多いので、見出しで畳んであります。押して開いてから触ります */
  await a.locator('#setting-rows summary', { hasText: 'お知らせ・ご連絡先' }).first().click();
  await a.waitForTimeout(400);
  await a.fill('[data-setting="LINE友だち追加URL"]', 'https://lin.ee/zer01test');
  await a.locator('[data-save="settings"]').first().click(); await a.waitForTimeout(1800);
  check('UC14', 'コードを触らずに保存できる',
    ((await post({ type: 'adminData', password: PW })).settings || {})['LINE友だち追加URL'],
    'https://lin.ee/zer01test');
  await a.context().close();

  await p.reload(); await p.waitForTimeout(1500);
  check('UC14', '貼った直後からサイトに出る',
    await p.locator('.site-footer a[href="https://lin.ee/zer01test"]').count(), 1);

  // おかしなURLは受け取らない（押した人を思わぬ場所へ飛ばさない）
  const b2 = await newPhone('UC14-悪い値');
  await b2.goto(B + '/admin.html'); await b2.waitForTimeout(900);
  await b2.fill('#passcode', PW); await b2.locator('#remember-me').setChecked(false);
  await b2.click('#gate-btn'); await b2.waitForTimeout(1700);
  await b2.locator('.tab', { hasText: '店舗情報' }).first().click(); await b2.waitForTimeout(500);
  await b2.locator('#setting-rows summary', { hasText: 'お知らせ・ご連絡先' }).first().click();
  await b2.waitForTimeout(400);
  await b2.fill('[data-setting="LINE友だち追加URL"]', 'javascript:alert(1)');
  await b2.locator('[data-save="settings"]').first().click(); await b2.waitForTimeout(1800);
  await b2.context().close();

  await p.reload(); await p.waitForTimeout(1500);
  /* 見るのは「空になること」ではなく「危ない値が採用されないこと」です。
     data.js に控えのURLを置いたので、弾かれたときに残るのは
     こちらが用意した https のURLになります（設定シートの値は捨てられます）。 */
  const bad = await p.evaluate(() => SALON.lineAddUrl);
  check('UC14', 'https以外のURLは採用しない', bad === '' || /^https:\/\//.test(bad), true);
  check('UC14', '打ち込まれた値が残らない', /javascript/i.test(bad), false);
  check('UC14', '変なリンクがサイトに出ない',
    await p.locator('.site-footer a[href^="javascript:"]').count(), 0);

  /* 空欄にしたら、控えのURLごと消えること。

     data.js に控えを置いたぶん、ここが効かないと
     「LINEをやめたのに、サイトの案内だけ残り続ける」状態になります。
     店主は管理ページで空にしたのに消えない、という形なので、
     自分では直せません。控えを置いた日から、これは必ず見ます。 */
  /* 設定の保存には「印」が要ります（別端末との上書きを防ぐため）。
     前は渡し忘れていて、保存が黙って断られたまま「控えが消えない」と
     判定していました。製品のバグではなく、この試験のバグでした。 */
  const cur = await post({ type: 'adminData', password: PW });
  const cleared = await post({ type: 'adminSave', password: PW, target: 'settings',
    stamp: cur.stamps.settings, rows: { ...cur.settings, 'LINE友だち追加URL': '' } });
  check('UC14', '空欄の保存が通る', cleared.ok, true);
  await p.reload(); await p.waitForTimeout(1500);
  check('UC14', '空欄にすれば、控えのURLごと案内を消せる',
    await p.evaluate(() => SALON.lineAddUrl), '');
  check('UC14', '消したあとはフッターにも出ない',
    await p.locator('.site-footer a[href*="line.me"], .site-footer a[href*="lin.ee"]').count(), 0);
  await p.context().close();

  // あと片付け（この先の試験に影響させない）
  const fin = await post({ type: 'adminData', password: PW });
  await post({ type: 'adminSave', password: PW, target: 'settings',
    stamp: fin.stamps.settings, rows: { ...fin.settings, 'LINE友だち追加URL': '' } });
}

/* ============================================================
   UC15 「この日のこの時間だけ受けたくない」を止める
   ============================================================ */
console.log('\n【UC15】店が、ある日の時間帯だけ予約を止める');
{
  const day = key(new Date(Date.now() + 9 * 864e5));

  // 店が 14:00〜16:00 だけ止める
  const a = await newPhone('UC15-店');
  await a.goto(B + '/admin.html'); await a.waitForTimeout(900);
  await a.fill('#passcode', PW); await a.locator('#remember-me').setChecked(false);
  await a.click('#gate-btn'); await a.waitForTimeout(1700);
  await a.locator('.tab', { hasText: '休業日' }).first().click(); await a.waitForTimeout(500);
  await a.locator('[data-add="closed"]').click(); await a.waitForTimeout(300);
  const row = a.locator('#closed-rows .booking-card').last();
  await row.locator('[data-col="休業日"]').fill(day);
  /* 時刻の欄は「この時間帯だけ休み」を選んでから出ます。
     終日休みのつもりで時刻を入れてしまい、日付が選べたまま残る事故が
     実際に起きたため、先に休み方を選ばせる作りにしました。 */
  await row.locator('[data-closed-mode][value="range"]').check();
  await a.waitForTimeout(300);
  const row2 = a.locator('#closed-rows .booking-card').last();
  await row2.locator('[data-col="開始"]').fill('14:00');
  await row2.locator('[data-col="終了"]').fill('16:00');
  await a.locator('[data-save="closed"]').click(); await a.waitForTimeout(1800);
  check('UC15', '時間帯つきで保存できる',
    ((await post({ type: 'adminData', password: PW })).closedDates || [])
      .some(r => r['休業日'] === day && r['開始'] === '14:00'), true);
  await a.context().close();

  // お客様側のカレンダーで、その帯だけ押せなくなる
  const p = await newPhone('UC15-客');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1500);
  const state = async t => p.evaluate(
    ([d, tm]) => Availability.slotInfo(d, tm, null, 60).reason, [day, t]);
  check('UC15', '13:00 は取れる', await state('13:00') === '' , true);
  check('UC15', '14:00 は止まる', await state('14:00'), 'closed-range');
  check('UC15', '15:30 は止まる', await state('15:30'), 'closed-range');
  check('UC15', '13:30開始も止まる（施術が帯に食い込む）', await state('13:30'), 'closed-range');
  check('UC15', '16:00 からは取れる', await state('16:00') === '', true);
  check('UC15', 'その日全体は休みにならない', await p.evaluate(
    d => Availability.isClosed(d), day), false);

  // 受信先に直接送っても弾かれる
  const direct = await post({
    type: 'reserve', code: 'LM-CLOS1', createdAt: new Date().toISOString(),
    date: day, time: '14:30', endTime: '15:30', totalMinutes: 60,
    menus: [{ name: 'カット' }], staffName: 'MATTEO', staffId: 'st01',
    totalPrice: 4000, customer: { name: '直接 送信', tel: '09000000001' }
  });
  check('UC15', '画面を通さず送っても断られる', direct.ok, false);
  await p.context().close();

  // あと片付け
  await post({ type: 'adminSave', password: PW, target: 'closed', rows: [] });
}

/* ============================================================
   UC16 電話で受けた予約を台帳に入れ、ネット予約と重ならないようにする
   ============================================================ */
console.log('\n【UC16】電話で受けた予約を台帳に入れる');
{
  /* ここまでの試験で埋まった日を避けます。
     先に予約が入っている日で試すと、確かめたいこと
     （電話予約でその枠が埋まる）が見えなくなります。 */
  const used = new Set(((await post({ type: 'availability' })).booked || []).map(b => b.date));
  let day = '';
  for (let i = 11; i < 40 && !day; i++) {
    const d = key(new Date(Date.now() + i * 864e5));
    if (!used.has(d)) day = d;
  }
  check('UC16', '予約の無い日が見つかる', !!day, true);

  const a = await newPhone('UC16-店');
  a.on('dialog', d => d.accept());
  await a.goto(B + '/admin.html'); await a.waitForTimeout(900);
  await a.fill('#passcode', PW); await a.locator('#remember-me').setChecked(false);
  await a.click('#gate-btn'); await a.waitForTimeout(1700);

  await a.click('#add-booking'); await a.waitForTimeout(300);
  await a.fill('#ab-date', day);
  await a.fill('#ab-time', '11:00');
  await a.fill('#ab-minutes', '60');
  await a.fill('#ab-name', '電話 九郎');
  await a.fill('#ab-tel', '09022223333');
  await a.fill('#ab-menu', 'メンズカット');
  await a.click('#ab-save'); await a.waitForTimeout(1800);

  const ledger = (await post({ type: 'adminData', password: PW })).reservations || [];
  const added = ledger.find(r => r.name === '電話 九郎');
  check('UC16', '台帳に入る', !!added, true);
  check('UC16', '終了時刻が計算される', added && added.endTime, '12:00');
  check('UC16', '予約一覧に出る',
    (await a.locator('#admin-rows').innerText()).includes('電話 九郎'), true);
  await a.context().close();

  // お客様側から、その枠が取れなくなっている
  const p = await newPhone('UC16-客');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1500);
  const free = async t => p.evaluate(
    ([d, tm]) => Availability.slotInfo(d, tm, null, 60).available, [day, t]);
  check('UC16', '11:00 はもう取れない', await free('11:00'), false);
  check('UC16', '11:30 も取れない（施術中）', await free('11:30'), false);
  check('UC16', '12:00 からは取れる', await free('12:00'), true);
  check('UC16', '10:00 も取れる', await free('10:00'), true);
  await p.context().close();

  // 同じ時間にもう1件入れようとすると、確認を求められる
  const b2 = await newPhone('UC16-重複');
  let asked = '';
  b2.on('dialog', d => { asked = d.message(); d.dismiss(); });   // 「いいえ」を選ぶ
  await b2.goto(B + '/admin.html'); await b2.waitForTimeout(900);
  await b2.fill('#passcode', PW); await b2.locator('#remember-me').setChecked(false);
  await b2.click('#gate-btn'); await b2.waitForTimeout(1700);
  await b2.click('#add-booking'); await b2.waitForTimeout(300);
  await b2.fill('#ab-date', day);
  await b2.fill('#ab-time', '11:30');
  await b2.fill('#ab-name', '重なり 十郎');
  await b2.click('#ab-save'); await b2.waitForTimeout(1600);
  check('UC16', '重なるときは確認を出す', asked.includes('すでに別のご予約'), true);

  const after = (await post({ type: 'adminData', password: PW })).reservations || [];
  check('UC16', '「いいえ」なら入らない', after.some(r => r.name === '重なり 十郎'), false);
  await b2.context().close();
}

/* ============================================================
   UC17 台帳につながっているのに、空いている枠が×になっていないか
   ============================================================ */
console.log('\n【UC17】空いている時間が、勝手に埋まっていないか');
{
  /* 受信先が無いときのデモ用に、それらしい「先約」を作る仕組みがあります。
     台帳につながったあともこれが効いていると、
     実際には空いている時間が毎日いくつか×になり、
     店は理由も分からないまま予約を取り逃がします。 */
  const p = await newPhone('UC17');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1600);

  check('UC17', '台帳につながっている',
    await p.evaluate(() => Remote.booked !== null), true);
  check('UC17', '作り物の先約が使われていない',
    await p.evaluate(() => Availability.busyBlocks('st01', '2099-06-01').length), 0);

  /* 受信先が落ちて空席状況が取れなかったときも、作り物で埋めてはいけません。
     分からないものを「埋まっている」ことにすると、
     実際には空いている時間をお客様に見せられなくなります。 */
  check('UC17', '取得に失敗したときも作り物で埋めない', await p.evaluate(() => {
    const before = Remote.booked;
    Remote.booked = null;                       // 取得失敗と同じ状態にする
    Availability._blocks.clear();
    const n = Availability.busyBlocks('st01', '2099-06-02').length;
    Remote.booked = before;
    Availability._blocks.clear();
    return n;
  }), 0);

  /* 予約が1件も無い先の日は、営業時間内のすべての枠が取れるはずです。
     ここまでの試験で埋まった日を避けたいので、台帳に無い日を選びます。
     （当日締め切り・休業日の影響も避けるため、十分先から探します） */
  const taken = new Set(((await post({ type: 'availability' })).booked || []).map(b => b.date));
  let far = '';
  for (let i = 25; i < 55 && !far; i++) {
    const d = key(new Date(Date.now() + i * 864e5));
    if (!taken.has(d)) far = d;
  }
  check('UC17', '予約の無い日が見つかる', !!far, true);
  const blocked = await p.evaluate(d => {
    const out = [];
    Availability.timeSlots().forEach(t => {
      const s = Availability.slotInfo(d, t, null, 30);
      if (!s.available) out.push(t + '=' + (s.reason || '?'));
    });
    return out;
  }, far);
  check('UC17', `予約の無い日は全部の枠が取れる（${far}）`, blocked.join(',') || 'なし', 'なし');
  await p.context().close();
}

/* ============================================================
   UC18 入力の途中で画面が読み込み直される
   ============================================================ */
console.log('\n【UC18】入力の途中で画面が読み込み直される');
{
  /* スマホは、他のアプリを使っているあいだにタブを捨てて、
     戻ったときに読み込み直すことがあります。お客様の操作ではありません。
     そこで選択が消えると、最初からやり直しになります。 */
  const p = await newPhone('UC18');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1500);
  await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(400);
  const chosen = (await p.locator('#coupon-choices .selectable').first()
    .locator('.selectable-title').innerText()).trim();
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(1100);
  await p.locator('button[data-date][data-time]:not([disabled])').nth(60).click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(600);

  await p.reload(); await p.waitForTimeout(2000);
  check('UC18', '同じステップに戻る', await p.evaluate(
    () => [...document.querySelectorAll('.reserve-panel.is-active')].map(x => x.dataset.panel).join()), '4');
  check('UC18', '選んだメニューが残っている', await p.evaluate(
    () => !!(state.couponId || state.menuIds.length)), true);
  check('UC18', '合計金額が0円になっていない',
    (await p.locator('#summary-total').innerText()).trim() !== '¥0', true);
  check('UC18', '同じメニューが選ばれている',
    (await p.locator('#summary-body').innerText()).includes(chosen.replace(/^［[^］]*］/, '')), true);
  check('UC18', '日時も残っている', await p.evaluate(() => !!(state.date && state.time)), true);
  await p.context().close();
}

/* ============================================================
   UC19 日本語入力を切り替えずに入力する
   ============================================================ */
console.log('\n【UC19】日本語入力のまま、全角で打ってしまうお客様');
{
  /* スマホで日本語入力のまま数字を打つと「０９０」に、
     「@」は「＠」になります。フリガナをひらがなで書く方もいます。
     ご本人にとっては正しく打っているので、ここで断られると
     「予約できない店」になってしまいます。 */
  const p = await newPhone('UC19');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1500);
  await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(1100);
  await p.locator('button[data-date][data-time]:not([disabled])').nth(40).click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(600);

  const saved19 = p.locator('#saved-profile');
  if (await saved19.isVisible()) { await p.click('#profile-edit'); await p.waitForTimeout(200); }
  await p.fill('#f-name', '全角 太郎');
  await p.fill('#f-kana', 'ぜんかく たろう');           // ひらがなで書いた
  await p.fill('#f-tel', '０９０ー１１１１ー９９９９');   // 全角＋長音符
  await p.fill('#f-email', 'ｚｅｎ＠ｅｘａｍｐｌｅ．ｃｏｍ');
  await p.locator('#f-email').blur(); await p.waitForTimeout(300);

  check('UC19', '電話番号が半角に直る', await p.inputValue('#f-tel'), '090-1111-9999');
  check('UC19', 'フリガナがカタカナに直る', await p.inputValue('#f-kana'), 'ゼンカク タロウ');
  check('UC19', 'メールが半角に直る', await p.inputValue('#f-email'), 'zen@example.com');

  await p.locator('label.radio-chip:has-text("初めて")').first().click();
  await p.locator('.checkbox-line > span').click();
  await p.locator('[data-next="5"]').first().click(); await p.waitForTimeout(600);
  check('UC19', '確認画面まで進める', await p.evaluate(
    () => [...document.querySelectorAll('.reserve-panel.is-active')].map(x => x.dataset.panel).join()), '5');
  await p.locator('#submit-reservation').click(); await p.waitForTimeout(1800);
  const code19 = (await p.locator('#done-code').innerText()).trim();
  check('UC19', '予約できる', /^LM-/.test(code19), true);
  await p.context().close();

  /* 控えを見ながら打ち直すときも、同じことが起きます */
  const other = await newPhone('UC19-別の端末');
  await other.goto(B + '/mypage.html'); await other.waitForTimeout(1300);
  await other.fill('#lookup-code', code19.toLowerCase().replace('-', 'ー'));
  await other.fill('#lookup-tel', '０９０１１１１９９９９');
  await other.click('#lookup-btn'); await other.waitForTimeout(1600);
  check('UC19', '小文字・全角で打っても照会できる',
    await other.locator('#lookup-result .booking-card').count(), 1);
  await other.context().close();
}

/* ============================================================
   UC20 3時間かかるメニューを、閉店間際に選ばれないか
   ============================================================ */
console.log('\n【UC20】長いメニューと、閉店の時刻');
{
  /* 縮毛矯正は3時間かかります。20:00から始めると23:00になり、
     受け口は断ります。断られるのは正しいのですが、お客様は
     お名前も電話番号も入れたあとです。選べないようにしておきます。 */
  const p = await newPhone('UC20');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1500);

  const menus = await p.$$eval('#coupon-choices .selectable', els => els.map((e, i) => {
    const meta = (e.querySelector('.selectable-meta') || {}).innerText || '';
    const m = meta.replace(/\s+/g, '').match(/約(?:(\d+)時間)?(?:(\d+)分)?/);
    return { i, minutes: m ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : 0 };
  }));
  const longest = menus.reduce((a, b) => (b.minutes > a.minutes ? b : a), menus[0]);
  check('UC20', '3時間のメニューがある', longest.minutes >= 180, true);

  await p.locator('#coupon-choices .selectable').nth(longest.i).click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(1300);

  const duration = await p.evaluate(() => totalMinutes());
  const slots = await p.$$eval('button[data-date][data-time]', els => els.map(e => ({
    date: e.dataset.date, time: e.dataset.time, disabled: e.disabled })));
  const byDate = {};
  slots.forEach(s => { (byDate[s.date] = byDate[s.date] || []).push(s); });
  const day1 = Object.keys(byDate).find(d => byDate[d].some(s => !s.disabled));
  const open = byDate[day1].filter(s => !s.disabled);
  const last = open[open.length - 1];
  const endsAt = (() => { const [h, m] = last.time.split(':').map(Number); return h * 60 + m + duration; })();

  const closeMin = await p.evaluate(() => toMinutes(SALON.business.closeTime));
  check('UC20', '最後の枠でも閉店までに終わる', endsAt <= closeMin, true);
  check('UC20', '閉店を過ぎる枠は選べない',
    open.some(s => { const [h, m] = s.time.split(':').map(Number); return h * 60 + m + duration > closeMin; }), false);
  await p.context().close();
}

/* ============================================================
   UC21 受け口が壊れている（公開設定を間違えて入れ直した）
   ============================================================ */
console.log('\n【UC21】Apps Script を入れ直して、公開設定を間違えたら');
{
  /* 「アクセスできるユーザー」を全員以外にして入れ直すと、
     受け口はJSONではなくGoogleのログイン画面（HTML）を返します。
     このとき、お客様に「予約できました」と出してはいけません。
     来店されても、店の台帳には何もありません。 */
  await post({ type: 'htmlmode', on: true });
  const p = await newPhone('UC21');
  let told = '';
  p.on('dialog', d => { told = d.message(); d.dismiss(); });

  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1500);
  await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(1100);
  const slot = p.locator('button[data-date][data-time]:not([disabled])').nth(20);
  await slot.click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(600);
  const saved21 = p.locator('#saved-profile');
  if (await saved21.isVisible()) { await p.click('#profile-edit'); await p.waitForTimeout(200); }
  await p.fill('#f-name', '届かない 太郎'); await p.fill('#f-kana', 'トドカナイ タロウ');
  await p.fill('#f-tel', '09011119999'); await p.fill('#f-email', 'x@example.com');
  await p.locator('label.radio-chip:has-text("初めて")').first().click();
  await p.locator('.checkbox-line > span').click();
  await p.locator('[data-next="5"]').first().click(); await p.waitForTimeout(600);
  await p.locator('#submit-reservation').click(); await p.waitForTimeout(5000);

  const seen = await p.evaluate(() => ({
    head: (document.querySelector('#h-done') || {}).textContent || '',
    warned: !(document.querySelector('#done-warning') || {}).hidden,
    warn: (document.querySelector('#done-warning') || {}).innerText || '',
    code: (document.querySelector('#done-code') || {}).textContent || '',
    stored: JSON.parse(localStorage.getItem('salon.reservations.v1') || '[]')
  }));
  check('UC21', '見出しが「完了しました」になっていない', /完了しました/.test(seen.head), false);
  check('UC21', '届いていないと見出しで伝えている', /届いて/.test(seen.head), true);
  check('UC21', '店舗へ連絡するようご案内している', /お電話|ご連絡/.test(seen.warn), true);
  check('UC21', '予約番号は出している（電話で伝えられるように）', /^LM-/.test(seen.code.trim()), true);
  check('UC21', 'この端末には届かなかったことを記録している',
    seen.stored.length === 1 && seen.stored[0].delivered === false, true);
  console.log('   見出し:', seen.head);

  /* 照会も同じです。ここが黙って失敗すると、お客様は
     「番号が違うのかな」と何度も打ち直すことになります。 */
  const q = await newPhone('UC21-照会');
  await q.goto(B + '/mypage.html'); await q.waitForTimeout(1300);
  await q.fill('#lookup-code', 'LM-ZZZZZ');
  await q.fill('#lookup-tel', '09011119999');
  await q.click('#lookup-btn'); await q.waitForTimeout(2500);
  const lookErr = await q.evaluate(() => {
    const e = document.querySelector('#lookup-error');
    return e && e.style.display !== 'none' ? e.innerText : '';
  });
  check('UC21', '照会も、失敗したと画面で分かる', lookErr.trim().length > 0, true);
  console.log('   照会の知らせ:', lookErr.replace(/\s+/g, ' ').slice(0, 60));
  await q.context().close();

  await post({ type: 'htmlmode', on: false });
  await p.context().close();
}

/* ============================================================
   UC22 予約をスマホのカレンダーに入れる
   ============================================================ */
console.log('\n【UC22】カレンダーに追加したファイルの中身');
{
  /* カレンダーの決まりは、1行75バイトまで・カンマや改行はそのまま書けない、
     と細かく決まっています。守れていないと、取り込めない端末が出ます。
     取り込めなかったことは、こちらには分かりません。 */
  const p = await newPhone('UC22');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1500);
  const ics = await p.evaluate(() => buildIcs({
    code: 'LM-ICS01', date: '2026-09-01', time: '10:00', endTime: '13:00',
    menus: [{ name: '【清潔感と品が続く】men\'s骨格補正カット＋眉カット, スパ付き' }],
    staffName: 'MATTEO', totalPrice: 6900
  }));

  const lines = ics.split('\r\n');
  const size = s => new TextEncoder().encode(s).length;
  check('UC22', '始まりと終わりが揃っている',
    lines[0] === 'BEGIN:VCALENDAR' && lines[lines.length - 1] === 'END:VCALENDAR', true);
  check('UC22', '75バイトを超える行が無い', lines.every(l => size(l) <= 75), true);
  check('UC22', '折り返した行は空白で始まる',
    lines.every((l, i) => i === 0 || /^[A-Z]/.test(l) || l.startsWith(' ')), true);
  check('UC22', 'カンマがそのまま入っていない', /[^\\],\s*スパ付き/.test(ics), false);
  check('UC22', '来店日時が入っている', ics.includes('DTSTART;TZID=Asia/Tokyo:20260901T100000'), true);
  check('UC22', '終わりの時刻も入っている', ics.includes('DTEND;TZID=Asia/Tokyo:20260901T130000'), true);
  check('UC22', '予約番号が入っている', ics.includes('LM-ICS01'), true);
  await p.context().close();
}

/* ============================================================
   UC23 店が営業時間を変える
   ============================================================ */
console.log('\n【UC23】営業終了を早めたら、その時間の枠が消えるか');
{
  /* 「今日は20時で閉める」を設定シートに入れたのに、
     受け口が22時まで受け続ける、という食い違いが起きないことを見ます。
     お客様の画面と、送ったときの判定が、同じでなければいけません。 */
  const before = (await post({ type: 'adminData', password: PW })).settings || {};
  await post({ type: 'adminSave', password: PW, target: 'settings',
    stamp: (await post({ type: 'adminData', password: PW })).stamps.settings,
    rows: { ...before, '営業終了': '20:00', '最終受付': '19:30' } });

  const p = await newPhone('UC23');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1600);
  await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(1300);

  const latest = await p.evaluate(() => {
    const times = [...document.querySelectorAll('button[data-date][data-time]')].map(b => b.dataset.time);
    return times.sort()[times.length - 1] || '';
  });
  check('UC23', '画面が新しい営業時間を読んでいる', await p.evaluate(() => SALON.business.closeTime), '20:00');
  check('UC23', '20時より後の枠が出ていない', latest <= '20:00', true);

  /* 画面を通さずに、閉店後の時間へ直接送ってみます */
  const day23 = await p.evaluate(() =>
    (document.querySelector('button[data-date][data-time]') || {}).dataset.date);
  const late = await post({ type: 'reserve', code: 'LM-LATE1', createdAt: new Date().toISOString(),
    date: day23, time: '21:00', endTime: '22:00', totalMinutes: 60,
    menus: [{ name: 'カット' }], staffName: 'MATTEO', staffId: 'st01',
    nominationFee: 0, totalPrice: 4000,
    customer: { name: '閉店後 太郎', kana: 'ヘイテンゴ', tel: '09088887777', email: 'l@example.com', visit: '初めて' } });
  check('UC23', '閉店後の時間に直接送っても断られる', late.ok, false);
  await p.context().close();

  // あと片付け
  await post({ type: 'adminSave', password: PW, target: 'settings',
    stamp: (await post({ type: 'adminData', password: PW })).stamps.settings, rows: before });
}

/* ============================================================
   UC24 予約画面を開いたまま、時間が過ぎる
   ============================================================ */
console.log('\n【UC24】朝に開いたカレンダーを、昼に見る');
{
  /* スマホは、ほかの用事のあいだ画面をそのまま残します。
     朝9時に開いたカレンダーを昼に見ると、もう過ぎた時間が
     「空いています」の顔で並んでいます。そこを選んで、お名前も
     電話番号も入れたところで断られるのが、いちばん徒労です。

     時計を進めて、戻ってきたときに描き直されるかを見ます。 */
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
    hasTouch: true, timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  const p = await ctx.newPage();
  p.on('pageerror', e => jsErrors.push(`[UC24] ${e.message}`));
  let told = '';
  p.on('dialog', d => { told = d.message(); d.dismiss(); });

  /* 「今日の朝9時（日本時間）」を作ります。この機械はUTCで動いているので、
     new Date().setHours(9) では日本時間の18時になってしまいます。 */
  const jstNow = new Date(Date.now() + 9 * 3600e3);
  const todayJst = `${jstNow.getUTCFullYear()}-${String(jstNow.getUTCMonth() + 1).padStart(2, '0')}-${String(jstNow.getUTCDate()).padStart(2, '0')}`;
  const morning = new Date(`${todayJst}T09:00:00+09:00`);
  await p.clock.install({ time: morning });
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1500);
  await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(1300);

  /* 今日ぶんで、いちばん早く取れる枠を選びます。時刻を決め打ちにすると、
     先のシナリオがそこを埋めていたときに落ちます。 */
  const today = todayJst;
  const slot = await p.evaluate(d => {
    const b = [...document.querySelectorAll(`button[data-date="${d}"][data-time]`)]
      .find(x => !x.disabled);
    return b ? b.dataset.time : null;
  }, today);
  check('UC24', '朝の時点で、今日の枠が選べる', !!slot, true);
  await p.locator(`button[data-date="${today}"][data-time="${slot}"]`).click();
  await p.waitForTimeout(400);

  /* 画面はそのままに、その枠が受付時刻（2時間前）を切るまで進めます */
  const [sh, sm] = slot.split(':').map(Number);
  const forwardMin = Math.max(30, (sh * 60 + sm) - 9 * 60 - 90);
  await p.clock.fastForward(`${String(Math.floor(forwardMin / 60)).padStart(2, '0')}:${String(forwardMin % 60).padStart(2, '0')}:00`);
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(900);

  check('UC24', '受付時刻を過ぎた枠は選べなくなっている',
    await p.locator(`button[data-date="${today}"][data-time="${slot}"]:not([disabled])`).count(), 0);
  check('UC24', '選んでいた時間が外れたことを伝えている', /お受けできなくなりました/.test(told), true);
  check('UC24', '選び直しの画面に戻っている',
    await p.evaluate(() => [...document.querySelectorAll('.reserve-panel.is-active')].map(x => x.dataset.panel).join()), '3');
  console.log('   お知らせ:', told.replace(/\n/g, ' ') || '（なし）');
  await ctx.close();
}

/* ============================================================
   UC25 スタイリストが1名の店で、「指名」を探させない
   ============================================================ */
console.log('\n【UC25】1人1席の店に、「指名」という選択はない');
{
  /* この店のスタイリストは1名です。誰に切ってもらうかは選びようがなく、
     指名料も発生しません。それなのに予約画面は
     「ご指名のスタッフをお選びください」「指名なしの場合は、当日空いている
     スタッフが担当いたします」と書いていました。
     お客様は在りもしない「指名なし」を探して止まります。
     （staff.html では同じ言い方をすでに直してあります。test/pages.mjs 【6】） */
  const p = await newPhone('UC25');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1600);
  check('UC25', '在籍は1名（この試験の前提）', await p.evaluate(() => SALON.staff.length), 1);

  await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(400);
  const step1Btn = await p.locator('#step-cta button').innerText();
  check('UC25', '「スタッフの選択へ」と言っていない', /スタッフの選択/.test(step1Btn), false);

  await p.locator('#step-cta button').click(); await p.waitForTimeout(800);
  const lead = (await p.locator('#h-step2').innerText()) + '\n' + (await p.locator('#staff-lead').innerText());
  check('UC25', '「ご指名」と書いていない', /指名/.test(lead), false);
  check('UC25', '他に空いているスタッフがいるように書いていない', /空いているスタッフ/.test(lead), false);
  check('UC25', '1名でお受けしていると伝えている', /マンツーマン|1名/.test(lead), true);
  check('UC25', '選択肢に「指名なし」は出さない', await p.locator('[data-staff=""]').count(), 0);
  /* かからない指名料を「¥0」と書いても、読む理由がありません */
  check('UC25', 'かからない指名料を並べていない',
    /指名料/.test(await p.locator('#staff-choices').innerText()), false);
  console.log('   案内文:', lead.replace(/\n/g, ' '));
  await p.context().close();
}

/* ============================================================
   UC26 カレンダーの記号と、横に長い表
   ============================================================ */
console.log('\n【UC26】出ない記号を探させない／表が横に動くと伝える');
{
  /* スタイリストが1名の店では、slotInfo は ○ と × しか返しません。
     それなのに凡例には ◎（空きに余裕あり）と △（残りわずか）が
     並んでいました。お客様は「◎の日を探そう」として、いつまでも
     見つけられません。

     表は14日ぶんありますが、390pxの画面には7日ぶんしか映りません。
     指で送れることを書いておかないと、先の日付に辿り着けません。 */
  const p = await newPhone('UC26');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1600);
  await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(1400);

  const legend = await p.locator('#cal-legend').innerText();
  const shown = await p.evaluate(() =>
    [...new Set([...document.querySelectorAll('button[data-date][data-time]')].map(b => b.textContent.trim()))]);
  check('UC26', '表に出るのは ○ と × と - だけ',
    shown.every(s => ['○', '×', '-'].includes(s)), true);
  check('UC26', '出ない ◎ を凡例に並べていない', /◎/.test(legend), false);
  check('UC26', '出ない △ を凡例に並べていない', /△/.test(legend), false);
  check('UC26', '出る ○ は説明している', /○/.test(legend), true);
  check('UC26', '休業日の印も説明している', /休業日/.test(legend), true);

  const wide = await p.evaluate(() => {
    const box = document.querySelector('.calendar-scroll');
    return box.scrollWidth > box.clientWidth + 1;
  });
  check('UC26', '表は画面より横に長い（送らないと先が見えない）', wide, true);
  check('UC26', '横に動かせることを書いている',
    /横に/.test(await p.locator('.cal-hint').innerText()), true);
  console.log('   凡例:', legend.replace(/\n/g, ' / '));
  await p.context().close();
}

/* ============================================================
   UC27 電波の細い場所で「この内容で予約する」を押す
   ============================================================ */
console.log('\n【UC27】応答が返ってくるまで、押せたことが分かる');
{
  /* 外出先の電波では、応答まで数秒かかります。そのあいだボタンの文字が
     変わるだけだと、画面を送っていて手元にボタンが無い方には
     何も起きていないように見えます。もう一度押されるか、閉じられます。

     送信中は、その旨をはっきり出し、二重に送れないようにします。 */
  const p = await newPhone('UC27');
  // 予約の送信だけを、わざと遅らせる
  await p.route('**/exec', async route => {
    const body = route.request().postData() || '';
    if (/"type"\s*:\s*"reserve"/.test(body)) await new Promise(r => setTimeout(r, 3000));
    await route.continue();
  });

  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1600);
  await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(1300);
  await p.locator('button[data-date][data-time]:not([disabled])').nth(20).click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(600);
  await p.fill('#f-name', '電波 細子'); await p.fill('#f-kana', 'デンパ');
  await p.fill('#f-tel', '09011110027'); await p.fill('#f-email', 'slow@example.com');
  await p.locator('label.radio-chip:has-text("初めて")').first().click();
  await p.locator('.checkbox-line > span').click();
  await p.locator('[data-next="5"]').first().click(); await p.waitForTimeout(600);

  await p.locator('#submit-reservation').click(); await p.waitForTimeout(900);
  check('UC27', '送信中だと、ボタン以外の場所でも伝えている',
    await p.locator('#sending-note').isVisible(), true);
  check('UC27', '送信ボタンは押せなくなっている',
    await p.locator('#submit-reservation').isDisabled(), true);
  /* ステップ表示は押すと戻れます。送信中に戻られると、
     送っている内容と画面が食い違うので、そこも止めます */
  await p.locator('.step[data-step="3"]').click(); await p.waitForTimeout(300);
  check('UC27', '送信中はステップ表示から戻らせない',
    await p.evaluate(() => [...document.querySelectorAll('.reserve-panel.is-active')]
      .map(x => x.dataset.panel).join()), '5');

  await p.waitForTimeout(5000);
  const code = (await p.locator('#done-code').innerText()).trim();
  check('UC27', '待ったあと、予約は取れている', /^LM-[A-Z0-9]{5}$/.test(code), true);
  check('UC27', '送信中の知らせは消えている', await p.locator('#sending-note').isVisible(), false);
  const mine = (await post({ type: 'adminData', password: PW })).reservations
    .filter(r => r.tel === '09011110027');
  check('UC27', '台帳にも二重に入っていない', mine.length, 1);
  await p.context().close();
}

/* ============================================================
   UC28 予約が取れたあと、控えて、この先どうすればいいか分かる
   ============================================================ */
console.log('\n【UC28】完了画面で、番号を控えて、この先が分かる');
{
  /* 外を歩きながら5文字を手で書き写すのは、まず無理です。
     そして完了画面は、お客様が最後に抱える2つの不安
     「本当に取れたのか」「都合が変わったらどうするのか」に
     答えられる最後の場所です。ここで答えないと、店に電話がかかります。 */
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    timezoneId: 'Asia/Tokyo', locale: 'ja-JP',
    permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  p.on('pageerror', e => jsErrors.push(`[UC28] ${e.message}`));

  const r = await book(p, { name: '控え 太郎', tel: '09011110028', slotIndex: 24 });

  const follow = await p.locator('#done-follow').innerText();
  check('UC28', '確認メールを送ったことを書いている', /確認メール/.test(follow), true);
  check('UC28', 'どこ宛に送ったかを書いている', /test@example\.com/.test(follow), true);
  check('UC28', '届かないときに見る場所を書いている', /迷惑メール/.test(follow), true);
  check('UC28', 'いつまで変更・キャンセルできるかを書いている', /前日18時/.test(follow), true);
  check('UC28', '期限後の連絡先も書いている', /080-4498-7036/.test(follow), true);

  await p.locator('#copy-code').click(); await p.waitForTimeout(500);
  check('UC28', 'コピーしたと伝えている', await p.locator('#copy-done').isVisible(), true);
  check('UC28', '予約番号がそのままコピーされている',
    (await p.evaluate(() => navigator.clipboard.readText())).trim(), r.code);
  console.log('   案内:', follow.replace(/\s+/g, ' ').slice(0, 90));
  await ctx.close();
}

/* ============================================================
   UC29 届かなかったのに「メールを送りました」と言わない
   ============================================================ */
console.log('\n【UC29】店舗に届かなかったときは、送っていない案内を出さない');
{
  /* UC28 で足した案内は、届いたときだけ正しい文です。
     届かなかった画面に「確認メールをお送りしました」が残っていると、
     お客様はメールを待ち、来ない理由が分からないままになります。
     UC12（通信が切れた）と同じ場面を、この案内の側から見ています。 */
  const p = await newPhone('UC29');
  await p.route('**/exec', async route => {
    const body = route.request().postData() || '';
    if (/"type"\s*:\s*"reserve"/.test(body)) { await route.abort('failed'); return; }
    await route.continue();
  });
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1600);
  await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(1300);
  await p.locator('button[data-date][data-time]:not([disabled])').nth(30).click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(600);
  await p.fill('#f-name', '不達 太郎'); await p.fill('#f-kana', 'フタツ');
  await p.fill('#f-tel', '09011110029'); await p.fill('#f-email', 'ng@example.com');
  await p.locator('label.radio-chip:has-text("初めて")').first().click();
  await p.locator('.checkbox-line > span').click();
  await p.locator('[data-next="5"]').first().click(); await p.waitForTimeout(600);
  await p.locator('#submit-reservation').click(); await p.waitForTimeout(7000);

  const follow = await p.locator('#done-follow').innerText();
  check('UC29', '届いていないことを見出しで伝えている',
    /届いて/.test(await p.locator('#h-done').innerText()), true);
  check('UC29', '送っていないメールを「送りました」と書かない', /確認メール/.test(follow), false);
  check('UC29', '店舗へ連絡する道は残している', /080-4498-7036/.test(follow), true);
  check('UC29', '予約番号は出している', /^LM-/.test((await p.locator('#done-code').innerText()).trim()), true);
  await p.context().close();
}

/* ============================================================
   UC30 まだ何も選んでいないのに「¥0」と書かない

   予約ページを開いた直後、合計の欄に「¥0」と出ていました。
   金額の欄に0円と書いてあれば、それは「無料」と読めます。しかも
   すぐ下に「メニューをお選びいただくと合計金額が表示されます」と
   書いてあり、同じ画面で逆のことを言っていました。

   掲載側で価格未定を「¥0」と表示しているメニューが実際に2件あるので、
   このサイトで0円を出すのは、無料だと誤解させる形（有利誤認）に
   いちばん近づきます。
   ============================================================ */
console.log('\n【UC30】何も選んでいない画面に「¥0」を出さない');
{
  const p = await newPhone('UC30');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1800);

  check('UC30', '合計の欄が「¥0」になっていない',
    (await p.locator('#summary-total').innerText()).trim() !== '¥0', true);
  /* ボタンの左の要約も同じです。「0件 ／ ¥0」と並べても読む値がありません */
  check('UC30', 'ボタン脇の要約も「¥0」ではない',
    /¥\s*0(?![\d,])/.test(await p.locator('#step-cta').innerText()), false);
  check('UC30', '次にすることが書いてある',
    /メニュー/.test(await p.locator('#step-cta').innerText()), true);
  /* 画面全体で見ても0円がどこにも無いこと。
     金額の欄以外に出ても、読む人には同じことです。 */
  check('UC30', '画面のどこにも「¥0」が出ていない',
    /¥\s*0(?![\d,])/.test(await p.locator('main').innerText()), false);

  /* 説明文が空のメニューで、中身の無い行が残らないこと。
     掲載に説明が無いメニューが実際にあります。 */
  check('UC30', '説明が空でも空っぽの行が残らない',
    await p.evaluate(() => [...document.querySelectorAll('#coupon-choices .selectable-sub')]
      .filter(el => !el.textContent.trim()).length), 0);
  await p.context().close();
}

/* ============================================================
   UC31 気になるスタイルを、書き写させない

   スタイル一覧には「気になるスタイルは、ご予約時のご要望欄に名前を
   書いていただければスムーズです」と書いてあります。つまり、写して
   打ち直す作業をお客様にさせていました。押した時点で分かっている
   ことなので、こちらで運びます。
   ============================================================ */
console.log('\n【UC31】スタイル名をご要望欄まで運ぶ');
{
  const p = await newPhone('UC31');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1500);
  await p.evaluate(() => rememberStyleRequest('ナチュラルセンターパート/曲がる縮毛矯正'));

  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1800);
  await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(300);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(1200);
  await p.locator('button[data-date][data-time]:not([disabled])').first().click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);

  const req = await p.inputValue('#f-request');
  check('UC31', 'スタイル名がご要望欄に入っている',
    req.includes('ナチュラルセンターパート/曲がる縮毛矯正'), true);
  /* 一度使ったら捨てます。次に別のメニューで予約する人に、
     前の人が見ていたスタイルが残っていると気味が悪いだけです。 */
  check('UC31', '一度使ったら残らない',
    await p.evaluate(() => takeStyleRequest()), '');
  await p.context().close();
}

/* 書きかけの下書きがある人の文章を、こちらの都合で上書きしない */
{
  const p = await newPhone('UC31-2');
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1500);
  await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(300);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(1200);
  await p.locator('button[data-date][data-time]:not([disabled])').first().click(); await p.waitForTimeout(400);
  await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
  await p.fill('#f-request', 'つむじが割れやすいので、そこだけ相談したいです。');
  await p.evaluate(() => rememberStyleRequest('スパイキーショート'));
  await p.reload(); await p.waitForTimeout(2200);
  check('UC31', '書きかけの文章を上書きしない',
    (await p.inputValue('#f-request')).includes('つむじが割れやすい'), true);
  await p.context().close();
}

/* ============================================================
   UC32 どこから来ていただいたかが、台帳に残る

   店主が掲載を止めてよいか決めるには、自社サイトに何件来ているのか、
   その入口はどこなのかが要ります。ところがそれを知るために、
   お客様の予約の手を1つでも増やしてはいけません。増やした分だけ
   予約が減り、掲載を止める根拠のほうが痩せます。

   ですからお客様には何も尋ねません。ここで確かめるのは
   「尋ねずに取れているか」と「予約が今までどおり通るか」です。
   ============================================================ */
console.log('\n【UC32】どこから来ていただいたかが、台帳に残る');

/* 台帳に入った1件を、店主の目線（管理ページ）で読み直します */
const ledgerOf = async code => {
  const res = await post({ type: 'adminData', password: PW });
  return (res.reservations || []).find(x => x.code === code) || {};
};

{
  /* LINE公式アカウントに貼った印付きURLから来られた方 */
  const p = await newPhone('UC32-LINE');
  const r = await book(p, { name: 'LINE 太郎', tel: '09011110032', slotIndex: 2,
    start: B + '/reserve.html?from=line' });
  check('UC32', 'LINEの印を付けたURLからでも、予約はそのまま通る', /^LM-/.test(r.code), true);
  check('UC32', '台帳に「LINE」として残る', (await ledgerOf(r.code)).source, 'LINE');
  await p.context().close();
}

{
  /* 料金が気になってメニューを見に行き、写真も見て、それから戻って予約する。
     いちばんよくある動き方です。ここで入口が消えると、LINEの効き目が
     いつまでも0件のまま出ます。 */
  const p = await newPhone('UC32-回り道');
  await p.goto(B + '/reserve.html?from=line'); await p.waitForTimeout(1200);
  await p.goto(B + '/menu.html'); await p.waitForTimeout(800);
  await p.goto(B + '/gallery.html'); await p.waitForTimeout(800);
  await p.goto(B + '/index.html'); await p.waitForTimeout(800);
  const r = await book(p, { name: '回り道 次郎', tel: '09011110033', slotIndex: 4 });
  check('UC32', '途中で別のページを見て戻っても、入口が消えない',
    (await ledgerOf(r.code)).source, 'LINE');
  await p.context().close();
}

{
  /* 名刺のQRから来られた方。印が違えば、別の入口として数えられます */
  const p = await newPhone('UC32-QR');
  const r = await book(p, { name: 'QR 三郎', tel: '09011110035', slotIndex: 6,
    start: B + '/index.html?from=qr' });
  check('UC32', '別の印は別の入口として残る', (await ledgerOf(r.code)).source, '名刺・店内QR');
  await p.context().close();
}

{
  /* 印の無いURLを直接開いた方。ここで予約が断られたら本末転倒です */
  const p = await newPhone('UC32-印なし');
  const r = await book(p, { name: '印なし 四郎', tel: '09011110036', slotIndex: 8 });
  check('UC32', '印が無くても予約はそのまま通る', /^LM-/.test(r.code), true);
  /* 分かるのは「直接開かれた」ところまでです。分からないものを
     LINEや地図の実績に足したりはしません。 */
  check('UC32', '分かる範囲だけが残る', (await ledgerOf(r.code)).source, '直接');
  await p.context().close();
}

{
  /* 知らない印を付けたURLが出回っても、台帳に妙な言葉を入れさせません */
  const p = await newPhone('UC32-知らない印');
  const r = await book(p, { name: '不明 五郎', tel: '09011110037', slotIndex: 10,
    start: B + '/reserve.html?from=%3Cscript%3E' });
  check('UC32', '知らない印でも予約は通る', /^LM-/.test(r.code), true);
  check('UC32', '知らない印は台帳に入らない', (await ledgerOf(r.code)).source, '直接');
  await p.context().close();
}

{
  /* 店が電話で受けた分。サイト経由と混ぜると、掲載を止めてよいかの
     判断そのものが狂います。 */
  const t = new Date(); t.setDate(t.getDate() + 20);
  const added = await post({ type: 'adminAdd', password: PW, force: true,
    date: key(t), time: '19:00', minutes: 60, price: 4000,
    name: '電話 六郎', tel: '0297001111', menu: 'カット' });
  check('UC32', '電話で受けた予約は「電話・来店」として区別される',
    (await ledgerOf(added.code)).source, '電話・来店');
}

{
  /* ★お客様の手間を増やしていないこと。
     入口を尋ねる欄が1つでも増えていたら、この仕組みは失敗です。 */
  const p = await newPhone('UC32-手間');
  await p.goto(B + '/reserve.html?from=line'); await p.waitForTimeout(1400);
  const form = await p.evaluate(() => {
    const f = document.querySelector('#customer-form');
    return { text: f.innerText,
      count: [...f.querySelectorAll('input, textarea, select')].filter(el => el.type !== 'hidden').length };
  });
  check('UC32', 'どこで知ったかを尋ねる欄が無い',
    /どこで|きっかけ|お知りに|何を見て|ご紹介者/.test(form.text), false);
  /* お名前・フリガナ・電話・メール・ご来店回数2つ・ご要望・同意 の8つのままです */
  check('UC32', '入力欄の数が増えていない', form.count, 8);
  check('UC32', '印が付いていても画面には出ない', /from=line/.test(form.text), false);
  await p.context().close();
}

/* ============================================================
   UC33 「準備中」と書いてあるあいだは、本当に受けない

   画面のいちばん上には「準備中：ご予約はまだお受けしていません」と
   出しています。ところが送れば実際に通っていました。台帳に行が入り、
   確認メールも飛びます。帯を読み飛ばした方が当日いらして、席がありません。

   画面で止めるだけでは足りません。この受け口は公開されていて、
   画面を通さない送信も届きます（DECISIONS.md）。ここで断ります。

   逆に、止めすぎてもいけません。すでに入っている予約を動かせなくすると、
   お客様が自分では取り消せなくなります。
   ============================================================ */
console.log('\n【UC33】準備中と書いてあるあいだは、本当に受けない');
{
  /* この節の中だけで使う日付。key は Date を受け取るので、日数から作ります */
  const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return key(d); };
  await post({ type: 'reset' });

  /* 先に1件だけ、受付中のうちに取っておきます。
     準備中にしたあとで、この予約を動かせるかを見るためです。 */
  const p0 = await newPhone('UC33-先に予約');
  const made = await book(p0, { name: '準備前 太郎', tel: '09044443333' });
  await p0.context().close();

  /* 帯を出す（＝準備中に戻す）。店主が管理ページからひと押しでできる操作です。 */
  /* 設定の保存には「印」が要ります（別端末との上書きを防ぐため）。
     渡し忘れると黙って断られ、帯が出ないまま先へ進みます。 */
  const cur = await post({ type: 'adminData', password: PW });
  const on = await post({ type: 'adminSave', password: PW, target: 'settings',
    stamp: cur.stamps.settings, rows: { ...cur.settings, '準備中の帯': '出す' } });
  check('UC33', '帯を出す設定が保存できる', on.ok, true);

  // ---- 画面を通さない送信 ----
  const direct = await post({ type: 'reserve', code: 'UC33-A', createdAt: new Date().toISOString(),
    date: day(3), time: '10:00', endTime: '11:00', totalMinutes: 60,
    menus: [{ name: 'カット' }], staffId: 'st01', staffName: 'MATTEO',
    nominationFee: 0, totalPrice: 4000,
    customer: { name: '直送 次郎', kana: 'チョクソウ', tel: '09055551111', email: 'a@b.co' } });
  check('UC33', '画面を通さない送信も受けない', direct.ok, false);
  check('UC33', '断る理由を書いている', /準備中/.test(String(direct.error || '')), true);
  check('UC33', 'どうすればよいかを書いている', /お電話|お問い合わせ/.test(String(direct.error || '')), true);

  const ledger = (await post({ type: 'adminData', password: PW })).reservations || [];
  check('UC33', '断った予約は台帳に入っていない',
    ledger.some(r => String(r.name).indexOf('直送') >= 0), false);

  // ---- すでに入っている予約は、お客様が自分で取り消せる ----
  const cancelled = await post({ type: 'cancel', code: made.code, tel: '09044443333' });
  check('UC33', '準備中でも、入っている予約はキャンセルできる', cancelled.ok, true);

  // ---- 店から入れる電話予約は止めない ----
  const byShop = await post({ type: 'adminAdd', password: PW, force: true, minutes: 60, price: 4000,
    date: day(4), time: '10:00', name: '電話 三郎', tel: '09066667777', menu: 'カット' });
  check('UC33', '準備中でも、店は電話予約を入れられる', byShop.ok, true);

  // ---- 帯を下ろすと、その場で受け付ける ----
  const now = await post({ type: 'adminData', password: PW });
  await post({ type: 'adminSave', password: PW, target: 'settings',
    stamp: now.stamps.settings, rows: { ...now.settings, '準備中の帯': '出さない' } });
  const after = await post({ type: 'reserve', code: 'UC33-B', createdAt: new Date().toISOString(),
    date: day(5), time: '10:00', endTime: '11:00', totalMinutes: 60,
    menus: [{ name: 'カット' }], staffId: 'st01', staffName: 'MATTEO',
    nominationFee: 0, totalPrice: 4000,
    customer: { name: '公開後 四郎', kana: 'コウカイゴ', tel: '09088889999', email: 'c@d.co' } });
  check('UC33', '帯を下ろせば、その場で受け付ける', after.ok, true);

  await post({ type: 'reset' });
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
