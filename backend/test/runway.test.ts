import { describe, it, expect, beforeEach } from "bun:test";
import { RunwayService } from "../src/services/runway";
import { alertService } from "../src/services/alert";
import app from "../src/app";

describe("OpenRouter Inference Balance Runway Monitoring (GAP-008 / Brief §5 & §7)", () => {
  let runway: RunwayService;

  beforeEach(() => {
    alertService.clearAlerts();
    alertService.setWebhookUrl(null);
    runway = new RunwayService();
  });

  it("reports HEALTHY when runway is 14 days or greater without triggering alerts", async () => {
    runway.configure({
      getCredits: async () => ({
        remainingCredits: 100.0,
        totalCredits: 150.0,
        totalUsage: 50.0,
      }),
      getUsage7d: async () => 14.0, // $14 over 7 days = $2.00/day
    });

    const report = await runway.checkInferenceRunway();
    expect(report.remainingCreditsUsd).toBe(100.0);
    expect(report.avgDailySpendUsd).toBe(2.0);
    expect(report.runwayDays).toBe(50);
    expect(report.status).toBe("HEALTHY");
    expect(report.alertSent).toBe(false);

    const alerts = alertService.getRecentAlerts();
    expect(alerts.length).toBe(0);
  });

  it("triggers WARNING alert when runway is less than 14 days but at least 7 days", async () => {
    runway.configure({
      getCredits: async () => ({
        remainingCredits: 20.0,
        totalCredits: 100.0,
        totalUsage: 80.0,
      }),
      getUsage7d: async () => 14.0, // $2.00/day => 10 days runway
    });

    const report = await runway.checkInferenceRunway();
    expect(report.remainingCreditsUsd).toBe(20.0);
    expect(report.avgDailySpendUsd).toBe(2.0);
    expect(report.runwayDays).toBe(10);
    expect(report.status).toBe("WARNING");
    expect(report.alertSent).toBe(true);

    const alerts = alertService.getRecentAlerts();
    expect(alerts.length).toBe(1);
    expect(alerts[0].type).toBe("BUDGET_WARNING");
    expect(alerts[0].severity).toBe("WARNING");
    expect(alerts[0].title).toContain("< 14 Days");
  });

  it("triggers CRITICAL alert when runway is less than 7 days", async () => {
    runway.configure({
      getCredits: async () => ({
        remainingCredits: 10.0,
        totalCredits: 100.0,
        totalUsage: 90.0,
      }),
      getUsage7d: async () => 14.0, // $2.00/day => 5 days runway
    });

    const report = await runway.checkInferenceRunway();
    expect(report.remainingCreditsUsd).toBe(10.0);
    expect(report.avgDailySpendUsd).toBe(2.0);
    expect(report.runwayDays).toBe(5);
    expect(report.status).toBe("CRITICAL");
    expect(report.alertSent).toBe(true);

    const alerts = alertService.getRecentAlerts();
    expect(alerts.length).toBe(1);
    expect(alerts[0].type).toBe("BUDGET_WARNING");
    expect(alerts[0].severity).toBe("CRITICAL");
    expect(alerts[0].title).toContain("< 7 Days");
  });

  it("applies nominal floor spend rate when 7-day usage is zero", async () => {
    runway.configure({
      getCredits: async () => ({
        remainingCredits: 1.0,
        totalCredits: 10.0,
        totalUsage: 9.0,
      }),
      getUsage7d: async () => 0, // no 7-day usage => fallback to $0.05/day
    });

    const report = await runway.checkInferenceRunway();
    expect(report.remainingCreditsUsd).toBe(1.0);
    expect(report.avgDailySpendUsd).toBe(0.05);
    expect(report.runwayDays).toBe(20); // 1.0 / 0.05 = 20 days
    expect(report.status).toBe("HEALTHY");
  });

  it("serves GET /api/treasury/runway endpoint correctly", async () => {
    const res = await app.request("/api/treasury/runway");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("remainingCreditsUsd");
    expect(data).toHaveProperty("avgDailySpendUsd");
    expect(data).toHaveProperty("runwayDays");
    expect(data).toHaveProperty("status");
    expect(["HEALTHY", "WARNING", "CRITICAL"]).toContain(data.status);
  });
});
