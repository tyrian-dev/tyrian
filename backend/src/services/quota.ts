import { redis } from "./redis";
import { indexerService } from "./indexer";
import { tyrianNetwork } from "../config/network";
import { pricingService, USDG_USD } from "./pricing";

export interface UserQuotaDetails {
  userAddress: string;
  allocatedUsd: number;
  usedUsd: number;
  remainingUsd: number;
  resetInSeconds: number;
  resetTimeUtc: string;
  isStaker: boolean;
  totalEffectiveStakeUsd: number;
  positions: {
    asset: string;
    assetAddress: string;
    activeShares: string;
    pendingShares: string;
    cooldownShares: string;
    estimatedUsdValue: number;
  }[];
  cooldowns: {
    id: string;
    asset: string;
    assetAddress: string;
    requestId: string;
    shares: string;
    unlockAt: string;
    claimed: boolean;
    txHash: string;
  }[];
}

/**
 * Calculates boost factor: 1 + 0.5 * min(1, tyrValue / baseAssetValue), capped at 1.5x
 * Rounded to 6 decimals.
 */
export function calculateBoost(tyrUsdValue: number, baseAssetUsdValue: number): number {
  if (baseAssetUsdValue <= 0) return 1.0;
  const ratio = tyrUsdValue / baseAssetUsdValue;
  const boost = 1.0 + 0.5 * Math.min(1.0, ratio);
  return Number(Math.min(1.5, boost).toFixed(6));
}

/**
 * Resolve token decimals based on active network manifest
 */
export function getAssetDecimals(symbolOrAddress: string): number {
  const s = symbolOrAddress.toLowerCase();
  if (s === "usdg" || s === tyrianNetwork.tokens.USDG.address?.toLowerCase()) {
    return tyrianNetwork.tokens.USDG.decimals ?? 6;
  }
  if (s === "tyrn" || s === "tyr" || s === tyrianNetwork.tokens.TYRN.address?.toLowerCase()) {
    return tyrianNetwork.tokens.TYRN.decimals ?? 18;
  }
  if (s === "weth" || s === tyrianNetwork.tokens.WETH.address?.toLowerCase()) {
    return tyrianNetwork.tokens.WETH.decimals ?? 18;
  }
  for (const [stockSym, config] of Object.entries(tyrianNetwork.stocks)) {
    if (s === stockSym.toLowerCase() || (config.address && config.address.toLowerCase() === s)) {
      return config.decimals ?? 18;
    }
  }
  return 18;
}

/**
 * Convert BigInt string with dynamic token decimals to floating number
 */
export function formatUnitsAsset(rawVal: string | bigint | number, symbolOrAddress: string): number {
  try {
    const decimals = getAssetDecimals(symbolOrAddress);
    const b = BigInt(rawVal);
    return Number(b) / (10 ** decimals);
  } catch {
    return 0;
  }
}

/**
 * Convert BigInt string with 18 decimals to floating USD value
 */
export function formatUnits18(rawVal: string): number {
  try {
    const b = BigInt(rawVal);
    return Number(b) / 1e18;
  } catch {
    return 0;
  }
}

export class QuotaService {
  /**
   * Resolves token symbol from address using network manifest
   */
  private resolveAssetSymbol(assetAddress: string): string {
    const addr = assetAddress.toLowerCase();
    if (addr === tyrianNetwork.tokens.USDG.address?.toLowerCase()) return "USDG";
    if (addr === tyrianNetwork.tokens.TYRN.address?.toLowerCase()) return "TYRN";
    if (addr === tyrianNetwork.tokens.WETH.address?.toLowerCase()) return "WETH";

    for (const [symbol, config] of Object.entries(tyrianNetwork.stocks)) {
      if (config.address && config.address.toLowerCase() === addr) {
        return symbol;
      }
    }

    return "UNKNOWN";
  }

  /**
   * Compute seconds and date for the next 00:00 UTC epoch reset
   */
  getNextEpochReset(): { secondsUntilReset: number; resetTimeUtc: string } {
    const now = new Date();
    const tomorrowUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
    );
    const secondsUntilReset = Math.max(0, Math.floor((tomorrowUtc.getTime() - now.getTime()) / 1000));
    return { secondsUntilReset, resetTimeUtc: tomorrowUtc.toISOString() };
  }

  /**
   * Retrieves or computes quota for a user.
   * If not cached in Redis, calculates live from indexer positions.
   * Strictly returns 0 for users with no stake.
   */
  async getUserQuota(userAddress: string): Promise<UserQuotaDetails> {
    const normalized = userAddress.toLowerCase();
    const { secondsUntilReset, resetTimeUtc } = this.getNextEpochReset();

    // 1. Fetch user positions and unstake requests from indexer
    const [positions, unstakeReqs] = await Promise.all([
      indexerService.getUserStakePositions(normalized),
      indexerService.getUserUnstakeRequests(normalized),
    ]);

    let totalEffectiveStakeUsd = 0;
    let tyrStaked = 0;

    const formattedPositions = [];
    for (const p of positions) {
      const symbol = this.resolveAssetSymbol(p.assetAddress);
      // Effective shares = activeShares + pendingShares (pending will be active next epoch)
      const sharesAmount = formatUnitsAsset(p.activeShares, symbol) + formatUnitsAsset(p.pendingShares, symbol);

      // USDG is the accounting unit. TYR and stock tokens are priced from their
      // on-chain oracles; a missing/stale price throws instead of guessing.
      const usdValue =
        sharesAmount <= 0
          ? 0
          : symbol === "USDG"
            ? sharesAmount * USDG_USD
            : await pricingService.getUsdValue(symbol, sharesAmount);

      if (symbol === "TYRN" || symbol === "TYR") {
        tyrStaked += sharesAmount;
      } else {
        totalEffectiveStakeUsd += usdValue;
      }

      formattedPositions.push({
        asset: symbol,
        assetAddress: p.assetAddress,
        activeShares: p.activeShares,
        pendingShares: p.pendingShares,
        cooldownShares: p.cooldownShares,
        estimatedUsdValue: usdValue,
      });
    }

    const formattedCooldowns = unstakeReqs.map((r) => ({
      id: r.id,
      asset: this.resolveAssetSymbol(r.assetAddress),
      assetAddress: r.assetAddress,
      requestId: r.requestId,
      shares: r.shares,
      unlockAt: r.unlockAt,
      claimed: r.claimed,
      txHash: r.txHash,
    }));

    const isStaker = totalEffectiveStakeUsd > 0 || tyrStaked > 0;

    // 2. Check Redis for allocated quota
    const cached = await redis.getQuota(normalized);

    let allocatedUsd = cached.allocatedUsd;
    let usedUsd = cached.usedUsd;

    // 3. If no quota stored in Redis yet, calculate from live indexer pool
    if (allocatedUsd <= 0 && isStaker) {
      allocatedUsd = await this.estimateLiveQuotaForUser(normalized, totalEffectiveStakeUsd, tyrStaked);
      await redis.setQuota(normalized, allocatedUsd, usedUsd);
    } else if (!isStaker) {
      // Wallet with 0 stake gets 0 quota. Never default to 5.0!
      allocatedUsd = 0;
      usedUsd = 0;
    }

    const remainingUsd = Number(Math.max(0, allocatedUsd - usedUsd).toFixed(6));

    return {
      userAddress: normalized,
      allocatedUsd: Number(allocatedUsd.toFixed(6)),
      usedUsd: Number(usedUsd.toFixed(6)),
      remainingUsd,
      resetInSeconds: secondsUntilReset,
      resetTimeUtc,
      isStaker,
      totalEffectiveStakeUsd: Number(totalEffectiveStakeUsd.toFixed(4)),
      positions: formattedPositions,
      cooldowns: formattedCooldowns,
    };
  }

  /**
   * Helper to estimate quota on-the-fly when epoch hasn't run yet.
   */
  private async estimateLiveQuotaForUser(
    userAddress: string,
    userBaseUsd: number,
    userTyrAmount: number,
  ): Promise<number> {
    if (userBaseUsd <= 0 && userTyrAmount <= 0) return 0;

    // Fetch all positions from indexer to get total pool weight
    const allPositions = await indexerService.getAllStakePositions();
    const harvests = await indexerService.getRecentHarvestEvents();

    let totalHarvestedUsd = 0;
    for (const h of harvests) {
      // Harvest events are denominated in the vault asset (USDG = $1.00).
      totalHarvestedUsd += formatUnitsAsset(h.yieldAmount, "USDG");
    }

    // No harvested yield means no budget. Never inject a fake testnet minimum:
    // a zero budget must surface as zero quota, not as preview money.
    const utilizationFactor = parseFloat(process.env.UTILIZATION_FACTOR || "0.9");
    const baseBudget = totalHarvestedUsd * utilizationFactor;

    let totalPoolBaseUsd = 0;
    for (const pos of allPositions) {
      const sym = this.resolveAssetSymbol(pos.assetAddress);
      const shares = formatUnitsAsset(pos.activeShares, sym) + formatUnitsAsset(pos.pendingShares, sym);
      if (sym === "USDG") {
        totalPoolBaseUsd += shares * USDG_USD;
      }
    }

    if (totalPoolBaseUsd <= 0) {
      totalPoolBaseUsd = userBaseUsd;
    }

    const tyrUsd =
      userTyrAmount > 0 ? await pricingService.getUsdValue("TYRN", userTyrAmount) : 0;
    const boost = calculateBoost(tyrUsd, userBaseUsd);
    const userWeightedStake = userBaseUsd * boost;

    const share = totalPoolBaseUsd > 0 ? userWeightedStake / totalPoolBaseUsd : 1.0;
    const quota = Math.min(baseBudget, baseBudget * share);

    return Number(quota.toFixed(6));
  }
}

export const quotaService = new QuotaService();
