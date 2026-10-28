import { describe, it, expect, afterEach } from "bun:test";
import { PortfolioVaultService, portfolioVaultService } from "../src/services/portfolio-vault";
import { TreasuryService } from "../src/services/treasury";
import { pricingService } from "../src/services/pricing";

describe("Portfolio cost basis (BUD-004 / GAP-011)", () => {
  afterEach(() => {
    portfolioVaultService.configure({});
    pricingService.configure({});
  });

  it("returns holdings injected by a reader (contract read shape)", async () => {
    const service = new PortfolioVaultService();
    service.configure({
      readHoldings: async () => [
        {
          token: "0x0000000000000000000000000000000000000abc",
          symbol: "TSLA",
          amount: 12.5,
          decimals: 18,
          avgCostUsd: 431.25,
          costBasisUsd: 5390.625,
        },
      ],
    });

    const holdings = await service.getHoldings();
    expect(holdings).toHaveLength(1);
    expect(holdings?.[0].avgCostUsd).toBe(431.25);
    expect(holdings?.[0].costBasisUsd).toBe(5390.625);
  });

  it("resolves to null when the vault cannot be read", async () => {
    const service = new PortfolioVaultService();
    service.configure({ readHoldings: async () => null });

    expect(await service.getHoldings()).toBeNull();
  });

  it("exposes the vault average buy price on the treasury portfolio", async () => {
    portfolioVaultService.configure({
      readHoldings: async () => [
        {
          token: "0x0000000000000000000000000000000000000abc",
          symbol: "TSLA",
          amount: 10,
          decimals: 18,
          avgCostUsd: 400,
          costBasisUsd: 4000,
        },
      ],
    });
    // Price the holding deterministically so the row is comparable.
    pricingService.configure({
      readOracle: async () => 500n * 10n ** 18n,
    });

    const summary = await new TreasuryService().getTreasurySummary();
    const row = summary.portfolio.find((item) => item.symbol === "TSLA");

    expect(row).toBeDefined();
    expect(row?.avgCostUsd).toBe(400);
    expect(row?.onchain).toBe(true);
    // Current price is $500, cost basis stays $400 — they must not be conflated.
    expect(row?.valueUsd).toBe(5000);
    expect(row?.pct).toBe(100);
  });

  it("leaves avgCostUsd undefined when the vault is unavailable", async () => {
    portfolioVaultService.configure({ readHoldings: async () => null });

    const summary = await new TreasuryService().getTreasurySummary();
    for (const item of summary.portfolio) {
      expect(item.avgCostUsd).toBeUndefined();
    }
  });
});
