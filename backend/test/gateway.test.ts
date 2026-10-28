import { describe, it, expect } from "bun:test";
import app from "../src/app";
import { redis } from "../src/services/redis";
import crypto from "node:crypto";

// Inference is explicitly mocked for gateway tests; production never defaults
// to mock mode and mainnet validates this flag at boot.
process.env.MOCK_INFERENCE = "true";

describe("Tyrian Backend AI Gateway & Quota Suite", () => {
  const liveStaker = "0x3b113D111672F8cc2e060F028EF4fF0B886dE63E";
  const unstakedUser = "0x000000000000000000000000000000000000dEaD";

  it("GET /health reports service status and network info", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.status).toBe("ok");
    expect(json.service).toBe("tyrian-ai-gateway");
    expect(json.network).toBe("testnet");
    expect(json.chainId).toBe(46630);
  });

  it("GET /v1/models returns allowlisted models with live pricing and context specs (BE-GW-009)", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThanOrEqual(8);
    const claude = json.data.find((m: any) => m.id === "anthropic/claude-3.5-sonnet");
    expect(claude).toBeDefined();
    expect(claude.context_length).toBe(200000);
    expect(claude.pricing.promptTokenPriceUsd).toBe(3.0);
    expect(claude.pricing.completionTokenPriceUsd).toBe(15.0);
    expect(claude.pricing.prompt).toBe("0.00000300");
    expect(claude.top_provider.context_length).toBe(200000);
    expect(json.source).toBeDefined();
  });

  it("GET /v1/quota returns 0 for unstaked wallet (no fake default)", async () => {
    const res = await app.request(`/v1/quota?address=${unstakedUser}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.userAddress).toBe(unstakedUser.toLowerCase());
    expect(json.allocatedUsd).toBe(0);
    expect(json.remainingUsd).toBe(0);
    expect(json.isStaker).toBe(false);
  });

  it("GET /v1/quota calculates live pro-rata quota for testnet staker", async () => {
    const res = await app.request(`/v1/quota?address=${liveStaker}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.userAddress).toBe(liveStaker.toLowerCase());
    expect(json.isStaker).toBe(true);
    expect(json.totalEffectiveStakeUsd).toBeGreaterThanOrEqual(200);
    expect(json.allocatedUsd).toBeGreaterThan(0);
    expect(json.remainingUsd).toBeGreaterThan(0);
    expect(json.positions.length).toBeGreaterThan(0);
    expect(json.positions[0].asset).toBe("USDG");
  });

  it("POST /v1/chat/completions rejects unstaked wallet with 402 quota_exceeded", async () => {
    const unstakedKey = "tyr_live_unstaked_key_1234567890abcdef123456";
    const unstakedHash = crypto.createHash("sha256").update(unstakedKey).digest("hex");
    await redis.set(
      `tyrian:key:${unstakedHash}`,
      JSON.stringify({ userAddress: unstakedUser, isRevoked: false }),
    );

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${unstakedKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "Halo!" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(402);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("quota_exceeded");
  });

  it("POST /v1/chat/completions allows inference for staked wallet and deducts quota", async () => {
    const stakerKey = "tyr_live_staker_key_1234567890abcdef123456";
    const stakerHash = crypto.createHash("sha256").update(stakerKey).digest("hex");
    await redis.set(
      `tyrian:key:${stakerHash}`,
      JSON.stringify({ userAddress: liveStaker, isRevoked: false }),
    );

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stakerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "Halo Tyrian!" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.has("X-Tyrian-Quota-Remaining")).toBe(true);
    const rem = parseFloat(res.headers.get("X-Tyrian-Quota-Remaining") || "0");
    expect(rem).toBeGreaterThan(0);
  });

  it("POST /api/epoch/run executes epoch settlement and redistributes quotas", async () => {
    const res = await app.request("/api/epoch/run", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.summary.walletsProcessed).toBeGreaterThanOrEqual(1);
    expect(json.summary.budgets.totalBudgetUsd).toBeGreaterThanOrEqual(0);
  });

  it("GET /v1/budget/status reports global protocol spend and alert status (BE-GW-011)", async () => {
    const res = await app.request("/v1/budget/status");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.todaySpendUsd).toBeDefined();
    expect(json.dailyBudgetUsd).toBeGreaterThan(0);
    expect(json.alertThreshold).toBe(0.8);
    expect(["normal", "alert", "exhausted"]).toContain(json.status);
  });

  it("POST /v1/chat/completions enforces Global Budget Guard when capacity is exhausted (BE-GW-011)", async () => {
    const stakerKey = "tyr_live_staker_key_1234567890abcdef123456";
    const { budgetGuard } = await import("../src/services/budget");
    
    // Simulate budget cap 0.0001 and high spend
    await budgetGuard.setDailyEpochBudget(0.0001);
    await budgetGuard.recordSpend(1.0);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stakerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "Halo!" }],
      }),
    });

    expect(res.status).toBe(429);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("global_budget_exhausted");

    // Reset budget back to normal
    await budgetGuard.setDailyEpochBudget(100.0);
    const todayStr = new Date().toISOString().split("T")[0];
    await redis.set(`tyrian:budget:spend:${todayStr}`, "0.0");
  });
});
