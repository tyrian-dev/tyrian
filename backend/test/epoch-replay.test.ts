import { describe, it, expect, beforeEach } from "bun:test";
import { runDailyEpochJob } from "../src/cron/epoch";
import { redis } from "../src/services/redis";
import { dbService } from "../src/services/db";

describe("Tyrian Idempotent Epoch Replay & Distributed Lock Suite (BE-EPOCH-009)", () => {
  const testEpochDate = "2026-10-28";
  const dummyPositions = [
    {
      userAddress: "0x1111111111111111111111111111111111111111",
      asset: "PORTFOLIO",
      usdValue: 1000,
      tyrStakedAmount: 500,
    },
    {
      userAddress: "0x2222222222222222222222222222222222222222",
      asset: "PORTFOLIO",
      usdValue: 2000,
      tyrStakedAmount: 0,
    },
  ];

  beforeEach(async () => {
    await redis.releaseLock(`tyrian:lock:epoch:${testEpochDate}`);
  });

  it("executes the first epoch distribution normally", async () => {
    const res = await runDailyEpochJob({
      epochDate: testEpochDate,
      harvestedYieldUsd: 100,
      creatorFeesUsd: 50,
      positions: dummyPositions,
      tyrPriceUsd: 0.05,
      force: true, // force reset for clean test run
    });

    expect(res.skipped).toBeFalsy();
    expect(res.walletsProcessed).toBe(2);
    expect(res.totalDistributedQuotaUsd).toBeGreaterThan(0);
  });

  it("skips duplicate epoch run idempotently for the same date", async () => {
    // Attempt second run on the exact same date
    const duplicate = await runDailyEpochJob({
      epochDate: testEpochDate,
      harvestedYieldUsd: 100,
      creatorFeesUsd: 50,
      positions: dummyPositions,
    });

    expect(duplicate.skipped).toBe(true);
    expect(duplicate.reason).toContain("already completed");
  });

  it("allows forced re-run when explicit force flag is provided", async () => {
    const rerun = await runDailyEpochJob({
      epochDate: testEpochDate,
      harvestedYieldUsd: 200,
      creatorFeesUsd: 50,
      positions: dummyPositions,
      tyrPriceUsd: 0.05,
      force: true,
    });

    expect(rerun.skipped).toBeFalsy();
    expect(rerun.walletsProcessed).toBe(2);
  });

  it("skips execution if distributed lock is held by another worker", async () => {
    const lockedDate = "2026-10-29";
    // Simulate concurrent instance holding lock
    const acquired = await redis.acquireLock(`tyrian:lock:epoch:${lockedDate}`, 120);
    expect(acquired).toBe(true);

    const concurrentRun = await runDailyEpochJob({
      epochDate: lockedDate,
      harvestedYieldUsd: 50,
      positions: dummyPositions,
    });

    expect(concurrentRun.skipped).toBe(true);
    expect(concurrentRun.reason).toContain("Lock active");

    await redis.releaseLock(`tyrian:lock:epoch:${lockedDate}`);
  });
});
