import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { alertService, type AlertEvent } from "../src/services/alert";
import { app } from "../src/app";

describe("Tyrian Multi-Channel Alert Sentinel & Webhook Suite (OPS-OBS-009)", () => {
  beforeEach(() => {
    alertService.clearAlerts();
    alertService.setWebhookUrl(null);
  });

  afterEach(() => {
    alertService.clearAlerts();
    alertService.setWebhookUrl(null);
  });

  it("detects webhook provider format correctly from URL", () => {
    expect(alertService.detectFormat("https://discord.com/api/webhooks/12345/abcdef")).toBe("DISCORD");
    expect(alertService.detectFormat("https://discordapp.com/api/webhooks/12345/abcdef")).toBe("DISCORD");
    expect(alertService.detectFormat("https://hooks.slack.com/services/T00/B00/X00")).toBe("SLACK");
    expect(alertService.detectFormat("https://internal.ops.mycorp.com/webhook")).toBe("GENERIC_JSON");
  });

  it("builds compliant Discord embed payload with severity colors", () => {
    const alert: AlertEvent = {
      id: "alert_test_1",
      type: "RECONCILIATION_DIFF",
      severity: "CRITICAL",
      title: "Reconciliation Discrepancy",
      message: "Difference detected between onchain contracts and Ponder indexer.",
      timestamp: "2026-10-28T09:00:00.000Z",
      metadata: { diffAmount: 500, asset: "USDG" },
    };

    const payload = alertService.buildPayload("DISCORD", alert, "🚨") as {
      username: string;
      embeds: Array<{ title: string; color: number; fields: Array<{ name: string; value: string }> }>;
    };

    expect(payload.username).toBe("Tyrian Protocol Sentinel");
    expect(payload.embeds[0].title).toContain("Reconciliation Discrepancy");
    expect(payload.embeds[0].color).toBe(0xff0000); // CRITICAL red
    expect(payload.embeds[0].fields.length).toBe(2);
    expect(payload.embeds[0].fields[0].name).toBe("diffAmount");
    expect(payload.embeds[0].fields[0].value).toBe("500");
  });

  it("builds compliant Slack Block Kit payload", () => {
    const alert: AlertEvent = {
      id: "alert_test_2",
      type: "INDEXER_LAG",
      severity: "WARNING",
      title: "Indexer Block Lag",
      message: "Ponder indexer is lagging by 150 blocks.",
      timestamp: "2026-10-28T09:00:00.000Z",
      metadata: { blockLag: 150 },
    };

    const payload = alertService.buildPayload("SLACK", alert, "⚠️") as {
      text: string;
      blocks: Array<{ type: string; text?: { text: string } }>;
    };

    expect(payload.text).toContain("[WARNING] Indexer Block Lag");
    expect(payload.blocks[0].type).toBe("header");
    expect(payload.blocks[0].text?.text).toContain("Indexer Block Lag");
    expect(payload.blocks[1].type).toBe("section");
    expect(payload.blocks[1].text?.text).toContain("WARNING");
  });

  it("builds standard Generic JSON payload for raw integrations", () => {
    const alert: AlertEvent = {
      id: "alert_test_3",
      type: "BUDGET_WARNING",
      severity: "WARNING",
      title: "Budget 80% Spent",
      message: "Daily epoch inference budget reached 80%.",
      timestamp: "2026-10-28T09:00:00.000Z",
      metadata: { spentUsd: 80, budgetUsd: 100 },
    };

    const payload = alertService.buildPayload("GENERIC_JSON", alert, "⚠️") as Record<string, unknown>;

    expect(payload.id).toBe("alert_test_3");
    expect(payload.type).toBe("BUDGET_WARNING");
    expect(payload.severity).toBe("WARNING");
    expect((payload.metadata as Record<string, unknown>).spentUsd).toBe(80);
  });

  it("delivers alert and records delivery status when webhook is configured", async () => {
    let receivedPayload: unknown = null;

    // Launch temporary local mock receiver server
    const server = Bun.serve({
      port: 0, // OS assigns available ephemeral port
      fetch(req) {
        return req.json().then((body) => {
          receivedPayload = body;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        });
      },
    });

    const mockUrl = `http://localhost:${server.port}/webhook`;
    alertService.setWebhookUrl(mockUrl, "GENERIC_JSON");

    try {
      const alert = await alertService.dispatchAlert(
        "CONTRACT_PAUSED",
        "CRITICAL",
        "Protocol Emergency Pause",
        "Guardian paused the StakeManager contract.",
        { reason: "Security drill" },
        true,
      );

      expect(alert).not.toBeNull();
      expect(alert?.delivery?.delivered).toBe(true);
      expect(alert?.delivery?.attempts).toBe(1);
      expect(alert?.delivery?.format).toBe("GENERIC_JSON");
      expect(receivedPayload).not.toBeNull();
      expect((receivedPayload as Record<string, unknown>).title).toBe("Protocol Emergency Pause");
    } finally {
      server.stop();
    }
  });

  it("retries delivery up to 3 times on destination failure", async () => {
    let callCount = 0;

    const server = Bun.serve({
      port: 0,
      fetch() {
        callCount++;
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    const mockUrl = `http://localhost:${server.port}/error-webhook`;
    alertService.setWebhookUrl(mockUrl);

    try {
      const alert = await alertService.dispatchAlert(
        "UPSTREAM_OUTAGE",
        "CRITICAL",
        "OpenRouter Outage",
        "Upstream inference provider unreachable.",
        undefined,
        true,
      );

      expect(alert).not.toBeNull();
      expect(alert?.delivery?.delivered).toBe(false);
      expect(alert?.delivery?.attempts).toBe(3);
      expect(callCount).toBe(3);
      expect(alert?.delivery?.error).toContain("500");
    } finally {
      server.stop();
    }
  });

  it("POST /alerts/test triggers live test webhook and returns 200 on success", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      },
    });

    const mockUrl = `http://localhost:${server.port}/test-webhook`;

    try {
      const res = await app.request("/api/metrics/alerts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: mockUrl }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("success");
      expect(json.delivery.success).toBe(true);
      expect(json.delivery.format).toBe("GENERIC_JSON");
    } finally {
      server.stop();
    }
  });
});
