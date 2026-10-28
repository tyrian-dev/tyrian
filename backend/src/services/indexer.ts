import { createPublicClient, type PublicClient } from "viem";
import { createResilientRpcTransport, StakeManagerAbi } from "@shared/contracts";
import { tyrianNetwork } from "../config/network";
import { alertService } from "./alert";

export interface IndexerStatusReport {
  healthy: boolean;
  endpoint: string;
  latencyMs: number;
  lastChecked: string;
  latestIndexedBlock?: number;
  latestOnChainBlock?: number;
  blockLag?: number;
  lagging?: boolean;
  error?: string;
}

export interface StakePositionItem {
  id: string;
  userAddress: string;
  assetAddress: string;
  activeShares: string;
  pendingShares: string;
  cooldownShares: string;
  earliestUnlockAt?: string;
  effectiveEpoch?: string;
  lastUpdatedBlock: string;
}

export interface UnstakeRequestItem {
  id: string;
  userAddress: string;
  assetAddress: string;
  requestId: string;
  shares: string;
  unlockAt: string;
  claimed: boolean;
  txHash: string;
  blockNumber: string;
}

export interface HarvestEventItem {
  id: string;
  token: string;
  yieldAmount: string;
  treasury: string;
  txHash: string;
  blockTimestamp: string;
}

export interface FeeSplitEventItem {
  id: string;
  token: string;
  treasuryAmount: string;
  buybackAmount: string;
  txHash: string;
  blockTimestamp: string;
}

export interface BurnEventItem {
  id: string;
  token: string;
  amount: string;
  source: string;
  txHash: string;
  blockTimestamp: string;
}

/**
 * Optional time window for event queries (BUD-001).
 *
 * `sinceSec` is inclusive and `untilSec` is exclusive, both in unix seconds, so
 * a caller can ask for exactly one UTC day without worrying about inclusive
 * boundaries at the seam between two epochs.
 */
export interface EventWindow {
  sinceSec?: number | bigint | null;
  untilSec?: number | bigint | null;
  limit?: number;
}

interface WindowQuery {
  variableDefinitions: string;
  whereClause: string;
  variables: Record<string, string>;
  limit: number;
}

const DEFAULT_EVENT_LIMIT = 1000;

function buildWindowQuery(window?: EventWindow): WindowQuery {
  const limit =
    window?.limit !== undefined && Number.isFinite(window.limit) && window.limit > 0
      ? Math.floor(window.limit)
      : DEFAULT_EVENT_LIMIT;

  const conditions: string[] = [];
  const variables: Record<string, string> = {};

  if (window?.sinceSec !== undefined && window.sinceSec !== null) {
    conditions.push("blockTimestamp_gte: $since");
    variables.since = BigInt(window.sinceSec).toString();
  }
  if (window?.untilSec !== undefined && window.untilSec !== null) {
    conditions.push("blockTimestamp_lt: $until");
    variables.until = BigInt(window.untilSec).toString();
  }

  const variableDefinitions = Object.keys(variables)
    .map((name) => `$${name}: BigInt`)
    .join(", ");

  return {
    variableDefinitions,
    whereClause: conditions.length > 0 ? `, where: { ${conditions.join(", ")} }` : "",
    variables,
    limit,
  };
}

export interface TreasuryRoutedItem {
  id: string;
  usdgIn: string;
  budgetOut: string;
  reserveOut: string;
  portfolioOut: string;
  txHash: string;
  blockTimestamp: string;
}

export class IndexerService {
  private getEndpoint(): string {
    return process.env.INDEXER_URL || "http://localhost:42069";
  }

  private async executeQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
    const endpoint = this.getEndpoint();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        console.warn(`[IndexerService] GraphQL request failed with status ${response.status}`);
        return null;
      }

      const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (payload.errors && payload.errors.length > 0) {
        console.warn(`[IndexerService] GraphQL errors:`, payload.errors);
        return null;
      }

      return payload.data ?? null;
    } catch (err) {
      console.warn(`[IndexerService] Failed to connect to indexer at ${endpoint}:`, (err as Error).message);
      return null;
    }
  }

  async isIndexerHealthy(): Promise<boolean> {
    const data = await this.executeQuery<{ stakePositions: { items: unknown[] } }>(`{
      stakePositions(limit: 1) {
        items { id }
      }
    }`);
    return data !== null;
  }

  /**
   * Performs an operational health check, block lag benchmark, and auto-alerting of Ponder indexer (IDX-007 / IDX-OPS-006 / IDX-OPS-007)
   */
  async getIndexerStatus(): Promise<IndexerStatusReport> {
    const start = Date.now();
    const endpoint = this.getEndpoint();
    try {
      // 1. Query Ponder for most recent indexed block
      const ponderData = await this.executeQuery<{
        stakePositions: { items: Array<{ lastUpdatedBlock: string }> };
        unstakeRequests: { items: Array<{ blockNumber: string }> };
      }>(`{
        stakePositions(limit: 1, orderBy: "lastUpdatedBlock", orderDirection: "desc") {
          items { lastUpdatedBlock }
        }
        unstakeRequests(limit: 1, orderBy: "blockNumber", orderDirection: "desc") {
          items { blockNumber }
        }
      }`);

      const isHealthy = ponderData !== null;
      let latestIndexedBlock: number | undefined;

      if (ponderData) {
        const pBlock = ponderData.stakePositions?.items?.[0]?.lastUpdatedBlock;
        const uBlock = ponderData.unstakeRequests?.items?.[0]?.blockNumber;
        const blocks = [Number(pBlock || 0), Number(uBlock || 0)].filter((b) => !isNaN(b) && b > 0);
        if (blocks.length > 0) {
          latestIndexedBlock = Math.max(...blocks);
        } else {
          // If no events indexed yet, fallback to manifest startBlock
          latestIndexedBlock = tyrianNetwork.startBlock ?? undefined;
        }
      }

      // 2. Fetch latest on-chain block with 3s timeout
      let latestOnChainBlock: number | undefined;
      try {
        const rpcUrl =
          process.env.RPC_URL ||
          (tyrianNetwork as unknown as { rpcUrl?: string }).rpcUrl ||
          "https://rpc.testnet.chain.robinhood.com";
        const fallbackUrls = process.env.RPC_FALLBACK_URLS || "";
        const client = createPublicClient({
          transport: createResilientRpcTransport(rpcUrl, fallbackUrls, {
            timeout: 3000,
            retryCount: 2,
          }),
        });
        const currentBlock = await client.getBlockNumber();
        latestOnChainBlock = Number(currentBlock);
      } catch {
        // Non-fatal if public RPC times out during healthcheck
      }

      // 3. Compute block lag
      let blockLag: number | undefined;
      let isLagging = false;

      if (latestOnChainBlock !== undefined && latestIndexedBlock !== undefined) {
        blockLag = Math.max(0, latestOnChainBlock - latestIndexedBlock);
        if (blockLag > 100) {
          isLagging = true;
          void alertService.dispatchAlert(
            "INDEXER_LAG",
            "WARNING",
            "Indexer Block Lag Detected",
            `Ponder indexer is lagging behind on-chain tip by ${blockLag} blocks (Indexed: ${latestIndexedBlock}, Chain: ${latestOnChainBlock}).`,
            { blockLag, latestIndexedBlock, latestOnChainBlock },
          );
        }
      }

      const latencyMs = Date.now() - start;

      return {
        healthy: isHealthy,
        endpoint,
        latencyMs,
        lastChecked: new Date().toISOString(),
        latestIndexedBlock,
        latestOnChainBlock,
        blockLag,
        lagging: isLagging,
      };
    } catch (err) {
      return {
        healthy: false,
        endpoint,
        latencyMs: Date.now() - start,
        lastChecked: new Date().toISOString(),
        error: (err as Error).message,
      };
    }
  }

  private client: PublicClient | null = null;

  private getPublicClient(): PublicClient {
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

  async getUserStakePositions(userAddress: string): Promise<StakePositionItem[]> {
    const normalized = userAddress.toLowerCase();
    const data = await this.executeQuery<{ stakePositions: { items: StakePositionItem[] } }>(
      `query GetUserPositions($user: String!) {
        stakePositions(where: { userAddress: $user }) {
          items {
            id
            userAddress
            assetAddress
            activeShares
            pendingShares
            cooldownShares
            earliestUnlockAt
            effectiveEpoch
            lastUpdatedBlock
          }
        }
      }`,
      { user: normalized },
    );

    if (data !== null) {
      return data.stakePositions?.items ?? [];
    }

    // Failover: When Ponder indexer GraphQL is offline/unreachable, query on-chain StakeManager directly
    try {
      const smAddress = tyrianNetwork.contracts.StakeManager;
      if (!smAddress) return [];

      const client = this.getPublicClient();
      const assetsToCheck: string[] = [];
      if (tyrianNetwork.tokens.USDG.address) assetsToCheck.push(tyrianNetwork.tokens.USDG.address);
      if (tyrianNetwork.tokens.TYR.address) assetsToCheck.push(tyrianNetwork.tokens.TYR.address);

      const items: StakePositionItem[] = [];
      for (const asset of assetsToCheck) {
        const [activeShares, pendingShares, cooldownShares, earliestUnlockAt] = await client.readContract({
          address: smAddress as `0x${string}`,
          abi: StakeManagerAbi,
          functionName: "positions",
          args: [normalized as `0x${string}`, asset as `0x${string}`],
        });

        if (activeShares > 0n || pendingShares > 0n || cooldownShares > 0n) {
          items.push({
            id: `${normalized}-${asset.toLowerCase()}`,
            userAddress: normalized,
            assetAddress: asset.toLowerCase(),
            activeShares: activeShares.toString(),
            pendingShares: pendingShares.toString(),
            cooldownShares: cooldownShares.toString(),
            earliestUnlockAt: earliestUnlockAt.toString(),
            lastUpdatedBlock: "0",
          });
        }
      }
      return items;
    } catch {
      return [];
    }
  }

  async getUserUnstakeRequests(userAddress: string): Promise<UnstakeRequestItem[]> {
    const normalized = userAddress.toLowerCase();
    const data = await this.executeQuery<{ unstakeRequests: { items: UnstakeRequestItem[] } }>(
      `query GetUserUnstakeRequests($user: String!) {
        unstakeRequests(where: { userAddress: $user, claimed: false }) {
          items {
            id
            userAddress
            assetAddress
            requestId
            shares
            unlockAt
            claimed
            txHash
            blockNumber
          }
        }
      }`,
      { user: normalized },
    );

    return data?.unstakeRequests?.items ?? [];
  }

  async getAllStakePositions(): Promise<StakePositionItem[]> {
    const data = await this.executeQuery<{ stakePositions: { items: StakePositionItem[] } }>(
      `{
        stakePositions(limit: 1000) {
          items {
            id
            userAddress
            assetAddress
            activeShares
            pendingShares
            cooldownShares
            earliestUnlockAt
            effectiveEpoch
            lastUpdatedBlock
          }
        }
      }`,
    );

    return data?.stakePositions?.items ?? [];
  }

  async getRecentHarvestEvents(window?: EventWindow): Promise<HarvestEventItem[]> {
    const { variableDefinitions, whereClause, variables, limit } = buildWindowQuery(window);

    const data = await this.executeQuery<{ harvestEvents: { items: HarvestEventItem[] } }>(
      `query HarvestEvents${variableDefinitions ? `(${variableDefinitions})` : ""} {
        harvestEvents(limit: ${limit}, orderBy: "blockTimestamp", orderDirection: "desc"${whereClause}) {
          items {
            id
            token
            yieldAmount
            treasury
            txHash
            blockTimestamp
          }
        }
      }`,
      Object.keys(variables).length > 0 ? variables : undefined,
    );

    return data?.harvestEvents?.items ?? [];
  }

  async getRecentFeeSplits(window?: EventWindow): Promise<FeeSplitEventItem[]> {
    const { variableDefinitions, whereClause, variables, limit } = buildWindowQuery(window);

    const data = await this.executeQuery<{ feeSplitEvents: { items: FeeSplitEventItem[] } }>(
      `query FeeSplitEvents${variableDefinitions ? `(${variableDefinitions})` : ""} {
        feeSplitEvents(limit: ${limit}, orderBy: "blockTimestamp", orderDirection: "desc"${whereClause}) {
          items {
            id
            token
            treasuryAmount
            buybackAmount
            txHash
            blockTimestamp
          }
        }
      }`,
      Object.keys(variables).length > 0 ? variables : undefined,
    );

    return data?.feeSplitEvents?.items ?? [];
  }

  async getRecentBurns(): Promise<BurnEventItem[]> {
    const data = await this.executeQuery<{ burnEvents: { items: BurnEventItem[] } }>(
      `{
        burnEvents(limit: 1000, orderBy: "blockTimestamp", orderDirection: "desc") {
          items {
            id
            token
            amount
            source
            txHash
            blockTimestamp
          }
        }
      }`,
    );

    return data?.burnEvents?.items ?? [];
  }

  async getRecentTreasuryRouted(): Promise<TreasuryRoutedItem[]> {
    const data = await this.executeQuery<{ treasuryRoutedEvents: { items: TreasuryRoutedItem[] } }>(
      `{
        treasuryRoutedEvents(limit: 1000, orderBy: "blockTimestamp", orderDirection: "desc") {
          items {
            id
            usdgIn
            budgetOut
            reserveOut
            portfolioOut
            txHash
            blockTimestamp
          }
        }
      }`,
    );

    return data?.treasuryRoutedEvents?.items ?? [];
  }
}

export const indexerService = new IndexerService();
