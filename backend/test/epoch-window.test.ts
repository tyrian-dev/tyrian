import { describe, it, expect, afterEach } from "bun:test";
import { IndexerService, indexerService } from "../src/services/indexer";
import { runDailyEpochJob } from "../src/cron/epoch";
import {
  DEFAULT_EPOCH_BUDGET_WINDOW_DAYS,
  MAX_EPOCH_BUDGET_WINDOW_DAYS,
  SECONDS_PER_DAY,
  resolveEpochBudgetWindow,
} from "../src/services/epoch-window";

describe("Epoch budget window (BUD-001)", () => {
  describe("resolveEpochBudgetWindow", () => {
    it("covers exactly the day before the epoch start by default", () => {
      const window = resolveEpochBudgetWindow("2026-11-05", DEFAULT_EPOCH_BUDGET_WINDOW_DAYS);

      expect(window.untilSec).toBe(Date.parse("2026-11-05T00:00:00Z") / 1000);
      expect(window.sinceSec).toBe(window.untilSec - SECONDS_PER_DAY);
      expect(window.days).toBe(DEFAULT_EPOCH_BUDGET_WINDOW_DAYS);
    });

    it("never allows a zero-length window, which would silently zero the budget", () => {
      const window = resolveEpochBudgetWindow("2026-11-05", 0);

      expect(window.days).toBe(1);
      expect(window.untilSec - window.sinceSec).toBe(SECONDS_PER_DAY);
    });

    it("caps the lookback so a stale event cannot be counted twice", () => {
      const window = resolveEpochBudgetWindow("2026-11-05", 90);

      expect(window.days).toBe(MAX_EPOCH_BUDGET_WINDOW_DAYS);
      expect(window.untilSec - window.sinceSec).toBe(MAX_EPOCH_BUDGET_WINDOW_DAYS * SECONDS_PER_DAY);
    });

    it("rejects a malformed epoch date instead of guessing", () => {
      expect(() => resolveEpochBudgetWindow("not-a-date")).toThrow(/Invalid epoch date/);
    });
  });

  describe("indexer event queries", () => {
    const originalFetch = globalThis.fetch;
    let captured: { query?: string; variables?: Record<string, unknown> } = {};

    function stubFetch(payload: unknown) {
      captured = {};
      globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
        captured = JSON.parse(init?.body ?? "{}");
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;
    }

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("filters harvests by the epoch window instead of counting all history", async () => {
      stubFetch({ data: { harvestEvents: { items: [] } } });
      const service = new IndexerService();

      await service.getRecentHarvestEvents({ sinceSec: 1_700_000_000, untilSec: 1_700_086_400 });

      expect(captured.query).toContain("where: { blockTimestamp_gte: $since, blockTimestamp_lt: $until }");
      expect(captured.variables).toEqual({
        since: "1700000000",
        until: "1700086400",
      });
    });

    it("filters fee splits by the epoch window", async () => {
      stubFetch({ data: { feeSplitEvents: { items: [] } } });
      const service = new IndexerService();

      await service.getRecentFeeSplits({ sinceSec: 1_700_000_000, untilSec: 1_700_086_400 });

      expect(captured.query).toContain("where: { blockTimestamp_gte: $since, blockTimestamp_lt: $until }");
      expect(captured.variables?.since).toBe("1700000000");
    });

    it("leaves the query unfiltered when no window is supplied", async () => {
      stubFetch({ data: { feeSplitEvents: { items: [] } } });
      const service = new IndexerService();

      await service.getRecentFeeSplits();

      expect(captured.query).not.toContain("where:");
      expect(captured.variables).toBeUndefined();
    });

    it("supports an open-ended window with only a lower bound", async () => {
      stubFetch({ data: { harvestEvents: { items: [] } } });
      const service = new IndexerService();

      await service.getRecentHarvestEvents({ sinceSec: 42 });

      expect(captured.query).toContain("where: { blockTimestamp_gte: $since }");
      expect(captured.query).not.toContain("blockTimestamp_lt");
      expect(captured.variables).toEqual({ since: "42" });
    });
  });

  describe("epoch job wiring", () => {
    const originalHarvests = indexerService.getRecentHarvestEvents;
    const originalFees = indexerService.getRecentFeeSplits;
    const seenHarvestWindows: Array<{ sinceSec?: number; untilSec?: number }> = [];
    const seenFeeWindows: Array<{ sinceSec?: number; untilSec?: number }> = [];

    afterEach(() => {
      indexerService.getRecentHarvestEvents = originalHarvests;
      indexerService.getRecentFeeSplits = originalFees;
      seenHarvestWindows.length = 0;
      seenFeeWindows.length = 0;
      delete process.env.EPOCH_BUDGET_WINDOW_DAYS;
    });

    it("asks the indexer for the epoch window only, never the whole history", async () => {
      indexerService.getRecentHarvestEvents = async (window) => {
        seenHarvestWindows.push({
          sinceSec: Number(window?.sinceSec),
          untilSec: Number(window?.untilSec),
        });
        return [];
      };
      indexerService.getRecentFeeSplits = async (window) => {
        seenFeeWindows.push({
          sinceSec: Number(window?.sinceSec),
          untilSec: Number(window?.untilSec),
        });
        return [];
      };

      const summary = await runDailyEpochJob({
        epochDate: "2099-02-01",
        force: true,
        positions: [],
        recentCompletedEpochs: [],
      });

      const expected = resolveEpochBudgetWindow("2099-02-01");
      expect(seenHarvestWindows).toHaveLength(1);
      expect(seenFeeWindows).toHaveLength(1);
      expect(seenHarvestWindows[0]).toEqual({
        sinceSec: expected.sinceSec,
        untilSec: expected.untilSec,
      });
      expect(seenFeeWindows[0]).toEqual({
        sinceSec: expected.sinceSec,
        untilSec: expected.untilSec,
      });
      expect(summary.budgetWindow?.sinceSec).toBe(expected.sinceSec);
      expect(summary.budgetWindow?.untilSec).toBe(expected.untilSec);
      expect(summary.budgets.totalBudgetUsd).toBe(0);
    });

    it("honours EPOCH_BUDGET_WINDOW_DAYS for reconciliation runs", async () => {
      process.env.EPOCH_BUDGET_WINDOW_DAYS = "3";
      indexerService.getRecentHarvestEvents = async (window) => {
        seenHarvestWindows.push({
          sinceSec: Number(window?.sinceSec),
          untilSec: Number(window?.untilSec),
        });
        return [];
      };
      indexerService.getRecentFeeSplits = async () => [];

      await runDailyEpochJob({
        epochDate: "2099-02-02",
        force: true,
        positions: [],
        recentCompletedEpochs: [],
      });

      expect(seenHarvestWindows[0].untilSec! - seenHarvestWindows[0].sinceSec!).toBe(
        3 * SECONDS_PER_DAY,
      );
    });
  });
});
