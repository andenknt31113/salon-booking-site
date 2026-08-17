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

/* ============================================================
   設定シートの項目も、3か所に散っています。

     ・gas/Code.gs の LISTED_SETTINGS   … シートに足す項目と、その初期値
     ・assets/js/admin.js の SETTING_KEYS … 管理ページに並ぶ入力欄
     ・assets/js/common.js の applySettings … 読み取ってサイトに出す

   名前が1文字でも食い違うと、店主は「入れて保存した」のに何も変わりません。
   保存はできているので、画面にも受け口にも何のしるしも出ません。
   いちばん気づけない壊れ方なので、ここで突き合わせます。
   ============================================================ */
console.log('\n【設定シートの項目】管理ページ・シート・サイトで同じ名前か');

/* admin.js / common.js を、ブラウザのふりをして読み込みます。
   名前を正規表現で拾うと、書き方を変えたときに黙って素通りするためです。 */
function browserBox() {
  const el = () => ({
    innerHTML: '', textContent: '', style: {}, dataset: {}, value: '', hidden: false,
    classList: { add(){}, remove(){}, toggle(){} },
    addEventListener() {}, appendChild() {}, remove() {}, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML() {},
    setAttribute() {}, getAttribute: () => null
  });
  const doc = {
    addEventListener() {}, dispatchEvent() {}, createElement: el,
    querySelector: () => null, querySelectorAll: () => [],
    body: el(), head: el(), title: ''
  };
  return {
    document: doc, window: {}, console: { log(){}, warn(){}, error(){}, info(){} },
    location: { pathname: '/index.html', origin: 'http://x', href: 'http://x/' },
    localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    fetch: () => Promise.reject(new Error('つなぎません')),
    CustomEvent: class { constructor(t) { this.type = t; } },
    setTimeout, clearTimeout, Set, Map, WeakMap, JSON, Math, Date, Number, String, Array, Object
  };
}

/** data.js + common.js（＋任意で admin.js）を読んだ箱を返す */
function loadSite(withAdmin = false) {
  const box = browserBox();
  vm.createContext(box);
  vm.runInContext(dataSrc, box);
  vm.runInContext(readFileSync(join(R, 'assets', 'js', 'common.js'), 'utf8'), box);
  if (withAdmin) vm.runInContext(readFileSync(join(R, 'assets', 'js', 'admin.js'), 'utf8'), box);
  return box;
}

/* Code.gs の LISTED_SETTINGS は、中で SALON_TEL などの定数を参照しているので、
   配列だけ取り出しても評価できません。定数ごと読み込んで取り出します。 */
function gasSettings() {
  const box = { console: { log(){}, warn(){}, error(){} } };
  vm.createContext(box);
  const consts = gas.match(/const\s+(SALON_TEL|SALON_ADDRESS|NOTIFY_EMAIL|CANCEL_DEADLINE_DAYS_BEFORE|CANCEL_DEADLINE_HOUR|CANCEL_DEADLINE_KEYS)\s*=[^\n]*\n/g) || [];
  const arr = gas.match(/const\s+LISTED_SETTINGS\s*=\s*(\[[\s\S]*?\n\];)/);
  if (!arr) return null;
  vm.runInContext(consts.join('') + 'const LISTED_SETTINGS = ' + arr[1]
    + ';globalThis.__s = LISTED_SETTINGS;', box);
  return box.__s;
}

const sheetSettings = gasSettings();
{
  /* const で書かれた一覧は、箱の外から名前で引けません（グローバル変数に
     ならないため）。中で評価して取り出します。 */
  const adminBox = loadSite(true);
  vm.runInContext('globalThis.__keys = SETTING_KEYS.map(f => f.key);', adminBox);
  const adminKeys = adminBox.__keys || [];

  if (!sheetSettings) {
    problems.push('Code.gs の LISTED_SETTINGS が読めない');
    console.log('  ❌ Code.gs 側の設定一覧が見つかりません');
  } else if (!adminKeys.length) {
    problems.push('admin.js の SETTING_KEYS が読めない');
    console.log('  ❌ 管理ページ側の項目一覧が見つかりません');
  } else {
    const sheetKeys = sheetSettings.map(r => r[0]);
    const missing = adminKeys.filter(k => sheetKeys.indexOf(k) < 0);
    const extra = sheetKeys.filter(k => adminKeys.indexOf(k) < 0);
    console.log(`  ${!missing.length ? '✅' : '❌'} 管理ページの項目が、すべてシートにある（${adminKeys.length}件）`);
    if (missing.length) {
      problems.push('シートに無い項目が管理ページにある：' + missing.join('／')
        + '（入れて保存しても、何も起きません）');
    }
    console.log(`  ${!extra.length ? '✅' : '❌'} シートの項目が、すべて管理ページにある`);
    if (extra.length) {
      problems.push('管理ページに出ていない項目がシートにある：' + extra.join('／')
        + '（店主には触れません）');
    }
    console.log(`  ${adminKeys.length === new Set(adminKeys).size ? '✅' : '❌'} 同じ名前の欄が2つない`);
    if (adminKeys.length !== new Set(adminKeys).size) {
      problems.push('管理ページに同じ名前の欄が2つある（あとの欄が先の欄を上書きします）');
    }
  }
}

/* シートの初期値は、いまサイトに出ている内容そのものでなければなりません。
   空で足すと、店主が電話番号だけ直して保存した瞬間に、触っていない住所や
   支払い方法まで空欄として保存され、サイトから消えます。 */
console.log('\n【設定シートの初期値】いまサイトに出ている内容と同じか');
if (sheetSettings) {
  const seed = {};
  sheetSettings.forEach(r => { seed[r[0]] = r[1]; });
  const staff = SALON.staff[0] || {};
  const pairs = [
    ['準備中の帯', SALON.draft ? '出す' : '出さない'],
    ['準備中の文言', SALON.draftNote],
    ['電話番号', SALON.tel],
    ['営業開始', SALON.business.openTime],
    ['営業終了', SALON.business.closeTime],
    ['最終受付', SALON.business.lastOrder],
    ['変更・キャンセル期限（何日前）', SALON.business.cancelDeadline.daysBefore],
    ['変更・キャンセル期限（何時）', SALON.business.cancelDeadline.hour],
    ['キャッチコピー', SALON.catch],
    ['店の紹介文', SALON.description],
    ['こだわり条件', SALON.features.join('\n')],
    ['住所', SALON.address],
    ['地図の検索文字列', SALON.mapQuery],
    ['アクセス', SALON.access],
    ['道案内', SALON.directions],
    ['駐車場', SALON.parking],
    ['支払い方法', SALON.payment],
    ['席数', SALON.seats],
    ['スタッフの肩書き', staff.role],
    ['スタッフの経験年数', staff.years],
    ['スタッフの得意分野', (staff.tags || []).join('\n')],
    ['スタッフの紹介文', staff.message]
  ];
  pairs.forEach(([key, value]) => {
    const same = String(seed[key]) === String(value);
    console.log(`  ${same ? '✅' : '❌'} ${key}`);
    if (!same) {
      console.log('     画面 ' + JSON.stringify(String(value)).slice(0, 90));
      console.log('     シート ' + JSON.stringify(String(seed[key])).slice(0, 90));
      problems.push(`設定シートの初期値「${key}」が data.js と違う`
        + '（シートを作った日に、サイトの掲載内容が入れ替わります）');
    }
  });
}

/* ============================================================
   予約の入口の言葉も、2か所にあります。

     ・assets/js/common.js の SOURCE_LABELS … 画面が控えて、送る言葉
     ・gas/Code.gs の SOURCE_LABELS         … 受け口が台帳に書いてよい言葉

   受け口は一覧に無い言葉を捨てます（公開されている入口なので、
   自由に書ける欄にはできません）。ですから片方に言葉を足しただけだと、
   その入口だけ、いつまでも空欄のまま記録されません。しかも予約は
   ふつうに通るので、店にも何のしるしも出ません。
   ============================================================ */
console.log('\n【予約の入口】画面が送る言葉と、受け口が受け取る言葉が同じか');
{
  const box = loadSite();
  vm.runInContext('globalThis.__src = SOURCE_LABELS.slice();', box);
  const site = box.__src || [];
  const m = gas.match(/const\s+SOURCE_LABELS\s*=\s*(\[[\s\S]*?\]);/);
  const back = m ? vm.runInNewContext('(' + m[1] + ')') : null;

  if (!site.length) {
    problems.push('common.js の SOURCE_LABELS が読めない');
    console.log('  ❌ 画面側の一覧が見つかりません');
  } else if (!back) {
    problems.push('Code.gs の SOURCE_LABELS が読めない');
    console.log('  ❌ 受け口側の一覧が見つかりません');
  } else {
    const same = site.join('|') === back.join('|');
    console.log(`  ${same ? '✅' : '❌'} 入口の言葉が同じ（${site.length}件）`);
    if (!same) {
      console.log('     画面 ' + site.join('／'));
      console.log('     受け口 ' + back.join('／'));
      problems.push('予約の入口の言葉が食い違う'
        + '（その入口からの予約だけ、台帳の欄が空のままになります）');
    }
    /* 店が配る印（?from=…）の言葉が一覧から漏れていると、
       配ったリンクからの予約だけが記録されません。 */
    vm.runInContext('globalThis.__marks = VISIT_SOURCES.map(s => s.label);', box);
    const marks = box.__marks || [];
    const lost = marks.filter(k => back.indexOf(k) < 0);
    console.log(`  ${!lost.length ? '✅' : '❌'} 店が配る印が、すべて受け口の一覧にある`);
    if (lost.length) {
      problems.push('受け口が受け取らない印を配ろうとしている：' + lost.join('／'));
    }
    /* 印の記号（from の値）が重なっていると、あとの1つが先の1つを隠します */
    vm.runInContext('globalThis.__keys2 = VISIT_SOURCES.map(s => s.key);', box);
    const keys = box.__keys2 || [];
    console.log(`  ${keys.length === new Set(keys).size ? '✅' : '❌'} 同じ印が2つない`);
    if (keys.length !== new Set(keys).size) problems.push('?from= の記号が重なっている');
  }
}

/* ============================================================
   変更・キャンセルの受付期限は、画面と受け口の両方が判定します。
   同じシートを読ませて、同じ答えになることを確かめます。
   ここが割れると、画面では変更できるのに送ると断られます。
   ============================================================ */
console.log('\n【受付期限】同じ設定シートから、画面側と受け口側が同じ値を読むか');
{
  /* Code.gs の cancelDeadline_ を、設定シートだけの偽スプレッドシートで呼びます */
  const gasDeadline = rows => {
    const sheet = {
      getLastRow: () => rows.length + 1,
      getLastColumn: () => 2,
      getRange: (row, col, nr, nc) => ({
        getValues: () => [['項目', '内容']].concat(rows)
          .slice(row - 1, row - 1 + (nr || 1)).map(r => r.slice(col - 1, col - 1 + (nc || 2)))
      })
    };
    const box = {
      console: { log(){}, warn(){}, error(){} },
      SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) }
    };
    vm.createContext(box);
    vm.runInContext(gas + ';globalThis.__d = cancelDeadline_();', box);
    return box.__d;
  };
  /* 画面側の applySettings を、同じ内容で呼びます */
  const siteDeadline = rows => {
    const box = loadSite();
    const st = {};
    rows.forEach(r => { st[r[0]] = r[1]; });
    vm.runInContext('applySettings(' + JSON.stringify(st) + ');'
      + 'globalThis.__d = SALON.business.cancelDeadline;', box);
    return box.__d;
  };

  const K = ['変更・キャンセル期限（何日前）', '変更・キャンセル期限（何時）'];
  const cases = [
    ['シートに何も無い（設置直後）', [], { daysBefore: 1, hour: 18 }],
    ['店主が2日前の12時に変えた', [[K[0], 2], [K[1], 12]], { daysBefore: 2, hour: 12 }],
    ['当日まで受け付ける（0日前）', [[K[0], 0], [K[1], 9]], { daysBefore: 0, hour: 9 }],
    ['全角で打った', [[K[0], '２'], [K[1], '１２']], { daysBefore: 2, hour: 12 }],
    ['空欄に戻した', [[K[0], ''], [K[1], '']], { daysBefore: 1, hour: 18 }],
    ['ありえない値（99時）', [[K[0], 1], [K[1], 99]], { daysBefore: 1, hour: 18 }],
    ['数字ですらない', [[K[0], 'あした'], [K[1], 'ゆうがた']], { daysBefore: 1, hour: 18 }]
  ];
  cases.forEach(([label, rows, want]) => {
    const site = siteDeadline(rows);
    const back = gasDeadline(rows);
    const s = `${site.daysBefore}日前の${site.hour}時`;
    const b = `${back.daysBefore}日前の${back.hour}時`;
    const w = `${want.daysBefore}日前の${want.hour}時`;
    const okBoth = s === b && s === w;
    console.log(`  ${okBoth ? '✅' : '❌'} ${label}：画面 ${s} ／ 受け口 ${b}`);
    if (s !== b) {
      problems.push(`受付期限「${label}」で画面と受け口が食い違う`
        + '（画面では変更できるのに、送ると断られます）');
    } else if (s !== w) {
      problems.push(`受付期限「${label}」の読み方がおかしい（期待 ${w} ／ 実際 ${s}）`);
    }
  });
}

console.log('\n' + '='.repeat(52));
if (problems.length) {
  console.log(`食い違い ${problems.length}件`);
  problems.forEach(p => console.log('  ❌ ' + p));
  process.exitCode = 1;
} else {
  console.log('2か所に書いてある設定は、すべて一致しています');
}
