# サロン予約サイト（簡易版）

スマホから見て、そのまま予約できる1ページのサロンサイトです。
ビルド不要・依存パッケージなし。HTML / CSS / 素の JavaScript の3ファイルだけで動きます。

## 公開URL

https://andenknt31113.github.io/salon-booking-site/

### 初回だけ必要な設定

GitHub Pages の有効化は、リポジトリ所有者が画面から1回だけ行う必要があります
（外部ツールからは権限の都合で有効化できません）。

1. リポジトリの **Settings** → 左メニューの **Pages** を開く
2. **Source** を `Deploy from a branch` にする
3. Branch を **`main`** / **`/(root)`** にして **Save**

1分ほどで上記URLが開くようになります。以降は `main` に push するだけで自動的に反映されます。

## ファイル

| ファイル | 内容 |
| --- | --- |
| `index.html` | ページ本体 |
| `assets/style.css` | 見た目（スマホ基準） |
| `assets/app.js` | **サロン設定 ＋ 予約の処理** |

## 中身

1ページに以下がまとまっています。

- サロン紹介
- メニュー・料金
- スタッフ
- **ネット予約**（メニュー → 担当 → 日付 → 時間 → お名前・電話 → 予約番号発行）
- ご予約の確認・キャンセル
- 店舗情報・地図リンク

画面下に「電話する」「ネット予約」を固定表示しているので、スマホからすぐ予約に進めます。

## 自社用にする

編集するのは **`assets/app.js` の先頭にある `SALON`** だけです。

```js
const SALON = {
  name: 'Salon LUMIÈRE',    // サロン名
  branch: '表参道店',
  tel: '03-1234-5678',
  address: '東京都渋谷区神宮前0-0-0',

  open: '10:00',            // 営業開始
  close: '20:00',           // 営業終了
  lastOrder: '19:00',       // 最終受付
  slot: 30,                 // 予約枠の刻み（分）
  closedWeekdays: [2],      // 定休日 0=日 1=月 2=火 …
  closedDates: [],          // 臨時休業日 '2026-08-20'
  showDays: 14,             // 日付の選択肢を何日分出すか
  leadHours: 2,             // 当日予約の締め切り（施術の何時間前まで）

  menus: [ /* メニュー */ ],
  staff: [ /* スタッフ */ ]
};
```

メニューやスタッフを増やすと、予約フォームの選択肢にも自動で反映されます。
スタッフの `days`（出勤曜日）と `fee`（指名料）は、空き時間の判定と料金計算にそのまま使われます。

配色を変えたいときは `assets/style.css` の先頭にある `--accent` を書き換えてください。

## 予約データの扱い（重要）

GitHub Pages はサーバー処理を持たない静的ホスティングです。そのため2つのモードがあります。

### デモモード（初期状態）

予約はその端末のブラウザ（localStorage）に保存されるだけで、**店舗側には届きません。**
動作確認・社内でのレビュー用です。

### 実運用モード

`assets/app.js` の `endpoint` に受信先 URL を設定すると、
予約確定時にその URL へ予約内容が JSON で POST されます。

```js
endpoint: 'https://script.google.com/macros/s/xxxxx/exec',
```

Google Apps Script を使う場合の最小例です。スプレッドシートに1行追加し、店舗宛にメールを送ります。

```js
function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  SpreadsheetApp.getActiveSheet().appendRow([
    d.code, d.date, d.time, d.menuName, d.staffName, d.name, d.tel, d.price, d.memo
  ]);
  MailApp.sendEmail('salon@example.com', '【新規予約】' + d.code,
    d.date + ' ' + d.time + ' / ' + d.name + '様 / ' + d.menuName);
  return ContentService.createTextOutput('ok');
}
```

「デプロイ → 新しいデプロイ → ウェブアプリ」で、アクセスできるユーザーを「全員」にして公開し、
発行された URL を `endpoint` に貼ってください。

## 空き時間について

初期状態の空き時間はサンプルです。次のルールで組み立てています。

- 定休日・臨時休業日・過去の時間・受付締切（`leadHours`）を除外
- スタッフの出勤曜日（`days`）を反映
- 1日に1〜3件の先約が入っている想定でブロックを生成
- 選んだメニューの所要時間ぶん、連続して空いている時間だけを選択可に
- この端末から入れた予約は、その担当の枠を実際に埋める

実際の予約管理システムとつなぐときは、`assets/app.js` の `staffFree()` を
自社の空き状況を返す処理に置き換えてください。ここ1箇所で全体に反映されます。

## ローカルで見る

```bash
python3 -m http.server 8000
# → http://localhost:8000
```
