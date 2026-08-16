/* ============================================================
 *  共通処理：ヘッダー/フッター描画・ユーティリティ・
 *  予約データ保存・空席計算エンジン
 * ============================================================ */

/* ---------- 短縮セレクタ ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- フォーマット ---------- */
const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
const pad2 = n => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD'（ローカルタイム基準） */
function toKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** 'YYYY-MM-DD' -> Date（ローカル0時） */
function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
/** 'YYYY-MM-DD' -> '8月17日(月)' */
function formatDateJa(key, opt = {}) {
  const d = fromKey(key);
  const wd = WEEKDAY_JA[d.getDay()];
  return opt.short
    ? `${d.getMonth() + 1}/${d.getDate()}(${wd})`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${wd})`;
}
/** '10:30' -> 630（分） */
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
/** 630 -> '10:30' */
function toHHMM(min) {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}
/** 所要時間の表示（90 -> '1時間30分'）
 *  シートに数字以外が入っていても「NaN分」と出さない */
function formatDuration(min) {
  const total = Number(min);
  if (!Number.isFinite(total) || total <= 0) return `${SALON.business.slotMinutes}分`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}時間${m}分`;
  if (h) return `${h}時間`;
  return `${m}分`;
}
/** 文字列から 0〜1 の決定的な擬似乱数（同じ入力なら常に同じ値） */
function seededRandom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
/* 一覧はスプレッドシートが届いたあとにもう一度描く。
   そのとき同じリスナーを二重に張らないための目印。
   二重に張ると1回のタップが2回分になり、選んだ直後に解除されてしまう。
   （2つのファイルで別々に持つと、両方を読み込む場面で衝突するのでここに置く） */
const boundOnce = new Set();
function bindOnce(key, fn) {
  if (boundOnce.has(key)) return;
  boundOnce.add(key);
  fn();
}

/* ネットでの変更・キャンセルを受け付ける期限の言い方。

   「前日18時」は、いくつもの画面と、確認メールの本文に出ます。
   店主が管理ページで期限を変えられるようになったので、文字を直書きして
   あると、そこだけ古い時刻を案内し続けます。しかも案内している側は
   お客様の画面を見ないので、ずれていることに気づけません。 */
function deadlineLabel() {
  const rule = SALON.business.cancelDeadline || { daysBefore: 1, hour: 18 };
  return rule.daysBefore === 1
    ? `前日${rule.hour}時`
    : `${rule.daysBefore}日前の${rule.hour}時`;
}

/** HTMLエスケープ */
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
/** 星表示 */
/* 星の数。

   四捨五入すると 4.5 が★5つになり、「4.5」と書いた隣に満点の星が並びます。
   実際より高く見せることになるので、切り捨てます。
   半分の星は使いません。端末によっては豆腐（□）になる文字だからです。
   細かい数字は、星のとなりに数値でも出しています。 */
function stars(score) {
  const n = Number(score);
  const full = Math.max(0, Math.min(5, Math.floor(isFinite(n) ? n : 0)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

/* ============================================================
 *  入力のゆれをならす
 *
 *  日本語入力を切り替えずに打つと、数字も記号も全角になります。
 *  フリガナはひらがなで書く方も、半角カナで書く方もいます。
 *  そのたびに「入力し直してください」と出すのは、こちらの都合です。
 *  読み取れるものは、こちらで直してから受け取ります。
 * ============================================================ */
const KANA_HALF = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
const KANA_FULL = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';
const VOICED = (() => {
  const m = { 'ｳﾞ': 'ヴ' };
  'ｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾊﾋﾌﾍﾎ'.split('').forEach((c, i) => { m[c + 'ﾞ'] = 'ガギグゲゴザジズゼゾダヂヅデドバビブベボ'[i]; });
  'ﾊﾋﾌﾍﾎ'.split('').forEach((c, i) => { m[c + 'ﾟ'] = 'パピプペポ'[i]; });
  return m;
})();

/** 全角の英数字・記号を半角に、全角スペースを空白に */
function toHalfWidth(v) {
  return String(v ?? '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

/** ひらがな・半角カナをカタカナに揃える */
function toKatakana(v) {
  const t = String(v ?? '');
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const pair = t.slice(i, i + 2);
    if (VOICED[pair]) { out += VOICED[pair]; i++; continue; }
    const j = KANA_HALF.indexOf(t[i]);
    if (j !== -1) { out += KANA_FULL[j]; continue; }
    // ひらがなはカタカナへ（ぁ〜ゖ）
    const code = t.charCodeAt(i);
    out += (code >= 0x3041 && code <= 0x3096) ? String.fromCharCode(code + 0x60) : t[i];
  }
  return out;
}

/** 電話番号：全角と、いろいろな形の「ー」を半角に揃える */
function normalizeTel(v) {
  return toHalfWidth(v).replace(/[‐‑‒–—―ー−ｰ]/g, '-').replace(/\s+/g, '').trim();
}

/** メールアドレス：全角のまま送られると届きません */
function normalizeEmail(v) {
  return toHalfWidth(v).replace(/\s/g, '').trim();
}

/** 予約番号：小文字・全角・「ー」で打っても同じ番号として扱う */
function normalizeCode(v) {
  return toHalfWidth(v).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/* ---------- マスタ参照ヘルパー ---------- */
const allMenuItems = () => SALON.menuCategories.flatMap(c => c.items);
const findMenu = id => allMenuItems().find(m => m.id === id) || SALON.coupons.find(c => c.id === id) || null;
const findStaff = id => SALON.staff.find(s => s.id === id) || null;
const staffLabel = id => (id ? (findStaff(id)?.name ?? '不明') : '指名なし');

/* ============================================================
 *  予約データストア
 *  GitHub Pages は静的サイトのためブラウザの localStorage に保存します。
 *  SALON.reservationEndpoint を設定すると外部へも送信します。
 * ============================================================ */
const STORE_KEY = 'salon.reservations.v1';

/* 日時変更の受け渡し用。
   予約確認ページが書き、予約ページが読みます。
   予約の中身をURLに載せるとお名前や電話番号が履歴に残るため、
   この端末の中だけで渡します。 */
const CHANGE_KEY = 'salon.changeTarget.v1';

/* スタイル一覧から「このスタイルで予約」を押したときの受け渡し用。
   スタイル一覧が書き、予約ページが読んで、ご要望欄に入れます。

   スタイル一覧には「気になるスタイルは、ご予約時のご要望欄に名前を
   書いていただければスムーズです」と案内しています。つまり、写して
   打ち直す作業をお客様にさせていました。押した時点で分かっている
   ことなので、こちらで運びます。

   URLに載せないのは、日時変更と同じ理由です。お名前ではないので
   実害は小さいのですが、共有されたリンクから来た人に、その人が
   選んでいないスタイルが入るのは筋が違います。 */
const STYLE_REQUEST_KEY = 'salon.styleRequest.v1';

/** スタイル一覧から呼びます。押されたスタイル名を覚えておきます */
function rememberStyleRequest(title) {
  const t = String(title == null ? '' : title).trim();
  if (!t) return;
  try { localStorage.setItem(STYLE_REQUEST_KEY, t); } catch (e) { /* 使えなくても予約自体は進みます */ }
}

/** 予約ページから呼びます。1回読んだら捨てます（次の予約に持ち越さない） */
function takeStyleRequest() {
  let t = '';
  try {
    t = localStorage.getItem(STYLE_REQUEST_KEY) || '';
    localStorage.removeItem(STYLE_REQUEST_KEY);
  } catch (e) { /* noop */ }
  return t.trim();
}

let memory = null; // localStorage が使えない環境（プライベートモード等）での代替

const Store = {
  all() {
    if (memory) return memory;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      memory = [];
      return memory;
    }
  },
  save(list) {
    if (memory) { memory = list; return; }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch (e) {
      memory = list; // 保存できない環境ではメモリ上に保持する
    }
  },
  add(reservation) {
    const list = this.all();
    list.push(reservation);
    this.save(list);
    return reservation;
  },
  find(code) {
    return this.all().find(r => r.code === code) || null;
  },
  /** 日時の変更。予約番号はそのままに、日時だけ差し替える */
  reschedule(code, next) {
    const list = this.all();
    const i = list.findIndex(r => r.code === code);
    if (i < 0) return false;
    list[i] = { ...list[i], ...next, changedAt: new Date().toISOString() };
    this.save(list);
    return true;
  },
  cancel(code) {
    const list = this.all();
    const target = list.find(r => r.code === code);
    if (!target) return false;
    target.status = 'cancelled';
    target.cancelledAt = new Date().toISOString();
    this.save(list);
    return true;
  },
  /** 有効な（キャンセルされていない）予約のみ */
  active() {
    return this.all().filter(r => r.status !== 'cancelled');
  },
  /** 予約番号を発行（例: LM-8F3K2） */
  issueCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = 'LM-' + Array.from({ length: 5 }, () =>
        chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (this.find(code));
    return code;
  }
};

/* ============================================================
 *  空席計算エンジン
 * ============================================================ */
const Availability = {
  /** 予約枠の時刻リスト（最終受付まで） */
  timeSlots() {
    const { openTime, lastOrder, slotMinutes } = SALON.business;
    const out = [];
    for (let m = toMinutes(openTime); m <= toMinutes(lastOrder); m += slotMinutes) {
      out.push(toHHMM(m));
    }
    return out;
  },

  /* 休業日の指定は2通りあります。
       '2026-08-20'                              … その日を丸ごと休みにする
       { date:'2026-08-20', start:'14:00', end:'16:00' } … その時間帯だけ止める
     外部の仕事や仕入れで「この時間だけ受けたくない」があるので、
     1日単位だけだと丸ごと閉めることになり、取れたはずの予約まで消えます。 */
  closedEntries(dateKey) {
    return (SALON.business.closedDates || [])
      .map(c => (typeof c === 'string' ? { date: c } : c))
      .filter(c => c && c.date === dateKey);
  },

  /** その日が丸ごと休みか */
  isClosed(dateKey) {
    const d = fromKey(dateKey);
    if (SALON.business.closedWeekdays.includes(d.getDay())) return true;
    // 時間の指定が無い行が1つでもあれば、その日は終日休み
    return this.closedEntries(dateKey).some(c => !c.start || !c.end);
  },

  /** その日の「この時間は受けない」帯（分に直したもの） */
  closedRanges(dateKey) {
    return this.closedEntries(dateKey)
      .filter(c => c.start && c.end)
      .map(c => ({ from: toMinutes(c.start), to: toMinutes(c.end) }))
      .filter(r => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from);
  },

  /** 開始 start（分）から length 分の施術が、休みの帯にかかるか */
  hitsClosedRange(dateKey, start, length) {
    return this.closedRanges(dateKey).some(r => start < r.to && start + length > r.from);
  },

  /** 受付可能な日付か（過去・休業日・予約可能期間外を除く） */
  isBookableDate(dateKey) {
    if (this.isClosed(dateKey)) return false;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = fromKey(dateKey);
    if (target < today) return false;
    const limit = new Date(today);
    limit.setDate(limit.getDate() + SALON.business.bookableDays);
    return target <= limit;
  },

  /** 受付締め切りを過ぎた枠か（当日の直近） */
  isTooSoon(dateKey, time) {
    const now = new Date();
    const slot = fromKey(dateKey);
    slot.setMinutes(toMinutes(time));
    return slot.getTime() - now.getTime() < SALON.business.minLeadHours * 3600 * 1000;
  },

  /** そのスタッフがその日出勤しているか */
  isWorking(staffId, dateKey) {
    const staff = findStaff(staffId);
    if (!staff) return false;
    return staff.workdays.includes(fromKey(dateKey).getDay());
  },

  /** 既存予約でそのスタッフの枠が埋まっているか（指名なし予約は特定スタッフを塞がない）
   *  この端末の予約と、受信先から取得した他のお客様の予約の両方を見ます。 */
  /* 日時変更のとき、変更しようとしている予約自身は「埋まっている」とみなさない。
     そうしないと、元の時間の前後が自分の予約で塞がれて選べなくなります。

     台帳から返ってくる他のお客様の予約には予約番号が含まれません
     （公開する情報を最小限にしているため）。そのため日時と担当の一致で判定します。
     同じ担当・同じ時間の予約は二重には取れないので、これで一意に決まります。 */
  ignoreCode: null,
  ignoreSlot: null,
  isIgnoredSlot(b) {
    const ig = this.ignoreSlot;
    return !!ig
      && b.date === ig.date
      && b.time === ig.time
      && (b.staffId || null) === (ig.staffId || null);
  },

  isBooked(staffId, dateKey, time) {
    const slotStart = toMinutes(time);
    const overlaps = (date, start, minutes) =>
      date === dateKey
      && slotStart >= toMinutes(start)
      && slotStart < toMinutes(start) + (minutes || SALON.business.slotMinutes);

    const mine = Store.active().some(r =>
      r.code !== this.ignoreCode
      && r.staffId === staffId && overlaps(r.date, r.time, r.totalMinutes));

    return mine || Remote.isBusy(staffId, dateKey, time);
  },

  /* デモ用の「先約」。予約が1件も無い画面はカレンダーが全部○になり、
     見せたときに動いているのか分からないため、それらしく埋めています。

     ★これは受信先が無いときだけです。
     台帳につながっている状態でこれを混ぜると、実際には空いている時間が
     毎日1〜3枠×になり、店は理由も分からないまま予約を取り逃がします。 */
  _blocks: new Map(),
  busyBlocks(staffId, dateKey) {
    /* 受信先を設定していれば、本番です。作り物は一切使いません。
       取得に失敗したとき（Apps Script が落ちている等）も同じです。
       分からないものを「埋まっている」ことにすると、
       実際には空いている時間をお客様に見せられなくなります。
       重なりは送信時に受信先が弾くので、そちらに任せます（UC9）。 */
    if (SALON.reservationEndpoint) return [];
    const ck = staffId + dateKey;
    if (this._blocks.has(ck)) return this._blocks.get(ck);

    const { openTime, lastOrder, slotMinutes } = SALON.business;
    const span = (toMinutes(lastOrder) - toMinutes(openTime)) / slotMinutes;
    const blocks = [];
    const count = 1 + Math.floor(seededRandom(`${dateKey}|${staffId}|n`) * 3);
    for (let i = 0; i < count; i++) {
      const start = toMinutes(openTime)
        + Math.floor(seededRandom(`${dateKey}|${staffId}|s${i}`) * span) * slotMinutes;
      const len = (2 + Math.floor(seededRandom(`${dateKey}|${staffId}|l${i}`) * 4)) * slotMinutes;
      blocks.push([start, start + len]);
    }
    this._blocks.set(ck, blocks);
    return blocks;
  },

  /** 1枠単位で、そのスタッフが空いているか */
  isStaffSlotFree(staffId, dateKey, time) {
    if (!this.isWorking(staffId, dateKey)) return false;
    if (this.isBooked(staffId, dateKey, time)) return false;
    const t = toMinutes(time);
    return !this.busyBlocks(staffId, dateKey).some(([s, e]) => t >= s && t < e);
  },

  /**
   * 指定枠の空き状況を返す
   * @returns {{ symbol:string, free:number, available:boolean, reason:string }}
   */
  slotInfo(dateKey, time, staffId = null, durationMin = SALON.business.slotMinutes) {
    if (!this.isBookableDate(dateKey)) return { symbol: '-', free: 0, available: false, reason: 'closed' };
    if (this.isTooSoon(dateKey, time)) return { symbol: '×', free: 0, available: false, reason: 'too-soon' };

    const { slotMinutes, closeTime } = SALON.business;
    const need = Math.max(1, Math.ceil(durationMin / slotMinutes));
    const start = toMinutes(time);
    if (start + durationMin > toMinutes(closeTime)) {
      return { symbol: '×', free: 0, available: false, reason: 'over-close' };
    }
    // 「この時間は受けない」帯にかかる施術は取れない
    if (this.hitsClosedRange(dateKey, start, durationMin)) {
      return { symbol: '×', free: 0, available: false, reason: 'closed-range' };
    }

    const targets = staffId ? [findStaff(staffId)].filter(Boolean) : SALON.staff;
    // 施術時間ぶん連続で空いているスタッフを数える
    const free = targets.filter(st => {
      for (let i = 0; i < need; i++) {
        if (!this.isStaffSlotFree(st.id, dateKey, toHHMM(start + i * slotMinutes))) return false;
      }
      return true;
    }).length;

    if (free === 0) return { symbol: '×', free: 0, available: false, reason: 'full' };
    // 対象が1名のときは「空きの多さ」に意味がないので ○ で表示する
    if (staffId || SALON.staff.length === 1) return { symbol: '○', free, available: true, reason: '' };
    if (free === 1) return { symbol: '△', free, available: true, reason: '' };
    if (free === 2) return { symbol: '○', free, available: true, reason: '' };
    return { symbol: '◎', free, available: true, reason: '' };
  },

  /** カレンダー表示用の日付配列を返す */
  dateRange(startOffset = 0, days = SALON.business.calendarDays) {
    const base = new Date(); base.setHours(0, 0, 0, 0);
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + startOffset + i);
      return toKey(d);
    });
  }
};

/* ============================================================
 *  受信先（Google Apps Script など）への送信
 * ============================================================ */
/* Content-Type を text/plain にしているのは意図的です。
   application/json にするとブラウザが事前確認（OPTIONS）を送りますが、
   Google Apps Script はこれに応答できず、送信が必ず失敗します。
   text/plain なら事前確認なしで届き、GAS 側は e.postData.contents で
   そのまま JSON として読めます。 */
/* 受信先（Google Apps Script）へ送る。

   返り値は必ず { ok, ... } の形にする。
   以前は fetch が例外を投げなければ true を返していたが、それだと
   Apps Script が { ok:false, error:... } を返したとき（シートの取り合いで
   待ちきれなかった等）に、届いていないのに成功として扱ってしまう。

   通信そのものに失敗した場合は1度だけ入れ直す。
   Apps Script は久しぶりの呼び出しで立ち上がりに時間がかかることがあり、
   電波の悪い場所での1回きりの失敗も拾えるため。 */
async function sendToEndpoint(payload, attempt = 0) {
  if (!SALON.reservationEndpoint) return { ok: false, noEndpoint: true };

  try {
    const res = await fetch(SALON.reservationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    // 形が違う応答（HTMLのエラーページ等）は失敗として扱う
    if (!data || typeof data.ok !== 'boolean') {
      return { ok: false, error: '受信先から予期しない応答が返りました。' };
    }
    return data;
  } catch (e) {
    if (attempt < 1) {
      await new Promise(r => setTimeout(r, 1500));
      return sendToEndpoint(payload, attempt + 1);
    }
    console.warn('受信先への送信に失敗しました。この端末には保存されています。', e);
    return { ok: false, error: '通信に失敗しました。' };
  }
}

/* ============================================================
 *  他のお客様の予約状況（ダブルブッキング防止）
 *  受信先から「埋まっている枠」だけを取得します。
 *  氏名・電話番号などは一切受け取りません。
 * ============================================================ */
const Remote = {
  booked: null,       // null = 未取得または取得失敗
  loaded: false,
  loading: null,

  /** 受信先から予約済み枠を取得する（多重呼び出しは1回にまとめる） */
  load(force = false) {
    if (!SALON.reservationEndpoint) { this.loaded = true; return Promise.resolve(false); }
    if (this.loading) return this.loading;
    if (this.loaded && !force) return Promise.resolve(this.booked !== null);

    this.loading = (async () => {
      try {
        const res = await fetch(SALON.reservationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ type: 'availability' })
        });
        const data = await res.json();
        this.booked = Array.isArray(data.booked) ? data.booked : [];
        return true;
      } catch (e) {
        // 取得できないときはこの端末の予約だけで判定する（予約自体は続行できる）
        console.warn('空席状況を取得できませんでした。', e);
        this.booked = null;
        return false;
      } finally {
        this.loaded = true;
        this.loading = null;
      }
    })();
    return this.loading;
  },

  /** 他のお客様の予約でその枠が埋まっているか

      席が1つの店では、担当が誰かに関わらず、時間が重なれば埋まっています。
      電話で受けた予約（担当なしで入ることがあります）と、サイトからの
      予約が、同じ時間に2件入らないようにするためです。 */
  isBusy(staffId, dateKey, time) {
    if (!this.booked) return false;
    const t = toMinutes(time);
    const oneSeat = SALON.staff.length <= 1;
    return this.booked.some(b =>
      !Availability.isIgnoredSlot(b)
      && b.date === dateKey
      && (oneSeat || b.staffId === staffId)
      && t >= toMinutes(b.time)
      && t < toMinutes(b.time) + (b.minutes || SALON.business.slotMinutes));
  }
};

/* ============================================================
 *  メニューの取り込み
 *  スプレッドシートの「メニュー」「おすすめメニュー」シートに行があれば、
 *  そちらを優先して使います。無ければ data.js の内容のまま動きます。
 * ============================================================ */
/* シートは人が手で書く場所なので、数字の欄に数字以外が入ることがある。
   そのまま使うと合計が NaN になり、金額も所要時間も出せなくなる。 */
/* Googleドライブに置いた写真のURLを、読める形にそろえます。

   管理ページから上げた写真は、はじめ
     https://drive.google.com/thumbnail?id=◯◯&sz=w1200
   の形で保存していました。ところがこの入口は、よそのページから直接
   読みにいくと Google に断られることがあります。断られるかどうかは
   そのときの回数や運によるので、同じ写真が「出たり出なかったり」します。
   店の人には、入れたはずの写真が勝手に消えたように見えます。

   画像用の配信元（lh3.googleusercontent.com）を通す形なら安定します。
   すでにシートに入っている古い形も、ここで読み替えます。
   店の人が入れ直す必要はありません。 */
function driveImageUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return s;
  const m = s.match(/^https:\/\/drive\.google\.com\/(?:thumbnail\?id=|uc\?(?:export=view&)?id=|file\/d\/)([A-Za-z0-9_-]+)/);
  return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w1200` : s;
}

function normalizeItem(m) {
  const price = Number(m.price);
  const minutes = Number(m.minutes);
  return {
    ...m,
    image: driveImageUrl(m.image),
    price: Number.isFinite(price) && price > 0 ? price : 0,
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : SALON.business.slotMinutes
  };
}

const Catalog = {
  loaded: false,
  loading: null,
  source: 'local',   // 'local' = data.js / 'sheet' = スプレッドシート

  /* 予約ページでは pages.js と reserve.js の両方がこれを呼びます。
     取得中の呼び出しに 'local' を返してしまうと、負けたほうは
     「シートではなかった」と判断して描き直しを飛ばします。
     すると SALON の中身はシート由来なのに、画面には data.js 由来の
     ボタンが並んだままになり、選んでも合計に入らない状態になります。
     取得中は同じ約束を返して、全員に同じ結果を渡します。 */
  load() {
    if (this.loading) return this.loading;
    if (this.loaded) return Promise.resolve(this.source);
    this.loading = this._fetch().finally(() => {
      this.loaded = true;
      this.loading = null;
    });
    return this.loading;
  },

  async _fetch() {
    if (!SALON.reservationEndpoint) return this.source;

    try {
      const res = await fetch(SALON.reservationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ type: 'menu' })
      });
      const data = await res.json();

      // 中身があるときだけ差し替える（空のシートで消えてしまわないように）
      if (Array.isArray(data.categories) && data.categories.length) {
        SALON.menuCategories = data.categories.map(c => ({
          ...c, items: (c.items || []).map(normalizeItem)
        }));
        this.source = 'sheet';
      }
      if (Array.isArray(data.coupons) && data.coupons.length) {
        SALON.coupons = data.coupons.map(normalizeItem);
        this.source = 'sheet';
      }
      if (Array.isArray(data.styles) && data.styles.length) {
        SALON.styles = data.styles.map(x => ({ ...x, image: driveImageUrl(x.image) }));
        this.source = 'sheet';
      }
      /* 口コミ。評価の数値はここから計算します。
         このサイトに実際に届いた声だけなので、掲載しても問題ありません。
         （掲載元サイトの評価を借りてくるのは、この店の実績ではないので出しません） */
      if (Array.isArray(data.reviews) && data.reviews.length) {
        SALON.reviews = data.reviews;
        SALON.reviewCount = data.reviews.length;
        SALON.rating = data.reviews.reduce((sum, r) => sum + (Number(r.score) || 0), 0) / data.reviews.length;
        this.source = 'sheet';
      }
      // 休業日はシートを正とする（空なら休みなし、という指定も尊重する）
      if (Array.isArray(data.closedDates)) {
        SALON.business.closedDates = data.closedDates;
        Availability._blocks.clear();
      }
      // 管理ページから変更された店舗情報を反映する。
      // ヘッダー・フッターはこれより先に描かれているため、描き直す。
      if (data.settings) {
        applySettings(data.settings);
        /* 設定シートには、紹介文・住所・こだわり条件・スタッフ紹介まで入っています。
           これらを描いているのは各ページ側で、描き直すかどうかは、この
           load() が返す値で決めています。メニューの行が1件も無い店（全部
           非表示にした、まだ入れていない）では 'local' のままになり、
           店主が書き換えた住所が画面に出ないままになります。
           設定が届いた時点で、シートから来たものがあるとみなします。 */
        this.source = 'sheet';
        renderHeader();
        renderFooter();
        wireImageFallbacks();
        /* 自分では取りに行かないページにも知らせます。
           プライバシーポリシーは、事業者名・代表者名・問い合わせ先を
           ここから受け取って描き直します（privacy.js）。 */
        document.dispatchEvent(new CustomEvent('salon:settings'));
      }
    } catch (e) {
      console.warn('メニューを取得できませんでした。掲載中の内容で表示します。', e);
    }
    return this.source;
  }
};

/* 設定シートが読めなかったときに戻す先。
   applySettings が書き換える前の値を、最初に控えておきます。 */
const SALON_DEFAULT_HOURS = {
  openTime: SALON.business.openTime,
  closeTime: SALON.business.closeTime,
  lastOrder: SALON.business.lastOrder
};

/* ---- 手で書かれた値を、画面に出せる形にする ----

   設定シートは店主が直接打つ場所です。全角、改行、記号、貼り付けそこねた
   長い文字列が来ます。ここを素通しにすると、1つの入力で画面が崩れます。
   制御文字を落とし、長さで頭打ちにします。

   長さで切るのは、終わりの無い1語（URLの貼り間違いなど）が来たときに、
   390pxの画面から横へ突き抜けてしまうためです。改行はそのまま残します
   （道案内や紹介文は、改行したとおりに出る場所です）。 */
function cleanSetting(v, max) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/* 1行に1件で書いてもらう欄（こだわり条件・得意分野）。
   続けて書かれることもあるので、読点と全角の「／」でも切ります
   （画面には「／」でつないで出しているので、それを写して戻されます）。
   半角の「/」では切りません。URLや「and/or」まで切れてしまうためです。

   件数と1件の長さに上限を置くのは、11件のタグを並べたスタイルで
   写真より説明のほうが背高になった、という実例があるためです。 */
function cleanSettingList(v, maxItems, maxLen) {
  return cleanSetting(v, maxItems * (maxLen + 1))
    .split(/[\n、,，／]+/)
    .map(s => cleanSetting(s, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

/** 管理ページ（設定シート）の内容をサイトに反映する。
 *
 *  ---- 空欄をどう読むか ----
 *  2通りあります。どちらなのかは、管理ページの欄ごとに書いてあります
 *  （admin.js の SETTING_SECTIONS。keep が付いているものが下の2つ目）。
 *
 *    ・空欄＝サイトから消える（紹介文・住所・支払い方法・こだわり条件など）
 *      いちど入れた案内を、管理ページから消せるようにするためです。
 *      「空欄＝据え置き」だけにすると、店主は消す手段を持ちません。
 *
 *    ・空欄＝掲載中の内容のまま（営業時間・最終受付・受付期限・電話番号・写真）
 *      空になると予約の枠が1つも作れなくなるか、お客様の連絡先が
 *      画面から消えてしまう項目です。ここは消せないほうが安全です。
 *
 *  設定シートにその行そのものが無いときは、どちらも掲載中の内容のままです
 *  （設置直後のシートや、古いシートで足りない項目があるとき）。
 */
function applySettings(st) {
  const set = (key, apply) => {
    const v = st[key];
    if (v !== undefined && String(v).trim() !== '') apply(String(v).trim());
  };
  /* 空欄にすれば消せる欄。行が無いときだけ掲載中の内容を使います。 */
  const setText = (key, max, apply) => {
    if (st[key] === undefined) return;
    apply(cleanSetting(st[key], max));
  };
  /* 空欄では消せない欄。整え方は同じで、空のときだけ掲載中の内容を残します。 */
  const setTextKeep = (key, max, apply) => {
    if (st[key] === undefined) return;
    const v = cleanSetting(st[key], max);
    if (v) apply(v);
  };
  const setList = (key, maxItems, maxLen, apply) => {
    if (st[key] === undefined) return;
    apply(cleanSettingList(st[key], maxItems, maxLen));
  };
  /* 数として読む欄。範囲の外は捨てて、掲載中の値のままにします。
     「経験200年」「99時まで」を通すと、直せるのは店主ではなくなります。 */
  const setInt = (key, min, max, apply) => {
    const raw = st[key];
    if (raw === undefined) return;
    const t = toHalfWidth(String(raw)).trim();
    if (t === '') { apply(null); return; }        // 空欄にすれば出さない
    /* 数字だけを抜き出すやり方にすると、「あした」が 0 になります
       （抜き出した結果が空文字で、Number('') は 0 のため）。
       0 は「当日まで」「0時」として通ってしまうので、丸ごと見ます。 */
    const n = /^\d+$/.test(t) ? Number(t) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
      console.warn(`設定シートの「${key}」は ${min}〜${max} の数字で入力してください（${raw}）。`);
      return;
    }
    apply(n);
  };
  set('電話番号', v => { SALON.tel = v; });

  /* 営業時間は「09:00」の形でないと枠が1つも作れず、
     予約カレンダーが黙って空になります。
     シートは手で書く場所なので「9時」「9:00〜」なども来ます。
     読めない値は無視して、data.js の値をそのまま使います。 */
  const time = v => {
    // 「２０：００」のような全角も、いったん半角にそろえてから読みます
    const m = toHalfWidth(v).trim().match(/^(\d{1,2})\s*[:：時]\s*(\d{1,2})?/);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2] || 0);
    if (h > 23 || mi > 59) return null;
    return `${pad2(h)}:${pad2(mi)}`;
  };
  const setTime = (key, apply) => {
    const raw = st[key];
    if (raw === undefined || String(raw).trim() === '') return;
    const v = time(raw);
    if (v) apply(v);
    else console.warn(`設定シートの「${key}」を読み取れませんでした（${raw}）。09:00 の形式で入力してください。`);
  };
  setTime('営業開始', v => { SALON.business.openTime = v; });
  setTime('営業終了', v => { SALON.business.closeTime = v; });
  setTime('最終受付', v => { SALON.business.lastOrder = v; });

  // 前後関係が壊れていると枠が作れないので、その場合も data.js の値に戻す
  const b = SALON.business;
  if (toMinutes(b.closeTime) <= toMinutes(b.openTime)) {
    console.warn('営業終了が営業開始より前になっています。掲載中の営業時間を使います。');
    b.openTime = SALON_DEFAULT_HOURS.openTime;
    b.closeTime = SALON_DEFAULT_HOURS.closeTime;
    b.lastOrder = SALON_DEFAULT_HOURS.lastOrder;
  }
  // 最終受付が営業終了より後だと、押せない枠が並ぶだけになる
  if (toMinutes(b.lastOrder) > toMinutes(b.closeTime)) {
    b.lastOrder = b.closeTime;
  }
  if (toMinutes(b.lastOrder) < toMinutes(b.openTime)) {
    b.lastOrder = b.closeTime;
  }
  set('キャッチコピー', v => { SALON.catch = v; });

  /* 外部サービスのURL。
     LINE公式アカウントを開設した日に、店側がスマホから貼れるようにします。
     ここをコード側だけにしておくと、いちばん貼りたい日に貼れません。
     ただし貼り先が http(s) でないと、押した人を思わぬ場所へ飛ばしてしまうので、
     形が違うものは受け取りません。 */
  const url = v => (/^https?:\/\//i.test(v) ? v : null);
  const setUrl = (key, apply) => {
    const raw = st[key];
    if (raw === undefined) return;
    const t = String(raw).trim();
    if (t === '') { apply(''); return; }        // 空欄にすれば案内を消せます
    const ok = url(t);
    if (ok) apply(ok);
    else console.warn(`設定シートの「${key}」は https:// から始まる形で入力してください（${t}）。`);
  };
  setUrl('LINE友だち追加URL', v => { SALON.lineAddUrl = v; });
  setUrl('Google口コミURL', v => { SALON.googleReviewUrl = v; });

  set('ロゴ画像', v => { SALON.logo = driveImageUrl(v); });
  set('スタッフ写真', v => { if (SALON.staff[0]) SALON.staff[0].image = driveImageUrl(v); });
  set('メイン写真', v => { SALON.heroImage = driveImageUrl(v); });
  if (st['お知らせ'] !== undefined) SALON.notice = String(st['お知らせ']).trim();

  /* 定休曜日。「日,水」「日曜・水曜」どちらの書き方でも読み取ります。
     指定が無い場合は data.js の設定をそのまま使います（空欄＝変更しない）。 */
  if (st['定休曜日'] !== undefined) {
    const raw = String(st['定休曜日']).trim();
    SALON.business.closedWeekdays = raw
      ? [...new Set(raw.split(/[,、・\s]+/).map(t => WEEKDAY_JA.indexOf(t.replace(/曜日?$/, ''))).filter(i => i >= 0))]
      : [];
  }

  /* ---- 変更・キャンセルの受付期限 ----
     受け口（gas/Code.gs の cancelDeadline_）も、同じ2行を読みます。
     ここを画面側だけの設定にすると、画面は「まだ変更できます」と出すのに
     送ると断られる、お客様にはどうしようもない状態になります。
     空欄と範囲外は掲載中の値のまま（消せる期限ではないため）。 */
  const rule = { daysBefore: 1, hour: 18, ...(SALON.business.cancelDeadline || {}) };
  setInt('変更・キャンセル期限（何日前）', 0, 30, v => { if (v !== null) rule.daysBefore = v; });
  setInt('変更・キャンセル期限（何時）', 0, 23, v => { if (v !== null) rule.hour = v; });
  SALON.business.cancelDeadline = rule;

  /* ---- 「準備中」の帯 ----
     これがサイトの公開スイッチです。以前は data.js の draft にあり、
     店主は自分の店のサイトを自分で公開できませんでした。
     読めない書き方はそのまま（勝手に公開も、勝手に非公開もしない）。 */
  if (st['準備中の帯'] !== undefined) {
    const v = toHalfWidth(String(st['準備中の帯'])).trim().toLowerCase();
    // 「表示しない」は「表示」で始まるので、出さない側から先に見ます
    if (/^(出さない|表示しない|しない|いいえ|false|off|no|×|x)/.test(v)) SALON.draft = false;
    else if (/^(出す|表示|する|はい|true|on|yes|○|o)/.test(v)) SALON.draft = true;
    else if (v) console.warn(`設定シートの「準備中の帯」は「出す」か「出さない」で入力してください（${v}）。`);
  }
  /* 文言だけを空にしても帯は消えません（消すのは上の「準備中の帯」です）。
     空で上書きすると、店が書いていない当たり障りのない一文が出てしまうので、
     掲載中の文言を残します。 */
  setTextKeep('準備中の文言', 200, v => { SALON.draftNote = v; });

  /* ---- 店の紹介・場所・設備 ----
     移転、PayPay導入、席を増やした。どれも普通に起きることです。
     ここがコード側にあると、起きた日に直せる人がいません。 */
  setText('店の紹介文', 800, v => { SALON.description = v; });
  setText('住所', 200, v => { SALON.address = v; });
  setText('地図の検索文字列', 200, v => { SALON.mapQuery = v; });
  setText('アクセス', 300, v => { SALON.access = v; });
  setText('道案内', 1000, v => { SALON.directions = v; });
  setText('駐車場', 200, v => { SALON.parking = v; });
  setText('支払い方法', 300, v => { SALON.payment = v; });
  setText('席数', 100, v => { SALON.seats = v; });
  setList('こだわり条件', 20, 40, v => { SALON.features = v; });

  /* ---- スタッフ紹介 ----
     1年経てば「経験6年」は嘘になります。 */
  const staff = SALON.staff[0];
  if (staff) {
    setText('スタッフの肩書き', 40, v => { staff.role = v; });
    setText('スタッフの紹介文', 800, v => { staff.message = v; });
    setList('スタッフの得意分野', 15, 30, v => { staff.tags = v; });
    /* 経験年数だけは空欄で消せます（staffCard は 0 なら出しません）。
       80年で頭打ちにしているのは、打ち間違いの「600」を
       「経験600年」と出さないためです。 */
    setInt('スタッフの経験年数', 0, 80, v => { staff.years = v === null ? 0 : v; });
  }

  /* ---- 事業者の情報（プライバシーポリシー） ----
     お客様の氏名・電話番号・メールをお預かりする以上、
     誰が預かっているのかを書かないわけにいきません。
     ここを店主が埋められないと、永久に空のままになります。 */
  setText('事業者名', 100, v => { SALON.operator = v; });
  setText('代表者名', 60, v => { SALON.operatorName = v; });
  setText('問い合わせ先メール', 120, v => { SALON.contactEmail = v; });
  setText('プライバシーポリシー制定日', 40, v => { SALON.privacyUpdated = v; });
}

/* 「店舗までご連絡ください」と書くときの連絡先。
   電話番号もLINEも設定していないと、お客様は連絡のしようがありません。
   行き止まりの案内を出さないよう、あるものから順に選びます。
   html を true にすると、押せるリンクにして返します。 */
function contactWay({ html = false } = {}) {
  if (SALON.tel) {
    const num = SALON.tel.replace(/-/g, '');
    return html
      ? `お電話（<a href="tel:${esc(num)}" style="text-decoration:underline">${esc(SALON.tel)}</a>）でご連絡ください。`
      : `お電話（${SALON.tel}）でご連絡ください。`;
  }
  if (SALON.lineAddUrl) {
    return html
      ? `<a href="${esc(SALON.lineAddUrl)}" target="_blank" rel="noopener" style="text-decoration:underline">当店のLINE</a>からご連絡ください。`
      : '当店のLINEからご連絡ください。';
  }
  /* どちらも無い状態で公開してはいけません。
     公開前チェックリストの必須項目です。ここは最後の逃げ道です。 */
  console.warn('電話番号もLINEのURLも設定されていません。'
    + 'お客様に「ご連絡ください」と案内しても、連絡先が分からない状態です。');
  return '当店までご連絡ください。';
}

/** 口コミを送る。予約番号と電話番号が一致した予約にだけ書けます。 */
async function sendReview(payload) {
  if (!SALON.reservationEndpoint) {
    return { ok: false, error: 'ただいまご感想の投稿をご利用いただけません。' };
  }
  try {
    const res = await fetch(SALON.reservationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ type: 'review', ...payload })
    });
    const data = await res.json();
    // 照会と同じ理由で、形が違う応答は失敗として扱います
    if (!data || typeof data.ok !== 'boolean') {
      return { ok: false, error: '受信先から予期しない応答が返りました。' };
    }
    return data;
  } catch (e) {
    console.warn('ご感想を送れませんでした', e);
    return { ok: false, error: '通信に失敗しました。時間をおいてお試しください。' };
  }
}

/** 予約番号と電話番号でご予約を照会する（ログインの代わり） */
async function lookupReservation(code, tel) {
  if (!SALON.reservationEndpoint) {
    return { ok: false, error: 'ただいまオンラインでの照会をご利用いただけません。' };
  }
  try {
    const res = await fetch(SALON.reservationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ type: 'lookup', code: code, tel: tel })
    });
    const data = await res.json();
    /* 形が違う応答（Googleのログイン画面など）は失敗として扱います。
       公開設定を間違えて入れ直すと、JSONではなくHTMLが返ってきます。
       そのまま返すと、お客様の画面には何も出ないまま「終わった」ように見えます。 */
    if (!data || typeof data.ok !== 'boolean') {
      return { ok: false, error: '受信先から予期しない応答が返りました。' };
    }
    return data;
  } catch (e) {
    console.warn('照会に失敗しました', e);
    return { ok: false, error: '通信に失敗しました。時間をおいてお試しください。' };
  }
}

/** キャンセルを受信先へ通知する（予約台帳の状態を更新するため） */
/* 電話番号も必ず添えます。
   受け口は公開されているので、これが無いと
   「予約番号を知っているだけの人」がキャンセルできてしまいます。 */
function sendCancellation(reservation) {
  return sendToEndpoint({
    type: 'cancel',
    code: reservation.code,
    tel: (reservation.customer && reservation.customer.tel)
      || reservation.lookupTel || '',
    date: reservation.date,
    time: reservation.time,
    name: reservation.customer ? reservation.customer.name : ''
  });
}

/* ============================================================
 *  ヘッダー / フッターの描画
 * ============================================================ */
const NAV_ITEMS = [
  { href: 'index.html', label: 'サロンTOP' },
  { href: 'gallery.html', label: 'スタイル' },
  { href: 'staff.html', label: 'スタッフ' },
  { href: 'menu.html', label: 'メニュー' },
  { href: 'reviews.html', label: '口コミ' },
  { href: 'reserve.html', label: '空席・予約' },
  { href: 'mypage.html', label: '予約確認' }
];

function currentPage() {
  const path = location.pathname.split('/').pop();
  return path === '' ? 'index.html' : path;
}

/* ============================================================
 *  ロゴ表示
 *  SALON.logo に画像パスが入っていればその画像を、
 *  無ければ店名から文字ロゴ（ワードマーク）を組み立てます。
 *  ZER01 は「ZERO + 1」なので、数字部分だけ色を変えて意味を見せています。
 * ============================================================ */
function wordmarkHtml() {
  return esc(SALON.name);
}

function brandLockup(opt = {}) {
  const size = opt.size || 'sm';
  const wordmark = `
    <span class="wordmark wordmark-${size}">
      <span class="wm-name">${wordmarkHtml()}</span>
      ${SALON.nameSub ? `<span class="wm-sub">${esc(SALON.nameSub)}</span>` : ''}
    </span>`;

  /* ロゴ画像は、文字ロゴの「代わり」ではなく「となり」に置きます。

     はじめは画像が読めたら文字ロゴを隠していました。ところが店のロゴは
     円形の紋章で、中に店名も入っています。大きく出すと、トップの見出しが
     ロゴ1枚に占領されて、何の店で何ができるのかが読めなくなりました。
     小さな印として名前の左に添えるほうが、店の名前も肩書きも残ります。

     opt.logo === false のときは画像を使いません。トップの大きな見出しは
     文字ロゴのままにしたいので、そこで使います。 */
  if (!SALON.logo || opt.logo === false) return wordmark;

  return `
    <span class="brand-lockup">
      <img class="brand-logo" src="${esc(SALON.logo)}" alt="" aria-hidden="true"
           style="height:${opt.height || SALON.logoHeight || 34}px" />
      ${wordmark}
    </span>`;
}

/** 画像が読み込めなかったときの取り扱いをまとめて設定する */
/* 写真が読めたか読めなかったかを見届けます。

   読めなかったからといって、すぐには消しません。
   Googleドライブに置いた写真は、続けて何枚も読みにいくと
   一時的に断られることがあります。1回の失敗で消してしまうと、
   同じページを開くたびに写真が出たり出なかったりします。
   店の人には、入れたはずの写真が勝手に消えたように見えます。

   間を置いて2回まで読み直し、それでも駄目なときだけ消します。 */
function settlePhoto(img, show, drop, tries = 2) {
  let left = tries;
  const src = img.getAttribute('src') || '';

  /* 読み直すのは、よそから借りている写真だけにします。
     この作りは Googleドライブが混んだときに断ってくることへの備えです。
     同じ置き場所（assets/…）のファイルは、あるか無いかのどちらかで、
     読み直しても結果は変わりません。まだ置いていないロゴのために、
     ページを開くたび3回取りに行くのは無駄なだけです。 */
  const remote = /^https?:\/\//.test(src);

  const retry = () => {
    if (!remote || left <= 0 || !src) { drop(); return; }
    left--;
    /* URLをそのまま入れ直すと、ブラウザが失敗した結果を返してくることが
       あります。意味のない印を足して、必ず取りに行かせます。 */
    setTimeout(() => {
      img.src = src + (src.indexOf('?') >= 0 ? '&' : '?') + 'retry=' + left;
    }, 700 * (tries - left));
  };

  img.addEventListener('load', () => { if (img.naturalWidth > 0) show(); });
  img.addEventListener('error', retry);
  // 描く前に読み終わっていた場合は、上の通知が来ません
  if (img.complete) { img.naturalWidth > 0 ? show() : retry(); }
}

function wireImageFallbacks(root = document) {
  /* ロゴ：文字ロゴを既定にして、画像が読めたときだけ差し替える。
     「まず画像を出して、失敗したら文字に戻す」向きだと、
     読み込みに失敗するまでのあいだ壊れた画像アイコンと alt 文字が出てしまう。 */
  $$('.brand-lockup img', root).forEach(img => {
    settlePhoto(img,
      () => img.closest('.brand-lockup')?.classList.add('is-image'),
      () => img.remove());
  });
  /* 写真：読めたときだけ見せる。
     ロゴと同じ理由で「まず出して失敗したら消す」向きにはしない。
     読み込みに失敗するまでのあいだ、壊れた画像が意匠の上に重なってしまう。 */
  $$('.ph-photo', root).forEach(img => {
    settlePhoto(img, () => img.classList.add('is-ready'), () => img.remove());
  });
  /* メニューの写真は任意。
     置いてあるとは限らないパスを先に書いてあるので、
     「読めたら写真の場所を空ける」向きにする。
     先に場所を空けてから消すと、読み込みのたびに列がガタつく。 */
  $$('.ph-photo-opt', root).forEach(img => {
    settlePhoto(img, () => img.parentElement?.classList.add('has-photo'), () => img.remove());
  });
}

/* 管理ページは、店の人が作業する場所です。

   お客様用のヘッダー（サロンTOP・スタイル・スタッフ…）とフッターを
   そのまま載せていたため、作業に関係のない案内が上下に700px以上ありました。
   毎朝いちばんに見たい「今日の予約」が、そのぶん下に押し出されます。
   店名だけ小さく出して、あとは作業のための場所にします。 */
function renderAdminHeader(host) {
  host.innerHTML = `
    <header class="admin-bar">
      <span class="admin-bar-name">${esc(SALON.name)}</span>
      <span class="admin-bar-label">管理ページ</span>
      <a class="admin-bar-link" href="index.html">サイトを見る</a>
    </header>`;
}

function renderHeader() {
  const host = $('#site-header');
  if (!host) return;
  const page = currentPage();
  if (page === 'admin.html') { renderAdminHeader(host); return; }
  const initials = SALON.mark
    || SALON.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
    || 'SL';
  const nav = NAV_ITEMS.map(item => {
    const cur = item.href === page ? ' aria-current="page"' : '';
    return `<li><a href="${item.href}"${cur}>${item.label}</a></li>`;
  }).join('');

  const draft = SALON.draft
    ? `<div class="draft-banner">${esc(SALON.draftNote || '準備中：内容は仮のものです')}</div>`
    : '';

  host.innerHTML = `
    ${draft}
    <header class="site-header">
      <div class="container header-top">
        <a class="brand" href="index.html" aria-label="${esc(SALON.name)} ${esc(SALON.nameSub || '')}">
          ${SALON.logo ? '' : `<span class="brand-mark" aria-hidden="true">${esc(initials)}</span>`}
          ${brandLockup({ size: 'sm' })}
        </a>
        <div class="header-actions">
          ${SALON.tel ? `
          <a class="header-tel" href="tel:${esc(SALON.tel.replace(/-/g, ''))}">
            <span>TEL / 受付 ${esc(SALON.business.openTime)}-${esc(SALON.business.closeTime)}</span>
            <strong>${esc(SALON.tel)}</strong>
          </a>` : ''}
          <a class="btn btn-primary btn-sm" href="reserve.html">ネット予約</a>
        </div>
      </div>
      <nav class="site-nav" aria-label="メインメニュー">
        <div class="container"><ul>${nav}</ul></div>
      </nav>
    </header>`;
}

function renderFooter() {
  const host = $('#site-footer');
  if (!host) return;
  /* 管理ページに、お客様向けの案内一覧（サロンTOP・口コミ・…）は要りません。
     作業の邪魔になるだけなので出しません。 */
  if (currentPage() === 'admin.html') { host.innerHTML = ''; return; }
  const year = new Date().getFullYear();
  // 固定ボタンの下にコピーライトが隠れないよう、出すページだけ余白を足す
  document.body.classList.toggle('has-sp-cta', !!stickyCta());
  host.innerHTML = `
    <footer class="site-footer">
      <div class="container">
        <div class="footer-grid">
          <div>
            <div class="footer-brand">${brandLockup({ size: 'md', height: 40 })}</div>
            <p>${esc(SALON.address)}</p>
            ${SALON.access ? `<p>${esc(SALON.access)}</p>` : ''}
            ${SALON.tel ? `<p style="margin-top:10px;">TEL ${esc(SALON.tel)}</p>` : ''}
            <p>営業時間 ${esc(SALON.business.openTime)}〜${esc(SALON.business.closeTime)}（最終受付 ${esc(SALON.business.lastOrder)}）</p>
            ${/* 曜日が決まっていない店で「定休日 なし」と出すと、いつ行っても開いていると
                  読まれます。掲載の注記があれば、その先頭の語（「不定休」）を出します。
                  全文は店舗情報の表にあります。 */ ''}
            <p>定休日 ${SALON.business.closedWeekdays.map(d => WEEKDAY_JA[d] + '曜日').join('・')
              || esc(String(SALON.business.closedNote || '').split(/[\s　]/)[0]) || 'なし'}</p>
          </div>
          <div>
            <h4>MENU</h4>
            <ul>
              <li><a href="index.html">サロンTOP</a></li>
              <li><a href="gallery.html">ヘアスタイル</a></li>
              <li><a href="staff.html">スタッフ一覧</a></li>
              <li><a href="menu.html">メニュー</a></li>
              <li><a href="reviews.html">口コミ</a></li>
            </ul>
          </div>
          <div>
            <h4>RESERVATION</h4>
            <ul>
              <li><a href="reserve.html">空席状況・ネット予約</a></li>
              <li><a href="mypage.html">ご予約の確認・キャンセル</a></li>
              ${SALON.lineAddUrl
                ? `<li><a href="${esc(SALON.lineAddUrl)}" target="_blank" rel="noopener">LINEで友だち追加</a></li>`
                : ''}
              <li><a href="index.html#faq">よくあるご質問</a></li>
              <li><a href="privacy.html">プライバシーポリシー</a></li>
              <li><a href="admin.html">スタッフ用 予約管理</a></li>
            </ul>
          </div>
        </div>
        <p class="copyright">&copy; ${year} ${esc(SALON.name)}. All rights reserved.</p>
      </div>
    </footer>
    ${stickyCta()}`;
}

/* 画面下に貼りつく予約ボタン。
   予約ページと予約確認ページでは出しません。予約の途中に「予約する」が
   ずっと居座ると、いま押すべきボタン（次へ・この内容で予約する）と紛らわしく、
   画面も狭くなるためです。 */
function stickyCta() {
  const page = currentPage();
  // 予約の途中と、店側が使うページには出しません
  if (page === 'reserve.html' || page === 'mypage.html' || page === 'admin.html') return '';
  return `
    <div class="sp-cta">
      ${SALON.tel ? `<a class="btn btn-ghost" href="tel:${esc(SALON.tel.replace(/-/g, ''))}">電話</a>` : ''}
      <a class="btn btn-primary" href="reserve.html">24時間ネット予約</a>
    </div>`;
}

/* ============================================================
 *  構造化データ（Google検索・マップ向け）
 *  店舗情報を data.js から組み立てて埋め込みます。
 * ============================================================ */
function injectStructuredData() {
  if (currentPage() !== 'index.html') return;

  const b = SALON.business;
  const prices = SALON.coupons.map(c => c.price)
    .concat(allMenuItems().map(m => m.price))
    .filter(Boolean);

  const data = {
    '@context': 'https://schema.org',
    '@type': 'HairSalon',
    name: SALON.fullName || `${SALON.name} ${SALON.nameSub || ''}`.trim(),
    alternateName: SALON.nameJa,
    description: SALON.description,
    address: {
      '@type': 'PostalAddress',
      addressCountry: 'JP',
      addressRegion: '茨城県',
      addressLocality: '龍ケ崎市',
      streetAddress: SALON.address.replace(/^茨城県龍ケ崎市/, '')
    },
    openingHours: `Mo-Su ${b.openTime}-${b.closeTime}`,
    url: location.origin + location.pathname.replace(/index\.html$/, ''),
    image: location.origin + location.pathname.replace(/index\.html$/, '') + 'assets/ogp.png'
  };

  if (SALON.tel) data.telephone = SALON.tel;
  if (prices.length) {
    data.priceRange = `¥${Math.min(...prices).toLocaleString()}〜¥${Math.max(...prices).toLocaleString()}`;
  }
  if (SALON.rating && SALON.reviewCount) {
    data.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: SALON.rating,
      reviewCount: SALON.reviewCount,
      bestRating: 5
    };
  }

  const tag = document.createElement('script');
  tag.type = 'application/ld+json';
  tag.textContent = JSON.stringify(data);
  document.head.appendChild(tag);
}

/* ページタイトルを設定ファイルから補完 */
function applyDocumentTitle() {
  const base = `${SALON.name} ${SALON.nameSub || SALON.branch}`.trim();
  document.title = document.title ? `${document.title}｜${base}` : base;
}

document.addEventListener('DOMContentLoaded', () => {
  renderHeader();
  renderFooter();
  wireImageFallbacks();
  applyDocumentTitle();
  injectStructuredData();
});
