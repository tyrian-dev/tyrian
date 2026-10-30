import { indexerService, type HarvestEventItem, type FeeSplitEventItem, type BurnEventItem } from "./indexer";
import { tyrianNetwork } from "../config/network";
import { dbService } from "./db";
import { pricingService } from "./pricing";
import { runwayService, type InferenceRunwayReport } from "./runway";
import { portfolioVaultService } from "./portfolio-vault";
import { formatUnitsAsset } from "./quota";

export interface TreasuryPortfolioItem {
  symbol: string;
  name: string;
  amount: number;
  valueUsd: number;
  pct: number;
  /**
   * Average buy price in USD per whole token, read from `PortfolioVault`
   * (BUD-004). Undefined when the vault or the cost basis is unavailable; the UI
   * must show "unavailable" rather than deriving a price from the current value.
   */
  avgCostUsd?: number;
  /** True when the row comes from the on-chain portfolio basket. */
  onchain?: boolean;
}

export interface TreasurySummary {
  asOf: string;
  treasuryBalanceUsd: number;
  inflow30dUsd: number;
  spend30dUsd: number;
  runwayDays: number;
  inferenceRunway?: InferenceRunwayReport;
  totalHarvestYieldUsd: number;
  totalCreatorFeeUsd: number;
  totalTyrBurned: number;
  tyrBurnedUsd: number;
  /** Allocated quota for today's UTC epoch, or null when no completed epoch exists. */
  quotaDistributedTodayUsd: number | null;
  portfolio: TreasuryPortfolioItem[];
}

export interface FlowPoint {
  date: string;
  timestamp: number;
  inflowUsd: number;
  spendUsd: number;
}

export interface FormattedHarvestItem {
  id: string;
  token: string;
  tokenSymbol: string;
  yieldAmount: string;
  yieldAmountNum: number;
  treasury: string;
  txHash: string;
  blockTimestamp: string;
  date: string;
}

export interface FormattedBurnItem {
  id: string;
  token: string;
  tokenSymbol: string;
  amount: string;
  amountNum: number;
  source: string;
  txHash: string;
  blockTimestamp: string;
  date: string;
}

export interface TreasuryFlow {
  points: FlowPoint[];
  recentHarvests: FormattedHarvestItem[];
  recentBurns: FormattedBurnItem[];
}

function formatUnits18(val: string): number {
  try {
    return Number(BigInt(val)) / 1e18;
  } catch {
    return 0;
  }
}

export class TreasuryService {
  private resolveTokenSymbol(address: string): string {
    const addr = address.toLowerCase();
    if (addr === tyrianNetwork.tokens.USDG.address?.toLowerCase()) return "USDG";
    if (addr === tyrianNetwork.tokens.WETH.address?.toLowerCase()) return "WETH";
    if (addr === tyrianNetwork.tokens.TYRN.address?.toLowerCase()) return "TYRN";

    for (const [sym, cfg] of Object.entries(tyrianNetwork.stocks)) {
      if (cfg.address && cfg.address.toLowerCase() === addr) return sym;
    }

    return "UNKNOWN";
  }

  private async getTokenPrice(symbol: string): Promise<number> {
    if (symbol === "UNKNOWN") return 0;
    try {
      return await pricingService.getUsdPrice(symbol);
    } catch {
      return 0;
    }
  }

  private portfolioName(symbol: string): string {
    if (symbol === "WETH") return "Wrapped Ether (Portfolio)";
    if (symbol === "USDG") return "Global Dollar Reserve";
    if (symbol === "TYRN" || symbol === "TYR") return "Tyrian Token ($TYRN)";
    if (symbol === "UNKNOWN") return "Unrecognized Asset";
    return `${symbol} Stock Token`;
  }

  async getTreasurySummary(): Promise<TreasurySummary> {
    const [harvestEvents, feeSplits, burns] = await Promise.all([
      indexerService.getRecentHarvestEvents(),
      indexerService.getRecentFeeSplits(),
      indexerService.getRecentBurns(),
    ]);

    // Today's distributed quota is a ledger fact, not a derived estimate. It is
    // null until an epoch has completed, so the UI can show "unavailable"
    // instead of a plausible-looking number.
    const todayUtc = new Date().toISOString().split("T")[0];
    const todayEpoch = await dbService.getQuotaEpoch(todayUtc);
    const quotaDistributedTodayUsd =
      todayEpoch && todayEpoch.status === "COMPLETED"
        ? Number(todayEpoch.totalAllocatedUsd)
        : null;

    let totalHarvestYieldUsd = 0;
    let usdgHarvested = 0;
    let wethFees = 0;
    let totalCreatorFeeUsd = 0;
    let totalTyrBurned = 0;

    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 86400;
    let inflow30dUsd = 0;

    // 1. Process Harvest Events
    for (const h of harvestEvents) {
      const sym = this.resolveTokenSymbol(h.token);
      const amt = formatUnitsAsset(h.yieldAmount, sym);
      const price = await this.getTokenPrice(sym);
      const valUsd = amt * price;

      totalHarvestYieldUsd += valUsd;
      if (sym === "USDG") usdgHarvested += amt;

      const ts = Number(h.blockTimestamp);
      if (ts >= thirtyDaysAgo) {
        inflow30dUsd += valUsd;
      }
    }

    // 2. Process Fee Splits (80% Treasury / 20% Buyback)
    for (const fs of feeSplits) {
      const sym = this.resolveTokenSymbol(fs.token);
      const treasuryAmt = formatUnitsAsset(fs.treasuryAmount, sym);
      const price = await this.getTokenPrice(sym);
      const valUsd = treasuryAmt * price;

      totalCreatorFeeUsd += valUsd;
      if (sym === "WETH") wethFees += treasuryAmt;

      const ts = Number(fs.blockTimestamp);
      if (ts >= thirtyDaysAgo) {
        inflow30dUsd += valUsd;
      }
    }

    // 3. Process Burn Events
    for (const b of burns) {
      const amt = formatUnitsAsset(b.amount, "TYRN");
      totalTyrBurned += amt;
    }

    const tyrPrice = await this.getTokenPrice("TYRN");
    const tyrBurnedUsd = Number((totalTyrBurned * tyrPrice).toFixed(4));

    const wethPrice = await this.getTokenPrice("WETH");
    // Treasury Balance = USDG + WETH + other assets held
    // In testnet / genesis, if yield has been harvested, balance reflects cumulative revenue
    const treasuryBalanceUsd = Math.max(
      totalHarvestYieldUsd + totalCreatorFeeUsd,
      usdgHarvested * 1.0 + wethFees * wethPrice,
    );

    // Inference runway calculation based on OpenRouter credits and 7-day spend (GAP-008 / Brief §5 & §7)
    let runwayReport: InferenceRunwayReport | undefined;
    try {
      runwayReport = await runwayService.checkInferenceRunway();
    } catch (err) {
      console.warn("[TreasuryService] Failed to check inference runway:", err);
    }

    const runwayDays = runwayReport ? runwayReport.runwayDays : 365;
    const dailySpendUsd = runwayReport ? runwayReport.avgDailySpendUsd : 0.05;
    const spend30dUsd = Number((dailySpendUsd * 30).toFixed(2));

    // Portfolio distribution
    const portfolio: TreasuryPortfolioItem[] = [];
    if (treasuryBalanceUsd > 0) {
      if (usdgHarvested > 0) {
        const val = usdgHarvested * 1.0;
        portfolio.push({
          symbol: "USDG",
          name: "Global Dollar Reserve",
          amount: Number(usdgHarvested.toFixed(2)),
          valueUsd: Number(val.toFixed(2)),
          pct: 0,
        });
      }
      if (wethFees > 0) {
        const val = wethFees * wethPrice;
        portfolio.push({
          symbol: "WETH",
          name: "Wrapped Ether (Creator Fees)",
          amount: Number(wethFees.toFixed(4)),
          valueUsd: Number(val.toFixed(2)),
          pct: 0,
        });
      }
    }

    // On-chain basket holdings carry a real cost basis. They are appended as
    // their own rows because the fee-derived rows above never include the DCA
    // portfolio (BUD-004 / Brief §7).
    const holdings = await portfolioVaultService.getHoldings();
    if (holdings) {
      for (const holding of holdings) {
        if (!(holding.amount > 0)) continue;

        const price = await this.getTokenPrice(holding.symbol);
        const valueUsd = holding.amount * price;
        const existing = portfolio.find((item) => item.symbol === holding.symbol);
        if (existing) {
          existing.avgCostUsd = holding.avgCostUsd ?? existing.avgCostUsd;
          existing.onchain = true;
          continue;
        }

        portfolio.push({
          symbol: holding.symbol,
          name: this.portfolioName(holding.symbol),
          amount: Number(holding.amount.toFixed(6)),
          valueUsd: Number(valueUsd.toFixed(2)),
          pct: 0,
          avgCostUsd: holding.avgCostUsd ?? undefined,
          onchain: true,
        });
      }
    }

    if (portfolio.length === 0) {
      portfolio.push({
        symbol: "USDG",
        name: "Global Dollar Reserve",
        amount: 0,
        valueUsd: 0,
        pct: 100,
      });
    }

    // Percentages are relative to the rows actually displayed, not to the
    // cumulative revenue estimate above.
    const portfolioTotalUsd = portfolio.reduce((sum, item) => sum + item.valueUsd, 0);
    for (const item of portfolio) {
      item.pct =
        portfolioTotalUsd > 0
          ? Number(((item.valueUsd / portfolioTotalUsd) * 100).toFixed(1))
          : 0;
    }

    return {
      asOf: new Date().toISOString(),
      treasuryBalanceUsd: Number(treasuryBalanceUsd.toFixed(2)),
      inflow30dUsd: Number(inflow30dUsd.toFixed(2)),
      spend30dUsd,
      runwayDays,
      inferenceRunway: runwayReport,
      totalHarvestYieldUsd: Number(totalHarvestYieldUsd.toFixed(2)),
      totalCreatorFeeUsd: Number(totalCreatorFeeUsd.toFixed(2)),
      totalTyrBurned: Number(totalTyrBurned.toFixed(0)),
      tyrBurnedUsd,
      quotaDistributedTodayUsd,
      portfolio,
    };
  }

  async getTreasuryFlow(): Promise<TreasuryFlow> {
    const [harvestEvents, feeSplits, burns] = await Promise.all([
      indexerService.getRecentHarvestEvents(),
      indexerService.getRecentFeeSplits(),
      indexerService.getRecentBurns(),
    ]);

    // Build 30-day timeline
    const now = new Date();
    const pointsMap: Record<string, { inflowUsd: number; spendUsd: number; timestamp: number }> = {};

    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400 * 1000);
      const dateKey = d.toISOString().split("T")[0];
      pointsMap[dateKey] = {
        inflowUsd: 0,
        spendUsd: 0.05, // nominal daily operational inference spend
        timestamp: Math.floor(d.getTime() / 1000),
      };
    }

    // Map harvest events into daily inflow
    for (const h of harvestEvents) {
      const dateKey = new Date(Number(h.blockTimestamp) * 1000).toISOString().split("T")[0];
      const sym = this.resolveTokenSymbol(h.token);
      const price = await this.getTokenPrice(sym);
      const val = formatUnitsAsset(h.yieldAmount, sym) * price;

      if (pointsMap[dateKey]) {
        pointsMap[dateKey].inflowUsd += val;
      }
    }

    // Map fee splits into daily inflow
    for (const fs of feeSplits) {
      const dateKey = new Date(Number(fs.blockTimestamp) * 1000).toISOString().split("T")[0];
      const sym = this.resolveTokenSymbol(fs.token);
      const price = await this.getTokenPrice(sym);
      const val = formatUnitsAsset(fs.treasuryAmount, sym) * price;

      if (pointsMap[dateKey]) {
        pointsMap[dateKey].inflowUsd += val;
      }
    }

    const points: FlowPoint[] = Object.entries(pointsMap).map(([date, data]) => ({
      date,
      timestamp: data.timestamp,
      inflowUsd: Number(data.inflowUsd.toFixed(4)),
      spendUsd: Number(data.spendUsd.toFixed(4)),
    }));

    const formattedHarvests: FormattedHarvestItem[] = harvestEvents.slice(0, 50).map((h) => {
      const sym = this.resolveTokenSymbol(h.token);
      const amt = formatUnitsAsset(h.yieldAmount, sym);
      return {
        id: h.id,
        token: h.token,
        tokenSymbol: sym,
        yieldAmount: h.yieldAmount,
        yieldAmountNum: Number(amt.toFixed(4)),
        treasury: h.treasury,
        txHash: h.txHash,
        blockTimestamp: h.blockTimestamp,
        date: new Date(Number(h.blockTimestamp) * 1000).toISOString().split("T")[0],
      };
    });

    const formattedBurns: FormattedBurnItem[] = burns.slice(0, 50).map((b) => {
      const sym = this.resolveTokenSymbol(b.token);
      const amt = formatUnitsAsset(b.amount, sym);
      return {
        id: b.id,
        token: b.token,
        tokenSymbol: sym,
        amount: b.amount,
        amountNum: Number(amt.toFixed(2)),
        source: b.source,
        txHash: b.txHash,
        blockTimestamp: b.blockTimestamp,
        date: new Date(Number(b.blockTimestamp) * 1000).toISOString().split("T")[0],
      };
    });

    return {
      points,
      recentHarvests: formattedHarvests,
      recentBurns: formattedBurns,
    };
  }
}

export const treasuryService = new TreasuryService();
