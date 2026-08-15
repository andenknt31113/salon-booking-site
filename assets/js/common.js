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

/** HTMLエスケープ */
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
/** 星表示 */
function stars(score) {
  const full = Math.round(score);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
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

  /** 休業日か */
  isClosed(dateKey) {
    const d = fromKey(dateKey);
    return SALON.business.closedWeekdays.includes(d.getDay())
      || SALON.business.closedDates.includes(dateKey);
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

  /* サンプルの「先約」を作る。実運用では予約管理システムの空き状況に差し替えてください。
     1日に1〜3件の施術が入っている想定でブロックを生成します。
     30分ごとに独立して判定すると、長いメニューで連続枠がまず取れなくなるため、
     まとまった時間の先約として作ります。 */
  _blocks: new Map(),
  busyBlocks(staffId, dateKey) {
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

  /** 他のお客様の予約でその枠が埋まっているか */
  isBusy(staffId, dateKey, time) {
    if (!this.booked) return false;
    const t = toMinutes(time);
    return this.booked.some(b =>
      !Availability.isIgnoredSlot(b)
      && b.date === dateKey
      && b.staffId === staffId
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
function normalizeItem(m) {
  const price = Number(m.price);
  const minutes = Number(m.minutes);
  return {
    ...m,
    price: Number.isFinite(price) && price > 0 ? price : 0,
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : SALON.business.slotMinutes
  };
}

const Catalog = {
  loaded: false,
  source: 'local',   // 'local' = data.js / 'sheet' = スプレッドシート

  async load() {
    if (this.loaded) return this.source;
    this.loaded = true;
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
        SALON.styles = data.styles;
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
        renderHeader();
        renderFooter();
        wireImageFallbacks();
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

/** 管理ページ（設定シート）の内容をサイトに反映する。
 *  空欄の項目は data.js の値をそのまま使います。 */
function applySettings(st) {
  const set = (key, apply) => {
    const v = st[key];
    if (v !== undefined && String(v).trim() !== '') apply(String(v).trim());
  };
  set('電話番号', v => { SALON.tel = v; });

  /* 営業時間は「09:00」の形でないと枠が1つも作れず、
     予約カレンダーが黙って空になります。
     シートは手で書く場所なので「9時」「9:00〜」なども来ます。
     読めない値は無視して、data.js の値をそのまま使います。 */
  const time = v => {
    const m = String(v).trim().match(/^(\d{1,2})\s*[:：時]\s*(\d{1,2})?/);
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

  set('ロゴ画像', v => { SALON.logo = v; });
  set('スタッフ写真', v => { if (SALON.staff[0]) SALON.staff[0].image = v; });
  set('メイン写真', v => { SALON.heroImage = v; });
  if (st['お知らせ'] !== undefined) SALON.notice = String(st['お知らせ']).trim();

  /* 定休曜日。「日,水」「日曜・水曜」どちらの書き方でも読み取ります。
     指定が無い場合は data.js の設定をそのまま使います（空欄＝変更しない）。 */
  if (st['定休曜日'] !== undefined) {
    const raw = String(st['定休曜日']).trim();
    SALON.business.closedWeekdays = raw
      ? [...new Set(raw.split(/[,、・\s]+/).map(t => WEEKDAY_JA.indexOf(t.replace(/曜日?$/, ''))).filter(i => i >= 0))]
      : [];
  }
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
    return await res.json();
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
    return await res.json();
  } catch (e) {
    console.warn('照会に失敗しました', e);
    return { ok: false, error: '通信に失敗しました。時間をおいてお試しください。' };
  }
}

/** キャンセルを受信先へ通知する（予約台帳の状態を更新するため） */
function sendCancellation(reservation) {
  return sendToEndpoint({
    type: 'cancel',
    code: reservation.code,
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

  if (!SALON.logo) return wordmark;

  /* ロゴ画像と文字ロゴの両方を出しておき、画像が読めなければ文字ロゴに戻す。
     こうしておくと、画像ファイルを置くだけで自動的に切り替わります。 */
  return `
    <span class="brand-lockup">
      <img class="brand-logo" src="${esc(SALON.logo)}" alt="${esc(SALON.name)}"
           style="height:${opt.height || SALON.logoHeight || 34}px" />
      ${wordmark}
    </span>`;
}

/** 画像が読み込めなかったときの取り扱いをまとめて設定する */
function wireImageFallbacks(root = document) {
  /* ロゴ：文字ロゴを既定にして、画像が読めたときだけ差し替える。
     「まず画像を出して、失敗したら文字に戻す」向きだと、
     読み込みに失敗するまでのあいだ壊れた画像アイコンと alt 文字が出てしまう。 */
  $$('.brand-lockup img', root).forEach(img => {
    const useImage = () => img.closest('.brand-lockup')?.classList.add('is-image');
    const drop = () => img.remove();
    if (img.complete) {
      img.naturalWidth > 0 ? useImage() : drop();
      return;
    }
    img.addEventListener('load', useImage, { once: true });
    img.addEventListener('error', drop, { once: true });
  });
  /* 写真：読めたときだけ見せる。
     ロゴと同じ理由で「まず出して失敗したら消す」向きにはしない。
     読み込みに失敗するまでのあいだ、壊れた画像が意匠の上に重なってしまう。 */
  $$('.ph-photo', root).forEach(img => {
    const show = () => img.classList.add('is-ready');
    const drop = () => img.remove();
    if (img.complete) {
      img.naturalWidth > 0 ? show() : drop();
      return;
    }
    img.addEventListener('load', show, { once: true });
    img.addEventListener('error', drop, { once: true });
  });
  /* メニューの写真は任意。
     置いてあるとは限らないパスを先に書いてあるので、
     「読めたら写真の場所を空ける」向きにする。
     先に場所を空けてから消すと、読み込みのたびに列がガタつく。 */
  $$('.ph-photo-opt', root).forEach(img => {
    const show = () => img.parentElement?.classList.add('has-photo');
    const drop = () => img.remove();
    if (img.complete) {
      img.naturalWidth > 0 ? show() : drop();
      return;
    }
    img.addEventListener('load', show, { once: true });
    img.addEventListener('error', drop, { once: true });
  });
}

function renderHeader() {
  const host = $('#site-header');
  if (!host) return;
  const page = currentPage();
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
            <p>定休日 ${SALON.business.closedWeekdays.map(d => WEEKDAY_JA[d] + '曜日').join('・') || 'なし'}</p>
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
