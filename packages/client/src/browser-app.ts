import type { GameCommand } from "../../shared/src/model.ts";
import type {
  GameCommandApiResponse,
  GameViewState,
  RealtimeMatchMessage
} from "../../shared/src/protocol.ts";
import {
  BATTLE_SCREEN_STYLES,
  mountBattleScreen,
  type BattleScreenMount
} from "./battle-screen.ts";
import {
  createOnlineRoomTransport,
  mountOnlineLobby,
  type OnlineAdmission,
  type OnlineLobbyMount,
  type OnlineRoomTransport
} from "./online-lobby.ts";
import { initialUiState } from "./ui-machine.ts";

const LOCAL_ACTOR_STORAGE_KEY = "goodfield.local-actor.v1";
const ONLINE_ADMISSION_STORAGE_KEY = "goodfield.online-admission.v1";
const BATTLE_STYLE_ID = "goodfield-battle-screen-styles";

export type LocalActorCredential = {
  matchId: string;
  playerId: string;
  accessToken: string;
  lastEventSeq: number | null;
};

export type LocalMatchCreatedResponse = {
  ok: true;
  matchId: string;
  creator: {
    playerId: string;
    accessToken: string;
  };
  snapshot: GameViewState;
};

export type OnlineBrowserCredential = {
  roomId: string;
  participantId: string | null;
  rejoinToken: string | null;
  csrfToken: string;
  inviteUrl: string | null;
  matchId: string | null;
  lastEventSeq: number | null;
};

type ApiFailure = {
  ok: false;
  code?: string;
  message?: string;
};

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type LocalMatchTransport = {
  createMatch(
    displayName: string,
    cpuCount: number
  ): Promise<LocalMatchCreatedResponse>;
  restoreMatch(
    credential: LocalActorCredential
  ): Promise<GameViewState>;
  sendCommand(
    credential: LocalActorCredential,
    command: GameCommand
  ): Promise<GameCommandApiResponse>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiMessage(value: unknown, fallback: string): string {
  if (
    isRecord(value) &&
    typeof value.message === "string" &&
    value.message.length > 0
  ) {
    return value.message;
  }
  return fallback;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

export function createLocalMatchTransport(
  fetcher: FetchLike = fetch
): LocalMatchTransport {
  return {
    async createMatch(displayName, cpuCount) {
      const response = await fetcher("/api/matches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName, cpuCount, mode: "TRAINING" })
      });
      const body = await responseJson(response);
      if (
        !response.ok ||
        !isRecord(body) ||
        body.ok !== true ||
        typeof body.matchId !== "string" ||
        !isRecord(body.creator) ||
        typeof body.creator.playerId !== "string" ||
        typeof body.creator.accessToken !== "string" ||
        !isRecord(body.snapshot)
      ) {
        throw new Error(apiMessage(body, "試合を開始できませんでした。"));
      }
      return body as LocalMatchCreatedResponse;
    },

    async restoreMatch(credential) {
      const response = await fetcher(
        `/api/matches/${encodeURIComponent(credential.matchId)}`,
        {
          headers: {
            authorization: `Bearer ${credential.accessToken}`
          }
        }
      );
      const body = await responseJson(response);
      if (
        !response.ok ||
        !isRecord(body) ||
        body.ok !== true ||
        !isRecord(body.snapshot)
      ) {
        const failure = body as ApiFailure | null;
        const error = new Error(
          apiMessage(failure, "保存された試合を復元できませんでした。")
        );
        error.name =
          failure?.code === "MATCH_NOT_FOUND"
            ? "MatchNotFoundError"
            : "MatchRestoreError";
        throw error;
      }
      return body.snapshot as GameViewState;
    },

    async sendCommand(credential, command) {
      const response = await fetcher(
        `/api/matches/${encodeURIComponent(credential.matchId)}/commands`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(command)
        }
      );
      const body = await responseJson(response);
      if (
        !isRecord(body) ||
        typeof body.ok !== "boolean"
      ) {
        throw new Error("サーバーから不正な応答を受け取りました。");
      }
      return body as GameCommandApiResponse;
    }
  };
}

export function parseStoredLocalActor(
  value: string | null
): LocalActorCredential | null {
  if (value === null) return null;
  try {
    const candidate = JSON.parse(value) as unknown;
    if (
      !isRecord(candidate) ||
      typeof candidate.matchId !== "string" ||
      typeof candidate.playerId !== "string" ||
      typeof candidate.accessToken !== "string" ||
      candidate.matchId.length === 0 ||
      candidate.playerId.length === 0 ||
      candidate.accessToken.length === 0 ||
      (
        candidate.lastEventSeq !== null &&
        (
          typeof candidate.lastEventSeq !== "number" ||
          !Number.isSafeInteger(candidate.lastEventSeq) ||
          candidate.lastEventSeq < 0
        )
      )
    ) {
      return null;
    }
    return {
      matchId: candidate.matchId,
      playerId: candidate.playerId,
      accessToken: candidate.accessToken,
      lastEventSeq: candidate.lastEventSeq
    };
  } catch {
    return null;
  }
}

export function parseStoredOnlineCredential(
  value: string | null
): OnlineBrowserCredential | null {
  if (value === null) return null;
  try {
    const candidate = JSON.parse(value) as unknown;
    if (
      !isRecord(candidate) ||
      typeof candidate.roomId !== "string" ||
      (
        candidate.participantId !== null &&
        typeof candidate.participantId !== "string"
      ) ||
      (
        candidate.rejoinToken !== null &&
        typeof candidate.rejoinToken !== "string"
      ) ||
      typeof candidate.csrfToken !== "string" ||
      (
        candidate.inviteUrl !== null &&
        typeof candidate.inviteUrl !== "string"
      ) ||
      (
        candidate.matchId !== null &&
        typeof candidate.matchId !== "string"
      ) ||
      (
        candidate.lastEventSeq !== null &&
        (
          typeof candidate.lastEventSeq !== "number" ||
          !Number.isSafeInteger(candidate.lastEventSeq) ||
          candidate.lastEventSeq < 0
        )
      )
    ) {
      return null;
    }
    return candidate as OnlineBrowserCredential;
  } catch {
    return null;
  }
}

export function websocketUrl(location: Location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/realtime`;
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

function ensureBattleStyles(documentObject: Document): void {
  if (documentObject.getElementById(BATTLE_STYLE_ID)) return;
  const style = documentObject.createElement("style");
  style.id = BATTLE_STYLE_ID;
  style.textContent = BATTLE_SCREEN_STYLES;
  documentObject.head.append(style);
}

export type GoodFieldBrowserApp = {
  restore: () => Promise<void>;
  showStart: (message?: string) => void;
  dispose: () => void;
};

export type GoodFieldBrowserAppOptions = {
  transport?: LocalMatchTransport;
  onlineTransport?: OnlineRoomTransport;
  storage?: Storage;
  document?: Document;
  location?: Location;
  history?: History;
  createWebSocket?: (
    url: string,
    protocols: string | string[]
  ) => WebSocket;
  setReconnectTimer?: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>;
  clearReconnectTimer?: (
    timer: ReturnType<typeof setTimeout>
  ) => void;
};

export function mountGoodFieldBrowserApp(
  root: HTMLElement,
  options: GoodFieldBrowserAppOptions = {}
): GoodFieldBrowserApp {
  const documentObject = options.document ?? document;
  const locationObject = options.location ?? window.location;
  const historyObject = options.history ?? window.history;
  const storage = options.storage ?? window.localStorage;
  const transport = options.transport ?? createLocalMatchTransport();
  const onlineTransport =
    options.onlineTransport ?? createOnlineRoomTransport();
  const createWebSocket =
    options.createWebSocket ??
    ((url, protocols) => new WebSocket(url, protocols));
  const setReconnectTimer = options.setReconnectTimer ?? setTimeout;
  const clearReconnectTimer = options.clearReconnectTimer ?? clearTimeout;
  let battle: BattleScreenMount | null = null;
  let lobby: OnlineLobbyMount | null = null;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let credential: LocalActorCredential | null = null;
  let onlineCredential: OnlineBrowserCredential | null = null;
  let disposed = false;

  const saveCredential = (): void => {
    if (!credential) {
      storage.removeItem(LOCAL_ACTOR_STORAGE_KEY);
      return;
    }
    storage.setItem(
      LOCAL_ACTOR_STORAGE_KEY,
      JSON.stringify(credential)
    );
  };

  const saveOnlineCredential = (): void => {
    if (!onlineCredential) {
      storage.removeItem(ONLINE_ADMISSION_STORAGE_KEY);
      return;
    }
    storage.setItem(
      ONLINE_ADMISSION_STORAGE_KEY,
      JSON.stringify(onlineCredential)
    );
  };

  const stopConnection = (): void => {
    if (reconnectTimer !== null) {
      clearReconnectTimer(reconnectTimer);
      reconnectTimer = null;
    }
    const currentSocket = socket;
    socket = null;
    if (
      currentSocket &&
      currentSocket.readyState !== WebSocket.CLOSED &&
      currentSocket.readyState !== WebSocket.CLOSING
    ) {
      currentSocket.close(1000, "Client navigation");
    }
  };

  const stopBattle = (): void => {
    stopConnection();
    lobby?.dispose();
    lobby = null;
    battle?.dispose();
    battle = null;
  };

  const renderNotice = (
    message: string,
    kind: "info" | "error" = "info"
  ): void => {
    let notice = root.querySelector<HTMLElement>("[data-app-notice]");
    if (!notice) {
      notice = documentObject.createElement("p");
      notice.dataset.appNotice = "";
      root.prepend(notice);
    }
    notice.className = `app-notice app-notice--${kind}`;
    notice.textContent = message;
  };

  const clearNotice = (): void => {
    root.querySelector("[data-app-notice]")?.remove();
  };

  const connectRealtime = (): void => {
    if (disposed || !credential) return;
    stopConnection();
    const activeCredential = credential;
    const realtimeSocket = createWebSocket(
      websocketUrl(locationObject),
      [
        "goodfield",
        `goodfield-token.${activeCredential.accessToken}`
      ]
    );
    socket = realtimeSocket;
    realtimeSocket.addEventListener("open", () => {
      if (socket !== realtimeSocket) return;
      reconnectAttempt = 0;
      clearNotice();
      realtimeSocket.send(JSON.stringify({
        type: "SYNC_MATCH",
        matchId: activeCredential.matchId,
        lastEventSeq: activeCredential.lastEventSeq
      }));
    });
    realtimeSocket.addEventListener("message", (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data)) as unknown;
      } catch {
        renderNotice("同期データを読み取れませんでした。", "error");
        return;
      }
      if (
        !isRecord(message) ||
        typeof message.type !== "string" ||
        message.type === "CONNECTED"
      ) {
        return;
      }
      if (message.type === "SYNC_ERROR") {
        renderNotice(
          apiMessage(message, "リアルタイム同期に失敗しました。"),
          "error"
        );
        return;
      }
      const realtime = message as RealtimeMatchMessage;
      if (
        (
          realtime.type !== "EVENT_BATCH" &&
          realtime.type !== "FULL_SNAPSHOT"
        ) ||
        realtime.matchId !== activeCredential.matchId
      ) {
        return;
      }
      credential = {
        ...activeCredential,
        lastEventSeq: realtime.eventSeq
      };
      saveCredential();
      battle?.applyRealtimeMessage(realtime);
    });
    realtimeSocket.addEventListener("close", (event) => {
      if (
        disposed ||
        socket !== realtimeSocket ||
        event.code === 1000
      ) {
        return;
      }
      socket = null;
      renderNotice("接続が切れました。再接続しています…", "error");
      const delays = [250, 500, 1_000, 2_000, 5_000] as const;
      const delay =
        delays[Math.min(reconnectAttempt, delays.length - 1)] ?? 5_000;
      reconnectAttempt += 1;
      reconnectTimer = setReconnectTimer(() => {
        reconnectTimer = null;
        connectRealtime();
      }, delay);
    });
    realtimeSocket.addEventListener("error", () => {
      renderNotice("リアルタイム接続に失敗しました。", "error");
    });
  };

  const connectOnlineRealtime = (): void => {
    if (
      disposed ||
      !onlineCredential ||
      onlineCredential.matchId === null
    ) {
      return;
    }
    stopConnection();
    const activeCredential = onlineCredential;
    const realtimeSocket = createWebSocket(
      websocketUrl(locationObject),
      "goodfield"
    );
    socket = realtimeSocket;
    realtimeSocket.addEventListener("open", () => {
      if (socket !== realtimeSocket || !activeCredential.matchId) return;
      reconnectAttempt = 0;
      clearNotice();
      realtimeSocket.send(JSON.stringify({
        type: "SYNC_MATCH",
        matchId: activeCredential.matchId,
        lastEventSeq: activeCredential.lastEventSeq
      }));
    });
    realtimeSocket.addEventListener("message", (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data)) as unknown;
      } catch {
        renderNotice("同期データを読み取れませんでした。", "error");
        return;
      }
      if (
        !isRecord(message) ||
        typeof message.type !== "string" ||
        message.type === "CONNECTED"
      ) {
        return;
      }
      if (message.type === "SYNC_ERROR") {
        renderNotice(
          apiMessage(message, "リアルタイム同期に失敗しました。"),
          "error"
        );
        return;
      }
      const realtime = message as RealtimeMatchMessage;
      if (
        (
          realtime.type !== "EVENT_BATCH" &&
          realtime.type !== "FULL_SNAPSHOT"
        ) ||
        realtime.matchId !== activeCredential.matchId
      ) {
        return;
      }
      onlineCredential = {
        ...activeCredential,
        lastEventSeq: realtime.eventSeq
      };
      saveOnlineCredential();
      battle?.applyRealtimeMessage(realtime);
    });
    realtimeSocket.addEventListener("close", (event) => {
      if (
        disposed ||
        socket !== realtimeSocket ||
        event.code === 1000
      ) {
        return;
      }
      socket = null;
      renderNotice("接続が切れました。再接続しています…", "error");
      const delays = [250, 500, 1_000, 2_000, 5_000] as const;
      const delay =
        delays[Math.min(reconnectAttempt, delays.length - 1)] ?? 5_000;
      reconnectAttempt += 1;
      reconnectTimer = setReconnectTimer(() => {
        reconnectTimer = null;
        connectOnlineRealtime();
      }, delay);
    });
    realtimeSocket.addEventListener("error", () => {
      renderNotice("リアルタイム接続に失敗しました。", "error");
    });
  };

  const showBattle = (
    snapshot: GameViewState,
    activeCredential: LocalActorCredential
  ): void => {
    stopBattle();
    onlineCredential = null;
    saveOnlineCredential();
    credential = activeCredential;
    saveCredential();
    ensureBattleStyles(documentObject);
    root.innerHTML = "";
    const battleRoot = documentObject.createElement("div");
    root.append(battleRoot);
    battle = mountBattleScreen(
      battleRoot,
      snapshot,
      initialUiState(),
      { exitHref: "#new-match" },
      {
        onCommand(command) {
          const commandCredential = credential;
          if (!commandCredential) return;
          void transport.sendCommand(commandCredential, command)
            .then((response) => {
              if (response.ok) {
                clearNotice();
                battle?.updateView(response.snapshot);
                return;
              }
              if (response.snapshot) {
                battle?.rejectCommand(response.snapshot);
              }
              renderNotice(response.message, "error");
            })
            .catch((error: unknown) => {
              if (battle && credential) {
                void transport.restoreMatch(credential)
                  .then((view) => battle?.rejectCommand(view))
                  .catch(() => {});
              }
              renderNotice(
                error instanceof Error
                  ? error.message
                  : "コマンドを送信できませんでした。",
                "error"
              );
            });
        }
      }
    );
    connectRealtime();
  };

  const showOnlineBattle = (
    snapshot: GameViewState,
    activeCredential: OnlineBrowserCredential
  ): void => {
    stopBattle();
    credential = null;
    saveCredential();
    onlineCredential = activeCredential;
    saveOnlineCredential();
    ensureBattleStyles(documentObject);
    root.innerHTML = "";
    const battleRoot = documentObject.createElement("div");
    root.append(battleRoot);
    battle = mountBattleScreen(
      battleRoot,
      snapshot,
      initialUiState(),
      { exitHref: "#new-match" },
      {
        onCommand(command) {
          const current = onlineCredential;
          if (!current?.matchId) return;
          void onlineTransport.sendCommand(
            current.matchId,
            current.csrfToken,
            command
          ).then((response) => {
            if (response.ok) {
              clearNotice();
              battle?.updateView(response.snapshot);
              return;
            }
            if (response.snapshot) {
              battle?.rejectCommand(response.snapshot);
            }
            renderNotice(response.message, "error");
          }).catch((error: unknown) => {
            renderNotice(
              error instanceof Error
                ? error.message
                : "コマンドを送信できませんでした。",
              "error"
            );
          });
        }
      }
    );
    connectOnlineRealtime();
  };

  const admissionCredential = (
    admission: OnlineAdmission,
    previous?: OnlineBrowserCredential
  ): OnlineBrowserCredential => ({
    roomId: admission.room.roomId,
    participantId: admission.participantId,
    rejoinToken:
      admission.rejoinToken ?? previous?.rejoinToken ?? null,
    csrfToken: admission.csrfToken,
    inviteUrl: admission.inviteUrl ?? previous?.inviteUrl ?? null,
    matchId: admission.room.matchId,
    lastEventSeq: previous?.lastEventSeq ?? null
  });

  const showOnlineLobby = (
    admission: OnlineAdmission,
    previous?: OnlineBrowserCredential,
    passphrase?: string
  ): void => {
    stopBattle();
    credential = null;
    saveCredential();
    onlineCredential = admissionCredential(admission, previous);
    saveOnlineCredential();
    root.innerHTML = "";
    const lobbyRoot = documentObject.createElement("div");
    root.append(lobbyRoot);
    lobby = mountOnlineLobby(lobbyRoot, admission.room, {
      roomId: admission.room.roomId,
      participantId: admission.participantId,
      csrfToken: admission.csrfToken,
      ...(admission.inviteUrl === undefined
        ? {}
        : { inviteUrl: admission.inviteUrl }),
      ...(passphrase === undefined ? {} : { passphrase }),
      transport: onlineTransport,
      onStarted(snapshot, matchId) {
        const current = onlineCredential;
        if (!current) return;
        showOnlineBattle(snapshot, {
          ...current,
          matchId
        });
      },
      onError(message) {
        renderNotice(message, "error");
      }
    });
  };

  const showStart = (message?: string): void => {
    stopBattle();
    credential = null;
    saveCredential();
    onlineCredential = null;
    saveOnlineCredential();
    let displayName = "Player";

    const soundMeter = Array.from(
      { length: 10 },
      () => "<span aria-hidden=\"true\"></span>"
    ).join("");

    const renderFrame = (
      screenTitle: string,
      stageMarkup: string,
      onBack?: () => void
    ): void => {
      root.innerHTML = `
        <section class="gf-site-frame" aria-labelledby="goodfield-title">
          <h1 id="goodfield-title" class="sr-only">GoodField</h1>
          <header class="gf-chrome-bar gf-chrome-bar--top">
            ${
              onBack
                ? `<button type="button"
                     class="gf-chrome-bar__slot gf-chrome-bar__slot--back"
                     data-stage-back aria-label="前の画面へ戻る">←</button>`
                : '<span aria-hidden="true"></span>'
            }
            <strong class="gf-chrome-bar__title">${escapeHtml(screenTitle)}</strong>
            <a class="gf-chrome-bar__slot" href="/rulebook"
              aria-label="教典を開く">
              <span class="gf-book-icon" aria-hidden="true"></span>
              教典
            </a>
          </header>
          <div class="gf-stage">
            ${
              message
                ? `<p class="startup-error" role="alert">${escapeHtml(message)}</p>`
                : ""
            }
            ${stageMarkup}
          </div>
          <footer class="gf-chrome-bar gf-chrome-bar--bottom">
            <span class="gf-chrome-bar__left">${escapeHtml(displayName)}</span>
            <button type="button"
              class="gf-chrome-bar__slot gf-chrome-bar__slot--center"
              data-home-settings aria-expanded="false">
              <span class="gf-gear-icon" aria-hidden="true"></span>
              設定
            </button>
            <span class="gf-sound-meter" aria-label="音量">${soundMeter}</span>
          </footer>
          <aside class="gf-settings-drawer" data-settings-drawer hidden>
            <p>GoodField 設定</p>
            <a href="/online.html">オンライン版の利用条件</a>
          </aside>
        </section>
      `;
      root.querySelector("[data-stage-back]")?.addEventListener(
        "click",
        () => onBack?.()
      );
      const settingsButton = root.querySelector<HTMLButtonElement>(
        "[data-home-settings]"
      );
      const settingsDrawer = root.querySelector<HTMLElement>(
        "[data-settings-drawer]"
      );
      settingsButton?.addEventListener("click", () => {
        if (!settingsDrawer) return;
        settingsDrawer.hidden = !settingsDrawer.hidden;
        settingsButton.setAttribute(
          "aria-expanded",
          String(!settingsDrawer.hidden)
        );
      });
    };

    const bindLocalForm = (): void => {
      const form = root.querySelector<HTMLFormElement>(
        "[data-local-match-form]"
      );
      form?.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!form || disposed) return;
        const submit = form.querySelector<HTMLButtonElement>(
          'button[type="submit"]'
        );
        const formData = new FormData(form);
        const selectedDisplayName = String(
          formData.get("displayName") ?? ""
        ).trim();
        const cpuCount = Number(formData.get("cpuCount"));
        if (submit) submit.disabled = true;
        renderNotice("試合を準備しています…");
        void transport.createMatch(selectedDisplayName, cpuCount)
          .then((created) => {
            showBattle(created.snapshot, {
              matchId: created.matchId,
              playerId: created.creator.playerId,
              accessToken: created.creator.accessToken,
              lastEventSeq: null
            });
          })
          .catch((error: unknown) => {
            if (submit) submit.disabled = false;
            renderNotice(
              error instanceof Error
                ? error.message
                : "試合を開始できませんでした。",
              "error"
            );
          });
      });
    };

    const bindOnlineForm = (): void => {
      const onlineForm = root.querySelector<HTMLFormElement>(
        "[data-online-room-form]"
      );
      onlineForm?.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!onlineForm || disposed) return;
        const submit = onlineForm.querySelector<HTMLButtonElement>(
          'button[type="submit"]'
        );
        const formData = new FormData(onlineForm);
        const selectedDisplayName = String(
          formData.get("displayName") ?? ""
        ).trim();
        const passphrase = String(
          formData.get("passphrase") ?? ""
        ).trim();
        const seatCount = Number(formData.get("seatCount"));
        const cpuCount = Number(formData.get("cpuCount"));
        if (submit) submit.disabled = true;
        renderNotice("オンラインルームを作成しています…");
        void onlineTransport.create({
          displayName: selectedDisplayName,
          ...(passphrase.length === 0 ? {} : { passphrase }),
          seatCount,
          cpuCount,
          allowSpectators: formData.get("allowSpectators") === "on",
          requestId: `browser-${globalThis.crypto.randomUUID()}`
        }).then((admission) => {
          clearNotice();
          showOnlineLobby(
            admission,
            undefined,
            passphrase.length === 0 ? undefined : passphrase
          );
        }).catch((error: unknown) => {
          if (submit) submit.disabled = false;
          renderNotice(
            error instanceof Error
              ? error.message
              : "オンラインルームを作成できませんでした。",
            "error"
          );
        });
      });
    };

    const renderTraining = (): void => {
      renderFrame(
        "修行",
        `
          <section class="gf-setup-panel" aria-labelledby="training-title">
            <h2 id="training-title" class="sr-only">修行の設定</h2>
            <form class="gf-setup-form" data-local-match-form>
              <input type="hidden" name="displayName"
                value="${escapeHtml(displayName)}">
              <label class="gf-player-count-control">
                <span>修行者</span>
                <select name="cpuCount" aria-label="修行者の人数">
                  ${Array.from({ length: 8 }, (_, index) => {
                    const cpuCount = index + 1;
                    const playerCount = cpuCount + 1;
                    return `<option value="${cpuCount}"${
                      cpuCount === 3 ? " selected" : ""
                    }>${playerCount} 人</option>`;
                  }).join("")}
                </select>
              </label>
              <div class="gf-end-time">
                <span>終末の時</span>
                <strong>G.F.75</strong>
              </div>
              <button type="submit" class="gf-setup-submit">
                戦いを始める
              </button>
            </form>
          </section>
        `,
        renderModes
      );
      bindLocalForm();
    };

    const renderOnline = (
      duel: boolean,
      passphrase?: string
    ): void => {
      const seatOptions = duel
        ? '<option value="2">2 人</option>'
        : Array.from({ length: 8 }, (_, index) => {
            const count = index + 2;
            return `<option value="${count}"${
              count === 4 ? " selected" : ""
            }>${count} 人</option>`;
          }).join("");
      renderFrame(
        duel ? "真剣タイマン" : "隠れ乱闘",
        `
          <section class="gf-setup-panel" aria-labelledby="online-room-title">
            <h2 id="online-room-title" class="sr-only">
              ${duel ? "2人対戦ルーム" : "隠れ乱闘ルーム"}の設定
            </h2>
            <form class="gf-setup-form" data-online-room-form>
              <input type="hidden" name="displayName"
                value="${escapeHtml(displayName)}">
              ${
                passphrase === undefined
                  ? ""
                  : `<input type="hidden" name="passphrase"
                      value="${escapeHtml(passphrase)}">`
              }
              <div class="gf-room-settings">
                <label>
                  <span>参加人数</span>
                  <select name="seatCount">${seatOptions}</select>
                </label>
                <label>
                  <span>CPU人数</span>
                  <select name="cpuCount">
                    ${Array.from({ length: 9 }, (_, count) =>
                      `<option value="${count}">${count} 人</option>`
                    ).join("")}
                  </select>
                </label>
                <label class="checkbox-row">
                  <input type="checkbox" name="allowSpectators">
                  <span>観戦者を許可する</span>
                </label>
              </div>
              <button type="submit" class="gf-setup-submit">
                部屋を作る
              </button>
              <a class="gf-terms-link" href="/online.html">
                オンライン版の利用条件
              </a>
            </form>
          </section>
        `,
        renderModes
      );
      bindOnlineForm();
    };

    const renderHiddenBrawl = (): void => {
      renderFrame(
        "隠れ乱闘",
        `
          <section class="gf-setup-panel"
            aria-labelledby="hidden-brawl-title">
            <h2 id="hidden-brawl-title">部屋の合言葉</h2>
            <p>友達と共有した合言葉を入力してください。</p>
            <form class="gf-setup-form" data-passphrase-form>
              <label>
                <span>部屋の合言葉</span>
                <input name="passphrase" maxlength="40"
                  autocomplete="off" required autofocus>
              </label>
              <button type="submit" class="gf-setup-submit">
                唱える
              </button>
              <a class="gf-terms-link" href="/online.html">
                オンライン版の利用条件
              </a>
            </form>
          </section>
        `,
        renderModes
      );
      const form = root.querySelector<HTMLFormElement>(
        "[data-passphrase-form]"
      );
      const passphraseInput = form?.querySelector<HTMLInputElement>(
        'input[name="passphrase"]'
      );
      const enteredPassphrase = (): string =>
        passphraseInput?.value.trim() ?? "";
      form?.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!form || disposed) return;
        const submit = form.querySelector<HTMLButtonElement>(
          'button[type="submit"]'
        );
        const passphrase = enteredPassphrase();
        if (passphrase.length === 0) return;
        if (submit) submit.disabled = true;
        renderNotice("合言葉を唱えています…");
        void onlineTransport.join({
          displayName,
          passphrase,
          requestId: `browser-${globalThis.crypto.randomUUID()}`
        }).then((admission) => {
          clearNotice();
          showOnlineLobby(admission, undefined, passphrase);
        }).catch((error: unknown) => {
          if (submit) submit.disabled = false;
          renderNotice(
            error instanceof Error
              ? error.message
              : "合言葉の部屋へ参加できませんでした。",
            "error"
          );
        });
      });
    };

    function renderModes(): void {
      renderFrame(
        "",
        `
          <nav class="gf-mode-stack" aria-label="ゲームモード">
            <button type="button" class="gf-mode-card"
              data-mode-training>
              <h2>修行</h2>
              <span class="gf-mode-card__stripe"></span>
              <p>コンピュータと対戦</p>
            </button>
            <button type="button"
              class="gf-mode-card gf-mode-card--online"
              data-mode-online>
              <h2>隠れ乱闘</h2>
              <span class="gf-mode-card__stripe"></span>
              <p>友達と対戦</p>
            </button>
            <button type="button"
              class="gf-mode-card gf-mode-card--duel"
              data-mode-duel>
              <h2>真剣タイマン</h2>
              <span class="gf-mode-card__stripe"></span>
              <p>2人個人戦</p>
            </button>
          </nav>
        `,
        renderHome
      );
      root.querySelector("[data-mode-training]")?.addEventListener(
        "click",
        renderTraining
      );
      root.querySelector("[data-mode-online]")?.addEventListener(
        "click",
        renderHiddenBrawl
      );
      root.querySelector("[data-mode-duel]")?.addEventListener(
        "click",
        () => renderOnline(true)
      );
    }

    function renderHome(): void {
      renderFrame(
        "",
        `
          <div class="gf-home-logo" aria-hidden="true">
            <span class="gf-home-logo__wordmark">
              <span class="gf-home-logo__mark">G</span>OOD FIELD
            </span>
          </div>
          <form class="gf-home-form" data-birth-form>
            <label>
              預言者の名前
              <input name="displayName" maxlength="40"
                autocomplete="nickname" value="${escapeHtml(displayName)}"
                required>
            </label>
            <button type="submit" class="gf-primary-game-button">
              生誕する
            </button>
          </form>
          <div class="gf-store-badges" aria-label="対応環境">
            <span class="gf-store-badge">
              WEBで遊べる
              <strong>Browser</strong>
            </span>
            <span class="gf-store-badge">
              招待対戦対応
              <strong>Online</strong>
            </span>
          </div>
        `
      );
      const birthForm = root.querySelector<HTMLFormElement>(
        "[data-birth-form]"
      );
      birthForm?.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!birthForm || disposed) return;
        const nextName = String(
          new FormData(birthForm).get("displayName") ?? ""
        ).trim();
        if (nextName.length === 0) return;
        displayName = nextName;
        renderModes();
      });
    }

    renderHome();
  };

  const showInvitation = (
    roomId: string,
    inviteCode: string,
    message?: string
  ): void => {
    stopBattle();
    root.innerHTML = `
      <section class="startup-card" aria-labelledby="join-room-title">
        <p class="eyebrow">招待制オンライン対戦</p>
        <h1 id="join-room-title">ルームへ参加</h1>
        <p>表示名を入力して招待ルームへ参加します。</p>
        ${
          message
            ? `<p class="startup-error" role="alert">${escapeHtml(message)}</p>`
            : ""
        }
        <form data-online-join-form>
          <label>
            表示名
            <input name="displayName" maxlength="40" autocomplete="nickname"
              required autofocus>
          </label>
          <button type="submit">参加する</button>
        </form>
        <button type="button" data-back-start>開始画面へ戻る</button>
      </section>
    `;
    const form = root.querySelector<HTMLFormElement>(
      "[data-online-join-form]"
    );
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form || disposed) return;
      const submit = form.querySelector<HTMLButtonElement>(
        'button[type="submit"]'
      );
      const displayName = String(
        new FormData(form).get("displayName") ?? ""
      ).trim();
      if (submit) submit.disabled = true;
      renderNotice("ルームへ参加しています…");
      void onlineTransport.joinInvitation(roomId, {
        displayName,
        inviteCode,
        requestId: `browser-${globalThis.crypto.randomUUID()}`
      }).then((admission) => {
        historyObject.replaceState(
          null,
          "",
          `/?room=${encodeURIComponent(roomId)}`
        );
        clearNotice();
        showOnlineLobby(admission);
      }).catch((error: unknown) => {
        if (submit) submit.disabled = false;
        renderNotice(
          error instanceof Error
            ? error.message
            : "ルームへ参加できませんでした。",
          "error"
        );
      });
    });
    root.querySelector("[data-back-start]")?.addEventListener(
      "click",
      () => {
        historyObject.replaceState(null, "", "/");
        showStart();
      }
    );
  };

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>('a[href="#new-match"]');
    if (!link) return;
    event.preventDefault();
    showStart();
  });

  const restore = async (): Promise<void> => {
    const pageUrl = new URL(locationObject.href);
    const invitedRoomId = pageUrl.searchParams.get("room");
    const inviteCode = pageUrl.searchParams.get("invite");
    if (invitedRoomId && inviteCode) {
      showInvitation(invitedRoomId, inviteCode);
      return;
    }
    const storedOnline = parseStoredOnlineCredential(
      storage.getItem(ONLINE_ADMISSION_STORAGE_KEY)
    );
    if (storedOnline) {
      root.innerHTML =
        '<p class="boot-message">オンラインルームへ再接続しています…</p>';
      try {
        const room = await onlineTransport.view(storedOnline.roomId);
        if (room.status === "STARTED" && room.matchId) {
          const snapshot = await onlineTransport.match(room.roomId);
          showOnlineBattle(snapshot, {
            ...storedOnline,
            matchId: room.matchId
          });
        } else {
          showOnlineLobby({
            room,
            participantId: storedOnline.participantId,
            csrfToken: storedOnline.csrfToken,
            ...(storedOnline.inviteUrl === null
              ? {}
              : { inviteUrl: storedOnline.inviteUrl })
          }, storedOnline);
        }
        return;
      } catch {
        if (
          storedOnline.participantId &&
          storedOnline.rejoinToken
        ) {
          try {
            const admission = await onlineTransport.rejoin(
              storedOnline.roomId,
              {
                participantId: storedOnline.participantId,
                rejoinToken: storedOnline.rejoinToken,
                requestId: `browser-${globalThis.crypto.randomUUID()}`
              }
            );
            if (admission.snapshot && admission.room.matchId) {
              showOnlineBattle(
                admission.snapshot,
                admissionCredential(admission, storedOnline)
              );
            } else {
              showOnlineLobby(admission, storedOnline);
            }
            return;
          } catch {
            storage.removeItem(ONLINE_ADMISSION_STORAGE_KEY);
          }
        } else {
          storage.removeItem(ONLINE_ADMISSION_STORAGE_KEY);
        }
        if (invitedRoomId) {
          showStart("オンラインセッションの期限が切れました。招待URLから再参加してください。");
          return;
        }
      }
    }
    const stored = parseStoredLocalActor(
      storage.getItem(LOCAL_ACTOR_STORAGE_KEY)
    );
    if (!stored) {
      showStart();
      return;
    }
    root.innerHTML = '<p class="boot-message">試合を復元しています…</p>';
    try {
      const snapshot = await transport.restoreMatch(stored);
      showBattle(snapshot, stored);
    } catch (error) {
      showStart(
        error instanceof Error && error.name === "MatchNotFoundError"
          ? "保存された試合は終了または削除されています。"
          : "試合へ再接続できませんでした。もう一度開始してください。"
      );
    }
  };

  return {
    restore,
    showStart,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopBattle();
    }
  };
}
