import { describe, it, expect } from "bun:test";
import app from "../src/app";
import { reconciliationService } from "../src/services/reconciliation";
import { runDailyEpochJob } from "../src/cron/epoch";

describe("Tyrian Daily Quota Reconciliation Suite (BE-EPOCH-010)", () => {
  const testEpoch = "2026-10-30";
  const dummyPositions = [
    {
      userAddress: "0x1111111111111111111111111111111111111111",
      asset: "PORTFOLIO",
      usdValue: 1000,
      tyrStakedAmount: 0,
    },
    {
      userAddress: "0x2222222222222222222222222222222222222222",
      asset: "PORTFOLIO",
      usdValue: 1000,
      tyrStakedAmount: 0,
    },
  ];

  it("returns NOT_FOUND for a future/unexecuted epoch", async () => {
    const report = await reconciliationService.reconcileDailyEpochQuota("2999-12-31");
    expect(report.status).toBe("NOT_FOUND");
    expect(report.diffUsd).toBe(0);
  });

  it("reconciles executed epoch with 0 diff and verified budget conservation", async () => {
    // 1. Execute epoch job
    await runDailyEpochJob({
      epochDate: testEpoch,
      harvestedYieldUsd: 100,
      creatorFeesUsd: 0,
      positions: dummyPositions,
      force: true,
    });

    // 2. Run reconciliation
    const report = await reconciliationService.reconcileDailyEpochQuota(testEpoch);
    expect(report.status).toBe("MATCH");
    expect(report.diffUsd).toBeLessThanOrEqual(0.0001);
    expect(report.budgetConserved).toBe(true);
    expect(report.walletsCount).toBe(2);
    expect(report.recordedAllocatedUsd).toBe(90.0);
    expect(report.aggregatedQuotasUsd).toBe(90.0);
  });

  it("GET /api/treasury/reconciliation/epoch/:date returns 200 with report", async () => {
    const res = await app.request(`/api/treasury/reconciliation/epoch/${testEpoch}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      epochDate: string;
      budgetConserved: boolean;
    };
    expect(json.epochDate).toBe(testEpoch);
    expect(json.status).toBe("MATCH");
    expect(json.budgetConserved).toBe(true);
  });

  it("GET /api/treasury/reconciliation/epoch/:date rejects invalid date format with 400", async () => {
    const res = await app.request("/api/treasury/reconciliation/epoch/invalid-date-format");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Valid YYYY-MM-DD");
  });
});
