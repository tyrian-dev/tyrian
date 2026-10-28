import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { tyrianNetwork } from "../config/network";

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export interface ReserveDeps {
  /** Override the USDG balance read (tests, or a pre-fetched snapshot). */
  readUsdgBalance?: () => Promise<bigint>;
  /** Override the USDG decimals read. Defaults to the manifest value. */
  readUsdgDecimals?: () => Promise<number>;
}

/**
 * Reads the on-chain treasury reserve balance (BUD-002).
 *
 * The 7-day budget damper must never manufacture spend that has no funding
 * source, so the reserve top-up is bounded by the USDG the reserve actually
 * holds. When the balance cannot be read the caller must treat the damper as
 * unavailable instead of guessing.
 */
export class ReserveService {
  private deps: ReserveDeps = {};
  private client: PublicClient | null = null;

  configure(deps: ReserveDeps): void {
    this.deps = deps;
    this.client = null;
  }

  getReserveAddress(): Address | null {
    const reserve = tyrianNetwork.external?.reserve;
    return reserve ? (reserve as Address) : null;
  }

  private getClient(): PublicClient {
    if (!this.client) {
      const rpcUrl = process.env.RPC_URL || tyrianNetwork.rpcUrl;
      this.client = createPublicClient({ transport: http(rpcUrl) });
    }
    return this.client;
  }

  private getUsdgAddress(): Address | null {
    const usdg = tyrianNetwork.tokens.USDG?.address;
    return usdg ? (usdg as Address) : null;
  }

  private async readDecimals(): Promise<number> {
    if (this.deps.readUsdgDecimals) return this.deps.readUsdgDecimals();

    const manifestDecimals = tyrianNetwork.tokens.USDG?.decimals;
    if (typeof manifestDecimals === "number" && manifestDecimals >= 0) {
      return manifestDecimals;
    }

    const usdg = this.getUsdgAddress();
    if (!usdg) return 18;
    const decimals = await this.getClient().readContract({
      address: usdg,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
    return Number(decimals);
  }

  /**
   * USD value of the reserve's USDG balance, or `null` when it is not knowable.
   *
   * `null` is a fail-safe signal: the damper must not top up the budget, because
   * an unknown reserve balance cannot back new spending.
   */
  async getReserveUsdgBalanceUsd(): Promise<number | null> {
    try {
      let rawBalance: bigint;

      if (this.deps.readUsdgBalance) {
        rawBalance = await this.deps.readUsdgBalance();
      } else {
        const reserve = this.getReserveAddress();
        const usdg = this.getUsdgAddress();
        if (!reserve || !usdg) return null;

        rawBalance = (await this.getClient().readContract({
          address: usdg,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [reserve],
        })) as bigint;
      }

      if (rawBalance < 0n) return null;

      const decimals = await this.readDecimals();
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;

      const asNumber = Number(rawBalance) / 10 ** decimals;
      if (!Number.isFinite(asNumber) || asNumber < 0) return null;

      // USDG is a USD stablecoin, so token units are USD units.
      return Number(asNumber.toFixed(6));
    } catch (err) {
      console.warn(
        "[ReserveService] Unable to read reserve USDG balance:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
}

export const reserveService = new ReserveService();
