/* ============================================================
 *  プレビュー専用の、にせの受信先
 *
 *  本番は Google Apps Script とスプレッドシートが相手です。
 *  ここでは同じやりとりを、この端末のブラウザの中だけで再現します。
 *  そうしないと「予約してみたのに管理ページに出てこない」
 *  「ロゴを選んだのにサイトに出ない」という、見本としては
 *  いちばん困る状態になるためです。
 *
 *  ・保存先は localStorage だけ。どこにも送信していません。
 *  ・メニューの初期値は data.js（実際の掲載内容）から作ります。
 *  ・管理ページのパスワードは zer01 です。
 *
 *  このファイルは本番サイトには入りません（tools/build-single.mjs が
 *  プレビューを作るときにだけ差し込みます）。
 * ============================================================ */
(function () {
  const KEY = 'zer01.preview.v2';
  const PW = 'zer01';
  const TOKEN = 'preview-token';

  /* ---------- 初期データを data.js から作る ---------- */
  const priceCell = m => (m.price ? String(m.price) + (m.priceFrom ? '〜' : '') : '');

  function seed() {
    const menus = [];
    (SALON.menuCategories || []).forEach(cat => {
      (cat.items || []).forEach(m => menus.push({
        区分: cat.name, メニュー名: m.name, 価格: priceCell(m),
        '所要(分)': m.minutes, 説明: m.note || '', 画像: m.image || '', 表示: '○'
      }));
    });
    const coupons = (SALON.coupons || []).map(c => ({
      クーポン名: c.title, 価格: priceCell(c), 通常価格: c.listPrice || '',
      '所要(分)': c.minutes, 説明: c.detail || '', 条件: c.terms || '',
      対象: c.badge || '全員', 画像: c.image || '', 表示: '○'
    }));
    const styles = (SALON.styles || []).map(s => ({
      タイトル: s.title, 分類: s.length || '', タグ: (s.tags || []).join(','),
      画像: s.image || '', 表示: '○'
    }));
    return {
      予約: [], menus: menus, coupons: coupons, styles: styles, reviews: [], closed: [],
      settings: {
        電話番号: '', 営業開始: '', 営業終了: '', 最終受付: '',
        キャッチコピー: '', お知らせ: '', 定休曜日: '',
        LINE友だち追加URL: '', Google口コミURL: '',
        ロゴ画像: '', スタッフ写真: '', メイン写真: ''
      }
    };
  }

  let db;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { db = null; }
  if (!db || !db.settings) db = seed();

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* 容量超過は無視 */ }
  }
  save();

  /* 見本の中身をまっさらに戻す。画面から呼べるようにしておきます */
  window.プレビューを初期化 = function () {
    try { localStorage.removeItem(KEY); } catch (e) { /* noop */ }
    location.reload();
  };

  /* ---------- シートの行を、サイトが読む形に直す（GASと同じ変換） ---------- */
  function parsePrice(v) {
    const t = String(v == null ? '' : v).trim();
    const n = Number(t.replace(/[^0-9.]/g, ''));
    return { value: isNaN(n) ? 0 : n, from: /[〜~]/.test(t) };
  }
  const shown = r => String(r.表示 || '').trim() !== '×';

  function buildMenu() {
    const groups = [];
    db.menus.filter(shown).forEach((r, i) => {
      let g = groups.find(x => x.name === r.区分);
      if (!g) { g = { id: 'cat' + groups.length, name: r.区分, items: [] }; groups.push(g); }
      const p = parsePrice(r.価格);
      g.items.push({
        id: 'sm' + i, name: r.メニュー名, price: p.value, priceFrom: p.from,
        minutes: r['所要(分)'], note: r.説明, image: String(r.画像 || '')
      });
    });
    return groups.length ? groups : null;
  }

  function buildCoupons() {
    const out = db.coupons.filter(shown).map((r, i) => {
      const p = parsePrice(r.価格);
      return {
        id: 'sc' + i, badge: r.対象, title: r.クーポン名, detail: r.説明,
        price: p.value, priceFrom: p.from, listPrice: Number(r.通常価格) || null,
        minutes: r['所要(分)'], terms: r.条件, image: String(r.画像 || '')
      };
    });
    return out.length ? out : null;
  }

  function buildStyles() {
    const out = db.styles.filter(shown).map((r, i) => ({
      id: 'ss' + i, title: r.タイトル, length: r.分類, staffId: null,
      tags: String(r.タグ || '').split(/[,、・\s]+/).filter(Boolean),
      image: String(r.画像 || ''), hue: (i * 37) % 360
    }));
    return out.length ? out : null;
  }

  function buildReviews() {
    const out = db.reviews
      .filter(r => String(r.状態 || '').trim() === '掲載中')
      .map((r, i) => ({
        id: 'rv' + i, score: Number(r.評価) || 5, nickname: r.ニックネーム || 'お客様',
        age: r.年代 || '', gender: r.性別 || '', date: r.投稿日,
        title: r.タイトル || '', body: r.本文, staffId: null,
        staffName: r.担当 || '', menu: r.メニュー || ''
      }));
    return out.length ? out : null;
  }

  /* ---------- 予約台帳 ---------- */
  const digits = v => String(v == null ? '' : v).replace(/\D/g, '');
  const live = () => db.予約.filter(r => r.status !== 'キャンセル');

  function ledgerRow(d) {
    const c = d.customer || {};
    return {
      code: d.code, date: d.date, time: d.time, endTime: d.endTime,
      menu: (d.menus || []).map(m => m.name).join(' / ') || d.menuText || '',
      staffName: d.staffName || '', staffId: d.staffId || '',
      price: d.totalPrice || 0, totalLabel: d.totalLabel || '',
      totalMinutes: d.totalMinutes || 0,
      name: c.name || '', tel: c.tel || '', email: c.email || '',
      visit: c.visit || '', request: c.request || '', status: '予約確定'
    };
  }

  const stamp = t => String(JSON.stringify(db[t] || null).length);
  const allStamps = () => {
    const o = {};
    ['menus', 'coupons', 'styles', 'reviews', 'closed', 'settings']
      .forEach(t => { o[t] = stamp(t); });
    return o;
  };

  /* ---------- 受け付け ---------- */
  function handle(d) {
    /* --- お客様側 --- */
    if (d.type === 'menu') {
      return {
        ok: true, categories: buildMenu(), coupons: buildCoupons(),
        styles: buildStyles(), reviews: buildReviews(),
        closedDates: db.closed.filter(r => r['休業日']).map(r => (
          r['開始'] && r['終了']
            ? { date: r['休業日'], start: r['開始'], end: r['終了'] }
            : r['休業日'])),
        settings: db.settings
      };
    }
    if (d.type === 'availability') {
      return {
        ok: true,
        booked: live().map(r => ({
          date: r.date, time: r.time, endTime: r.endTime, staffId: r.staffId || ''
        }))
      };
    }
    if (d.type === 'reserve') {
      // 同じ予約番号が二度届いても増やさない（本番と同じ扱い）
      if (db.予約.some(r => r.code === d.code)) return { ok: true, code: d.code };
      const taken = live().some(r => r.date === d.date && r.time === d.time);
      if (taken) {
        return { ok: false, error: 'この時間はちょうど埋まってしまいました。別の時間をお選びください。' };
      }
      db.予約.push(ledgerRow(d));
      save();
      return { ok: true, code: d.code };
    }
    if (d.type === 'lookup') {
      const r = db.予約.find(x => x.code === d.code && digits(x.tel) === digits(d.tel));
      if (!r) return { ok: false, error: 'ご予約が見つかりませんでした。予約番号と電話番号をご確認ください。' };
      return { ok: true, reservation: r };
    }
    if (d.type === 'cancel') {
      const r = db.予約.find(x => x.code === d.code);
      if (!r) return { ok: false, error: 'ご予約が見つかりませんでした。' };
      if (r.status === 'キャンセル') return { ok: true, already: true };
      r.status = 'キャンセル';
      save();
      return { ok: true };
    }
    if (d.type === 'change') {
      const r = db.予約.find(x => x.code === d.code && digits(x.tel) === digits(d.tel));
      if (!r) return { ok: false, error: 'ご予約が見つかりませんでした。' };
      r.date = d.date; r.time = d.time; r.endTime = d.endTime;
      save();
      return { ok: true };
    }
    if (d.type === 'review') {
      const r = db.予約.find(x => x.code === d.code && digits(x.tel) === digits(d.tel));
      if (!r) return { ok: false, error: 'ご予約が確認できませんでした。' };
      db.reviews.push({
        投稿日: new Date().toISOString().slice(0, 10), 予約番号: d.code,
        ニックネーム: d.nickname || 'お客様', 年代: d.age || '', 性別: d.gender || '',
        評価: d.score || 5, タイトル: d.title || '', 本文: d.body || '',
        担当: r.staffName || '', メニュー: r.menu || '', 状態: '未承認'
      });
      save();
      return { ok: true };
    }

    /* --- 店側 --- */
    if (d.type && d.type.indexOf('admin') === 0) {
      if (d.password !== PW && d.token !== TOKEN) {
        return { ok: false, error: 'パスワードが違います。' };
      }
      if (d.type === 'adminLogin') return { ok: true, token: d.remember ? TOKEN : '' };
      if (d.type === 'adminData') {
        return {
          ok: true, stamps: allStamps(),
          reservations: db.予約.slice().sort((a, b) =>
            (b.date + b.time).localeCompare(a.date + a.time)),
          menus: db.menus, coupons: db.coupons, styles: db.styles,
          reviews: db.reviews, closedDates: db.closed, settings: db.settings
        };
      }
      if (d.type === 'adminAdd') {
        const toMin = t => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : 0; };
        const mins = Number(d.minutes) || 60;
        if (!d.date || !d.time) return { ok: false, error: '来店日と開始時刻をご確認ください。' };
        if (!String(d.name || '').trim()) return { ok: false, error: 'お名前をご入力ください。' };
        const start = toMin(d.time), end = start + mins;
        if (!d.force) {
          const taken = live().some(x => x.date === d.date
            && start < toMin(x.endTime) && toMin(x.time) < end);
          if (taken) {
            return { ok: false, confirm: true,
              error: 'この時間には、すでに別のご予約が入っています。それでも登録しますか？' };
          }
        }
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code;
        do {
          code = 'LM-' + Array.from({ length: 5 },
            () => chars[Math.floor(Math.random() * chars.length)]).join('');
        } while (db.予約.some(r => r.code === code));
        const endTime = ('0' + Math.floor(end / 60) % 24).slice(-2) + ':' + ('0' + end % 60).slice(-2);
        db.予約.push({
          code: code, date: d.date, time: d.time, endTime: endTime, totalMinutes: mins,
          menu: d.menu || '（電話予約）', staffName: 'MATTEO', staffId: 'st01',
          price: Number(d.price) || 0, name: d.name, tel: d.tel || '', email: '',
          visit: '電話・来店', request: d.memo || '', status: '予約確定'
        });
        save();
        return { ok: true, code: code, endTime: endTime };
      }
      if (d.type === 'adminUpload') {
        // 本番は Google ドライブに保存してURLを返します。
        // 見本では、選んだ画像そのもの（データURL）を返して表示に使います。
        return { ok: true, url: String(d.dataBase64 || '') };
      }
      if (d.type === 'adminSave') {
        if (d.stamp && d.stamp !== stamp(d.target)) {
          return { ok: false, stale: true,
            error: 'この内容は、別の端末から変更されています。いったん読み込み直してください。' };
        }
        if (d.target === 'settings') db.settings = d.rows || {};
        else db[d.target] = d.rows || [];
        save();
        return { ok: true, stamps: allStamps() };
      }
    }
    return { ok: false, error: '見本では扱っていない操作です。' };
  }

  SALON.reservationEndpoint = 'preview://zer01';

  const realFetch = window.fetch.bind(window);
  window.fetch = function (url, opt) {
    if (String(url).indexOf('preview://') !== 0) return realFetch(url, opt);
    let d = {};
    try { d = JSON.parse((opt && opt.body) || '{}'); } catch (e) { /* noop */ }
    let out;
    try { out = handle(d); } catch (e) { out = { ok: false, error: String(e.message || e) }; }
    // 本番は通信が挟まるので、少しだけ間を置いて本番の見え方に近づけます
    return new Promise(resolve => setTimeout(
      () => resolve({ json: () => Promise.resolve(out) }), 120));
  };
})();
