import { Hono } from "hono";
import { verifyMessage } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import crypto from "node:crypto";
import { redis } from "../services/redis";
import {
  createSession,
  destroySession,
  readSession,
  revokeAllUserSessions,
} from "../services/session";
import { getSiweDomain, isAllowedSiweChainId } from "../config/network";
import { csrfProtection, rateLimiter } from "../middleware/security";
import { geoGate, extractCountry } from "../middleware/geo";
import { dbService } from "../services/db";

export const authRouter = new Hono();

const NONCE_TTL_SECONDS = 5 * 60;
const MAX_MESSAGE_AGE_SECONDS = 10 * 60;

/**
 * 1. GET /api/auth/nonce (BE-AUTH-002 / BE-AUTH-005)
 * Generates a single-use SIWE nonce, rate-limited to 10 req/min/IP.
 */
authRouter.get(
  "/nonce",
  rateLimiter({ keyPrefix: "nonce", limit: 10, windowSeconds: 60 }),
  async (c) => {
    const nonce = crypto.randomBytes(16).toString("hex");
    await redis.set(`tyrian:nonce:${nonce}`, "valid", NONCE_TTL_SECONDS);
    return c.json({ nonce });
  },
);

/**
 * 2. POST /api/auth/verify (SIWE EIP-4361 - BE-AUTH-001, BE-AUTH-002, BE-AUTH-004, BE-AUTH-005, BE-AUTH-007, BE-AUTH-009)
 * Verifies SIWE message, enforces geo-fencing, domain/chain, single-use nonce, CSRF check, and audit logging.
 */
authRouter.post(
  "/verify",
  geoGate,
  rateLimiter({ keyPrefix: "verify", limit: 5, windowSeconds: 60 }),
  csrfProtection,
  async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        message?: string;
        signature?: `0x${string}`;
        address?: `0x${string}`;
      };

      if (!body.message || !body.signature) {
        return c.json({ error: "Missing message or signature." }, 400);
      }

      const parsed = parseSiweMessage(body.message);

      if (
        !parsed.address ||
        !parsed.nonce ||
        !parsed.domain ||
        !parsed.chainId ||
        !parsed.uri ||
        !parsed.issuedAt
      ) {
        return c.json({ error: "Invalid SIWE message." }, 400);
      }

      if (
        body.address &&
        parsed.address.toLowerCase() !== body.address.toLowerCase()
      ) {
        return c.json({ error: "Signed address does not match." }, 401);
      }

      const expectedDomain = getSiweDomain();
      const now = new Date();

      if (!isAllowedSiweChainId(parsed.chainId)) {
        return c.json({ error: "Unsupported chain in SIWE message." }, 401);
      }

      const ageSeconds = (now.getTime() - parsed.issuedAt.getTime()) / 1000;
      if (ageSeconds < -60 || ageSeconds > MAX_MESSAGE_AGE_SECONDS) {
        return c.json({ error: "SIWE message is expired or not yet valid." }, 401);
      }

      const validMessage = validateSiweMessage({
        message: parsed,
        nonce: parsed.nonce,
        address: parsed.address,
        ...(expectedDomain ? { domain: expectedDomain } : {}),
        time: now,
      });

      if (!validMessage) {
        return c.json({ error: "SIWE message validation failed." }, 401);
      }

      const isValid = await verifyMessage({
        address: parsed.address,
        message: body.message,
        signature: body.signature,
      });

      if (!isValid) {
        return c.json({ error: "Invalid signature." }, 401);
      }

      // Consume nonce atomically (single-use replay prevention)
      const nonceValue = await redis.consume(`tyrian:nonce:${parsed.nonce}`);
      if (!nonceValue) {
        return c.json({ error: "Nonce expired or already used." }, 401);
      }

      const session = {
        address: parsed.address.toLowerCase(),
        chainId: parsed.chainId,
        createdAt: now.toISOString(),
      };

      await createSession(c, session);

      // Ensure user record in persistent storage
      void dbService.ensureUser(session.address);

      // Persistent audit logging (BE-AUTH-009)
      const ipCountry = extractCountry(c);
      const userAgent = c.req.header("user-agent");
      void dbService.logAudit({
        userAddress: session.address,
        action: "AUTH_VERIFY",
        ipCountry,
        userAgent,
        metadata: { chainId: session.chainId },
      });

      return c.json({
        success: true,
        address: session.address,
        chainId: session.chainId,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Verification failed.", details: errorMsg }, 500);
    }
  },
);

/**
 * 3. GET /api/auth/me
 */
authRouter.get("/me", async (c) => {
  const lookup = await readSession(c);
  if (!lookup) {
    return c.json({ authenticated: false, address: null });
  }

  return c.json({
    authenticated: true,
    address: lookup.session.address,
    chainId: lookup.session.chainId ?? null,
  });
});

/**
 * 4. POST /api/auth/logout (BE-AUTH-004, BE-AUTH-009)
 */
authRouter.post("/logout", csrfProtection, async (c) => {
  const lookup = await readSession(c);
  if (lookup) {
    const ipCountry = extractCountry(c);
    const userAgent = c.req.header("user-agent");
    void dbService.logAudit({
      userAddress: lookup.session.address,
      action: "AUTH_LOGOUT",
      ipCountry,
      userAgent,
    });
  }

  await destroySession(c);
  return c.json({ success: true });
});

/**
 * 5. DELETE /api/auth/sessions (BE-AUTH-008, BE-AUTH-009 - Revoke all active sessions)
 */
authRouter.delete("/sessions", csrfProtection, async (c) => {
  const lookup = await readSession(c);
  if (!lookup) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const revokedCount = await revokeAllUserSessions(lookup.session.address);
  await destroySession(c);

  const ipCountry = extractCountry(c);
  const userAgent = c.req.header("user-agent");
  void dbService.logAudit({
    userAddress: lookup.session.address,
    action: "SESSIONS_REVOKE",
    ipCountry,
    userAgent,
    metadata: { revokedCount },
  });

  return c.json({
    success: true,
    revokedCount,
    message: "All sessions have been revoked.",
  });
});

/**
 * 6. GET /api/auth/terms/status (BE-AUTH-006)
 */
authRouter.get("/terms/status", async (c) => {
  const lookup = await readSession(c);
  let accepted = false;
  if (lookup) {
    const user = await dbService.getUser(lookup.session.address);
    accepted = Boolean(user?.tosSignedAt);
  }
  return c.json({
    tosVersion: "2026-10",
    required: true,
    authenticated: Boolean(lookup),
    userAddress: lookup?.session.address ?? null,
    accepted,
  });
});

/**
 * 7. POST /api/auth/terms/accept (BE-AUTH-006, BE-AUTH-007, BE-AUTH-009)
 */
authRouter.post("/terms/accept", geoGate, csrfProtection, async (c) => {
  const lookup = await readSession(c);
  if (!lookup) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await dbService.ensureUser(lookup.session.address, true);

  const ipCountry = extractCountry(c);
  const userAgent = c.req.header("user-agent");
  void dbService.logAudit({
    userAddress: lookup.session.address,
    action: "TERMS_ACCEPT",
    ipCountry,
    userAgent,
    metadata: { tosVersion: "2026-10" },
  });

  return c.json({
    success: true,
    tosSigned: true,
    tosVersion: "2026-10",
  });
});
