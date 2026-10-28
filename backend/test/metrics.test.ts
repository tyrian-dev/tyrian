import { describe, expect, test } from "bun:test";
import app from "../src/app";
import { metricsService } from "../src/services/metrics";

describe("Tyrian Observability & Prometheus Metrics Suite (OPS-OBS)", () => {
  test("GET /metrics returns standard Prometheus exposition format (OPS-OBS-001 / OPS-OBS-008)", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);

    const contentType = res.headers.get("content-type") || "";
    expect(contentType).toContain("text/plain");

    const text = await res.text();
    expect(text).toContain("# HELP tyrian_uptime_seconds");
    expect(text).toContain("# TYPE tyrian_uptime_seconds gauge");
    expect(text).toContain("tyrian_uptime_seconds");
    expect(text).toContain("tyrian_daily_budget_spend_usd");
    expect(text).toContain("tyrian_daily_budget_cap_usd");
    expect(text).toContain("tyrian_indexer_reconciliation_diff");
  });

  test("GET /api/metrics/summary returns structured JSON telemetry", async () => {
    const res = await app.request("/api/metrics/summary");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(typeof data.uptimeSeconds).toBe("number");
    expect(typeof data.http.totalRequests).toBe("number");
    expect(typeof data.gateway.totalRequests).toBe("number");
    expect(typeof data.budget.dailySpendUsd).toBe("number");
    expect(typeof data.budget.dailyBudgetCapUsd).toBe("number");
    expect(typeof data.reconciliation.lastDiff).toBe("number");
  });

  test("HTTP requests automatically increment Prometheus counters", async () => {
    // Hit /health
    await app.request("/health");

    const metricsRes = await app.request("/metrics");
    const text = await metricsRes.text();

    expect(text).toContain('tyrian_http_requests_total{method="GET",path="/health",status="200"}');
  });

  test("Gateway metrics record tokens, spend, and errors", async () => {
    metricsService.recordGatewayRequest("anthropic/claude-3.5-sonnet", 200, 0.0015, 100, 200);
    metricsService.recordQuotaExceeded();
    metricsService.recordRateLimitHit("ip");
    metricsService.recordUpstreamError("502");

    const summary = await metricsService.getSummary();
    expect(summary.gateway.totalPromptTokens).toBeGreaterThanOrEqual(100);
    expect(summary.gateway.totalCompletionTokens).toBeGreaterThanOrEqual(200);
    expect(summary.gateway.quotaExceededCount).toBeGreaterThanOrEqual(1);

    const metricsRes = await app.request("/metrics");
    const text = await metricsRes.text();
    expect(text).toContain('tyrian_gateway_requests_total{model="anthropic/claude-3.5-sonnet",status="200"}');
    expect(text).toContain('tyrian_gateway_tokens_total{type="prompt"}');
    expect(text).toContain("tyrian_gateway_quota_exceeded_total");
    expect(text).toContain('tyrian_rate_limit_hits_total{type="ip"}');
    expect(text).toContain('tyrian_upstream_errors_total{error="502"}');
  });

  test("Reconciliation and epoch metrics are updated on gauge", async () => {
    metricsService.setReconciliationDiff(0);
    metricsService.setEpochMetrics(450, 12.5);

    const metricsRes = await app.request("/metrics");
    const text = await metricsRes.text();

    expect(text).toContain("tyrian_indexer_reconciliation_diff 0");
    expect(text).toContain("tyrian_epoch_last_duration_ms 450");
    expect(text).toContain("tyrian_epoch_last_allocated_usd 12.500000");
  });
});
