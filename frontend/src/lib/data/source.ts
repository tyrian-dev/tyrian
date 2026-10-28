import {
  ALL_ASSETS,
  PREVIEW_QUOTA,
  PREVIEW_RESET_SECONDS,
  STAKE_PREVIEW_POSITIONS,
  previewBalance,
} from "./preview";
import { activeNetwork } from "@shared/contracts/addresses";
import type {
  AssetDef,
  DataSourceMode,
  QuotaSnapshot,
  UserPosition,
} from "./types";

export const LIVE_DATA_NOT_CONFIGURED_MESSAGE =
  "Live data is not configured. Preview data is hidden instead of being shown as live.";

export function getDataSourceMode(): DataSourceMode {
  return process.env.NEXT_PUBLIC_DATA_SOURCE === "live" ? "live" : "preview";
}

export function isLiveDataMode(): boolean {
  return getDataSourceMode() === "live";
}

export interface DashboardDataSource {
  getQuota(): Promise<QuotaSnapshot>;
  getInitialQuota(): QuotaSnapshot;
}

export interface StakeDataSource {
  getAssets(): AssetDef[];
  getInitialPositions(): UserPosition[];
  getPreviewBalance(symbol: string): number;
}

const previewQuotaSnapshot: QuotaSnapshot = {
  allocatedUsd: PREVIEW_QUOTA.total,
  usedUsd: PREVIEW_QUOTA.total * 0.34,
  remainingUsd: PREVIEW_QUOTA.total * 0.66,
  resetInSeconds: PREVIEW_RESET_SECONDS,
  resetTimeUtc: null,
  source: "preview",
};

const previewDashboardDataSource: DashboardDataSource = {
  getInitialQuota() {
    return previewQuotaSnapshot;
  },
  async getQuota() {
    return previewQuotaSnapshot;
  },
};

const liveDashboardDataSource: DashboardDataSource = {
  getInitialQuota() {
    return {
      allocatedUsd: 0,
      usedUsd: 0,
      remainingUsd: 0,
      resetInSeconds: 0,
      resetTimeUtc: null,
      source: "live",
    };
  },
  async getQuota() {
    throw new Error(LIVE_DATA_NOT_CONFIGURED_MESSAGE);
  },
};

const previewStakeDataSource: StakeDataSource = {
  getAssets: () => ALL_ASSETS,
  getInitialPositions: () => STAKE_PREVIEW_POSITIONS,
  getPreviewBalance: previewBalance,
};

const liveStakeDataSource: StakeDataSource = {
  getAssets: () => {
    return ALL_ASSETS.map((asset) => {
      if (asset.symbol === "USDG") {
        return { ...asset, addr: activeNetwork.tokens.USDG?.address ?? undefined };
      }
      if (asset.symbol === "TYR") {
        return { ...asset, addr: activeNetwork.tokens.TYR?.address ?? undefined };
      }
      const stock = activeNetwork.stocks?.[asset.symbol];
      if (stock) {
        return {
          ...asset,
          addr: stock.address ?? undefined,
          feed: stock.feed ?? undefined,
        };
      }
      return asset;
    });
  },
  getInitialPositions: () => [],
  getPreviewBalance: () => 0,
};

export function getDashboardDataSource(): DashboardDataSource {
  return getDataSourceMode() === "live"
    ? liveDashboardDataSource
    : previewDashboardDataSource;
}

export function getStakeDataSource(): StakeDataSource {
  return isLiveDataMode() ? liveStakeDataSource : previewStakeDataSource;
}
