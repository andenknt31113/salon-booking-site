/* ============================================================
 *  予約確認・キャンセル（お客様向け）
 * ============================================================ */

let filterCode = '';
/* 直前に照会したご予約。別端末から日時変更するときに使います */
let lastLookup = null;

/* この端末の記録は status:'cancelled'、照会結果は status:'キャンセル' と、
   出どころで言葉が違います。片方だけを見ていると、キャンセル済みの
   ご予約に「キャンセルする」を出してしまうので、1か所で吸収します。 */
function isCancelled(r) {
  return r.status === 'cancelled' || r.status === 'キャンセル';
}

/** 予約の終わりの時刻（分）。endTime が無い古い記録は開始時刻で代用する */
function endMinutes(r) {
  const end = toMinutes(r.endTime || '');
  return Number.isFinite(end) ? end : toMinutes(r.time);
}

/* 予約が過去のものか。
   施術中はまだ「過去」ではありません。開始時刻で切ると、10時のご予約が
   10時5分には「ご来店済み」に変わり、席に座っている方に
   「ご感想を書く」を出すことになります。終わりの時刻で判定します。 */
function isPast(r) {
  const dt = fromKey(r.date);
  dt.setMinutes(endMinutes(r));
  return dt.getTime() < Date.now();
}

/* 変更・キャンセルの受付期限。設定は data.js の business.cancelDeadline。
   ここを通っても、Apps Script 側でもう一度確認します
   （期限の直前にページを開いたまま、しばらくして押された場合のため）。 */
function deadlineOf(dateKey) {
  const rule = SALON.business.cancelDeadline || { daysBefore: 1, hour: 18 };
  const d = fromKey(dateKey);
  d.setDate(d.getDate() - rule.daysBefore);
  d.setHours(rule.hour, 0, 0, 0);
  return d;
}
function deadlineLabel() {
  const rule = SALON.business.cancelDeadline || { daysBefore: 1, hour: 18 };
  return rule.daysBefore === 1
    ? `前日${rule.hour}時`
    : `${rule.daysBefore}日前の${rule.hour}時`;
}

/* 店舗の台帳が「もう期限切れです」と答えたご予約。
   端末の時計は数分ずれていることがあり、こちらの計算では期限内に見えます。
   一度断られたのに同じボタンが残っていると、お客様は何度でも押します。
   台帳の答えのほうが正しいので、覚えておいて押せなくします。 */
const refusedByDeadline = new Set();

/** 変更・キャンセルができるか */
function isCancellable(r) {
  if (isCancelled(r) || isPast(r)) return false;
  if (refusedByDeadline.has(normalizeCode(r.code))) return false;
  return Date.now() < deadlineOf(r.date).getTime();
}

/* 押せなくなった理由を、そのとおりに伝えます。
   どの場合も「期限を過ぎました」と出すのは事実と違いますし、
   すでにキャンセル済みの方に電話をかけさせることになります。 */
function stopReasonText(r) {
  if (isCancelled(r)) {
    return 'このご予約は、すでにキャンセルを承っております。';
  }
  if (isPast(r)) {
    return 'このご予約は、ご来店の日時を過ぎています。';
  }
  return `恐れ入ります。ネットでの変更・キャンセルの受付は${deadlineLabel()}までとなっております。\n`
    + `お手数ですが${contactWay()}`;
}

/* 金額が決まっていないご予約の書き方。
   カウンセリングでお見積りするメニューや、店が電話で受けて価格欄を
   空けたままの予約があります。そこで「¥0」と出すと無料だと読めてしまうので、
   サイトの他の場所と同じ「お見積り」に揃えます。 */
/* 名前は totalDisplay。reserve.js にも同じ役目の totalText がありますが、
   あちらは選択中のメニューから計算するもので、引数の取り方が違います。
   同じ名前にすると、あとで1つのページに両方を読み込んだときに
   静かに片方が消えます。 */
function totalDisplay(r) {
  if (r.totalLabel) return esc(r.totalLabel);
  return r.totalPrice ? esc(yen(r.totalPrice)) : 'お見積り';
}
function totalLine(r) {
  return `<p class="booking-detail">合計：<strong>${totalDisplay(r)}</strong>`
    + `（${r.totalPrice ? '税込・' : ''}約${formatDuration(r.totalMinutes)}）</p>`;
}

/* 日時変更の受け渡し（CHANGE_KEY は common.js で定義） */
function startChange(reservation) {
  /* 期限を過ぎたご予約を変更画面へ送ってはいけません。
     日時を選び直し、お名前と電話番号まで確かめた最後の最後で断られます。
     開いたまま期限をまたいだ画面から押されることがあるので、ここで止めます。 */
  if (!isCancellable(reservation)) {
    alert(stopReasonText(reservation));
    refreshView(true);
    return;
  }
  try {
    sessionStorage.setItem(CHANGE_KEY, JSON.stringify(reservation));
  } catch (e) {
    alert('この設定では日時変更をご利用いただけません。お手数ですが店舗までご連絡ください。');
    return;
  }
  location.href = 'reserve.html?change=1';
}

function changeBtn(code) {
  return `<button class="btn btn-outline btn-sm" type="button" data-change="${esc(code)}">日時を変更する</button>`;
}

/* 送信中であることを見せる。
   スマホの電波が細いと応答まで数秒かかります。押しても何も変わらないと
   「効いていない」と読んで何度も押され、そのあいだに画面を閉じられます。 */
function busy(btn, on, label) {
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = '送信中…';
  } else {
    btn.textContent = btn.dataset.label || label;
  }
}

function bookingCard(r) {
  const cancelled = isCancelled(r);
  const past = isPast(r);
  const chip = cancelled
    ? '<span class="status-chip is-cancelled">キャンセル済み</span>'
    : past
      ? '<span class="status-chip is-past">ご来店済み</span>'
      : '<span class="status-chip">予約確定</span>';

  // ご来店後は、ご感想をお願いする
  const reviewLink = (past && !cancelled)
    ? `<button class="btn btn-outline btn-sm" type="button" data-review="${esc(r.code)}">ご感想を書く</button>`
    : '';

  const actions = isCancellable(r)
    ? changeBtn(r.code)
      + `<button class="btn btn-ghost btn-sm" type="button" data-cancel="${esc(r.code)}">この予約をキャンセルする</button>`
    : (!cancelled && !past)
      ? `<p style="font-size:12px;color:var(--ink-3);">※ネットでの変更・キャンセルは${deadlineLabel()}までです。お手数ですが${contactWay({ html: true })}</p>`
      : reviewLink;

  return `
    <article class="booking-card ${cancelled ? 'is-cancelled' : ''}">
      <div class="booking-head">
        ${chip}
        <span class="booking-code">予約番号 ${esc(r.code)}</span>
      </div>
      <p class="booking-when">${formatDateJa(r.date)} ${esc(r.time)}〜${esc(r.endTime || '')}</p>
      <p class="booking-detail">ご担当：${esc(r.staffName)}${r.nominationFee > 0 ? `（指名料 ${yen(r.nominationFee)}）` : ''}</p>
      <p class="booking-detail">メニュー：${r.menus.map(m => esc(m.name)).join(' ／ ')}</p>
      ${totalLine(r)}
      ${r.customer.request ? `<p class="booking-detail">ご要望：${esc(r.customer.request)}</p>` : ''}
      <div class="booking-actions">${actions}</div>
    </article>`;
}

/* この端末に記録が無い方の行き止まりを作らない。
   機種変更や、ご家族の端末から予約された方がここに来ます。
   「ありません」だけで終わらせると、確かめる手立てが無くなります。 */
function noRecordHint() {
  return SALON.reservationEndpoint
    ? '別の端末でご予約された場合は、このページの下にある'
      + '<a href="#lookup-box" style="text-decoration:underline">ご予約番号での照会</a>からご確認いただけます。'
    : `お手数ですが${contactWay({ html: true })}`;
}

function render() {
  let list = Store.all();
  /* 絞り込みは、記録が1件しかない方には要りません。
     出しておくと「番号を入れないと見られないのか」と読ませてしまいます。
     絞り込み中は、解除できるように必ず出したままにします。 */
  const box = $('#search-box');
  if (box) box.hidden = !filterCode && list.length < 2;
  if (filterCode) {
    list = list.filter(r => normalizeCode(r.code).includes(normalizeCode(filterCode)));
  }

  const upcoming = list.filter(r => !isPast(r) && !isCancelled(r))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const past = list.filter(r => isPast(r) || isCancelled(r))
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));

  $('#upcoming-list').innerHTML = upcoming.length
    ? upcoming.map(bookingCard).join('')
    : `<div class="empty-state">
         ${filterCode
           ? 'ご指定の予約番号は、この端末の記録の中には見つかりませんでした。'
           : 'この端末に、これからのご予約の記録はありません。'}
         <br />${noRecordHint()}
       </div>`;

  /* 絞り込み中に「過去のご予約はありません」とだけ出すと、
     打った番号のご予約そのものが無いように読めます。 */
  $('#past-list').innerHTML = past.length
    ? past.map(bookingCard).join('')
    : `<div class="empty-state">${filterCode
        ? 'ご指定の予約番号は、この端末の記録の中には見つかりませんでした。'
        : '過去のご予約はありません。'}</div>`;
}

/* 手続きを受け付けたことを伝える場所。
   キャンセルすると、カードは「これからのご予約」から
   「過去・キャンセルのご予約」へ移ります。押した場所から消えるだけだと
   「効かなかった」とも「消えてしまった」とも読めるので、言葉で伝えます。 */
function showFlash(msg) {
  const el = $('#flash');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
/* 次の手続きを始めるときは消します。
   1件目のキャンセルが通ったあと2件目が送れなかったのに、
   「承りました」が画面に残っていると、2件とも済んだと読めてしまいます。 */
function clearFlash() {
  const el = $('#flash');
  if (el) el.style.display = 'none';
}

/* ============================================================
 *  予約番号 + 電話番号での照会
 * ============================================================ */
function renderLookupResult(r) {
  const cancelled = isCancelled(r);
  const past = isPast(r);
  const canCancel = isCancellable(r);

  const chip = cancelled
    ? '<span class="status-chip is-cancelled">キャンセル済み</span>'
    : past
      ? '<span class="status-chip is-past">ご来店済み</span>'
      : '<span class="status-chip">予約確定</span>';

  $('#lookup-result').innerHTML = `
    <article class="booking-card ${cancelled ? 'is-cancelled' : ''}">
      <div class="booking-head">
        ${chip}
        <span class="booking-code">予約番号 ${esc(r.code)}</span>
      </div>
      <p class="booking-when">${formatDateJa(r.date)} ${esc(r.time)}〜${esc(r.endTime || '')}</p>
      <p class="booking-detail">${esc(r.name)} 様</p>
      <p class="booking-detail">メニュー：${esc(r.menuText)}</p>
      <p class="booking-detail">ご担当：${esc(r.staffName)}</p>
      ${totalLine(r)}
      ${canCancel
        ? `<div class="booking-actions">
             ${changeBtn(r.code)}
             <button class="btn btn-ghost btn-sm" type="button" data-lookup-cancel="${esc(r.code)}">この予約をキャンセルする</button>
           </div>`
        : (!cancelled && !past)
          ? `<p style="font-size:12px;color:var(--muted);margin-top:12px;">※ネットでの変更・キャンセルは${deadlineLabel()}までです。${contactWay({ html: true })}</p>`
          : ''}
    </article>`;
}

/* いま画面に出ている「押せる／押せない」を1本の文字列にしたもの。
   毎分まるごと描き直すと、読んでいる途中で画面が跳ねます。
   中身が変わったときだけ描き直すための目印です。 */
function viewSignature() {
  const of = r => `${r.code}/${isCancelled(r) ? 1 : 0}${isPast(r) ? 1 : 0}${isCancellable(r) ? 1 : 0}`;
  return filterCode + '|' + Store.all().map(of).join(',')
    + '|' + (lastLookup ? of(lastLookup) : '');
}
let shownSignature = '';

/* 画面を開いたまま時間が過ぎたときに、描き直します。

   スマホは、ほかの用事のあいだ画面をそのまま残します。夕方5時に開いた
   この画面を夜に見ると、受付期限（前日18時）を過ぎたご予約に
   「キャンセルする」「日時を変更する」が並んだままです。
   押せば店舗側で断られますが、それは押してみるまで分かりません。

   予約ページ（reserve.js）と同じ考え方です。あちらは空き状況を取り直すため
   5分ごとですが、こちらは手元の時計を見るだけなので毎分見直します。 */
function refreshView(force) {
  const sig = viewSignature();
  if (!force && sig === shownSignature) return;
  shownSignature = sig;
  render();
  if (lastLookup) renderLookupResult(lastLookup);
}

async function doLookup() {
  const btn = $('#lookup-btn');
  /* 日本語入力のまま打つと「LM-」が「ＬＭー」になります。
     番号は合っているので、直してから照会します。 */
  const code = normalizeCode($('#lookup-code').value);
  const tel = normalizeTel($('#lookup-tel').value);
  $('#lookup-tel').value = tel;
  const err = $('#lookup-error');

  err.style.display = 'none';
  $('#lookup-result').innerHTML = '';

  if (!code || !tel) {
    err.textContent = 'ご予約番号とお電話番号の両方をご入力ください。';
    err.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = '照会中…';
  const res = await lookupReservation(code, tel);
  btn.disabled = false;
  btn.textContent = 'ご予約を確認する';

  if (!res.ok) {
    /* 「見つかりませんでした」だけで終わらせると、そこで手が止まります。
       番号の控えのありかと、連絡先まで書いておきます。
       お電話で予約された方は、そもそもここでは引けません。 */
    lastLookup = null;
    err.innerHTML = esc(res.error || 'ご予約が見つかりませんでした。')
      + '<br />ご予約番号は、ご予約完了画面と自動返信メールに記載しております。'
      + '<br />お分かりにならない場合は、' + contactWay({ html: true });
    err.style.display = 'block';
    return;
  }
  /* 照会に使った電話番号を控えます。
     このあとキャンセルや日時変更で本人確認に使いますが、入力欄から
     読み直すと、お客様が欄を消したり打ち直したりしたときに
     「ご予約が確認できませんでした」になり、理由が分かりません。 */
  lastLookup = { ...res.reservation, lookupTel: tel };
  refreshView(true);
}

document.addEventListener('DOMContentLoaded', () => {
  refreshView(true);

  /* 受付期限の案内。期限も連絡先も設定で変わるので、まるごとここで組み立てます。
     電話番号が空のときに「までお電話ください」だけが残る、という出方をさせません。 */
  const renderDeadlineNote = () => {
    const note = $('#deadline-note');
    if (!note) return;
    note.innerHTML = `ネットでの変更・キャンセルは<b>${deadlineLabel()}まで</b>です。`
      + `それ以降は、お手数ですが${contactWay({ html: true })}`;
  };
  renderDeadlineNote();

  /* 連絡先は、店が管理ページ（設定シート）から変えられます。
     ここで読み直さないと、番号を変えた翌日から、このページだけが
     古い番号で「お電話ください」と案内し続けます。
     期限を過ぎたお客様が最後に頼る場所なので、ここが古いと行き止まりです。 */
  Catalog.load().then(() => {
    renderDeadlineNote();
    refreshView(true);
  });

  $('#search-btn').addEventListener('click', () => {
    filterCode = $('#search-code').value.trim();
    refreshView(true);
  });
  $('#search-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#search-btn').click();
  });
  $('#clear-btn').addEventListener('click', () => {
    filterCode = '';
    $('#search-code').value = '';
    refreshView(true);
  });

  // 照会フォーム
  $('#lookup-btn').addEventListener('click', doLookup);
  /* 予約番号の欄でも Enter で照会します。
     番号を打ったあと、そのまま確定キー（改行）を押す方がいます。
     電話番号の欄だけに付けておくと、その方は何も起きない画面を見ます。 */
  $('#lookup-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLookup();
  });
  $('#lookup-tel').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLookup();
  });
  /* 受信先が未設定のあいだは照会が使えません。
     ここで止めたままにすると、この端末に記録が無い方の行き止まりになるので、
     連絡先を必ず添えます。 */
  if (!SALON.reservationEndpoint) {
    $('#lookup-box').innerHTML =
      '<p class="empty-state" style="padding:20px;">'
      + 'ご予約番号での照会は、オンライン受付の準備が整い次第ご利用いただけます。<br />'
      + 'お急ぎの場合は、' + contactWay({ html: true })
      + '</p>';
  }

  // 照会結果からのキャンセル（電話番号の一致を店舗側でも確認します）
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-lookup-cancel]');
    if (!btn) return;
    const code = btn.dataset.lookupCancel;
    if (!lastLookup || lastLookup.code !== code) {
      alert('ご予約が見つかりませんでした。お手数ですが、もう一度照会してください。');
      return;
    }
    /* 期限をまたいで開いたままの画面から押されることがあります。
       「この操作は取り消せません」と念を押したうえで断るのは、
       お客様にとっていちばん分かりにくい断り方です。先に見ます。 */
    if (!isCancellable(lastLookup)) {
      alert(stopReasonText(lastLookup));
      refreshView(true);
      return;
    }
    const r = lastLookup;
    /* 何をキャンセルするのかを書きます。
       ご予約が複数ある方が、番号だけを見て取り違えないためです。 */
    const ok = confirm(
      `以下のご予約をキャンセルします。よろしいですか？\n\n`
      + `${formatDateJa(r.date)} ${r.time}〜\n${r.menuText || ''}\n\n`
      + `※この操作は取り消せません。`
    );
    if (!ok) return;

    clearFlash();
    busy(btn, true);
    const res = await sendToEndpoint({ type: 'cancel', code, tel: r.lookupTel });
    busy(btn, false, 'この予約をキャンセルする');

    if (res.deadline) {
      alert(res.error);
      // 台帳が期限切れと答えました。画面の側も期限切れの見た目に直します
      refusedByDeadline.add(normalizeCode(code));
      refreshView(true);
      return;
    }
    if (!res.ok && !res.noEndpoint) {
      alert('キャンセルを店舗に送信できませんでした。'
        + (res.error ? `\n（${res.error}）` : '')
        + '\n\nお手数ですが、もう一度お試しいただくか、店舗までご連絡ください。');
      return;
    }
    /* 台帳への反映は済んでいます。ここで照会をやり直すと、直後に電波が
       切れただけで結果が消え、キャンセルできたのか分からなくなります。
       手元の表示だけ書き換えます。 */
    lastLookup = { ...lastLookup, status: 'キャンセル' };
    Store.cancel(code); // この端末にも記録があれば同期する
    refreshView(true);
    showFlash('キャンセルを承りました。');
  });

  /* 日時の変更。
     予約の中身（メニュー・担当・お客様情報）はそのままに、
     日時だけ選び直してもらいます。予約番号も変わりません。 */
  // ご感想を書く（予約番号だけ渡す。電話番号は口コミページで入力してもらう）
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-review]');
    if (!btn) return;
    try { sessionStorage.setItem('salon.reviewCode', btn.dataset.review); } catch (err) { /* noop */ }
    location.href = 'reviews.html#write';
  });

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-change]');
    if (!btn) return;
    const code = btn.dataset.change;

    // この端末で取った予約
    const mine = Store.find(code);
    if (mine) { startChange(mine); return; }

    // 予約番号＋電話番号で照会した予約
    if (lastLookup && lastLookup.code === code) {
      startChange({
        code: lastLookup.code,
        date: lastLookup.date,
        time: lastLookup.time,
        endTime: lastLookup.endTime,
        totalMinutes: lastLookup.totalMinutes,
        staffName: lastLookup.staffName,
        menuText: lastLookup.menuText,
        totalPrice: lastLookup.totalPrice,
        totalLabel: lastLookup.totalLabel,
        status: lastLookup.status,
        // 照会では個人情報を返していないので、変更時に電話番号で本人確認する
        lookupTel: lastLookup.lookupTel
      });
      return;
    }
    alert('ご予約が見つかりませんでした。お手数ですが、もう一度照会してください。');
  });

  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-cancel]');
    if (!btn) return;
    const code = btn.dataset.cancel;
    const r = Store.find(code);
    if (!r) return;
    /* 開いたまま期限をまたいだ画面から押されることがあります。
       念を押したうえで断るより先に、押せなくなっていることを伝えます。 */
    if (!isCancellable(r)) {
      alert(stopReasonText(r));
      refreshView(true);
      return;
    }
    const ok = confirm(
      `以下のご予約をキャンセルします。よろしいですか？\n\n` +
      `${formatDateJa(r.date)} ${r.time}〜\n${r.menus.map(m => m.name).join(' / ')}\n\n` +
      `※この操作は取り消せません。`
    );
    if (!ok) return;

    clearFlash();
    busy(btn, true);
    const res = await sendCancellation(r); // 予約台帳の状態も「キャンセル」に更新する
    busy(btn, false, 'この予約をキャンセルする');

    if (res.deadline) {
      alert(res.error);
      refusedByDeadline.add(normalizeCode(code));
      refreshView(true);
      return;
    }
    if (!res.ok && !res.noEndpoint) {
      alert('キャンセルを店舗に送信できませんでした。'
        + (res.error ? `\n（${res.error}）` : '')
        + '\n\nお手数ですが、もう一度お試しいただくか、店舗までご連絡ください。');
      return;
    }
    Store.cancel(code);
    refreshView(true);
    showFlash('キャンセルを承りました。');
  });

  /* 開きっぱなしの画面を、戻ってきたときと、毎分、見直します。
     期限が過ぎたら押せなくなり、ご来店が済んだら「過去」へ移ります。 */
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshView(); });
  window.addEventListener('focus', () => refreshView());
  setInterval(() => refreshView(), 60 * 1000);
});
