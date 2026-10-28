import {
  createPublicClient,
  type Address,
  type PublicClient,
} from "viem";
import {
  createResilientRpcTransport,
  StockPriceOracleAbi,
  TyrTwapOracleAbi,
} from "@shared/contracts";
import { tyrianNetwork } from "../config/network";

/**
 * USD pricing for quota, epoch, and reconciliation math.
 *
 * Rules:
 * - USDG is the accounting unit: 1 USDG = 1.00 USD, stated explicitly.
 * - TYR comes from `TyrTwapOracle.getPrice()` (18 decimals).
 * - Stock tokens come from the per-ticker `StockPriceOracle.getPrice()`.
 * - A zero, unreachable, or unreasonable price throws `PriceUnavailableError`
 *   instead of falling back to a hardcoded number. Callers must treat that as
 *   `unavailable`, never as zero or as a preview value.
 * - Successful reads are cached for 60 seconds (configurable through
 *   `PRICING_CACHE_TTL_MS`) so one epoch run does not hammer the RPC.
 */

export const USDG_USD = 1.0;
export const DEFAULT_PRICE_CACHE_TTL_MS = 60_000;
const PRICE_DECIMALS = 18n;
const PRICE_SCALE = 10n ** PRICE_DECIMALS;
const MAX_REASONABLE_PRICE = 1_000_000_000_000n; // 1e12 USD

const AggregatorV3Abi = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export type PriceUnavailableReason =
  | "oracle_not_configured"
  | "unsupported_asset"
  | "read_failed"
  | "zero_price"
  | "unreasonable_price";

export class PriceUnavailableError extends Error {
  readonly code = "price_unavailable";

  constructor(
    readonly symbol: string,
    readonly reason: PriceUnavailableReason,
    readonly detail?: string,
  ) {
    super(
      `Price unavailable for ${symbol} (${reason})${detail ? `: ${detail}` : ""}`,
    );
    this.name = "PriceUnavailableError";
  }
}

export type OracleKind = "tyr" | "stock" | "weth" | "chainlink";

export interface PricingDeps {
  /** Override the on-chain reader. Tests use this; production never sets it. */
  readOracle?: (kind: OracleKind, address: Address) => Promise<bigint>;
  /** Clock override for cache expiry tests. */
  now?: () => number;
  /** Cache TTL. Defaults to `PRICING_CACHE_TTL_MS` or 60 seconds. */
  ttlMs?: number;
}

interface CacheEntry {
  price: number;
  expiresAt: number;
}

export class PricingService {
  private client: PublicClient | null = null;
  private readonly cache = new Map<string, CacheEntry>();
  private deps: PricingDeps;

  constructor(deps: PricingDeps = {}) {
    this.deps = deps;
  }

  /** Test hook: swap dependencies and drop stale cached values. */
  configure(deps: PricingDeps): void {
    this.deps = deps;
    this.cache.clear();
  }

  clearCache(): void {
    this.cache.clear();
  }

  private get ttlMs(): number {
    if (this.deps.ttlMs !== undefined) return this.deps.ttlMs;
    const fromEnv = Number(process.env.PRICING_CACHE_TTL_MS);
    return Number.isFinite(fromEnv) && fromEnv >= 0
      ? fromEnv
      : DEFAULT_PRICE_CACHE_TTL_MS;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private getClient(): PublicClient {
    if (!this.client) {
      const rpcUrl =
        process.env.RPC_URL ||
        (tyrianNetwork as unknown as { rpcUrl?: string }).rpcUrl ||
        "https://rpc.testnet.chain.robinhood.com";
      const fallbackUrls = process.env.RPC_FALLBACK_URLS || "";
      this.client = createPublicClient({
        transport: createResilientRpcTransport(rpcUrl, fallbackUrls, {
          timeout: 10_000,
          retryCount: 3,
        }),
      });
    }
    return this.client;
  }

  private async readOracle(kind: OracleKind, address: Address): Promise<bigint> {
    if (this.deps.readOracle) {
      return this.deps.readOracle(kind, address);
    }

    if (kind === "weth" || kind === "chainlink") {
      const [roundData, decimals] = await Promise.all([
        this.getClient().readContract({
          address,
          abi: AggregatorV3Abi,
          functionName: "latestRoundData",
        }) as Promise<[bigint, bigint, bigint, bigint, bigint]>,
        this.getClient().readContract({
          address,
          abi: AggregatorV3Abi,
          functionName: "decimals",
        }) as Promise<number>,
      ]);
      const answer = roundData[1];
      if (answer <= 0n) return 0n;

      const feedDecimals = BigInt(decimals);
      if (feedDecimals <= PRICE_DECIMALS) {
        return answer * 10n ** (PRICE_DECIMALS - feedDecimals);
      } else {
        return answer / 10n ** (feedDecimals - PRICE_DECIMALS);
      }
    }

    const result = await this.getClient().readContract({
      address,
      abi: kind === "tyr" ? TyrTwapOracleAbi : StockPriceOracleAbi,
      functionName: "getPrice",
    });

    return result as bigint;
  }

  private async load(
    key: string,
    symbol: string,
    kind: OracleKind,
    address: Address | null | undefined,
    oracleLabel: string,
  ): Promise<number> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.price;

    if (!address && !this.deps.readOracle) {
      if (symbol === "WETH" && process.env.WETH_USD_PRICE) {
        const envPrice = Number(process.env.WETH_USD_PRICE);
        if (Number.isFinite(envPrice) && envPrice > 0) {
          this.cache.set(key, { price: envPrice, expiresAt: this.now() + this.ttlMs });
          return envPrice;
        }
      }
      throw new PriceUnavailableError(symbol, "oracle_not_configured", oracleLabel);
    }

    let price18: bigint;
    try {
      price18 = await this.readOracle(
        kind,
        address ?? "0x0000000000000000000000000000000000000000",
      );
    } catch (err) {
      // An on-chain revert is how the oracles report stale or invalid data.
      throw new PriceUnavailableError(
        symbol,
        "read_failed",
        err instanceof Error ? err.message : String(err),
      );
    }

    if (price18 <= 0n) {
      throw new PriceUnavailableError(symbol, "zero_price", oracleLabel);
    }
    if (price18 / PRICE_SCALE > MAX_REASONABLE_PRICE) {
      throw new PriceUnavailableError(symbol, "unreasonable_price", oracleLabel);
    }

    const price = Number(price18) / Number(PRICE_SCALE);
    this.cache.set(key, { price, expiresAt: this.now() + this.ttlMs });
    return price;
  }

  /** USD price of one TYR token. */
  async getTyrPriceUsd(): Promise<number> {
    return this.load(
      "TYR",
      "TYR",
      "tyr",
      tyrianNetwork.contracts.TyrTwapOracle,
      "contracts.TyrTwapOracle",
    );
  }

  /** USD price of one WETH token. */
  async getWethPriceUsd(): Promise<number> {
    const feedAddress = (process.env.WETH_FEED_ADDRESS || null) as Address | null;
    return this.load(
      "WETH",
      "WETH",
      "weth",
      feedAddress,
      "process.env.WETH_FEED_ADDRESS",
    );
  }

  /** USD price of one stock token, keyed by ticker from the manifest. */
  async getStockPriceUsd(ticker: string): Promise<number> {
    const symbol = ticker.toUpperCase();
    const stock = tyrianNetwork.stocks[symbol];
    if (!stock) {
      throw new PriceUnavailableError(symbol, "unsupported_asset");
    }

    return this.load(
      `STOCK:${symbol}`,
      symbol,
      "stock",
      stock.oracle,
      `stocks.${symbol}.oracle`,
    );
  }

  /** USD price for a manifest symbol. USDG is explicitly pegged to 1.00. */
  async getUsdPrice(symbol: string): Promise<number> {
    const normalized = symbol.toUpperCase();
    if (normalized === "USDG") return USDG_USD;
    if (normalized === "TYR") return this.getTyrPriceUsd();
    if (normalized === "WETH") return this.getWethPriceUsd();
    if (tyrianNetwork.stocks[normalized]) {
      return this.getStockPriceUsd(normalized);
    }
    throw new PriceUnavailableError(normalized, "unsupported_asset");
  }

  /** USD value of `units` whole tokens of `symbol`. */
  async getUsdValue(symbol: string, units: number): Promise<number> {
    const price = await this.getUsdPrice(symbol);
    return units * price;
  }
}

export const pricingService = new PricingService();
