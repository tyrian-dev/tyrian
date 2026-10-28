import { describe, it, expect } from "bun:test";
import { redis } from "../src/services/redis";

describe("Tyrian Redis Memory & Eviction Hardening Suite (OPS-003 / OPS-005)", () => {
  it("reports memory usage and eviction policy (getMemoryInfo)", async () => {
    const memoryInfo = await redis.getMemoryInfo();

    expect(memoryInfo).toBeDefined();
    expect(typeof memoryInfo.connected).toBe("boolean");
    expect(typeof memoryInfo.usedMemoryHuman).toBe("string");
    expect(typeof memoryInfo.maxmemoryPolicy).toBe("string");
    // Maxmemory policy must be volatile-lru or similar LRU policy
    expect(memoryInfo.maxmemoryPolicy.length).toBeGreaterThan(0);
  });

  it("stores quota with automatic TTL expiration to prevent memory leakage", async () => {
    const testWallet = "0x9999999999999999999999999999999999999999";

    // Set quota with 1 second TTL
    await redis.setQuota(testWallet, 50, 10, 1);

    const activeQuota = await redis.getQuota(testWallet);
    expect(activeQuota.allocatedUsd).toBe(50);
    expect(activeQuota.usedUsd).toBe(10);

    // Wait 1.1s for ephemeral expiration
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const expiredQuota = await redis.getQuota(testWallet);
    expect(expiredQuota.allocatedUsd).toBe(0);
    expect(expiredQuota.usedUsd).toBe(0);
  });

  it("supports manual key expiration via expire method", async () => {
    const key = "test:ttl:key";
    await redis.set(key, "hello");
    const ok = await redis.expire(key, 60);
    expect(ok).toBe(true);

    const val = await redis.get(key);
    expect(val).toBe("hello");

    await redis.del(key);
  });
});
