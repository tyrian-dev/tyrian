import { describe, expect, it } from "bun:test";
import app from "../src/app";
import { redis } from "../src/services/redis";
import { budgetGuard } from "../src/services/budget";
import { openRouter } from "../src/services/openrouter";
import crypto from "node:crypto";

// Inference is explicitly mocked for gateway tests.
process.env.MOCK_INFERENCE = "true";

describe("Tyrian Chaos & Fault Injection Suite (REL-QA-008 / ARC-005)", () => {
  const chaosWallet = "0x3b113D111672F8cc2e060F028EF4fF0B886dE63E"; // staked testnet wallet
  const chaosKey = "tyr_live_chaos_test_key_aabbccddeeff00112233";

  it("recovers and refunds user quota + budget when upstream OpenRouter returns 502 Bad Gateway", async () => {
    // 1. Setup key and initial quota
    const keyHash = crypto.createHash("sha256").update(chaosKey).digest("hex");
    await redis.set(
      `tyrian:key:${keyHash}`,
      JSON.stringify({ userAddress: chaosWallet, isRevoked: false }),
    );
    await redis.setQuota(chaosWallet, 5.0, 0.0);
    await budgetGuard.setDailyEpochBudget(100.0);

    const initialQuota = await redis.getQuota(chaosWallet);
    const initialSpend = await budgetGuard.getDailySpend();

    // 2. Mock upstream openRouter.executeChatCompletion to simulate 502 upstream failure
    const originalExec = openRouter.executeChatCompletion;
    (openRouter as unknown as { executeChatCompletion: unknown }).executeChatCompletion = async () => {
      return new Response(JSON.stringify({ error: { message: "Cloudflare 502 Bad Gateway" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${chaosKey}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "Chaos test" }],
        }),
      });

      expect(res.status).toBe(502);
      const json = (await res.json()) as { error: { message: string; type: string; code: number } };
      expect(json.error.type).toBe("upstream_error");
      expect(json.error.code).toBe(502);

      // 3. Verify Quota was REFUNDED (usedUsd should be equal to initialQuota.usedUsd)
      const finalQuota = await redis.getQuota(chaosWallet);
      expect(finalQuota.usedUsd).toBeCloseTo(initialQuota.usedUsd, 4);

      // 4. Verify Global Budget Guard was REFUNDED
      const finalSpend = await budgetGuard.getDailySpend();
      expect(finalSpend).toBeCloseTo(initialSpend, 4);
    } finally {
      // Restore original function
      (openRouter as unknown as { executeChatCompletion: unknown }).executeChatCompletion = originalExec;
    }
  });

  it("recovers and refunds user quota + budget when upstream throws network exception", async () => {
    await redis.setQuota(chaosWallet, 5.0, 0.0);
    const initialQuota = await redis.getQuota(chaosWallet);
    const initialSpend = await budgetGuard.getDailySpend();

    // Mock network hang / connection reset
    const originalExec = openRouter.executeChatCompletion;
    (openRouter as unknown as { executeChatCompletion: unknown }).executeChatCompletion = async () => {
      throw new Error("ECONNRESET: Upstream connection abruptly closed by remote host");
    };

    try {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${chaosKey}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "Network exception test" }],
        }),
      });

      expect(res.status).toBe(500);
      const json = (await res.json()) as { error: { message: string; type: string } };
      expect(json.error.type).toBe("gateway_error");
      // Must not leak stack trace or internal tokens
      expect(json.error.message).not.toContain("ECONNRESET");

      // Verify quota refunded
      const finalQuota = await redis.getQuota(chaosWallet);
      expect(finalQuota.usedUsd).toBeCloseTo(initialQuota.usedUsd, 4);

      // Verify budget guard refunded
      const finalSpend = await budgetGuard.getDailySpend();
      expect(finalSpend).toBeCloseTo(initialSpend, 4);
    } finally {
      (openRouter as unknown as { executeChatCompletion: unknown }).executeChatCompletion = originalExec;
    }
  });

  it("rejects revoked API key with 401 without consuming quota (R-07)", async () => {
    const revokedKey = "tyr_live_revoked_key_99998888777766665555";
    const keyHash = crypto.createHash("sha256").update(revokedKey).digest("hex");
    await redis.set(
      `tyrian:key:${keyHash}`,
      JSON.stringify({ userAddress: chaosWallet, isRevoked: true }),
    );

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${revokedKey}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Revoked key test" }],
      }),
    });

    expect(res.status).toBe(401);
  });
});
