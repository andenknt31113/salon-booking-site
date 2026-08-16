/* 画面に、お客様が書いた文字がそのまま埋め込まれていないかを確かめる。

   お名前やご要望は、確認画面・完了画面・管理ページ・お客様タブ・
   予約確認ページと、いくつもの場所に出ます。
   どこか1か所でも生のまま埋め込むと、そこだけが穴になります。
   店側の画面で動くと、開いているのは店の人なので被害が大きくなります。

   使い方は ユースケース.md を参照。 */
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const B = process.env.BASE || 'http://127.0.0.1:8820';
const PW = process.env.ADMIN_PW || 'test1234';
const found = [];
const note = (t, m) => { found.push(`${t}（${m}）`); console.log(`  ❌ ${t} — ${m}`); };
const ok = t => console.log(`  ✅ ${t}`);

/* 前に流した試験の予約が残っていると、空き枠が見つからず失敗します */
await fetch(B + '/exec', { method: 'POST', headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({ type: 'reset' }) }).catch(() => {});

const br = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    /* お客様のスマホは日本時間です。この機械の時間帯のままだと、
       当日の締め切りのような「いま何時か」で変わる判定がずれます。 */
    timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
const p = await ctx.newPage();
let alerted = false;
p.on('dialog', d => { alerted = true; d.dismiss(); });
const errs = [];
p.on('pageerror', e => errs.push(e.message));

console.log('\n【画面】タグを含む文字を入れて予約する');
await p.goto(B + '/reserve.html'); await p.waitForTimeout(1600);
await p.locator('#coupon-choices .selectable').first().click(); await p.waitForTimeout(400);
await p.locator('#step-cta button').click(); await p.waitForTimeout(700);
await p.locator('#step-cta button').click(); await p.waitForTimeout(1100);
await p.locator('button[data-date][data-time]:not([disabled])').nth(40).click(); await p.waitForTimeout(400);
await p.locator('#step-cta button').click(); await p.waitForTimeout(600);
await p.fill('#f-name', '<img src=x onerror=alert(1)>山田');
await p.fill('#f-kana', 'ヤマダ');
await p.fill('#f-tel', '09098765432');
await p.fill('#f-email', 'x@example.com');
await p.locator('label.radio-chip:has-text("初めて")').first().click();
await p.fill('#f-request', '<script>alert(2)</script>\nよろしく');
await p.locator('#customer-form .checkbox-line > span').click();
await p.locator('#step-cta button').click(); await p.waitForTimeout(800);

const confirmHtml = await p.locator('#confirm-body').innerHTML();
confirmHtml.includes('<img src=x') ? note('確認画面', 'タグが生で埋め込まれている')
  : ok('確認画面ではタグが文字として出る');

await p.locator('#submit-reservation').click(); await p.waitForTimeout(2000);
const code = (await p.locator('#done-code').innerText()).trim();
console.log(`  予約番号: ${code || '（取れず）'}`);
alerted ? note('完了画面', 'スクリプトが動いた') : ok('完了画面でスクリプトは動かない');

console.log('\n【画面】その予約を店側で見る');
const a = await ctx.newPage();
a.on('dialog', d => { alerted = true; d.dismiss(); });
a.on('pageerror', e => errs.push('admin: ' + e.message));
await a.goto(B + '/admin.html'); await a.waitForTimeout(900);
await a.fill('#passcode', PW); await a.locator('#remember-me').setChecked(false);
await a.click('#gate-btn'); await a.waitForTimeout(1800);
const adminHtml = await a.locator('#admin-rows').innerHTML();
adminHtml.includes('<img src=x') ? note('管理ページ 予約一覧', 'タグが生で埋め込まれている')
  : ok('管理ページではタグが文字として出る');
await a.locator('.tab', { hasText: 'お客様' }).first().click(); await a.waitForTimeout(600);
const custHtml = await a.locator('#customer-rows').innerHTML();
custHtml.includes('<img src=x') ? note('お客様タブ', 'タグが生で埋め込まれている')
  : ok('お客様タブでもタグが文字として出る');
alerted ? note('管理ページ', 'スクリプトが動いた') : ok('管理ページでスクリプトは動かない');

console.log('\n【画面】マイページ');
await p.goto(B + '/mypage.html'); await p.waitForTimeout(1400);
const myHtml = await p.locator('#upcoming-list').innerHTML();
myHtml.includes('<img src=x') ? note('予約確認ページ', 'タグが生で埋め込まれている')
  : ok('予約確認ページでもタグが文字として出る');
console.log('  横はみ出し:', await p.evaluate(() => document.documentElement.scrollWidth));

console.log('\n' + '='.repeat(52));
console.log('JSエラー:', errs.length ? errs.slice(0, 3) : 'なし');
if (found.length || errs.length) {
  found.forEach(f => console.log('  ❌ ' + f));
  process.exitCode = 1;
} else {
  console.log('お客様が書いた文字は、どの画面でも文字として出ています');
}
await br.close();
