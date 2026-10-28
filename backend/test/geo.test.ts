import { describe, it, expect } from "bun:test";
import app from "../src/app";

describe("Tyrian Server-Side Geo-Blocking Suite (BE-AUTH-007 / BE-PRG-008)", () => {
  it("rejects mutating auth /verify from blocked country (US)", async () => {
    const res = await app.request("/api/auth/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vercel-ip-country": "US",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({ message: "test", signature: "0x123" }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string; message: string; country: string } };
    expect(json.error.code).toBe("geo_blocked");
    expect(json.error.country).toBe("US");
  });

  it("rejects mutating auth /verify via Cloudflare cf-ipcountry header (GB)", async () => {
    const res = await app.request("/api/auth/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-ipcountry": "GB",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({ message: "test", signature: "0x123" }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string; country: string } };
    expect(json.error.code).toBe("geo_blocked");
    expect(json.error.country).toBe("GB");
  });

  it("rejects key management operations from blocked country (CA)", async () => {
    const res = await app.request("/api/keys", {
      method: "GET",
      headers: {
        "x-country-code": "CA",
        Origin: "http://localhost:3000",
      },
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string; country: string } };
    expect(json.error.code).toBe("geo_blocked");
    expect(json.error.country).toBe("CA");
  });

  it("rejects AI gateway chat completion from blocked country (AE)", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vercel-ip-country": "AE",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("geo_blocked");
  });

  it("permits allowed country (SG) to proceed past geo-fence", async () => {
    const res = await app.request("/api/keys", {
      method: "GET",
      headers: {
        "x-vercel-ip-country": "SG",
        Origin: "http://localhost:3000",
      },
    });

    // Should not be 403 geo_blocked (will be 401 Unauthorized because not logged in)
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Unauthorized");
  });

  it("permits requests without country header in dev/localhost", async () => {
    const res = await app.request("/api/auth/nonce");
    expect(res.status).toBe(200);
  });

  it("fails closed without a country header when strict geo mode is enabled", async () => {
    const previous = process.env.GEO_GATE_STRICT;
    process.env.GEO_GATE_STRICT = "true";
    try {
      const res = await app.request("/api/keys", {
        method: "GET",
        headers: { Origin: "http://localhost:3000" },
      });

      expect(res.status).toBe(403);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("geo_unavailable");
    } finally {
      if (previous === undefined) delete process.env.GEO_GATE_STRICT;
      else process.env.GEO_GATE_STRICT = previous;
    }
  });
});
