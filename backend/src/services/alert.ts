export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export type AlertType =
  | "BUDGET_WARNING"
  | "BUDGET_EXHAUSTED"
  | "RECONCILIATION_DIFF"
  | "UPSTREAM_OUTAGE"
  | "CONTRACT_PAUSED"
  | "INDEXER_LAG"
  | "TEST_ALERT";

export type WebhookFormat = "DISCORD" | "SLACK" | "GENERIC_JSON";

export interface AlertDeliveryStatus {
  delivered: boolean;
  attempts: number;
  format?: WebhookFormat;
  error?: string;
  deliveredAt?: string;
}

export interface AlertEvent {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  delivery?: AlertDeliveryStatus;
}

export class AlertService {
  private webhookUrl: string | null = null;
  private webhookFormat: WebhookFormat | null = null;
  private recentAlerts: AlertEvent[] = [];
  private maxStoredAlerts = 50;
  private lastAlertTimestamps = new Map<AlertType, number>();
  private defaultCooldownMs = 10 * 60 * 1000; // 10 minutes debounce per alert type

  constructor() {
    this.webhookUrl = process.env.ALERT_WEBHOOK_URL || null;
    const envFormat = process.env.ALERT_WEBHOOK_FORMAT?.toUpperCase();
    if (envFormat === "DISCORD" || envFormat === "SLACK" || envFormat === "GENERIC_JSON") {
      this.webhookFormat = envFormat as WebhookFormat;
    }
  }

  setWebhookUrl(url: string | null, format?: WebhookFormat): void {
    this.webhookUrl = url;
    if (format) this.webhookFormat = format;
  }

  getRecentAlerts(): AlertEvent[] {
    return [...this.recentAlerts];
  }

  clearAlerts(): void {
    this.recentAlerts = [];
    this.lastAlertTimestamps.clear();
  }

  detectFormat(url: string): WebhookFormat {
    if (this.webhookFormat) return this.webhookFormat;
    if (url.includes("hooks.slack.com")) return "SLACK";
    if (url.includes("discord.com/api/webhooks") || url.includes("discordapp.com/api/webhooks")) return "DISCORD";
    return "GENERIC_JSON";
  }

  buildPayload(format: WebhookFormat, alert: AlertEvent, icon: string): unknown {
    const fields = alert.metadata
      ? Object.entries(alert.metadata).map(([k, v]) => ({
          name: k,
          value: String(v),
          inline: true,
        }))
      : [];

    switch (format) {
      case "DISCORD":
        return {
          username: "Tyrian Protocol Sentinel",
          avatar_url: "https://tyrian.finance/icon.png",
          embeds: [
            {
              title: `${icon} ${alert.title}`,
              description: alert.message,
              color: alert.severity === "CRITICAL" ? 0xff0000 : alert.severity === "WARNING" ? 0xffa500 : 0x00ff00,
              fields,
              timestamp: alert.timestamp,
            },
          ],
        };

      case "SLACK":
        return {
          text: `${icon} [${alert.severity}] ${alert.title}: ${alert.message}`,
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: `${icon} ${alert.title}` },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Severity:* \`${alert.severity}\`\n*Type:* \`${alert.type}\`\n*Details:* ${alert.message}`,
              },
            },
            ...(fields.length > 0
              ? [
                  {
                    type: "section",
                    fields: fields.slice(0, 10).map((f) => ({
                      type: "mrkdwn",
                      text: `*${f.name}:*\n${f.value}`,
                    })),
                  },
                ]
              : []),
          ],
        };

      case "GENERIC_JSON":
      default:
        return {
          id: alert.id,
          type: alert.type,
          severity: alert.severity,
          title: alert.title,
          message: alert.message,
          timestamp: alert.timestamp,
          metadata: alert.metadata ?? {},
        };
    }
  }

  async sendWithRetry(
    targetUrl: string,
    payload: unknown,
    maxRetries = 3,
  ): Promise<{ delivered: boolean; attempts: number; error?: string }> {
    let lastError = "";
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000), // 5s timeout
        });

        if (response.ok) {
          return { delivered: true, attempts: attempt };
        }

        lastError = `HTTP ${response.status}: ${response.statusText}`;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      // Exponential backoff if more attempts remain
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 150));
      }
    }

    return { delivered: false, attempts: maxRetries, error: lastError };
  }

  async dispatchAlert(
    type: AlertType,
    severity: AlertSeverity,
    title: string,
    message: string,
    metadata?: Record<string, unknown>,
    bypassCooldown = false,
  ): Promise<AlertEvent | null> {
    const now = Date.now();
    const lastSent = this.lastAlertTimestamps.get(type) || 0;

    if (!bypassCooldown && now - lastSent < this.defaultCooldownMs) {
      console.log(`[AlertService] Cooldown active for alert ${type}. Skipping duplicate webhook.`);
      return null;
    }

    const alert: AlertEvent = {
      id: `alert_${now}_${Math.random().toString(36).slice(2, 7)}`,
      type,
      severity,
      title,
      message,
      timestamp: new Date().toISOString(),
      metadata,
    };

    // Store in-memory for Ops dashboard
    this.recentAlerts.unshift(alert);
    if (this.recentAlerts.length > this.maxStoredAlerts) {
      this.recentAlerts.pop();
    }

    this.lastAlertTimestamps.set(type, now);

    // Console notification
    const icon = severity === "CRITICAL" ? "🚨" : severity === "WARNING" ? "⚠️" : "ℹ️";
    console.warn(`[AlertService] ${icon} [${severity}] ${title}: ${message}`);

    // Deliver webhook if configured
    const targetUrl = this.webhookUrl || process.env.ALERT_WEBHOOK_URL;
    if (targetUrl) {
      const format = this.detectFormat(targetUrl);
      const payload = this.buildPayload(format, alert, icon);
      const deliveryResult = await this.sendWithRetry(targetUrl, payload);

      alert.delivery = {
        delivered: deliveryResult.delivered,
        attempts: deliveryResult.attempts,
        format,
        error: deliveryResult.error,
        deliveredAt: deliveryResult.delivered ? new Date().toISOString() : undefined,
      };

      if (!deliveryResult.delivered) {
        console.error(`[AlertService] Failed to deliver alert webhook after ${deliveryResult.attempts} attempts: ${deliveryResult.error}`);
      }
    }

    return alert;
  }

  async testWebhook(overrideUrl?: string): Promise<{ success: boolean; attempts: number; format: WebhookFormat; error?: string }> {
    const targetUrl = overrideUrl || this.webhookUrl || process.env.ALERT_WEBHOOK_URL;
    if (!targetUrl) {
      return { success: false, attempts: 0, format: "GENERIC_JSON", error: "No webhook URL configured" };
    }

    const format = this.detectFormat(targetUrl);
    const testAlert: AlertEvent = {
      id: `test_${Date.now()}`,
      type: "TEST_ALERT",
      severity: "INFO",
      title: "Sentinel Webhook Health Check",
      message: "This is a verified test alert dispatched from Tyrian Cloud Operations Sentinel.",
      timestamp: new Date().toISOString(),
      metadata: { environment: process.env.APP_ENV || "testnet", timestamp: new Date().toISOString() },
    };

    const payload = this.buildPayload(format, testAlert, "🧪");
    const result = await this.sendWithRetry(targetUrl, payload);

    return {
      success: result.delivered,
      attempts: result.attempts,
      format,
      error: result.error,
    };
  }
}

export const alertService = new AlertService();
