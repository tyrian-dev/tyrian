import { describe, it, expect } from "bun:test";
import { calculateBoost } from "../src/services/quota";
import { runDailyEpochJob, type StakePosition } from "../src/cron/epoch";

describe("Epoch Quota Formula Specification & Test Vectors (BE-EPOCH-011)", () => {
  describe("Boost Calculation: 1 + 0.5 * min(1, tyrUsd / baseUsd), capped at 1.5", () => {
    it("returns 1.0 when base asset value is zero", () => {
      expect(calculateBoost(100, 0)).toBe(1.0);
    });

    it("returns 1.0 when TYR stake value is zero", () => {
      expect(calculateBoost(0, 100)).toBe(1.0);
    });

    it("returns 1.25 when TYR value is 50% of base asset", () => {
      expect(calculateBoost(50, 100)).toBe(1.25);
    });

    it("returns 1.5 when TYR value equals base asset", () => {
      expect(calculateBoost(100, 100)).toBe(1.5);
    });

    it("caps boost at 1.5 when TYR value exceeds base asset", () => {
      expect(calculateBoost(500, 100)).toBe(1.5);
    });
  });

  describe("Pro-rata Quota Distribution (BE-EPOCH-001 / BE-EPOCH-004)", () => {
    it("distributes quota strictly pro-rata and rounds to 6 decimals", async () => {
      const positions: StakePosition[] = [
        {
          userAddress: "0x1111111111111111111111111111111111111111",
          asset: "PORTFOLIO",
          usdValue: 1000,
          tyrStakedAmount: 0, // boost = 1.0 -> weight = 1000
        },
        {
          userAddress: "0x2222222222222222222222222222222222222222",
          asset: "PORTFOLIO",
          usdValue: 1000,
          tyrStakedAmount: 10000, // 10000 * 0.05 = $500 -> boost = 1.25 -> weight = 1250
        },
      ];

      // Harvested yield = 100 USD; Utilization = 0.90 -> Base budget = $90.00
      const summary = await runDailyEpochJob({
        harvestedYieldUsd: 100,
        creatorFeesUsd: 0,
        positions,
        tyrPriceUsd: 0.05,
        force: true,
      });

      expect(summary.budgets.baseYieldUsd).toBe(90);
      expect(summary.walletsProcessed).toBe(2);

      const userA = summary.allocations.find(
        (a) => a.userAddress === "0x1111111111111111111111111111111111111111",
      );
      const userB = summary.allocations.find(
        (a) => a.userAddress === "0x2222222222222222222222222222222222222222",
      );

      expect(userA).toBeDefined();
      expect(userB).toBeDefined();

      // Total weight = 1000 + 1250 = 2250
      // User A quota: 90 * (1000 / 2250) = 40.0
      // User B quota: 90 * (1250 / 2250) = 50.0
      expect(userA!.quotaUsd).toBe(40);
      expect(userB!.quotaUsd).toBe(50);
      expect(summary.totalDistributedQuotaUsd).toBe(90);
    });

    it("assigns 0 quota to zero-stake wallets without artificial minimum (BE-EPOCH-003)", async () => {
      const positions: StakePosition[] = [
        {
          userAddress: "0x0000000000000000000000000000000000000000",
          asset: "PORTFOLIO",
          usdValue: 0,
          tyrStakedAmount: 0,
        },
      ];

      const summary = await runDailyEpochJob({
        harvestedYieldUsd: 100,
        creatorFeesUsd: 0,
        positions,
        force: true,
      });

      const zeroUser = summary.allocations.find(
        (a) => a.userAddress === "0x0000000000000000000000000000000000000000",
      );
      expect(zeroUser?.quotaUsd).toBe(0);
    });
  });
});
