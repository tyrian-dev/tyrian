import type { AiModel } from "@shared/types";

export const ALLOWED_MODELS: AiModel[] = [
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    contextLength: 200000,
    pricing: { promptTokenPriceUsd: 3.0, completionTokenPriceUsd: 15.0 },
    isAllowed: true,
  },
  {
    id: "anthropic/claude-3.5-sonnet",
    name: "Claude 3.5 Sonnet",
    contextLength: 200000,
    pricing: { promptTokenPriceUsd: 3.0, completionTokenPriceUsd: 15.0 },
    isAllowed: true,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    contextLength: 128000,
    pricing: { promptTokenPriceUsd: 2.5, completionTokenPriceUsd: 10.0 },
    isAllowed: true,
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    contextLength: 128000,
    pricing: { promptTokenPriceUsd: 0.15, completionTokenPriceUsd: 0.6 },
    isAllowed: true,
  },
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3",
    contextLength: 64000,
    pricing: { promptTokenPriceUsd: 0.14, completionTokenPriceUsd: 0.28 },
    isAllowed: true,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    contextLength: 1000000,
    pricing: { promptTokenPriceUsd: 0.075, completionTokenPriceUsd: 0.3 },
    isAllowed: true,
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B",
    contextLength: 128000,
    pricing: { promptTokenPriceUsd: 0.2, completionTokenPriceUsd: 0.4 },
    isAllowed: true,
  },
  {
    id: "qwen/qwen-2.5-72b-instruct",
    name: "Qwen 2.5 72B",
    contextLength: 128000,
    pricing: { promptTokenPriceUsd: 0.35, completionTokenPriceUsd: 0.4 },
    isAllowed: true,
  },
];

export class OpenRouterService {
  private apiKey: string;
  private mgmtKey: string;
  private cachedLiveModels: AiModel[] | null = null;
  private lastFetchTime: number = 0;
  private fetchImpl: typeof fetch = fetch;

  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY || "";
    this.mgmtKey = process.env.OPENROUTER_MGMT_KEY || "";
  }

  configure(deps: {
    fetchImpl?: typeof fetch;
    apiKey?: string;
    mgmtKey?: string;
    cachedLiveModels?: AiModel[] | null;
  }): void {
    if (deps.fetchImpl !== undefined) this.fetchImpl = deps.fetchImpl;
    if (deps.apiKey !== undefined) this.apiKey = deps.apiKey;
    if (deps.mgmtKey !== undefined) this.mgmtKey = deps.mgmtKey;
    if (deps.cachedLiveModels !== undefined) this.cachedLiveModels = deps.cachedLiveModels;
  }

  /**
   * Reads and parses dynamic MODEL_ALLOWLIST from env (GAP-010 / Brief §3 F8).
   * Supports comma-separated strings or JSON arrays.
   * Returns null on missing or malformed env to allow fail-safe default fallback.
   */
  getConfiguredAllowlist(): string[] | null {
    const raw = process.env.MODEL_ALLOWLIST?.trim();
    if (!raw) return null;

    try {
      if (raw.startsWith("[") || raw.startsWith("{")) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const list = parsed.map((s) => String(s).trim()).filter(Boolean);
          return list.length > 0 ? list : null;
        }
        return null;
      }

      const items = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      // Validate that items look like valid model identifiers or wildcard prefixes
      const validPattern = /^[a-zA-Z0-9_\-\.\*\/]+$/;
      const allValid = items.every((item) => validPattern.test(item));
      if (!allValid || items.length === 0) {
        return null;
      }

      return items;
    } catch (err) {
      console.warn("[OpenRouter] Malformed MODEL_ALLOWLIST in env, falling back to default list:", err);
      return null;
    }
  }

  private matchesAllowlist(modelId: string, patterns: string[]): boolean {
    const idLower = modelId.toLowerCase();
    return patterns.some((pattern) => {
      const p = pattern.toLowerCase();
      if (p.endsWith("/*")) {
        const prefix = p.slice(0, -1);
        return idLower.startsWith(prefix);
      }
      return idLower === p;
    });
  }

  /**
   * Mock inference is opt-in and never implicit. A missing or malformed
   * provider key used to silently select mock mode, which could leak fake
   * completions into production. It is now an explicit flag, disabled in
   * production builds and on mainnet.
   */
  private get isMock(): boolean {
    if (process.env.MOCK_INFERENCE !== "true") return false;
    if (process.env.NODE_ENV === "production") return false;
    return true;
  }

  /** Platform credential for session-authenticated playground traffic. */
  getPlatformApiKey(): string {
    return this.apiKey;
  }

  getModels(): AiModel[] {
    const baseList = this.cachedLiveModels || ALLOWED_MODELS;
    const configured = this.getConfiguredAllowlist();
    if (configured && configured.length > 0) {
      return baseList.filter((m) => this.matchesAllowlist(m.id, configured));
    }
    return baseList;
  }

  async getLiveModels(): Promise<{ models: AiModel[]; source: "live" | "cache" | "curated" }> {
    if (this.isMock) {
      return { models: this.getModels(), source: "curated" };
    }

    const now = Date.now();
    // Cache for 10 minutes
    if (this.cachedLiveModels && (now - this.lastFetchTime < 10 * 60 * 1000)) {
      return { models: this.getModels(), source: "cache" };
    }

    try {
      const res = await this.fetchImpl("https://openrouter.ai/api/v1/models", {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) throw new Error(`OpenRouter models API returned ${res.status}`);
      const json = (await res.json()) as { data?: any[] };
      if (Array.isArray(json.data) && json.data.length > 0) {
        const configured = this.getConfiguredAllowlist();
        const defaultPrefixes = ["openai/", "anthropic/", "google/", "meta-llama/", "qwen/", "deepseek/"];
        const liveList: AiModel[] = [];

        for (const m of json.data) {
          if (!m.id) continue;
          if (configured && configured.length > 0) {
            if (!this.matchesAllowlist(m.id, configured)) continue;
          } else if (!defaultPrefixes.some((p) => m.id.startsWith(p))) {
            continue;
          }
          const promptPrice = +(m.pricing?.prompt ?? 0) * 1e6;
          const completionPrice = +(m.pricing?.completion ?? 0) * 1e6;
          if (isNaN(promptPrice) || isNaN(completionPrice)) continue;

          liveList.push({
            id: m.id,
            name: (m.name || m.id).replace(/^[^:]+:\s*/, ""),
            contextLength: m.context_length || m.top_provider?.context_length || 128000,
            pricing: {
              promptTokenPriceUsd: promptPrice,
              completionTokenPriceUsd: completionPrice,
            },
            isAllowed: true,
          });
        }

        if (liveList.length > 0) {
          this.cachedLiveModels = liveList;
          this.lastFetchTime = now;
          return { models: liveList, source: "live" };
        }
      }
    } catch (err) {
      console.warn("[OpenRouter] Live model fetch failed, using curated allowlist:", err);
    }

    return { models: this.getModels(), source: "curated" };
  }

  isModelAllowed(modelId: string): boolean {
    const configured = this.getConfiguredAllowlist();
    if (configured && configured.length > 0) {
      return this.matchesAllowlist(modelId, configured);
    }

    const list = this.cachedLiveModels || ALLOWED_MODELS;
    return list.some((m) => m.id === modelId && m.isAllowed);
  }

  getModel(modelId: string): AiModel | undefined {
    const list = this.cachedLiveModels || ALLOWED_MODELS;
    return list.find((m) => m.id === modelId);
  }

  /**
   * Fetches current credit balance from OpenRouter API (GAP-008 / Brief §5 & §7).
   * Returns totalCredits, totalUsage, remainingCredits.
   */
  async getCredits(): Promise<{
    totalCredits: number;
    totalUsage: number;
    remainingCredits: number;
  }> {
    if (this.isMock) {
      return { totalCredits: 100.0, totalUsage: 10.0, remainingCredits: 90.0 };
    }

    const key = this.mgmtKey || this.apiKey;
    if (!key) {
      return { totalCredits: 0, totalUsage: 0, remainingCredits: 0 };
    }

    try {
      const res = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        throw new Error(`OpenRouter credits API returned ${res.status}`);
      }

      const json = (await res.json()) as {
        data?: {
          total_credits?: number;
          total_usage?: number;
        };
      };

      const totalCredits = Number(json.data?.total_credits ?? 0);
      const totalUsage = Number(json.data?.total_usage ?? 0);
      const remainingCredits = Math.max(0, totalCredits - totalUsage);

      return { totalCredits, totalUsage, remainingCredits };
    } catch (err) {
      console.warn("[OpenRouter] Failed to fetch credits balance:", err);
      return { totalCredits: 0, totalUsage: 0, remainingCredits: 0 };
    }
  }

  /**
   * Syncs daily credit limit to an OpenRouter sub-key via Management API
   */
  async createOrUpdateSubKey(userAddress: string, dailyLimitUsd: number): Promise<string> {
    if (this.isMock) {
      return `mock_sub_key_${userAddress.slice(0, 8)}`;
    }

    if (!this.mgmtKey) {
      throw new Error("OPENROUTER_MGMT_KEY is not configured; cannot issue a sub-key.");
    }

    const res = await fetch("https://openrouter.ai/api/v1/keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.mgmtKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `tyrian_${userAddress.toLowerCase()}`,
        limit: dailyLimitUsd,
        limit_reset: "daily",
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenRouter Management API error: ${res.statusText}`);
    }

    const data = (await res.json()) as { key: string };
    if (!data.key) {
      throw new Error("OpenRouter Management API returned no sub-key.");
    }
    return data.key;
  }

  /**
   * Executes completion request (streaming SSE or non-streaming).
   *
   * `apiKey` must be the caller's sub-key (or the platform key for an
   * explicitly session-authenticated request). This method never falls back to
   * the platform key when a per-user key is expected: it returns 503
   * `provider_key_unavailable` instead.
   *
   * Enforces Zero Data Retention (Brief §5 / GAP-009 / BE-GW-013) by setting
   * `provider.data_collection: "deny"`.
   */
  async executeChatCompletion(params: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    stream?: boolean;
    max_tokens?: number;
    apiKey?: string;
    provider?: Record<string, unknown>;
    [key: string]: unknown;
  }): Promise<Response> {
    if (this.isMock) {
      return this.generateMockStreamResponse(params.model, params.messages);
    }

    const providerKey = params.apiKey?.trim() || "";
    if (!providerKey) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              "No provider key is available for this request. Create a new Tyrian API key or retry after the provider credentials are restored.",
            type: "provider_key_unavailable",
            code: "provider_key_unavailable",
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    const { apiKey: _ignored, provider: callerProvider, ...payload } = params;
    const finalPayload = {
      ...payload,
      provider: {
        ...(typeof callerProvider === "object" && callerProvider !== null ? callerProvider : {}),
        data_collection: "deny", // Enforces Zero Data Retention (Brief §5 / GAP-009)
      },
    };

    const res = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${providerKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://tyrian.app",
        "X-Title": "Tyrian AI Gateway",
      },
      body: JSON.stringify(finalPayload),
    });

    return res;
  }

  private generateMockStreamResponse(model: string, messages: Array<{ role: string; content: string }>): Response {
    const lastUserMsg = messages[messages.length - 1]?.content || "Hello";
    const replyText = `[Tyrian Gateway (${model})] Response received for: "${lastUserMsg}". Stake verified. Free inference funded by protocol yield.`;

    const encoder = new TextEncoder();
    let interval: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        const words = replyText.split(" ");
        let i = 0;

        interval = setInterval(() => {
          if (i < words.length) {
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: (i === 0 ? "" : " ") + words[i] },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            i++;
          } else {
            // Send final chunk with usage
            const finalChunk = {
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 15,
                completion_tokens: words.length,
                total_tokens: 15 + words.length,
              },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            if (interval) clearInterval(interval);
            interval = null;
            controller.close();
          }
        }, 50);
      },
      cancel() {
        // The client may disconnect mid-stream; stop the interval so it cannot
        // enqueue into a closed controller.
        if (interval) clearInterval(interval);
        interval = null;
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}

export const openRouter = new OpenRouterService();
