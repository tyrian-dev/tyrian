import { describe, it, expect } from "bun:test";
import { dbService } from "../src/services/db";

describe("Tyrian Audit Logging & Privacy Suite (BE-AUTH-009)", () => {
  it("logAudit method executes safely without throw", async () => {
    let errorThrown = false;
    try {
      await dbService.logAudit({
        userAddress: "0x1234567890123456789012345678901234567890",
        action: "AUTH_VERIFY",
        ipCountry: "SG",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        metadata: {
          chainId: 1,
          rawSecretKey: "should_be_redacted",
          signature: "0x123456",
          allowedInfo: "safe_value",
        },
      });
    } catch {
      errorThrown = true;
    }

    expect(errorThrown).toBe(false);
  });
});
