# GoodField

`docs/GAME_RULE_SPEC.md`、`docs/BATTLE_SYSTEM_SPEC.md`、`docs/GAME_UI_FLOW_SPEC.md`
を規範にした、決定論的なWeb対戦ゲーム実装です。現在はサーバー正本の
ルールエンジン基盤と共有型、
プレイヤー別ビュー、リアルタイム同期、ローカル対戦画面、合言葉制オンラインの
セッション・ルームライフサイクルを実装しています。

## 必要環境

- Node.js 24
- npm 11

## 開発コマンド

```sh
npm install
npm run dev
npm run build
npm start
npm run smoke:start
npm run test:smoke
npm run generate:cards
npm run generate:golden
npm run check
npm run test:load
npm run test:online
npm run release:check
npm run online:check
```

`npm run dev` はクライアントTypeScriptの監視コンパイルとローカルサーバーを起動します。
`npm run build` はソースマップ付き配布物を `dist` に生成し、`npm start` はその
生成物を既定の `http://127.0.0.1:3000` で提供します。ポートは
`GOODFIELD_PORT`、待受ホストは `GOODFIELD_HOST` で変更できます。
`npm run smoke:start` は空きポートでビルド済みサーバーの起動と静的配信を確認します。
`npm run test:smoke` はビルド後のサーバーで、開始画面、試合作成、WebSocket同期、
コマンド、結果、再読込復元までを実通信経路で確認します。`npm run check`にも
このスモークが含まれます。停止は起動したターミナルで `Ctrl+C` を押します。

ブラウザを開くと、表示名とCPU人数からローカル修行を開始できます。ローカルActor資格は
同じブラウザのローカルストレージへだけ保存され、再読込時に同じ本人ビューを復元します。
結果画面の「戦いを終わる」から資格を消去して新しい試合を開始できます。

隠れ乱闘は、日本語対応の合言葉によるルーム作成・参加、準備、Human/CPU席、開始、
本人別対戦画面、再接続まで実装済みです。合言葉はNFKC正規化後にHMAC化して保持します。
本番では`PostgresGoodFieldStore`をSQLクライアントへ接続し、
ルーム、ハッシュ済みセッション、試合Revision、再接続カーソルを永続化します。

`npm run generate:cards` はルール仕様の教典テーブルから、実行用カード定義と
差し替え可能な日本語表示テキストを別々に生成します。
`npm run generate:golden` は固定シードの3試合を完走し、コマンド列、乱数ログ、
イベント列、最終状態のレビュー用Fixtureを更新します。
`npm run test:load` は9人戦、終末悪魔連鎖、反射連鎖、配信障害を計測します。
`npm run test:online` はオンラインセッションから100ルーム・900セッション負荷までを
検査します。`npm run online:check` は全検査にオンライン公開用ファイルの静的ゲートを
加えます。ステージングと本番の手動承認は`docs/ONLINE_RELEASE_CHECKLIST.md`に記録します。
`npm run release:check` は通常の全検査に加え、タスク完了状態、固定バージョン、
リリースノート、マイグレーションとロールバック手順を検査します。

## オンライン設定

ローカルでは追加設定なしで起動できます。本番相当では次を外部の秘密管理から注入します。

```sh
GOODFIELD_PUBLIC_ORIGIN=https://play.example.com
GOODFIELD_COOKIE_SECURE=true
GOODFIELD_SESSION_SECRET=<32byte以上の秘密値>
GOODFIELD_ROOM_SECRET=<32byte以上の秘密値>
GOODFIELD_DURABLE_STORE_MODULE=<永続ストアfactoryモジュール>
```

`NODE_ENV=production` ではHTTPSの公開Origin、両秘密値、永続ストアfactoryがない
起動を拒否します。
詳細な運用境界、保持期限、脅威モデルは
`docs/ONLINE_MVP_ARCHITECTURE.md`、配備・復旧は`docs/ONLINE_OPERATIONS.md`を参照してください。

## 構成

```text
packages/shared  共有型、カード定義、決定論的乱数
packages/server  ルールエンジン、イベントReducer、秘匿投影、リアルタイム同期
packages/client  UI状態機械、レスポンシブ対戦画面
scripts          カード生成と静的検査
tests            ルール・秘匿・決定性テスト
docs             規範仕様と実装タスク
```

サーバーの永続化は試合ごとの追記型JSONLジャーナルを使い、運用監査ログとは
分離します。運用監査には拒否コマンド、同期失敗、異常連鎖の匿名化参照だけを残し、
表示名、手札、カードID、シードは出力しません。

実装済み範囲と次の作業は `docs/IMPLEMENTATION_STATUS.md` を参照してください。
