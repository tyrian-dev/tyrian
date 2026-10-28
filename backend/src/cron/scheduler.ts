import { runDailyEpochJob, type EpochRunSummary } from "./epoch";
import { reconciliationService, type ReconciliationReport } from "../services/reconciliation";
import { metricsService } from "../services/metrics";
import { alertService } from "../services/alert";
import { treasuryKeeperService, type RouteExecutionResult } from "../services/treasury-keeper";
import { portfolioKeeperService, type DcaExecutionResult } from "../services/portfolio-keeper";
import { runwayService } from "../services/runway";

export class ProtocolSchedulerService {
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private epochTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isReconciliationActive = false;
  private isEpochActive = false;
  private lastEpochDateUtc: string | null = null;

  // Defaults: 60m reconciliation interval
  private reconciliationIntervalMs = 60 * 60 * 1000;

  setReconciliationInterval(intervalMs: number): void {
    this.reconciliationIntervalMs = intervalMs;
    if (this.isRunning) {
      this.restartReconciliationTimer();
    }
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("[Scheduler] ⏱️ Tyrian Protocol Background Scheduler started");

    // 1. Start periodic reconciliation loop
    this.restartReconciliationTimer();

    // 2. Schedule next 00:00:00 UTC epoch run
    this.scheduleNextEpoch();
  }

  stop(): void {
    this.isRunning = false;
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    if (this.epochTimer) {
      clearTimeout(this.epochTimer);
      this.epochTimer = null;
    }
    console.log("[Scheduler] 🛑 Tyrian Protocol Background Scheduler stopped");
  }

  private restartReconciliationTimer(): void {
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
    }
    this.reconciliationTimer = setInterval(() => {
      void this.runPeriodicReconciliation();
    }, this.reconciliationIntervalMs);
  }

  async runPeriodicReconciliation(): Promise<ReconciliationReport | null> {
    if (this.isReconciliationActive) {
      console.log("[Scheduler] Reconciliation already in progress. Skipping.");
      return null;
    }

    this.isReconciliationActive = true;
    try {
      console.log("[Scheduler] 🔍 Running periodic on-chain reconciliation check...");
      const report = await reconciliationService.runReconciliation();
      const diffNum = Number(report.totalDiff);

      metricsService.setReconciliationDiff(diffNum);

      if (!report.allMatched || diffNum > 0) {
        await alertService.dispatchAlert(
          "RECONCILIATION_DIFF",
          "CRITICAL",
          "On-Chain & Indexer Accounting Discrepancy",
          `Detected difference of ${report.totalDiff} units between on-chain totalShares and indexer state.`,
          {
            network: report.network,
            blockNumber: String(report.blockNumber),
            diff: report.totalDiff,
          },
        );
      } else {
        console.log(`[Scheduler] ✅ Reconciliation verified: 0 diff across ${report.assets.length} assets.`);
      }

      // Periodic OpenRouter inference runway sentinel check (GAP-008 / Brief §5 & §7)
      try {
        const runway = await runwayService.checkInferenceRunway();
        console.log(`[Scheduler] 🤖 Inference runway check: ${runway.runwayDays} days ($${runway.remainingCreditsUsd} credits, status=${runway.status})`);
      } catch (runwayErr) {
        console.warn("[Scheduler] Non-fatal error during runway check:", runwayErr);
      }

      return report;
    } catch (err) {
      console.error("[Scheduler] Error running background reconciliation:", err);
      return null;
    } finally {
      this.isReconciliationActive = false;
    }
  }

  private scheduleNextEpoch(): void {
    const now = new Date();
    // Compute next 00:00:00 UTC
    const nextUtc = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0
    ));

    const msUntilNext = nextUtc.getTime() - now.getTime();
    console.log(`[Scheduler] Next daily epoch scheduled in ${Math.round(msUntilNext / 1000 / 60)} minutes (${nextUtc.toISOString()})`);

    this.epochTimer = setTimeout(async () => {
      await this.runScheduledEpoch();
      if (this.isRunning) {
        this.scheduleNextEpoch();
      }
    }, msUntilNext);
  }

  async runScheduledEpoch(): Promise<EpochRunSummary | null> {
    const todayStr = new Date().toISOString().split("T")[0];
    if (this.lastEpochDateUtc === todayStr) {
      console.log(`[Scheduler] Epoch for ${todayStr} UTC has already executed. Skipping duplicate run.`);
      return null;
    }

    if (this.isEpochActive) {
      console.log("[Scheduler] Epoch execution currently active. Skipping.");
      return null;
    }

    this.isEpochActive = true;
    const start = Date.now();
    try {
      console.log(`[Scheduler] 🚀 Executing automated daily 00:00 UTC epoch redistribution for ${todayStr}...`);

      // 1. Trigger automated TreasuryRouter on-chain routing (GAP-006 / Brief §7)
      try {
        const routeResult = await this.triggerTreasuryRoute();
        if (routeResult.executed) {
          console.log(`[Scheduler] 🔀 TreasuryRouter.route() executed: tx ${routeResult.txHash}`);
        } else {
          console.log(`[Scheduler] Treasury routing skipped or deferred: ${routeResult.reason}`);
        }
      } catch (routeErr) {
        console.error("[Scheduler] Non-fatal error during automated treasury routing:", routeErr);
      }

      // 2. Trigger automated PortfolioVault DCA buy if due (GAP-011 / Brief §7)
      try {
        const dcaResult = await this.triggerPortfolioDca();
        if (dcaResult.executed) {
          console.log(`[Scheduler] 📈 PortfolioVault DCA buy executed: tx ${dcaResult.txHash}`);
        } else {
          console.log(`[Scheduler] Portfolio DCA buy skipped or deferred: ${dcaResult.reason}`);
        }
      } catch (dcaErr) {
        console.error("[Scheduler] Non-fatal error during automated DCA buy:", dcaErr);
      }

      // 3. Run off-chain quota redistribution job
      const summary = await runDailyEpochJob();
      const durationMs = Date.now() - start;

      this.lastEpochDateUtc = todayStr;
      metricsService.setEpochMetrics(durationMs, summary.totalDistributedQuotaUsd);

      console.log(`[Scheduler] ✅ Epoch complete: $${summary.totalDistributedQuotaUsd.toFixed(6)} allocated across ${summary.walletsProcessed} wallets (${durationMs}ms).`);
      return summary;
    } catch (err) {
      console.error("[Scheduler] ❌ Daily epoch execution failed:", err);
      await alertService.dispatchAlert(
        "BUDGET_WARNING",
        "WARNING",
        "Scheduled Epoch Job Failure",
        `Daily epoch quota redistribution encountered an error: ${(err as Error).message}`,
      );
      return null;
    } finally {
      this.isEpochActive = false;
    }
  }

  async triggerTreasuryRoute(options?: { minUsdgOut?: bigint; deadlineSeconds?: number }): Promise<RouteExecutionResult> {
    return treasuryKeeperService.triggerRoute(options);
  }

  async triggerPortfolioDca(options?: {
    tokenAddress?: `0x${string}`;
    usdgAmount?: bigint;
    maxSlippageBps?: number;
    deadlineSeconds?: number;
  }): Promise<DcaExecutionResult> {
    return portfolioKeeperService.triggerDcaBuy(options);
  }

  getStatus(): {
    isRunning: boolean;
    reconciliationIntervalMs: number;
    lastEpochDateUtc: string | null;
    isReconciliationActive: boolean;
    isEpochActive: boolean;
  } {
    return {
      isRunning: this.isRunning,
      reconciliationIntervalMs: this.reconciliationIntervalMs,
      lastEpochDateUtc: this.lastEpochDateUtc,
      isReconciliationActive: this.isReconciliationActive,
      isEpochActive: this.isEpochActive,
    };
  }
}

export const protocolScheduler = new ProtocolSchedulerService();
