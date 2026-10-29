import { afterEach, describe, expect, it } from "bun:test";
import { OpenRouterService } from "../src/services/openrouter";

const ORIGINAL_MOCK = process.env.MOCK_INFERENCE;
const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_MGMT = process.env.OPENROUTER_MGMT_KEY;

afterEach(() => {
  if (ORIGINAL_MOCK === undefined) delete process.env.MOCK_INFERENCE;
  else process.env.MOCK_INFERENCE = ORIGINAL_MOCK;

  if (ORIGINAL_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;

  if (ORIGINAL_MGMT === undefined) delete process.env.OPENROUTER_MGMT_KEY;
  else process.env.OPENROUTER_MGMT_KEY = ORIGINAL_MGMT;
});

describe("OpenRouter fail-closed credentials (BE-GW-012)", () => {
  it("does not enable mock mode just because the provider key is missing", async () => {
    delete process.env.MOCK_INFERENCE;
    delete process.env.OPENROUTER_API_KEY;

    const service = new OpenRouterService();
    const res = await service.executeChatCompletion({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("provider_key_unavailable");
    expect(body.error.type).toBe("provider_key_unavailable");
  });

  it("never falls back to the platform key when no caller key is supplied", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-platform-key";
    delete process.env.MOCK_INFERENCE;

    const service = new OpenRouterService();
    expect(service.getPlatformApiKey()).toBe("sk-or-v1-platform-key");

    const res = await service.executeChatCompletion({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      // apiKey intentionally omitted: an API-key caller must bring its sub-key.
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("provider_key_unavailable");
  });

  it("refuses to issue a sub-key without a management key", async () => {
    delete process.env.MOCK_INFERENCE;
    delete process.env.OPENROUTER_MGMT_KEY;

    const service = new OpenRouterService();
    await expect(
      service.createOrUpdateSubKey("0x1111111111111111111111111111111111111111", 5),
    ).rejects.toThrow("OPENROUTER_MGMT_KEY");
  });

  it("keeps mock inference behind an explicit opt-in", async () => {
    process.env.MOCK_INFERENCE = "true";

    const service = new OpenRouterService();
    const res = await service.executeChatCompletion({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  it("handles both top-level and nested data key formats from OpenRouter Management API", async () => {
    delete process.env.MOCK_INFERENCE;
    process.env.OPENROUTER_MGMT_KEY = "test-mgmt-key";

    const service = new OpenRouterService();

    // Test case A: { data: { key: "sk-or-nested" } }
    service.configure({
      fetchImpl: (async () => {
        return new Response(JSON.stringify({ data: { key: "sk-or-nested-sub-key" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const keyA = await service.createOrUpdateSubKey("0x2222222222222222222222222222222222222222", 10);
    expect(keyA).toBe("sk-or-nested-sub-key");

    // Test case B: { key: "sk-or-top-level" }
    service.configure({
      fetchImpl: (async () => {
        return new Response(JSON.stringify({ key: "sk-or-top-level-sub-key" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const keyB = await service.createOrUpdateSubKey("0x2222222222222222222222222222222222222222", 10);
    expect(keyB).toBe("sk-or-top-level-sub-key");

    // Test case C: zero quota omits limit to prevent OpenRouter 400 Bad Request
    let capturedBody: any = null;
    service.configure({
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        if (init?.body) capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ key: "sk-or-zero-quota-key" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const keyC = await service.createOrUpdateSubKey("0x2222222222222222222222222222222222222222", 0);
    expect(keyC).toBe("sk-or-zero-quota-key");
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.limit).toBeUndefined();
    expect(capturedBody.limit_reset).toBeUndefined();
  });

  it("maps upstream 401/402/429 to clear provider errors rather than misleading user errors", async () => {
    delete process.env.MOCK_INFERENCE;
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const service = new OpenRouterService();

    // 1. Upstream 401 -> 502 provider_auth_failed
    service.configure({
      fetchImpl: (async () => {
        return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const res401 = await service.executeChatCompletion({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-or-expired-key",
    });
    expect(res401.status).toBe(502);
    const body401 = (await res401.json()) as any;
    expect(body401.error.code).toBe("provider_auth_failed");

    // 2. Upstream 402 -> 503 provider_credits_exhausted
    service.configure({
      fetchImpl: (async () => {
        return new Response(JSON.stringify({ error: { message: "Credit limit exceeded" } }), {
          status: 402,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const res402 = await service.executeChatCompletion({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-or-no-credits-key",
    });
    expect(res402.status).toBe(503);
    const body402 = (await res402.json()) as any;
    expect(body402.error.code).toBe("provider_credits_exhausted");

    // 3. Upstream 429 -> 429 provider_rate_limited
    service.configure({
      fetchImpl: (async () => {
        return new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const res429 = await service.executeChatCompletion({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-or-busy-key",
    });
    expect(res429.status).toBe(429);
    const body429 = (await res429.json()) as any;
    expect(body429.error.code).toBe("provider_rate_limited");
  });
});
