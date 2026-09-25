/* ============================================================
 *  管理ページ
 *
 *  パスワードはサイトのソースには持たせず、入力された値を
 *  Google Apps Script 側に送って照合します。
 *  （スクリプトプロパティ ADMIN_PASSWORD に保存）
 *  そのため、ソースを読まれてもパスワードは分かりません。
 * ============================================================ */

let adminPw = '';          // 入力されたパスワード（この画面を開いている間だけ保持）
let adminToken = '';       // 「この端末を記憶する」で受け取った合鍵
let adminData = null;      // 取得した内容
const PHONE_TIME_STEP_MINUTES = 10;
const MINUTES_PER_DAY = 24 * 60;
const PHONE_REQUEST_KEY_PREFIX = 'zer01-phone-request:';
const PHONE_REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{16,80}$/;
let phoneRequestId = '';
let phoneSubmitting = false;
let phoneUncertain = false;
let phoneConflict = false;
let phonePayload = null;
let phonePresets = [];
let phonePriceNeedsInput = false;
let activeChange = null;
/* 読み込んだ時点のシートの印。保存時に送って、
   そのあいだに別の端末から保存されていないかを見てもらう。 */
let stamps = {};
const edits = { closed: [], menus: [], coupons: [], styles: [], reviews: [], settings: {} };

/* いま入力欄を開いている行（メニュー・おすすめメニュー・写真）。
   -1 なら一覧だけ。

   なぜ「1件だけ」か：以前はメニュー4件ぶんの入力欄が縦に全部並んでいて、
   単品メニューのタブは3648pxありました（画面は844px）。
   どんなメニューがあるのかを見るだけでも、全項目を読みながら
   何度も指を送ることになり、直したい1件を探せませんでした。 */
const openRow = { menus: 0, coupons: 0, styles: 0 };

/* 読み込んだ時点の中身。「まだ保存していない」を出すために使います。

   保存は「edits に溜めて、保存ボタンで一括」です。1件直して一覧に戻ると
   見た目は落ち着くので、そこで手が離れて保存を押し忘れます。
   押し忘れたまま画面を閉じると、直した値段は消えて元のままになります。

   行そのもの（オブジェクト）を鍵にします。番号で覚えると、
   途中で1件消したときに残りの行の番号がずれ、直していない行まで
   「未保存」と出て、どれを直したのか分からなくなります。 */
const rowBase = new WeakMap();
const baseCount = {};
let settingsBase = '';
/* 保存できたことを、そのタブの保存バーに残しておくための控え */
const savedNote = {};
const pendingSaves = new Set();

/* 記憶した合鍵の置き場所。パスワードそのものは保存しません。
   合鍵は Apps Script 側で発行・失効させるため、盗まれても店側で無効にできます。 */
const TOKEN_KEY = 'salon.adminToken.v1';

/* 休業日は「終日」と「この時間帯だけ」の両方を扱います。
   開始・終了が空なら終日、入っていればその帯だけ止まります。 */
const CLOSED_COLS = ['休業日', '開始', '終了', 'メモ'];
const MENU_COLS = ['区分', 'メニュー名', '価格', '所要(分)', '説明', '画像', '表示'];
const COUPON_COLS = ['メニュー名', '価格', '通常価格', '所要(分)', '説明', '条件', '対象', '画像', '表示'];
const STYLE_COLS = ['タイトル', '分類', 'タグ', '説明', '画像', '表示'];
/* 「店舗情報」タブに並べる項目。

   ひとつながりに並べていたころは11項目でした。いまは34項目あります。
   そのまま縦に並べると、390pxの画面では目的の欄にたどり着けません
   （電話番号を直すのに、住所も紹介文も通り過ぎることになります）。
   見出しで区切り、畳んでおきます。畳んでおけば、タブを開いた最初の画面が
   「何がどこにあるか」の目次になります。

   blank は、その欄を空にしたときどうなるかです。画面にもそのまま出します。
     'clear' … サイトから消える（いちど入れた案内を、消せるようにするため）
     'keep'  … いま出ている内容のまま（空だと予約の枠が作れない、
               あるいはお客様の連絡先が画面から消えてしまう項目）
   読み取り側は common.js の applySettings と対になっています。 */
const SETTING_SECTIONS = [
  {
    title: 'ネット予約の受付',
    note: '新規ネット予約の受付設定です。「出す」の間は新規予約を断ります。公開ページの帯や文章は別途更新が必要です。',
    fields: [
      { key: '準備中の帯', type: 'choice', choices: ['出す', '出さない'],
        current: () => (SALON.draft ? '出す' : '出さない'),
        hint: '「出さない」を保存すると、新規ネット予約を受け付けます。営業用の準備と動作確認が済むまで変更しないでください。' },
      { key: '準備中の文言', type: 'textarea', blank: 'keep',
        hint: '帯に出る文です。お客様が読みます。店への申し送りは書かないでください。' }
    ]
  },
  {
    title: 'お知らせ・ご連絡先',
    fields: [
      { key: 'お知らせ', type: 'text', blank: 'clear',
        hint: 'トップの上部に帯で出ます。「◯日は休みます」など。' },
      { key: '電話番号', type: 'tel', blank: 'keep',
        hint: '例）0297-00-0000。お客様の連絡先なので、ここは空にしても消えません。' },
      { key: '通知先メール', type: 'text', blank: 'clear',
        hint: 'ご予約が入ったときに知らせるメールアドレス。複数入れるときはカンマで区切ります'
          + '（例）tenshu@example.com, staff@example.com'
          + '　★空欄にすると、ご予約が入っても誰にも届きません' },
      { key: 'LINE友だち追加URL', type: 'url', blank: 'clear',
        hint: 'LINE公式アカウントの「友だち追加」URL（https://lin.ee/… ）。'
          + '入れると予約完了画面とフッターに案内が出ます。' },
      { key: 'Google口コミURL', type: 'url', blank: 'clear',
        hint: 'Googleビジネスプロフィールの「クチコミを書く」URL。' }
    ]
  },
  {
    title: '営業時間・ご予約の受付',
    note: 'この4つはお客様が選べる枠に直に効きます。空欄にすると枠が作れないので、'
      + 'いま出ている内容のままになります。',
    fields: [
      { key: '営業開始', type: 'time', blank: 'keep' },
      { key: '営業終了', type: 'time', blank: 'keep' },
      { key: '最終受付', type: 'time', blank: 'keep', hint: '最後に施術を始められる時刻です。' },
      { key: '定休曜日', type: 'weekdays' },
      /* 受付期限は、この2行が唯一の置き場所です。画面もApps Scriptも
         ここを読むので、片方だけ変わることが起きません。 */
      { key: '変更・キャンセル期限（何日前）', type: 'number', blank: 'keep', min: 0, max: 30,
        hint: 'お客様がネットで変更・キャンセルできる期限。1なら前日、2なら2日前です。' },
      { key: '変更・キャンセル期限（何時）', type: 'number', blank: 'keep', min: 0, max: 23,
        hint: 'その日の何時までかを 0〜23 で入れます（18なら18時まで）。' }
    ]
  },
  {
    title: 'お店の紹介',
    fields: [
      { key: 'キャッチコピー', type: 'textarea', blank: 'keep',
        hint: 'トップの大見出しに出ます。' },
      { key: '店の紹介文', type: 'textarea', blank: 'clear',
        hint: 'キャッチコピーの下に出る、お店の紹介です。' },
      { key: 'こだわり条件', type: 'textarea', blank: 'clear', rows: 8,
        hint: '1行に1つずつ書いてください。店舗情報の表に「／」でつないで出ます。' }
    ]
  },
  {
    title: '場所・行き方',
    note: '移転したときは、この5つを直せば、サイトも地図ボタンも確認メールも変わります。',
    fields: [
      { key: '住所', type: 'text', blank: 'clear' },
      { key: '地図の検索文字列', type: 'text', blank: 'clear',
        hint: '地図ボタンで検索させる文字。部屋番号まで入れると出ないことがあるので、建物名までがおすすめです。' },
      { key: 'アクセス', type: 'textarea', blank: 'clear', hint: '最寄り駅・バス停からの行き方。' },
      { key: '道案内', type: 'textarea', blank: 'clear', rows: 8,
        hint: '改行するとそのまま改行して出ます。' },
      { key: '駐車場', type: 'text', blank: 'clear' }
    ]
  },
  {
    title: '店内・お支払い',
    fields: [
      { key: '支払い方法', type: 'textarea', blank: 'clear',
        hint: 'PayPay を入れたときなどは、ここに書き足してください。' },
      { key: '席数', type: 'text', blank: 'clear',
        hint: '店舗情報の表に出る文字です。同時にお受けできる人数は変わりません。' }
    ]
  },
  {
    title: 'スタッフ紹介',
    fields: [
      { key: 'スタッフの肩書き', type: 'text', blank: 'clear', hint: 'お名前の上に出ます。' },
      { key: 'スタッフの経験年数', type: 'number', blank: 'clear', min: 0, max: 80,
        hint: '「経験6年」と出ます。1年経ったら直してください。' },
      { key: 'スタッフの得意分野', type: 'textarea', blank: 'clear', rows: 7,
        hint: '1行に1つずつ書いてください。札になって並びます。' },
      { key: 'スタッフの紹介文', type: 'textarea', blank: 'clear', rows: 8 },
      { key: 'スタッフ写真', type: 'image', blank: 'keep', hint: 'スタッフ紹介に出る写真。' }
    ]
  },
  {
    title: '写真',
    fields: [
      { key: 'ロゴ画像', type: 'image', blank: 'keep',
        hint: 'ヘッダーとトップに出るロゴ。写真を選ぶと自動で入ります。' },
      { key: 'メイン写真', type: 'image', blank: 'keep',
        hint: 'トップの一番上に大きく出る写真。店内や施術中の写真がおすすめです。' }
    ]
  },
  {
    title: '事業者の情報（プライバシーポリシー）',
    note: 'お客様のお名前・電話番号・メールをお預かりしています。'
      + '誰が預かっているのかを書かないまま公開することはできません。ここは必ず埋めてください。',
    fields: [
      { key: '事業者名', type: 'text', blank: 'clear', hint: '屋号または法人名。' },
      { key: '代表者名', type: 'text', blank: 'clear' },
      { key: '問い合わせ先メール', type: 'text', blank: 'clear',
        hint: '開示・削除のご請求先として出ます。上の「通知先メール」と同じで構いません。' },
      { key: 'プライバシーポリシー制定日', type: 'text', blank: 'clear', hint: '例）2026年8月15日' }
    ]
  },
  {
    /* この2つはお客様の画面には出ません。「数字」タブの計算にだけ使います。
       率も掲載料も契約プランごとに違うので、こちらでは何も置きません。
       入るまで、数字タブは金額を1円も出しません。 */
    title: 'ホットペッパーとの比較',
    note: '掲載を続けるかどうかを、勘ではなく数字で決めるための欄です。'
      + '2つともホットペッパーからの請求明細に書いてあります。'
      + '入れると「数字」タブに、今月いくら手数料を払わずに済んだかが出ます。'
      + '入れるまでは金額を出しません（こちらで数字を作らないためです）。',
    fields: [
      { key: 'ホットペッパー手数料率（％）', type: 'number', blank: 'clear', min: 0, max: 100,
        hint: '予約1件の売上のうち、手数料として引かれる割合。'
          + '請求明細の送客手数料を、その月の該当売上で割った値でかまいません。' },
      { key: 'ホットペッパー掲載料（月額・円）', type: 'number', blank: 'clear', min: 0, max: 10000000,
        hint: '毎月かかる掲載料。予約が0件でもかかる分です。手数料とは別に請求されています。' }
    ]
  }
];

/* 上の全項目を、順番のまま平らにしたもの。
   保存する中身と、設定シート側（gas/Code.gs の LISTED_SETTINGS）の
   突き合わせに使います（test/settings.mjs）。 */
const SETTING_KEYS = SETTING_SECTIONS.reduce((all, s) => all.concat(s.fields), []);

/* キャンセルかどうか。台帳には「取消」「キャンセル済」などの書き方のゆれがありますが、
   受信先が「キャンセル」にそろえて返してくれるので、見るのはここだけで済みます。
   一覧・統計・カレンダーで別々に書くと、片方だけ直したときに食い違って、
   キャンセル済みの枠が埋まったままに見えます。 */
const isCancelled = r => r.status === 'キャンセル';

/* ---------- 受信先とのやりとり ---------- */
function adminTransportError(payload, httpStatus = 0) {
  const detail = httpStatus ? `（HTTP ${httpStatus}）` : '';
  let error = httpStatus
    ? `受け口の応答を確認できません${detail}。登録・保存の結果を確認してください。`
    : '通信に失敗しました。登録・保存の結果が不明な場合は確認してください。';
  if (payload.type === 'adminLogin' || payload.type === 'adminData') {
    const operation = payload.type === 'adminLogin' ? 'ログイン確認' : '管理画面の読み込み';
    error = `${operation}の応答を確認できません${detail}。パスワードの間違いとは限りません。`
      + '時間をおいて1回だけ試し、続く場合はこの文面を制作担当者へ伝えてください。';
  }
  return { ok: false, transportError: true, httpStatus, error };
}

async function adminPost(payload) {
  if (!SALON.reservationEndpoint) {
    return { ok: false, error: '受信先（Google Apps Script）が未設定です。' };
  }
  let httpStatus = 0;
  try {
    const res = await fetch(SALON.reservationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, password: adminPw, token: adminToken })
    });
    httpStatus = res.status;
    if (!res.ok) return adminTransportError(payload, httpStatus);
    const result = await res.json();
    if (!result || typeof result.ok !== 'boolean') return adminTransportError(payload, httpStatus);
    return result;
  } catch (error) {
    return adminTransportError(payload, httpStatus);
  }
}

/* ---------- ログイン ---------- */
function setLoginBusy(busy, message = '確認中…') {
  $('#gate-btn').disabled = busy;
  $('#gate-btn').textContent = busy ? message : 'ログイン';
}

async function login() {
  const btn = $('#gate-btn');
  if (btn.disabled) return;
  const err = $('#gate-error');
  adminPw = $('#passcode').value;
  err.style.display = 'none';

  if (!adminPw) {
    err.textContent = 'パスワードを入力してください。';
    err.style.display = 'block';
    return;
  }

  setLoginBusy(true);
  try {
    const remember = !!($('#remember-me') || {}).checked;
    const res = await adminPost({ type: 'adminLogin', remember });
    if (!res.ok) {
      adminPw = '';
      err.textContent = res.error || 'ログインできませんでした。';
      err.style.display = 'block';
      return;
    }
    if (res.token) {
      adminToken = res.token;
      try { localStorage.setItem(TOKEN_KEY, res.token); } catch (error) {}
    }
    setLoginBusy(true, '予定を読み込み中…');
    await openDashboard();
  } catch (error) {
    err.textContent = '管理画面を開けませんでした。画面を再読み込みし、続く場合は制作担当者へ連絡してください。';
    err.style.display = 'block';
  } finally {
    setLoginBusy(false);
  }
}

async function restoreRememberedLogin(saved) {
  if ($('#gate-btn').disabled) return;
  adminToken = saved;
  const message = $('#gate-message').textContent;
  $('#gate-message').textContent = 'この端末は記憶されています。読み込み中…';
  setLoginBusy(true, '予定を読み込み中…');
  try {
    await openDashboard(true);
  } catch (error) {
    $('#gate-error').textContent = '管理画面を開けませんでした。画面を再読み込みし、続く場合は制作担当者へ連絡してください。';
    $('#gate-error').style.display = 'block';
  } finally {
    $('#gate-message').textContent = message;
    setLoginBusy(false);
  }
}

/** 記憶した合鍵を捨てて、もう一度パスワードを聞く状態に戻す */
function forgetDevice() {
  /* このボタンはタブの列に並んでいます。スマホではタブが折り返して
     すぐ隣に来るので、タブを押したつもりで当たります。
     押した瞬間にパスワードからやり直しになり、
     お客様を待たせている最中だと手が止まります。 */
  if (!confirm('この端末の記憶を消します。次からはパスワードの入力が必要になります。よろしいですか？')) return;
  adminToken = '';
  adminPw = '';
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* noop */ }
  location.reload();
}

async function openDashboard(remembered = false) {
  const res = await adminPost({ type: 'adminData' });
  if (!res.ok) {
    let message = res.error || '読み込みに失敗しました。';
    if (remembered && !res.transportError && res.error === 'パスワードが違います。') {
      adminToken = '';
      try { localStorage.removeItem(TOKEN_KEY); } catch (error) {}
      message = 'この端末の記憶でログインできませんでした。もう一度パスワードを入力してください。';
    }
    /* 開いたあとの読み直し（キャンセルの反映など）で失敗したときは、
       ログイン画面のエラー欄は隠れたままで誰も読めません。
       黙って古い予定を出しておくと、キャンセルが通ったのかどうか
       分からないまま、その枠を空きだと思って別のお客様を入れてしまいます。 */
    if (!$('#dashboard').hidden) {
      alert('最新の予定を読み込めませんでした。\n' + message
        + '\n電波の届くところで、この画面を開き直してください。');
      return false;
    }
    $('#gate-error').textContent = message;
    $('#gate-error').style.display = 'block';
    return false;
  }
  adminData = res;
  edits.closed = (res.closedDates || []).map(r => ({ ...r }));
  showReservationFreshness();
  edits.menus = (res.menus || []).map(r => ({ ...r }));
  edits.coupons = (res.coupons || []).map(r => ({ ...r }));
  edits.styles = (res.styles || []).map(r => ({ ...r }));
  edits.reviews = (res.reviews || []).map(r => ({ ...r }));
  edits.settings = { ...(res.settings || {}) };
  stamps = { ...(res.stamps || {}) };

  /* 読み直したので、前に開いていた行の番号はもう当てになりません。
     先頭に戻します（先頭を開いておく理由は renderList のところに書いています）。 */
  openRow.menus = 0; openRow.coupons = 0; openRow.styles = 0;
  ['closed', 'menus', 'coupons', 'styles', 'reviews', 'settings'].forEach(markSaved);

  $('#gate').hidden = true;
  $('#dashboard').hidden = false;
  renderStats();
  renderReservations();
  /* 前に選んだ見せ方に戻します（初めて開いた端末では一覧）。
     この中でカレンダーも描かれます。 */
  let view = 'list';
  try { view = localStorage.getItem(VIEW_KEY) || 'list'; } catch (e) { /* noop */ }
  setReserveView(view);
  renderCustomers();
  renderNumbers();
  renderClosed();
  renderList('menus');
  renderList('coupons');
  renderList('styles');
  renderReviews();
  renderSettings();
  updateDirty();
  AdminNotifications.start(res.reservations || []);
  await restorePhoneBooking();
  return true;
}

/* ---------- 予約一覧 ---------- */
function filteredReservations() {
  const date = $('#filter-date').value;
  const status = $('#filter-status').value;
  return (adminData.reservations || [])
    .filter(r => !date || r.date === date)
    .filter(r => status === 'all'
      || (status === 'cancelled' ? isCancelled(r) : !isCancelled(r)));
}

function renderStats() {
  const live = (adminData.reservations || []).filter(r => !isCancelled(r));
  const today = toKey(new Date());
  /* 「今後7日間」は今日を1日目に数えます。+7 だと今日を入れて8日分になり、
     売上見込みが1日ぶん多く出ます。仕入れの判断に使う数字なので合わせます。 */
  const week = new Date(); week.setDate(week.getDate() + 6);
  const weekKey = toKey(week);
  const inWeek = live.filter(r => r.date >= today && r.date <= weekKey);

  $('#stats').innerHTML = [
    ['本日のご予約', `${live.filter(r => r.date === today).length}件`],
    ['今後7日間', `${inWeek.length}件`],
    ['7日間の売上見込', yen(inWeek.reduce((s, r) => s + (Number(r.price) || 0), 0))],
    ['キャンセル', `${(adminData.reservations || []).filter(isCancelled).length}件`]
  ].map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
}

/* 日付の見出し。今日・明日は日付より先に、その言葉で分かるようにします */
function dayHeading(date) {
  const today = toKey(new Date());
  const t = new Date(); t.setDate(t.getDate() + 1);
  const tomorrow = toKey(t);
  const label = date === today ? '本日' : date === tomorrow ? '明日' : '';
  return { label, text: formatDateJa(date) };
}

/* 休業日タブで入れた「受けない時間帯」を、その日の予定に混ぜて返します。
   設定したのに予定表に出てこないと、入れたこと自体を忘れて
   「なぜかこの時間だけ予約が来ない」と悩むことになります。 */
function closedBlocksOn(date) {
  return (adminData.closedDates || [])
    .filter(r => r['休業日'] === date && r['開始'] && r['終了'])
    .map(r => ({ 受付停止: true, date, time: r['開始'], endTime: r['終了'], memo: r['メモ'] || '' }));
}
function closedAllDay(date) {
  return (adminData.closedDates || [])
    .some(r => r['休業日'] === date && !(r['開始'] && r['終了']));
}

/* 過ぎたご予約を出しているか。
   日付を選んでいないときは、本日より前を畳んでおきます。
   台帳は消さずに溜まっていくので、半年も使えば古い日が何十件も先に並び、
   本日にたどり着くまで指を動かし続けることになります。
   この画面の主な使い方は、朝いちばんに「今日は何時から何件か」を見ることです。 */
let showPast = false;
let renderedReservationFilters = {};
let renderedCustomerFilters = {};

function renderReservations() {
  reconcilePhoneResult();
  renderMailAlert();
  if (!guardNoteFilters(renderedReservationFilters)) return;
  renderedReservationFilters = {
    '#filter-date': $('#filter-date').value,
    '#filter-status': $('#filter-status').value
  };
  const list = filteredReservations();

  /* 来店日ごとにまとめ、早い順に並べます。
     カードが縦に並ぶだけだと、その日が何件なのか数えないと分かりません。
     朝いちばんに開いて「今日は何時から何件か」を見るのが主な使い方なので、
     日付で区切って件数を添えます。 */
  const byDate = new Map();
  list.forEach(r => {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  });

  // 予約が1件も無い日でも、受付を止めているならその日は出します
  const dateFilter = $('#filter-date').value;
  (adminData.closedDates || []).forEach(r => {
    const d = r['休業日'];
    if (!d || (dateFilter && d !== dateFilter)) return;
    if (!byDate.has(d)) byDate.set(d, []);
  });

  /* 日付を選んでいるときは、それが過ぎた日でもそのまま出します。
     わざわざ選んだ日が出てこないほうが困ります。 */
  const today = toKey(new Date());
  const sorted = [...byDate.keys()].sort();
  const pastKeys = dateFilter ? [] : sorted.filter(d => d < today);
  const pastCount = pastKeys.reduce((n, d) => n + byDate.get(d).length, 0);
  const keys = (pastKeys.length && !showPast) ? sorted.filter(d => d >= today) : sorted;

  /* 過去は捨てずに、押せば出します。「先月の◯◯さんは何をしたか」を
     見たいことがありますし、消えていると台帳から落ちたように見えます。 */
  const pastButton = pastKeys.length
    ? `<button class="btn btn-ghost btn-sm" type="button" data-toggle-past style="margin-bottom:14px;">${
        showPast ? '過ぎたご予約を畳む' : `過ぎたご予約（${pastCount}件）も見る`}</button>`
    : '';

  if (!keys.length) {
    /* 「該当する予約はありません」だけだと、絞り込んだままなのか
       本当に1件も無いのかが分かりません。片方を思い込むと、
       入っているはずの予約を見落とすか、入っていない予約を待つことになります。 */
    const total = (adminData.reservations || []).length;
    const message = (dateFilter || $('#filter-status').value !== 'all')
      ? 'この条件に合うご予約はありません。上の「条件をクリア」で戻せます。'
      : total ? '本日より先のご予約は、まだありません。'
        : 'まだご予約はありません。電話で受けたご予約は「＋ 電話予約を入れる」から台帳に入れてください。';
    $('#admin-rows').innerHTML = pastButton + `<p class="empty-state">${esc(message)}</p>`;
    return;
  }

  $('#admin-rows').innerHTML = pastButton + keys.map(date => {
    const rows = byDate.get(date);
    const h = dayHeading(date);
    const live = rows.filter(r => !isCancelled(r)).length;
    const allDay = closedAllDay(date);
    /* 休みにした日に予約が残っていることがあります（先に入っていた分）。
       件数を隠すと気づけないので、両方まとめて出します。 */
    const count = allDay
      ? (live ? `終日お休み・予約${live}件あり` : '終日お休み')
      : live ? `${live}件`
        : rows.length ? `キャンセル${rows.length}件のみ` : '予約なし';

    // 予約と「受けない時間帯」を、時刻順に混ぜて並べます
    const items = rows.concat(closedBlocksOn(date))
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));

    return `
      <div class="day-heading">
        ${h.label ? `<span class="day-badge">${esc(h.label)}</span>` : ''}
        <span class="day-date">${esc(h.text)}</span>
        <span class="day-count">${esc(count)}</span>
      </div>
      ${allDay ? `<div class="closed-block is-allday">この日は終日、予約を受け付けていません${
        live ? '（下のご予約は、休みにする前に入っていたものです）' : ''}</div>` : ''}
      ${items.map(x => (x.受付停止 ? closedCard(x) : reservationCard(x))).join('')}`;
  }).join('');
}

function closedCard(c) {
  return `
    <div class="closed-block">
      <span class="booking-time">${esc(c.time)}〜${esc(c.endTime)}</span>
      <span>予約を受け付けていません${c.memo ? `（${esc(c.memo)}）` : ''}</span>
    </div>`;
}

/* ---------- 施術メモ（次回への申し送り） ----------
   店だけが書き、店だけが読みます。お客様の照会には出ません
   （受け口の doLookup_ が、返す項目を並べて書いてあります）。

   置き場所は予約台帳の行です。名簿を別に作っていないので、
   予約の行を消せば、そのときのメモも一緒に消えます（DECISIONS.md）。

   書く場所と読む場所を分けています。
     書きたくなるのは施術の直後 → 予約一覧のカード
     読みたくなるのは次のご来店の前 → お客様タブの先頭
   同じ部品を両方に出しているので、片方で保存すると両方の表示が変わります。 */

/* 台帳の列と同じ上限です。ここだけ長くしても、受け口が切ります */
const NOTE_MAX = 1000;
const pendingNoteSaves = new Set();

function noteEditorHtml(r) {
  const note = String(r.note || '').trim();
  const code = esc(r.code);
  return `
    <div class="note-box" data-note-box="${code}">
      <p class="note-text" data-note-text${note ? '' : ' hidden'}>申し送り：<span>${esc(note)}</span></p>
      <details class="note-editor">
        <summary data-note-summary>${noteSummaryLabel(!!note)}</summary>
        <textarea class="note-input" data-note-input rows="3" maxlength="${NOTE_MAX}"
          placeholder="次にご来店されたときに見たいことを書きます。お客様には表示されません。">${esc(note)}</textarea>
        <div class="note-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-note-save="${code}">メモを保存</button>
          <span class="note-status" data-note-status role="status"></span>
        </div>
      </details>
    </div>`;
}

/* 保存できたら、画面に出ている同じ予約のメモを全部そろえます。

   予約一覧とお客様タブは、どちらも画面の中に居ます（隠れているだけ）。
   押したほうだけ直すと、タブを切り替えた先に古いメモが残り、
   どちらが本当か分からなくなります。

   予約番号はシートに手で書かれることがあるので、引用符が混ざっていても
   選び方が壊れないよう CSS.escape を通します。 */
function applyNoteToScreen(code, note) {
  const has = !!note.trim();
  document.querySelectorAll(`[data-note-box="${CSS.escape(code)}"]`).forEach(box => {
    const input = box.querySelector('[data-note-input]');
    input.value = note;
    input.defaultValue = note;
    const text = box.querySelector('[data-note-text]');
    text.hidden = !has;
    text.querySelector('span').textContent = note;
    box.querySelector('[data-note-summary]').textContent = noteSummaryLabel(has);
  });
}

/* 書いたことがあるかどうかで、開く前の見出しを変えます。
   出す場所が2か所あるので、文言はここ1か所に置きます。 */
const noteSummaryLabel = has => (has ? '申し送りを直す' : '次回への申し送りを書く');

async function saveNote(btn) {
  const code = btn.dataset.noteSave;
  const box = btn.closest('.note-box');
  const input = box && box.querySelector('[data-note-input]');
  const status = box && box.querySelector('[data-note-status]');
  if (!input || pendingNoteSaves.has(code)) return;

  const note = input.value;
  const boxes = $$(`[data-note-box="${CSS.escape(code)}"]`);
  pendingNoteSaves.add(code);
  boxes.forEach(noteBox => {
    noteBox.querySelector('[data-note-input]').disabled = true;
    noteBox.querySelector('[data-note-save]').disabled = true;
    noteBox.querySelector('[data-note-status]').textContent = '保存中…';
  });
  let res;
  try {
    res = await adminPost({ type: 'adminNote', code, note });
  } catch {
    res = { ok: false };
  } finally {
    pendingNoteSaves.delete(code);
    boxes.forEach(noteBox => {
      noteBox.querySelector('[data-note-input]').disabled = false;
      noteBox.querySelector('[data-note-save]').disabled = false;
      noteBox.querySelector('[data-note-status]').textContent = '';
    });
  }

  if (!res.ok) {
    /* 保存できていないのに黙っていると、書いたつもりで閉じられます。
       次のご来店のときに何も出てこず、そのときには理由が分かりません。 */
    if (status) status.textContent = '未保存です。入力は残っています。';
    alert('メモを保存できませんでした。' + (res.error ? '\n' + res.error : ''));
    return;
  }

  /* 受け口が切り詰めた・数式よけをした結果を正とします。
     手元の文字をそのまま出すと、台帳の中身と画面が食い違います。 */
  const saved = String(res.note == null ? note : res.note);
  const r = (adminData.reservations || []).find(x => x.code === code);
  if (r) r.note = saved;
  applyNoteToScreen(code, saved);
  if (status) status.textContent = '保存しました';
}

function mailNeedsAttention(r) {
  return /送信失敗|宛先なし/.test(String(r.shopMailStatus || ''))
    || /送信失敗/.test(String(r.customerMailStatus || ''));
}

function renderMailAlert() {
  const alert = $('#mail-alert');
  const affected = (adminData.reservations || []).filter(mailNeedsAttention);
  alert.hidden = !affected.length;
  if (!affected.length) { alert.innerHTML = ''; return; }
  alert.innerHTML = `<div><b>メール送信処理を確認してください（${affected.length}件）</b>
    <p>予約は台帳に残っています。登録し直さず、連絡方法を確認してください。メールは自動再送しません。</p>
    <details><summary>該当する予約を開く</summary>${affected.map(r =>
      `<p><button class="btn btn-outline btn-sm" type="button" data-mail-code="${esc(r.code)}">${esc(r.date)} ${esc(r.time)} ${esc(r.name)}様</button></p>`
    ).join('')}</details></div>`;
}

function mailStatusHtml(r) {
  const shop = String(r.shopMailStatus || '');
  const customer = String(r.customerMailStatus || '');
  if (!shop && !customer) return '';
  const needsAttention = mailNeedsAttention(r);
  return `<p class="${needsAttention ? 'booking-request' : 'booking-detail'}">メール送信処理：店舗 ${esc(shop || '記録なし')}／お客様 ${esc(customer || '記録なし')}<br><small>送信処理の結果です。受信箱への到着は確認していません。</small></p>`;
}

function reservationCard(r) {
  const off = isCancelled(r);
  /* 電話で受けた予約は、番号を控えていないことがあります。
     そのまま空のリンクを出すと、押しても何も起きない場所ができます。 */
  const tel = telKey(r.tel);
  /* 予約番号を目印に持たせます。カレンダーのマスを押したとき、
     このカードまで画面を送るために使います。 */
  return `
    <article class="booking-card ${off ? 'is-cancelled' : ''}" data-code="${esc(r.code)}">
      <div class="booking-head">
        <span class="booking-time">${esc(r.time)}〜${esc(r.endTime)}</span>
        ${off ? '<span class="status-chip is-cancelled">キャンセル</span>' : ''}
        <span class="booking-code">${esc(r.code)}</span>
      </div>
      <p class="booking-name">${esc(r.name)} 様<small>${esc(r.visit || '—')}</small></p>
      <p class="booking-detail">${esc(r.menu)}／${esc(r.staffName)}</p>
      <p class="booking-detail">${yen(r.price)}／${tel
        ? `<a href="tel:${tel}" style="text-decoration:underline">${esc(r.tel)}</a>`
        : '電話番号の控えなし'}
      </p>
      ${r.request ? `<p class="booking-request">ご要望：${esc(r.request)}</p>` : ''}
      ${mailStatusHtml(r)}
      ${/* キャンセルされた回にも書けるようにしています。
            「来られなかった理由」も、次にお会いするときに知りたいことだからです。 */''}
      ${noteEditorHtml(r)}
      ${off ? '' : `<div class="booking-actions" style="margin-top:12px;">
        ${adminData?.capabilities?.adminChange === true && r.date >= toKey(new Date())
          ? `<button class="btn btn-ghost btn-sm" type="button" data-admin-change="${esc(r.code)}">日時を変更</button>` : ''}
        <button class="btn btn-ghost btn-sm" type="button" data-admin-cancel="${esc(r.code)}">キャンセルにする</button>
      </div>`}
    </article>`;
}

function openAdminChange(button) {
  if (activeChange) {
    alert('開いている日時変更を閉じてから、別の予約を操作してください。');
    return;
  }
  if (hasUnsavedReservationNotes()) {
    alert('書きかけの施術メモを保存してから、日時を変更してください。');
    return;
  }
  const reservation = (adminData.reservations || []).find(row => row.code === button.dataset.adminChange);
  if (!reservation || isCancelled(reservation) || reservation.date < toKey(new Date())) return;
  const card = button.closest('.booking-card');
  if (!card) return;
  activeChange = { code: reservation.code, fromDate: reservation.date, fromTime: reservation.time,
    date: reservation.date, time: reservation.time, pending: false, uncertain: false };
  const editor = document.createElement('div');
  editor.className = 'admin-change-editor';
  editor.dataset.changeEditor = reservation.code;
  editor.innerHTML = `
    <strong>予約番号 ${esc(reservation.code)} の日時変更</strong>
    <p class="booking-detail">現在：${esc(formatDateJa(reservation.date))} ${esc(reservation.time)}〜${esc(reservation.endTime)}。予約番号と所要時間は変わりません。</p>
    <div class="add-grid">
      <label class="form-field"><span>変更後の日付</span><input type="date" data-change-date min="${toKey(new Date())}" value="${esc(reservation.date)}"></label>
      <label class="form-field"><span>変更後の開始時刻</span><select data-change-time>${phoneTimeOptions()}</select></label>
    </div>
    <p class="note">保存時に営業時間・休業日・ほかの予約を再確認します。メール通知は連絡先と送信設定によります。</p>
    <p class="admin-change-status" data-change-status role="status"></p>
    <div class="booking-actions">
      <button class="btn btn-dark btn-sm" type="button" data-change-save>日時を保存</button>
      <button class="btn btn-ghost btn-sm" type="button" data-change-check hidden>最新の予定を確認</button>
      <button class="btn btn-ghost btn-sm" type="button" data-change-close>閉じる</button>
    </div>`;
  card.appendChild(editor);
  const time = editor.querySelector('[data-change-time]');
  if (![...time.options].some(option => option.value === reservation.time)) {
    time.add(new Option(reservation.time, reservation.time));
  }
  time.value = reservation.time;
  editor.querySelector('[data-change-date]').focus();
}

function closeAdminChange() {
  if (!activeChange || activeChange.pending) return;
  if (activeChange.uncertain && !confirm('保存結果をまだ確認できていません。台帳を確認するまで、同じ予約を登録・変更しないでください。閉じますか？')) return;
  document.querySelector('[data-change-editor]')?.remove();
  activeChange = null;
}

function showChangedReservation(reservation) {
  const rows = adminData.reservations || [];
  const index = rows.findIndex(row => row.code === reservation.code);
  if (index >= 0) rows[index] = reservation;
  activeChange = null;
  $('#filter-date').value = reservation.date;
  $('#filter-status').value = 'all';
  renderStats();
  onFilterChange();
  renderCustomers();
  renderNumbers();
  focusBooking(reservation.code);
}

async function saveAdminChange(button) {
  if (!activeChange || activeChange.pending || activeChange.uncertain) return;
  const editor = button.closest('[data-change-editor]');
  const date = editor.querySelector('[data-change-date]').value;
  const time = editor.querySelector('[data-change-time]').value;
  const status = editor.querySelector('[data-change-status]');
  if (hasUnsavedReservationNotes()) {
    status.textContent = '書きかけの施術メモを先に保存してください。';
    return;
  }
  if (!date || !time || (date === activeChange.fromDate && time === activeChange.fromTime)) {
    status.textContent = '変更後の別の日時を選んでください。';
    return;
  }
  if (!confirm(`予約番号 ${activeChange.code}\n${activeChange.fromDate} ${activeChange.fromTime} → ${date} ${time}\nこの日時へ変更しますか？`)) return;
  activeChange.date = date;
  activeChange.time = time;
  activeChange.pending = true;
  editor.querySelectorAll('input, select, button').forEach(field => { field.disabled = true; });
  $$('[data-note-input], [data-note-save]').forEach(field => { field.disabled = true; });
  status.textContent = '台帳へ保存しています…';
  const result = await adminPost({ type: 'adminChange', code: activeChange.code,
    fromDate: activeChange.fromDate, fromTime: activeChange.fromTime, date, time });
  activeChange.pending = false;
  editor.querySelectorAll('input, select, button').forEach(field => { field.disabled = false; });
  $$('[data-note-input], [data-note-save]').forEach(field => { field.disabled = false; });
  if (result.ok && result.reservation?.code === activeChange.code) {
    showChangedReservation(result.reservation);
    const calendarNotice = result.calendarWarning
      ? ' カレンダー連携は未確認です。予約台帳を正として制作担当者へお知らせください。' : '';
    $('#reservation-freshness').textContent = '日時を保存しました。ほかの予約は最新の予定を読み込んで確認してください。' + calendarNotice;
    if (await refreshReservations()) $('#reservation-freshness').textContent = '日時を保存し、最新の予定を読み込みました。' + calendarNotice;
    return;
  }
  if (result.transportError || result.stale || result.ok) {
    activeChange.uncertain = true;
    editor.querySelector('[data-change-save]').disabled = true;
    editor.querySelector('[data-change-check]').hidden = false;
    status.textContent = result.stale
      ? '別の画面で日時が変わった可能性があります。保存し直さず、最新の予定を確認してください。'
      : '保存結果を確認できません。もう一度保存せず、最新の予定を確認してください。';
    return;
  }
  status.textContent = result.error || '変更できませんでした。日時をご確認ください。';
}

async function checkAdminChange(button) {
  if (!activeChange || activeChange.pending) return;
  const editor = button.closest('[data-change-editor]');
  const status = editor.querySelector('[data-change-status]');
  if (hasUnsavedReservationNotes()) {
    status.textContent = '書きかけの施術メモを先に保存してください。';
    return;
  }
  activeChange.pending = true;
  button.disabled = true;
  $$('[data-note-input], [data-note-save]').forEach(field => { field.disabled = true; });
  status.textContent = '台帳の最新の日時を確認しています…';
  const result = await adminPost({ type: 'adminData' });
  activeChange.pending = false;
  button.disabled = false;
  $$('[data-note-input], [data-note-save]').forEach(field => { field.disabled = false; });
  if (!result.ok) {
    status.textContent = '台帳を確認できませんでした。再送せず、時間をおいて確認してください。';
    return;
  }
  const live = (result.reservations || []).find(row => row.code === activeChange.code);
  if (!live) {
    status.textContent = '予約が見つかりません。保存し直さず、制作担当者へご連絡ください。';
    return;
  }
  if (live.date === activeChange.date && live.time === activeChange.time) {
    adminData.reservations = result.reservations;
    adminData.closedDates = result.closedDates || [];
    showChangedReservation(live);
    $('#reservation-freshness').textContent = '台帳で変更後の日時を確認しました。';
    return;
  }
  status.textContent = live.date === activeChange.fromDate && live.time === activeChange.fromTime
    ? '台帳は変更前の日時です。再登録せず、電話で状況を確認してから操作してください。'
    : `台帳は ${live.date} ${live.time} です。別の変更があるため、保存し直さず確認してください。`;
}

/* ---------- 予約一覧：カレンダー表示 ----------
   お客様向けの空席カレンダー（reserve.js の renderCalendar）と同じ
   「横＝日付／縦＝時間」のマス目です。店主はサロンボードに慣れているので、
   予定の入り方はこの形がいちばん速く読めます。

   違うのは中身です。
     お客様向け … 空いているか（○×）
     こちら     … 誰が入っているか（お名前）
   空いているマスは空欄にしています。「×」を並べると、
   埋まっている所が逆に見えにくくなるためです。 */

/* 1画面に出す日数。1週間ぶんです。
   お客様向けは14日ですが、こちらはマスにお名前を入れるぶん1列が倍以上の幅になり、
   14日だと横に送り続けることになります。 */
const ACAL_DAYS = 7;
/* 何日ずらして見ているか。マイナスにすれば過ぎた週も見られます
   （店主は昨日・先週の実績も見ます）。 */
let acalOffset = 0;

/* 予定の見せ方。'list' が今までの一覧、'calendar' がマス目。

   既定は一覧にしました。この画面がいちばん切実に使われるのは
   お客様の電話を受けている最中で、そのとき要るのはお名前・電話番号・メニューです。
   それが並んでいるのは一覧のほうで、カレンダーからは1回押して開くことになります。
   カレンダーはひと押しで出せるので、失うものは押す1回だけです。

   そのうえで、選んだ見せ方はこの端末に覚えます。
   カレンダーで見たい店主が、開くたびに押し直さずに済むようにです。 */
const VIEW_KEY = 'salon.adminReserveView.v1';
let reserveView = 'list';

/* 設定シートの時刻を読む。読めなければ掲載中（data.js）の値を使う。

   シートは人が手で書く場所なので「9時」「０９：００」も来ます。
   読めない値をそのまま使うと目盛りが1つも作れず、
   カレンダーが理由も出さずに空になります。

   読み取り方そのものは common.js の parseTimeText と同じでなければいけません。
   お客様の画面（applySettings）とこの画面が別々に読むと、同じシートから
   違う営業時間が出ます。だから同じ関数を呼びます。 */
function settingTime(key, fallback) {
  return parseTimeText((edits.settings || {})[key]) || fallback;
}

/** カレンダーの縦軸（営業開始〜最終受付） */
/* 見ているのは edits.settings です。「店舗情報」タブで直した営業時間が、
   保存したあと読み込み直さなくてもカレンダーに出るようにするためです。 */
function acalTimes() {
  const b = SALON.business;
  let open = settingTime('営業開始', b.openTime);
  let close = settingTime('営業終了', b.closeTime);
  let last = settingTime('最終受付', b.lastOrder);
  // 前後が壊れていると行が1つも作れないので、掲載中の営業時間に戻す
  if (toMinutes(close) <= toMinutes(open)) {
    open = b.openTime; close = b.closeTime; last = b.lastOrder;
  }
  if (toMinutes(last) > toMinutes(close) || toMinutes(last) < toMinutes(open)) last = close;

  const out = [];
  for (let m = toMinutes(open); m <= toMinutes(last); m += b.slotMinutes) out.push(toHHMM(m));
  return out;
}

/** 定休曜日（設定シート）。0=日曜 */
function acalHolidays() {
  const raw = String((edits.settings || {})['定休曜日'] ?? '').trim();
  if (!raw) return [];
  return [...new Set(raw.split(/[,、・\s]+/)
    .map(t => WEEKDAY_JA.indexOf(t.replace(/曜日?$/, '')))
    .filter(i => i >= 0))];
}

/** 予約の終わりの時刻（分）。終了が控えられていない古い行は1枠ぶんとみなす */
function endMinutesOf(r) {
  const start = toMinutes(String(r.time || ''));
  const end = toMinutes(String(r.endTime || ''));
  return Number.isFinite(end) && end > start ? end : start + SALON.business.slotMinutes;
}

/* マスに出すのは姓だけです。電話番号やメールは出しません。
   カレンダーは施術中に開いて、お客様から見える向きになることがあります。

   「山田　太郎」のように区切られていれば姓だけ。区切りが無いときは頭から4文字です。
   マスの幅に収まらないと、どの列のことなのか分からなくなります。 */
function surnameOf(name) {
  const head = String(name || '').trim().split(/\s+/)[0];
  if (!head) return 'お名前なし';
  return head.length > 4 ? head.slice(0, 4) : head;
}

/** 1マスの中身。予約があればお名前、なければ空欄 */
function acalCellBody(date, time, from, live, off) {
  const startsHere = r => toMinutes(String(r.time || '')) >= from;
  const where = `${formatDateJa(date, { short: true })} ${time}`;

  if (live.length) {
    /* この枠から始まる予約を優先します。そうしないと、前の予約が延びている所に
       次のお客様が始まったとき、始まったほうのお名前がどこにも出ません。 */
    const r = live.find(startsHere) || live[0];
    // 席は1つなので普通は1件ですが、店の判断で重ねて入れることがあります
    const more = live.length > 1 ? `＋${live.length - 1}` : '';
    return `<button class="cal-book${startsHere(r) ? '' : ' is-cont'}" type="button"
        data-cal-code="${esc(r.code)}"
        aria-label="${esc(`${where} ${surnameOf(r.name)} 様のご予約`)}"
      >${startsHere(r) ? esc(surnameOf(r.name)) + more : ''}</button>`;
  }

  if (off.length) {
    const r = off.find(startsHere);
    /* キャンセル済みは始まりのマスにだけ置きます。
       続きのマスまで塗ると、空いているのに埋まって見えます。 */
    if (!r) return '<span class="cal-cell"></span>';
    return `<button class="cal-off" type="button"
        data-cal-code="${esc(r.code)}"
        aria-label="${esc(`${where} ${surnameOf(r.name)} 様（キャンセル済み・この枠は空いています）`)}"
      >${esc(surnameOf(r.name))}</button>`;
  }

  return '<span class="cal-cell"></span>';
}

/** 1マス（td）。休業日・臨時休業・今日・過去の塗り分けもここで決めます */
function acalCell(date, time, list, holidays, today) {
  const step = SALON.business.slotMinutes;
  const from = toMinutes(time);
  const to = from + step;
  /* 電話で受けた予約は 9:15 開始のように目盛りに乗らないことがあります。
     少しでも重なる枠すべてに置かないと、実際は埋まっているのに
     カレンダー上は空いて見える枠ができます。 */
  const hit = list.filter(r => toMinutes(String(r.time || '')) < to && endMinutesOf(r) > from);
  /* キャンセル済みは「埋まっている」として描きません。
     生きている予約と重なったときも、生きているほうを優先します。 */
  const live = hit.filter(r => !isCancelled(r));
  const off = hit.filter(isCancelled);

  const allDay = holidays.includes(fromKey(date).getDay()) || closedAllDay(date);
  const stopped = !allDay && closedBlocksOn(date)
    .some(c => toMinutes(c.time) < to && toMinutes(c.endTime) > from);

  const cls = [
    allDay || stopped ? 'is-off' : '',
    date === today ? 'is-today' : '',
    date < today ? 'is-past' : ''
  ].filter(Boolean).join(' ');

  return `<td class="${cls}" data-date="${date}" data-time="${time}">${
    acalCellBody(date, time, from, live, off)}</td>`;
}

/* 上の「すべての状態／予約確定のみ／キャンセルのみ」は、ここでは効かせません。
   カレンダーは「いつ埋まっているか」を見る場所なので、
   絞り込んだ結果だけを描くと、空いていない枠が空いて見えます。 */
function renderAdminCalendar() {
  if (!$('#admin-calendar') || !adminData) return;

  const times = acalTimes();
  const today = toKey(new Date());
  const holidays = acalHolidays();
  /* 日付の並びは、お客様向けカレンダーと同じ Availability.dateRange を使います
     （common.js）。同じ数え方を2か所に書くと、片方だけ直したときに
     店の予定表とお客様の空席表が1日ずれます。 */
  const dates = Availability.dateRange(acalOffset, ACAL_DAYS);

  $('#acal-range').textContent = `${formatDateJa(dates[0], { short: true })} 〜 `
    + formatDateJa(dates[dates.length - 1], { short: true });

  /* 日付ごとに分けておきます。マスごとに台帳を端から見ると、
     1週間ぶんで200回近く同じ走査を繰り返すことになります。 */
  const byDate = new Map();
  (adminData.reservations || []).forEach(r => {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  });

  $('#acal-head').innerHTML = `<tr><th scope="col">時間</th>${dates.map(d => {
    const wd = fromKey(d).getDay();
    const cls = [
      wd === 0 ? 'is-sun' : wd === 6 ? 'is-sat' : '',
      d === today ? 'is-today' : '',
      d < today ? 'is-past' : ''
    ].filter(Boolean).join(' ');
    return `<th scope="col" class="${cls}">
        <span class="cal-date">${fromKey(d).getMonth() + 1}/${fromKey(d).getDate()}</span>
        <span class="cal-wd">${d === today ? '本日' : WEEKDAY_JA[wd]}</span>
      </th>`;
  }).join('')}</tr>`;

  /* 営業時間が読めないと目盛りが空になります。格子だけ出すと
     「予約が1件も無い」と読めてしまうので、理由を書きます。 */
  $('#acal-body').innerHTML = times.length
    ? times.map(t => `
      <tr>
        <th scope="row">${t}</th>
        ${dates.map(d => acalCell(d, t, byDate.get(d) || [], holidays, today)).join('')}
      </tr>`).join('')
    : `<tr><td colspan="${dates.length + 1}"><p class="empty-state">`
      + '営業時間が読み取れないため、マス目を作れませんでした。'
      + '「店舗情報」タブの営業開始・営業終了をご確認ください。</p></td></tr>';
}

/** 絞り込みを変えたとき。一覧とカレンダーの両方を合わせる */
function showTodayReservations() {
  if (hasUnsavedReservationNotes() || activeChange) {
    $('#reservation-freshness').textContent = '編集中の予約があります。保存または閉じてから今日の予約へ戻ってください。';
    return;
  }
  $('#filter-date').value = toKey(new Date());
  $('#filter-status').value = 'all';
  onFilterChange();
}

function onFilterChange() {
  if (!guardNoteFilters(renderedReservationFilters)) return;
  const d = $('#filter-date').value;
  /* 日付で絞り込んだら、カレンダーもその日を含む7日間へ動かします。
     切り替えたときに別の週が出ていると、同じ日をもう一度探すことになります。 */
  if (d) {
    const base = new Date(); base.setHours(0, 0, 0, 0);
    acalOffset = Math.round((fromKey(d).getTime() - base.getTime()) / 86400000);
  }
  renderReservations();
  renderAdminCalendar();
}

/** 一覧とカレンダーを切り替える */
function setReserveView(view) {
  reserveView = view === 'calendar' ? 'calendar' : 'list';
  $$('#reserve-view .tab').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.view === reserveView)));
  $('#admin-calendar').hidden = reserveView !== 'calendar';
  $('#admin-rows').hidden = reserveView !== 'list';
  try { localStorage.setItem(VIEW_KEY, reserveView); } catch (e) { /* 覚えられなくても動きます */ }
  if (reserveView === 'calendar') renderAdminCalendar();
}

/* マスを押したら、その1件を一覧のカードで見せます。
   マスの中に電話番号やメニューまで詰めると読めませんし、
   カードと二重に作ると、直すときに片方だけ直すことになります。 */
function focusBooking(code) {
  if (hasUnsavedReservationNotes() || activeChange) {
    alert('編集中の予約を保存または閉じてから、予約の詳細を開いてください。');
    return;
  }
  const r = (adminData.reservations || []).find(x => x.code === code);
  if (!r) return;

  /* 絞り込みが効いていると、飛んだ先にカードがありません。
     押しても何も起きないように見えるので、その1件が出るところまで条件を戻します。 */
  const status = $('#filter-status').value;
  if (status !== 'all' && (status === 'cancelled') !== isCancelled(r)) $('#filter-status').value = 'all';
  if ($('#filter-date').value && $('#filter-date').value !== r.date) $('#filter-date').value = '';
  if (r.date < toKey(new Date())) showPast = true;

  setReserveView('list');
  renderReservations();

  const card = $$('#admin-rows [data-code]').find(el => el.dataset.code === code);
  if (!card) return;
  // 前に押したぶんの目印が残っていると、どちらを押したのか分からなくなります
  $$('#admin-rows .is-focus').forEach(el => el.classList.remove('is-focus'));
  card.classList.add('is-focus');
  card.scrollIntoView({ block: 'center' });
}

/* ---------- 電話・来店で受けた予約を台帳に入れる ----------
   ここが無いと、電話で受けた分が台帳に無いまま残り、
   同じ時間にネット予約が入ります。 */
function phoneTimeOptions() {
  const options = ['<option value="">開始時刻を選択</option>'];
  for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += PHONE_TIME_STEP_MINUTES) {
    const time = toHHMM(minutes);
    options.push(`<option value="${time}">${time}</option>`);
  }
  return options.join('');
}

function toggleAddBooking(open) {
  if (phoneSubmitting) return;
  if (open && $('#ab-time').options.length === 1) $('#ab-time').innerHTML = phoneTimeOptions();
  $('#add-booking-form').hidden = !open;
  $('#ab-error').style.display = 'none';
  // 前に入れたぶんの結果が残っていると、今入れた結果と読み違えます
  if (open) $('#add-result').hidden = true;
  if (open) {
    renderPhonePresets();
    $('#ab-recovery').textContent = phoneRequestId ? '前の電話受付を確認中です。同じ受付として再試行し、別の予約を重ねて登録しないでください。'
      : supportsPhoneRetry() ? '通信が途切れたときは、同じ受付IDで結果を確認します。受付IDだけをこの端末に保存します。'
        : 'この接続先は再送防止に未対応です。登録結果が不明な場合は繰り返し登録せず、台帳を確認してください。更新は制作担当者へご依頼ください。';
    // 何も入っていなければ今日を入れておく（毎回打つのは面倒なので）
    if (!$('#ab-date').value) $('#ab-date').value = toKey(new Date());
    $('#ab-name').focus();
  }
}

function supportsPhoneRetry() { return adminData?.capabilities?.phoneRequestIds === true; }
function phoneRequestKey() { return PHONE_REQUEST_KEY_PREFIX + SALON.reservationEndpoint; }

function startCustomerBooking(code) {
  if (!guardNoteFilters({})) return;
  if (phoneSubmitting || phoneRequestId || phoneUncertain || phoneConflict) {
    alert('前の電話受付が処理中、または結果未確認です。予約一覧の電話予約フォームで結果を確認してから、次の受付を始めてください。');
    return;
  }
  try {
    if (localStorage.getItem(phoneRequestKey())) {
      alert('別の画面で始めた電話受付が未確認です。元の画面で結果を確認してから、次の受付を始めてください。');
      return;
    }
  } catch {
    alert('前の電話受付の控えを読み取れません。新しく登録せず、制作担当者へご連絡ください。');
    return;
  }
  const reservation = (adminData.reservations || []).find(row => row.code === code);
  const name = String(reservation?.name || '').trim();
  const tel = telKey(reservation?.tel || '');
  if (!name || !tel) {
    alert('お名前と電話番号を確認できません。最新の予定を読み込んでから、もう一度お試しください。');
    return;
  }
  const draft = ['#ab-name', '#ab-tel', '#ab-menu', '#ab-memo', '#ab-price', '#ab-time'].some(selector => $(selector).value)
    || ($('#ab-date').value && $('#ab-date').value !== toKey(new Date()))
    || $('#ab-minutes').value !== $('#ab-minutes').defaultValue;
  if (draft && !confirm('入力中の電話予約を破棄して、' + name + ' 様の新しい電話予約を入力しますか？日時・メニュー・金額・メモは引き継ぎません。')) return;

  $$('input, select', $('#ab-fields')).forEach(field => { field.value = ''; });
  phonePayload = null;
  phonePriceNeedsInput = false;
  $('#ab-menu-hint').textContent = '今回のメニューを選ぶか、所要時間・金額を入力してください。';
  $('#ab-name').value = name;
  $('#ab-tel').value = tel;
  $('#admin-tabs [data-pane="reserve"]').click();
  toggleAddBooking(true);
  const notice = $('#ab-customer');
  notice.textContent = name + ' 様（' + tel + '）のお名前・電話番号を名簿から入力しました。まだ予約は登録していません。今回の日時・施術内容をご確認ください。';
  notice.hidden = false;
  notice.focus({ preventScroll: true });
  notice.scrollIntoView({ block: 'start' });
}

function renderPhonePresets() {
  phonePresets = ['coupons', 'menus'].flatMap(target => (adminData[target] || [])
    .filter(row => String(row['メニュー名'] || '').trim() && !/^(×|✕|false|off|0|非表示)$/i.test(String(row['表示'] ?? '').trim()))
    .map(row => ({ ...row, group: target === 'coupons' ? 'おすすめ' : '単品' })));
  $('#ab-menu-preset').innerHTML = '<option value="">メニュー・時間・金額を手入力</option>'
    + phonePresets.map((row, index) => `<option value="${index}">${esc(row.group)}：${esc(row['メニュー名'])}／${esc(minutesText(row['所要(分)']))}／${esc(priceText(row['価格']))}</option>`).join('');
}

function applyPhonePreset() {
  const choice = $('#ab-menu-preset').value;
  if (choice === '') return;
  const row = phonePresets[Number(choice)];
  if (!row) return;
  if (($('#ab-menu').value || $('#ab-price').value)
      && !confirm('入力中のメニュー・所要時間・金額を、選んだメニューで置き換えますか？')) {
    $('#ab-menu-preset').value = '';
    return;
  }
  $('#ab-menu').value = row['メニュー名'];
  const minutes = numberOf(row['所要(分)'], NaN);
  $('#ab-minutes').value = Number.isInteger(minutes) && minutes >= 15 && minutes <= 480 ? String(minutes) : '';
  const price = numberOf(row['価格'], NaN);
  phonePriceNeedsInput = !Number.isFinite(price) || price < 0;
  $('#ab-price').value = phonePriceNeedsInput ? '' : String(price);
  $('#ab-menu-hint').textContent = phonePriceNeedsInput
    ? '下限料金・見積り・未設定のメニューです。お客様と確認した今回の金額を入力してください。'
    : '登録済みの時間と金額を入力しました。今回の施術内容に合わせて確認してください。';
}

function setPhoneBusy(busy) {
  phoneSubmitting = busy;
  $('#ab-fields').disabled = busy || phoneUncertain || phoneConflict;
  $('#ab-save').disabled = busy || phoneConflict || (phoneUncertain && (!supportsPhoneRetry() || !phonePayload));
  $('#ab-save').textContent = busy ? '確認中…' : phoneUncertain ? '同じ受付として再試行' : '台帳に入れる';
  $('#ab-cancel').disabled = busy;
  $('#ab-check').hidden = !phoneRequestId;
  $('#ab-check').disabled = busy || !supportsPhoneRetry();
}

async function restorePhoneBooking() {
  try {
    const stored = localStorage.getItem(phoneRequestKey());
    if (!stored) return;
    if (!PHONE_REQUEST_ID_PATTERN.test(stored)) throw new Error('受付IDを確認できません。');
    phoneRequestId = stored;
    toggleAddBooking(true);
    await checkPhoneResult();
  } catch {
    toggleAddBooking(true);
    showAddError('前の電話受付の控えを読み取れません。新しく登録せず、制作担当者へご連絡ください。');
    phoneUncertain = true;
    setPhoneBusy(false);
  }
}

async function checkPhoneResult() {
  if (phoneSubmitting || !phoneRequestId) return;
  if (!supportsPhoneRetry()) {
    phoneUncertain = true;
    setPhoneBusy(false);
    showAddError('前の電話受付が未確認です。この接続先では結果確認ができないため、制作担当者に更新をご依頼ください。');
    return;
  }
  setPhoneBusy(true);
  try {
    const result = await adminPost({ type: 'adminAddStatus', requestId: phoneRequestId });
    if (!result.ok || result.requestId !== phoneRequestId) {
      phoneUncertain = true;
      showAddError('登録結果をまだ確認できません。同じ受付のまま、通信が戻ってから確認してください。');
    } else if (result.found) {
      if (phoneConflict && !confirm('以前の受付が登録済みです。今回入力した別の内容は登録されていません。入力欄を閉じ、以前の受付結果を確認しますか？')) return;
      finishPhoneBooking(result);
    } else {
      phoneUncertain = false;
      phoneConflict = false;
      $('#ab-recovery').textContent = 'まだ登録を確認できません。再試行は同じ受付IDで行います。入力欄が空なら、前の電話受付の内容を入力し直してください。';
    }
  } finally { setPhoneBusy(false); }
}

/* 数字の欄に打たれた「４５００」「4,500円」「90分」を数にします。
   店主は日本語入力のまま打つので、数字は全角になります。
   全角を読み落とすと、金額は0円、所要は既定の60分として黙って登録され、
   90分の施術に60分の枠しか押さえられず、次のお客様と重なります。 */
function numberOf(value, fallback) {
  const t = toHalfWidth(value).replace(/[,¥￥円分\s]/g, '').trim();
  if (t === '') return fallback;
  const n = Number(t);
  return isFinite(n) ? n : NaN;
}

async function saveAddBooking(force = false) {
  if (phoneSubmitting || phoneConflict) return;
  if (phoneUncertain && (!supportsPhoneRetry() || !phonePayload)) {
    showAddError('前の電話受付の結果を先に確認してください。'); return;
  }
  const err = $('#ab-error');
  err.style.display = 'none';

  const minutes = numberOf($('#ab-minutes').value, NaN);
  const price = numberOf($('#ab-price').value, 0);
  const payload = phoneUncertain && phonePayload ? { ...phonePayload } : {
    type: 'adminAdd', force,
    date: $('#ab-date').value,
    time: $('#ab-time').value,
    minutes,
    price,
    name: $('#ab-name').value.trim(),
    /* 全角のまま台帳に入れると、お客様タブでまとめられず（番号なし扱い）、
       カードの電話をかけるリンクも押せなくなります。 */
    tel: normalizeTel($('#ab-tel').value),
    menu: $('#ab-menu').value.trim(),
    memo: $('#ab-memo').value.trim()
  };
  if (!payload.date || !payload.time) { showAddError('来店日と開始時刻をお選びください。'); return; }
  if (!payload.name) { showAddError('お名前をご入力ください。'); return; }
  /* 所要が0や負だと、終わりの時刻が始まりより前になります。
     押さえた気になっているのに枠が空いたままで、同じ時間にネット予約が入ります。 */
  if (!Number.isInteger(payload.minutes) || !(payload.minutes >= 15 && payload.minutes <= 480)) {
    showAddError('所要（分）は15〜480の数字でご入力ください。'); return;
  }
  if (!(price >= 0)) { showAddError('金額は数字でご入力ください（空欄でもかまいません）。'); return; }
  if (toMinutes(payload.time) + payload.minutes >= MINUTES_PER_DAY) { showAddError('日をまたがない終了時刻になるようにご確認ください。'); return; }
  if (phonePriceNeedsInput && !$('#ab-price').value.trim()) { showAddError('今回の金額をご入力ください。下限料金を確定料金として登録しないでください。'); return; }
  /* スマホの日付は目盛りを回して選ぶので、指がすべると年や月ごと動きます。
     過ぎた日で入れると畳んだ過去側に入って一覧に出ないため、
     入っていないと思ってもう一度入れることになります。 */
  if (!force && payload.date < toKey(new Date())
      && !confirm(`${formatDateJa(payload.date)}は過ぎた日付です。このまま台帳に入れますか？`)) {
    return;
  }

  if (supportsPhoneRetry()) {
    try {
      const stored = localStorage.getItem(phoneRequestKey());
      if (stored && phoneRequestId !== stored) {
        if (!PHONE_REQUEST_ID_PATTERN.test(stored)) throw new Error();
        phoneRequestId = stored;
        phoneConflict = true;
        await checkPhoneResult();
        return;
      }
      phoneRequestId ||= crypto.randomUUID();
      localStorage.setItem(phoneRequestKey(), phoneRequestId);
      if (localStorage.getItem(phoneRequestKey()) !== phoneRequestId) throw new Error();
      payload.requestId = phoneRequestId;
    } catch { showAddError('受付IDの控えを端末に保存できません。二重登録を防ぐため、登録を止めました。端末の保存設定を確認してください。'); return; }
  }
  phonePayload = { ...payload };
  setPhoneBusy(true);
  try {
    let res = await adminPost(payload);
    if (!res.ok && res.confirm) {
      phoneUncertain = false;
      if (!confirm(res.error + '\n\n※ネット予約とは別に、店側の判断で入れられます。')) return;
      phonePayload = { ...payload, force: true };
      res = await adminPost(phonePayload);
    }
    if (!res.ok) {
      phoneConflict = !!res.requestConflict;
      phoneUncertain = !!res.transportError || !supportsPhoneRetry();
      showAddError(res.error || '登録できませんでした。');
      return;
    }
    if (supportsPhoneRetry() && (res.requestId !== phoneRequestId || !res.reservation?.code)) {
      phoneUncertain = true;
      showAddError('登録結果を確認できませんでした。新しく登録せず、前の電話受付の結果を確認してください。');
      return;
    }
    finishPhoneBooking(res);
  } catch {
    phoneUncertain = true;
    showAddError('登録結果が不明です。繰り返し新しく登録せず、前の電話受付の結果を確認してください。');
  } finally { setPhoneBusy(false); }
}

function finishPhoneBooking(res) {
  const payload = phonePayload || {};
  const reservation = res.reservation || {
    code: res.code, date: payload.date, time: payload.time, endTime: res.endTime,
    menu: payload.menu || '（電話予約）', staffName: '', price: payload.price,
    name: payload.name, tel: payload.tel, email: '', visit: '電話・来店', source: '電話・来店',
    request: payload.memo, status: '予約確定'
  };
  if (phoneRequestId) {
    try {
      if (localStorage.getItem(phoneRequestKey()) === phoneRequestId) localStorage.removeItem(phoneRequestKey());
    } catch { phoneUncertain = true; showAddError('予約は登録済みですが、端末の受付控えを消せません。新しい登録をせず制作担当者へご連絡ください。'); return; }
  }
  phoneRequestId = '';
  phonePayload = null;
  phoneUncertain = false;
  phoneConflict = false;
  const reservations = adminData.reservations ||= [];
  const existing = reservations.findIndex(row => row.code === reservation.code);
  if (existing < 0) reservations.push(reservation);
  else reservations[existing] = reservation;
  /* 過ぎた日で入れたときは、過去を開いた状態にします。
     承知のうえで入れた（先週ぶんの記録など）のに一覧から消えると、
     入っていないと思ってもう一度入れることになります。 */
  if (reservation.date < toKey(new Date())) showPast = true;
  renderStats();
  const hasNotes = hasUnsavedReservationNotes();
  if (!hasNotes) { renderReservations(); renderCustomers(); }
  renderAdminCalendar();
  ['#ab-name', '#ab-tel', '#ab-menu', '#ab-memo', '#ab-price'].forEach(id => { $(id).value = ''; });
  phonePriceNeedsInput = false;
  $('#ab-menu-hint').textContent = '選んだ内容は、登録前に確認・変更できます。';
  $('#ab-customer').hidden = true;
  $('#add-booking-form').hidden = true;

  /* 結果は一覧の手前に出して、その場まで画面を送ります。
     ページのいちばん下の保存メッセージは、予約カードの下に隠れていて、
     スマホでは見えません。入れたのに何も出ないと、
     もう一度押して同じ予約を二重に入れてしまいます。 */
  const note = $('#add-result');
  const filterDate = $('#filter-date').value;
  const outOfView = (filterDate && filterDate !== reservation.date)
    || $('#filter-status').value === 'cancelled';
  note.textContent = `${res.duplicate ? '前の電話受付の登録結果を確認しました' : '台帳に入れました'}（予約番号 ${res.code}）。`
    + `${formatDateJa(reservation.date)} ${reservation.time}〜。`
    + (isCancelled(reservation) ? 'この予約はキャンセル済みです。復活・再登録はしていません。' : 'この時間はネット予約から埋まります。')
    + (res.calendarWarning ? 'カレンダー連携は未確認です。予約台帳を正として制作担当者へお知らせください。' : '')
    + (hasNotes ? '書きかけのメモを残しています。保存後に最新の予定を読み込んでください。' : '')
    + (outOfView ? '（いま絞り込み中のため、下の一覧には出ていません）' : '');
  note.dataset.code = reservation.code;
  note.dataset.reservationState = phoneResultState(reservation);
  note.hidden = false;
  note.scrollIntoView({ block: 'center' });
}

const phoneResultState = reservation => JSON.stringify([
  reservation.date, reservation.time, reservation.endTime, isCancelled(reservation)
]);

function reconcilePhoneResult() {
  const note = $('#add-result');
  if (note.hidden || !note.dataset.code) return;
  const reservation = (adminData.reservations || []).find(row => row.code === note.dataset.code);
  if (!reservation || phoneResultState(reservation) !== note.dataset.reservationState) note.hidden = true;
}

function showAddError(message) {
  const err = $('#ab-error');
  err.textContent = message;
  err.style.display = 'block';
  // 入力欄が長いので、押したボタンから離れた場所に出ると読まれません
  err.scrollIntoView({ block: 'center' });
}

/* ---------- お客様 ----------
   顧客名簿を別に作ってはいません。**予約台帳をまとめ直しているだけ**です。
   同じ人かどうかは電話番号で見ます。お名前は表記ゆれがあり、
   メールは端末を変えると変わることがあるためです。
   新しい情報を集めていないので、消すときも予約台帳の行を消すだけで済みます。 */
function telKey(tel) {
  /* 全角で控えられた番号（０９０…）も同じ番号として扱います。
     半角だけ見ていると、その行は「番号なし」としてお客様タブから丸ごと消え、
     カードの電話リンクも空になります。シートに直接打たれた行や、
     店主が全角のまま入れた電話予約が、ここに来ます。 */
  return toHalfWidth(tel).replace(/[^0-9]/g, '');
}

/* 探すときの文字のゆれを、こちらで吸収します。
   店主は日本語入力を切り替えずに打つので、番号もスペースも全角になります。
   出てこないと「そのお客様は初めて」と思い込み、前回のご要望を見ないまま
   施術に入ることになります。 */
function searchKey(v) {
  return toKatakana(toHalfWidth(v)).replace(/\s+/g, '').toLowerCase();
}

function buildCustomers() {
  const map = new Map();
  (adminData.reservations || []).forEach(r => {
    const key = telKey(r.tel);
    if (!key) return;                       // 電話番号が無い行はまとめようがない
    if (!map.has(key)) {
      map.set(key, { tel: r.tel, visits: [] });
    }
    const c = map.get(key);
    c.visits.push(r);
  });
  return [...map.values()].map(c => {
    c.visits.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    c.name = c.visits[0].name;
    c.email = c.visits[0].email;
    /* 1つの番号を家族で使う店です（固定電話、親子でご来店）。
       いちばん新しいお名前だけ覚えていると、ご主人の履歴が奥様の名前で並び、
       前回のご要望を取り違えます。また、古いほうのお名前で探しても
       出てこなくなります。使われたお名前は全部持っておきます。 */
    c.names = [...new Set(c.visits.map(v => String(v.name || '').trim()).filter(Boolean))];
    c.done = c.visits.filter(v => !isCancelled(v));
    c.spent = c.done.reduce((s, v) => s + (Number(v.price) || 0), 0);
    return c;
  });
}

function customerSchedule(visits, now = new Date()) {
  const current = toKey(now) + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const live = visits.filter(v => !isCancelled(v));
  const past = live.filter(v => v.date + ' ' + (v.endTime || v.time) <= current)
    .sort((left, right) => (right.date + right.time).localeCompare(left.date + left.time));
  const upcoming = live.filter(v => v.date + ' ' + (v.endTime || v.time) > current)
    .sort((left, right) => (left.date + left.time).localeCompare(right.date + right.time));
  return { previous: past[0], next: upcoming[0], past, upcoming,
    cancelled: visits.filter(isCancelled) };
}

function renderCustomers() {
  if (!guardNoteFilters(renderedCustomerFilters)) return;
  const expanded = $('#customer-rows .customer-record[open]')?.dataset.customerTel;
  const q = ($('#customer-search') || {}).value || '';
  const sort = ($('#customer-sort') || {}).value || 'recent';
  renderedCustomerFilters = { '#customer-search': q, '#customer-sort': sort };
  const needle = searchKey(q);
  const digits = telKey(q);

  const customers = buildCustomers().map(customer => ({ ...customer, schedule: customerSchedule(customer.visits) }));
  let list = customers.filter(c => !needle
    || c.names.some(n => searchKey(n).includes(needle))
    || (digits && telKey(c.tel).includes(digits)));

  list.sort((a, b) => sort === 'visits' ? b.schedule.past.length - a.schedule.past.length
    : sort === 'name' ? String(a.name).localeCompare(String(b.name), 'ja')
      : String(b.schedule.previous?.date || '').localeCompare(String(a.schedule.previous?.date || '')));
  $('#customer-count').textContent = `${list.length}件を表示 / 名簿 ${customers.length}件（電話番号ごと）`;

  if (!list.length) {
    $('#customer-rows').innerHTML = (adminData.reservations || []).length
      ? '<p class="empty-state">該当するお客様はいません。</p>'
      : '<p class="empty-state">ご予約が入ると、ここにお客様が並びます。</p>';
    return;
  }

  $('#customer-rows').innerHTML = list.map(c => {
    const schedule = c.schedule;
    const latest = schedule.previous;
    // 家族で番号を分け合っているときだけ、どなたのご来店かを添えます
    const shared = c.names.length > 1;
    const who = v => (shared ? esc(v.name || '（お名前なし）') + '／' : '');
    /* 来店回数は「キャンセルを除いた予約の数」です。
       実際に来られたかどうかまでは分からないので、そう書いておきます。 */
    return `
      <article class="booking-card customer-card">
        <details class="customer-record" data-customer-tel="${esc(telKey(c.tel))}"${expanded === telKey(c.tel) ? ' open' : ''}>
          <summary class="customer-row" data-customer-history>
            <span class="customer-row-name"><strong>${esc(c.name || '（お名前なし）')}</strong>${shared ? `<small>同じ番号：${esc(c.names.join('・'))}</small>` : ''}</span>
            <span class="customer-row-tel">${esc(c.tel)}</span>
            <span class="customer-row-date"><span class="customer-row-label">直近の過去予約</span>${latest ? formatDateJa(latest.date) : '過去予約なし'}</span>
            <span class="customer-row-date"><span class="customer-row-label">次の予約</span>${schedule.next ? `${formatDateJa(schedule.next.date)} ${esc(schedule.next.time)}` : '次回予約なし'}</span>
            <span class="customer-row-arrow" aria-hidden="true">›</span>
          </summary>
          <div class="customer-profile">
        <div class="booking-head">
          <h3 class="customer-name">${shared ? '同じ電話番号を使う方の予約履歴' : `${esc(c.name || '（お名前なし）')}の予約履歴`}</h3>
          <span class="status-chip">過去の予約 ${schedule.past.length}件</span>
        </div>
        <p class="booking-detail">今後・施術中 ${schedule.upcoming.length}件 ／ キャンセル ${schedule.cancelled.length}件</p>
        ${shared ? `<p class="booking-detail">この番号でご予約：${esc(c.names.join('・'))} 様</p>` : ''}
        <p class="booking-detail">
          <a href="tel:${esc(telKey(c.tel))}" style="text-decoration:underline">${esc(c.tel)}</a>
          ${c.email ? `／ ${esc(c.email)}` : ''}
        </p>
        <div class="customer-booking-actions">
          <p class="note">${shared ? '同じ電話番号の履歴です。予約する方を選んでください。' : 'お名前・電話番号を引き継いで、新しい電話予約を入力できます。'}日時・施術内容は今回分を確認します。</p>
          ${c.names.map(name => `<button class="btn btn-outline btn-sm" type="button" data-customer-booking="${esc(c.visits.find(visit => String(visit.name || '').trim() === name).code)}">${esc(name)} 様の電話予約</button>`).join('')}
          ${c.names.length ? '' : '<p class="note">お名前の控えがないため、予約一覧の「電話予約を入れる」から入力してください。</p>'}
        </div>
        <p class="booking-detail">予約金額の合計 ${yen(c.spent)}（今後の予約を含む・キャンセルを除く）</p>
        ${latest ? `<p class="booking-detail">直近の過去予約：${formatDateJa(latest.date)}／${who(latest)}${esc(latest.menu)}（来店確認は未記録）</p>` : '<p class="booking-detail">過去の予約はまだありません。</p>'}
        ${/* 申し送りは「いちばん新しいご来店の回」に書きます。
              次にお会いするときに読むものなので、書く相手はその回だからです。
              古い回を直したくなったら、予約一覧のカードから直せます。 */''}
        ${latest ? noteEditorHtml(latest) : ''}
        ${schedule.next ? `<p class="booking-detail">次の予約（施術中を含む）：${formatDateJa(schedule.next.date)} ${esc(schedule.next.time)}／${who(schedule.next)}${esc(schedule.next.menu)}</p>${noteEditorHtml(schedule.next)}` : '<p class="booking-detail">次の予約はまだありません。</p>'}
        <details class="customer-history" open>
          <summary>すべての予約を見る（${c.visits.length}件・キャンセルを含む）</summary>
          <ul>
            ${c.visits.map(v => `
              <li${isCancelled(v) ? ' class="is-cancelled"' : ''}>
                <span class="hist-date">${formatDateJa(v.date)} ${esc(v.time)}</span>
                <span class="hist-menu">${who(v)}${esc(v.menu)}（${isCancelled(v) ? 'キャンセル' : schedule.past.includes(v) ? '過去の予約' : '今後・施術中'}）</span>
                <span class="hist-request">予約時のメール：${v.email ? esc(v.email) : '登録なし'}</span>
                ${v.request ? `<span class="hist-request">ご要望：${esc(v.request)}</span>` : ''}
                ${/* 過去の回のメモは読むだけにします。ここに入力欄を並べると、
                      履歴を開くたびに欄が何個も出てきて、前回の内容が読めません。 */''}
                ${v.note ? `<span class="hist-note">メモ：${esc(v.note)}</span>` : ''}
                <button class="btn btn-outline btn-sm" type="button" data-history-booking="${esc(v.code)}">予約の詳細・施術メモを開く</button>
              </li>`).join('')}
          </ul>
        </details>
        <button class="btn btn-outline btn-sm customer-close" type="button" data-customer-close>詳細を閉じて名簿に戻る</button>
          </div>
        </details>
      </article>`;
  }).join('');
}

/* ============================================================
   数字 — 掲載を続けるかどうかを決めるための画面

   店主が月に1回だけ開きます。そのとき決めたいことは1つです。
   「ホットペッパーの掲載を、下げてよいか。止めてよいか」

   決め手は4つです。
     ・自社サイトで何件取れているか（先月より増えているか）
     ・その入口はどこか（店が配ったリンクが効いているか）
     ・2回目以降のお客様が自社に移っているか
     ・席がどれだけ埋まっているか（新規を入れる余地が残っているか）
   そのうえで、手数料をいくら払わずに済んだかを出します。

   ★ここで数字を作らないこと。
     手数料率も掲載料も店ごとに違います。入っていないものは
     「分かりません」と出します。それらしい数字を置くと、店主は
     それを実績だと思って掲載を止めます。取り返しがつきません。

   ★煽らないこと。
     出すのは事実と、その読み方だけです。「止めましょう」は書きません。
     決めるのは店主で、こちらには見えていない事情（新規の入り方、
     この先の季節）があります。
   ============================================================ */

/* 見ている月。0 が今月、-1 が先月。月に1回開く画面なので、
   月初に開いた店主が先月ぶんを見られるように2つ持ちます。 */
let numbersMonth = 0;

/* 電話・来店で受けた分。
   「予約の入口」の列が無かったころの行は入口が空ですが、
   来店回数のほうには前から「電話・来店」と入っています。両方を見ます。 */
const isWalkIn = r => r.source === '電話・来店' || r.visit === '電話・来店';

/** その1件の入口。分からないものは「記録なし」。「直接」に混ぜません */
function sourceOf(r) {
  if (isWalkIn(r)) return '電話・来店';
  return SOURCE_LABELS.indexOf(r.source) >= 0 ? r.source : '記録なし';
}

/** 見ている月 */
function monthOf(offset) {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth() + offset, 1);
  return {
    key: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
    label: `${d.getFullYear()}年${d.getMonth() + 1}月`,
    year: d.getFullYear(), month: d.getMonth() + 1
  };
}

/* その月のご予約。数えるのは来店日です。
   受付日で数えると、先月のうちに取った今月ぶんが先月に乗り、
   手数料の話（施術1件ごとにかかる）と合わなくなります。 */
function monthBookings(key) {
  return (adminData.reservations || [])
    .filter(r => !isCancelled(r) && String(r.date || '').slice(0, 7) === key);
}

/* 設定シートの数。手で書く場所なので、読めない値は未入力として扱います。

   0 と未入力は別ものです。「0%」と書いてあれば0円と出しますが、
   空欄のときは金額そのものを出しません。 */
function settingNumber(key, min, max) {
  const t = toHalfWidth((edits.settings || {})[key]).replace(/[,¥￥円%％\s]/g, '').trim();
  if (t === '' || !/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return (n < min || n > max) ? null : n;
}

/** 稼働率を出すための営業時間（分）。読めなければ掲載中の値 */
function numbersHours() {
  const b = SALON.business;
  const open = toMinutes(settingTime('営業開始', b.openTime));
  const close = toMinutes(settingTime('営業終了', b.closeTime));
  return close > open
    ? { open, close }
    : { open: toMinutes(b.openTime), close: toMinutes(b.closeTime) };
}

/** その日に受けられた時間（分）。定休・終日休みは0 */
function openMinutesOn(dateKey, hours, holidays) {
  if (holidays.includes(fromKey(dateKey).getDay())) return 0;
  if (closedAllDay(dateKey)) return 0;
  /* 受けないことにした時間帯は、営業時間から引きます。引かないと、
     店が自分で閉めた時間まで「空いていた」ことになり、稼働率が低く出ます。 */
  const stop = closedBlocksOn(dateKey).reduce((sum, c) => sum
    + Math.max(0, Math.min(hours.close, toMinutes(c.endTime))
                 - Math.max(hours.open, toMinutes(c.time))), 0);
  return Math.max(0, hours.close - hours.open - stop);
}

/* 稼働率。営業時間のうち、どれだけ予約で埋まっているか。

   これから先の日は数えません。まだ来ていない日は空いていて当たり前で、
   混ぜるとどの月も月初は「がらがら」に見えます。 */
function occupancy(m) {
  const hours = numbersHours();
  const holidays = acalHolidays();
  const today = toKey(new Date());
  const lastDay = new Date(m.year, m.month, 0).getDate();
  const list = monthBookings(m.key);
  let open = 0, used = 0, days = 0, until = '';

  for (let d = 1; d <= lastDay; d++) {
    const k = `${m.key}-${pad2(d)}`;
    if (k > today) break;
    until = k;
    const o = openMinutesOn(k, hours, holidays);
    if (!o) continue;
    days++;
    open += o;
    used += list.filter(r => r.date === k).reduce((s, r) => {
      const t = toMinutes(String(r.time || ''));
      // 時刻の読めない行は数えません（分からないものを埋めない）
      if (!Number.isFinite(t)) return s;
      const from = Math.max(hours.open, t);
      const to = Math.min(hours.close, endMinutesOf(r));
      return s + Math.max(0, to - from);
    }, 0);
  }
  return { open, used, days, until, rate: open ? used / open : null };
}

/** 分を「◯時間」に。桁を落としすぎると、稼働率と合わなく見えます */
const hoursText = min => `${Math.round(min / 6) / 10}時間`;

/* ---- 画面の部品 ----
   数字のとなりに、その読み方を必ず1行添えます。数字だけ出しても
   店主は決められません。ただし「止めましょう」とは書きません。 */
function numCard(title, value, unit, sub, read, cls = '') {
  return `
    <section class="num-card ${cls}">
      <h3 class="num-title">${esc(title)}</h3>
      <p class="num-value">${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ''}</p>
      ${sub ? `<p class="num-sub">${esc(sub)}</p>` : ''}
      ${read ? `<p class="num-read">${esc(read)}</p>` : ''}
    </section>`;
}

function numBars(rows, total) {
  if (!rows.length) return '<p class="empty-state">数えられるご予約がありません。</p>';
  return `<ul class="num-bars">${rows.map(([label, n]) => {
    const pct = total ? Math.round(n / total * 100) : 0;
    return `<li>
        <span class="num-bar-label">${esc(label)}</span>
        <span class="num-bar"><span style="width:${pct}%"></span></span>
        <span class="num-bar-num">${n}件<small>${pct}%</small></span>
      </li>`;
  }).join('')}</ul>`;
}

/* 1. その月に自社サイトから何件入ったか */
function numbersCount(m, prev, site, siteBefore) {
  const diff = site.length - siteBefore.length;
  const sub = `${prev.label}は ${siteBefore.length}件`
    + (diff === 0 ? '（同じ）' : `（${diff > 0 ? '＋' : '−'}${Math.abs(diff)}件）`);
  return numCard(
    `${m.label}の自社サイト経由のご予約`, String(site.length), '件', sub,
    'ホットペッパーを通さずに入ったご予約です。電話・来店で受けた分は含みません。'
    + 'この数が増えているあいだは、掲載を下げても受け皿が育っています。');
}

/* 2. どの入口から来ているか */
function numbersSources(m, all) {
  const count = {};
  all.forEach(r => { const k = sourceOf(r); count[k] = (count[k] || 0) + 1; });
  /* 店が配った入口（LINE・地図・QR・Instagram）と電話は、0件でも出します。
     0件だと分かることに意味があるためです（配ったのに来ていない）。
     それ以外は、あるときだけ出します。 */
  const always = VISIT_SOURCES.map(s => s.label).concat(['電話・来店']);
  const rows = SOURCE_LABELS.concat(['記録なし'])
    .filter(k => always.includes(k) || count[k])
    .map(k => [k, count[k] || 0]);
  const marked = VISIT_SOURCES.reduce((n, s) => n + (count[s.label] || 0), 0);

  return `
    <section class="num-card">
      <h3 class="num-title">${esc(m.label)}の入口の内訳</h3>
      ${numBars(rows, all.length)}
      <p class="num-read">${esc(
        `店が配ったリンクから来たのは ${marked}件です。「直接」「検索」は、その印が付いていない分です。`
        + 'Googleマップから来ても、参照元は検索と同じに見えます。地図の分を分けて数えたいときは、'
        + '下のURLをビジネスプロフィールの予約リンクに入れてください。')}</p>
    </section>`;
}

/* 3. リピーターが自社に移っているか */
function numbersRepeat(m, site) {
  const n = k => site.filter(r => r.visit === k).length;
  const first = n('初めて');
  const again = n('2回目以降');
  const unknown = site.length - first - again;
  const rows = [['初めて', first], ['2回目以降', again]]
    .concat(unknown ? [['分かりません', unknown]] : []);

  return `
    <section class="num-card">
      <h3 class="num-title">${esc(m.label)}の 初めて／2回目以降</h3>
      ${numBars(rows, site.length)}
      <p class="num-read">${esc(
        'この「2回目以降」が、ホットペッパーを通さずに戻ってきてくださった方です。'
        + 'ここが増えているほど、掲載に払っている送客手数料は減っています。'
        + '会計のときにLINEをお伝えすると、いちばん動く数字です。')}</p>
    </section>`;
}

/* 4. 席がどれだけ埋まっているか */
function numbersOccupancy(m) {
  const o = occupancy(m);
  if (o.rate === null) {
    return numCard(`${m.label}の稼働率`, '分かりません', '', '',
      o.days === 0 && !o.until
        ? 'この月はまだ始まっていないため、数えられる日がありません。'
        : '営業時間が読み取れないか、この月に営業日がありませんでした。'
          + '「店舗情報」タブの営業開始・営業終了をご確認ください。', 'is-quiet');
  }
  return numCard(
    `${m.label}の稼働率`, `${Math.round(o.rate * 100)}%`, '',
    `${m.label}1日〜${Number(o.until.slice(8))}日／営業${o.days}日`
    + `／受けられた ${hoursText(o.open)} のうち ${hoursText(o.used)} が予約`,
    '席は1つです。ここが高いほど、掲載が新しいお客様を連れてきても'
    + '入れる場所が残っていません。逆にここが低いうちは、掲載を止めると'
    + '空いたままの時間が増えます。');
}

/* 5. ★本題：ホットペッパーに払わずに済んだ金額 */
function numbersSavings(m, site) {
  const rate = settingNumber('ホットペッパー手数料率（％）', 0, 100);
  const monthly = settingNumber('ホットペッパー掲載料（月額・円）', 0, 10000000);
  const priced = site.filter(r => Number(r.price) > 0);
  const total = priced.reduce((s, r) => s + Number(r.price), 0);
  const noPrice = site.length - priced.length;

  /* 率が入っていないときは、金額をひとつも出しません。
     こちらで率を決めて計算すると、それは実績ではなく作り話になります。 */
  if (rate === null) {
    return `
      <section class="num-card is-empty" id="numbers-savings">
        <h3 class="num-title">ホットペッパーに払わずに済んだ金額</h3>
        <p class="num-value">—</p>
        <p class="num-read">${esc(
          '手数料率が入っていないので、金額は出しません。'
          + '率も掲載料も契約プランごとに違うため、こちらで決めた数字を出すと作り話になります。'
          + 'ホットペッパーからの請求明細を見て入れてください。'
          + '「掲載料」と「予約1件あたりの手数料」を分けて見るのがこつです。')}</p>
        <button class="btn btn-outline btn-sm" type="button" id="numbers-to-settings">
          入力欄を開く（店舗情報タブ）
        </button>
      </section>`;
  }

  // 多めに言わないよう切り捨てます
  const saved = Math.floor(total * rate / 100);
  const avg = priced.length ? total / priced.length : 0;
  const perBooking = avg * rate / 100;

  const breakEven = monthly === null
    ? '掲載料が入っていないので、何件から掲載料を上回るかは出せません。'
      + '同じ欄に月額を入れてください。'
    : perBooking > 0
      ? `掲載料 ${yen(monthly)}/月 を上回るのは、自社サイト経由が月 ${Math.ceil(monthly / perBooking)}件 からです`
        + `（1件あたりの平均 ${yen(Math.round(avg))} で計算）。${m.label}は ${site.length}件でした。`
      : '金額の入ったご予約がこの月に無いため、何件から掲載料を上回るかは出せません。';

  return `
    <section class="num-card" id="numbers-savings">
      <h3 class="num-title">${esc(m.label)}にホットペッパーへ払わずに済んだ金額</h3>
      <p class="num-value">${esc(yen(saved))}</p>
      <p class="num-sub">${esc(`自社サイト経由 ${site.length}件 ／ 合計 ${yen(total)} × 手数料 ${rate}%`
        + (noPrice ? `（金額の決まっていない ${noPrice}件は合計に入っていません）` : ''))}</p>
      <p class="num-read">${esc(
        '同じご予約をホットペッパー経由で受けていたら、これだけ手数料で引かれていた計算です。'
        + '実際にその分が手元に残ったのではなく、引かれずに済んだ額です。')}</p>
      <p class="num-read">${esc(breakEven)}</p>
    </section>`;
}

/* 入口ごとのURL。ここからコピーして配ります */
function numbersLinks() {
  // admin.html を落とした場所が、このサイトの入口です
  const base = location.href.split('?')[0].replace(/[^/]*$/, '');
  return `
    <section class="num-card">
      <h3 class="num-title">入口ごとのURL（配る用）</h3>
      <p class="num-read">${esc(
        '上の「入口の内訳」は、配る先ごとに違うURLを使うことで分かれます。'
        + '同じURLを両方に貼ると、まとめて数えられます。'
        + 'お客様の画面は何も変わりません。URLの末尾が違うだけです。')}</p>
      ${VISIT_SOURCES.map(s => {
        const url = base + s.page + '?from=' + s.key;
        return `
        <div class="num-link">
          <p class="num-link-head">${esc(s.label)}</p>
          <p class="num-link-note">${esc(s.note)}</p>
          <div class="num-link-row">
            <input class="input" type="text" readonly value="${esc(url)}"
                   aria-label="${esc(s.label + '用のURL')}" />
            <button class="btn btn-outline btn-sm" type="button"
                    data-copy-url="${esc(url)}">コピー</button>
          </div>
        </div>`;
      }).join('')}
    </section>`;
}

/* この画面で分からないこと。
   出していない数字を店主が「無い」と読み違えると、判断がまるごと狂います。 */
function numbersUnknown() {
  return `
    <section class="num-card is-quiet">
      <h3 class="num-title">この画面で分からないこと</h3>
      <ul class="num-list">
        <li>ホットペッパー経由のご予約の件数と売上。あちらの管理画面にしかありません。
            「自社が何件になったか」は出せますが、「掲載を止めたら何件失うか」は出せません。</li>
        <li>ご来店になったかどうか。数えているのはご予約であって、来店ではありません。</li>
        <li>金額の決まっていないご予約（お見積り）の金額。合計には入れていません。</li>
        <li>電話でお受けした方が、どこを見てお電話くださったか。台帳では「電話・来店」までです。</li>
        <li>「予約の入口」の列を足す前のご予約。「記録なし」になり、さかのぼって埋まりません。</li>
      </ul>
    </section>`;
}

function renderNumbers() {
  const host = $('#numbers-body');
  if (!host || !adminData) return;
  const m = monthOf(numbersMonth);
  const prev = monthOf(numbersMonth - 1);
  const all = monthBookings(m.key);
  const site = all.filter(r => !isWalkIn(r));
  const siteBefore = monthBookings(prev.key).filter(r => !isWalkIn(r));

  /* 1件も無い月でも、画面は成り立たせます。0件は失敗ではなく、
     0件だと分かること自体が判断の材料です。 */
  host.innerHTML = [
    numbersCount(m, prev, site, siteBefore),
    numbersSources(m, all),
    numbersRepeat(m, site),
    numbersOccupancy(m),
    numbersSavings(m, site),
    numbersLinks(),
    numbersUnknown()
  ].join('');
}

function setNumbersMonth(offset) {
  numbersMonth = offset === -1 ? -1 : 0;
  $$('#numbers-month .tab').forEach(b =>
    b.setAttribute('aria-selected', String(Number(b.dataset.month) === numbersMonth)));
  renderNumbers();
}

/* 数字タブから、その数字を出すための入力欄まで連れていきます。
   「店舗情報タブの下のほうにあります」と書くだけでは、34項目の中から
   探すことになり、たいてい途中でやめます。 */
function openSettingSection(title) {
  const tab = document.querySelector('#admin-tabs .tab[data-pane="settings"]');
  if (tab) tab.click();
  const i = SETTING_SECTIONS.findIndex(s => s.title === title);
  const box = document.querySelector(`[data-setting-group="${i}"]`);
  if (!box) return;
  box.open = true;
  box.scrollIntoView({ block: 'start' });
}

/* コピーできない端末（許可されない・対応していない）でも行き止まりにしません。
   すぐ左に同じURLが出ているので、選んだ状態にして手で写せるようにします。 */
async function copyUrl(btn) {
  const row = btn.closest('.num-link-row');
  try {
    await navigator.clipboard.writeText(btn.dataset.copyUrl);
    btn.textContent = 'コピーしました';
  } catch (e) {
    const field = row && row.querySelector('input');
    if (field) field.select();
    btn.textContent = '長押しでコピー';
  }
  setTimeout(() => { btn.textContent = 'コピー'; }, 4000);
}

/* ---------- 写真 ----------
   選んだ写真をブラウザ側で長辺1200pxまで縮めてから送ります。
   スマホの写真はそのままだと数MBあり、Apps Script が受け取りきれないためです。
   縮めた画像は Apps Script が Google ドライブに保存し、
   サイトから表示できるURLを返してきます。ファイル名も向こうで付け直します。 */
const MAX_EDGE = 1200;

/* これを下回る写真は、サイトで引き伸ばされてぼやけます。

   スマホは細かい点を2倍で描くので、表示幅600pxの枠でも1200px要ります。
   実際、スタッフ写真に 254×336 の画像が入っていて、260×521 の枠に
   引き伸ばされたうえ切り抜かれていました。掲載から取り込んだ控え
   （assets/staff-matteo.jpg）は 853×1280 あるので、小さいほうが
   勝っていたことになります。

   止めはしません。外観の写真のように、小さくても他に無いものがあります。
   ただ、気づかずに上書きされるのがいちばん困るので、一度聞きます。 */
const MIN_EDGE = 800;

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('画像として開けませんでした。'));
      img.onload = () => {
        if (Math.max(img.width, img.height) < MIN_EDGE
            && !confirm(`この写真は ${img.width}×${img.height} と小さく、`
              + 'サイトでは引き伸ばされてぼやけます。\n'
              + `長いほうが ${MIN_EDGE}px 以上の写真をおすすめします。\n\n`
              + 'それでもこの写真を使いますか？')) {
          reject(new Error('小さいので登録しませんでした。大きい写真を選び直してください。'));
          return;
        }
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        // PNG は透過を保つためそのまま、それ以外は JPEG に寄せて軽くする
        const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        resolve({ dataUrl: canvas.toDataURL(mime, 0.85), mimeType: mime });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function uploadImage(file, slot) {
  if (!file.type || file.type.indexOf('image/') !== 0) {
    throw new Error('画像ファイルを選んでください。');
  }
  const { dataUrl, mimeType } = await shrinkImage(file);
  const res = await adminPost({ type: 'adminUpload', slot, mimeType, dataBase64: dataUrl });
  if (!res.ok) throw new Error(res.error || 'アップロードに失敗しました。');
  return res.url;
}

/** 画像1つぶんの入力欄。URL欄・選択ボタン・小さな見本 */
/* その行の「既定の写真」。リポジトリに置いてある写真の場所です。

   管理ページは data.js をそのまま読んでいて、シートの内容で上書きされません。
   だからここが既定の出どころになります。 */
function defaultImageFor(target, index) {
  const row = (edits[target] || [])[index] || {};
  const name = String(row['メニュー名'] || row['タイトル'] || '').trim();
  if (!name) return '';
  const from = target === 'coupons' ? (SALON.coupons || [])
    : target === 'menus' ? allMenuItems()
      : target === 'styles' ? (SALON.styles || []) : [];
  const hit = from.find(x => String(x.title || x.name || '').trim() === name);
  return hit && hit.image ? String(hit.image) : '';
}

function imageField(label, url, attrs, slot, mark = '', def = '') {
  const v = url == null ? '' : String(url);
  return `
    <div class="form-field"${mark} style="margin:0 0 10px;">
      <span style="display:block;font-size:12px;color:var(--muted);margin-bottom:5px;">${esc(label)}</span>
      <div class="image-picker">
        <div class="image-preview">${v ? `<img src="${esc(v)}" alt="" />` : '<span>写真なし</span>'}</div>
        <div class="image-picker-body">
          <input class="input" type="text" value="${esc(v)}" placeholder="写真を選ぶと自動で入ります" ${attrs} />
          <div class="image-picker-actions">
            <label class="btn btn-outline btn-sm">
              写真を選ぶ
              <input type="file" accept="image/*" hidden data-upload="${esc(slot)}" />
            </label>
            ${v ? '<button class="btn btn-ghost btn-sm" type="button" data-clear-image>削除</button>' : ''}
            ${/* 既定に戻す道が管理ページに無いと、店主は Apps Script を
                  開くしかありません。触れない場所に閉じ込めることになります。 */''}
            ${def && def !== v
              ? `<button class="btn btn-ghost btn-sm" type="button"
                         data-default-image="${esc(def)}">既定の写真に戻す</button>` : ''}
          </div>
          ${/* いま出ている写真が、店主が上げたものか既定か、何ピクセルか。
                これが見えないと、小さい写真を上げたことに誰も気づけません。
                実際に 254×336 と 310×372 が入ったまま公開直前まで残りました。 */''}
          <p class="image-size" data-image-size hidden></p>
          <p class="image-picker-note" hidden></p>
        </div>
      </div>
    </div>`;
}

/* 写真を選んだときの共通処理。どの入力欄に結果を書くかは、
   同じ .image-picker の中の text 入力を見て決めます。 */
async function handleUpload(input) {
  const file = (input.files || [])[0];
  if (!file) return;
  const picker = input.closest('.image-picker');
  const note = picker.querySelector('.image-picker-note');
  const text = picker.querySelector('input[type="text"]');
  note.hidden = false;
  note.style.color = 'var(--muted)';
  note.textContent = 'アップロード中…';

  try {
    const url = await uploadImage(file, input.dataset.upload);
    text.value = url;
    // 手入力と同じ扱いにして、編集内容に反映させる
    text.dispatchEvent(new Event('input', { bubbles: true }));
    picker.querySelector('.image-preview').innerHTML = `<img src="${esc(url)}" alt="" />`;
    note.style.color = 'var(--ok)';
    note.textContent = '写真を登録しました。設定の保存後、公開ページへの反映は別途更新が必要です。';
  } catch (err) {
    note.style.color = 'var(--danger)';
    note.textContent = String(err.message || err);
  } finally {
    input.value = '';
  }
}

/* ---------- 行の編集（休業日 / メニュー / おすすめメニュー / 写真） ---------- */
function fieldFor(col, value, target, index) {
  const v = value == null ? '' : value;
  /* どの欄かをCSSから見分けられるようにしておきます。
     価格・所要のような短い欄を横に2つ並べて、入力欄の縦を詰めるためです。
     縦に全部並べると、1件ぶんだけで画面1つぶんを超えて、
     いちばん下の「表示」に届く前に何を直していたか分からなくなります。 */
  const mark = ` data-field="${esc(col)}"`;
  if (col === '画像') {
    return imageField('画像',
      v,
      `data-target="${target}" data-index="${index}" data-col="画像"`,
      target + '-' + index, mark, defaultImageFor(target, index));
  }
  if (col === '表示') {
    return `<label class="checkbox-line"${mark} style="margin-top:8px;">
        <input type="checkbox" data-target="${target}" data-index="${index}" data-col="${esc(col)}"
               ${String(v).trim() === '×' ? '' : 'checked'} />
        <span>サイトに表示する</span>
      </label>`;
  }
  // 価格は「4000〜」と書けるようにしたいので number にはしない
  const type = col === '通常価格' ? 'number'
    : col === '休業日' ? 'date'
      : (col === '開始' || col === '終了') ? 'time' : 'text';
  /* 休み方は上のラジオで選ばせるようになったので、
     ここで「空欄なら終日」と説明する必要はなくなりました。 */
  const hint = col === '開始' ? '例）14:00'
    : col === '終了' ? '例）16:00'
      : col === '所要(分)' ? '15〜480分の整数' : '';
  return `
    <label class="form-field"${mark} style="margin:0 0 10px;">
      <span style="display:block;font-size:12px;color:var(--muted);margin-bottom:5px;">${esc(col)}${
        hint ? `<small style="margin-left:8px;font-weight:400;">${esc(hint)}</small>` : ''}</span>
      <input class="input" type="${type}"${col === '所要(分)' ? ' inputmode="numeric"' : ''} value="${esc(v)}"
             data-target="${target}" data-index="${index}" data-col="${esc(col)}" />
    </label>`;
}

/* 休業日の1行。

   直す前は「休業日・開始・終了・メモ」の入力欄が4つ並ぶだけでした。
   ところがこの4つは、2種類のまったく違うことを表しています。

     開始・終了が空       → その日は終日お休み（お客様はその日を選べない）
     開始・終了に時刻あり → その帯だけ止める（お客様は**その日を選べる**）

   画面からはこの違いが読み取れません。実際に、終日休みにしたつもりで
   時刻を入れてしまい、「休みにしたのにお客様の画面から予約できる」と
   なりました。店にとっていちばん起きてはいけない事故です。

   なので、どちらなのかを先に選ばせます。選んだ結果どうなるかも
   その場に文で出します。「終日」を選んだら時刻の欄自体を消すので、
   入れたまま残って効いてしまうこともありません。 */
function closedSummary(row) {
  const d = String(row['休業日'] || '').trim();
  const st = String(row['開始'] || '').trim();
  const en = String(row['終了'] || '').trim();
  if (!d) return '日付を入れてください。入れるまで、この行は保存しても効きません。';
  if (!st || !en) return `${d} は終日お休みになります。お客様はこの日を選べません。`;
  /* 営業時間を丸ごと覆う指定は、店の頭の中では「終日休み」です。
     ところが仕組みの上では「時間帯の指定がある日」なので、
     お客様のカレンダーにはその日が**選べる日として残ります**。
     枠は全部埋まって見えますが、休みだとは伝わりません。
     ここを黙って通すと「休みにしたのに予約が入った」に一番近づきます。 */
  const b = (typeof SALON !== 'undefined' && SALON.business) || {};
  if (b.openTime && b.closeTime && st <= b.openTime && en >= b.closeTime) {
    return `${d} の ${st}〜${en}。これは営業時間（${b.openTime}〜${b.closeTime}）を丸ごと覆っています。`
      + 'この指定のままだと、お客様の画面にはこの日が「選べる日」として残ります。'
      + '終日お休みにするなら「終日休み」を選んでください。';
  }
  return `${d} の ${st}〜${en} だけ受け付けません。`
    + 'この日の他の時間は、お客様から予約できます。';
}

/* ---------- 休業日：月のマス目 ----------
   出張で1週間まとめて塞ぐとき、下の一覧に7行足すのは時間がかかります。
   日を押すだけで終日休みを入り切りできるようにします。

   一覧は消しません。「14:00〜16:00だけ休み」とメモは、日を押すだけでは
   表せないためです。どちらも同じ edits.closed を触るので、
   片方で変えるともう片方にも出ます。 */
let ccalOffset = 0;   // 何か月ずらして見ているか

/** その日の休み方。'all' = 終日 / 'range' = 時間帯だけ / '' = 休みでない */
function closedStateOf(key) {
  const hit = edits.closed.filter(r => String(r['休業日'] || '').trim() === key);
  if (!hit.length) return '';
  return hit.some(r => !String(r['開始'] || '').trim() || !String(r['終了'] || '').trim())
    ? 'all' : 'range';
}

/** その日に入っている、キャンセルでない予約の数 */
function liveCountOn(key) {
  return (adminData.reservations || []).filter(r => r.date === key && !isCancelled(r)).length;
}

function renderClosedCalendar() {
  const host = $('#closed-cal');
  if (!host) return;
  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + ccalOffset);
  const year = base.getFullYear(), month = base.getMonth();
  const title = $('#ccal-title');
  if (title) title.textContent = `${year}年${month + 1}月`;

  const today = toKey(new Date());
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<td class="ccal-empty"></td>');
  for (let d = 1; d <= days; d++) {
    const key = toKey(new Date(year, month, d));
    const state = closedStateOf(key);
    const past = key < today;
    const live = liveCountOn(key);
    /* 過ぎた日は押せません。押しても意味が無いうえ、
       間違って過去の日を休みにすると、一覧に理由の分からない行が増えます。 */
    const cls = ['ccal-day', state === 'all' ? 'is-off' : '', state === 'range' ? 'is-part' : '',
      past ? 'is-past' : '', key === today ? 'is-today' : ''].filter(Boolean).join(' ');
    cells.push(`<td>
      <button type="button" class="${cls}" ${past ? 'disabled' : ''}
              data-ccal="${key}" aria-pressed="${state === 'all'}"
              aria-label="${month + 1}月${d}日${state === 'all' ? '・終日休み' : state === 'range' ? '・一部休み' : ''}">
        <span class="ccal-n">${d}</span>
        ${state === 'all' ? '<span class="ccal-mark">休</span>'
          : state === 'range' ? '<span class="ccal-mark is-part">一部</span>'
          : live ? `<span class="ccal-live">${live}件</span>` : '<span class="ccal-mark is-open">○</span>'}
      </button></td>`);
  }
  while (cells.length % 7) cells.push('<td class="ccal-empty"></td>');

  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(`<tr>${cells.slice(i, i + 7).join('')}</tr>`);

  host.innerHTML = `
    <table class="ccal">
      <thead><tr>${WEEKDAY_JA
        .map((w, i) => `<th class="${i === 0 ? 'is-sun' : i === 6 ? 'is-sat' : ''}">${w}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
}

/** 日を押したとき。終日休みの入り切り */
function toggleClosedDay(key) {
  const state = closedStateOf(key);

  /* 時間帯だけの休みが入っている日は、押しても切り替えません。
     「14:00〜16:00だけ休み」を終日に変えるのか、消すのかが決められないためです。
     下の一覧まで送って、そこで直してもらいます。 */
  if (state === 'range') {
    alert(`${formatDateJa(key)} は「時間帯だけ休み」で登録されています。\n`
      + '下の一覧から直してください。');
    const i = edits.closed.findIndex(r => String(r['休業日'] || '').trim() === key);
    const el = $$('#closed-rows .booking-card')[i];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  if (state === 'all') {
    edits.closed = edits.closed.filter(r => String(r['休業日'] || '').trim() !== key);
  } else {
    /* 予約が入っている日を休みにすると、そのお客様は台帳に残ったまま、
       画面上はお休みの日になります。店が気づかないまま当日を迎えるので、
       件数を見せてから聞きます。 */
    const live = liveCountOn(key);
    if (live && !confirm(`${formatDateJa(key)} には、すでに ${live}件 のご予約が入っています。\n`
      + 'お休みにしても、そのご予約は消えません。\n\n'
      + 'それでもこの日をお休みにしますか？')) return;
    edits.closed.push({ '休業日': key, '開始': '', '終了': '', 'メモ': '' });
    edits.closed.sort((a, b) => String(a['休業日']).localeCompare(String(b['休業日'])));
  }
  renderClosed();
  updateDirty();
}

function renderClosed() {
  renderClosedCalendar();
  const rows = edits.closed;
  $('#closed-rows').innerHTML = rows.length
    ? rows.map((row, i) => {
      const range = !!(String(row['開始'] || '').trim() && String(row['終了'] || '').trim());
      return `
        <div class="booking-card" style="border-left-color:var(--line);">
          ${fieldFor('休業日', row['休業日'], 'closed', i)}
          <div class="form-field" style="margin:0 0 10px;">
            <span style="display:block;font-size:12px;color:var(--muted);margin-bottom:5px;">休み方</span>
            <label class="checkbox-line" style="margin-bottom:4px;">
              <input type="radio" name="closed-mode-${i}" value="allday"
                     data-closed-mode="${i}" ${range ? '' : 'checked'} />
              <span>終日休み</span>
            </label>
            <label class="checkbox-line" style="margin-bottom:0;">
              <input type="radio" name="closed-mode-${i}" value="range"
                     data-closed-mode="${i}" ${range ? 'checked' : ''} />
              <span>この時間帯だけ休み</span>
            </label>
          </div>
          ${range ? fieldFor('開始', row['開始'], 'closed', i) + fieldFor('終了', row['終了'], 'closed', i) : ''}
          ${fieldFor('メモ', row['メモ'], 'closed', i)}
          <p data-closed-summary="${i}"
             style="font-size:12.5px;line-height:1.7;color:var(--text-2);
                    background:var(--panel-2);border-left:3px solid var(--accent);
                    padding:9px 12px;margin:0 0 10px;">${esc(closedSummary(row))}</p>
          <button class="btn btn-ghost btn-sm" type="button" data-remove="closed" data-index="${i}">この行を削除</button>
        </div>`;
    }).join('')
    : '<p class="empty-state">まだ登録がありません。下のボタンから追加してください。</p>';
}

/* ============================================================
   一覧 → 押した1件だけ入力欄を開く（メニュー／おすすめメニュー／写真）

   直す前は、1件ぶんの入力欄（区分・メニュー名・価格・所要・説明・画像・表示）が
   件数ぶん縦に並んでいるだけでした。単品メニュー4件で縦3648px、画面の4画面ぶんです。
   ・どんなメニューがあるのか、一覧では分からない
   ・カードの先頭が「区分」なので、何を編集しているのか2つ目の欄まで読まないと分からない
   ・保存がいちばん下にあるので、1件の値段を直すだけで長い往復になる
   という状態でした。

   そこで「1行1件の一覧」を上に置き、押した1件ぶんだけ入力欄を一覧の下に出します。
   一覧は上に残したままなので、直したあとも何があるかを見失いません。

   はじめは先頭の1件を開いた形で出します（openRow の初期値）。全部閉じていると、
   行が押せること自体に気づけません。使うのはコードを触らない方で、
   説明を読まずに触ります。いちばん上は必ず目に入るので、そこが開いていれば
   「押すと、その1件が開く」と分かります。
   ============================================================ */

/* 一覧の1行に何を出すか。タブごとに「何を見れば、その1件だと分かるか」が違います */
const LIST_VIEW = {
  menus: {
    title: r => r['メニュー名'],
    sub: r => `${priceText(r['価格'])} ・ ${minutesText(r['所要(分)'])}`,
    thumb: false,
    addLabel: '＋ メニューを追加',
    empty: 'まだメニューがありません。下の「＋ メニューを追加」から入れてください。'
  },
  coupons: {
    title: r => r['メニュー名'],
    sub: r => {
      const list = String(r['通常価格'] ?? '').trim();
      return `${priceText(r['価格'])}${list ? `（通常 ${priceText(list)}）` : ''}`
        + ` ・ ${minutesText(r['所要(分)'])}`;
    },
    thumb: false,
    addLabel: '＋ おすすめメニューを追加',
    empty: 'まだおすすめメニューがありません。下の「＋ おすすめメニューを追加」から入れてください。'
  },
  styles: {
    title: r => r['タイトル'],
    /* 写真タブだけは一覧にも写真を出します。
       タイトルだけ並べても、どの写真のことか思い出せません。 */
    /* タグはシートに「ショート,フェード」のように区切って入っています。
       打たれたままだと読点が並んで読みにくいので、サイト側と同じ区切りで割り直します。 */
    sub: r => [String(r['分類'] || '').trim() || '分類なし',
               String(r['タグ'] || '').split(/[,、・\s]+/).filter(Boolean).join('・')]
      .filter(Boolean).join(' ・ '),
    thumb: true,
    addLabel: '＋ 写真を追加',
    empty: 'まだ写真がありません。下の「＋ 写真を追加」から入れてください。'
  }
};

/* どのタブが、どの列と、どの置き場所を使うか */
const PANE = {
  closed:  [CLOSED_COLS, '#closed-rows'],
  menus:   [MENU_COLS, '#menu-rows'],
  coupons: [COUPON_COLS, '#coupon-rows'],
  styles:  [STYLE_COLS, '#style-rows']
};

/* 一覧に出す金額。シートには「4000〜」「2500」「￥3,000」など、
   店主が打ったままの形で入っています。そのまま出すと桁が読み取れないので、
   数として読めたものだけ ¥4,000〜 の形に直します。
   読めなかったときは、打たれたままを出します（勝手に消さない）。 */
function priceText(v) {
  const t = String(v ?? '').trim();
  if (!t) return '価格未設定';
  const half = toHalfWidth(t);
  const n = Number(half.replace(/[^0-9.]/g, ''));
  if (!isFinite(n) || !/[0-9]/.test(half)) return t;
  return yen(n) + (/[〜~]/.test(half) ? '〜' : '');
}
function minutesText(v) {
  const minutes = bookableMinutes(v);
  return minutes === null ? '所要時間を確認' : `${minutes}分`;
}
function bookableMinutes(value) {
  const match = toHalfWidth(value).trim().match(/^(\d+)\s*分?$/);
  const minutes = match ? Number(match[1]) : NaN;
  return Number.isInteger(minutes) && minutes >= 15 && minutes <= 480 ? minutes : null;
}
function firstInvalidBookableMinutes(rows) {
  return rows.findIndex(row => {
    if (!String(row['メニュー名'] || '').trim()) return false;
    const display = toHalfWidth(row['表示']).trim().toLowerCase();
    if (['×', '✕', '✖', '✗', 'x', '非表示', '非公開', '休止', '停止', 'false', 'no', 'off', '0'].includes(display)) return false;
    return bookableMinutes(row['所要(分)']) === null;
  });
}
/* 名前が空のままの行。一覧から消すと、消えたと思って同じものを作り直します */
const rowTitle = (target, row) =>
  String(LIST_VIEW[target].title(row) || '').trim() || '（名前がまだ入っていません）';

/* 削除の確認に出す「何を消そうとしているか」。
   「削除しますか？」だけだと、どの行を押したのか分からないまま はい を押します。 */
function removeLabel(target, row) {
  if (target === 'closed') {
    const d = String(row['休業日'] || '').trim();
    if (!d) return '休業日（日付がまだ入っていません）';
    return `休業日：${d}`
      + (row['開始'] && row['終了'] ? `　${row['開始']}〜${row['終了']}` : '　終日');
  }
  if (target === 'reviews') {
    const who = String(row['ニックネーム'] || 'お客様').trim();
    const what = String(row['タイトル'] || row['本文'] || '').trim().slice(0, 24);
    return `口コミ：${who} 様${what ? `「${what}」` : ''}`;
  }
  return rowTitle(target, row);
}

/** 一覧（1行1件）＋「＋ 追加」ボタン */
function listHtml(target) {
  const view = LIST_VIEW[target];
  const rows = edits[target];
  const body = rows.length ? rows.map((row, i) => {
    /* 「表示」を外した行も必ず一覧に出します。隠すと、消したつもりが無いのに
       消えたように見えて、同じメニューをもう1件作ってしまいます。 */
    const off = String(row['表示'] ?? '').trim() === '×';
    const img = String(row['画像'] || '').trim();
    const marks = [
      off ? '<span class="admin-mark is-off">非表示</span>' : '',
      /* 写真タブは左の見本で分かるので、印は出しません */
      (!view.thumb && img) ? '<span class="admin-mark">写真あり</span>' : '',
      rowDirty(row) ? '<span class="admin-mark is-dirty">未保存</span>' : ''
    ].join('');
    return `
      <button class="admin-row${i === openRow[target] ? ' is-open' : ''}${off ? ' is-off' : ''}"
              type="button" data-open="${esc(target)}" data-index="${i}"
              aria-expanded="${i === openRow[target] ? 'true' : 'false'}">
        ${view.thumb ? `<span class="admin-row-thumb">${img
          ? `<img src="${esc(img)}" alt="" />` : '<span>写真なし</span>'}</span>` : ''}
        <span class="admin-row-main">
          <span class="admin-row-title">${esc(rowTitle(target, row))}</span>
          <span class="admin-row-sub">${esc(view.sub(row))}</span>
        </span>
        ${marks ? `<span class="admin-row-marks">${marks}</span>` : ''}
        <span class="admin-row-chev" aria-hidden="true">›</span>
      </button>`;
  }).join('') : `<p class="empty-state">${esc(view.empty)}</p>`;

  return `<div class="admin-list-body">${body}</div>
    <button class="btn btn-ghost btn-sm admin-add" type="button"
            data-add="${esc(target)}">${esc(view.addLabel)}</button>`;
}

/** 開いている1件ぶんの入力欄。開いていなければ空 */
function editorHtml(target) {
  const i = openRow[target];
  const row = edits[target][i];
  if (!row) return '';
  const cols = PANE[target][0];
  return `
    <div class="admin-editor" data-editor="${esc(target)}">
      <div class="admin-editor-head">
        <span class="admin-editor-title">編集中：${esc(rowTitle(target, row))}</span>
        <button class="btn btn-ghost btn-sm" type="button"
                data-close-editor="${esc(target)}">閉じる</button>
      </div>
      ${cols.map(c => fieldFor(c, row[c], target, i)).join('')}
      <div class="admin-editor-foot">
        <button class="btn btn-outline btn-sm" type="button"
                data-close-editor="${esc(target)}">一覧に戻る</button>
        <button class="btn btn-ghost btn-sm" type="button"
                data-remove="${esc(target)}" data-index="${i}">この行を削除</button>
      </div>
    </div>`;
}

/* 一覧と、開いている1件ぶんの入力欄をまとめて描き直します。
   入力欄は一覧の「下」に置きます。行と行のあいだに挟むと、
   開けた瞬間に下の行が画面外へ押し出され、何件あるのか見えなくなります。 */
function renderList(target) {
  $(PANE[target][1]).innerHTML =
    `<div class="admin-list" data-list="${esc(target)}">${listHtml(target)}</div>`
    + editorHtml(target);
}

/* 打っている最中に呼ばれます。一覧の行だけ描き直して、入力欄には触りません。
   入力欄まで描き直すと、1文字打つたびにカーソルが飛んで先が打てなくなります。 */
function refreshList(target) {
  const box = document.querySelector(`[data-list="${target}"]`);
  if (!box) return;                     // 休業日・口コミ・店舗情報には一覧がありません
  box.innerHTML = listHtml(target);
  const title = document.querySelector(`[data-editor="${target}"] .admin-editor-title`);
  const row = edits[target][openRow[target]];
  if (title && row) title.textContent = '編集中：' + rowTitle(target, row);
}

/* ---------- まだ保存していない、を出す ---------- */
function markSaved(target) {
  if (target === 'settings') { settingsBase = JSON.stringify(edits.settings); return; }
  (edits[target] || []).forEach(r => rowBase.set(r, JSON.stringify(r)));
  baseCount[target] = (edits[target] || []).length;
}
/** その行が、読み込んだときから変わっているか（足したばかりの行も「変わっている」） */
function rowDirty(row) {
  return !rowBase.has(row) || rowBase.get(row) !== JSON.stringify(row);
}
function isDirty(target) {
  if (target === 'settings') return JSON.stringify(edits.settings) !== settingsBase;
  const rows = edits[target] || [];
  return rows.length !== (baseCount[target] || 0) || rows.some(rowDirty);
}
function dirtyText(target) {
  if (target === 'settings') return 'まだ保存していません。下の保存ボタンを押してください。';
  const rows = edits[target] || [];
  const changed = rows.filter(rowDirty).length;
  const removed = Math.max(0, (baseCount[target] || 0) - rows.length);
  const bits = [];
  if (changed) bits.push(`${changed}件`);
  if (removed) bits.push(`削除${removed}件`);
  return `まだ保存していません（${bits.join('・') || '変更あり'}）。下の保存ボタンを押してください。`;
}

/* 保存バーの文言・タブの赤い点・一覧の「未保存」を、まとめて出し直します */
function updateDirty() {
  ['closed', 'menus', 'coupons', 'styles', 'reviews', 'settings'].forEach(t => {
    const dirty = isDirty(t);
    if (dirty) savedNote[t] = '';       // 直したのに「保存しました」が残っていると読み違えます
    const note = document.querySelector(`[data-note="${t}"]`);
    if (note) {
      note.textContent = dirty ? dirtyText(t) : (savedNote[t] || '');
      note.className = 'admin-savebar-note'
        + (dirty ? ' is-dirty' : savedNote[t] ? ' is-ok' : '');
    }
    const bar = note && note.closest('.admin-savebar');
    if (bar) bar.classList.toggle('is-dirty', dirty);
    /* タブを離れても気づけるように、タブそのものにも印を付けます。
       別のタブに移ってから保存を押しに戻れるのは、この点があるからです。 */
    const tab = document.querySelector(`#admin-tabs .tab[data-pane="${t}"]`);
    if (tab) tab.classList.toggle('admin-tab-dirty', dirty);
  });
  /* 店舗情報は見出しで畳んであるので、タブの点だけでは
     どの見出しの中を直したのかが分かりません。 */
  updateSettingSections();
  const editSummary = $('#site-edit-tabs > summary');
  const pending = $$('#site-edit-tabs .admin-tab-dirty').length;
  if (editSummary) editSummary.textContent = pending ? `サイトの編集・設定（未保存 ${pending}項目）` : 'サイトの編集・設定';
}

/* 追加ボタンで作られる空の行 */
const BLANK_ROW = {
  closed:  { '休業日': '', '開始': '', '終了': '', 'メモ': '' },
  menus:   { '区分': 'カット', 'メニュー名': '', '価格': '', '所要(分)': 60, '説明': '', '画像': '', '表示': '○' },
  coupons: { 'メニュー名': '', '価格': '', '通常価格': '', '所要(分)': 60, '説明': '', '条件': '', '対象': '全員', '画像': '', '表示': '○' },
  styles:  { 'タイトル': '', '分類': 'ショート', 'タグ': '', '説明': '', '画像': '', '表示': '○' }
};

/* そのタブを丸ごと描き直します（追加・削除・保存のあと） */
function redraw(target) {
  if (target === 'reviews') renderReviews();
  else if (target === 'closed') renderClosed();
  else if (LIST_VIEW[target]) renderList(target);
  updateDirty();
}

/* 空欄にしたときどうなるかは、欄ごとに違います。
   タブの先頭にまとめて書くと、いま見ている欄がどちらなのか分かりません。
   欄の下に、その欄のことだけを書きます。 */
const BLANK_NOTE = {
  clear: '空欄にすると、サイトから消えます。',
  keep: '空欄にすると、いま出ている内容のままです。'
};

const settingHint = f => [f.hint, BLANK_NOTE[f.blank]].filter(Boolean).join('　');

function hintHtml(text, style = 'margin-top:5px;') {
  return text
    ? `<span style="display:block;font-size:11.5px;color:var(--muted);line-height:1.7;${style}">${esc(text)}</span>`
    : '';
}

/** 定休曜日は、7つのボタンを押す形のままにします（文字で書かせない） */
function weekdayFieldHtml() {
  const raw = String(edits.settings['定休曜日'] ?? '');
  const on = new Set(raw.split(/[,、・\s]+/).map(t => t.replace(/曜日?$/, '')).filter(Boolean));
  return `
    <div class="form-field">
      <span style="display:block;font-size:13px;font-weight:700;margin-bottom:6px;">定休曜日</span>
      <div class="weekday-picker">
        ${WEEKDAY_JA.map(w => `
          <label class="radio-chip">
            <input type="checkbox" data-weekday="${w}" ${on.has(w) ? 'checked' : ''} />
            <span>${w}</span>
          </label>`).join('')}
      </div>
      ${hintHtml('選んだ曜日は毎週ずっと予約できなくなります。1日だけ休むときは「休業日」タブをお使いください。')}
    </div>`;
}

function settingFieldHtml(f) {
  const v = edits.settings[f.key] ?? '';
  const hint = settingHint(f);

  if (f.type === 'weekdays') return weekdayFieldHtml();

  if (f.type === 'image') {
    return imageField(f.key, v, `data-setting="${esc(f.key)}"`, 'setting-' + f.key)
      + hintHtml(hint, 'margin:-4px 0 12px;');
  }

  const label = `<span style="display:block;font-size:13px;font-weight:700;margin-bottom:6px;">${esc(f.key)}</span>`;

  /* 出す／出さないのように答えが2つしかないものは、打たせません。
     「はい」「オン」「TRUE」と書かれるたびに読み方が増えます。 */
  if (f.type === 'choice') {
    /* シートがまだ空のとき（設置直後）は、いま掲載中の状態を選んでおきます。
       先頭の選択肢を出しておくと、画面には「出す」と見えているのに
       サイトでは帯が出ていない、という食い違いが起きます。 */
    const cur = String(v).trim() || (f.current ? f.current() : f.choices[0]);
    return `
    <label class="form-field">
      ${label}
      <select class="select" data-setting="${esc(f.key)}">
        ${f.choices.map(c => `<option value="${esc(c)}"${cur === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      ${hintHtml(hint)}
    </label>`;
  }

  /* 長い文と、1行1件で書く欄。1行の入力欄に入れると、
     打った先が見えないまま横に流れていきます。 */
  if (f.type === 'textarea') {
    return `
    <label class="form-field">
      ${label}
      <textarea class="input" rows="${f.rows || 4}" data-setting="${esc(f.key)}"
                style="min-height:${(f.rows || 4) * 26 + 20}px;">${esc(v)}</textarea>
      ${hintHtml(hint)}
    </label>`;
  }

  /* 数の欄。日本語入力のまま打った全角（「１８」）も受け取りたいので
     type="number" にはしません（空欄になって黙って既定値に戻ります）。
     読めない値は applySettings 側で捨てます。 */
  const type = f.type === 'time' ? 'time' : f.type === 'url' ? 'url' : f.type === 'tel' ? 'tel' : 'text';
  const extra = f.type === 'url' ? 'inputmode="url" placeholder="https://" '
    : f.type === 'number' ? `inputmode="numeric" placeholder="${f.min}〜${f.max}" `
      : f.type === 'tel' ? 'inputmode="tel" ' : '';
  return `
    <label class="form-field">
      ${label}
      <input class="input" type="${type}" ${extra}value="${esc(v)}" data-setting="${esc(f.key)}" />
      ${hintHtml(hint)}
    </label>`;
}

/* どの見出しの中に、まだ保存していない欄があるか。
   畳んでいるあいだは中が見えないので、見出しに印を出します。
   出さないと、直したことは覚えていても、どこを直したのか探せません。 */
function settingSectionDirty(section) {
  let base = {};
  try { base = JSON.parse(settingsBase || '{}'); } catch (e) { /* 読み込み前 */ }
  return section.fields.some(f =>
    String(edits.settings[f.key] ?? '') !== String(base[f.key] ?? ''));
}

function updateSettingSections() {
  SETTING_SECTIONS.forEach((s, i) => {
    const mark = document.querySelector(`[data-setting-mark="${i}"]`);
    if (mark) mark.textContent = settingSectionDirty(s) ? '●' : '';
  });
}

function renderSettings() {
  /* 折り畳みは、開いたときの1画面が目次になるように、全部畳んでおきます。
     どれか1つを開いておくと、その中身が目次の下半分を押し出します。 */
  $('#setting-rows').innerHTML = SETTING_SECTIONS.map((s, i) => `
    <details class="setting-group" data-setting-group="${i}">
      <summary style="padding:13px 4px;font-size:15px;font-weight:700;cursor:pointer;
                      border-bottom:1px solid var(--line-2);list-style:revert;">
        ${esc(s.title)}
        <span data-setting-mark="${i}" style="color:var(--danger);font-size:10px;vertical-align:2px;"></span>
      </summary>
      <div style="padding:14px 2px 4px;">
        ${s.note ? `<p class="note" style="margin:0 0 14px;">${esc(s.note)}</p>` : ''}
        ${s.fields.map(settingFieldHtml).join('')}
      </div>
    </details>`).join('');
  updateSettingSections();
}

/** 曜日のチェックから「日,水」の形にまとめて設定に入れる */
function collectWeekdays() {
  const on = $$('[data-weekday]').filter(el => el.checked).map(el => el.dataset.weekday);
  edits.settings['定休曜日'] = on.join(',');
}

/* 口コミは他のシートと扱いが違う。
   お客様が書いた本文・評価・お名前は表示のみにして、
   店舗が触れるのは「掲載するかどうか」と削除だけにしてある。 */
const REVIEW_STATES = ['未承認', '掲載中', '非掲載'];

function renderReviews() {
  const host = $('#review-rows');
  if (!host) return;
  const rows = edits.reviews;

  host.innerHTML = rows.length
    ? rows.map((r, i) => {
        const state = String(r['状態'] || '未承認');
        const who = [r['ニックネーム'], r['年代'], r['性別']].filter(Boolean).join('・');
        return `
        <div class="booking-card" style="border-left-color:${state === '掲載中' ? 'var(--ok)' : 'var(--line)'};">
          <div class="booking-head">
            <span class="status-chip ${state === '掲載中' ? '' : 'is-cancelled'}">${esc(state)}</span>
            <span class="booking-code">${esc(r['投稿日'] || '')}／${esc(r['予約番号'] || '')}</span>
          </div>
          <p class="booking-detail"><strong>${esc(stars(Number(r['評価']) || 5))}</strong> ${esc(who)}</p>
          ${r['タイトル'] ? `<p class="booking-when" style="font-size:15px;">${esc(r['タイトル'])}</p>` : ''}
          <p class="booking-detail" style="white-space:pre-wrap;">${esc(r['本文'] || '')}</p>
          <p class="booking-detail" style="font-size:12px;color:var(--muted);">
            ${esc(r['メニュー'] || '')}${r['担当'] ? '／' + esc(r['担当']) : ''}
          </p>
          <div class="booking-actions">
            ${REVIEW_STATES.map(v => `
              <label class="radio-chip">
                <input type="radio" name="rvstate${i}" value="${esc(v)}"
                       data-review-state="${i}" ${state === v ? 'checked' : ''} />
                <span>${esc(v)}</span>
              </label>`).join('')}
            <button class="btn btn-ghost btn-sm" type="button" data-remove="reviews" data-index="${i}">削除</button>
          </div>
        </div>`;
      }).join('')
    : '<p class="empty-state">まだ口コミは届いていません。</p>';
}

/* ---------- 保存 ---------- */
function showSaveError(target, message, rowIndex = -1) {
  const error = $('#save-error');
  error.textContent = message;
  error.style.display = 'block';
  if (rowIndex >= 0 && (target === 'menus' || target === 'coupons')) {
    openRow[target] = rowIndex;
    redraw(target);
  }
  const note = document.querySelector(`[data-note="${target}"]`);
  if (note) {
    note.textContent = message;
    note.className = 'admin-savebar-note is-error';
  }
  if (rowIndex >= 0) {
    const editor = document.querySelector(`[data-editor="${target}"]`);
    if (editor) {
      editor.scrollIntoView({ block: 'start' });
      const field = editor.querySelector('[data-col="所要(分)"]');
      if (field) field.focus();
    }
  }
}

async function save(target) {
  if (pendingSaves.has(target)) return;
  const err = $('#save-error');
  const ok = $('#save-ok');
  err.style.display = 'none';
  ok.style.display = 'none';

  const btn = document.querySelector(`[data-save="${target}"]`);
  if (target === 'settings') collectWeekdays();

  const submitted = JSON.parse(JSON.stringify(edits[target]));
  const submittedRows = target === 'settings' ? [] : edits[target].slice();
  if (target === 'menus' || target === 'coupons') {
    const invalidIndex = firstInvalidBookableMinutes(submitted);
    if (invalidIndex >= 0) {
      showSaveError(target, '予約に出すメニューの' + (invalidIndex + 1)
        + '件目の所要時間をご確認ください。15〜480分の整数を入力するか、表示を外してください。', invalidIndex);
      return;
    }
  }
  btn.disabled = true;
  btn.textContent = '保存中…';
  const payload = { type: 'adminSave', target, rows: submitted, stamp: stamps[target] };

  pendingSaves.add(target);
  let res;
  try {
    res = await adminPost(payload);
  } catch {
    res = { ok: false, error: '通信に失敗しました。入力を残しています。' };
  } finally {
    pendingSaves.delete(target);
    btn.disabled = false;
    btn.textContent = btn.dataset.label;
  }

  if (!res.ok) {
    showSaveError(target, res.error || '保存に失敗しました。',
      res.invalidDuration && Number.isInteger(res.invalidRow) ? res.invalidRow : -1);
    // 別の端末で変更されていた場合は、読み込み直す手段をその場に出す
    if (res.stale) {
      err.insertAdjacentHTML('beforeend',
        ' <button class="btn btn-outline btn-sm" type="button" id="reload-admin">読み込み直す</button>');
      const reload = $('#reload-admin');
      if (reload) reload.addEventListener('click', () => location.reload());
    }
    return;
  }
  if (res.stamps && res.stamps[target] != null) stamps[target] = res.stamps[target];
  /* 休業日は予約一覧にも出しているので、保存したらそちらも描き直します。
     保存したのに予定表が前のままだと、保存できたのか分かりません。 */
  if (target === 'closed') {
    adminData.closedDates = submitted;
    renderReservations();
    renderAdminCalendar();
  }
  if (target === 'menus' || target === 'coupons') adminData[target] = submitted.map(row => ({ ...row }));
  ok.textContent = saveResultMessage(target);
  ok.style.display = 'block';
  /* ここが保存の折り返し地点です。いま画面にある内容を「保存済み」として覚え直し、
     一覧の「未保存」とタブの点を消します。消さないと、保存したのに
     まだ残っているように見えて、同じ内容をもう一度送ることになります。 */
  if (target === 'settings') settingsBase = JSON.stringify(submitted);
  else {
    submittedRows.forEach((row, index) => rowBase.set(row, JSON.stringify(submitted[index])));
    baseCount[target] = submittedRows.length;
  }
  savedNote[target] = saveResultMessage(target);
  if (isDirty(target)) {
    ok.textContent = '送信した内容を保存しました。その後の変更は未保存です。';
    refreshList(target);
    updateDirty();
  } else redraw(target);
}

function saveResultMessage(target) {
  if (target === 'closed') return '休業日を保存しました。予約の受付に反映されます。既存の予約は変更されません。';
  if (target === 'menus' || target === 'coupons') return '予約用メニューを保存しました。公開ページの料金・写真は別途更新が必要です。';
  if (target === 'settings') return '設定を保存しました。予約の受付条件は反映されます。公開ページの文章・写真は別途更新が必要です。';
  if (target === 'reviews') return '旧口コミデータを保存しました。公開サイトやGoogle口コミには反映されません。';
  return '写真の設定を保存しました。公開ページへの反映は別途更新が必要です。';
}

/* ---------- CSV ---------- */
function exportCsv() {
  const list = filteredReservations();
  if (!list.length) { alert('出力できる予約がありません。'); return; }
  /* 施術メモも出します。店が自分の控えとして書き出すものなので、
     店が書いた欄が抜けていると、控えとして使えません。
     ただしこの中身は店の覚え書きです。**お客様に渡す紙には使えません。** */
  const head = ['予約番号', '来店日', '開始', '終了', 'メニュー', '担当', '金額',
    'お名前', '電話番号', 'メール', '来店回数', 'ご要望', '状態', '施術メモ'];
  const body = list.map(r => [r.code, r.date, r.time, r.endTime, r.menu, r.staffName,
    r.price, r.name, r.tel, r.email, r.visit, r.request, r.status, r.note]);
  /* 「=」「+」「-」「@」で始まる文字は、ExcelやGoogleスプレッドシートで
     開いたときに数式として実行されます。お名前欄に式を書いて予約した人がいると、
     このCSVを開いた店側の端末でそれが動きます。先頭に ' を足して文字に固定します。 */
  const safe = v => {
    const t = String(v ?? '');
    return (/^[=+\-@]/.test(t) ? "'" + t : t).replace(/"/g, '""');
  };
  const csv = [head, ...body]
    .map(cols => cols.map(c => `"${safe(c)}"`).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `reservations_${toKey(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function showReservationFreshness() {
  $('#reservation-freshness').textContent = `最終読込：${new Date().toLocaleString('ja-JP')}（自動更新ではありません）`;
}

function hasUnsavedReservationNotes() {
  if (pendingNoteSaves.size) return true;
  return $$('[data-note-box]').some(box => {
    const input = box.querySelector('[data-note-input]');
    return input.value.trim() !== input.defaultValue.trim();
  });
}

function guardNoteFilters(previousValues) {
  if (!hasUnsavedReservationNotes() && !activeChange) return true;
  Object.entries(previousValues).forEach(([selector, value]) => {
    const field = $(selector);
    if (field) field.value = value;
  });
  alert(activeChange
    ? '日時変更の入力中です。保存または閉じてから表示を切り替えてください。'
    : '書きかけ、または保存中の施術メモがあります。保存を終えてから表示を切り替えてください。');
  return false;
}

async function refreshReservations() {
  const status = $('#reservation-freshness');
  if (hasUnsavedReservationNotes() || activeChange) {
    status.textContent = '編集中の予約を保存または閉じてから、予定を読み込んでください。';
    return;
  }
  const button = $('#refresh-reservations');
  button.disabled = true;
  status.textContent = '最新の予定を読み込んでいます。';
  try {
    const result = await adminPost({ type: 'adminData' });
    if (!result.ok) throw new Error('読み込み失敗');
    if (hasUnsavedReservationNotes() || activeChange) {
      status.textContent = '編集中の予約があるため更新を保留しました。保存後に読み込んでください。';
      return;
    }
    adminData.reservations = result.reservations || [];
    adminData.closedDates = result.closedDates || [];
    renderStats();
    renderReservations();
    renderAdminCalendar();
    renderCustomers();
    renderNumbers();
    showReservationFreshness();
    return true;
  } catch {
    status.textContent = '最新の予定を取得できませんでした。表示中の予定は古い可能性があります。再度読み込んでください。';
  } finally {
    button.disabled = false;
  }
}

function warnBeforeLeaving(event) {
  if (!adminData || $('#dashboard').hidden) return;
  const pending = Object.keys(edits).some(isDirty)
    || pendingSaves.size || phoneSubmitting || phoneUncertain || phoneRequestId
    || hasUnsavedReservationNotes() || activeChange || !$('#add-booking-form').hidden;
  if (!pending) return;
  event.preventDefault();
  event.returnValue = '';
}

/* ---------- 起動 ---------- */
document.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('beforeunload', warnBeforeLeaving);
  const savebarObserver = new ResizeObserver(entries => {
    entries.forEach(({ target }) => {
      target.closest('.admin-pane').style.setProperty('--admin-savebar-height', `${target.getBoundingClientRect().height}px`);
    });
  });
  $$('.admin-savebar').forEach(bar => savebarObserver.observe(bar));
  $('#refresh-reservations').addEventListener('click', refreshReservations);
  /* 受け口が入っていないとき。
     以前はここで入力欄とボタンを disabled にしていましたが、
     設置作業中の人が「文字が入れられない」で止まりました。
     欄が死んでいる理由は、上の案内文からは読み取れません。

     しかも、この案内文はしばしば嘘になります。設置は済んでいるのに、
     ブラウザや GitHub Pages が古い data.js を握っているだけ、という
     ことが起きます（実際に起きました）。そのときに
     「まだ設置していません」と言い切るのは、間違った方向へ人を送ります。

     なので欄は生かしたままにして、押した人に両方の可能性を伝えます。 */
  if (!SALON.reservationEndpoint) {
    $('#gate-message').textContent =
      '予約の受け口（Apps Script のURL）が読み込めていません。'
      + 'まず、このページを読み込み直してください。';
    const err = $('#gate-error');
    $('#gate-btn').addEventListener('click', () => {
      err.innerHTML =
        'この画面はまだ受け口につながっていません。<br>'
        + '① キーボードの <b>Ctrl+Shift+R</b>（Mac は <b>⌘+Shift+R</b>）で読み込み直す<br>'
        + '　 設置した直後は、古い内容が数分残ることがあります。<br>'
        + '② それでも変わらなければ、Apps Script の設置がまだ済んでいません。'
        + '設置手順は README をご覧ください。';
      err.style.display = 'block';
    });
    $('#passcode').addEventListener('keydown', e => {
      if (e.key === 'Enter') $('#gate-btn').click();
    });
    return;
  }

  $$('[data-save]').forEach(b => { b.dataset.label = b.textContent; });

  if (!window.googleAdminEmbedded) {
    $('#gate-btn').addEventListener('click', login);
    $('#passcode').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  }

  // タブ切り替え
  $('#admin-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const editorTabs = $('#site-edit-tabs');
    editorTabs.open = editorTabs.contains(tab);
    document.body.classList.toggle('admin-edit-mode', editorTabs.open);
    $$('.tab', $('#admin-tabs')).forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    $$('.admin-pane').forEach(p => { p.hidden = p.dataset.pane !== tab.dataset.pane; });
    /* 数字は、店舗情報タブで入れた手数料率をそのまま使います。
       開いたときに描き直さないと、入れた直後に見に来た店主の画面に
       「手数料率が入っていません」が残ります。 */
    if (tab.dataset.pane === 'numbers') renderNumbers();
  });

  // 入力の反映
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.matches('[data-note-input]')) {
      const code = el.closest('[data-note-box]').dataset.noteBox;
      $$(`[data-note-box="${CSS.escape(code)}"]`).forEach(noteBox => {
        noteBox.querySelector('[data-note-input]').value = el.value;
        noteBox.querySelector('[data-note-status]').textContent = '';
      });
      return;
    }
    if (el.dataset.setting !== undefined) {
      edits.settings[el.dataset.setting] = el.value;
      updateDirty();
      return;
    }
    if (el.dataset.target === undefined) return;
    const target = el.dataset.target;
    const row = edits[target][Number(el.dataset.index)];
    if (!row) return;
    row[el.dataset.col] = el.type === 'checkbox' ? (el.checked ? '○' : '×') : el.value;
    /* 休業日は「いま入れた内容だとどうなるか」をその場に文で出しています。
       打った先から追いつかないと、確かめるために保存する羽目になります。
       入力欄ごと描き直すとカーソルが飛ぶので、文だけ差し替えます。 */
    if (target === 'closed') {
      const note = $(`[data-closed-summary="${el.dataset.index}"]`);
      if (note) note.textContent = closedSummary(row);
    }
    /* 一覧の行だけ描き直します（入力欄には触りません）。
       名前や値段を打った先から一覧に出ないと、どの行を直しているのか
       分からなくなりますが、入力欄まで描き直すとカーソルが飛びます。 */
    refreshList(target);
    updateDirty();
  });
  document.addEventListener('change', e => {
    const el = e.target;
    /* 「出す／出さない」の選択欄。端末によっては input が来ないので、
       こちらでも受け取ります（来なかったら未保存の印も出ません）。 */
    if (el.dataset.setting !== undefined) {
      edits.settings[el.dataset.setting] = el.value;
      updateDirty();
      return;
    }
    if (el.dataset.reviewState !== undefined && el.checked) {
      const row = edits.reviews[Number(el.dataset.reviewState)];
      if (row) row['状態'] = el.value;
      updateDirty();
      return;
    }
    /* 定休曜日は保存時にまとめていたので、押しても「未保存」が出ませんでした。
       出ないと、押しただけで決まったと思って画面を離れます。 */
    if (el.dataset.weekday !== undefined) { collectWeekdays(); updateDirty(); return; }
    /* 休み方の切り替え。終日を選んだら時刻を消します。
       残したままにすると、画面には「終日」と出ているのに
       中身は時間帯だけの休みのまま、という食い違いが起きます。 */
    if (el.dataset.closedMode !== undefined && el.checked) {
      const row = edits.closed[Number(el.dataset.closedMode)];
      if (row) {
        if (el.value === 'allday') { row['開始'] = ''; row['終了'] = ''; }
        else if (!row['開始'] && !row['終了']) {
          // 時刻の欄を出すだけでは、何を入れる欄なのか分かりません
          row['開始'] = SALON.business.openTime;
          row['終了'] = SALON.business.closeTime;
        }
        renderClosed();
        updateDirty();
      }
      return;
    }
    if (el.type === 'checkbox' && el.dataset.target !== undefined) {
      const row = edits[el.dataset.target][Number(el.dataset.index)];
      if (row) row[el.dataset.col] = el.checked ? '○' : '×';
      refreshList(el.dataset.target);
      updateDirty();
    }
  });

  // 行の追加・削除・保存
  document.addEventListener('click', async e => {
    const mail = e.target.closest('[data-mail-code]');
    if (mail) { focusBooking(mail.dataset.mailCode); return; }
    const past = e.target.closest('[data-toggle-past]');
    if (past) {
      if (!guardNoteFilters(renderedReservationFilters)) return;
      showPast = !showPast;
      renderReservations();
      return;
    }

    // カレンダーのマス。その1件の詳細（一覧のカード）まで送ります
    const cal = e.target.closest('[data-cal-code]');
    if (cal) { focusBooking(cal.dataset.calCode); return; }

    const customer = e.target.closest('[data-customer-history]');
    if (customer) {
      e.preventDefault();
      const record = customer.closest('.customer-record');
      if ($('#customer-rows .customer-record[open]') && !guardNoteFilters({})) return;
      $$('.customer-record[open]').forEach(other => { if (other !== record) other.open = false; });
      record.open = !record.open;
      customer.focus({ preventScroll: true });
      customer.scrollIntoView({ block: 'nearest' });
      return;
    }

    const closeCustomer = e.target.closest('[data-customer-close]');
    if (closeCustomer) {
      if (!guardNoteFilters({})) return;
      const record = closeCustomer.closest('.customer-record');
      record.open = false;
      const summary = record.querySelector('[data-customer-history]');
      summary.focus({ preventScroll: true });
      summary.scrollIntoView({ block: 'nearest' });
      return;
    }

    const customerBooking = e.target.closest('[data-customer-booking]');
    if (customerBooking) { startCustomerBooking(customerBooking.dataset.customerBooking); return; }

    const booking = e.target.closest('[data-history-booking]');
    if (booking) {
      if (hasUnsavedReservationNotes()) {
        alert('書きかけの施術メモを保存してから、予約の詳細を開いてください。');
        return;
      }
      $('#admin-tabs [data-pane="reserve"]').click();
      focusBooking(booking.dataset.historyBooking);
      return;
    }

    const cp = e.target.closest('[data-copy-url]');
    if (cp) { await copyUrl(cp); return; }

    if (e.target.closest('#numbers-to-settings')) {
      openSettingSection('ホットペッパーとの比較');
      return;
    }

    /* 一覧の行を押した。押した1件だけを開き、ほかは閉じたままにする。
       もう一度同じ行を押せば閉じて、一覧だけに戻る。 */
    const op = e.target.closest('[data-open]');
    if (op) {
      const t = op.dataset.open;
      const i = Number(op.dataset.index);
      openRow[t] = (openRow[t] === i) ? -1 : i;
      redraw(t);
      /* 入力欄は一覧の下に出ます。写真が何十枚もあると一覧が長くなり、
         押しても画面が変わらないように見えるので、その場まで送ります。 */
      const ed = document.querySelector(`[data-editor="${t}"]`);
      if (ed) ed.scrollIntoView({ block: 'start' });
      return;
    }

    const cl = e.target.closest('[data-close-editor]');
    if (cl) {
      const t = cl.dataset.closeEditor;
      openRow[t] = -1;
      redraw(t);
      const list = document.querySelector(`[data-list="${t}"]`);
      if (list) list.scrollIntoView({ block: 'start' });
      return;
    }

    const add = e.target.closest('[data-add]');
    if (add) {
      const t = add.dataset.add;
      edits[t].push(BLANK_ROW[t] ? { ...BLANK_ROW[t] } : {});
      // 足した行は、そのまま打ち込めるように開いておく
      if (openRow[t] !== undefined) openRow[t] = edits[t].length - 1;
      redraw(t);
      const ed = document.querySelector(`[data-editor="${t}"]`);
      if (ed) ed.scrollIntoView({ block: 'start' });
      return;
    }

    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const t = rm.dataset.remove;
      const i = Number(rm.dataset.index);
      const row = edits[t][i];
      if (!row) return;
      /* 確かめずに消していました。指がすべって消えると、何が入っていたか
         思い出せません（説明や写真は打ち直せません）。 */
      if (!confirm(`${removeLabel(t, row)}\n\nこの行を削除します。よろしいですか？\n`
          + '※削除は保存時に確定します。公開ページへの反映は別途更新が必要です。')) return;
      edits[t].splice(i, 1);
      if (openRow[t] !== undefined) openRow[t] = -1;
      redraw(t);
      return;
    }

    const sv = e.target.closest('[data-save]');
    if (sv) { await save(sv.dataset.save); return; }

    const nt = e.target.closest('[data-note-save]');
    if (nt) { await saveNote(nt); return; }

    const change = e.target.closest('[data-admin-change]');
    if (change) { openAdminChange(change); return; }
    const changeSave = e.target.closest('[data-change-save]');
    if (changeSave) { await saveAdminChange(changeSave); return; }
    const changeCheck = e.target.closest('[data-change-check]');
    if (changeCheck) { await checkAdminChange(changeCheck); return; }
    if (e.target.closest('[data-change-close]')) { closeAdminChange(); return; }

    const cx = e.target.closest('[data-admin-cancel]');
    if (cx) {
      if (activeChange) {
        alert('日時変更の入力を閉じてからキャンセルしてください。');
        return;
      }
      const code = cx.dataset.adminCancel;
      if (!confirm(`予約番号 ${code} をキャンセル扱いにします。よろしいですか？`)) return;
      cx.disabled = true;
      const r = (adminData.reservations || []).find(x => x.code === code) || {};
      /* 店としてのキャンセルなので、パスワード（または記憶した合鍵）を添えます。
         お客様の電話番号を打ち直さずに反映できます。 */
      const res = await adminPost({ type: 'cancel', code, date: r.date, time: r.time, name: r.name });
      if (!res.ok) {
        cx.disabled = false;
        /* 受信側は「前日18時まで」でキャンセルを断ります。お客様向けの決まりですが、
           店から入れた当日のキャンセルも同じ理由で断られます。
           そのままの文言を出すと「店舗までご連絡ください」と自分に言われることになり、
           何をすれば枠が空くのか分かりません。 */
        alert(res.deadline
          ? `予約番号 ${code} は、受付期限を過ぎているとして断られました。\n\n`
            + 'キャンセルは完了していません。予約の受け口が古い可能性があります。制作担当者へご連絡ください。'
          : 'キャンセルできませんでした。' + (res.error ? '\n' + res.error : ''));
        return;
      }
      r.status = 'キャンセル';
      reconcilePhoneResult();
      cx.textContent = 'キャンセル済み';
      cx.closest('.booking-card').classList.add('is-cancelled');
      renderStats();
      renderAdminCalendar();
      if (res.calendarWarning) {
        alert('キャンセルは予約台帳に反映しましたが、カレンダー連携は未確認です。予約台帳を正として制作担当者へお知らせください。');
      }
      await refreshReservations();
    }
  });

  /* 写真が読み込めたら、実寸と出どころを欄の下に出します。

     これが見えないせいで、254×336 のスタッフ写真と 310×372 の
     メニュー写真が、公開直前まで気づかれずに残っていました。
     店主から見れば「登録しました」と出た写真です。粗いことは、
     お客様がサイトを見るまで誰も分かりません。

     load は泡立たないので、捕まえる側で拾います。 */
  document.addEventListener('load', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const picker = img.closest('.image-picker');
    if (!picker) return;
    const out = picker.querySelector('[data-image-size]');
    if (!out) return;
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w) return;
    const src = img.getAttribute('src') || '';
    const from = /^https?:\/\//.test(src) ? 'アップロードした写真' : '既定の写真';
    const small = Math.max(w, h) < MIN_EDGE;
    out.hidden = false;
    out.style.color = small ? 'var(--danger)' : 'var(--muted)';
    out.textContent = `${from}・${w}×${h}`
      + (small ? `（小さいので、サイトでは引き伸ばされてぼやけます。${MIN_EDGE}px以上を推奨）` : '');
  }, true);

  // 写真の選択
  document.addEventListener('change', e => {
    if (e.target.dataset && e.target.dataset.upload !== undefined) handleUpload(e.target);
  });
  /* 「既定の写真に戻す」。押すと、リポジトリに置いてある写真の場所を入れます。
     これが無いと、店主は Apps Script を開かないと既定に戻せません。 */
  document.addEventListener('click', e => {
    const def = e.target.closest('[data-default-image]');
    if (!def) return;
    const picker = def.closest('.image-picker');
    const text = picker.querySelector('input[type="text"]');
    text.value = def.dataset.defaultImage;
    text.dispatchEvent(new Event('input', { bubbles: true }));
    picker.querySelector('.image-preview').innerHTML =
      `<img src="${esc(def.dataset.defaultImage)}" alt="" />`;
    const note = picker.querySelector('.image-picker-note');
    note.hidden = false;
    note.style.color = 'var(--ok)';
    note.textContent = '既定の写真に戻しました。設定の保存後、公開ページへの反映は別途更新が必要です。';
  });

  document.addEventListener('click', e => {
    const clr = e.target.closest('[data-clear-image]');
    if (!clr) return;
    const picker = clr.closest('.image-picker');
    const text = picker.querySelector('input[type="text"]');
    text.value = '';
    text.dispatchEvent(new Event('input', { bubbles: true }));
    picker.querySelector('.image-preview').innerHTML = '<span>写真なし</span>';
    clr.remove();
  });

  const forget = $('#forget-device');
  if (forget) forget.addEventListener('click', forgetDevice);

  $('#reserve-view').addEventListener('click', e => {
    const b = e.target.closest('[data-view]');
    if (b) setReserveView(b.dataset.view);
  });
  $('#numbers-month').addEventListener('click', e => {
    const b = e.target.closest('[data-month]');
    if (b) setNumbersMonth(Number(b.dataset.month));
  });
  $('#acal-prev').addEventListener('click', () => { acalOffset -= ACAL_DAYS; renderAdminCalendar(); });
  $('#acal-next').addEventListener('click', () => { acalOffset += ACAL_DAYS; renderAdminCalendar(); });

  $('#ccal-prev').addEventListener('click', () => { ccalOffset -= 1; renderClosedCalendar(); });
  $('#ccal-next').addEventListener('click', () => { ccalOffset += 1; renderClosedCalendar(); });
  $('#closed-cal').addEventListener('click', e => {
    const b = e.target.closest('[data-ccal]');
    if (b && !b.disabled) toggleClosedDay(b.dataset.ccal);
  });

  $('#filter-date').addEventListener('change', onFilterChange);
  $('#filter-today').addEventListener('click', showTodayReservations);
  $('#filter-status').addEventListener('change', onFilterChange);
  $('#customer-search').addEventListener('input', renderCustomers);
  $('#customer-sort').addEventListener('change', renderCustomers);
  $('#add-booking').addEventListener('click', () => toggleAddBooking($('#add-booking-form').hidden));
  $('#ab-cancel').addEventListener('click', () => toggleAddBooking(false));
  $('#ab-save').addEventListener('click', () => saveAddBooking(false));
  $('#ab-check').addEventListener('click', checkPhoneResult);
  $('#ab-menu-preset').addEventListener('change', applyPhonePreset);
  $('#filter-reset').addEventListener('click', () => {
    $('#filter-date').value = '';
    $('#filter-status').value = 'all';
    onFilterChange();
  });
  $('#export-csv').addEventListener('click', exportCsv);

  /* 前に「この端末を記憶する」を選んでいれば、合鍵で黙って入る。
     合鍵が期限切れ・失効していれば、いつもどおりパスワードを聞く画面のままにする。 */
  let saved = '';
  try { saved = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* noop */ }
  if (saved && !window.googleAdminEmbedded) restoreRememberedLogin(saved);
});
