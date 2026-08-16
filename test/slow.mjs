/* 通信が遅いとき、画面に何が出るか。

   Apps Script は久しぶりの呼び出しだと応答に数秒かかることがある。
   そのあいだ画面が空白だと、LINEから来た方はそのまま離れてしまう。
   「取得を待たずに、掲載中の内容で先に描けているか」を見る。 */
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const B = process.env.BASE || 'http://127.0.0.1:8820';
const post = b => fetch(B + '/exec', { method:'POST', headers:{'Content-Type':'text/plain'}, body: JSON.stringify(b) }).then(r=>r.json());

const br = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const p = await (await br.newContext({ viewport:{width:390,height:844}, isMobile:true, timezoneId:'Asia/Tokyo', locale:'ja-JP' })).newPage();

async function look(page, label) {
  const t0 = Date.now();
  await p.goto(B + '/' + page, { waitUntil: 'domcontentloaded' });
  // 500ms 後（＝まだ応答が返っていないタイミング）に何が見えているか
  await p.waitForTimeout(500);
  const early = await p.evaluate(() => ({
    見えている文字数: (document.body.innerText || '').replace(/\s/g,'').length,
    見出し: (document.querySelector('h1, .hero h1, #hero-catch') || {}).innerText || '(なし)',
    予約ボタン: document.querySelectorAll('a[href*="reserve"], #submit-reservation').length,
    メニュー件数: document.querySelectorAll('.coupon, .menu-row, .selectable').length
  }));
  await p.waitForTimeout(3000);
  const late = await p.evaluate(() => ({
    見えている文字数: (document.body.innerText || '').replace(/\s/g,'').length,
    メニュー件数: document.querySelectorAll('.coupon, .menu-row, .selectable').length
  }));
  console.log(`\n[${label}] ${page}`);
  console.log('  0.5秒後:', JSON.stringify(early));
  console.log('  3.5秒後:', JSON.stringify(late));
  // 応答を待つあいだも、読めるものが出ていること
  if (early.見えている文字数 < 300) problems.push(`${label} ${page}: 0.5秒後の表示が少なすぎる`);
  if (early.メニュー件数 === 0) problems.push(`${label} ${page}: 0.5秒後にメニューが1件も出ていない`);
}

const problems = [];
console.log('=== 通信が正常なとき ===');
await post({ type:'slowmode', ms:0 });
for (const pg of ['index.html','menu.html','reserve.html']) await look(pg, '正常');

console.log('\n\n=== 応答に2.5秒かかるとき（電波の悪い場所） ===');
await post({ type:'slowmode', ms:2500 });
for (const pg of ['index.html','menu.html','reserve.html']) await look(pg, '遅い');

await post({ type:'slowmode', ms:0 });
await br.close();

console.log('\n' + '='.repeat(52));
if (problems.length) {
  console.log('見つかった問題:\n  ' + problems.join('\n  '));
  process.exitCode = 1;
} else {
  console.log('遅いときも、待たずに読める内容が出ている');
}
