import crypto from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { redis } from "./redis";

export const SESSION_COOKIE_NAME = "tyrian_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface TyrianSession {
  address: string;
  chainId?: number;
  createdAt: string;
  lastSeenAt?: string;
  userAgentHash?: string;
}

export interface SessionLookup {
  token: string;
  session: TyrianSession;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readToken(c: Context): string | null {
  const cookie = getCookie(c, SESSION_COOKIE_NAME);
  if (cookie) return cookie;

  const authorization = c.req.header("Authorization");
  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function readSession(c: Context): Promise<SessionLookup | null> {
  const token = readToken(c);
  if (!token) return null;

  const tokenHash = hashToken(token);
  const raw = await redis.get(`tyrian:session:${tokenHash}`);
  if (!raw) return null;

  try {
    const session = JSON.parse(raw) as TyrianSession;
    if (!session.address) return null;

    // Refresh lastSeenAt asynchronously
    session.lastSeenAt = new Date().toISOString();
    void redis.set(`tyrian:session:${tokenHash}`, JSON.stringify(session), SESSION_TTL_SECONDS);

    return { token, session };
  } catch {
    return null;
  }
}

export async function getAuthAddress(c: Context): Promise<string | null> {
  const lookup = await readSession(c);
  return lookup?.session.address ?? null;
}

export async function createSession(
  c: Context,
  session: TyrianSession,
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);

  const userAgent = c.req.header("User-Agent") || "";
  const userAgentHash = crypto.createHash("sha256").update(userAgent).digest("hex").slice(0, 16);

  const fullSession: TyrianSession = {
    ...session,
    address: session.address.toLowerCase(),
    lastSeenAt: new Date().toISOString(),
    userAgentHash,
  };

  await redis.set(
    `tyrian:session:${tokenHash}`,
    JSON.stringify(fullSession),
    SESSION_TTL_SECONDS,
  );

  // Maintain active sessions index per user
  const userKey = `tyrian:user_sessions:${fullSession.address}`;
  await redis.sadd(userKey, tokenHash);

  setCookie(c, SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });

  return token;
}

export async function destroySession(c: Context): Promise<void> {
  const token = readToken(c);
  if (token) {
    const tokenHash = hashToken(token);
    const raw = await redis.get(`tyrian:session:${tokenHash}`);
    if (raw) {
      try {
        const session = JSON.parse(raw) as TyrianSession;
        if (session.address) {
          await redis.srem(`tyrian:user_sessions:${session.address}`, tokenHash);
        }
      } catch {}
    }
    await redis.del(`tyrian:session:${tokenHash}`);
  }

  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
}

/**
 * Revoke all active sessions for a user (BE-AUTH-008)
 */
export async function revokeAllUserSessions(userAddress: string): Promise<number> {
  const normalized = userAddress.toLowerCase();
  const userKey = `tyrian:user_sessions:${normalized}`;
  const sessionHashes = await redis.smembers(userKey);

  let revoked = 0;
  for (const hash of sessionHashes) {
    await redis.del(`tyrian:session:${hash}`);
    revoked++;
  }

  await redis.del(userKey);
  return revoked;
}
