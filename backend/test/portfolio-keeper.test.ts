import { describe, it, expect, beforeEach } from "bun:test";
import { PortfolioKeeperService } from "../src/services/portfolio-keeper";
import { alertService } from "../src/services/alert";

describe("Portfolio Vault Keeper Service (GAP-011 / Brief §7)", () => {
  let keeper: PortfolioKeeperService;

  beforeEach(() => {
    alertService.clearAlerts();
    alertService.setWebhookUrl(null);
    keeper = new PortfolioKeeperService();
  });

  it("skips execution gracefully if keeper private key is missing", async () => {
    const origKey = process.env.TREASURY_KEEPER_KEY;
    const origKey2 = process.env.KEEPER_PRIVATE_KEY;
    delete process.env.TREASURY_KEEPER_KEY;
    delete process.env.KEEPER_PRIVATE_KEY;

    try {
      const result = await keeper.triggerDcaBuy();
      expect(result.executed).toBe(false);
      expect(result.reason).toBe("keeper_key_missing");
    } finally {
      if (origKey) process.env.TREASURY_KEEPER_KEY = origKey;
      if (origKey2) process.env.KEEPER_PRIVATE_KEY = origKey2;
    }
  });

  it("executes DCA buy order via injected handler and returns execution details", async () => {
    const mockTxHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as const;
    const mockBlock = 42161500n;
    const mockTokensBought = 50n * 10n ** 18n;

    keeper.configure({
      executeBuy: async () => ({
        txHash: mockTxHash,
        blockNumber: mockBlock,
        tokensBought: mockTokensBought,
      }),
    });

    const result = await keeper.triggerDcaBuy();
    expect(result.executed).toBe(true);
    expect(result.txHash).toBe(mockTxHash);
    expect(result.blockNumber).toBe(mockBlock);
    expect(result.tokensBought).toBe(mockTokensBought);
  });

  it("dispatches alert on buy execution failure and reports failure reason", async () => {
    keeper.configure({
      executeBuy: async () => {
        throw new Error("execution reverted: Uniswap V3 slippage limit exceeded");
      },
    });

    const result = await keeper.triggerDcaBuy();
    expect(result.executed).toBe(false);
    expect(result.reason).toBe("execution_failed");
    expect(result.error).toContain("Uniswap V3 slippage limit exceeded");

    const alerts = alertService.getRecentAlerts();
    expect(alerts.length).toBe(1);
    expect(alerts[0].type).toBe("BUDGET_WARNING");
    expect(alerts[0].severity).toBe("WARNING");
    expect(alerts[0].title).toBe("PortfolioVault DCA Buy Failed");
  });
});
