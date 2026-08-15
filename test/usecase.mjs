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
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => jsErrors.push(`[${label}] ${e.message}`));
  return p;
}

/* お客様が1件予約する。使い回すのでまとめておく */
async function book(p, { name, tel, menuIndex = 0, slotIndex = 0 }) {
  await p.goto(B + '/reserve.html'); await p.waitForTimeout(1400);
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
  await post({
    type: 'reserve', code: 'LM-UC910', date: today, time: '23:30', endTime: '23:59', totalMinutes: 20,
    menus: [{ name: 'テスト' }], staffId: 'stUC10', staffName: 'MATTEO', nominationFee: 0,
    totalPrice: 4000, createdAt: new Date().toISOString(),
    customer: { name: '期限 五郎', kana: 'キゲン', tel: '09011110011', email: 'a@b.c', visit: '初めて', request: '' }
  });
  const res = await post({ type: 'cancel', code: 'LM-UC910', tel: '09011110011' });
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
  await b2.fill('[data-setting="LINE友だち追加URL"]', 'javascript:alert(1)');
  await b2.locator('[data-save="settings"]').first().click(); await b2.waitForTimeout(1800);
  await b2.context().close();

  await p.reload(); await p.waitForTimeout(1500);
  check('UC14', 'https以外のURLは採用しない',
    await p.evaluate(() => SALON.lineAddUrl), '');
  check('UC14', '変なリンクがサイトに出ない',
    await p.locator('.site-footer a[href^="javascript:"]').count(), 0);
  await p.context().close();

  // あと片付け（この先の試験に影響させない）
  await post({ type: 'adminSave', password: PW, target: 'settings',
    rows: { ...(await post({ type: 'adminData', password: PW })).settings,
            'LINE友だち追加URL': '' } });
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
  await row.locator('[data-col="開始"]').fill('14:00');
  await row.locator('[data-col="終了"]').fill('16:00');
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
  const day = key(new Date(Date.now() + 11 * 864e5));

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
