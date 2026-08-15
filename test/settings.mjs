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

console.log('\n' + '='.repeat(52));
if (problems.length) {
  console.log(`食い違い ${problems.length}件`);
  problems.forEach(p => console.log('  ❌ ' + p));
  process.exitCode = 1;
} else {
  console.log('2か所に書いてある設定は、すべて一致しています');
}
