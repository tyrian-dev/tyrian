import testnetJson from "../../config/networks/testnet.json";
import mainnetJson from "../../config/networks/mainnet.json";
import type { Address } from "../types";

export type NetworkName = "testnet" | "mainnet";

export type ContractName =
  | "StakeManager"
  | "UsdgVault"
  | "FeeSplitter"
  | "BuybackBurner"
  | "TreasuryRouter"
  | "PortfolioVault"
  | "TyrTwapOracle";

export type TokenName = "USDG" | "TYRN" | "WETH";

export interface TokenConfig {
  symbol: string;
  address: Address | null;
  decimals: number;
}

export interface StockConfig {
  symbol: string;
  name: string;
  address: Address | null;
  feed: Address | null;
  /** Standalone StockPriceOracle used by PortfolioVault valuation. */
  oracle: Address | null;
  /** One StockVault per ticker. Never a shared multi-ticker vault. */
  vault: Address | null;
  decimals: number;
  enabled: boolean;
}

export interface ExternalConfig {
  treasurySafe: Address | null;
  budget: Address | null;
  reserve: Address | null;
  timelock: Address | null;
  guardian: Address | null;
  dexRouter: Address | null;
  morphoMarket: Address | null;
  uniswapPool: Address | null;
  ponsFeeWallet: Address | null;
}

export interface FeatureFlags {
  stockTokens: boolean;
  morpho: boolean;
  ponsDirectClaim: boolean;
  geoGate: boolean;
}

export interface NetworkManifest {
  name: NetworkName;
  label: string;
  chainId: number;
  rpcUrl: string;
  rpcEnv: string;
  explorer: string;
  startBlock: number | null;
  verification: "pending" | "unverified" | "verified";
  contracts: Record<ContractName, Address | null>;
  tokens: Record<TokenName, TokenConfig>;
  stocks: Record<string, StockConfig>;
  external: ExternalConfig;
  features: FeatureFlags;
  deployment: {
    blockNumber: number | null;
    txHash: string | null;
    verifiedAt: string | null;
  };
}

// `process` is replaced by Next.js for NEXT_PUBLIC_* values. The declaration keeps
// this package usable in non-Next runtimes without requiring @types/node.
declare const process: { env: Record<string, string | undefined> } | undefined;

export const networkManifests: Record<NetworkName, NetworkManifest> = {
  testnet: testnetJson as unknown as NetworkManifest,
  mainnet: mainnetJson as unknown as NetworkManifest,
};

export function isZeroAddress(value: string | null | undefined): boolean {
  return !value || /^0x0{40}$/i.test(value);
}

export function isAddress(value: string | null | undefined): value is Address {
  return !!value && /^0x[0-9a-fA-F]{40}$/.test(value) && !isZeroAddress(value);
}

export function resolveNetworkName(value?: string | number | null): NetworkName {
  if (value === undefined || value === null || value === "") return "testnet";

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "mainnet" || normalized === "production" || normalized === "4663") {
    return "mainnet";
  }
  if (
    normalized === "testnet" ||
    normalized === "local" ||
    normalized === "development" ||
    normalized === "46630"
  ) {
    return "testnet";
  }
  if (normalized === "staging") return "mainnet";

  throw new Error(`Unknown Tyrian network: ${value}`);
}

export function getNetworkManifest(network: NetworkName | string | number): NetworkManifest {
  if (typeof network === "number") {
    const found = Object.values(networkManifests).find((item) => item.chainId === network);
    if (!found) throw new Error(`No Tyrian manifest for chain ${network}`);
    return found;
  }

  if (network === "testnet" || network === "mainnet") return networkManifests[network];
  return networkManifests[resolveNetworkName(network)];
}

export function getActiveNetworkName(): NetworkName {
  const candidate =
    (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_NETWORK : undefined) ||
    (typeof process !== "undefined"
      ? process.env.TYRIAN_NETWORK || process.env.APP_ENV
      : undefined);
  return resolveNetworkName(candidate);
}

export const activeNetworkName: NetworkName = getActiveNetworkName();
export const activeNetwork: NetworkManifest = networkManifests[activeNetworkName];

function connectedAddresses(manifest: NetworkManifest): Partial<Record<ContractName, Address>> {
  const result: Partial<Record<ContractName, Address>> = {};
  for (const [name, address] of Object.entries(manifest.contracts) as Array<
    [ContractName, Address | null]
  >) {
    if (isAddress(address)) result[name] = address;
  }
  return result;
}

/**
 * Address registry derived from manifests. Missing or zero addresses are never
 * exposed as a usable address.
 */
export const addresses: Record<string, Partial<Record<ContractName, Address>>> = {
  [String(networkManifests.testnet.chainId)]: connectedAddresses(networkManifests.testnet),
  [String(networkManifests.mainnet.chainId)]: connectedAddresses(networkManifests.mainnet),
};

export function findContractAddress(
  chainId: number | undefined,
  name: ContractName | string,
): Address | undefined {
  if (chainId === undefined) return undefined;
  const byChain = addresses[String(chainId)];
  const value = byChain?.[name as ContractName];
  return isAddress(value) ? value : undefined;
}

export function getContractAddress(
  name: ContractName,
  network: NetworkName | string | number = activeNetworkName,
): Address {
  const manifest = getNetworkManifest(network);
  const address = manifest.contracts[name];
  if (!isAddress(address)) {
    throw new Error(
      `${name} is not configured for ${manifest.name} (chain ${manifest.chainId}). ` +
        `Fill config/networks/${manifest.name}.json after verification.`,
    );
  }
  return address;
}

export function getToken(
  name: TokenName,
  network: NetworkName | string | number = activeNetworkName,
): TokenConfig {
  const token = getNetworkManifest(network).tokens[name];
  if (!isAddress(token.address)) {
    throw new Error(`Token ${name} is not configured for network ${network}`);
  }
  return token;
}

export function getEnabledStocks(
  network: NetworkName | string | number = activeNetworkName,
): StockConfig[] {
  return Object.values(getNetworkManifest(network).stocks).filter(
    (stock) =>
      stock.enabled &&
      isAddress(stock.address) &&
      isAddress(stock.feed) &&
      isAddress(stock.vault),
  );
}

/**
 * StockVault address for one ticker. Each ticker has its own vault.
 */
export function getStockVault(
  ticker: string,
  network: NetworkName | string | number = activeNetworkName,
): Address {
  const manifest = getNetworkManifest(network);
  const stock = manifest.stocks[ticker.toUpperCase()];
  if (!stock || !isAddress(stock.vault)) {
    throw new Error(
      `StockVault for ${ticker} is not configured for ${manifest.name} ` +
        `(chain ${manifest.chainId}). Fill stocks.${ticker.toUpperCase()}.vault ` +
        `in config/networks/${manifest.name}.json after verification.`,
    );
  }
  return stock.vault;
}

/**
 * All configured StockVault addresses. Includes disabled tickers so the indexer
 * can still read their historical events.
 */
export function getStockVaults(
  network: NetworkName | string | number = activeNetworkName,
): Address[] {
  return Object.values(getNetworkManifest(network).stocks)
    .map((stock) => stock.vault)
    .filter(isAddress);
}

const CONTRACT_NAMES: ContractName[] = [
  "StakeManager",
  "UsdgVault",
  "FeeSplitter",
  "BuybackBurner",
  "TreasuryRouter",
  "PortfolioVault",
  "TyrTwapOracle",
];

const TOKEN_NAMES: TokenName[] = ["USDG", "TYRN", "WETH"];

const VERIFICATION_VALUES: NetworkManifest["verification"][] = [
  "pending",
  "unverified",
  "verified",
];

function checkAddress(
  issues: string[],
  label: string,
  value: Address | null | undefined,
  required = false,
): boolean {
  if (isAddress(value)) return true;
  // `null` means "not configured yet" and is allowed outside readiness checks.
  // Zero, malformed, or non-string values are always invalid.
  if (required || (value !== null && value !== undefined)) issues.push(label);
  return false;
}

/**
 * Structural validation that applies to every network profile, including
 * before deployment. It never invents an address: `null` stays allowed, but a
 * zero/malformed address or an inconsistent flag is rejected.
 */
export function getManifestIssues(manifest: NetworkManifest): string[] {
  const issues: string[] = [];

  if (manifest.name !== "testnet" && manifest.name !== "mainnet") {
    issues.push("name");
  }
  if (!manifest.label?.trim()) issues.push("label");
  if (!Number.isInteger(manifest.chainId) || manifest.chainId <= 0) {
    issues.push("chainId");
  }
  if (!manifest.rpcUrl?.trim() || !/^https?:\/\//.test(manifest.rpcUrl)) {
    issues.push("rpcUrl");
  }
  if (!manifest.explorer?.trim() || !/^https?:\/\//.test(manifest.explorer)) {
    issues.push("explorer");
  }

  for (const name of CONTRACT_NAMES) {
    checkAddress(issues, `contracts.${name}`, manifest.contracts[name]);
  }

  for (const name of TOKEN_NAMES) {
    const token = manifest.tokens[name];
    if (!token) {
      issues.push(`tokens.${name}`);
      continue;
    }
    if (token.symbol !== name) issues.push(`tokens.${name}.symbol`);
    if (
      !Number.isInteger(token.decimals) ||
      token.decimals < 0 ||
      token.decimals > 36
    ) {
      issues.push(`tokens.${name}.decimals`);
    }
    checkAddress(issues, `tokens.${name}.address`, token.address);
  }

  for (const name of Object.keys(manifest.external) as Array<keyof ExternalConfig>) {
    checkAddress(issues, `external.${name}`, manifest.external[name]);
  }

  const vaults = new Set<string>();
  const oracles = new Set<string>();
  for (const [ticker, stock] of Object.entries(manifest.stocks)) {
    if (!stock) {
      issues.push(`stocks.${ticker}`);
      continue;
    }
    if (stock.symbol !== ticker) issues.push(`stocks.${ticker}.symbol`);
    if (
      !Number.isInteger(stock.decimals) ||
      stock.decimals <= 0 ||
      stock.decimals > 36
    ) {
      issues.push(`stocks.${ticker}.decimals`);
    }

    checkAddress(issues, `stocks.${ticker}.address`, stock.address, stock.enabled);
    checkAddress(issues, `stocks.${ticker}.feed`, stock.feed, stock.enabled);
    const hasOracle = checkAddress(
      issues,
      `stocks.${ticker}.oracle`,
      stock.oracle,
      stock.enabled,
    );
    const hasVault = checkAddress(
      issues,
      `stocks.${ticker}.vault`,
      stock.vault,
      stock.enabled,
    );

    if (hasOracle && stock.oracle) {
      const key = stock.oracle.toLowerCase();
      if (oracles.has(key)) issues.push(`stocks.${ticker}.oracle.duplicate`);
      else oracles.add(key);
    }

    if (hasVault && stock.vault) {
      const key = stock.vault.toLowerCase();
      if (vaults.has(key)) issues.push(`stocks.${ticker}.vault.duplicate`);
      else vaults.add(key);
    }
  }

  const enabledStocks = Object.values(manifest.stocks).filter((stock) => stock.enabled);
  for (const name of [
    "stockTokens",
    "morpho",
    "ponsDirectClaim",
    "geoGate",
  ] as const) {
    if (typeof manifest.features[name] !== "boolean") {
      issues.push(`features.${name}`);
    }
  }
  if (manifest.features.stockTokens && enabledStocks.length === 0) {
    issues.push("stocks.enabled");
  }
  if (!manifest.features.stockTokens && enabledStocks.length > 0) {
    issues.push("features.stockTokens");
  }
  if (manifest.features.morpho && !isAddress(manifest.external.morphoMarket)) {
    issues.push("external.morphoMarket");
  }
  if (manifest.features.ponsDirectClaim && !isAddress(manifest.external.ponsFeeWallet)) {
    issues.push("external.ponsFeeWallet");
  }

  if (
    manifest.startBlock !== null &&
    (!Number.isInteger(manifest.startBlock) || manifest.startBlock <= 0)
  ) {
    issues.push("startBlock");
  }
  if (manifest.verification === "verified" && manifest.startBlock === null) {
    issues.push("startBlock");
  }
  if (!VERIFICATION_VALUES.includes(manifest.verification)) {
    issues.push("verification");
  }

  const deployment = manifest.deployment;
  if (
    deployment.blockNumber !== null &&
    (!Number.isInteger(deployment.blockNumber) || deployment.blockNumber <= 0)
  ) {
    issues.push("deployment.blockNumber");
  }
  if (
    deployment.txHash !== null &&
    !/^0x[0-9a-fA-F]{64}$/.test(deployment.txHash)
  ) {
    issues.push("deployment.txHash");
  }
  if (
    deployment.verifiedAt !== null &&
    Number.isNaN(Date.parse(deployment.verifiedAt))
  ) {
    issues.push("deployment.verifiedAt");
  }

  return Array.from(new Set(issues));
}

/**
 * Fail-closed mainnet readiness check used by deploy/CI scripts.
 */
export function getMainnetReadinessIssues(manifest: NetworkManifest): string[] {
  const issues = getManifestIssues(manifest);
  if (manifest.name !== "mainnet") {
    issues.push("network.mainnet");
    return Array.from(new Set(issues));
  }

  const requiredContracts: ContractName[] = [
    "StakeManager",
    "UsdgVault",
    "FeeSplitter",
    "BuybackBurner",
    "TreasuryRouter",
    "PortfolioVault",
    // BUD-003: TYR pricing for the epoch/quota path is fail-closed without it.
    "TyrTwapOracle",
  ];
  for (const name of requiredContracts) {
    if (!isAddress(manifest.contracts[name])) issues.push(`contracts.${name}`);
  }
  for (const name of TOKEN_NAMES) {
    if (!isAddress(manifest.tokens[name]?.address)) {
      issues.push(`tokens.${name}.address`);
    }
  }
  for (const name of [
    "treasurySafe",
    "budget",
    "reserve",
    "timelock",
    "guardian",
    "dexRouter",
    // BUD-003: the TYR TWAP oracle is deployed against this pool, so a missing
    // pool means TYR cannot be priced on-chain.
    "uniswapPool",
  ] as const) {
    if (!isAddress(manifest.external[name])) issues.push(`external.${name}`);
  }

  const enabledStocks = Object.values(manifest.stocks).filter((stock) => stock.enabled);
  if (manifest.features.stockTokens && enabledStocks.length === 0) {
    issues.push("stocks.enabled");
  }
  if (!manifest.features.stockTokens && enabledStocks.length > 0) {
    issues.push("features.stockTokens");
  }
  for (const stock of enabledStocks) {
    if (!isAddress(stock.address)) issues.push(`stocks.${stock.symbol}.address`);
    if (!isAddress(stock.feed)) issues.push(`stocks.${stock.symbol}.feed`);
    if (!isAddress(stock.oracle)) issues.push(`stocks.${stock.symbol}.oracle`);
    if (!isAddress(stock.vault)) issues.push(`stocks.${stock.symbol}.vault`);
  }

  if (manifest.startBlock === null || manifest.startBlock === 0) {
    issues.push("startBlock");
  }
  if (manifest.verification !== "verified") issues.push("verification");

  return Array.from(new Set(issues));
}

export function assertManifestValid(
  network: NetworkName | string | number = activeNetworkName,
): void {
  const manifest = getNetworkManifest(network);
  const issues = getManifestIssues(manifest);
  if (issues.length > 0) {
    throw new Error(`${manifest.name} manifest is invalid: ${issues.join(", ")}`);
  }
}

export function assertMainnetReady(
  network: NetworkName | string | number = "mainnet",
): void {
  const manifest = getNetworkManifest(network);
  if (manifest.name !== "mainnet") {
    throw new Error("assertMainnetReady only accepts mainnet");
  }

  const issues = getMainnetReadinessIssues(manifest);
  if (issues.length > 0) {
    throw new Error(`Mainnet manifest is not ready: ${issues.join(", ")}`);
  }
}
