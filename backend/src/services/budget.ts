import { redis } from "./redis";
import { alertService } from "./alert";

export class BudgetGuardService {
  private defaultDailyBudgetUsd: number = 100.0; // fallback $100 before first epoch run
  private alertThresholdRatio: number = 0.8; // 80% threshold
  private spendLock: Promise<void> = Promise.resolve();

  private getTodayKey(): string {
    const dateStr = new Date().toISOString().split("T")[0];
    return `tyrian:budget:spend:${dateStr}`;
  }

  private getGlobalBudgetKey(): string {
    const dateStr = new Date().toISOString().split("T")[0];
    return `tyrian:budget:cap:${dateStr}`;
  }

  async setDailyEpochBudget(budgetUsd: number): Promise<void> {
    if (budgetUsd <= 0) return;
    const key = this.getGlobalBudgetKey();
    await redis.set(key, budgetUsd.toString(), 2 * 24 * 60 * 60);
  }

  async getDailyBudget(): Promise<number> {
    const key = this.getGlobalBudgetKey();
    const raw = await redis.get(key);
    return raw ? parseFloat(raw) : this.defaultDailyBudgetUsd;
  }

  async getDailySpend(): Promise<number> {
    const key = this.getTodayKey();
    const raw = await redis.get(key);
    return raw ? parseFloat(raw) : 0;
  }

  async recordSpend(costUsd: number): Promise<{
    currentSpend: number;
    maxBudget: number;
    ratio: number;
    alert: boolean;
    exceeded: boolean;
  }> {
    const key = this.getTodayKey();
    const current = await this.getDailySpend();
    const newSpend = current + costUsd;
    await redis.set(key, newSpend.toString(), 2 * 24 * 60 * 60);

    const maxBudget = await this.getDailyBudget();
    const ratio = maxBudget > 0 ? newSpend / maxBudget : 0;
    const alert = ratio >= this.alertThresholdRatio;
    const exceeded = ratio >= 1.0;

    if (alert && !exceeded) {
      console.warn(
        `[BudgetGuard] ⚠️ Global daily inference spend reached ${(ratio * 100).toFixed(1)}% ($${newSpend.toFixed(4)} / $${maxBudget.toFixed(2)})`,
      );
      void alertService.dispatchAlert(
        "BUDGET_WARNING",
        "WARNING",
        "Global Daily Budget Threshold Reached (80%)",
        `Daily inference spend reached ${(ratio * 100).toFixed(1)}% ($${newSpend.toFixed(4)} / $${maxBudget.toFixed(2)}).`,
        { spendUsd: newSpend, budgetCapUsd: maxBudget },
      );
    } else if (exceeded) {
      console.error(
        `[BudgetGuard] 🛑 Global daily inference budget EXHAUSTED ($${newSpend.toFixed(4)} / $${maxBudget.toFixed(2)})`,
      );
      void alertService.dispatchAlert(
        "BUDGET_EXHAUSTED",
        "CRITICAL",
        "Global Daily Budget Exhausted (100%)",
        `Daily inference budget limit reached ($${newSpend.toFixed(4)} / $${maxBudget.toFixed(2)}). All further inference calls are temporarily blocked until 00:00 UTC epoch reset.`,
        { spendUsd: newSpend, budgetCapUsd: maxBudget },
      );
    }

    return {
      currentSpend: newSpend,
      maxBudget,
      ratio,
      alert,
      exceeded,
    };
  }

  async recordRefund(costUsd: number): Promise<void> {
    const key = this.getTodayKey();
    const current = await this.getDailySpend();
    const newSpend = Math.max(0, current - costUsd);
    await redis.set(key, newSpend.toString(), 2 * 24 * 60 * 60);
  }

  async reserveBudget(estimatedCostUsd: number): Promise<{ allowed: boolean; reason?: string }> {
    return new Promise((resolve) => {
      this.spendLock = this.spendLock.then(async () => {
        try {
          const maxBudget = await this.getDailyBudget();
          const current = await this.getDailySpend();

          if (maxBudget > 0 && current + estimatedCostUsd > maxBudget) {
            resolve({
              allowed: false,
              reason: "Global daily inference budget exhausted. Protocol yield limits reached for current epoch.",
            });
            return;
          }

          const newSpend = current + estimatedCostUsd;
          const key = this.getTodayKey();
          await redis.set(key, newSpend.toString(), 2 * 24 * 60 * 60);

          const ratio = maxBudget > 0 ? newSpend / maxBudget : 0;
          if (ratio >= this.alertThresholdRatio && ratio < 1.0) {
            console.warn(
              `[BudgetGuard] ⚠️ Global daily inference spend reached ${(ratio * 100).toFixed(1)}% ($${newSpend.toFixed(4)} / $${maxBudget.toFixed(4)})`,
            );
          } else if (ratio >= 1.0) {
            console.error(
              `[BudgetGuard] 🛑 Global daily inference budget EXHAUSTED ($${newSpend.toFixed(4)} / $${maxBudget.toFixed(4)})`,
            );
          }

          resolve({ allowed: true });
        } catch {
          resolve({ allowed: false, reason: "Budget check failed" });
        }
      });
    });
  }

  async checkCanSpend(estimatedCostUsd: number): Promise<{ allowed: boolean; reason?: string }> {
    const current = await this.getDailySpend();
    const maxBudget = await this.getDailyBudget();

    if (maxBudget > 0 && current + estimatedCostUsd > maxBudget) {
      return {
        allowed: false,
        reason: "Global daily inference budget exhausted. Protocol yield limits reached for current epoch.",
      };
    }

    return { allowed: true };
  }
}

export const budgetGuard = new BudgetGuardService();
