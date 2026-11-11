# 公開サイトの外形監視

公開サイトが開けなくなったことに、店主やお客様より先に気づくための確認です。読取だけを行い、予約・取消・管理保存・メール送信はしません。

## 確認する内容

- `sitemap.xml`の全ページと、予約確認（`mypage.html`）・管理の入口（`admin-google.html`）がHTTP 200で、HTMLが最後まで届くこと。
- それらのページが読み込む同じサイトのJS・CSSがHTTP 200で、空でないこと。
- 内部ファイル（`HANDOFF.md`、`gas/Code.gs`など`PRIVATE_PATHS`の一覧）が配信されていないこと。
- 指定した場合だけ、予約の受け口が読取に応答すること（下記）。

確認対象のURLは`sitemap.xml`から取ります。独自ドメインへ移るときは`sitemap.xml`を直せば、監視先も一緒に変わります。

## 手元で実行する

Node.js 22で、リポジトリのルートから実行します。外部ライブラリ・認証情報は不要です。

```sh
node tools/monitor-site.mjs
node --test test/monitor-site.mjs
```

1行目は公開中のサイトへ読取を送ります。2行目は架空の応答だけを使い、通信しません。失敗がある場合は終了コード1で、`failures`に対象と理由を出します。接続先のURLと応答本文は出力しません。

## 定期実行

`.github/workflows/monitor-site.yml`が毎時2回実行します。失敗するとworkflowが失敗になり、GitHubの通知設定（Settings → Notifications → Actions）に従ってリポジトリの所有者へメールが届きます。通知を受け取る設定になっているかは、最初の一回で確認してください。

- 止める：Actionsタブ →「Monitor public site」→ Disable workflow。
- 手で一回動かす：同じ画面の Run workflow。
- GitHubは、60日間リポジトリに更新がないと定期実行を自動で止めます。止まった場合は同じ画面から再度有効にします。
- 開始時刻はGitHubの混雑で遅れる・飛ぶことがあります。分単位の監視ではありません。

## 予約の受け口も確認する場合

既定では受け口へ何も送りません。リポジトリ変数`MONITOR_BACKEND_READ`を`true`にした場合だけ、予約画面が最初に送るのと同じメニュー読取を一回送り、`ok: true`の応答を確認します。

この読取も通常のGAS入口を使うため、共通ロックと、途中停止した日時変更の既存リカバリー処理を通ります（`tools/measure-booking-backend.md`と同じ注意）。1日あたり約48回の実行が増えます。本番への定期的な読取になるので、有効にするかは運用担当者が決めてください。手元で一回だけ試す場合：

```sh
MONITOR_BACKEND_READ=true node tools/monitor-site.mjs
```

## この確認で分からないこと

- 予約の確定・変更・取消、メールの配送、管理画面のログインが実際に通ること。
- 受け口の確認を有効にしていない場合の、GAS・予約台帳の障害。
- 表示の崩れや文言の誤り。画面の検査は`tools/verify-ui.md`を使います。
