import type {
  AssetDef,
  BoostState,
  PreviewQuota,
  ProviderMix,
  StakePool,
  UsagePoint,
  UserPosition,
} from "./types";

export const PREVIEW_PRICES: Record<string, number> = {
  USDG: 1,
  TYRN: 0.0004,
  TYR: 0.0004,
  AAPL: 255,
  NVDA: 185,
  MSFT: 520,
  GOOGL: 250,
  AMZN: 225,
  META: 715,
  TSLA: 440,
  AMD: 230,
};

export const PREVIEW_STAKE_POOLS: StakePool[] = [
  {
    id: "usdg",
    asset: "USDG",
    budgetUsd: 270,
    totalWeight: 99000,
    source: "preview",
  },
  {
    id: "stock",
    asset: "STOCK",
    budgetUsd: 141.12,
    totalWeight: 2000000,
    source: "preview",
  },
  {
    id: "tyrn",
    asset: "TYRN",
    budgetUsd: 211.68,
    totalWeight: 50000000,
    source: "preview",
  },
];

export const QUOTA_SAMPLE_POSITIONS = [
  { asset: "USDG", amount: 1000 },
  { asset: "NVDA", amount: 10 },
  { asset: "TYRN", amount: 1000000 },
];

function previewTotals() {
  let usdgV = 0;
  let stockV = 0;
  let tyr = 0;

  for (const position of QUOTA_SAMPLE_POSITIONS) {
    const price = PREVIEW_PRICES[position.asset] ?? 0;
    if (position.asset === "USDG") usdgV += position.amount * price;
    else if (position.asset === "TYRN" || position.asset === "TYR") tyr += position.amount;
    else stockV += position.amount * price;
  }

  return { usdgV, stockV, tyr };
}

export function computePreviewBoostState(): BoostState {
  const { usdgV, stockV, tyr } = previewTotals();
  const baseValueUsd = usdgV + stockV;
  const tyrValueUsd = tyr * PREVIEW_PRICES.TYR;
  const boost =
    baseValueUsd > 0
      ? 1 + 0.5 * Math.min(1, tyrValueUsd / baseValueUsd)
      : 1;

  return {
    boost,
    tyrValueUsd,
    baseValueUsd,
    source: "preview",
  };
}

export const PREVIEW_BOOST_STATE = computePreviewBoostState();

export function computePreviewQuota(): PreviewQuota {
  const { usdgV, stockV, tyr } = previewTotals();
  const boost = PREVIEW_BOOST_STATE.boost;
  const [usdgPool, stockPool, tyrPool] = PREVIEW_STAKE_POOLS;
  const wU = usdgV * boost;
  const wS = stockV * boost;

  const pools = [
    {
      name: "USDG pool",
      weight: wU,
      share: wU ? wU / (usdgPool.totalWeight + wU) : 0,
      B: usdgPool.budgetUsd,
      unit: false,
    },
    {
      name: "Stock pool",
      weight: wS,
      share: wS ? wS / (stockPool.totalWeight + wS) : 0,
      B: stockPool.budgetUsd,
      unit: false,
    },
    {
      name: "$TYRN pool",
      weight: tyr,
      share: tyr ? tyr / (tyrPool.totalWeight + tyr) : 0,
      B: tyrPool.budgetUsd,
      unit: true,
    },
  ].map((pool) => ({ ...pool, q: pool.B * pool.share }));

  return {
    boost,
    pools,
    total: pools.reduce((sum, pool) => sum + pool.q, 0),
  };
}

export const PREVIEW_QUOTA = computePreviewQuota();
export const PREVIEW_RESET_SECONDS = 34280;

export const ALL_ASSETS: AssetDef[] = [
  { symbol: "USDG", name: "Global Dollar", type: "base", price: 1.0, pool: "USDG pool" },
  { symbol: "TYRN", name: "Tyrian", type: "boost", price: 0.0004, pool: "$TYRN pool" },
  { symbol: "AAPL", name: "Apple", type: "stock", price: 255, pool: "Stock pool", addr: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0" },
  { symbol: "NVDA", name: "NVIDIA", type: "stock", price: 185, pool: "Stock pool", addr: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15" },
  { symbol: "MSFT", name: "Microsoft", type: "stock", price: 520, pool: "Stock pool", addr: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", feed: "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E" },
  { symbol: "GOOGL", name: "Alphabet", type: "stock", price: 250, pool: "Stock pool", addr: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", feed: "0xF6f373a037c30F0e5010d854385cA89185AE638b" },
  { symbol: "AMZN", name: "Amazon", type: "stock", price: 225, pool: "Stock pool", addr: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", feed: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C" },
  { symbol: "META", name: "Meta", type: "stock", price: 715, pool: "Stock pool", addr: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", feed: "0x7C38C00C30BEe9378381E7B6135d7283356D71b1" },
  { symbol: "TSLA", name: "Tesla", type: "stock", price: 440, pool: "Stock pool", addr: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", feed: "0x4A1166a659A55625345e9515b32adECea5547C38" },
  { symbol: "AMD", name: "AMD", type: "stock", price: 230, pool: "Stock pool", addr: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", feed: "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72" },
];

export const STAKE_PREVIEW_POSITIONS: UserPosition[] = [
  { id: "p1", asset: "USDG", amount: 1000, valueUsd: 1000, status: "active" },
  { id: "p2", asset: "NVDA", amount: 10, valueUsd: 1850, status: "active" },
  { id: "p3", asset: "TYRN", amount: 15000, valueUsd: 6, status: "active" },
];

const PREVIEW_USAGE_COSTS = [
  0.3, 0.45, 0.2, 0.8, 0.65, 0.9, 0.4, 0.55, 0.7, 0.3, 0.6, 0.85, 0.4, 0.5,
  0.75, 0.95, 0.6, 0.4, 0.35, 0.7, 0.8, 0.5, 0.65, 0.75, 0.4, 0.6, 0.85, 0.9,
  0.7, 0.84,
];

export const PREVIEW_USAGE_POINTS: UsagePoint[] = PREVIEW_USAGE_COSTS.map(
  (costUsd, index, all) => ({
    date:
      index === all.length - 1
        ? "Today"
        : `${all.length - 1 - index}d`,
    costUsd,
    source: "preview",
  }),
);

// Baseline Dashboard label from the existing sample data; keep it stable so
// centralizing the chart does not change the rendered 30-day total.
export const PREVIEW_USAGE_TOTAL = 18.42;

export const PREVIEW_PROVIDER_MIX: ProviderMix[] = [
  { name: "Anthropic", pct: 42, color: "var(--series-1)" },
  { name: "OpenAI", pct: 28, color: "var(--tyr-400)" },
  { name: "Google", pct: 16, color: "var(--gold-500)" },
  { name: "DeepSeek", pct: 9, color: "var(--success)" },
  { name: "Qwen", pct: 5, color: "var(--tyr-300)" },
];

export const PREVIEW_BALANCES: Record<string, number> = {
  USDG: 5000,
  TYRN: 2000000,
  TYR: 2000000,
  default: 12,
};

export function previewBalance(symbol: string): number {
  return PREVIEW_BALANCES[symbol] ?? PREVIEW_BALANCES.default;
}
