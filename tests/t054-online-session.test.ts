import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import {
  OnlineSessionError,
  OnlineSessionStore
} from "../packages/server/src/online-session.ts";

function request(
  cookie: string,
  csrfToken: string,
  origin = "https://goodfield.example"
): IncomingMessage {
  return {
    headers: {
      cookie,
      host: "goodfield.example",
      origin,
      "x-forwarded-proto": "https",
      "x-goodfield-csrf": csrfToken
    },
    socket: {}
  } as unknown as IncomingMessage;
}

test("T-054 sessions use scoped HttpOnly cookies, CSRF, origin, rotation, and revocation", () => {
  let now = "2026-07-26T00:00:00.000Z";
  const sessions = new OnlineSessionStore({
    clock: () => now,
    secret: "s".repeat(32),
    secureCookies: true,
    allowedOrigins: ["https://goodfield.example"],
    ttlMs: 60_000
  });
  const issued = sessions.issue({
    role: "HOST",
    roomId: "room_1234567890123456",
    participantId: "participant_1234567890123456"
  });
  const cookie = issued.cookie.split(";")[0] ?? "";

  assert.match(issued.cookie, /^__Host-goodfield_session=/u);
  assert.match(issued.cookie, /; Path=\/; HttpOnly; SameSite=Strict;/u);
  assert.match(issued.cookie, /; Secure$/u);
  assert.equal(issued.cookie.includes(issued.csrfToken), false);
  assert.equal(
    sessions.requireRequest(request(cookie, issued.csrfToken), {
      origin: true,
      csrf: true,
      roles: ["HOST"]
    }).roomId,
    "room_1234567890123456"
  );
  assert.throws(
    () =>
      sessions.requireRequest(request(cookie, "wrong-csrf"), {
        origin: true,
        csrf: true
      }),
    (error: unknown) =>
      error instanceof OnlineSessionError &&
      error.code === "CSRF_REJECTED"
  );
  assert.throws(
    () =>
      sessions.requireRequest(
        request(cookie, issued.csrfToken, "https://evil.example"),
        { origin: true }
      ),
    (error: unknown) =>
      error instanceof OnlineSessionError &&
      error.code === "ORIGIN_REJECTED"
  );

  const rotated = sessions.rotate(cookie);
  assert.equal(sessions.authenticateCookieHeader(cookie), null);
  const rotatedCookie = rotated.cookie.split(";")[0];
  assert.ok(rotatedCookie);
  assert.ok(sessions.authenticateCookieHeader(rotatedCookie));
  assert.equal(sessions.revoke(rotated.session.sessionId), true);
  assert.equal(sessions.authenticateCookieHeader(rotatedCookie), null);

  const expiring = sessions.issue({
    role: "SPECTATOR",
    roomId: "room_1234567890123456",
    participantId: null
  });
  now = "2026-07-26T00:01:00.000Z";
  assert.equal(
    sessions.authenticateCookieHeader(expiring.cookie.split(";")[0]),
    null
  );
  assert.throws(
    () =>
      sessions.requireRequest(
        request(
          expiring.cookie.split(";")[0] ?? "",
          expiring.csrfToken
        )
      ),
    (error: unknown) =>
      error instanceof OnlineSessionError &&
      error.code === "SESSION_EXPIRED"
  );
});
