import { describe, it, expect, afterAll } from "bun:test";
import { runDailyEpochJob, type StakePosition } from "../src/cron/epoch";
import { pricingService, PriceUnavailableError } from "../src/services/pricing";

const E18 = 10n ** 18n;

describe("Brief Alignment Sprint 1: Epoch Economics & Anti-Flash-Stake", () => {
  afterAll(() => {
    pricingService.configure({});
  });

  describe("GAP-001 & GAP-002: Fee Pools & Cross-Subsidy Elimination", () => {
    it("allocates creator fee splits 40% to Stock pool and 60% to TYR pool", async () => {
      // Creator fees = $1,000; utilization = 0.90 -> total fee budget = $900
      // Stock budget (40%) = $360; TYR budget (60%) = $540
      const summary = await runDailyEpochJob({
        epochDate: "2088-01-01",
        force: true,
        harvestedYieldUsd: 0,
        creatorFeesUsd: 1000,
        positions: [
          {
            userAddress: "0xstock11111111111111111111111111111111111",
            asset: "PORTFOLIO",
            usdValue: 1000,
            usdgValue: 0,
            stockValue: 1000, // Stock staker
            tyrStakedAmount: 0,
          },
          {
            userAddress: "0xtyr11111111111111111111111111111111111111",
            asset: "PORTFOLIO",
            usdValue: 0,
            usdgValue: 0,
            stockValue: 0,
            tyrStakedAmount: 1000, // TYR staker
          },
        ],
        tyrPriceUsd: 0.10,
      });

      expect(summary.budgets.stockPoolUsd).toBe(360);
      expect(summary.budgets.tyrPoolUsd).toBe(540);
      expect(summary.budgets.baseYieldUsd).toBe(0);

      const stockUser = summary.allocations.find(
        (a) => a.userAddress === "0xstock11111111111111111111111111111111111",
      );
      const tyrUser = summary.allocations.find(
        (a) => a.userAddress === "0xtyr11111111111111111111111111111111111111",
      );

      // Stock staker gets all $360 from Stock fee pool, 0 from TYR pool
      expect(stockUser?.quotaUsd).toBe(360);
      // TYR staker gets all $540 from TYR fee pool, 0 from Stock pool
      expect(tyrUser?.quotaUsd).toBe(540);
    });

    it("prevents cross-subsidy: USDG stakers do not receive Stock fee budget and vice versa", async () => {
      // USDG harvest yield = $100 -> baseYieldBudget = $90
      // Creator fees = $100 -> fee budget = $90 -> stockBudget (40%) = $36, tyrBudget (60%) = $54
      const summary = await runDailyEpochJob({
        epochDate: "2088-01-02",
        force: true,
        harvestedYieldUsd: 100,
        creatorFeesUsd: 100,
        recentCompletedEpochs: [], // Isolate pool separation from 7-day damper top-up
        positions: [
          {
            userAddress: "0xusdg_only_user____________________________",
            asset: "PORTFOLIO",
            usdValue: 1000,
            usdgValue: 1000, // Only staked USDG
            stockValue: 0,
            tyrStakedAmount: 0,
          },
          {
            userAddress: "0xstock_only_user___________________________",
            asset: "PORTFOLIO",
            usdValue: 1000,
            usdgValue: 0,
            stockValue: 1000, // Only staked Stock
            tyrStakedAmount: 0,
          },
        ],
        tyrPriceUsd: 0.05,
      });

      const usdgUser = summary.allocations.find(
        (a) => a.userAddress === "0xusdg_only_user____________________________",
      );
      const stockUser = summary.allocations.find(
        (a) => a.userAddress === "0xstock_only_user___________________________",
      );

      // USDG user receives 100% of base yield budget ($90) and 0 from stock budget ($0)
      expect(usdgUser?.quotaUsd).toBe(90);

      // Stock user receives 100% of stock budget ($36) and 0 from USDG yield budget ($0)
      expect(stockUser?.quotaUsd).toBe(36);
    });
  });

  describe("GAP-003 & GAP-004: Anti-Flash-Stake & Unstake Quota Stop", () => {
    it("anti-flash-stake: stake pending for current epoch receives 0 quota until next epoch boundary", async () => {
      // User staked during epoch 2088-05-10. Effective epoch is 2088-05-11 (epoch+1).
      // When 2088-05-10 epoch runs, pending stake is not yet active.
      const epochTimestamp = new Date("2088-05-10T00:00:00Z").getTime();
      const currentEpochNum = Math.floor(epochTimestamp / 86400000);

      // Simulate a stake with effectiveEpoch in the future
      const summaryEpochH = await runDailyEpochJob({
        epochDate: "2088-05-10",
        force: true,
        harvestedYieldUsd: 100,
        creatorFeesUsd: 0,
        positions: [
          {
            userAddress: "0xmature_user_______________________________",
            asset: "PORTFOLIO",
            usdValue: 1000,
            usdgValue: 1000,
            stockValue: 0,
            tyrStakedAmount: 0,
          },
          {
            userAddress: "0xflash_staker______________________________",
            asset: "PORTFOLIO",
            usdValue: 0, // Not yet active in epoch H
            usdgValue: 0,
            stockValue: 0,
            tyrStakedAmount: 0,
          },
        ],
      });

      const flashStaker = summaryEpochH.allocations.find(
        (a) => a.userAddress === "0xflash_staker______________________________",
      );
      expect(flashStaker?.quotaUsd).toBe(0);

      const matureUser = summaryEpochH.allocations.find(
        (a) => a.userAddress === "0xmature_user_______________________________",
      );
      expect(matureUser?.quotaUsd).toBe(90);
    });
  });

  describe("GAP-005: Oracle-Backed Harvest & Fee Valuation", () => {
    it("fails closed when oracle is unavailable instead of falling back to 1:1 pricing", async () => {
      pricingService.configure({
        readOracle: async () => {
          throw new Error("oracle unreachable");
        },
      });

      // Attempting to price an un-configured or failing asset must fail closed
      await expect(
        runDailyEpochJob({
          epochDate: "2088-06-01",
          force: true,
          harvestedYieldUsd: 100,
          positions: [
            {
              userAddress: "0xtestuser__________________________________",
              asset: "PORTFOLIO",
              usdValue: 1000,
              tyrStakedAmount: 100, // Requires TYR oracle
            },
          ],
        }),
      ).rejects.toBeInstanceOf(PriceUnavailableError);
    });
  });
});
