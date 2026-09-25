import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function demoCatalog() {
  const source = readFileSync(new URL('../assets/js/data.js', import.meta.url), 'utf8');
  const salon = vm.runInNewContext(source + '; SALON');
  const price = item => item.price ? String(item.price) + (item.priceFrom ? '〜' : '') : '';
  return {
    menus: salon.menuCategories.flatMap(category => category.items.map(item => ({
      区分: category.name, メニュー名: item.name, 価格: price(item), '所要(分)': item.minutes,
      説明: item.note || '', 画像: item.image || '', 表示: '○'
    }))),
    coupons: salon.coupons.map(item => ({
      メニュー名: item.title, 価格: price(item), 通常価格: item.listPrice || '', '所要(分)': item.minutes,
      説明: item.detail || '', 条件: item.terms || '', 対象: item.badge || '', 画像: item.image || '', 表示: '○'
    })),
    styles: salon.styles.map(item => ({
      タイトル: item.title, 分類: item.length || '', タグ: (item.tags || []).join(','), 画像: item.image || '', 表示: '○'
    }))
  };
}

export function demoReservations(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return [
    { days: -20, name: 'デモのお客様A', tel: '00000000001', time: '10:00', note: '架空の施術メモ：次回は長さを相談' },
    { days: -1, name: 'デモのお客様B', tel: '00000000002', time: '10:00' },
    { days: 0, name: 'デモのお客様A', tel: '00000000001', time: '09:00' },
    { days: 0, name: 'デモのお客様C', tel: '00000000003', time: '14:00' },
    { days: 1, name: 'デモのお客様B', tel: '00000000002', time: '11:00' }
  ].map((item, index) => {
    const date = new Date(today + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() + item.days);
    return {
      code: 'LM-DEMO' + (index + 1), date: date.toISOString().slice(0, 10), time: item.time,
      endTime: String(Number(item.time.slice(0, 2)) + 1).padStart(2, '0') + ':00',
      totalMinutes: 60, totalPrice: 4000, menus: [{ name: 'デモ施術（練習用）' }], staffName: 'MATTEO',
      customer: { name: item.name, tel: item.tel, email: `demo${index + 1}@example.invalid`, visit: '2回目以降' },
      note: item.note || '', source: '電話・来店', cancelled: false
    };
  });
}

export function demoHtml(html) {
  const banner = '<aside id="demo-banner" role="note" style="padding:12px 16px;background:#fff1bd;color:#302815;border-bottom:2px solid #9c7624">'
    + '<strong>デモ・練習用／パスワード不要</strong><p style="margin:4px 0">予約・お客様は架空データです。登録・保存はこのデモ内だけ。本番への反映、メール・LINEの送信はありません。実際の個人情報は入力しないでください。</p>'
    + '<small>変更は一時保存で、サーバー終了時に消えます。掲載サイトの更新・本番運用の検証ではありません。</small> '
    + '<button type="button" id="demo-reset">デモを最初に戻す</button><p id="demo-error" role="alert" hidden></p></aside>';
  return html.replace('<body', '<body data-demo="true"')
    .replace(/(<body[^>]*>)/, '$1' + banner)
    .replace('<title>', '<title>【デモ】')
    .replace('見た目だけを切り替えます。ログイン後の登録・保存は、どちらも同じ台帳に反映されます。',
      '見た目だけを切り替えます。ここでの登録・保存は、どちらもデモ専用の架空台帳に反映されます。')
    .replace('</body>', '<script src="/demo-ui.js"></script></body>');
}
