import { describe, expect, it } from "bun:test";
import app from "../src/app";
import { redis } from "../src/services/redis";

// Inference is explicitly mocked for gateway tests.
process.env.MOCK_INFERENCE = "true";

describe("AI Gateway Streaming & Quota Enforcement (FE-LIVE-007 / BE-GW-005)", () => {
  const STAKER_WALLET = "0x3b113D111672F8cc2e060F028EF4fF0B886dE63E";
  const UNSTAKED_WALLET = "0x000000000000000000000000000000000000dEaD";

  it("POST /v1/chat/completions with stream=true rejects unstaked wallet with 402", async () => {
    // Generate API key for unstaked wallet
    const keyData = { userAddress: UNSTAKED_WALLET.toLowerCase(), isRevoked: false };
    const rawKey = "tyr_live_test_unstaked_key_999";
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await redis.set(`tyrian:key:${hash}`, JSON.stringify(keyData));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.type).toBe("quota_exceeded");
  });

  it("POST /v1/chat/completions with stream=true returns text/event-stream for staked wallet", async () => {
    // Seed quota in Redis for staker wallet
    await redis.setQuota(STAKER_WALLET.toLowerCase(), 5.0, 0.0);

    const keyData = { userAddress: STAKER_WALLET.toLowerCase(), isRevoked: false };
    const rawKey = "tyr_live_test_staker_key_888";
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await redis.set(`tyrian:key:${hash}`, JSON.stringify(keyData));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "What is Tyrian?" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("X-Tyrian-Quota-Remaining")).toBeDefined();

    // Read stream chunks
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let text = "";
    let chunkCount = 0;

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
      chunkCount++;
    }

    expect(chunkCount).toBeGreaterThan(0);
    expect(text).toContain("data:");
    expect(text).toContain("[DONE]");
  });
});
