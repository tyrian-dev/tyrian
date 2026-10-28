export type Address = `0x${string}`;

export interface ModelPricing {
  promptTokenPriceUsd: number; // e.g. per 1M tokens
  completionTokenPriceUsd: number;
}

export interface AiModel {
  id: string; // e.g. "anthropic/claude-3.5-sonnet"
  name: string;
  contextLength: number;
  pricing: ModelPricing;
  isAllowed: boolean;
}

export interface UserQuota {
  userAddress: Address;
  allocatedUsd: number;
  usedUsd: number;
  remainingUsd: number;
  boostMultiplier: number;
  resetAt: string; // ISO date / 00:00 UTC
}

export interface ApiKeyItem {
  id: string;
  name: string;
  keyPrefix: string; // e.g. "tyr_live_••••a9f2"
  createdAt: string;
  isRevoked: boolean;
}

export interface TreasuryMetrics {
  tvlUsd: number;
  dailyQuotaDistributedUsd: number;
  totalHarvestedUsd: number;
  totalInferenceFundedUsd: number;
  totalTyrBurned: string;
  stockPortfolioUsd: number;
}
