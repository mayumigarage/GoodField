# 公開環境の配備

`deploy/Dockerfile` は Node.js 24 で配布物を再生成し、非rootユーザーで単一の
GoodFieldプロセスを起動する。`nginx.conf` はTLS終端、HTTPからHTTPSへの転送、
WebSocket Upgrade、16KiBの本文上限を設定する。

本番では次をSecret管理基盤から注入し、イメージやデプロイログへ値を含めない。

- `GOODFIELD_PUBLIC_ORIGIN=https://<public-host>`
- `GOODFIELD_SESSION_SECRET`（32byte以上）
- `GOODFIELD_ROOM_SECRET`（32byte以上）
- `GOODFIELD_DURABLE_STORE_MODULE`（`createGoodFieldDurableStore()`をexportするモジュール）
- PostgreSQL接続情報（`PostgresGoodFieldStore`へ渡すSQLクライアントだけが参照する）

アプリケーションとDBのスキーマは同じリリース番号で固定する。起動前に
`POSTGRES_DURABLE_STORE_MIGRATIONS`を適用し、`/health/ready` が200になってから
トラフィックへ追加する。終了時は新規参加をドレインし、進行中接続の猶予期間後に
SIGTERMを送り、最終チェックポイントが完了してから停止する。

公開ホスト名と証明書パスは環境に合わせて置換する。ステージングと本番でSecret、
DB、Cookie、招待コードを共有しない。
