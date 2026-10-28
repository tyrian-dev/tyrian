import { ponder } from "ponder:registry";
import {
  assetConfigEvent,
  burnEvent,
  feeSplitEvent,
  harvestEvent,
  stakePosition,
  treasuryRoutedEvent,
  treasurySplitEvent,
  unstakeRequest,
  withdrawal,
} from "../ponder.schema";

function positionId(user: string, asset: string): string {
  return `${user.toLowerCase()}-${asset.toLowerCase()}`;
}

function requestId(user: string, asset: string, id: bigint): string {
  return `${user.toLowerCase()}-${asset.toLowerCase()}-${id.toString()}`;
}

function burnSource(source: number): "FEE" | "BUYBACK" {
  const value = Number(source);
  if (value === 0) return "FEE";
  if (value === 1) return "BUYBACK";
  throw new Error(`Unknown BurnSource value: ${source}`);
}

ponder.on("StakeManager:Staked", async ({ event, context }) => {
  const { user, asset, shares, effectiveEpoch } = event.args;
  const id = positionId(user, asset);
  const existing = await context.db.find(stakePosition, { id });

  const targetEpoch = effectiveEpoch ?? (event.block.timestamp / 86400n + 1n);

  if (existing) {
    await context.db.update(stakePosition, { id }).set({
      pendingShares: existing.pendingShares + shares,
      effectiveEpoch: targetEpoch,
      lastUpdatedBlock: event.block.number,
    });
    return;
  }

  await context.db.insert(stakePosition).values({
    id,
    userAddress: user.toLowerCase(),
    assetAddress: asset.toLowerCase(),
    activeShares: 0n,
    pendingShares: shares,
    cooldownShares: 0n,
    earliestUnlockAt: 0n,
    effectiveEpoch: targetEpoch,
    lastUpdatedBlock: event.block.number,
  });
});

ponder.on("StakeManager:UnstakeRequested", async ({ event, context }) => {
  const { user, asset, requestId: request, shares, unlockAt } = event.args;
  const id = positionId(user, asset);
  const existing = await context.db.find(stakePosition, { id });

  if (existing) {
    let newActive = existing.activeShares;
    let newPending = existing.pendingShares;

    if (newActive >= shares) {
      newActive -= shares;
    } else {
      const remainder = shares - newActive;
      newActive = 0n;
      newPending = newPending >= remainder ? newPending - remainder : 0n;
    }

    const earliestUnlockAt =
      existing.earliestUnlockAt === 0n || unlockAt < existing.earliestUnlockAt
        ? unlockAt
        : existing.earliestUnlockAt;

    await context.db.update(stakePosition, { id }).set({
      activeShares: newActive,
      pendingShares: newPending,
      cooldownShares: existing.cooldownShares + shares,
      earliestUnlockAt,
      lastUpdatedBlock: event.block.number,
    });
  }

  await context.db.insert(unstakeRequest).values({
    id: requestId(user, asset, request),
    userAddress: user.toLowerCase(),
    assetAddress: asset.toLowerCase(),
    requestId: request,
    shares,
    unlockAt,
    claimed: false,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
  });
});

ponder.on("StakeManager:Withdrawn", async ({ event, context }) => {
  const { user, asset, requestId: request, shares, amount } = event.args;
  const requestKey = requestId(user, asset, request);
  const record = await context.db.find(unstakeRequest, { id: requestKey });

  if (record && !record.claimed) {
    await context.db.update(unstakeRequest, { id: requestKey }).set({ claimed: true });
  }

  const id = positionId(user, asset);
  const existing = await context.db.find(stakePosition, { id });
  if (existing) {
    await context.db.update(stakePosition, { id }).set({
      cooldownShares: existing.cooldownShares > shares
        ? existing.cooldownShares - shares
        : 0n,
      lastUpdatedBlock: event.block.number,
    });
  }

  await context.db.insert(withdrawal).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    userAddress: user.toLowerCase(),
    assetAddress: asset.toLowerCase(),
    requestId: request,
    shares,
    amount,
    txHash: event.transaction.hash,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on("StakeManager:AssetConfigUpdated", async ({ event, context }) => {
  const { asset, enabled, vault, priceFeed, depositCap } = event.args;

  await context.db
    .insert(assetConfigEvent)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      assetAddress: asset.toLowerCase(),
      enabled,
      vault: vault.toLowerCase(),
      priceFeed: priceFeed.toLowerCase(),
      depositCap,
      blockTimestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

ponder.on("UsdgVault:Harvested", async ({ event, context }) => {
  const { asset, yieldAmount, treasury } = event.args;

  await context.db.insert(harvestEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    token: asset.toLowerCase(),
    yieldAmount,
    treasury: treasury.toLowerCase(),
    txHash: event.transaction.hash,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on("StockVault:Harvested", async ({ event, context }) => {
  const { asset, yieldAmount, treasury } = event.args;

  await context.db.insert(harvestEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    token: asset.toLowerCase(),
    yieldAmount,
    treasury: treasury.toLowerCase(),
    txHash: event.transaction.hash,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on("FeeSplitter:FeesSplit", async ({ event, context }) => {
  const { token, treasuryAmt, buybackAmt } = event.args;

  await context.db.insert(feeSplitEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    token: token.toLowerCase(),
    treasuryAmount: treasuryAmt,
    buybackAmount: buybackAmt,
    txHash: event.transaction.hash,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on("FeeSplitter:Burned", async ({ event, context }) => {
  const { token, amount, source } = event.args;

  await context.db.insert(burnEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    token: token.toLowerCase(),
    amount,
    source: burnSource(Number(source)),
    txHash: event.transaction.hash,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on("BuybackBurner:Burned", async ({ event, context }) => {
  const { token, amount, source } = event.args;

  await context.db.insert(burnEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    token: token.toLowerCase(),
    amount,
    source: burnSource(Number(source)),
    txHash: event.transaction.hash,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on("TreasuryRouter:Routed", async ({ event, context }) => {
  const { usdgIn, budgetOut, reserveOut, portfolioOut } = event.args;

  await context.db.insert(treasuryRoutedEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    usdgIn,
    budgetOut,
    reserveOut,
    portfolioOut,
    txHash: event.transaction.hash,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on("TreasuryRouter:SplitUpdated", async ({ event, context }) => {
  const { budgetBps, reserveBps, portfolioBps } = event.args;

  await context.db.insert(treasurySplitEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    budgetBps,
    reserveBps,
    portfolioBps,
    txHash: event.transaction.hash,
    blockTimestamp: event.block.timestamp,
  });
});
