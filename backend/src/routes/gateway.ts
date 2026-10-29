import { Hono } from "hono";
import type { Context } from "hono";
import crypto from "node:crypto";
import { redis } from "../services/redis";
import { openRouter, ALLOWED_MODELS } from "../services/openrouter";
import { readSession } from "../services/session";
import { quotaService } from "../services/quota";
import { PriceUnavailableError } from "../services/pricing";
import { decryptSecret } from "../services/crypto";
import { dbService } from "../services/db";
import { budgetGuard } from "../services/budget";
import { metricsService } from "../services/metrics";
import { gatewayRateLimiter } from "../middleware/security";
import { geoGate } from "../middleware/geo";

export const gatewayRouter = new Hono();

const PLAYGROUND_SESSION_KEY = "tyr_live_playground_session";

interface GatewayCaller {
  userAddress: string;
  /** Decrypted OpenRouter sub-key. Absent only for session/playground callers. */
  subKey?: string;
  source: "session" | "api_key" | "playground";
}

// Extract API key from Authorization header
async function authenticateApiKey(authHeader?: string): Promise<GatewayCaller | null> {
  if (!authHeader || !authHeader.startsWith("Bearer tyr_live_")) {
    return null;
  }

  const rawKey = authHeader.replace("Bearer ", "").trim();

  // The internal playground key is a local-development convenience only. It
  // must never authenticate a production gateway.
  if (rawKey === PLAYGROUND_SESSION_KEY) {
    if (process.env.NODE_ENV === "production") return null;
    return { userAddress: "0x0000000000000000000000000000000000000000", source: "playground" };
  }

  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  let cached = await redis.get(`tyrian:key:${keyHash}`);
  if (!cached) {
    // Fallback to Postgres database if not in Redis cache
    const dbKey = await dbService.getApiKeyByHash(keyHash);
    if (!dbKey) return null;
    cached = JSON.stringify({
      userAddress: dbKey.userAddress,
      isRevoked: dbKey.isRevoked,
      name: dbKey.name,
    });
    await redis.set(`tyrian:key:${keyHash}`, cached);
  }

  const keyData = JSON.parse(cached);
  if (keyData.isRevoked) return null;

  let subKey: string | undefined;
  if (typeof keyData.subKey === "string" && keyData.subKey.length > 0) {
    try {
      subKey = decryptSecret(keyData.subKey);
    } catch (err) {
      // A broken sub-key must fail closed, not silently fall back to the
      // platform key.
      console.error("[Gateway] Failed to decrypt stored OpenRouter sub-key:", err);
    }
  }

  return { userAddress: keyData.userAddress, subKey, source: "api_key" };
}

async function authenticateRequest(c: Context): Promise<GatewayCaller | null> {
  const session = await readSession(c);
  if (session) {
    return { userAddress: session.session.address, source: "session" };
  }

  return authenticateApiKey(c.req.header("Authorization"));
}

/**
 * 1. POST /v1/chat/completions (OpenAI Compatible - BE-GW-001, BE-GW-005, BE-GW-010, BE-GW-011, BE-AUTH-007)
 */
gatewayRouter.post(
  "/chat/completions",
  geoGate,
  gatewayRateLimiter(60, 60),
  async (c) => {
  const auth = await authenticateRequest(c);
  if (!auth) {
    metricsService.recordGatewayRequest("unknown", 401);
    return c.json(
      {
        error: {
          message: "Sign in or provide a valid Tyrian API key.",
          type: "invalid_request_error",
        },
      },
      401,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const modelId = body.model;

  if (!modelId || !openRouter.isModelAllowed(modelId)) {
    metricsService.recordGatewayRequest(modelId || "invalid", 400);
    return c.json(
      { error: { message: `Model '${modelId}' is not in the Tyrian allowlist.`, type: "invalid_request_error" } },
      400,
    );
  }

  // Pre-flight check 1: Global Budget Guard atomic reserve (BE-GW-011)
  const estimatedCost = 0.0005; // $0.0005 minimum reservation
  const budgetCheck = await budgetGuard.reserveBudget(estimatedCost);
  if (!budgetCheck.allowed) {
    metricsService.recordRateLimitHit("key");
    metricsService.recordGatewayRequest(modelId, 429);
    return c.json(
      {
        error: {
          message: budgetCheck.reason || "Global daily inference budget exhausted. Protocol yield limits reached.",
          type: "global_budget_exhausted",
          code: "global_budget_exhausted",
        },
      },
      429,
    );
  }

  // Pre-flight check 2: Strict individual quota verification from indexer / Redis.
  // A missing or stale price fails closed: no quota is inferred from guessed USD
  // values, the request is refused with 503.
  let quota: Awaited<ReturnType<typeof quotaService.getUserQuota>>;
  try {
    quota = await quotaService.getUserQuota(auth.userAddress);
  } catch (err) {
    if (err instanceof PriceUnavailableError) {
      void budgetGuard.recordRefund(estimatedCost);
      metricsService.recordUpstreamError("price_unavailable");
      return c.json(
        {
          error: {
            message:
              "Quota cannot be computed because an on-chain price is unavailable. Retry once the oracle is healthy.",
            type: "price_unavailable",
            code: "price_unavailable",
            asset: err.symbol,
          },
        },
        503,
      );
    }
    throw err;
  }
  const remaining = quota.remainingUsd;

  // Reject if user has zero quota or has exhausted quota
  if (remaining <= 0.0001) {
    // Refund budget guard reservation if user has no personal quota
    void budgetGuard.recordRefund(estimatedCost);
    metricsService.recordQuotaExceeded();
    metricsService.recordGatewayRequest(modelId, 402);
    return c.json(
      {
        error: {
          message: "Daily inference quota exceeded. Stake more assets or wait for 00:00 UTC epoch reset.",
          type: "quota_exceeded",
          code: "quota_exceeded",
        },
      },
      402,
    );
  }

  // Deduct estimated nominal fee or minimum charge from user's quota
  const startTime = Date.now();
  await redis.deductQuota(auth.userAddress, estimatedCost);

  let response: Response;
  try {
    // Per-key callers must use their own sub-key. Only a session-authenticated
    // playground request may use the platform credential, and an empty key
    // fails closed with 503 from the provider service.
    const providerKey =
      auth.subKey ??
      (auth.source === "session" ? openRouter.getPlatformApiKey() : "");

    // Forward to OpenRouter / Mock
    response = await openRouter.executeChatCompletion({
      model: modelId,
      messages: body.messages || [],
      stream: body.stream ?? true,
      max_tokens: body.max_tokens,
      apiKey: providerKey,
      provider: body.provider,
    });

    if (!response.ok && response.status >= 500) {
      // Rollback quota and budget guard if upstream fails (REL-QA-008)
      await redis.refundQuota(auth.userAddress, estimatedCost);
      void budgetGuard.recordRefund(estimatedCost);
      metricsService.recordUpstreamError(response.status.toString());
      metricsService.recordGatewayRequest(modelId, response.status);
      const upstreamBody = await response.json().catch(() => null);
      return c.json(
        {
          error: {
            message:
              upstreamBody?.error?.message ||
              "Upstream AI model provider temporarily unavailable",
            type: upstreamBody?.error?.type || "upstream_error",
            code: upstreamBody?.error?.code || response.status,
          },
        },
        (response.status >= 500 && response.status <= 504 ? response.status : 502) as 502 | 503,
      );
    }
  } catch (err) {
    // Rollback on exception
    await redis.refundQuota(auth.userAddress, estimatedCost);
    void budgetGuard.recordRefund(estimatedCost);
    metricsService.recordUpstreamError("500");
    metricsService.recordGatewayRequest(modelId, 500);
    console.error("[GatewayRouter] Upstream error:", err);
    return c.json(
      {
        error: {
          message: "Internal gateway processing error",
          type: "gateway_error",
          code: 500,
        },
      },
      500,
    );
  }

  // Log inference metadata to persistent Postgres storage (no prompt content, metadata only)
  const latencyMs = Date.now() - startTime;
  metricsService.recordGatewayRequest(modelId, response.status, estimatedCost, 15, 25);
  void dbService.logUsage({
    userAddress: auth.userAddress,
    model: modelId,
    promptTokens: 15,
    completionTokens: 25,
    costUsd: estimatedCost,
    latencyMs,
  });

  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-cache",
      "X-Tyrian-Quota-Remaining": Math.max(0, remaining - estimatedCost).toFixed(6),
    },
  });
});

/**
 * 2. GET /v1/models (Model allowlist + pricing)
 */
gatewayRouter.get("/models", async (c) => {
  const { models, source } = await openRouter.getLiveModels();

  const formattedModels = models.map((m) => {
    const promptPerToken = (m.pricing.promptTokenPriceUsd / 1_000_000).toFixed(8);
    const completionPerToken = (m.pricing.completionTokenPriceUsd / 1_000_000).toFixed(8);
    const provider = m.id.split("/")[0] || "unknown";

    return {
      id: m.id,
      name: m.name,
      object: "model",
      created: 1718800000,
      owned_by: provider,
      permission: [],
      root: m.id,
      context_length: m.contextLength,
      pricing: {
        prompt: promptPerToken,
        completion: completionPerToken,
        promptTokenPriceUsd: m.pricing.promptTokenPriceUsd,
        completionTokenPriceUsd: m.pricing.completionTokenPriceUsd,
      },
      top_provider: {
        context_length: m.contextLength,
        max_completion_tokens: Math.min(8192, m.contextLength),
      },
    };
  });

  return c.json({ object: "list", data: formattedModels, source });
});

/**
 * 3. GET /v1/quota and GET /api/quota handler (Brief §3 F4 / GAP-013)
 */
export async function handleGetQuota(c: Context) {
  const auth = await authenticateRequest(c);
  const addressParam = c.req.query("address");
  const targetAddress = auth?.userAddress || addressParam;

  if (!targetAddress) {
    return c.json({ error: "Missing authorization or address parameter" }, 400);
  }

  let quota: Awaited<ReturnType<typeof quotaService.getUserQuota>>;
  try {
    quota = await quotaService.getUserQuota(targetAddress);
  } catch (err) {
    if (err instanceof PriceUnavailableError) {
      return c.json(
        {
          error: "Price unavailable",
          type: "price_unavailable",
          code: "price_unavailable",
          asset: err.symbol,
        },
        503,
      );
    }
    throw err;
  }
  return c.json(quota);
}

gatewayRouter.get("/quota", handleGetQuota);

/**
 * 4. GET /v1/usage
 */
gatewayRouter.get("/usage", async (c) => {
  const auth = await authenticateRequest(c);
  if (!auth) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const summary = await dbService.getUserUsageSummary(auth.userAddress);

  return c.json({
    userAddress: auth.userAddress,
    period: "last_30_days",
    totalTokens: summary.totalTokens,
    totalCostUsd: summary.totalCostUsd,
    requestCount: summary.requestCount,
    dailyPoints: summary.dailyPoints,
    providerMix: summary.providerMix,
  });
});

/**
 * 5. GET /v1/budget/status (BE-GW-011 Global Budget Guard status)
 */
gatewayRouter.get("/budget/status", async (c) => {
  const spend = await budgetGuard.getDailySpend();
  const budget = await budgetGuard.getDailyBudget();
  const ratio = budget > 0 ? spend / budget : 0;

  return c.json({
    todaySpendUsd: spend,
    dailyBudgetUsd: budget,
    utilizationRatio: ratio,
    alertThreshold: 0.8,
    status: ratio >= 1.0 ? "exhausted" : ratio >= 0.8 ? "alert" : "normal",
  });
});
