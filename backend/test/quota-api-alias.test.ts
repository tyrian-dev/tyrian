import { describe, it, expect } from "bun:test";
import app from "../src/app";

describe("Quota API Alias Harmonization (GAP-013 / Brief §3 F4)", () => {
  const testAddress = "0x1234567890123456789012345678901234567890";

  it("rejects request missing both authorization header and address query on both endpoints", async () => {
    const resV1 = await app.request("/v1/quota");
    const resApi = await app.request("/api/quota");

    expect(resV1.status).toBe(400);
    expect(resApi.status).toBe(400);

    const bodyV1 = await resV1.json();
    const bodyApi = await resApi.json();

    expect(bodyV1).toEqual(bodyApi);
    expect(bodyApi.error).toBe("Missing authorization or address parameter");
  });

  it("serves identical quota response for GET /api/quota and GET /v1/quota with ?address=...", async () => {
    const resV1 = await app.request(`/v1/quota?address=${testAddress}`);
    const resApi = await app.request(`/api/quota?address=${testAddress}`);

    expect(resV1.status).toBe(200);
    expect(resApi.status).toBe(200);

    const bodyV1 = await resV1.json();
    const bodyApi = await resApi.json();

    const { resetInSeconds: resetV1, ...restV1 } = bodyV1;
    const { resetInSeconds: resetApi, ...restApi } = bodyApi;

    expect(restV1).toEqual(restApi);
    expect(Math.abs(resetV1 - resetApi)).toBeLessThanOrEqual(2);
    expect(bodyApi.userAddress.toLowerCase()).toBe(testAddress.toLowerCase());
    expect(bodyApi).toHaveProperty("allocatedUsd");
    expect(bodyApi).toHaveProperty("usedUsd");
    expect(bodyApi).toHaveProperty("remainingUsd");
    expect(bodyApi).toHaveProperty("positions");
  });
});
