import { onchainTable } from "ponder";

export const stakePosition = onchainTable("stake_position", (t) => ({
  id: t.text().primaryKey(), // userAddress-assetAddress
  userAddress: t.text().notNull(),
  assetAddress: t.text().notNull(),
  activeShares: t.bigint().notNull(),
  pendingShares: t.bigint().notNull(),
  cooldownShares: t.bigint().notNull(),
  earliestUnlockAt: t.bigint().notNull(),
  effectiveEpoch: t.bigint().default(0n),
  lastUpdatedBlock: t.bigint().notNull(),
}));

export const unstakeRequest = onchainTable("unstake_request", (t) => ({
  id: t.text().primaryKey(), // user-asset-requestId
  userAddress: t.text().notNull(),
  assetAddress: t.text().notNull(),
  requestId: t.bigint().notNull(),
  shares: t.bigint().notNull(),
  unlockAt: t.bigint().notNull(),
  claimed: t.boolean().notNull(),
  txHash: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
}));

export const withdrawal = onchainTable("withdrawal", (t) => ({
  id: t.text().primaryKey(), // txHash-logIndex
  userAddress: t.text().notNull(),
  assetAddress: t.text().notNull(),
  requestId: t.bigint().notNull(),
  shares: t.bigint().notNull(),
  amount: t.bigint().notNull(),
  txHash: t.text().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

export const assetConfigEvent = onchainTable("asset_config_event", (t) => ({
  id: t.text().primaryKey(), // txHash-logIndex
  assetAddress: t.text().notNull(),
  enabled: t.boolean().notNull(),
  vault: t.text().notNull(),
  priceFeed: t.text().notNull(),
  depositCap: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

export const harvestEvent = onchainTable("harvest_event", (t) => ({
  id: t.text().primaryKey(), // txHash-logIndex
  token: t.text().notNull(),
  yieldAmount: t.bigint().notNull(),
  treasury: t.text().notNull(),
  txHash: t.text().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

export const feeSplitEvent = onchainTable("fee_split_event", (t) => ({
  id: t.text().primaryKey(), // txHash-logIndex
  token: t.text().notNull(),
  treasuryAmount: t.bigint().notNull(),
  buybackAmount: t.bigint().notNull(),
  txHash: t.text().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

export const burnEvent = onchainTable("burn_event", (t) => ({
  id: t.text().primaryKey(), // txHash-logIndex
  token: t.text().notNull(),
  amount: t.bigint().notNull(),
  source: t.text().notNull(), // FEE | BUYBACK
  txHash: t.text().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

export const treasuryRoutedEvent = onchainTable("treasury_routed_event", (t) => ({
  id: t.text().primaryKey(), // txHash-logIndex
  usdgIn: t.bigint().notNull(),
  budgetOut: t.bigint().notNull(),
  reserveOut: t.bigint().notNull(),
  portfolioOut: t.bigint().notNull(),
  txHash: t.text().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

export const treasurySplitEvent = onchainTable("treasury_split_event", (t) => ({
  id: t.text().primaryKey(), // txHash-logIndex
  budgetBps: t.bigint().notNull(),
  reserveBps: t.bigint().notNull(),
  portfolioBps: t.bigint().notNull(),
  txHash: t.text().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));
