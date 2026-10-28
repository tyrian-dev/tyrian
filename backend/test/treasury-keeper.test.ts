import { describe, it, expect, beforeEach } from "bun:test";
import { TreasuryKeeperService } from "../src/services/treasury-keeper";
import { alertService } from "../src/services/alert";

describe("Treasury Keeper Service (GAP-006 / Brief §7)", () => {
  let keeper: TreasuryKeeperService;

  beforeEach(() => {
    alertService.clearAlerts();
    alertService.setWebhookUrl(null);
    keeper = new TreasuryKeeperService();
  });

  it("skips execution gracefully if keeper private key is missing", async () => {
    const origKey = process.env.TREASURY_KEEPER_KEY;
    const origKey2 = process.env.KEEPER_PRIVATE_KEY;
    delete process.env.TREASURY_KEEPER_KEY;
    delete process.env.KEEPER_PRIVATE_KEY;

    try {
      const result = await keeper.triggerRoute();
      expect(result.executed).toBe(false);
      expect(result.reason).toBe("keeper_key_missing");
    } finally {
      if (origKey) process.env.TREASURY_KEEPER_KEY = origKey;
      if (origKey2) process.env.KEEPER_PRIVATE_KEY = origKey2;
    }
  });

  it("executes route via injected handler and returns tx hash", async () => {
    const mockTxHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as const;
    const mockBlock = 42161400n;

    keeper.configure({
      executeRoute: async () => ({
        txHash: mockTxHash,
        blockNumber: mockBlock,
      }),
    });

    const result = await keeper.triggerRoute();
    expect(result.executed).toBe(true);
    expect(result.txHash).toBe(mockTxHash);
    expect(result.blockNumber).toBe(mockBlock);
  });

  it("dispatches alert on execution failure and reports failure reason", async () => {
    keeper.configure({
      executeRoute: async () => {
        throw new Error("execution reverted: Uniswap slippage exceeded");
      },
    });

    const result = await keeper.triggerRoute();
    expect(result.executed).toBe(false);
    expect(result.reason).toBe("execution_failed");
    expect(result.error).toContain("Uniswap slippage exceeded");

    // Verify alert was stored in recent alerts
    const alerts = alertService.getRecentAlerts();
    expect(alerts.length).toBe(1);
    expect(alerts[0].type).toBe("BUDGET_WARNING");
    expect(alerts[0].severity).toBe("WARNING");
    expect(alerts[0].title).toBe("TreasuryRouter Route Failed");
  });
});
