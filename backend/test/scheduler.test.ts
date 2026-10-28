import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { protocolScheduler } from "../src/cron/scheduler";
import { alertService } from "../src/services/alert";
import { metricsService } from "../src/services/metrics";
import app from "../src/app";

describe("Tyrian Background Scheduler & Alerting Suite (OPS-SCHED / OPS-OBS-009)", () => {
  beforeEach(() => {
    alertService.clearAlerts();
  });

  afterEach(() => {
    protocolScheduler.stop();
  });

  test("ProtocolScheduler starts and stops cleanly", () => {
    protocolScheduler.start();
    let status = protocolScheduler.getStatus();
    expect(status.isRunning).toBe(true);

    protocolScheduler.stop();
    status = protocolScheduler.getStatus();
    expect(status.isRunning).toBe(false);
  });

  test("runPeriodicReconciliation updates Prometheus diff gauge and verifies solvency", async () => {
    const report = await protocolScheduler.runPeriodicReconciliation();
    expect(report).toBeDefined();

    const metricsRes = await app.request("/metrics");
    const text = await metricsRes.text();
    expect(text).toContain("tyrian_indexer_reconciliation_diff");
  }, 20000);

  test("runScheduledEpoch redistributes quotas and updates duration/allocated gauges", async () => {
    const summary = await protocolScheduler.runScheduledEpoch();
    if (summary) {
      expect(summary.timestamp).toBeDefined();
      expect(typeof summary.totalDistributedQuotaUsd).toBe("number");

      const metricsRes = await app.request("/metrics");
      const text = await metricsRes.text();
      expect(text).toContain("tyrian_epoch_last_duration_ms");
      expect(text).toContain("tyrian_epoch_last_allocated_usd");
    }
  }, 20000);

  test("alertService stores events and debounce prevents duplicate spam", async () => {
    // 1. First alert should succeed
    const a1 = await alertService.dispatchAlert(
      "BUDGET_WARNING",
      "WARNING",
      "Daily spend high",
      "Spend reached 80%",
      { spend: 80 },
    );
    expect(a1).not.toBeNull();
    expect(alertService.getRecentAlerts().length).toBe(1);

    // 2. Immediate duplicate of same type should be debounced by cooldown
    const a2 = await alertService.dispatchAlert(
      "BUDGET_WARNING",
      "WARNING",
      "Daily spend high",
      "Spend reached 80%",
    );
    expect(a2).toBeNull();
    expect(alertService.getRecentAlerts().length).toBe(1);

    // 3. Different alert type should pass through
    const a3 = await alertService.dispatchAlert(
      "CONTRACT_PAUSED",
      "CRITICAL",
      "Vault paused",
      "Guardian triggered emergency pause",
    );
    expect(a3).not.toBeNull();
    expect(alertService.getRecentAlerts().length).toBe(2);

    // 4. Exposed via GET /api/metrics/alerts
    const res = await app.request("/api/metrics/alerts");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.alerts.length).toBe(2);
    expect(data.alerts[0].type).toBe("CONTRACT_PAUSED");
  });
});
