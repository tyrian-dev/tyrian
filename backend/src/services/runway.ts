import { openRouter } from "./openrouter";
import { dbService } from "./db";
import { alertService } from "./alert";

export type RunwayStatus = "HEALTHY" | "WARNING" | "CRITICAL";

export interface InferenceRunwayReport {
  remainingCreditsUsd: number;
  avgDailySpendUsd: number;
  totalUsage7dUsd: number;
  runwayDays: number;
  status: RunwayStatus;
  alertSent: boolean;
  checkedAt: string;
}

export interface RunwayDeps {
  getCredits?: () => Promise<{ remainingCredits: number; totalCredits: number; totalUsage: number }>;
  getUsage7d?: () => Promise<number>;
  dispatchAlert?: typeof alertService.dispatchAlert;
}

export class RunwayService {
  private deps: RunwayDeps = {};

  constructor(deps: RunwayDeps = {}) {
    this.deps = deps;
  }

  configure(deps: RunwayDeps): void {
    this.deps = { ...this.deps, ...deps };
  }

  /**
   * Evaluates OpenRouter inference balance runway against 7-day spend (GAP-008 / Brief §5 & §7).
   * Sentinel triggers:
   * - Warning alert if runway < 14 days
   * - Critical alert if runway < 7 days
   */
  async checkInferenceRunway(options?: {
    remainingCredits?: number;
    avgDailySpend7d?: number;
  }): Promise<InferenceRunwayReport> {
    let remainingCreditsUsd = options?.remainingCredits;
    if (remainingCreditsUsd === undefined) {
      if (this.deps.getCredits) {
        const credits = await this.deps.getCredits();
        remainingCreditsUsd = credits.remainingCredits;
      } else {
        const credits = await openRouter.getCredits();
        remainingCreditsUsd = credits.remainingCredits;
      }
    }

    let avgDailySpendUsd = options?.avgDailySpend7d;
    let totalUsage7dUsd = 0;

    if (avgDailySpendUsd === undefined) {
      if (this.deps.getUsage7d) {
        totalUsage7dUsd = await this.deps.getUsage7d();
      } else {
        totalUsage7dUsd = await dbService.getProtocolUsagePastDays(7);
      }

      if (totalUsage7dUsd > 0) {
        avgDailySpendUsd = Number((totalUsage7dUsd / 7).toFixed(6));
      } else {
        // Fallback floor spend rate ($0.05/day) when protocol has no 7d inference logs yet
        avgDailySpendUsd = 0.05;
      }
    } else {
      totalUsage7dUsd = Number((avgDailySpendUsd * 7).toFixed(6));
    }

    const runwayDays =
      avgDailySpendUsd > 0
        ? Math.floor(remainingCreditsUsd / avgDailySpendUsd)
        : remainingCreditsUsd > 0
          ? 365
          : 0;

    let status: RunwayStatus = "HEALTHY";
    let alertSent = false;

    const dispatch = this.deps.dispatchAlert || alertService.dispatchAlert.bind(alertService);

    if (runwayDays < 7) {
      status = "CRITICAL";
      alertSent = true;
      await dispatch(
        "BUDGET_WARNING",
        "CRITICAL",
        "Critical OpenRouter Runway Alert (< 7 Days)",
        `Inference credit balance has reached critical level: $${remainingCreditsUsd.toFixed(2)} remaining with ~${runwayDays} days runway at $${avgDailySpendUsd.toFixed(4)}/day burn rate. Immediate top-up required.`,
        {
          remainingCreditsUsd: String(remainingCreditsUsd),
          avgDailySpendUsd: String(avgDailySpendUsd),
          runwayDays: String(runwayDays),
        },
      );
    } else if (runwayDays < 14) {
      status = "WARNING";
      alertSent = true;
      await dispatch(
        "BUDGET_WARNING",
        "WARNING",
        "Low OpenRouter Runway Warning (< 14 Days)",
        `Inference credit balance is below safe threshold: $${remainingCreditsUsd.toFixed(2)} remaining with ~${runwayDays} days runway at $${avgDailySpendUsd.toFixed(4)}/day burn rate. Top-up recommended soon.`,
        {
          remainingCreditsUsd: String(remainingCreditsUsd),
          avgDailySpendUsd: String(avgDailySpendUsd),
          runwayDays: String(runwayDays),
        },
      );
    }

    return {
      remainingCreditsUsd: Number(remainingCreditsUsd.toFixed(4)),
      avgDailySpendUsd: Number(avgDailySpendUsd.toFixed(4)),
      totalUsage7dUsd: Number(totalUsage7dUsd.toFixed(4)),
      runwayDays,
      status,
      alertSent,
      checkedAt: new Date().toISOString(),
    };
  }
}

export const runwayService = new RunwayService();
