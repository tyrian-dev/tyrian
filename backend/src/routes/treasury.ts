import { Hono } from "hono";
import { treasuryService } from "../services/treasury";
import { reconciliationService } from "../services/reconciliation";
import { PriceUnavailableError } from "../services/pricing";
import { runwayService } from "../services/runway";

export const treasuryRouter = new Hono();

/**
 * GET /api/treasury/summary
 * Returns overall treasury balances, 30-day inflow, runway, and portfolio
 */
treasuryRouter.get("/summary", async (c) => {
  try {
    const summary = await treasuryService.getTreasurySummary();
    return c.json(summary);
  } catch (err) {
    console.error("[TreasuryRouter] /summary error:", err);
    return c.json({ error: "Failed to fetch treasury summary" }, 500);
  }
});

/**
 * GET /api/treasury/runway
 * Returns real-time OpenRouter inference balance runway status and alert thresholds (GAP-008 / Brief §5 & §7)
 */
treasuryRouter.get("/runway", async (c) => {
  try {
    const report = await runwayService.checkInferenceRunway();
    return c.json(report);
  } catch (err) {
    console.error("[TreasuryRouter] /runway error:", err);
    return c.json({ error: "Failed to fetch inference runway" }, 500);
  }
});

/**
 * GET /api/treasury/flow
 * Returns 30-day inflow/spend timeline and recent harvest/burn transactions
 */
treasuryRouter.get("/flow", async (c) => {
  try {
    const flow = await treasuryService.getTreasuryFlow();
    return c.json(flow);
  } catch (err) {
    console.error("[TreasuryRouter] /flow error:", err);
    return c.json({ error: "Failed to fetch treasury flow" }, 500);
  }
});

/**
 * GET /api/treasury/reconciliation
 * Performs on-chain vs indexer reconciliation and reports status & diffs (IDX-005)
 */
treasuryRouter.get("/reconciliation", async (c) => {
  try {
    const report = await reconciliationService.runReconciliation();
    return c.json(report);
  } catch (err) {
    console.error("[TreasuryRouter] /reconciliation error:", err);
    return c.json({ error: "Failed to perform reconciliation" }, 500);
  }
});

/**
 * GET /api/treasury/positions/view/:address
 * Returns derived view of effective positions for an address (IDX-004)
 */
treasuryRouter.get("/positions/view/:address", async (c) => {
  const address = c.req.param("address");
  if (!address || !address.startsWith("0x")) {
    return c.json({ error: "Valid 0x address required" }, 400);
  }

  try {
    const views = await reconciliationService.getEffectivePositionsView(address);
    return c.json({ address, positions: views });
  } catch (err) {
    if (err instanceof PriceUnavailableError) {
      return c.json(
        {
          error: "Price unavailable for one or more positions",
          type: "price_unavailable",
          code: "price_unavailable",
          asset: err.symbol,
        },
        503,
      );
    }
    console.error("[TreasuryRouter] /positions/view error:", err);
    return c.json({ error: "Failed to fetch derived positions view" }, 500);
  }
});

/**
 * GET /api/treasury/reconciliation/epoch/:date
 * Reconciles recorded daily epoch distribution against PostgreSQL user allocations (BE-EPOCH-010)
 */
treasuryRouter.get("/reconciliation/epoch/:date", async (c) => {
  const date = c.req.param("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "Valid YYYY-MM-DD date required" }, 400);
  }

  try {
    const report = await reconciliationService.reconcileDailyEpochQuota(date);
    return c.json(report);
  } catch (err) {
    console.error("[TreasuryRouter] /reconciliation/epoch error:", err);
    return c.json({ error: "Failed to reconcile epoch quota" }, 500);
  }
});

