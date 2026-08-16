/* 2か所に書いてある設定が、食い違っていないかを見る試験。

   このサイトは、画面側（assets/js/data.js）と受け口側（gas/Code.gs）の
   2つに分かれています。Apps Script からは data.js を読めないので、
   受付日数や締切時刻のような「同じでなければならない値」は、
   両方に書いてあります。

   片方だけ直すと、画面では取れるのに送ると断られる、という
   お客様にはどうしようもない失敗になります。しかも画面は正しく見えるので、
   店の人も気づけません。ここで毎回突き合わせておきます。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const gas = readFileSync(join(R, 'gas', 'Code.gs'), 'utf8');

/* data.js は画面用の書き方（const SALON = {...}）なので、
   そのまま読み込んで中身を取り出します。 */
const dataSrc = readFileSync(join(R, 'assets', 'js', 'data.js'), 'utf8');
const box = { window: {}, document: { addEventListener() {} } };
vm.createContext(box);
vm.runInContext(dataSrc + ';globalThis.__salon = SALON;', box);
const SALON = box.__salon;

/* Code.gs の const を、動かさずに読み取ります */
function gasConst(name) {
  const m = gas.match(new RegExp('const\\s+' + name + "\\s*=\\s*'?([^;']+)'?\\s*;"));
  return m ? m[1].trim() : null;
}
const num = name => Number(gasConst(name));

/* Code.gs に書いてある配列（掲載メニューの一覧）を、動かさずに読み取ります。
   どれも「const 名前 = [ … 改行 ];」の形なので、そこだけ取り出して評価します。 */
function gasArray(name) {
  const m = gas.match(new RegExp('const\\s+' + name + '\\s*=\\s*(\\[[\\s\\S]*?\\n\\]);'));
  return m ? vm.runInNewContext('(' + m[1] + ')') : null;
}

/* シートの価格欄は「4000〜」のように文字でも書けます（gas の parsePrice_ と同じ読み方）。
   全角チルダ「～」は parsePrice_ が「〜から」と読まないので、ここでも読みません。
   そうしておかないと、試験は通るのに画面だけ「¥4,000」と言い切ってしまいます。 */
function sheetPrice(v) {
  const s = String(v == null ? '' : v);
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return { value: isNaN(n) || !n ? 0 : n, from: /[〜~]/.test(s) };
}

const problems = [];
const check = (label, siteValue, gasValue, why) => {
  const same = String(siteValue) === String(gasValue);
  console.log(`  ${same ? '✅' : '❌'} ${label}：画面 ${siteValue} ／ 受け口 ${gasValue}`);
  if (!same) problems.push(`${label}（${why}）`);
};

console.log('\n【2か所に書いてある設定】画面側と受け口側で同じか');
check('何日先まで予約できるか', SALON.business.bookableDays, num('BOOKABLE_DAYS'),
  '画面では選べるのに、送ると断られます');
check('営業開始', SALON.business.openTime, gasConst('DEFAULT_OPEN'),
  '朝いちばんの枠が、画面には出るのに取れなくなります');
check('営業終了', SALON.business.closeTime, gasConst('DEFAULT_CLOSE'),
  '最後の枠が、画面には出るのに取れなくなります');
check('当日予約の締め切り（何時間前）', SALON.business.minLeadHours, num('MIN_LEAD_HOURS'),
  '画面には出ている枠が、送ると断られます');
check('変更・キャンセルの締切（何日前）', SALON.business.cancelDeadline.daysBefore,
  num('CANCEL_DEADLINE_DAYS_BEFORE'), '画面では変更できるのに、送ると断られます');
check('変更・キャンセルの締切（何時）', SALON.business.cancelDeadline.hour,
  num('CANCEL_DEADLINE_HOUR'), '締切の案内文と、実際の締切がずれます');
check('店の電話番号', SALON.tel, gasConst('SALON_TEL'),
  'メールの署名だけ古い番号になります');
check('担当の名前', SALON.staff[0] && SALON.staff[0].name, gasConst('SALON_STAFF_NAME'),
  '電話で入れた予約の担当名が、サイトの表記と変わります');
check('担当のID', SALON.staff[0] && SALON.staff[0].id, gasConst('SALON_STAFF_ID'),
  '電話予約が空席計算に入らず、同じ時間にネット予約が入ります');
/* サイトは「ZER01」と「barber/lounge」を分けて持っています（ロゴの組み方のため）。
   メールの差出人はひと続きの店名なので、つなげたものと比べます。 */
check('店の名前', [SALON.name, SALON.nameSub].filter(Boolean).join(' '), gasConst('SALON_NAME'),
  'メールの差出人と、サイトの店名が変わります');

console.log('\n【席の数】');
{
  const seats = num('SEATS');
  const staff = SALON.staff.length;
  console.log(`  受け口の席数 ${seats} ／ 画面のスタッフ ${staff}名`);
  if (seats > staff) {
    problems.push('席数がスタッフ数より多い（同時に受けられない予約が入ります）');
    console.log('  ❌ 席のほうが多い');
  } else {
    console.log('  ✅ 席の数はスタッフ数を超えていない');
  }
}

console.log('\n【受け口の場所】');
{
  /* reservationEndpoint が空のあいだ、サイトはこの端末の中だけで動きます。
     公開前に入れ忘れると、予約が誰にも届きません。 */
  const url = String(SALON.reservationEndpoint || '');
  if (!url) {
    console.log('  ⚠ まだ受け口（Apps Script のURL）が入っていません。');
    console.log('    このままでも画面は動きますが、予約は店に届きません。');
    console.log('    Apps Script を入れたら assets/js/data.js の reservationEndpoint に貼ってください。');
  } else if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    problems.push('受け口のURLの形が違う（末尾は /exec です）');
    console.log('  ❌ URLの形が違います：' + url);
  } else {
    console.log('  ✅ 受け口のURLが入っています');
  }
}

/* ============================================================
   掲載メニューも2か所にあります。

   画面は最初 data.js の内容を描き、そのあとシート（Code.gs が書いた内容）が
   届くと描き直します。2つがずれていると、開いた直後と数秒後で値段が変わります。
   お客様は自分が何を見たのか分からなくなり、店の人にも再現できません。
   ============================================================ */
console.log('\n【掲載メニュー】画面側（data.js）と、シートに書き込む側（Code.gs）で同じか');
{
  const gasMenus = gasArray('LISTED_MENUS');
  const gasCoupons = gasArray('LISTED_COUPONS');
  const gasStyles = gasArray('LISTED_STYLES');

  const same = (label, a, b, why) => {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) {
      console.log('     画面 ' + JSON.stringify(a));
      console.log('     受け口 ' + JSON.stringify(b));
      problems.push(`${label}（${why}）`);
    }
  };

  if (!gasMenus || !gasCoupons || !gasStyles) {
    problems.push('Code.gs の掲載メニュー一覧（LISTED_MENUS / LISTED_COUPONS / LISTED_STYLES）が読めない');
    console.log('  ❌ Code.gs 側の一覧が見つかりません');
  } else {
    /* 単品メニュー：区分・名前・価格（「〜から」かどうかも）・所要・説明 */
    const siteMenus = SALON.menuCategories.flatMap(c => c.items.map(m =>
      [c.name, m.name, Number(m.price) || 0, !!m.priceFrom, m.minutes, m.note || '']));
    const sheetMenus = gasMenus.map(r => {
      const p = sheetPrice(r[2]);
      return [r[0], r[1], p.value, p.from, r[3], r[4] || ''];
    });
    same('単品メニュー9件（区分・名前・価格・所要・説明）', siteMenus, sheetMenus,
      '開いた直後と数秒後で、メニューの値段や説明が変わります');

    /* おすすめメニュー：名前・価格・「〜から」・所要 */
    const siteCoupons = SALON.coupons.map(c =>
      [c.title, Number(c.price) || 0, !!c.priceFrom, c.minutes]);
    const sheetCoupons = gasCoupons.map(r => {
      const p = sheetPrice(r[1]);
      return [r[0], p.value, p.from, r[2]];
    });
    same('おすすめメニュー14件（名前・価格・所要）', siteCoupons, sheetCoupons,
      '開いた直後と数秒後で、おすすめメニューの値段が変わります');

    /* スタイル：タイトル・分類（絞り込みタブ）・タグ・説明 */
    const siteStyles = SALON.styles.map(s => [s.title, s.length, s.tags.join(','), s.detail || '']);
    const sheetStyles = gasStyles.map(r => [r[0], r[1], r[2], r[3] || '']);
    same('スタイル12件（タイトル・分類・タグ・説明）', siteStyles, sheetStyles,
      'ギャラリーの絞り込みタブと説明文が、シートを読んだ瞬間に入れ替わります');

    /* 価格が空の行は「お見積り」として出ます。0円と書いてしまうと
       無料だと誤解されます（景品表示法の有利誤認）。 */
    const zeroSite = SALON.coupons.filter(c => c.price === 0).map(c => c.title);
    const zeroSheet = gasCoupons.filter(r => r[1] === 0).map(r => r[0]);
    console.log(`  ${zeroSite.length + zeroSheet.length === 0 ? '✅' : '❌'} 価格に 0 を書いていない（空欄＝お見積り）`);
    if (zeroSite.length || zeroSheet.length) {
      problems.push('価格に 0 が入っている（無料だと誤解されます）：'
        + zeroSite.concat(zeroSheet).join('／'));
    }
  }
}

console.log('\n' + '='.repeat(52));
if (problems.length) {
  console.log(`食い違い ${problems.length}件`);
  problems.forEach(p => console.log('  ❌ ' + p));
  process.exitCode = 1;
} else {
  console.log('2か所に書いてある設定は、すべて一致しています');
}
