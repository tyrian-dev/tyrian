import { describe, it, expect, beforeEach } from "bun:test";
import app from "../src/app";
import { redis } from "../src/services/redis";
import { createSession } from "../src/services/session";
import type { Context } from "hono";

describe("Tyrian Backend Auth & Session Security Suite (BE-AUTH)", () => {
  const testAddress = "0x1234567890123456789012345678901234567890";

  it("GET /api/auth/nonce issues random hex nonce", async () => {
    const res = await app.request("/api/auth/nonce");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { nonce: string };
    expect(json.nonce).toBeDefined();
    expect(json.nonce.length).toBe(32);

    // Verify it is cached in Redis
    const cached = await redis.get(`tyrian:nonce:${json.nonce}`);
    expect(cached).toBe("valid");
  });

  it("Atomic consume prevents nonce replay (BE-AUTH-002)", async () => {
    const res = await app.request("/api/auth/nonce");
    const { nonce } = (await res.json()) as { nonce: string };

    const firstConsume = await redis.consume(`tyrian:nonce:${nonce}`);
    expect(firstConsume).toBe("valid");

    // Replay attempt fails atomically
    const secondConsume = await redis.consume(`tyrian:nonce:${nonce}`);
    expect(secondConsume).toBeNull();
  });

  it("POST /api/auth/verify rejects cross-origin attacker (BE-AUTH-004)", async () => {
    const res = await app.request("/api/auth/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil-attacker.xyz",
      },
      body: JSON.stringify({ message: "test", signature: "0x123" }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Origin mismatch");
  });

  it("POST /api/auth/verify rejects missing fields", async () => {
    const res = await app.request("/api/auth/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("GET /api/auth/me returns authenticated=false when no session cookie", async () => {
    const res = await app.request("/api/auth/me");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { authenticated: boolean; address: string | null };
    expect(json.authenticated).toBe(false);
    expect(json.address).toBeNull();
  });

  it("DELETE /api/auth/sessions revokes all user sessions (BE-AUTH-008)", async () => {
    // Fabricate a session
    const mockContext = {
      req: { header: () => "" },
      header: () => {},
    } as unknown as Context;

    const token = await createSession(mockContext, {
      address: testAddress,
      chainId: 46630,
      createdAt: new Date().toISOString(),
    });

    expect(token).toBeDefined();

    // Verify session works via Authorization Bearer
    const meRes = await app.request("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(meRes.status).toBe(200);
    const meJson = (await meRes.json()) as { authenticated: boolean; address: string };
    expect(meJson.authenticated).toBe(true);
    expect(meJson.address).toBe(testAddress.toLowerCase());

    // Revoke all sessions
    const revokeRes = await app.request("/api/auth/sessions", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "http://localhost:3000",
      },
    });

    expect(revokeRes.status).toBe(200);
    const revokeJson = (await revokeRes.json()) as { success: boolean; revokedCount: number };
    expect(revokeJson.success).toBe(true);
    expect(revokeJson.revokedCount).toBeGreaterThanOrEqual(1);

    // After revocation, session is dead
    const afterRes = await app.request("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const afterJson = (await afterRes.json()) as { authenticated: boolean };
    expect(afterJson.authenticated).toBe(false);
  });

  it("GET & POST /api/auth/terms handles ToS acceptance flow (BE-AUTH-006)", async () => {
    const mockContext = {
      req: { header: () => "" },
      header: () => {},
    } as unknown as Context;

    const token = await createSession(mockContext, {
      address: testAddress,
      chainId: 46630,
      createdAt: new Date().toISOString(),
    });

    const statusRes = await app.request("/api/auth/terms/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as { tosVersion: string; required: boolean };
    expect(statusJson.tosVersion).toBe("2026-10");
    expect(statusJson.required).toBe(true);

    const acceptRes = await app.request("/api/auth/terms/accept", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "http://localhost:3000",
      },
    });
    expect(acceptRes.status).toBe(200);
    const acceptJson = (await acceptRes.json()) as { success: boolean; tosSigned: boolean };
    expect(acceptJson.success).toBe(true);
    expect(acceptJson.tosSigned).toBe(true);

    const postStatusRes = await app.request("/api/auth/terms/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(postStatusRes.status).toBe(200);
    const postStatusJson = (await postStatusRes.json()) as { accepted: boolean };
    expect(postStatusJson.accepted).toBe(true);
  });
});
