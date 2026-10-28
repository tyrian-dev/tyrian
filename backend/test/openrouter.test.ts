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
});
