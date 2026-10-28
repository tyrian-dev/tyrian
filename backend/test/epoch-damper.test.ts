import { describe, it, expect, beforeEach } from "bun:test";
import { runDailyEpochJob } from "../src/cron/epoch";
import { redis } from "../src/services/redis";

describe("7-Day Budget Damper & Reserve Top-Up (GAP-007 / BUD-002 / Brief §7)", () => {
  beforeEach(async () => {
    // Release potential lock
    await redis.releaseLock("tyrian:lock:epoch:2097-01-01");
    await redis.releaseLock("tyrian:lock:epoch:2097-01-02");
    await redis.releaseLock("tyrian:lock:epoch:2097-01-03");
    await redis.releaseLock("tyrian:lock:epoch:2097-01-04");
    await redis.releaseLock("tyrian:lock:epoch:2097-01-05");
    await redis.releaseLock("tyrian:lock:epoch:2097-01-06");
  });

  it("does not apply damper when natural yield meets or exceeds 70% of 7-day rolling average", async () => {
    // 7-day history with average $100/day
    const recentEpochs = [
      { totalBudgetUsd: 100 },
      { totalBudgetUsd: 100 },
      { totalBudgetUsd: 100 },
      { totalBudgetUsd: 100 },
      { totalBudgetUsd: 100 },
      { totalBudgetUsd: 100 },
      { totalBudgetUsd: 100 },
    ];

    const result = await runDailyEpochJob({
      epochDate: "2097-01-01",
      force: true,
      harvestedYieldUsd: 80, // with 0.9 factor => 72 USD (which is >= 70% of 100 = 70 USD)
      creatorFeesUsd: 0,
      positions: [
        {
          userAddress: "0x1111111111111111111111111111111111111111",
          asset: "PORTFOLIO",
          usdValue: 5000,
          usdgValue: 5000,
          stockValue: 0,
          tyrStakedAmount: 0,
        },
      ],
      recentCompletedEpochs: recentEpochs,
      reserveAvailableUsd: 10_000,
    });

    expect(result.damper).toBeDefined();
    expect(result.damper!.applied).toBe(false);
    expect(result.damper!.rollingAvg7DayUsd).toBe(100);
    expect(result.damper!.thresholdUsd).toBe(70);
    expect(result.damper!.reserveTopUpUsd).toBe(0);
    expect(result.budgets.totalBudgetUsd).toBe(72);
  });

  it("tops up shortfall from reserve when yield drops below 70% average", async () => {
    // 7-day rolling average = $100/day. Threshold 70% = $70.
    const recentEpochs = Array(7).fill({ totalBudgetUsd: 100 });

    const result = await runDailyEpochJob({
      epochDate: "2097-01-02",
      force: true,
      harvestedYieldUsd: 20, // with 0.9 factor => 18 USD natural budget. Shortfall = 70 - 18 = 52 USD.
      creatorFeesUsd: 0,
      positions: [
        {
          userAddress: "0x1111111111111111111111111111111111111111",
          asset: "PORTFOLIO",
          usdValue: 10000, // 2% of $10,000 = $200 max top-up cap. $52 shortfall is well within cap.
          usdgValue: 10000,
          stockValue: 0,
          tyrStakedAmount: 0,
        },
      ],
      recentCompletedEpochs: recentEpochs,
      reserveAvailableUsd: 5_000,
    });

    expect(result.damper!.applied).toBe(true);
    expect(result.damper!.rollingAvg7DayUsd).toBe(100);
    expect(result.damper!.thresholdUsd).toBe(70);
    expect(result.damper!.shortfallUsd).toBe(52);
    expect(result.damper!.reserveTopUpUsd).toBe(52);
    expect(result.damper!.reason).toBe("reserve_top_up");
    expect(result.damper!.fundingRequiredUsd).toBe(52);
    // Base yield gets natural 18 + 52 reserve top-up = 70 USD
    expect(result.budgets.baseYieldUsd).toBe(70);
    expect(result.budgets.totalBudgetUsd).toBe(70);
    expect(result.totalDistributedQuotaUsd).toBe(70);
  });

  it("strictly caps daily reserve top-up at 2% of total principal per day", async () => {
    // 7-day rolling average = $1000/day. Threshold 70% = $700.
    const recentEpochs = Array(7).fill({ totalBudgetUsd: 1000 });

    const result = await runDailyEpochJob({
      epochDate: "2097-01-03",
      force: true,
      harvestedYieldUsd: 0, // 0 natural yield. Shortfall = $700.
      creatorFeesUsd: 0,
      positions: [
        {
          userAddress: "0x1111111111111111111111111111111111111111",
          asset: "PORTFOLIO",
          usdValue: 5000, // 2% of $5,000 = $100 max top-up cap!
          usdgValue: 5000,
          stockValue: 0,
          tyrStakedAmount: 0,
        },
      ],
      recentCompletedEpochs: recentEpochs,
      // Reserve is large enough that the principal cap is the binding limit.
      reserveAvailableUsd: 50_000,
    });

    expect(result.damper!.applied).toBe(true);
    expect(result.damper!.shortfallUsd).toBe(700);
    expect(result.damper!.principalCapUsd).toBe(100);
    expect(result.damper!.maxDailyTopUpUsd).toBe(100);
    // Reserve top-up must be capped at 100, not 700!
    expect(result.damper!.reserveTopUpUsd).toBe(100);
    expect(result.budgets.totalBudgetUsd).toBe(100);
    expect(result.totalDistributedQuotaUsd).toBe(100);
  });

  it("caps the top-up at the on-chain reserve balance, not at the principal limit", async () => {
    // Shortfall $700, principal cap $100, but the reserve only holds $30.
    const recentEpochs = Array(7).fill({ totalBudgetUsd: 1000 });

    const result = await runDailyEpochJob({
      epochDate: "2097-01-05",
      force: true,
      harvestedYieldUsd: 0,
      creatorFeesUsd: 0,
      positions: [
        {
          userAddress: "0x1111111111111111111111111111111111111111",
          asset: "PORTFOLIO",
          usdValue: 5000,
          usdgValue: 5000,
          stockValue: 0,
          tyrStakedAmount: 0,
        },
      ],
      recentCompletedEpochs: recentEpochs,
      reserveAvailableUsd: 30,
    });

    expect(result.damper!.applied).toBe(true);
    expect(result.damper!.principalCapUsd).toBe(100);
    expect(result.damper!.reserveAvailableUsd).toBe(30);
    expect(result.damper!.maxDailyTopUpUsd).toBe(30);
    // Budget can never exceed the money that actually exists.
    expect(result.damper!.reserveTopUpUsd).toBe(30);
    expect(result.budgets.totalBudgetUsd).toBe(30);
  });

  it("does not top up when the reserve balance cannot be read", async () => {
    const recentEpochs = Array(7).fill({ totalBudgetUsd: 1000 });

    const result = await runDailyEpochJob({
      epochDate: "2097-01-06",
      force: true,
      harvestedYieldUsd: 0,
      creatorFeesUsd: 0,
      positions: [
        {
          userAddress: "0x1111111111111111111111111111111111111111",
          asset: "PORTFOLIO",
          usdValue: 5000,
          usdgValue: 5000,
          stockValue: 0,
          tyrStakedAmount: 0,
        },
      ],
      recentCompletedEpochs: recentEpochs,
      reserveAvailableUsd: null,
    });

    expect(result.damper!.applied).toBe(false);
    expect(result.damper!.reason).toBe("reserve_balance_unavailable");
    expect(result.damper!.reserveTopUpUsd).toBe(0);
    // Natural budget only (zero yield), no invented spend.
    expect(result.budgets.totalBudgetUsd).toBe(0);
  });

  it("does not top up when the reserve is empty", async () => {
    const recentEpochs = Array(7).fill({ totalBudgetUsd: 1000 });

    const result = await runDailyEpochJob({
      epochDate: "2097-01-04",
      force: true,
      harvestedYieldUsd: 0,
      creatorFeesUsd: 0,
      positions: [
        {
          userAddress: "0x1111111111111111111111111111111111111111",
          asset: "PORTFOLIO",
          usdValue: 5000,
          usdgValue: 5000,
          stockValue: 0,
          tyrStakedAmount: 0,
        },
      ],
      recentCompletedEpochs: recentEpochs,
      reserveAvailableUsd: 0,
    });

    expect(result.damper!.applied).toBe(false);
    expect(result.damper!.reason).toBe("reserve_exhausted");
    expect(result.budgets.totalBudgetUsd).toBe(0);
  });

  it("does not apply damper if there is no historical epoch data", async () => {
    const result = await runDailyEpochJob({
      epochDate: "2097-01-07",
      force: true,
      harvestedYieldUsd: 10,
      creatorFeesUsd: 0,
      positions: [
        {
          userAddress: "0x1111111111111111111111111111111111111111",
          asset: "PORTFOLIO",
          usdValue: 5000,
          usdgValue: 5000,
          stockValue: 0,
          tyrStakedAmount: 0,
        },
      ],
      recentCompletedEpochs: [], // Empty history
      reserveAvailableUsd: 10_000,
    });

    expect(result.damper!.applied).toBe(false);
    expect(result.damper!.reserveTopUpUsd).toBe(0);
    expect(result.budgets.totalBudgetUsd).toBe(9); // 10 * 0.9 = 9
  });
});
