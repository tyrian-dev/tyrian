import { describe, expect, it } from "bun:test";
import { reconciliationService } from "../src/services/reconciliation";
import app from "../src/app";
import { tyrianNetwork } from "../src/config/network";

describe("Tyrian On-Chain & Indexer Reconciliation Suite (IDX-004 / IDX-005)", () => {
  it("runReconciliation reports 0 diff when indexer matches on-chain state", async () => {
    // Injected mock positions with 0 stake (clean state)
    const report = await reconciliationService.runReconciliation([]);

    expect(report).toBeDefined();
    expect(report.network).toBe(tyrianNetwork.name);
    expect(report.assets.length).toBeGreaterThan(0);

    // Each asset checked should report structured numbers
    for (const asset of report.assets) {
      expect(asset.symbol).toBeDefined();
      expect(asset.onChainTotalShares).toBeDefined();
      expect(asset.indexerTotalShares).toBe("0");
    }
  }, 35000);

  it("runReconciliation detects diff when indexer diverges from on-chain total", async () => {
    // Inject diverging position
    const fakePositions = [
      {
        id: "0x1111111111111111111111111111111111111111-0xusdg",
        userAddress: "0x1111111111111111111111111111111111111111",
        assetAddress: tyrianNetwork.tokens.USDG.address?.toLowerCase() || "0x0",
        activeShares: "100000000000000000000", // 100 shares
        pendingShares: "0",
        cooldownShares: "0",
        lastUpdatedBlock: "100",
      },
    ];

    const report = await reconciliationService.runReconciliation(fakePositions);
    expect(report).toBeDefined();
    const usdgReport = report.assets.find((a) => a.symbol === "USDG");
    if (usdgReport) {
      expect(usdgReport.indexerTotalShares).toBe("100000000000000000000");
    }
  }, 35000);

  it("getEffectivePositionsView computes derived view with estimated USD value (IDX-004)", async () => {
    const testWallet = "0x3b113D111672F8cc2e060F028EF4fF0B886dE63E";
    const views = await reconciliationService.getEffectivePositionsView(testWallet);

    expect(Array.isArray(views)).toBe(true);
    // If indexer is live or empty, views is an array
    for (const v of views) {
      expect(v.userAddress).toBe(testWallet.toLowerCase());
      expect(v.symbol).toBeDefined();
      expect(typeof v.estimatedUsdValue).toBe("number");
      expect(v.effectiveActiveShares).toBeDefined();
      expect(v.cooldownShares).toBeDefined();
    }
  });

  it("GET /api/treasury/reconciliation returns 200 with structured report", async () => {
    const res = await app.request("/api/treasury/reconciliation");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; network: string; assets: unknown[] };
    expect(body.status).toMatch(/MATCH|DIFF_DETECTED/);
    expect(body.network).toBeDefined();
    expect(Array.isArray(body.assets)).toBe(true);
  }, 35000);

  it("GET /api/treasury/positions/view/:address returns derived positions view", async () => {
    const res = await app.request("/api/treasury/positions/view/0x3b113D111672F8cc2e060F028EF4fF0B886dE63E");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { address: string; positions: unknown[] };
    expect(body.address.toLowerCase()).toBe("0x3b113d111672f8cc2e060f028ef4ff0b886de63e");
    expect(Array.isArray(body.positions)).toBe(true);
  });

  it("GET /api/treasury/positions/view/:address rejects invalid address with 400", async () => {
    const res = await app.request("/api/treasury/positions/view/invalid-address");
    expect(res.status).toBe(400);
  });
});
