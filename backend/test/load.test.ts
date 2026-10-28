import { describe, expect, it } from "bun:test";
import app from "../src/app";
import { redis } from "../src/services/redis";
import { budgetGuard } from "../src/services/budget";
import crypto from "node:crypto";

// Inference is explicitly mocked for gateway tests.
process.env.MOCK_INFERENCE = "true";

describe("AI Gateway Load & Concurrency Performance Suite (REL-QA-006)", () => {
  const liveStaker = "0x3b113D111672F8cc2e060F028EF4fF0B886dE63E";
  const testKey = "tyr_live_load_test_key_111122223333444455556666";

  it("handles 30 concurrent non-stream requests with atomic quota deduction and p95 < 3s", async () => {
    // 1. Register API key and give test wallet plenty of quota ($10)
    const keyHash = crypto.createHash("sha256").update(testKey).digest("hex");
    await redis.set(
      `tyrian:key:${keyHash}`,
      JSON.stringify({ userAddress: liveStaker, isRevoked: false }),
    );
    await redis.setQuota(liveStaker, 10.0, 0.0);
    await budgetGuard.setDailyEpochBudget(100.0);

    const concurrency = 30;
    const latencies: number[] = [];

    const requestPromises = Array.from({ length: concurrency }).map(async (_, idx) => {
      const start = Date.now();
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testKey}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          stream: false,
          messages: [{ role: "user", content: `Benchmark request #${idx}` }],
        }),
      });

      const elapsed = Date.now() - start;
      latencies.push(elapsed);
      return res;
    });

    const responses = await Promise.all(requestPromises);

    // Verify all 30 succeeded
    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    // Sort latencies to compute p50 and p95
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];

    console.log(`[Load Benchmark] 30 concurrent requests: p50=${p50}ms, p95=${p95}ms, max=${latencies[latencies.length - 1]}ms`);

    // Target SLO: p95 < 3000ms
    expect(p95).toBeLessThan(3000);

    // Verify atomic quota tracking
    const quota = await redis.getQuota(liveStaker);
    // 30 requests * $0.0005 = $0.015
    expect(quota.usedUsd).toBeGreaterThan(0.01);
  });

  it("enforces Global Budget Guard under concurrent burst (REL-QA-006 / BE-GW-011)", async () => {
    // Set daily budget cap to $0.0025 (allowing exactly ~5 requests at $0.0005 each)
    const burstKey = "tyr_live_burst_test_key_777788889999000011112222";
    const burstHash = crypto.createHash("sha256").update(burstKey).digest("hex");
    await redis.set(
      `tyrian:key:${burstHash}`,
      JSON.stringify({ userAddress: liveStaker, isRevoked: false }),
    );

    await redis.setQuota(liveStaker, 10.0, 0.0);
    await budgetGuard.setDailyEpochBudget(0.0025);

    // Reset today's spend
    const dateStr = new Date().toISOString().split("T")[0];
    await redis.set(`tyrian:budget:spend:${dateStr}`, "0");

    const burstCount = 15;
    const promises = Array.from({ length: burstCount }).map(async () => {
      return app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${burstKey}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          stream: false,
          messages: [{ role: "user", content: "Burst budget test" }],
        }),
      });
    });

    const responses = await Promise.all(promises);
    const statuses = responses.map((r) => r.status);

    const okCount = statuses.filter((s) => s === 200).length;
    const blockedCount = statuses.filter((s) => s === 429).length;

    console.log(`[Budget Burst] Sent: ${burstCount}, Succeeded (200): ${okCount}, Blocked (429): ${blockedCount}`);

    // Budget allowed around 5 requests, remainder blocked with 429
    expect(okCount).toBeGreaterThanOrEqual(4);
    expect(okCount).toBeLessThanOrEqual(6);
    expect(blockedCount).toBeGreaterThanOrEqual(9);

    // Clean up daily budget to high value for remaining tests
    await budgetGuard.setDailyEpochBudget(100.0);
  });
});
