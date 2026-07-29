import assert from "node:assert/strict";
import test from "node:test";

import { GameCommandApi } from "../packages/server/src/command-api.ts";
import {
  OnlineRoomError,
  OnlineRoomService
} from "../packages/server/src/online-room.ts";
import { OnlineSessionStore } from "../packages/server/src/online-session.ts";
import { RealtimeMatchHub } from "../packages/server/src/realtime.ts";
import { RuntimeMatchService } from "../packages/server/src/runtime-match.ts";

function services(
  clock: () => string,
  randomOverride?: (size: number) => Uint8Array
): {
  rooms: OnlineRoomService;
  matches: RuntimeMatchService;
  sessions: OnlineSessionStore;
} {
  let randomCounter = 0;
  const fallbackRandom = (size: number): Uint8Array => {
    randomCounter += 1;
    return Uint8Array.from(
      { length: size },
      (_, index) => (randomCounter * 31 + index) % 256
    );
  };
  const random = randomOverride ?? fallbackRandom;
  const matches = new RuntimeMatchService({
    commandApi: new GameCommandApi(clock),
    realtimeHub: new RealtimeMatchHub({ clock }),
    clock,
    random
  });
  const sessions = new OnlineSessionStore({
    clock,
    random,
    secret: "session-secret-".padEnd(32, "s")
  });
  return {
    matches,
    sessions,
    rooms: new OnlineRoomService({
      matchService: matches,
      sessions,
      clock,
      random,
      secret: "room-secret-".padEnd(32, "r"),
      hostDisconnectGraceMs: 1_000,
      roomTtlMs: 10_000,
      roomRetentionMs: 10_000
    })
  };
}

test("T-055 host invitation, guest readiness, atomic start, and spectator admission", () => {
  const now = "2026-07-26T00:00:00.000Z";
  const { rooms, matches } = services(() => now);
  const created = rooms.create({
    displayName: "Host",
    seatCount: 3,
    allowSpectators: true,
    requestId: "create-request"
  });
  const duplicate = rooms.create({
    displayName: "Host",
    seatCount: 3,
    allowSpectators: true,
    requestId: "create-request"
  });
  assert.equal(duplicate.room.roomId, created.room.roomId);
  assert.equal(duplicate.inviteCode, created.inviteCode);

  const joined = rooms.join(created.room.roomId, {
    displayName: "Guest",
    inviteCode: created.inviteCode,
    requestId: "join-request-1"
  });
  rooms.setSeatController(
    created.session.session,
    2,
    "CPU"
  );
  rooms.setReady(created.session.session, true);
  const readyRoom = rooms.setReady(joined.session.session, true);
  assert.equal(readyRoom.canStart, true);

  const started = rooms.start(
    created.session.session,
    "start-request"
  );
  const repeatedStart = rooms.start(
    created.session.session,
    "start-request"
  );
  assert.equal(repeatedStart.matchId, started.matchId);
  assert.equal(started.room.status, "STARTED");
  assert.equal(started.snapshot.self?.playerId !== null, true);
  assert.equal(
    rooms.authorizeMatch(joined.session.session)?.viewer.kind,
    "PLAYER"
  );
  assert.throws(
    () =>
      rooms.join(created.room.roomId, {
        displayName: "Late",
        inviteCode: created.inviteCode
      }),
    (error: unknown) =>
      error instanceof OnlineRoomError &&
      error.code === "ROOM_STARTED"
  );

  const spectator = rooms.spectate(
    created.room.roomId,
    created.inviteCode
  );
  assert.equal(spectator.snapshot?.self, null);
  assert.deepEqual(
    rooms.authorizeMatch(spectator.session.session)?.viewer,
    { kind: "SPECTATOR" }
  );
  matches.close();
});

test("T-055 rejoin revokes old sessions and host disconnect transfers or expires rooms", () => {
  let now = "2026-07-26T00:00:00.000Z";
  const { rooms, matches, sessions } = services(() => now);
  const created = rooms.create({
    displayName: "Host",
    seatCount: 2,
    requestId: "create-transfer"
  });
  const guest = rooms.join(created.room.roomId, {
    displayName: "Guest",
    inviteCode: created.inviteCode,
    requestId: "join-transfer"
  });
  const oldGuestCookie = guest.session.cookie.split(";")[0];
  const rejoined = rooms.rejoin(created.room.roomId, {
    participantId: guest.participantId ?? "",
    rejoinToken: guest.rejoinToken ?? "",
    requestId: "rejoin-transfer"
  });
  assert.equal(sessions.authenticateCookieHeader(oldGuestCookie), null);
  assert.equal(rejoined.participantId, guest.participantId);

  rooms.setConnected(created.session.session, false);
  now = "2026-07-26T00:00:01.000Z";
  const sweep = rooms.sweep();
  assert.equal(sweep.transferred, 1);
  assert.equal(
    rooms.view(rejoined.session.session).seats
      .find(({ participantId }) => participantId === guest.participantId)
      ?.isHost,
    true
  );

  rooms.leave(rejoined.session.session);
  rooms.leave(created.session.session);
  assert.throws(
    () => rooms.view(created.session.session),
    /expired|session/iu
  );
  matches.close();
});

test("T-055 Japanese passphrases find the same hidden-brawl room without storing plaintext", () => {
  const now = "2026-07-26T00:00:00.000Z";
  const { rooms, matches } = services(() => now);
  const created = rooms.create({
    displayName: "部屋主",
    passphrase: " ひみつの花園１２３ ",
    seatCount: 3,
    requestId: "create-passphrase-room"
  });

  assert.equal(created.room.accessMode, "PASSPHRASE");
  const joined = rooms.joinByPassphrase({
    displayName: "参加者",
    passphrase: "ひみつの花園123",
    requestId: "join-passphrase-room"
  });
  assert.equal(joined.room.roomId, created.room.roomId);
  assert.equal(joined.room.seats[1]?.displayName, "参加者");
  const hostTeamRoom = rooms.setTeam(
    created.session.session,
    "TEAM_1"
  );
  const teamRoom = rooms.setTeam(joined.session.session, "TEAM_2");
  assert.equal(hostTeamRoom.seats[0]?.teamId, "TEAM_1");
  assert.equal(teamRoom.seats[1]?.teamId, "TEAM_2");
  assert.equal(teamRoom.canStart, true);
  const endTimeRoom = rooms.setEndTimeThreshold(
    created.session.session,
    150
  );
  assert.equal(endTimeRoom.endTimeThreshold, 150);

  assert.throws(
    () => rooms.create({
      displayName: "別の部屋主",
      passphrase: "ひみつの花園123",
      seatCount: 2,
      requestId: "duplicate-passphrase-room"
    }),
    (error: unknown) =>
      error instanceof OnlineRoomError &&
      error.code === "PASSPHRASE_IN_USE"
  );
  const newlyCreated = rooms.joinByPassphrase({
    displayName: "新しい部屋主",
    passphrase: "ちがう合言葉",
    requestId: "new-passphrase-room"
  });
  assert.notEqual(newlyCreated.room.roomId, created.room.roomId);
  assert.equal(newlyCreated.room.seatCount, 9);
  assert.equal(newlyCreated.room.endTimeThreshold, 100);
  assert.equal(newlyCreated.room.seats[0]?.isHost, true);

  const started = rooms.start(
    created.session.session,
    "start-passphrase-room"
  );
  assert.equal(
    started.snapshot.players.find(
      ({ displayName }) => displayName === "部屋主"
    )?.teamId,
    "TEAM_1"
  );
  assert.equal(
    started.snapshot.players.find(
      ({ displayName }) => displayName === "参加者"
    )?.teamId,
    "TEAM_2"
  );

  const persisted = JSON.stringify(rooms.exportState());
  assert.equal(persisted.includes("ひみつの花園"), false);
  assert.equal(persisted.includes("ちがう合言葉"), false);
  matches.close();
});

test("T-055 leaving hidden-brawl host transfers controls to a random connected participant", () => {
  const now = "2026-07-26T00:00:00.000Z";
  let randomCall = 0;
  const random = (size: number): Uint8Array => {
    randomCall += 1;
    return Uint8Array.from(
      { length: size },
      (_, index) => size === 1 ? 1 : (randomCall * 17 + index) % 256
    );
  };
  const { rooms, matches } = services(() => now, random);
  const host = rooms.joinByPassphrase({
    displayName: "最初の参加者",
    passphrase: "ランダム移譲",
    requestId: "random-host-create"
  });
  const firstGuest = rooms.joinByPassphrase({
    displayName: "候補1",
    passphrase: "ランダム移譲",
    requestId: "random-host-guest-1"
  });
  const secondGuest = rooms.joinByPassphrase({
    displayName: "候補2",
    passphrase: "ランダム移譲",
    requestId: "random-host-guest-2"
  });

  assert.equal(host.room.seats[0]?.isHost, true);
  const transferred = rooms.leave(host.session.session);
  assert.ok(transferred);
  assert.equal(
    transferred.seats.find(
      ({ participantId }) => participantId === secondGuest.participantId
    )?.isHost,
    true
  );
  assert.equal(
    transferred.seats.find(
      ({ participantId }) => participantId === firstGuest.participantId
    )?.isHost,
    false
  );
  assert.doesNotThrow(() =>
    rooms.shuffleTeams(secondGuest.session.session)
  );
  assert.throws(
    () => rooms.shuffleTeams(firstGuest.session.session),
    (error: unknown) =>
      error instanceof OnlineRoomError &&
      error.code === "HOST_REQUIRED"
  );
  matches.close();
});

test("T-055 hidden-brawl host can toggle list entry while retaining host controls", () => {
  const now = "2026-07-26T00:00:00.000Z";
  const { rooms, matches } = services(() => now);
  const host = rooms.joinByPassphrase({
    displayName: "主催者",
    passphrase: "出入り自由",
    requestId: "entry-host"
  });
  const firstGuest = rooms.joinByPassphrase({
    displayName: "参加者1",
    passphrase: "出入り自由",
    requestId: "entry-guest-1"
  });
  const secondGuest = rooms.joinByPassphrase({
    displayName: "参加者2",
    passphrase: "出入り自由",
    requestId: "entry-guest-2"
  });

  const exited = rooms.setEntry(host.session.session, false);
  assert.equal(exited.hostParticipantId, host.participantId);
  assert.equal(
    exited.seats.some(
      ({ participantId }) => participantId === host.participantId
    ),
    false
  );
  assert.equal(exited.canStart, true);
  assert.doesNotThrow(() =>
    rooms.shuffleTeams(host.session.session)
  );

  const reentered = rooms.setEntry(host.session.session, true);
  assert.equal(
    reentered.seats.find(
      ({ participantId }) => participantId === host.participantId
    )?.teamId,
    null
  );
  const exitedAgain = rooms.setEntry(host.session.session, false);
  assert.equal(exitedAgain.canStart, true);

  const started = rooms.start(
    host.session.session,
    "host-observer-start"
  );
  assert.equal(started.snapshot.self, null);
  assert.equal(
    started.snapshot.players.some(
      ({ displayName }) => displayName === "主催者"
    ),
    false
  );
  assert.deepEqual(
    new Set(started.snapshot.players.map(({ displayName }) => displayName)),
    new Set(["参加者1", "参加者2"])
  );
  assert.deepEqual(
    rooms.authorizeMatch(host.session.session)?.viewer,
    { kind: "SPECTATOR" }
  );
  assert.equal(
    rooms.authorizeMatch(firstGuest.session.session)?.viewer.kind,
    "PLAYER"
  );
  assert.equal(
    rooms.authorizeMatch(secondGuest.session.session)?.viewer.kind,
    "PLAYER"
  );
  matches.close();
});
