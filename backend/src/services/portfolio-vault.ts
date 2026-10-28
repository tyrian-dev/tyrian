import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { PortfolioVaultAbi } from "@shared/contracts/abis/PortfolioVault";
import { tyrianNetwork } from "../config/network";

const ERC20_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

export interface PortfolioHolding {
  token: Address;
  symbol: string;
  /** Balance held by the vault, in whole tokens. */
  amount: number;
  decimals: number;
  /** Average buy cost in USD per whole token, or null when never bought. */
  avgCostUsd: number | null;
  /** Cumulative USD spent on the tokens still held (pro-rated on sells). */
  costBasisUsd: number | null;
}

export interface PortfolioVaultDeps {
  readHoldings?: () => Promise<PortfolioHolding[] | null>;
}

/**
 * Reads the treasury portfolio basket from `PortfolioVault` (BUD-004).
 *
 * The vault tracks a cost basis per target (`getAvgCostUsd` / `getCostBasis`),
 * which is the only honest source for "harga beli rata-rata" on `/treasury`.
 * Deriving it from `valueUsd / amount` shows the current price instead.
 *
 * Returns `null` when the vault address or RPC is unavailable so callers can
 * show "unavailable" instead of a fabricated number.
 */
export class PortfolioVaultService {
  private deps: PortfolioVaultDeps = {};
  private client: PublicClient | null = null;

  configure(deps: PortfolioVaultDeps): void {
    this.deps = deps;
    this.client = null;
  }

  private getClient(): PublicClient {
    if (!this.client) {
      const rpcUrl = process.env.RPC_URL || tyrianNetwork.rpcUrl;
      this.client = createPublicClient({ transport: http(rpcUrl) });
    }
    return this.client;
  }

  private resolveSymbol(token: string): string {
    const addr = token.toLowerCase();
    if (addr === tyrianNetwork.tokens.WETH.address?.toLowerCase()) return "WETH";
    if (addr === tyrianNetwork.tokens.USDG.address?.toLowerCase()) return "USDG";
    for (const [symbol, cfg] of Object.entries(tyrianNetwork.stocks)) {
      if (cfg.address && cfg.address.toLowerCase() === addr) return symbol;
    }
    return "UNKNOWN";
  }

  async getHoldings(): Promise<PortfolioHolding[] | null> {
    if (this.deps.readHoldings) return this.deps.readHoldings();

    const vault = tyrianNetwork.contracts.PortfolioVault;
    if (!vault) return null;

    try {
      const client = this.getClient();
      const count = (await client.readContract({
        address: vault as Address,
        abi: PortfolioVaultAbi,
        functionName: "targetCount",
      })) as bigint;

      const holdings: PortfolioHolding[] = [];

      for (let index = 0n; index < count; index += 1n) {
        const target = (await client.readContract({
          address: vault as Address,
          abi: PortfolioVaultAbi,
          functionName: "targetAt",
          args: [index],
        })) as readonly [Address, number, number, Address];

        const token = target[0];
        const decimals = Number(target[1]);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;

        const balance = (await client.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [vault as Address],
        })) as bigint;

        if (balance <= 0n) continue;

        let avgCostUsd: number | null = null;
        let costBasisUsd: number | null = null;
        try {
          const [cumulativeCostUsd, , avgCostUsd18] = (await client.readContract({
            address: vault as Address,
            abi: PortfolioVaultAbi,
            functionName: "getCostBasis",
            args: [token],
          })) as readonly [bigint, bigint, bigint];

          costBasisUsd = Number(cumulativeCostUsd) / 1e18;
          avgCostUsd = avgCostUsd18 > 0n ? Number(avgCostUsd18) / 1e18 : null;
        } catch {
          // A token outside the basket, or a vault without cost-basis support.
          avgCostUsd = null;
          costBasisUsd = null;
        }

        holdings.push({
          token,
          symbol: this.resolveSymbol(token),
          amount: Number(balance) / 10 ** decimals,
          decimals,
          avgCostUsd,
          costBasisUsd,
        });
      }

      return holdings;
    } catch (err) {
      console.warn(
        "[PortfolioVaultService] Unable to read portfolio holdings:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
}

export const portfolioVaultService = new PortfolioVaultService();
