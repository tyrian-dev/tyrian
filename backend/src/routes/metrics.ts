import { Hono } from "hono";
import { metricsService } from "../services/metrics";
import { alertService } from "../services/alert";

export const metricsRouter = new Hono();

// Standard Prometheus Exposition format
metricsRouter.get("/metrics", async (c) => {
  const data = await metricsService.toPrometheusFormat();
  return c.text(data, 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});

// JSON Summary for Admin/Dashboard telemetry
metricsRouter.get("/summary", async (c) => {
  const summary = await metricsService.getSummary();
  return c.json(summary);
});

// Recent Operational Alerts
metricsRouter.get("/alerts", async (c) => {
  const alerts = alertService.getRecentAlerts();
  return c.json({ alerts });
});

// Operational Sentinel Webhook Test Trigger (OPS-OBS-009)
metricsRouter.post("/alerts/test", async (c) => {
  let webhookUrl: string | undefined;
  try {
    const body = await c.req.json();
    if (body && typeof body.webhookUrl === "string") {
      webhookUrl = body.webhookUrl;
    }
  } catch {
    // Body optional, fallback to env webhookUrl
  }

  const result = await alertService.testWebhook(webhookUrl);
  return c.json({
    status: result.success ? "success" : "failed",
    delivery: result,
  }, result.success ? 200 : 502);
});
