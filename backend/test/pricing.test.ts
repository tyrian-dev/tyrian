import { afterAll, describe, expect, it } from "bun:test";
import {
  DEFAULT_PRICE_CACHE_TTL_MS,
  PriceUnavailableError,
  PricingService,
  USDG_USD,
  pricingService,
} from "../src/services/pricing";
import { runDailyEpochJob } from "../src/cron/epoch";

const E18 = 10n ** 18n;

describe("Pricing service (oracle-backed USD values)", () => {
  afterAll(() => {
    // The singleton is shared with quota/epoch; restore production behaviour.
    pricingService.configure({});
  });

  it("pegs USDG to exactly 1.00 without an oracle read", async () => {
    let reads = 0;
    const service = new PricingService({
      readOracle: async () => {
        reads += 1;
        return 0n;
      },
    });

    expect(await service.getUsdPrice("USDG")).toBe(USDG_USD);
    expect(await service.getUsdValue("usdg", 250)).toBe(250);
    expect(reads).toBe(0);
  });

  it("reads TYR from the oracle with 18 decimals", async () => {
    const service = new PricingService({
      readOracle: async (kind) => {
        expect(kind).toBe("tyr");
        return (5n * E18) / 100n; // 0.05 USD
      },
    });

    expect(await service.getTyrPriceUsd()).toBe(0.05);
  });

  it("reads a stock price by ticker", async () => {
    const service = new PricingService({
      readOracle: async (kind) => {
        expect(kind).toBe("stock");
        return 250n * E18;
      },
    });

    expect(await service.getStockPriceUsd("TSLA")).toBe(250);
  });

  it("reads WETH price from the oracle reader with 18 decimals", async () => {
    const service = new PricingService({
      readOracle: async (kind) => {
        expect(kind).toBe("weth");
        return 2600n * E18;
      },
    });

    expect(await service.getWethPriceUsd()).toBe(2600);
    expect(await service.getUsdPrice("WETH")).toBe(2600);
  });

  it("supports WETH_USD_PRICE env fallback when oracle is not configured", async () => {
    const original = process.env.WETH_USD_PRICE;
    try {
      process.env.WETH_USD_PRICE = "2750";
      const service = new PricingService({});
      expect(await service.getWethPriceUsd()).toBe(2750);
    } finally {
      if (original === undefined) {
        delete process.env.WETH_USD_PRICE;
      } else {
        process.env.WETH_USD_PRICE = original;
      }
    }
  });

  it("caches a successful read for the TTL and refreshes afterwards", async () => {
    let now = 0;
    let reads = 0;
    const service = new PricingService({
      ttlMs: DEFAULT_PRICE_CACHE_TTL_MS,
      now: () => now,
      readOracle: async () => {
        reads += 1;
        return E18;
      },
    });

    expect(await service.getTyrPriceUsd()).toBe(1);
    expect(await service.getTyrPriceUsd()).toBe(1);
    expect(reads).toBe(1);

    now = DEFAULT_PRICE_CACHE_TTL_MS + 1;
    expect(await service.getTyrPriceUsd()).toBe(1);
    expect(reads).toBe(2);
  });

  it("does not cache failures, so a transient revert can recover", async () => {
    let attempt = 0;
    const service = new PricingService({
      readOracle: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("stale price");
        return 2n * E18;
      },
    });

    await expect(service.getTyrPriceUsd()).rejects.toBeInstanceOf(PriceUnavailableError);
    expect(await service.getTyrPriceUsd()).toBe(2);
  });

  it("rejects a zero price instead of returning zero USD", async () => {
    const service = new PricingService({ readOracle: async () => 0n });

    const error = await service.getTyrPriceUsd().catch((err) => err);
    expect(error).toBeInstanceOf(PriceUnavailableError);
    expect(error.reason).toBe("zero_price");
    expect(error.code).toBe("price_unavailable");
  });

  it("rejects an absurd price instead of inflating quota", async () => {
    const service = new PricingService({ readOracle: async () => 10n ** 24n * E18 });

    const error = await service.getTyrPriceUsd().catch((err) => err);
    expect(error).toBeInstanceOf(PriceUnavailableError);
    expect(error.reason).toBe("unreasonable_price");
  });

  it("rejects an unknown manifest symbol", async () => {
    const service = new PricingService({ readOracle: async () => E18 });

    const error = await service.getUsdPrice("NOT_A_TICKER").catch((err) => err);
    expect(error).toBeInstanceOf(PriceUnavailableError);
    expect(error.reason).toBe("unsupported_asset");
  });

  it("reports oracle_not_configured when no reader and no manifest oracle exist", async () => {
    // Only meaningful on a network whose TYR oracle is still null (testnet).
    const service = new PricingService();
    const error = await service.getTyrPriceUsd().catch((err) => err);
    if (error instanceof PriceUnavailableError && error.reason === "oracle_not_configured") {
      expect(["TYRN", "TYR"]).toContain(error.symbol);
    } else {
      // Mainnet-style manifest: the oracle exists, so the read is attempted.
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("Epoch pricing fail-closed (BE-EPOCH-012)", () => {
  afterAll(() => {
    pricingService.configure({});
  });

  it("fails the epoch when a TYR position exists and the oracle is unavailable", async () => {
    pricingService.configure({
      readOracle: async () => {
        throw new Error("oracle stale");
      },
    });

    await expect(
      runDailyEpochJob({
        epochDate: "2098-12-01",
        force: true,
        harvestedYieldUsd: 100,
        positions: [
          {
            userAddress: "0x1111111111111111111111111111111111111111",
            asset: "PORTFOLIO",
            usdValue: 1000,
            tyrStakedAmount: 500,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(PriceUnavailableError);
  });

  it("does not touch the TYR oracle when no wallet staked TYR", async () => {
    let reads = 0;
    pricingService.configure({
      readOracle: async () => {
        reads += 1;
        throw new Error("should not be called");
      },
    });

    const summary = await runDailyEpochJob({
      epochDate: "2098-12-02",
      force: true,
      harvestedYieldUsd: 100,
      positions: [
        {
          userAddress: "0x2222222222222222222222222222222222222222",
          asset: "PORTFOLIO",
          usdValue: 1000,
          tyrStakedAmount: 0,
        },
      ],
    });

    expect(reads).toBe(0);
    expect(summary.walletsProcessed).toBe(1);
  });
});
