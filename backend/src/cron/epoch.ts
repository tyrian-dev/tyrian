import { redis } from "../services/redis";
import { openRouter } from "../services/openrouter";
import { indexerService, type StakePositionItem } from "../services/indexer";
import { calculateBoost, formatUnits18, formatUnitsAsset } from "../services/quota";
import { tyrianNetwork } from "../config/network";
import { dbService } from "../services/db";
import { budgetGuard } from "../services/budget";
import { alertService } from "../services/alert";
import { reserveService } from "../services/reserve";
import { resolveEpochBudgetWindow, type EpochBudgetWindow } from "../services/epoch-window";
import {
  pricingService,
  PriceUnavailableError,
  USDG_USD,
} from "../services/pricing";

export interface StakePosition {
  userAddress: string;
  asset: string;
  usdValue: number;
  tyrStakedAmount: number;
  usdgValue?: number;
  stockValue?: number;
}

export interface EpochRunSummary {
  timestamp: string;
  epochDate?: string;
  skipped?: boolean;
  reason?: string;
  utilizationFactor: number;
  stockPoolShare: number;
  budgets: {
    baseYieldUsd: number;
    stockPoolUsd: number;
    tyrPoolUsd: number;
    totalBudgetUsd: number;
    reserveTopUpUsd?: number;
  };
  /**
   * Window of indexed events that funded this epoch (BUD-001). Without it the
   * budget silently becomes a cumulative total of every harvest since deploy.
   */
  budgetWindow?: EpochBudgetWindow;
  damper?: {
    applied: boolean;
    rollingAvg7DayUsd: number;
    thresholdUsd: number;
    shortfallUsd: number;
    reserveTopUpUsd: number;
    maxDailyTopUpUsd: number;
    /** 2% of staker principal, the cap from the brief. */
    principalCapUsd?: number;
    /** On-chain USDG balance of `external.reserve`, or null when unknown. */
    reserveAvailableUsd?: number | null;
    /** Amount ops must move from reserve to the inference budget. */
    fundingRequiredUsd?: number;
    /** Why the damper did or did not apply. */
    reason?: string;
  };
  walletsProcessed: number;
  totalDistributedQuotaUsd: number;
  allocations: Array<{
    userAddress: string;
    quotaUsd: number;
    baseWeight: number;
    tyrAmount: number;
  }>;
}

function resolveAssetSymbol(assetAddress: string): string {
  const addr = assetAddress.toLowerCase();
  if (addr === tyrianNetwork.tokens.USDG.address?.toLowerCase()) return "USDG";
  if (addr === tyrianNetwork.tokens.TYR.address?.toLowerCase()) return "TYR";
  if (addr === tyrianNetwork.tokens.WETH.address?.toLowerCase()) return "WETH";

  for (const [symbol, config] of Object.entries(tyrianNetwork.stocks)) {
    if (config.address && config.address.toLowerCase() === addr) {
      return symbol;
    }
  }

  return "UNKNOWN";
}

/**
 * Executes daily epoch job at 00:00 UTC (or on-demand):
 * 1. Collects live positions and harvested events from indexer (if not supplied in params).
 * 2. Computes pro-rata daily quota per wallet strictly adhering to 6 decimal precision and zero-minimum.
 * 3. Writes updated quotas to Redis and resets used to 0.
 * 4. Updates sub-key limits in OpenRouter Management API.
 */
export async function runDailyEpochJob(params?: {
  epochDate?: string;
  force?: boolean;
  harvestedYieldUsd?: number;
  creatorFeesUsd?: number;
  positions?: StakePosition[];
  recentCompletedEpochs?: Array<{ totalBudgetUsd: number | string }>;
  totalPrincipalUsd?: number;
  /**
   * On-chain reserve balance for the damper (BUD-002). Tests pass a number;
   * production omits it so the value comes from `external.reserve`.
   * `null` means "not knowable" and disables the top-up.
   */
  reserveAvailableUsd?: number | null;
  /** Lookback override for the budget window in days (BUD-001). */
  budgetWindowDays?: number;
  /**
   * Explicit TYR price for tests and deterministic replays. Production omits
   * this so the price comes from TyrTwapOracle; an unavailable oracle fails the
   * epoch instead of falling back to a hardcoded value.
   */
  tyrPriceUsd?: number;
}): Promise<EpochRunSummary> {
  const timestamp = new Date().toISOString();
  const epochDate = params?.epochDate || timestamp.split("T")[0];
  console.log(`[Epoch Job ${timestamp}] Starting quota redistribution for epoch ${epochDate}...`);

  const utilizationFactor = parseFloat(process.env.UTILIZATION_FACTOR || "0.9");
  const stockPoolShare = parseFloat(process.env.STOCK_POOL_SHARE || "0.4");

  // 1. Check PostgreSQL idempotency record (BE-EPOCH-009)
  if (!params?.force) {
    const existingEpoch = await dbService.getQuotaEpoch(epochDate);
    if (existingEpoch && existingEpoch.status === "COMPLETED") {
      console.log(`[Epoch Job ${timestamp}] Epoch ${epochDate} is already COMPLETED. Skipping duplicate execution (BE-EPOCH-009).`);
      return {
        timestamp,
        epochDate,
        skipped: true,
        reason: `Epoch ${epochDate} already completed`,
        utilizationFactor,
        stockPoolShare,
        budgets: {
          baseYieldUsd: 0,
          stockPoolUsd: 0,
          tyrPoolUsd: 0,
          totalBudgetUsd: Number(existingEpoch.totalBudgetUsd),
        },
        walletsProcessed: existingEpoch.walletsCount,
        totalDistributedQuotaUsd: Number(existingEpoch.totalAllocatedUsd),
        allocations: [],
      };
    }
  }

  // 2. Acquire Redis distributed lock (BE-EPOCH-009)
  const lockKey = `tyrian:lock:epoch:${epochDate}`;
  const lockAcquired = await redis.acquireLock(lockKey, 300);
  if (!lockAcquired && !params?.force) {
    console.warn(`[Epoch Job ${timestamp}] Epoch lock for ${epochDate} is currently active. Skipping concurrent execution.`);
    return {
      timestamp,
      epochDate,
      skipped: true,
      reason: `Lock active for ${epochDate}`,
      utilizationFactor,
      stockPoolShare,
      budgets: { baseYieldUsd: 0, stockPoolUsd: 0, tyrPoolUsd: 0, totalBudgetUsd: 0 },
      walletsProcessed: 0,
      totalDistributedQuotaUsd: 0,
      allocations: [],
    };
  }

  try {
    let harvestedYieldUsd = params?.harvestedYieldUsd;
    let creatorFeesUsd = params?.creatorFeesUsd;

    // Budget window: only events produced in the window immediately before the
    // epoch start fund this epoch (BUD-001). Querying without a window turns the
    // budget into a cumulative total of everything since deploy.
    const budgetWindow = resolveEpochBudgetWindow(epochDate, params?.budgetWindowDays);

    // 1. Fetch & value harvested yield using oracle pricing (GAP-005)
    if (harvestedYieldUsd === undefined) {
      const harvests = await indexerService.getRecentHarvestEvents({
        sinceSec: budgetWindow.sinceSec,
        untilSec: budgetWindow.untilSec,
      });
      let sumYieldUsd = 0;
      for (const h of harvests) {
        const symbol = resolveAssetSymbol(h.token);
        if (symbol === "UNKNOWN") {
          throw new PriceUnavailableError(h.token, "unsupported_asset");
        }
        const amount = formatUnitsAsset(h.yieldAmount, symbol);
        const price = await pricingService.getUsdPrice(symbol);
        sumYieldUsd += amount * price;
      }
      harvestedYieldUsd = sumYieldUsd;
    }

    // 2. Fetch & value creator fee splits using oracle pricing (GAP-001)
    if (creatorFeesUsd === undefined) {
      const feeSplits = await indexerService.getRecentFeeSplits({
        sinceSec: budgetWindow.sinceSec,
        untilSec: budgetWindow.untilSec,
      });
      let sumFeeUsd = 0;
      for (const fs of feeSplits) {
        const symbol = resolveAssetSymbol(fs.token);
        if (symbol === "UNKNOWN") continue;
        const feeAmount = formatUnitsAsset(fs.treasuryAmount, symbol);
        const price = await pricingService.getUsdPrice(symbol);
        sumFeeUsd += feeAmount * price;
      }
      creatorFeesUsd = sumFeeUsd;
    }

    let positions: StakePosition[] = params?.positions ?? [];

    if (!params?.positions) {
      const rawPositions = await indexerService.getAllStakePositions();

      // Current epoch number matching block.timestamp / 1 days (anti-flash-stake GAP-003)
      const epochTimestamp = epochDate ? new Date(epochDate).getTime() : Date.now();
      const currentEpochNumber = BigInt(Math.floor(epochTimestamp / 86400000));

      const rows = rawPositions.map((raw) => {
        const symbol = resolveAssetSymbol(raw.assetAddress);
        const effectiveEpoch = raw.effectiveEpoch ? BigInt(raw.effectiveEpoch) : 0n;
        // Stake is only active if effectiveEpoch <= currentEpochNumber (anti-flash-stake)
        const pendingEligible = effectiveEpoch === 0n || effectiveEpoch <= currentEpochNumber;
        const effectiveShares = formatUnitsAsset(raw.activeShares, symbol) + (pendingEligible ? formatUnitsAsset(raw.pendingShares, symbol) : 0);

        return {
          raw,
          user: raw.userAddress.toLowerCase(),
          symbol,
          effectiveShares,
        };
      });

      // Resolve each distinct non-TYR symbol once. Pricing is fail-closed: a
      // stale/missing oracle throws before any quota is written.
      const symbols = new Set(
        rows
          .filter((row) => row.effectiveShares > 0 && row.symbol !== "TYR")
          .map((row) => row.symbol),
      );
      const prices = new Map<string, number>();
      for (const symbol of symbols) {
        prices.set(
          symbol,
          symbol === "USDG" ? USDG_USD : await pricingService.getUsdPrice(symbol),
        );
      }

      const positionMap = new Map<string, { usdgValue: number; stockValue: number; tyrStakedAmount: number }>();

      for (const row of rows) {
        const entry = positionMap.get(row.user) || { usdgValue: 0, stockValue: 0, tyrStakedAmount: 0 };
        if (row.symbol === "TYR") {
          entry.tyrStakedAmount += row.effectiveShares;
        } else if (row.symbol === "USDG") {
          entry.usdgValue += row.effectiveShares * USDG_USD;
        } else if (row.effectiveShares > 0) {
          const price = prices.get(row.symbol);
          if (price === undefined) {
            throw new PriceUnavailableError(row.symbol, "unsupported_asset");
          }
          entry.stockValue += row.effectiveShares * price;
        }
        positionMap.set(row.user, entry);
      }

      positions = Array.from(positionMap.entries()).map(([userAddress, data]) => ({
        userAddress,
        asset: "PORTFOLIO",
        usdValue: data.usdgValue + data.stockValue,
        usdgValue: data.usdgValue,
        stockValue: data.stockValue,
        tyrStakedAmount: data.tyrStakedAmount,
      }));
    }

    // Natural daily budget pools (Brief §4)
    let naturalBaseYieldBudget = harvestedYieldUsd * utilizationFactor;
    const totalFeeBudget = creatorFeesUsd * utilizationFactor;
    const stockBudget = totalFeeBudget * stockPoolShare;
    const tyrBudget = totalFeeBudget * (1.0 - stockPoolShare);
    const naturalTotalBudgetUsd = naturalBaseYieldBudget + stockBudget + tyrBudget;

    // 7-day Budget Damper & Reserve Top-Up (GAP-007 / BUD-002 / Brief §7)
    // If natural budget is < 70% of the rolling 7-day average, the reserve tops
    // it up. The top-up is capped by BOTH the brief limit (2% of principal per
    // day) and the USDG the reserve actually holds: the damper must never
    // authorise spending that has no funding behind it.
    let recentEpochs = params?.recentCompletedEpochs;
    if (!recentEpochs) {
      const dbRecent = await dbService.getRecentCompletedEpochs(7, epochDate);
      recentEpochs = dbRecent.map((r) => ({ totalBudgetUsd: Number(r.totalBudgetUsd) }));
    }

    let damperApplied = false;
    let rollingAvg7DayUsd = 0;
    let thresholdUsd = 0;
    let shortfallUsd = 0;
    let reserveTopUpUsd = 0;
    let maxDailyTopUpUsd = 0;
    let principalCapUsd = 0;
    let reserveAvailableUsd: number | null = null;
    let damperReason = "not_needed";

    if (recentEpochs.length > 0) {
      const sumRecent = recentEpochs.reduce((acc, ep) => acc + Number(ep.totalBudgetUsd), 0);
      rollingAvg7DayUsd = Number((sumRecent / recentEpochs.length).toFixed(6));
      thresholdUsd = Number((rollingAvg7DayUsd * 0.70).toFixed(6));

      if (naturalTotalBudgetUsd < thresholdUsd) {
        shortfallUsd = Number((thresholdUsd - naturalTotalBudgetUsd).toFixed(6));

        const totalPrincipal =
          params?.totalPrincipalUsd !== undefined
            ? params.totalPrincipalUsd
            : positions.reduce((sum, pos) => sum + (pos.usdValue || 0), 0);

        principalCapUsd = Number((totalPrincipal * 0.02).toFixed(6)); // 2% principal/day ceiling

        reserveAvailableUsd =
          params?.reserveAvailableUsd !== undefined
            ? params.reserveAvailableUsd
            : await reserveService.getReserveUsdgBalanceUsd();

        if (reserveAvailableUsd === null || reserveAvailableUsd === undefined) {
          // Unknown funding source: do not invent budget.
          damperReason = "reserve_balance_unavailable";
        } else if (!(reserveAvailableUsd > 0)) {
          damperReason = "reserve_exhausted";
        } else {
          maxDailyTopUpUsd = Number(
            Math.min(principalCapUsd, reserveAvailableUsd).toFixed(6),
          );
          reserveTopUpUsd = Number(Math.min(shortfallUsd, maxDailyTopUpUsd).toFixed(6));

          if (reserveTopUpUsd > 0) {
            damperApplied = true;
            damperReason = "reserve_top_up";
            naturalBaseYieldBudget += reserveTopUpUsd;
            console.log(
              `[Epoch Damper] Shortfall detected (Natural: $${naturalTotalBudgetUsd.toFixed(2)} < 70% avg: $${thresholdUsd.toFixed(2)}). Reserve top-up: +$${reserveTopUpUsd.toFixed(2)} (cap: min(2% principal $${principalCapUsd.toFixed(2)}, reserve $${reserveAvailableUsd.toFixed(2)})) = $${maxDailyTopUpUsd.toFixed(2)}.`,
            );

            // The budget only becomes real money once ops move it. Record the
            // obligation and page the operator instead of silently spending.
            await alertService
              .dispatchAlert(
                "BUDGET_WARNING",
                "WARNING",
                "Reserve Top-Up Required",
                `Epoch ${epochDate} shortfall $${shortfallUsd.toFixed(2)}. ` +
                  `Transfer $${reserveTopUpUsd.toFixed(2)} from the treasury reserve to the inference budget ` +
                  `(reserve balance $${reserveAvailableUsd.toFixed(2)}).`,
              )
              .catch((err: unknown) => {
                console.warn(
                  "[Epoch Damper] Alert dispatch failed:",
                  err instanceof Error ? err.message : err,
                );
              });
          } else {
            damperReason = "cap_reached";
          }
        }
      }
    }

    const baseYieldBudget = naturalBaseYieldBudget;
    const totalBudgetUsd = baseYieldBudget + stockBudget + tyrBudget;

    console.log(
      `[Epoch Job] Budgets: BaseYield=$${baseYieldBudget.toFixed(4)}${reserveTopUpUsd > 0 ? ` (+$${reserveTopUpUsd.toFixed(4)} reserve top-up)` : ""}, Stock=$${stockBudget.toFixed(4)}, TYR=$${tyrBudget.toFixed(4)} (Total=$${totalBudgetUsd.toFixed(4)})`,
    );

    // Record start in PostgreSQL (BE-EPOCH-009)
    await dbService.startQuotaEpoch({
      epochDate,
      totalBudgetUsd,
    });

    // Sync protocol daily budget to BudgetGuard (BE-GW-011)
    await budgetGuard.setDailyEpochBudget(totalBudgetUsd);

    // Calculate weighted stakes per asset class without cross-subsidy (GAP-002)
    let totalUsdgWeighted = 0;
    let totalStockWeighted = 0;
    let totalTyrStaked = 0;

    // TYR boost needs a real TYR/USD price. Fetch it once, and only when a TYR
    // position exists. Without a price the epoch fails rather than guessing.
    const totalTyrAmount = positions.reduce((sum, pos) => sum + pos.tyrStakedAmount, 0);
    let tyrPriceUsd = 0;
    if (totalTyrAmount > 0) {
      if (params?.tyrPriceUsd !== undefined) {
        if (!(params.tyrPriceUsd > 0)) {
          throw new PriceUnavailableError("TYR", "zero_price", "params.tyrPriceUsd");
        }
        tyrPriceUsd = params.tyrPriceUsd;
      } else {
        tyrPriceUsd = await pricingService.getTyrPriceUsd();
      }
    }

    const userWeights = new Map<
      string,
      {
        usdgWeight: number;
        stockWeight: number;
        tyrAmount: number;
        totalBaseValue: number;
      }
    >();

    for (const pos of positions) {
      // Determine USDG vs Stock composition with backward compatibility
      let usdgVal = pos.usdgValue;
      let stockVal = pos.stockValue;
      if (usdgVal === undefined && stockVal === undefined) {
        if (pos.asset === "STOCK" || tyrianNetwork.stocks[pos.asset.toUpperCase()]) {
          stockVal = pos.usdValue;
          usdgVal = 0;
        } else {
          // Default to base USDG yield pool
          usdgVal = pos.usdValue;
          stockVal = 0;
        }
      } else {
        usdgVal = usdgVal ?? 0;
        stockVal = stockVal ?? 0;
      }

      const totalBaseUsd = usdgVal + stockVal;
      const tyrUsd = pos.tyrStakedAmount * tyrPriceUsd;
      const boost = calculateBoost(tyrUsd, totalBaseUsd);

      const usdgWeighted = usdgVal * boost;
      const stockWeighted = stockVal * boost;

      const current = userWeights.get(pos.userAddress) || {
        usdgWeight: 0,
        stockWeight: 0,
        tyrAmount: 0,
        totalBaseValue: 0,
      };
      current.usdgWeight += usdgWeighted;
      current.stockWeight += stockWeighted;
      current.tyrAmount += pos.tyrStakedAmount;
      current.totalBaseValue += totalBaseUsd;
      userWeights.set(pos.userAddress, current);

      totalUsdgWeighted += usdgWeighted;
      totalStockWeighted += stockWeighted;
      totalTyrStaked += pos.tyrStakedAmount;
    }

    const allocations: Array<{
      userAddress: string;
      quotaUsd: number;
      baseWeight: number;
      tyrAmount: number;
    }> = [];

    let totalDistributedQuotaUsd = 0;

    // Distribute quota per pool without cross-subsidy (GAP-002)
    for (const [address, data] of userWeights.entries()) {
      let quotaUsd = 0;

      // 1. Base USDG Yield Pool -> strictly for USDG stakers
      if (totalUsdgWeighted > 0 && data.usdgWeight > 0) {
        quotaUsd += baseYieldBudget * (data.usdgWeight / totalUsdgWeighted);
      }

      // 2. Stock Token Pool -> strictly for Stock Token stakers
      if (totalStockWeighted > 0 && data.stockWeight > 0) {
        quotaUsd += stockBudget * (data.stockWeight / totalStockWeighted);
      }

      // 3. TYR Pool -> strictly for TYR stakers
      if (totalTyrStaked > 0 && data.tyrAmount > 0) {
        quotaUsd += tyrBudget * (data.tyrAmount / totalTyrStaked);
      }

      // Round to 6 decimals, strictly zero if no stake weight
      quotaUsd = quotaUsd > 0 ? Number(quotaUsd.toFixed(6)) : 0;

      // Save to Redis
      await redis.setQuota(address, quotaUsd, 0); // reset used to 0 for new epoch

      // Save to persistent Postgres storage
      const totalWeighted = data.usdgWeight + data.stockWeight;
      void dbService.saveEpochQuota({
        userAddress: address,
        epochDate,
        allocatedUsd: quotaUsd,
        usedUsd: 0,
        boostMultiplier:
          data.totalBaseValue > 0
            ? Number((totalWeighted / data.totalBaseValue).toFixed(2))
            : 1.0,
      });

      // Sync sub-key limit to OpenRouter. A provider outage must not lose the
      // quota ledger: log it and keep the allocation, the gateway will fail
      // closed with 503 `provider_key_unavailable` until keys recover.
      try {
        await openRouter.createOrUpdateSubKey(address, quotaUsd);
      } catch (err) {
        console.error(
          `[Epoch Job] Failed to sync OpenRouter sub-key for ${address}:`,
          err instanceof Error ? err.message : err,
        );
      }

      allocations.push({
        userAddress: address,
        quotaUsd,
        baseWeight: Number(totalWeighted.toFixed(4)),
        tyrAmount: Number(data.tyrAmount.toFixed(4)),
      });

      totalDistributedQuotaUsd += quotaUsd;
      console.log(`[Epoch Job] Wallet ${address} assigned daily quota: $${quotaUsd}`);
    }

    totalDistributedQuotaUsd = Number(totalDistributedQuotaUsd.toFixed(6));

    // Complete epoch execution record in PostgreSQL (BE-EPOCH-009)
    await dbService.completeQuotaEpoch({
      epochDate,
      totalAllocatedUsd: totalDistributedQuotaUsd,
      walletsCount: allocations.length,
    });

    console.log(`[Epoch Job] Completed. Wallets: ${allocations.length}, Total quota: $${totalDistributedQuotaUsd}`);

    return {
      timestamp,
      epochDate,
      utilizationFactor,
      stockPoolShare,
      budgets: {
        baseYieldUsd: Number(baseYieldBudget.toFixed(6)),
        stockPoolUsd: Number(stockBudget.toFixed(6)),
        tyrPoolUsd: Number(tyrBudget.toFixed(6)),
        totalBudgetUsd: Number(totalBudgetUsd.toFixed(6)),
        reserveTopUpUsd: reserveTopUpUsd > 0 ? Number(reserveTopUpUsd.toFixed(6)) : 0,
      },
      budgetWindow,
      damper: {
        applied: damperApplied,
        rollingAvg7DayUsd,
        thresholdUsd,
        shortfallUsd,
        reserveTopUpUsd,
        maxDailyTopUpUsd,
        principalCapUsd,
        reserveAvailableUsd,
        fundingRequiredUsd: damperApplied ? reserveTopUpUsd : 0,
        reason: damperReason,
      },
      walletsProcessed: allocations.length,
      totalDistributedQuotaUsd,
      allocations,
    };
  } catch (err) {
    await dbService.failQuotaEpoch(epochDate);
    throw err;
  } finally {
    await redis.releaseLock(lockKey);
  }
}
