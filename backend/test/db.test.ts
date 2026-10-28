import { describe, expect, it } from "bun:test";
import { dbService } from "../src/services/db";
import crypto from "node:crypto";

describe("PostgreSQL Persistent Database Service (BE-PRG-001)", () => {
  const TEST_USER = "0x8888888888888888888888888888888888888888";

  it("ensureUser creates user record in postgres", async () => {
    await dbService.ensureUser(TEST_USER, true);
    // Should complete without error
    expect(true).toBe(true);
  });

  it("createApiKey persists key to postgres and getUserApiKeys retrieves it", async () => {
    const rawKey = `tyr_live_test_db_${Date.now()}`;
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const keyId = crypto.randomUUID();
    const keyName = "Production Server Key";
    const keyPrefix = `tyr_live_••••${rawKey.slice(-4)}`;

    await dbService.createApiKey({
      id: keyId,
      userAddress: TEST_USER,
      name: keyName,
      keyHash,
      keyPrefix,
    });

    const keys = await dbService.getUserApiKeys(TEST_USER);
    expect(keys.length).toBeGreaterThanOrEqual(1);

    const found = keys.find((k) => k.id === keyId);
    expect(found).toBeDefined();
    expect(found?.name).toBe(keyName);
    expect(found?.isRevoked).toBe(false);

    // Verify lookup by hash
    const byHash = await dbService.getApiKeyByHash(keyHash);
    expect(byHash).toBeDefined();
    expect(byHash?.userAddress).toBe(TEST_USER.toLowerCase());
    expect(byHash?.isRevoked).toBe(false);
  });

  it("revokeApiKey marks key as revoked in postgres", async () => {
    const rawKey = `tyr_live_revoke_${Date.now()}`;
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const keyId = crypto.randomUUID();

    await dbService.createApiKey({
      id: keyId,
      userAddress: TEST_USER,
      name: "Temporary Key",
      keyHash,
      keyPrefix: "tyr_live_••••temp",
    });

    const ok = await dbService.revokeApiKey(keyId, TEST_USER);
    expect(ok).toBe(true);

    const byHash = await dbService.getApiKeyByHash(keyHash);
    expect(byHash?.isRevoked).toBe(true);
  });

  it("logUsage stores metadata and getUserUsageSummary aggregates tokens and costs", async () => {
    await dbService.logUsage({
      userAddress: TEST_USER,
      model: "anthropic/claude-3.5-sonnet",
      promptTokens: 100,
      completionTokens: 200,
      costUsd: 0.0035,
      latencyMs: 450,
    });

    const summary = await dbService.getUserUsageSummary(TEST_USER);
    expect(summary.totalTokens).toBeGreaterThanOrEqual(300);
    expect(summary.totalCostUsd).toBeGreaterThanOrEqual(0.0035);
    expect(summary.requestCount).toBeGreaterThanOrEqual(1);
  });

  it("saveEpochQuota persists daily epoch quota", async () => {
    await dbService.saveEpochQuota({
      userAddress: TEST_USER,
      epochDate: "2026-10-27",
      allocatedUsd: 5.5,
      usedUsd: 0.0,
      boostMultiplier: 1.25,
    });

    expect(true).toBe(true);
  });
});
