export type DataSourceMode = "preview" | "live";

export type AssetType = "base" | "stock" | "boost";

export interface AssetDef {
  symbol: string;
  name: string;
  type: AssetType;
  price: number;
  pool: string;
  addr?: string;
  feed?: string;
}

export interface PreviewPool {
  name: string;
  weight: number;
  share: number;
  B: number;
  unit: boolean;
  q: number;
}

export interface PreviewQuota {
  boost: number;
  pools: PreviewPool[];
  total: number;
}

export interface QuotaSnapshot {
  allocatedUsd: number;
  usedUsd: number;
  remainingUsd: number;
  resetInSeconds: number;
  resetTimeUtc?: string | null;
  source: DataSourceMode;
}

export interface StakePool {
  id: string;
  asset: string;
  budgetUsd: number;
  totalWeight: number;
  source: DataSourceMode;
}

export interface UserPosition {
  id: string;
  asset: string;
  amount: number;
  valueUsd: number;
  status: "active" | "cooldown";
  cooldownEnds?: string;
}

export interface BoostState {
  boost: number;
  tyrValueUsd: number;
  baseValueUsd: number;
  source: DataSourceMode;
}

export interface UsagePoint {
  date: string;
  costUsd: number;
  source: DataSourceMode;
}

export interface ProviderMix {
  name: string;
  pct: number;
  color: string;
}
