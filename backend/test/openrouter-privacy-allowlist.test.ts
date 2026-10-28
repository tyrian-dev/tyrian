import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { OpenRouterService, ALLOWED_MODELS } from "../src/services/openrouter";

describe("OpenRouter Privacy & Allowlist Suite (GAP-009 & GAP-010 / Brief §3 & §5)", () => {
  let service: OpenRouterService;
  let capturedPayload: any = null;
  const originalEnv = process.env.MODEL_ALLOWLIST;
  const originalMock = process.env.MOCK_INFERENCE;

  beforeEach(() => {
    capturedPayload = null;
    delete process.env.MODEL_ALLOWLIST;
    process.env.MOCK_INFERENCE = "false"; // Disable mock inference to inspect payload

    service = new OpenRouterService();
    service.configure({
      apiKey: "test-api-key",
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.body) {
          capturedPayload = JSON.parse(init.body as string);
        }
        return new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), { status: 200 });
      },
    });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MODEL_ALLOWLIST = originalEnv;
    } else {
      delete process.env.MODEL_ALLOWLIST;
    }
    if (originalMock !== undefined) {
      process.env.MOCK_INFERENCE = originalMock;
    }
  });

  describe("GAP-009: Provider Privacy & Zero Data Retention", () => {
    it("always injects provider.data_collection = 'deny' into OpenRouter completions request", async () => {
      await service.executeChatCompletion({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "Hello privacy" }],
        apiKey: "user-sub-key-123",
      });

      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload.provider).toBeDefined();
      expect(capturedPayload.provider.data_collection).toBe("deny");
    });

    it("prevents caller from overriding data_collection = 'deny'", async () => {
      await service.executeChatCompletion({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "Test override" }],
        apiKey: "user-sub-key-123",
        provider: {
          data_collection: "allow", // Attempted override
          require_parameters: true,
        },
      });

      expect(capturedPayload).not.toBeNull();
      // data_collection must stay locked to 'deny'
      expect(capturedPayload.provider.data_collection).toBe("deny");
      expect(capturedPayload.provider.require_parameters).toBe(true);
    });
  });

  describe("GAP-010: Dynamic MODEL_ALLOWLIST from Environment", () => {
    it("restricts allowed models based on comma-separated MODEL_ALLOWLIST", () => {
      process.env.MODEL_ALLOWLIST = "anthropic/*,deepseek/deepseek-chat";

      expect(service.isModelAllowed("anthropic/claude-3.5-sonnet")).toBe(true);
      expect(service.isModelAllowed("anthropic/claude-sonnet-4.5")).toBe(true);
      expect(service.isModelAllowed("deepseek/deepseek-chat")).toBe(true);
      // openai and google models should NOT be allowed
      expect(service.isModelAllowed("openai/gpt-4o")).toBe(false);
      expect(service.isModelAllowed("google/gemini-2.5-flash")).toBe(false);
    });

    it("supports JSON array string in MODEL_ALLOWLIST", () => {
      process.env.MODEL_ALLOWLIST = JSON.stringify(["openai/gpt-4o", "meta-llama/*"]);

      expect(service.isModelAllowed("openai/gpt-4o")).toBe(true);
      expect(service.isModelAllowed("meta-llama/llama-3.3-70b-instruct")).toBe(true);
      expect(service.isModelAllowed("anthropic/claude-3.5-sonnet")).toBe(false);
    });

    it("falls back to default allowlist when MODEL_ALLOWLIST is empty or malformed", () => {
      process.env.MODEL_ALLOWLIST = "";
      expect(service.isModelAllowed("anthropic/claude-3.5-sonnet")).toBe(true);
      expect(service.isModelAllowed("openai/gpt-4o")).toBe(true);

      process.env.MODEL_ALLOWLIST = "{ invalid json :::";
      expect(service.isModelAllowed("anthropic/claude-3.5-sonnet")).toBe(true);
    });

    it("filters getModels() according to dynamic allowlist", () => {
      process.env.MODEL_ALLOWLIST = "deepseek/*";
      const models = service.getModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.id.startsWith("deepseek/"))).toBe(true);
    });
  });
});
