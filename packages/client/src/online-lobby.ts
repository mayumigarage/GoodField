import type { GameCommand } from "../../shared/src/model.ts";
import type {
  GameCommandApiResponse,
  GameViewState
} from "../../shared/src/protocol.ts";

export type OnlineRoomSeat = {
  seatIndex: number;
  controller: "HUMAN" | "CPU" | null;
  participantId: string | null;
  displayName: string | null;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  teamId: "TEAM_1" | "TEAM_2" | "TEAM_3" | "TEAM_4" | null;
};

export type OnlineRoom = {
  roomId: string;
  accessMode: "PASSPHRASE" | "INVITATION";
  status: "OPEN" | "STARTING" | "STARTED" | "EXPIRED";
  seatCount: number;
  allowSpectators: boolean;
  endTimeThreshold: 1 | 50 | 75 | 100 | 150 | null;
  createdAt: string;
  expiresAt: string;
  matchId: string | null;
  seats: OnlineRoomSeat[];
  canStart: boolean;
};

export type OnlineAdmission = {
  room: OnlineRoom;
  participantId: string | null;
  rejoinToken?: string | null;
  csrfToken: string;
  inviteUrl?: string;
  snapshot?: GameViewState | null;
};

type ApiErrorBody = {
  ok?: false;
  code?: string;
  message?: string;
};

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type OnlineRoomTransport = {
  create(input: {
    displayName: string;
    passphrase?: string;
    seatCount: number;
    cpuCount: number;
    allowSpectators: boolean;
    requestId: string;
  }): Promise<OnlineAdmission>;
  join(input: {
    displayName: string;
    passphrase: string;
    requestId: string;
  }): Promise<OnlineAdmission>;
  joinInvitation(
    roomId: string,
    input: {
      displayName: string;
      inviteCode: string;
      requestId: string;
    }
  ): Promise<OnlineAdmission>;
  rejoin(
    roomId: string,
    input: {
      participantId: string;
      rejoinToken: string;
      requestId: string;
    }
  ): Promise<OnlineAdmission>;
  view(roomId: string): Promise<OnlineRoom>;
  ready(
    roomId: string,
    csrfToken: string,
    ready: boolean
  ): Promise<OnlineRoom>;
  setSeat(
    roomId: string,
    csrfToken: string,
    seatIndex: number,
    controller: "CPU" | null
  ): Promise<OnlineRoom>;
  setTeam(
    roomId: string,
    csrfToken: string,
    teamId: OnlineRoomSeat["teamId"]
  ): Promise<OnlineRoom>;
  shuffleTeams(
    roomId: string,
    csrfToken: string
  ): Promise<OnlineRoom>;
  setEndTime(
    roomId: string,
    csrfToken: string,
    endTimeThreshold: 1 | 50 | 75 | 100 | 150
  ): Promise<OnlineRoom>;
  start(
    roomId: string,
    csrfToken: string,
    requestId: string
  ): Promise<{
    room: OnlineRoom;
    matchId: string;
    snapshot: GameViewState;
  }>;
  match(roomId: string): Promise<GameViewState>;
  sendCommand(
    matchId: string,
    csrfToken: string,
    command: GameCommand
  ): Promise<GameCommandApiResponse>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

async function requireSuccess<T>(
  response: Response,
  fallback: string
): Promise<T> {
  const body = await json(response);
  if (!response.ok || !isRecord(body) || body.ok !== true) {
    const failure = isRecord(body) ? body as ApiErrorBody : null;
    const localized = failure?.code
      ? ({
          SESSION_EXPIRED:
            "セッションの期限が切れました。合言葉を唱えて再参加してください。",
          ROOM_NOT_FOUND:
            "その合言葉の部屋は見つかりませんでした。",
          PASSPHRASE_IN_USE:
            "その合言葉の部屋はすでにあります。「唱える」から参加してください。",
          ROOM_FULL:
            "このルームは満席です。空席ができるまで参加できません。",
          ROOM_STARTED:
            "このルームは開始済みです。観戦許可がある場合は観戦してください。",
          DUPLICATE_PARTICIPANT:
            "同じ参加者が別タブで接続済みです。元のタブへ戻るか再参加してください。",
          ROOM_EXPIRED:
            "このルームは期限切れです。新しい合言葉で部屋を作ってください。"
        } as Readonly<Record<string, string>>)[failure.code]
      : undefined;
    const error = new Error(
      localized ??
      (typeof failure?.message === "string"
        ? failure.message
        : fallback)
    );
    error.name =
      typeof failure?.code === "string" ? failure.code : "OnlineRoomError";
    throw error;
  }
  return body as T;
}

function csrfHeaders(csrfToken: string): HeadersInit {
  return {
    "content-type": "application/json",
    "x-goodfield-csrf": csrfToken
  };
}

export function createOnlineRoomTransport(
  fetcher: FetchLike = fetch
): OnlineRoomTransport {
  const post = (
    path: string,
    body: unknown,
    csrfToken?: string
  ): Promise<Response> =>
    fetcher(path, {
      method: "POST",
      credentials: "same-origin",
      headers:
        csrfToken === undefined
          ? { "content-type": "application/json" }
          : csrfHeaders(csrfToken),
      body: JSON.stringify(body)
    });
  return {
    async create(input) {
      return requireSuccess<OnlineAdmission>(
        await post("/api/rooms", input),
        "オンラインルームを作成できませんでした。"
      );
    },
    async join(input) {
      return requireSuccess<OnlineAdmission>(
        await post("/api/rooms/join", input),
        "ルームへ参加できませんでした。"
      );
    },
    async joinInvitation(roomId, input) {
      return requireSuccess<OnlineAdmission>(
        await post(
          `/api/rooms/${encodeURIComponent(roomId)}/join`,
          input
        ),
        "招待ルームへ参加できませんでした。"
      );
    },
    async rejoin(roomId, input) {
      return requireSuccess<OnlineAdmission>(
        await post(
          `/api/rooms/${encodeURIComponent(roomId)}/rejoin`,
          input
        ),
        "ルームへ再参加できませんでした。"
      );
    },
    async view(roomId) {
      const body = await requireSuccess<{ room: OnlineRoom }>(
        await fetcher(`/api/rooms/${encodeURIComponent(roomId)}`, {
          credentials: "same-origin"
        }),
        "ルームの状態を取得できませんでした。"
      );
      return body.room;
    },
    async ready(roomId, csrfToken, ready) {
      const body = await requireSuccess<{ room: OnlineRoom }>(
        await post(
          `/api/rooms/${encodeURIComponent(roomId)}/ready`,
          { ready },
          csrfToken
        ),
        "準備状態を更新できませんでした。"
      );
      return body.room;
    },
    async setSeat(roomId, csrfToken, seatIndex, controller) {
      const response = await fetcher(
        `/api/rooms/${encodeURIComponent(roomId)}/seats/${seatIndex}`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: csrfHeaders(csrfToken),
          body: JSON.stringify({ controller })
        }
      );
      const body = await requireSuccess<{ room: OnlineRoom }>(
        response,
        "席を更新できませんでした。"
      );
      return body.room;
    },
    async setTeam(roomId, csrfToken, teamId) {
      const body = await requireSuccess<{ room: OnlineRoom }>(
        await post(
          `/api/rooms/${encodeURIComponent(roomId)}/team`,
          { teamId },
          csrfToken
        ),
        "チームを変更できませんでした。"
      );
      return body.room;
    },
    async shuffleTeams(roomId, csrfToken) {
      const body = await requireSuccess<{ room: OnlineRoom }>(
        await post(
          `/api/rooms/${encodeURIComponent(roomId)}/shuffle-teams`,
          {},
          csrfToken
        ),
        "チームをシャッフルできませんでした。"
      );
      return body.room;
    },
    async setEndTime(
      roomId,
      csrfToken,
      endTimeThreshold
    ) {
      const body = await requireSuccess<{ room: OnlineRoom }>(
        await post(
          `/api/rooms/${encodeURIComponent(roomId)}/end-time`,
          { endTimeThreshold },
          csrfToken
        ),
        "終末の時を変更できませんでした。"
      );
      return body.room;
    },
    async start(roomId, csrfToken, requestId) {
      return requireSuccess<{
        room: OnlineRoom;
        matchId: string;
        snapshot: GameViewState;
      }>(
        await post(
          `/api/rooms/${encodeURIComponent(roomId)}/start`,
          { requestId },
          csrfToken
        ),
        "試合を開始できませんでした。"
      );
    },
    async match(roomId) {
      const body = await requireSuccess<{ snapshot: GameViewState }>(
        await fetcher(
          `/api/rooms/${encodeURIComponent(roomId)}/match`,
          { credentials: "same-origin" }
        ),
        "試合へ接続できませんでした。"
      );
      return body.snapshot;
    },
    async sendCommand(matchId, csrfToken, command) {
      const response = await post(
        `/api/matches/${encodeURIComponent(matchId)}/commands`,
        command,
        csrfToken
      );
      const body = await json(response);
      if (!isRecord(body) || typeof body.ok !== "boolean") {
        throw new Error("サーバーから不正な応答を受け取りました。");
      }
      return body as GameCommandApiResponse;
    }
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character] ?? character
  );
}

function requestId(): string {
  return `browser-${globalThis.crypto.randomUUID()}`;
}

export type OnlineLobbyMount = {
  update: (room: OnlineRoom) => void;
  dispose: () => void;
};

export type OnlineLobbyMountOptions = {
  roomId: string;
  participantId: string | null;
  csrfToken: string;
  inviteUrl?: string;
  passphrase?: string;
  transport?: OnlineRoomTransport;
  pollIntervalMs?: number;
  clipboard?: Pick<Clipboard, "writeText">;
  onStarted: (snapshot: GameViewState, matchId: string) => void;
  onError?: (message: string) => void;
};

export function mountOnlineLobby(
  root: HTMLElement,
  initialRoom: OnlineRoom,
  options: OnlineLobbyMountOptions
): OnlineLobbyMount {
  const transport = options.transport ?? createOnlineRoomTransport();
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const clipboard = options.clipboard ?? navigator.clipboard;
  let room = initialRoom;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let busy = false;

  const report = (error: unknown): void => {
    options.onError?.(
      error instanceof Error
        ? error.message
        : "ルーム操作に失敗しました。"
    );
  };

  const render = (): void => {
    const ownSeat = room.seats.find(
      (seat) => seat.participantId === options.participantId
    );
    const isHost = ownSeat?.isHost ?? false;
    root.innerHTML = `
      <section class="online-lobby" aria-labelledby="online-lobby-title">
        <header>
          <p class="eyebrow">${
            room.accessMode === "PASSPHRASE"
              ? "合言葉で集まるオンライン対戦"
              : "招待制オンライン対戦"
          }</p>
          <h1 id="online-lobby-title">${
            room.accessMode === "PASSPHRASE"
              ? "隠れ乱闘"
              : "対戦ルーム"
          }</h1>
          <p aria-live="polite">${
            room.status === "OPEN"
              ? room.accessMode === "PASSPHRASE"
                ? "参加者を待っています。"
                : "参加者の準備を待っています。"
              : room.status === "STARTING"
                ? "試合を準備しています…"
                : room.status === "STARTED"
                  ? "試合が始まりました。"
                  : "このルームは期限切れです。"
          }</p>
        </header>
        ${
          options.inviteUrl && isHost
            ? `<div class="invite-row">
                <label>招待URL
                  <input readonly value="${escapeHtml(options.inviteUrl)}"
                    aria-label="招待URL">
                </label>
                <button type="button" data-copy-invite>コピー</button>
              </div>`
            : ""
        }
        <ol class="lobby-seats" aria-label="参加者一覧">
          ${room.seats.map((seat) => `
            <li>
              <span>席 ${seat.seatIndex + 1}</span>
              <strong>${escapeHtml(
                seat.displayName ??
                  (seat.controller === "CPU" ? "CPU" : "空席")
              )}</strong>
              <span>${
                room.accessMode === "PASSPHRASE"
                  ? seat.participantId === null
                    ? "参加待ち"
                    : seat.teamId === null
                      ? "個人戦"
                      : `チーム ${seat.teamId.slice(-1)}`
                  : seat.controller === "CPU"
                  ? "CPU"
                  : seat.ready
                    ? "準備完了"
                    : seat.participantId
                      ? "準備中"
                      : "参加待ち"
              }</span>
              ${seat.isHost ? "<span>ホスト</span>" : ""}
              ${
                room.accessMode === "INVITATION" &&
                isHost &&
                seat.participantId === null
                  ? `<button type="button" data-seat="${seat.seatIndex}"
                       data-controller="${seat.controller === "CPU" ? "EMPTY" : "CPU"}">
                       ${seat.controller === "CPU" ? "空席に戻す" : "CPUにする"}
                     </button>`
                  : ""
              }
            </li>
          `).join("")}
        </ol>
        ${
          room.accessMode === "PASSPHRASE" && ownSeat
            ? `<div class="hidden-brawl-controls">
                <section aria-labelledby="individual-battle-title">
                  <h2 id="individual-battle-title">個人戦</h2>
                  <button type="button" data-team-choice=""
                    aria-pressed="${String(ownSeat.teamId === null)}"
                    aria-label="個人戦を選ぶ">●</button>
                </section>
                <section aria-labelledby="team-battle-title">
                  <h2 id="team-battle-title">チーム戦</h2>
                  <div class="hidden-brawl-teams">
                    ${[
                      ["TEAM_1", "▲"],
                      ["TEAM_2", "▼"],
                      ["TEAM_3", "◆"],
                      ["TEAM_4", "■"]
                    ].map(([teamId, symbol]) =>
                      `<button type="button"
                        data-team-choice="${teamId}"
                        data-team="${teamId}"
                        aria-pressed="${String(ownSeat.teamId === teamId)}"
                        aria-label="チーム ${teamId?.slice(-1)}を選ぶ">
                        ${symbol}
                      </button>`
                    ).join("")}
                  </div>
                </section>
                <label class="hidden-brawl-end-time">
                  <span>終末の時</span>
                  <select data-end-time ${isHost ? "" : "disabled"}>
                    ${[50, 75, 100, 150].map((value) =>
                      `<option value="${value}"${
                        room.endTimeThreshold === value ? " selected" : ""
                      }>G.F.${value}</option>`
                    ).join("")}
                  </select>
                </label>
                ${
                  isHost
                    ? `<button type="button" data-shuffle-teams>
                        チームをシャッフル
                      </button>`
                    : ""
                }
              </div>`
            : ""
        }
        <div class="lobby-actions">
          ${
            room.accessMode === "INVITATION" && ownSeat
              ? `<button type="button" data-ready>
                   ${ownSeat.ready ? "準備を取り消す" : "準備完了"}
                 </button>`
              : ""
          }
          ${
            isHost
              ? `<button type="button" data-start
                   ${room.canStart ? "" : "disabled"}>
                   試合を開始
                 </button>`
              : ""
          }
        </div>
      </section>
    `;

    root.querySelector("[data-copy-invite]")?.addEventListener(
      "click",
      () => {
        if (!options.inviteUrl) return;
        void clipboard.writeText(options.inviteUrl).catch(report);
      }
    );
    root.querySelector("[data-copy-passphrase]")?.addEventListener(
      "click",
      () => {
        if (!options.passphrase) return;
        void clipboard.writeText(options.passphrase).catch(report);
      }
    );
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      "[data-team-choice]"
    )) {
      button.addEventListener("click", () => {
        if (busy) return;
        const teamId =
          button.dataset.teamChoice === ""
            ? null
            : button.dataset.teamChoice as OnlineRoomSeat["teamId"];
        busy = true;
        void transport.setTeam(
          room.roomId,
          options.csrfToken,
          teamId
        ).then(update).catch(report).finally(() => {
          busy = false;
        });
      });
    }
    root.querySelector("[data-shuffle-teams]")?.addEventListener(
      "click",
      () => {
        if (busy) return;
        busy = true;
        void transport.shuffleTeams(
          room.roomId,
          options.csrfToken
        ).then(update).catch(report).finally(() => {
          busy = false;
        });
      }
    );
    root.querySelector<HTMLSelectElement>("[data-end-time]")
      ?.addEventListener("change", (event) => {
        if (busy || !(event.currentTarget instanceof HTMLSelectElement)) {
          return;
        }
        const endTimeThreshold = Number(event.currentTarget.value) as
          50 | 75 | 100 | 150;
        busy = true;
        void transport.setEndTime(
          room.roomId,
          options.csrfToken,
          endTimeThreshold
        ).then(update).catch(report).finally(() => {
          busy = false;
        });
      });
    root.querySelector("[data-ready]")?.addEventListener("click", () => {
      if (!ownSeat || busy) return;
      busy = true;
      void transport.ready(
        room.roomId,
        options.csrfToken,
        !ownSeat.ready
      ).then(update).catch(report).finally(() => {
        busy = false;
      });
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      "[data-seat]"
    )) {
      button.addEventListener("click", () => {
        if (busy) return;
        const seatIndex = Number(button.dataset.seat);
        const controller =
          button.dataset.controller === "CPU" ? "CPU" : null;
        busy = true;
        void transport.setSeat(
          room.roomId,
          options.csrfToken,
          seatIndex,
          controller
        ).then(update).catch(report).finally(() => {
          busy = false;
        });
      });
    }
    root.querySelector("[data-start]")?.addEventListener("click", () => {
      if (!room.canStart || busy) return;
      busy = true;
      void transport.start(
        room.roomId,
        options.csrfToken,
        requestId()
      ).then((started) => {
        options.onStarted(started.snapshot, started.matchId);
      }).catch(report).finally(() => {
        busy = false;
      });
    });
  };

  const update = (nextRoom: OnlineRoom): void => {
    room = nextRoom;
    if (room.status === "STARTED" && room.matchId) {
      void transport.match(room.roomId)
        .then((snapshot) => options.onStarted(snapshot, room.matchId ?? ""))
        .catch(report);
      return;
    }
    render();
  };

  const poll = (): void => {
    if (disposed) return;
    void transport.view(room.roomId)
      .then(update)
      .catch(report)
      .finally(() => {
        if (!disposed) timer = setTimeout(poll, pollIntervalMs);
      });
  };

  render();
  timer = setTimeout(poll, pollIntervalMs);
  return {
    update,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      root.innerHTML = "";
    }
  };
}
