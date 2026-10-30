import { describe, expect, test } from "bun:test";
import {
  assertMainnetReady,
  getMainnetReadinessIssues,
  getManifestIssues,
  isAddress,
  networkManifests,
  type NetworkManifest,
} from "./addresses";

function address(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

let nextAddress = 1;
function uniqueAddress(): `0x${string}` {
  return address(nextAddress++);
}

function unconfiguredMainnet(): NetworkManifest {
  const manifest = structuredClone(networkManifests.mainnet);
  manifest.contracts.StakeManager = null;
  manifest.tokens.USDG.address = null;
  manifest.external.treasurySafe = null;
  manifest.external.budget = null;
  manifest.external.reserve = null;
  manifest.external.dexRouter = null;
  manifest.startBlock = null;
  manifest.verification = "pending";
  return manifest;
}

function readyMainnet(): NetworkManifest {
  const manifest = structuredClone(networkManifests.mainnet);
  manifest.startBlock = 1_000;
  manifest.verification = "verified";
  manifest.deployment = {
    blockNumber: 1_000,
    txHash: `0x${"ab".repeat(32)}`,
    verifiedAt: "2026-10-27T00:00:00.000Z",
  };

  for (const name of [
    "StakeManager",
    "UsdgVault",
    "FeeSplitter",
    "BuybackBurner",
    "TreasuryRouter",
    "PortfolioVault",
    "TyrTwapOracle",
  ] as const) {
    manifest.contracts[name] = uniqueAddress();
  }
  for (const name of ["USDG", "TYRN", "WETH"] as const) {
    manifest.tokens[name].address = uniqueAddress();
  }
  manifest.external.treasurySafe = uniqueAddress();
  manifest.external.budget = uniqueAddress();
  manifest.external.reserve = uniqueAddress();
  manifest.external.timelock = uniqueAddress();
  manifest.external.guardian = uniqueAddress();
  manifest.external.dexRouter = uniqueAddress();
  manifest.external.uniswapPool = uniqueAddress();

  manifest.features.stockTokens = true;
  manifest.stocks.AAPL = {
    ...manifest.stocks.AAPL,
    address: uniqueAddress(),
    feed: uniqueAddress(),
    oracle: uniqueAddress(),
    vault: uniqueAddress(),
    enabled: true,
  };

  return manifest;
}

describe("getManifestIssues", () => {
  test("accepts the current pre-deployment testnet manifest", () => {
    expect(getManifestIssues(networkManifests.testnet)).toEqual([]);
  });

  test("rejects zero and malformed addresses", () => {
    const manifest = structuredClone(networkManifests.testnet);
    manifest.contracts.StakeManager = `0x${"0".repeat(40)}`;
    manifest.tokens.USDG.address = "0x1234";

    expect(getManifestIssues(manifest)).toContain("contracts.StakeManager");
    expect(getManifestIssues(manifest)).toContain("tokens.USDG.address");
  });

  test("requires address, feed, oracle, and vault for enabled stocks", () => {
    const manifest = structuredClone(networkManifests.testnet);
    manifest.features.stockTokens = true;
    manifest.stocks.AAPL.enabled = true;

    const issues = getManifestIssues(manifest);
    expect(issues).toContain("stocks.AAPL.address");
    expect(issues).toContain("stocks.AAPL.feed");
    expect(issues).toContain("stocks.AAPL.oracle");
    expect(issues).toContain("stocks.AAPL.vault");
  });

  test("rejects a stock flag that does not match enabled tickers", () => {
    const manifest = structuredClone(networkManifests.testnet);
    manifest.stocks.AAPL.enabled = true;
    manifest.stocks.AAPL.address = uniqueAddress();
    manifest.stocks.AAPL.feed = uniqueAddress();
    manifest.stocks.AAPL.vault = uniqueAddress();
    manifest.features.stockTokens = false;

    expect(getManifestIssues(manifest)).toContain("features.stockTokens");
  });

  test("rejects a duplicate StockVault address", () => {
    const manifest = structuredClone(networkManifests.testnet);
    const vault = uniqueAddress();
    manifest.features.stockTokens = true;
    manifest.stocks.AAPL = {
      ...manifest.stocks.AAPL,
      address: uniqueAddress(),
      feed: uniqueAddress(),
      oracle: uniqueAddress(),
      vault,
      enabled: true,
    };
    manifest.stocks.NVDA = {
      ...manifest.stocks.NVDA,
      address: uniqueAddress(),
      feed: uniqueAddress(),
      oracle: uniqueAddress(),
      vault,
      enabled: true,
    };

    expect(getManifestIssues(manifest)).toContain("stocks.NVDA.vault.duplicate");
  });

  test("rejects a duplicate StockPriceOracle address", () => {
    const manifest = structuredClone(networkManifests.testnet);
    const oracle = uniqueAddress();
    manifest.features.stockTokens = true;
    manifest.stocks.AAPL = {
      ...manifest.stocks.AAPL,
      address: uniqueAddress(),
      feed: uniqueAddress(),
      oracle,
      vault: uniqueAddress(),
      enabled: true,
    };
    manifest.stocks.NVDA = {
      ...manifest.stocks.NVDA,
      address: uniqueAddress(),
      feed: uniqueAddress(),
      oracle,
      vault: uniqueAddress(),
      enabled: true,
    };

    expect(getManifestIssues(manifest)).toContain(
      "stocks.NVDA.oracle.duplicate",
    );
  });

  test("rejects feature flags that point to missing external addresses", () => {
    const manifest = structuredClone(networkManifests.testnet);
    manifest.features.morpho = true;
    manifest.features.ponsDirectClaim = true;

    const issues = getManifestIssues(manifest);
    expect(issues).toContain("external.morphoMarket");
    expect(issues).toContain("external.ponsFeeWallet");
  });

  test("rejects a verified manifest without a start block", () => {
    const manifest = structuredClone(networkManifests.testnet);
    manifest.verification = "verified";
    manifest.startBlock = null;

    expect(getManifestIssues(manifest)).toContain("startBlock");
  });
});

describe("getMainnetReadinessIssues", () => {
  test("fails closed while mainnet addresses are null", () => {
    const issues = getMainnetReadinessIssues(unconfiguredMainnet());

    expect(issues).toContain("contracts.StakeManager");
    expect(issues).toContain("tokens.USDG.address");
    expect(issues).toContain("external.treasurySafe");
    expect(issues).toContain("external.budget");
    expect(issues).toContain("external.reserve");
    expect(issues).toContain("external.dexRouter");
    expect(issues).toContain("startBlock");
    expect(issues).toContain("verification");
  });

  test("accepts a fully configured verified mainnet manifest", () => {
    expect(getMainnetReadinessIssues(readyMainnet())).toEqual([]);
  });

  test("requires a delayed start block and verified status", () => {
    const manifest = readyMainnet();
    manifest.startBlock = null;
    manifest.verification = "pending";

    const issues = getMainnetReadinessIssues(manifest);
    expect(issues).toContain("startBlock");
    expect(issues).toContain("verification");
  });

  test("requires every enabled stock to have its own vault", () => {
    const manifest = readyMainnet();
    manifest.stocks.NVDA = {
      ...manifest.stocks.NVDA,
      address: uniqueAddress(),
      feed: uniqueAddress(),
      oracle: uniqueAddress(),
      vault: null,
      enabled: true,
    };

    expect(getMainnetReadinessIssues(manifest)).toContain("stocks.NVDA.vault");
  });

  test("requires an oracle for every enabled stock", () => {
    const manifest = readyMainnet();
    manifest.stocks.AAPL.oracle = null;

    expect(getMainnetReadinessIssues(manifest)).toContain(
      "stocks.AAPL.oracle",
    );
  });

  test("requires the TYR TWAP oracle and its pons pool", () => {
    const manifest = readyMainnet();
    manifest.contracts.TyrTwapOracle = null;
    manifest.external.uniswapPool = null;

    const issues = getMainnetReadinessIssues(manifest);
    expect(issues).toContain("contracts.TyrTwapOracle");
    expect(issues).toContain("external.uniswapPool");
  });
});

describe("assertMainnetReady", () => {
  test("throws a clear error when mainnet is not configured", () => {
    expect(() => assertMainnetReady("mainnet")).toThrow(
      /Mainnet manifest is not ready:/,
    );
  });

  test("only accepts mainnet", () => {
    expect(() => assertMainnetReady("testnet")).toThrow(
      "assertMainnetReady only accepts mainnet",
    );
  });
});

describe("isAddress", () => {
  test("rejects zero and malformed values", () => {
    expect(isAddress(`0x${"0".repeat(40)}`)).toBe(false);
    expect(isAddress("0x1234")).toBe(false);
    expect(isAddress(null)).toBe(false);
    expect(isAddress(address(1))).toBe(true);
  });
});
