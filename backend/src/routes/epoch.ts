import { Hono } from "hono";
import { runDailyEpochJob } from "../cron/epoch";
import { indexerService } from "../services/indexer";
import { quotaService } from "../services/quota";
import { metricsService } from "../services/metrics";
import { PriceUnavailableError } from "../services/pricing";

export const epochRouter = new Hono();

/**
 * 1. GET /api/epoch/status
 */
epochRouter.get("/status", async (c) => {
  const isHealthy = await indexerService.isIndexerHealthy();
  const nextReset = quotaService.getNextEpochReset();
  const recentHarvests = await indexerService.getRecentHarvestEvents();

  return c.json({
    status: isHealthy ? "ready" : "indexer_unavailable",
    nextResetTimeUtc: nextReset.resetTimeUtc,
    secondsUntilReset: nextReset.secondsUntilReset,
    recentHarvestCount: recentHarvests.length,
  });
});

/**
 * 2. POST /api/epoch/run
 * Trigger daily epoch job to pull real on-chain events from indexer and reallocate quotas.
 */
epochRouter.post("/run", async (c) => {
  const adminSecret = process.env.ADMIN_SECRET;
  const authHeader = c.req.header("Authorization");

  if (adminSecret && authHeader !== `Bearer ${adminSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const startTime = Date.now();
  try {
    const summary = await runDailyEpochJob();
    const durationMs = Date.now() - startTime;
    metricsService.setEpochMetrics(durationMs, summary.totalDistributedQuotaUsd);
    return c.json({ success: true, summary });
  } catch (err) {
    if (err instanceof PriceUnavailableError) {
      console.error(`[Epoch Job] Price unavailable, quota distribution not written: ${err.message}`);
      return c.json(
        {
          error: err.message,
          type: "price_unavailable",
          code: "price_unavailable",
          asset: err.symbol,
        },
        503,
      );
    }
    return c.json({ error: (err as Error).message }, 500);
  }
});
