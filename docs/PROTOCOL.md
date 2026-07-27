# GoodField 通信プロトコル

更新日: 2026-07-26

本書は `GAME_RULE_SPEC.md` と `GAME_UI_FLOW_SPEC.md` の通信要件を、現行実装で
使用するコマンド、イベント、再接続メッセージへ具体化する。

## 1. 基本原則

- コマンドはHTTP、イベントと再接続同期はWebSocket互換のJSONメッセージで扱う。
- 認証済みプレイヤーIDまたは観戦権限は接続処理で確定し、クライアントの
  `SYNC_MATCH`ペイロードから受け取らない。
- `revision`はコマンドの楽観的排他制御、`eventSeq`はイベント配信と再接続の
  カーソルに使用する。
- `eventSeq`は公開、プレイヤー限定、サーバー限定の全イベントを通じた単調増加値
  とする。クライアントに非公開のイベントがある場合、受信イベント列に欠番が
  あってよい。
- クライアントは各メッセージの`eventSeq`を最後に同期済みの値として保存する。
  受信した公開イベントの末尾値からカーソルを推測しない。

## 2. コマンド

コマンドは `POST /matches/{matchId}/commands` へ送る。共通項目は次のとおり。

```ts
type CommandBase = {
  matchId: string;
  commandId: string;
  actorId: string;
  expectedRevision: number;
};
```

- `actorId`は認証済みプレイヤーと一致しなければならない。
- 同じプレイヤーの同じ`commandId`と同じ内容の再送には、最初と同じ応答を返す。
- 同じ`commandId`で内容が異なる場合は`DUPLICATE_COMMAND_CONFLICT`とする。
- `expectedRevision`が最新状態と異なる場合は適用せず、最新スナップショットを返す。
- 成功応答は最新の`eventSeq`と、呼び出したプレイヤー向けスナップショットを含む。

## 3. 再接続要求

```ts
type MatchSyncRequest = {
  type: "SYNC_MATCH";
  matchId: string;
  lastEventSeq: number | null;
};
```

初回接続では`lastEventSeq = null`、再接続では最後に同期済みのグローバル
`eventSeq`を送る。負数、非整数、未知の追加フィールドは拒否する。

## 4. 差分同期

保持履歴が`lastEventSeq`から現在値まで連続している場合は、次を返す。

```ts
type RealtimeEventBatch = {
  type: "EVENT_BATCH";
  matchId: string;
  afterEventSeq: number;
  eventSeq: number;
  events: DomainEvent[];
  snapshot: GameViewState;
};
```

- `events`は接続者に公開可能なイベントだけを`eventSeq`昇順で含む。
- 非公開イベントだけで状態が進んだ場合、`events`が空でも`eventSeq`と
  `snapshot`は最新値へ進む。
- `snapshot`を直ちに正本状態として採用し、`events`は演出キューへ順番に追加する。
- 同じまたは古い`eventSeq`のイベントを再受信しても、状態へ二重適用しない。

## 5. 完全同期

初回接続、履歴不足、またはクライアントのカーソルがサーバーより進んでいる場合は、
次を返す。

```ts
type RealtimeFullSnapshot = {
  type: "FULL_SNAPSHOT";
  matchId: string;
  eventSeq: number;
  reason:
    | "INITIAL_SYNC"
    | "EVENT_HISTORY_UNAVAILABLE"
    | "CLIENT_AHEAD";
  recentEvents: DomainEvent[];
  snapshot: GameViewState;
};
```

完全同期では古い演出を全件再生しない。サーバーは保持履歴から行動、防御、取引、
原子的なリソース変化、授与、復活、昇天、切断、試合終了に関する直近の重要イベント
だけを最大12件返す。現行のインメモリ履歴上限は1試合512イベントとする。

## 6. 公開範囲

| `visibility.scope` | 配信先 |
|---|---|
| `PUBLIC` | 全参加プレイヤーと認可済み観戦者 |
| `PLAYER` | 指定された本人だけ |
| `SERVER` | 配信しない |

プレイヤー限定の授与、取引提示、強制除去内容は他プレイヤーと観戦者へ送らない。
夢状態のカードは本人向けイベントとスナップショットでも固定済みの偽カードとして
投影し、真カードIDと偽装フラグを送らない。シード、PRNG状態、乱数監査ログ、
処理済みコマンド、内部保留キューはリアルタイムペイロードへ含めない。

## 7. 状態復元

- 操作中は最新`phase`、合法手、対象、防御要求、取引確認、入力期限を復元する。
- CPU代行中はプレイヤーの`controller = "CPU"`を正本とし、人間入力を復元しない。
- 観戦者は`self = null`のスナップショットを受け取る。
- 試合終了後は`phase = "MATCH_ENDED"`と`result`を復元する。
- 接続が切れたクライアントの送信失敗は他の接続への配信を妨げない。
