import { budgetGuard } from "./budget";
import { treasuryService } from "./treasury";
import { reconciliationService } from "./reconciliation";

export interface MetricsSummary {
  uptimeSeconds: number;
  http: {
    totalRequests: number;
    requestsByPath: Record<string, number>;
  };
  gateway: {
    totalRequests: number;
    totalSpendUsd: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    activeStreams: number;
    quotaExceededCount: number;
    rateLimitedCount: number;
    upstreamErrorsCount: number;
  };
  budget: {
    dailySpendUsd: number;
    dailyBudgetCapUsd: number;
    utilizationRatio: number;
  };
  reconciliation: {
    lastDiff: number;
  };
  auth: {
    operations: Record<string, number>;
  };
}

export class MetricsService {
  private startTime = Date.now();
  private httpRequests = new Map<string, number>();
  private gatewayRequests = new Map<string, number>();
  private promptTokens = 0;
  private completionTokens = 0;
  private totalSpendUsd = 0;
  private activeStreamsCount = 0;
  private quotaExceededHits = 0;
  private rateLimitHits = new Map<string, number>();
  private upstreamErrors = new Map<string, number>();
  private authOperations = new Map<string, number>();
  private lastReconciliationDiff = 0;
  private lastEpochDurationMs = 0;
  private lastEpochAllocatedUsd = 0;

  recordHttpRequest(method: string, path: string, status: number): void {
    // Group parameterized paths to prevent cardinality explosion
    const normalizedPath = path
      .replace(/\/positions\/view\/0x[a-fA-F0-9]+/g, "/positions/view/:address")
      .replace(/\/keys\/[a-zA-Z0-9_-]+/g, "/keys/:id");
    const key = `${method.toUpperCase()}_${normalizedPath}_${status}`;
    this.httpRequests.set(key, (this.httpRequests.get(key) || 0) + 1);
  }

  recordGatewayRequest(
    model: string,
    status: number,
    costUsd: number = 0,
    promptToks: number = 0,
    completionToks: number = 0,
  ): void {
    const key = `${model}_${status}`;
    this.gatewayRequests.set(key, (this.gatewayRequests.get(key) || 0) + 1);
    this.totalSpendUsd += costUsd;
    this.promptTokens += promptToks;
    this.completionTokens += completionToks;
  }

  recordRateLimitHit(type: "ip" | "key"): void {
    this.rateLimitHits.set(type, (this.rateLimitHits.get(type) || 0) + 1);
  }

  recordQuotaExceeded(): void {
    this.quotaExceededHits++;
  }

  recordUpstreamError(type: string): void {
    this.upstreamErrors.set(type, (this.upstreamErrors.get(type) || 0) + 1);
  }

  recordAuthOp(op: string, success: boolean): void {
    const key = `${op}_${success ? "success" : "failure"}`;
    this.authOperations.set(key, (this.authOperations.get(key) || 0) + 1);
  }

  incActiveStreams(): void {
    this.activeStreamsCount++;
  }

  decActiveStreams(): void {
    if (this.activeStreamsCount > 0) {
      this.activeStreamsCount--;
    }
  }

  setReconciliationDiff(diff: number): void {
    this.lastReconciliationDiff = diff;
  }

  setEpochMetrics(durationMs: number, allocatedUsd: number): void {
    this.lastEpochDurationMs = durationMs;
    this.lastEpochAllocatedUsd = allocatedUsd;
  }

  async getSummary(): Promise<MetricsSummary> {
    const dailySpend = await budgetGuard.getDailySpend();
    const dailyCap = await budgetGuard.getDailyBudget();
    const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);

    let totalHttp = 0;
    const requestsByPath: Record<string, number> = {};
    for (const [key, count] of this.httpRequests.entries()) {
      totalHttp += count;
      requestsByPath[key] = count;
    }

    let totalGateway = 0;
    for (const count of this.gatewayRequests.values()) {
      totalGateway += count;
    }

    let rateLimitedTotal = 0;
    for (const count of this.rateLimitHits.values()) {
      rateLimitedTotal += count;
    }

    let upstreamErrorTotal = 0;
    for (const count of this.upstreamErrors.values()) {
      upstreamErrorTotal += count;
    }

    const authOps: Record<string, number> = {};
    for (const [op, count] of this.authOperations.entries()) {
      authOps[op] = count;
    }

    return {
      uptimeSeconds: uptimeSec,
      http: {
        totalRequests: totalHttp,
        requestsByPath,
      },
      gateway: {
        totalRequests: totalGateway,
        totalSpendUsd: this.totalSpendUsd,
        totalPromptTokens: this.promptTokens,
        totalCompletionTokens: this.completionTokens,
        activeStreams: this.activeStreamsCount,
        quotaExceededCount: this.quotaExceededHits,
        rateLimitedCount: rateLimitedTotal,
        upstreamErrorsCount: upstreamErrorTotal,
      },
      budget: {
        dailySpendUsd: dailySpend,
        dailyBudgetCapUsd: dailyCap,
        utilizationRatio: dailyCap > 0 ? dailySpend / dailyCap : 0,
      },
      reconciliation: {
        lastDiff: this.lastReconciliationDiff,
      },
      auth: {
        operations: authOps,
      },
    };
  }

  async toPrometheusFormat(): Promise<string> {
    const lines: string[] = [];
    const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);

    // Process & System
    lines.push("# HELP tyrian_uptime_seconds Total runtime in seconds");
    lines.push("# TYPE tyrian_uptime_seconds gauge");
    lines.push(`tyrian_uptime_seconds ${uptimeSec}`);

    // HTTP Requests Total
    lines.push("# HELP tyrian_http_requests_total Total number of HTTP requests");
    lines.push("# TYPE tyrian_http_requests_total counter");
    for (const [key, val] of this.httpRequests.entries()) {
      const parts = key.split("_");
      const method = parts[0];
      const status = parts[parts.length - 1];
      const path = parts.slice(1, -1).join("_");
      lines.push(`tyrian_http_requests_total{method="${method}",path="${path}",status="${status}"} ${val}`);
    }

    // Gateway Requests Total
    lines.push("# HELP tyrian_gateway_requests_total Total AI inference completions requests");
    lines.push("# TYPE tyrian_gateway_requests_total counter");
    for (const [key, val] of this.gatewayRequests.entries()) {
      const [model, status] = key.split("_");
      lines.push(`tyrian_gateway_requests_total{model="${model}",status="${status}"} ${val}`);
    }

    // Gateway Tokens
    lines.push("# HELP tyrian_gateway_tokens_total Total prompt and completion tokens processed");
    lines.push("# TYPE tyrian_gateway_tokens_total counter");
    lines.push(`tyrian_gateway_tokens_total{type="prompt"} ${this.promptTokens}`);
    lines.push(`tyrian_gateway_tokens_total{type="completion"} ${this.completionTokens}`);

    // Gateway Spend USD Total
    lines.push("# HELP tyrian_gateway_spend_usd_total Cumulative inference spend in USD");
    lines.push("# TYPE tyrian_gateway_spend_usd_total counter");
    lines.push(`tyrian_gateway_spend_usd_total ${this.totalSpendUsd.toFixed(6)}`);

    // Active Streams Gauge
    lines.push("# HELP tyrian_gateway_active_streams Current active SSE streaming connections");
    lines.push("# TYPE tyrian_gateway_active_streams gauge");
    lines.push(`tyrian_gateway_active_streams ${this.activeStreamsCount}`);

    // Quota Exceeded & Rate Limit Counters
    lines.push("# HELP tyrian_gateway_quota_exceeded_total Total 402 quota exceeded rejections");
    lines.push("# TYPE tyrian_gateway_quota_exceeded_total counter");
    lines.push(`tyrian_gateway_quota_exceeded_total ${this.quotaExceededHits}`);

    lines.push("# HELP tyrian_rate_limit_hits_total Total requests rejected due to rate limiting");
    lines.push("# TYPE tyrian_rate_limit_hits_total counter");
    for (const [type, val] of this.rateLimitHits.entries()) {
      lines.push(`tyrian_rate_limit_hits_total{type="${type}"} ${val}`);
    }

    // Upstream Errors Counter
    lines.push("# HELP tyrian_upstream_errors_total Total errors encountered when contacting OpenRouter");
    lines.push("# TYPE tyrian_upstream_errors_total counter");
    for (const [type, val] of this.upstreamErrors.entries()) {
      lines.push(`tyrian_upstream_errors_total{error="${type}"} ${val}`);
    }

    // Budget Guard Gauges
    const dailySpend = await budgetGuard.getDailySpend();
    const dailyCap = await budgetGuard.getDailyBudget();
    lines.push("# HELP tyrian_daily_budget_spend_usd Current UTC daily inference spend in USD");
    lines.push("# TYPE tyrian_daily_budget_spend_usd gauge");
    lines.push(`tyrian_daily_budget_spend_usd ${dailySpend.toFixed(6)}`);

    lines.push("# HELP tyrian_daily_budget_cap_usd Current UTC daily inference budget ceiling in USD");
    lines.push("# TYPE tyrian_daily_budget_cap_usd gauge");
    lines.push(`tyrian_daily_budget_cap_usd ${dailyCap.toFixed(6)}`);

    // Epoch Gauges
    lines.push("# HELP tyrian_epoch_last_duration_ms Last epoch computation runtime in ms");
    lines.push("# TYPE tyrian_epoch_last_duration_ms gauge");
    lines.push(`tyrian_epoch_last_duration_ms ${this.lastEpochDurationMs}`);

    lines.push("# HELP tyrian_epoch_last_allocated_usd Last epoch allocated quota total in USD");
    lines.push("# TYPE tyrian_epoch_last_allocated_usd gauge");
    lines.push(`tyrian_epoch_last_allocated_usd ${this.lastEpochAllocatedUsd.toFixed(6)}`);

    // Reconciliation Diff Gauge
    lines.push("# HELP tyrian_indexer_reconciliation_diff Last on-chain vs indexer share discrepancy");
    lines.push("# TYPE tyrian_indexer_reconciliation_diff gauge");
    lines.push(`tyrian_indexer_reconciliation_diff ${this.lastReconciliationDiff}`);

    // Treasury Metrics
    try {
      const summary = await treasuryService.getTreasurySummary();
      lines.push("# HELP tyrian_treasury_runway_days Estimated treasury operating runway in days");
      lines.push("# TYPE tyrian_treasury_runway_days gauge");
      lines.push(`tyrian_treasury_runway_days ${summary.runwayDays}`);

      lines.push("# HELP tyrian_treasury_balance_usd Current total treasury holdings in USD");
      lines.push("# TYPE tyrian_treasury_balance_usd gauge");
      lines.push(`tyrian_treasury_balance_usd ${summary.treasuryBalanceUsd}`);
    } catch {
      // Treasury read optional if indexer offline during cold start
    }

    // Auth Operations
    lines.push("# HELP tyrian_auth_operations_total Authentication and session lifecycle operations");
    lines.push("# TYPE tyrian_auth_operations_total counter");
    for (const [op, val] of this.authOperations.entries()) {
      const [action, outcome] = op.split("_");
      lines.push(`tyrian_auth_operations_total{action="${action}",outcome="${outcome}"} ${val}`);
    }

    return lines.join("\n") + "\n";
  }
}

export const metricsService = new MetricsService();
