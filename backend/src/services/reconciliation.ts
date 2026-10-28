import { createPublicClient, type PublicClient, parseAbi } from "viem";
import { createResilientRpcTransport } from "@shared/contracts";
import { tyrianNetwork, tyrianNetworkName } from "../config/network";
import { indexerService, type StakePositionItem } from "./indexer";
import { metricsService } from "./metrics";
import { alertService } from "./alert";
import { dbService } from "./db";
import { pricingService, PriceUnavailableError } from "./pricing";
import { StakeManagerAbi, UsdgVaultAbi } from "@shared/contracts/abis";

export interface AssetReconciliation {
  symbol: string;
  assetAddress: string;
  vaultAddress: string;
  onChainTotalShares: string;
  indexerTotalShares: string;
  diff: string;
  matched: boolean;
  vaultAssets: string;
  vaultPrincipal: string;
  solvent: boolean;
}

export interface EpochQuotaReconciliationReport {
  epochDate: string;
  status: "MATCH" | "DIFF_DETECTED" | "NOT_FOUND";
  totalBudgetUsd: number;
  recordedAllocatedUsd: number;
  aggregatedQuotasUsd: number;
  diffUsd: number;
  walletsCount: number;
  budgetConserved: boolean;
  timestamp: string;
}

export interface ReconciliationReport {
  status: "MATCH" | "DIFF_DETECTED" | "OFFLINE";
  timestamp: string;
  blockNumber?: number;
  network: string;
  assets: AssetReconciliation[];
  totalDiff: string;
  allMatched: boolean;
}

export interface EffectivePositionView {
  userAddress: string;
  assetAddress: string;
  symbol: string;
  effectiveActiveShares: string;
  pendingShares: string;
  cooldownShares: string;
  earliestUnlockAt: number;
  estimatedUsdValue: number;
  lastUpdatedBlock: number;
}

export class ReconciliationService {
  private client: PublicClient | null = null;

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

  /**
   * Reconciles on-chain StakeManager & Vault accounting against Indexer read-model (IDX-005)
   */
  async runReconciliation(injectedPositions?: StakePositionItem[]): Promise<ReconciliationReport> {
    const timestamp = new Date().toISOString();
    const assetsToCheck: Array<{ symbol: string; address: string; vault: string }> = [];

    // USDG
    if (tyrianNetwork.tokens.USDG.address && tyrianNetwork.contracts.UsdgVault) {
      assetsToCheck.push({
        symbol: "USDG",
        address: tyrianNetwork.tokens.USDG.address,
        vault: tyrianNetwork.contracts.UsdgVault,
      });
    }

    // TYR
    if (tyrianNetwork.tokens.TYR.address && tyrianNetwork.contracts.UsdgVault) {
      // TYR has config in StakeManager if enabled
      assetsToCheck.push({
        symbol: "TYR",
        address: tyrianNetwork.tokens.TYR.address,
        vault: tyrianNetwork.contracts.UsdgVault,
      });
    }

    // Enabled stocks
    for (const [symbol, config] of Object.entries(tyrianNetwork.stocks)) {
      if (config.enabled && config.address && config.vault) {
        assetsToCheck.push({
          symbol,
          address: config.address,
          vault: config.vault,
        });
      }
    }

    // 1. Fetch indexer positions
    const positions = injectedPositions ?? (await indexerService.getAllStakePositions());
    const indexerSharesByAsset = new Map<string, bigint>();

    for (const p of positions) {
      const asset = p.assetAddress.toLowerCase();
      const current = indexerSharesByAsset.get(asset) || 0n;
      // Staker total shares = active + pending
      const userTotal = BigInt(p.activeShares || "0") + BigInt(p.pendingShares || "0");
      indexerSharesByAsset.set(asset, current + userTotal);
    }

    const client = this.getClient();
    let currentBlock: number | undefined;
    try {
      currentBlock = Number(await client.getBlockNumber());
    } catch {
      // Fallback if local RPC offline
    }

    const stakeManagerAddress = tyrianNetwork.contracts.StakeManager as `0x${string}`;
    const assetReports: AssetReconciliation[] = [];
    let totalDiff = 0n;
    let allMatched = true;

    for (const asset of assetsToCheck) {
      let onChainTotalShares = 0n;
      let vaultAssets = 0n;
      let vaultPrincipal = 0n;

      if (stakeManagerAddress && currentBlock !== undefined) {
        try {
          const configResult = (await client.readContract({
            address: stakeManagerAddress,
            abi: StakeManagerAbi,
            functionName: "assetConfig",
            args: [asset.address as `0x${string}`],
          })) as [boolean, number, `0x${string}`, `0x${string}`, bigint, bigint];

          // configResult[5] is totalShares
          onChainTotalShares = configResult[5] ?? 0n;

          // Vault solvency
          const actualVault = configResult[2] || (asset.vault as `0x${string}`);
          if (actualVault && actualVault !== "0x0000000000000000000000000000000000000000") {
            try {
              vaultAssets = (await client.readContract({
                address: actualVault,
                abi: UsdgVaultAbi,
                functionName: "totalAssets",
              })) as bigint;

              vaultPrincipal = (await client.readContract({
                address: actualVault,
                abi: UsdgVaultAbi,
                functionName: "totalPrincipal",
              })) as bigint;
            } catch {
              // Non-fatal if test mock vault has different interface
            }
          }
        } catch {
          // If RPC fails for specific call, assume indexer match for offline testing
        }
      }

      // If offline or onChain is 0 and indexer has shares (e.g. mock test), compute diff
      const indexerTotal = indexerSharesByAsset.get(asset.address.toLowerCase()) || 0n;
      const diff = onChainTotalShares > indexerTotal ? onChainTotalShares - indexerTotal : indexerTotal - onChainTotalShares;
      const matched = diff === 0n;

      if (!matched) {
        allMatched = false;
        totalDiff += diff;
      }

      assetReports.push({
        symbol: asset.symbol,
        assetAddress: asset.address,
        vaultAddress: asset.vault,
        onChainTotalShares: onChainTotalShares.toString(),
        indexerTotalShares: indexerTotal.toString(),
        diff: diff.toString(),
        matched,
        vaultAssets: vaultAssets.toString(),
        vaultPrincipal: vaultPrincipal.toString(),
        solvent: vaultAssets >= vaultPrincipal,
      });
    }

    metricsService.setReconciliationDiff(Number(totalDiff));

    return {
      status: allMatched ? "MATCH" : "DIFF_DETECTED",
      timestamp,
      blockNumber: currentBlock,
      network: tyrianNetworkName,
      assets: assetReports,
      totalDiff: totalDiff.toString(),
      allMatched,
    };
  }

  /**
   * Generates derived view of effective positions for a given user (IDX-004)
   */
  async getEffectivePositionsView(userAddress: string): Promise<EffectivePositionView[]> {
    const rawPositions = await indexerService.getUserStakePositions(userAddress);
    const views: EffectivePositionView[] = [];

    for (const raw of rawPositions) {
      const active = BigInt(raw.activeShares || "0");
      const pending = BigInt(raw.pendingShares || "0");
      const cooldown = BigInt(raw.cooldownShares || "0");
      const unlockAt = Number(raw.earliestUnlockAt || "0");

      // Resolve symbol from the manifest. No hardcoded fallback price: unknown
      // assets or stale oracles surface as a pricing error for the caller.
      let symbol = "UNKNOWN";

      const addr = raw.assetAddress.toLowerCase();
      if (addr === tyrianNetwork.tokens.USDG.address?.toLowerCase()) {
        symbol = "USDG";
      } else if (addr === tyrianNetwork.tokens.TYR.address?.toLowerCase()) {
        symbol = "TYR";
      } else {
        for (const [stkSymbol, cfg] of Object.entries(tyrianNetwork.stocks)) {
          if (cfg.address?.toLowerCase() === addr) {
            symbol = stkSymbol;
            break;
          }
        }
      }

      const totalSharesNumber = Number(active + pending) / 1e18;
      let priceUsd = 0;
      if (totalSharesNumber > 0) {
        if (symbol === "UNKNOWN") {
          throw new PriceUnavailableError(raw.assetAddress, "unsupported_asset");
        }
        priceUsd = await pricingService.getUsdPrice(symbol);
      }
      const estimatedUsdValue = totalSharesNumber * priceUsd;

      views.push({
        userAddress: raw.userAddress.toLowerCase(),
        assetAddress: raw.assetAddress.toLowerCase(),
        symbol,
        effectiveActiveShares: active.toString(),
        pendingShares: pending.toString(),
        cooldownShares: cooldown.toString(),
        earliestUnlockAt: unlockAt,
        estimatedUsdValue,
        lastUpdatedBlock: Number(raw.lastUpdatedBlock || "0"),
      });
    }

    return views;
  }

  /**
   * Reconciles daily epoch quota distribution against PostgreSQL ledger (BE-EPOCH-010)
   */
  async reconcileDailyEpochQuota(epochDate: string): Promise<EpochQuotaReconciliationReport> {
    const timestamp = new Date().toISOString();
    const epochRecord = await dbService.getQuotaEpoch(epochDate);

    if (!epochRecord) {
      return {
        epochDate,
        status: "NOT_FOUND",
        totalBudgetUsd: 0,
        recordedAllocatedUsd: 0,
        aggregatedQuotasUsd: 0,
        diffUsd: 0,
        walletsCount: 0,
        budgetConserved: true,
        timestamp,
      };
    }

    // A failed or in-progress epoch has no finalized distribution to reconcile.
    // Reporting MATCH here would hide a failed settlement.
    if (epochRecord.status !== "COMPLETED") {
      return {
        epochDate,
        status: "NOT_FOUND",
        totalBudgetUsd: Number(epochRecord.totalBudgetUsd),
        recordedAllocatedUsd: Number(epochRecord.totalAllocatedUsd),
        aggregatedQuotasUsd: 0,
        diffUsd: 0,
        walletsCount: epochRecord.walletsCount,
        budgetConserved: true,
        timestamp,
      };
    }

    const recordedAllocated = Number(epochRecord.totalAllocatedUsd);
    const totalBudget = Number(epochRecord.totalBudgetUsd);
    const agg = await dbService.getEpochQuotasAggregation(epochDate);

    const diffUsd = Number(Math.abs(recordedAllocated - agg.totalAllocatedUsd).toFixed(6));
    const budgetConserved = recordedAllocated <= totalBudget + 0.0001;
    const isMatch = diffUsd <= 0.0001 && budgetConserved;

    if (!isMatch) {
      console.warn(
        `[Reconciliation] ⚠️ Epoch quota mismatch detected for ${epochDate}: Recorded=$${recordedAllocated}, Aggregated=$${agg.totalAllocatedUsd}, Diff=$${diffUsd}, Budget=$${totalBudget}`,
      );
      void alertService.dispatchAlert(
        "BUDGET_WARNING",
        "WARNING",
        "Epoch Quota Reconciliation Mismatch",
        `Discrepancy detected in quota epoch ${epochDate}. Recorded=$${recordedAllocated}, Aggregated=$${agg.totalAllocatedUsd}, Diff=$${diffUsd}.`,
        { epochDate, recordedAllocated, aggregated: agg.totalAllocatedUsd, diffUsd },
      );
    }

    return {
      epochDate,
      status: isMatch ? "MATCH" : "DIFF_DETECTED",
      totalBudgetUsd: totalBudget,
      recordedAllocatedUsd: recordedAllocated,
      aggregatedQuotasUsd: agg.totalAllocatedUsd,
      diffUsd,
      walletsCount: agg.walletsCount,
      budgetConserved,
      timestamp,
    };
  }
}

export const reconciliationService = new ReconciliationService();
