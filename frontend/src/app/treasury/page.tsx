"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { Odometer } from "@/components/ui/Odometer";
import { activeNetwork, isAddress } from "@shared/contracts/addresses";

const ASSETS = [
  { sym: "AAPL", name: "Apple Inc.", kind: "stock", price: 255 },
  { sym: "NVDA", name: "NVIDIA Corporation", kind: "stock", price: 185 },
  { sym: "MSFT", name: "Microsoft Corporation", kind: "stock", price: 520 },
  { sym: "GOOGL", name: "Alphabet Inc.", kind: "stock", price: 250 },
  { sym: "AMZN", name: "Amazon.com Inc.", kind: "stock", price: 225 },
  { sym: "META", name: "Meta Platforms Inc.", kind: "stock", price: 715 },
  { sym: "TSLA", name: "Tesla Inc.", kind: "stock", price: 440 },
  { sym: "AMD", name: "Advanced Micro Devices", kind: "stock", price: 230 },
];


function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v || 1)));
  const scaled = v / p;
  return Math.ceil(scaled / (scaled > 5 ? 2 : 1)) * p * (scaled > 5 ? 2 : 1);
}

const fmtUSD = (v: number, dec?: number) => {
  if (dec !== undefined) {
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  return "$" + Math.round(v).toLocaleString("en-US");
};

const fmtNum = (v: number) => Math.round(v).toLocaleString("en-US");

interface LiveTreasurySummary {
  asOf: string;
  treasuryBalanceUsd: number;
  inflow30dUsd: number;
  spend30dUsd: number;
  runwayDays: number;
  totalHarvestYieldUsd: number;
  totalCreatorFeeUsd: number;
  totalTyrBurned: number;
  tyrBurnedUsd: number;
  portfolio: {
    symbol: string;
    name: string;
    amount: number;
    valueUsd: number;
    pct: number;
    avgCostUsd?: number;
  }[];
}

interface LiveTreasuryFlow {
  points: { date: string; timestamp: number; inflowUsd: number; spendUsd: number }[];
  recentHarvests: {
    id: string;
    token: string;
    tokenSymbol: string;
    yieldAmount: string;
    yieldAmountNum: number;
    treasury: string;
    txHash: string;
    blockTimestamp: string;
    date: string;
  }[];
  recentBurns: {
    id: string;
    token: string;
    tokenSymbol: string;
    amount: string;
    amountNum: number;
    source: string;
    txHash: string;
    blockTimestamp: string;
    date: string;
  }[];
}

export default function TreasuryPage() {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [liveSummary, setLiveSummary] = useState<LiveTreasurySummary | null>(null);
  const [liveFlow, setLiveFlow] = useState<LiveTreasuryFlow | null>(null);
  const [isLiveLoaded, setIsLiveLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch("/api/treasury/summary").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/treasury/flow").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([summary, flow]) => {
        if (cancelled) return;
        if (summary) setLiveSummary(summary);
        if (flow) setLiveFlow(flow);
        if (summary || flow) setIsLiveLoaded(true);
      })
      .catch((err) => {
        console.warn("[TreasuryPage] Failed to fetch live treasury data:", err);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // 30-day timeline generator (real live points or default 30-day zero-state)
  const defaultFlowPoints = useMemo(() => {
    const N = 30;
    const now = Date.now();
    const l: string[] = [];
    const zeroes: number[] = [];

    for (let i = N - 1; i >= 0; i--) {
      const d = new Date(now - i * 864e5);
      l.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }));
      zeroes.push(0);
    }

    return {
      labels: l,
      values: zeroes,
    };
  }, []);

  const labels = useMemo(() => {
    if (liveFlow && liveFlow.points.length > 0) {
      return liveFlow.points.map((p) => {
        const d = new Date(p.date + "T00:00:00Z");
        return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      });
    }
    return defaultFlowPoints.labels;
  }, [liveFlow, defaultFlowPoints.labels]);

  const inflow = useMemo(() => {
    if (liveFlow && liveFlow.points.length > 0) {
      return liveFlow.points.map((p) => p.inflowUsd);
    }
    return defaultFlowPoints.values;
  }, [liveFlow, defaultFlowPoints.values]);

  const spend = useMemo(() => {
    if (liveFlow && liveFlow.points.length > 0) {
      return liveFlow.points.map((p) => p.spendUsd);
    }
    return defaultFlowPoints.values;
  }, [liveFlow, defaultFlowPoints.values]);

  const chartMax = useMemo(() => {
    const highest = Math.max(...inflow, ...spend, 10);
    return niceMax(highest * 1.08);
  }, [inflow, spend]);

  const balance = liveSummary?.treasuryBalanceUsd ?? 0;
  const runway = liveSummary?.runwayDays ?? 0;
  const burned = liveSummary?.totalTyrBurned ?? 0;
  const yInflow = inflow[inflow.length - 1] ?? 0;
  const ySpend = spend[spend.length - 1] ?? 0;

  // SVG Chart Dimensions & Math
  const W0 = 720;
  const H = 260;
  const padL = 54;
  const padR = 12;
  const padT = 12;
  const padB = 30;
  const iw = W0 - padL - padR;
  const ih = H - padT - padB;

  const getX = (i: number) => padL + (i * iw) / Math.max(1, labels.length - 1);
  const getY = (v: number) => padT + ih - (v / chartMax) * ih;

  const inflowPath = inflow.map((v, i) => (i ? "L" : "M") + getX(i) + "," + getY(v)).join(" ");
  const spendPath = spend.map((v, i) => (i ? "L" : "M") + getX(i) + "," + getY(v)).join(" ");

  const tiles = [
    {
      label: "Treasury balance",
      val: fmtUSD(balance, 2),
      foot: `Safe on ${activeNetwork.label}`,
    },
    {
      label: "Inflow yesterday",
      val: fmtUSD(yInflow, 2),
      foot: "yield + 80% creator fees",
    },
    {
      label: "Inference spend yesterday",
      val: fmtUSD(ySpend, 2),
      foot: "paid to AI providers",
    },
    {
      label: "$TYR burned",
      val: fmtNum(burned),
      foot: "sent to 0x…dEaD",
    },
    {
      label: "Runway",
      val: `${runway} days`,
      foot: "at operational spend rate",
    },
    {
      label: "OpenRouter reserve",
      val: "14+ days",
      foot: "target balance ≥ 14 days",
    },
  ];

  const yBudget = yInflow * 0.7;
  const reserveYield = liveSummary?.totalHarvestYieldUsd ?? 0;
  const utilization = 0.9;
  const budget = (yBudget + reserveYield) * utilization;
  const stockShare = 0.8;
  const stockPoolBudget = budget * stockShare;
  const tyrPoolBudget = budget * (1 - stockShare);
  const todayEpoch = "Epoch " + new Date().toISOString().slice(0, 10);

  const buckets = [
    {
      name: "Daily budget",
      pct: 70,
      desc: "Liquid USDG. Funds tomorrow's quota.",
      color: "var(--tyr-600)",
      val: fmtUSD(yInflow * 0.7, 2),
      sub: "from yesterday",
    },
    {
      name: "Reserve",
      pct: 20,
      desc: "USDG in a Morpho vault. Principal untouched unless runway < 7 days.",
      color: "var(--tyr-400)",
      val: fmtUSD(yInflow * 0.2, 2),
      sub: "",
    },
    {
      name: "Stock portfolio",
      pct: 10,
      desc: "Weekly DCA into 8 Stock Tokens.",
      color: "var(--gold-500)",
      val: fmtUSD(yInflow * 0.1, 2),
      sub: "",
    },
  ];

  const portfolioRows = useMemo(() => {
    if (liveSummary?.portfolio && liveSummary.portfolio.length > 0) {
      const tot = liveSummary.portfolio.reduce((s, x) => s + x.valueUsd, 0);
      return liveSummary.portfolio.map((item) => {
        const w = tot > 0 ? (item.valueUsd / tot) * 100 : 0;
        const d = w > 0 ? w - 12.5 : 0;
        return {
          sym: item.symbol,
          name: item.name,
          held: item.amount,
          avg: item.avgCostUsd ?? null,
          price: item.valueUsd > 0 && item.amount > 0 ? item.valueUsd / item.amount : null,
          val: item.valueUsd,
          weight: w,
          drift: d,
        };
      });
    }

    return ASSETS.map((a) => ({
      sym: a.sym,
      name: a.name,
      held: 0,
      avg: null,
      price: a.price,
      val: 0,
      weight: 0,
      drift: 0,
    }));
  }, [liveSummary?.portfolio]);

  const contractsList = [
    {
      name: "StakeManager",
      desc: "Stake positions and 7-day cooldown accounting",
      addr: activeNetwork.contracts.StakeManager,
    },
    {
      name: "UsdgVault",
      desc: "Principal-protected vault supplying USDG yield",
      addr: activeNetwork.contracts.UsdgVault,
    },
    {
      name: "FeeSplitter",
      desc: "Splits creator fees: 80% Treasury / 20% Buyback",
      addr: activeNetwork.contracts.FeeSplitter,
    },
    {
      name: "BuybackBurner",
      desc: "Buys $TYR and burns permanently",
      addr: activeNetwork.contracts.BuybackBurner,
    },
    {
      name: "TreasuryRouter",
      desc: "Routes revenue 70/20/10 each epoch",
      addr: activeNetwork.contracts.TreasuryRouter,
    },
    {
      name: "PortfolioVault",
      desc: "Protocol-owned Stock Token cash basket",
      addr: activeNetwork.contracts.PortfolioVault,
    },
    {
      name: "Treasury Safe",
      desc: "Timelock / Multi-sig treasury custody",
      addr: activeNetwork.external.treasurySafe,
    },
  ];

  return (
    <main className="page-treasury">
      <header className="page-head">
        <svg className="orn" viewBox="-100 -100 200 200" aria-hidden="true">
          <use href="#murex" />
        </svg>
        <div className="wrap">
          <div>
            <div className="eyebrow">Treasury</div>
            <h1>Every dollar, accounted for.</h1>
            <p className="lead">
              Yield and 80% of $TYR creator fees flow in. Inference spend flows out. Quota can never exceed what came in, so the treasury can&apos;t run a deficit.
            </p>
          </div>
          <div className="aside">
            <span className={`chip ${isLiveLoaded ? "" : "chip-warn"}`}>
              <i style={isLiveLoaded ? { background: "var(--success)" } : undefined} />
              {isLiveLoaded ? `Live · ${activeNetwork.label}` : "Sample data"}
            </span>
            <span className="chip">Robinhood Chain Testnet</span>
          </div>
        </div>
      </header>

      <div className="wrap">
        <div className="section" style={{ paddingBottom: 0 }}>
          <div className="banner" data-reveal>
            <svg
              className="ico"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            </svg>
            <div className="grow">
              {isLiveLoaded ? (
                <span>
                  <b>Live protocol data.</b> Figures are aggregated directly from indexer events (<code className="inline">Harvested</code>, <code className="inline">FeesSplit</code>, <code className="inline">Burned</code>) on {activeNetwork.label}.
                  {liveSummary?.asOf && <small style={{ display: "block", color: "var(--text-sub)", marginTop: "4px" }}>As of: {new Date(liveSummary.asOf).toUTCString()}</small>}
                </span>
              ) : (
                <span>
                  <b>Sample data mode.</b> Contracts are active on testnet. Connecting to backend treasury service…
                </span>
              )}
            </div>
          </div>

          <div className="tiles kpis" id="kpis" data-reveal>
            {tiles.map((t, idx) => (
              <div className="tile" key={idx}>
                <div className="label">{t.label}</div>
                <Odometer as="div" className="value" text={t.val} />
                <div className="foot">{t.foot}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Chart Section */}
        <section className="section" aria-labelledby="flowH">
          <div className="section-title">
            <h2 id="flowH">In and out, last 30 days</h2>
            <div className="legend">
              <span>
                <i style={{ background: "var(--series-2)" }} />
                Treasury inflow
              </span>
              <span>
                <i style={{ background: "var(--series-1)" }} />
                Inference spend
              </span>
            </div>
          </div>
          <div className="panel" data-reveal>
            <div className="chart" style={{ position: "relative" }}>
              <svg
                viewBox={`0 0 ${W0} ${H}`}
                role="img"
                aria-label="Daily treasury inflow and inference spend, last 30 days"
                style={{ width: "100%", height: "auto", display: "block" }}
              >
                <g className="axis">
                  {[0, 1, 2, 3, 4].map((k) => {
                    const v = (chartMax * k) / 4;
                    const yy = getY(v);
                    return (
                      <g key={k}>
                        <line
                          className={k ? "gridline" : "baseline"}
                          x1={padL}
                          x2={W0 - padR}
                          y1={yy}
                          y2={yy}
                          stroke="var(--border)"
                          strokeDasharray={k ? "3 3" : undefined}
                        />
                        <text
                          x={padL - 8}
                          y={yy + 4}
                          textAnchor="end"
                          fontSize="11"
                          fill="var(--text-muted)"
                          fontFamily="JetBrains Mono"
                        >
                          ${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 2 : 0)}
                        </text>
                      </g>
                    );
                  })}
                  {labels.map((l, i) => {
                    if (i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1) {
                      return (
                        <text
                          key={i}
                          x={getX(i)}
                          y={H - 8}
                          textAnchor="middle"
                          fontSize="11"
                          fill="var(--text-muted)"
                          fontFamily="JetBrains Mono"
                        >
                          {l}
                        </text>
                      );
                    }
                    return null;
                  })}
                </g>

                {/* Inflow line */}
                <path
                  data-chart-line
                  d={inflowPath}
                  fill="none"
                  style={{ stroke: "var(--series-2)" }}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />

                {/* Spend line */}
                <path
                  data-chart-line
                  d={spendPath}
                  fill="none"
                  style={{ stroke: "var(--series-1)" }}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />

                {/* Interactive cursor line and dots */}
                {hoverIndex !== null && (
                  <>
                    <line
                      className="xh"
                      x1={getX(hoverIndex)}
                      x2={getX(hoverIndex)}
                      y1={padT}
                      y2={padT + ih}
                      stroke="var(--border-strong)"
                      strokeWidth="1"
                    />
                    <circle
                      cx={getX(hoverIndex)}
                      cy={getY(inflow[hoverIndex])}
                      r="4.5"
                      style={{ fill: "var(--series-2)", stroke: "var(--surface)" }}
                      strokeWidth="2"
                    />
                    <circle
                      cx={getX(hoverIndex)}
                      cy={getY(spend[hoverIndex])}
                      r="4.5"
                      style={{ fill: "var(--series-1)", stroke: "var(--surface)" }}
                      strokeWidth="2"
                    />
                  </>
                )}

                {/* Transparent hit overlay */}
                <rect
                  className="hit"
                  x={padL}
                  y={padT}
                  width={iw}
                  height={ih}
                  fill="transparent"
                  onPointerMove={(e) => {
                    if (!labels || labels.length === 0) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const px = ((e.clientX - rect.left) / rect.width) * W0;
                    const idx = Math.max(
                      0,
                      Math.min(
                        labels.length - 1,
                        Math.round(((px - padL) / iw) * (labels.length - 1)),
                      ),
                    );
                    setHoverIndex(idx);
                  }}
                  onPointerLeave={() => setHoverIndex(null)}
                />
              </svg>

              {/* Tooltip */}
              {hoverIndex !== null && labels[hoverIndex] !== undefined && (
                <div
                  className="chart-tip on"
                  style={{
                    position: "absolute",
                    left: `${Math.min(80, Math.max(10, (getX(hoverIndex) / W0) * 100))}%`,
                    top: "10px",
                  }}
                >
                  <div className="t">{labels[hoverIndex]}</div>
                  <div className="r">
                    <span>
                      <i
                        style={{
                          width: "10px",
                          height: "3px",
                          borderRadius: "2px",
                          background: "var(--series-2)",
                          display: "inline-block",
                        }}
                      />
                      Inflow
                    </span>
                    <b>{fmtUSD(inflow[hoverIndex], 2)}</b>
                  </div>
                  <div className="r">
                    <span>
                      <i
                        style={{
                          width: "10px",
                          height: "3px",
                          borderRadius: "2px",
                          background: "var(--series-1)",
                          display: "inline-block",
                        }}
                      />
                      Inference spend
                    </span>
                    <b>{fmtUSD(spend[hoverIndex], 2)}</b>
                  </div>
                </div>
              )}

              <details className="chart-table" style={{ marginTop: "10px" }}>
                <summary
                  className="btn btn-ghost btn-sm"
                  style={{ display: "inline-flex", listStyle: "none", cursor: "pointer" }}
                >
                  View as table
                </summary>
                <div
                  className="table-wrap"
                  style={{ marginTop: "10px", maxHeight: "300px", overflow: "auto" }}
                >
                  <table className="data">
                    <caption className="sr-only">
                      Daily treasury inflow and inference spend, last 30 days
                    </caption>
                    <thead>
                      <tr>
                        <th>Day</th>
                        <th className="num">Inflow</th>
                        <th className="num">Inference spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {labels.map((l, i) => (
                        <tr key={i}>
                          <td>{l}</td>
                          <td className="num">{fmtUSD(inflow[i], 2)}</td>
                          <td className="num">{fmtUSD(spend[i], 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </div>
          </div>
        </section>

        {/* Where fees go */}
        <section className="section" aria-labelledby="feeH" style={{ paddingTop: 0 }}>
          <div className="section-title">
            <h2 id="feeH">Where fees go</h2>
            <p>Every $TYR trade on pons pays a 1% pool fee. Tyrian&apos;s creator share is split by the FeeSplitter, which anyone can call.</p>
          </div>
          <div className="flowrow">
            <div data-reveal>
              <div className="pct">1%</div>
              <p>Pool fee on every $TYR trade</p>
            </div>
            <div data-reveal>
              <div className="pct">70%</div>
              <p>Creator share to the FeeSplitter (0.7% of volume)</p>
            </div>
            <div data-reveal>
              <div className="pct">80%</div>
              <p>To the Treasury for inference</p>
            </div>
            <div data-reveal>
              <div className="pct">20%</div>
              <p>Buyback &amp; burn in small TWAP buys</p>
            </div>
          </div>
        </section>

        {/* Treasury split and today's budget */}
        <section
          className="section grid-2"
          style={{ paddingTop: 0 }}
          aria-label="Treasury split and today's budget"
        >
          <div className="panel" data-reveal>
            <div className="panel-head">
              <h2>Treasury split</h2>
              <span className="chip">TreasuryRouter · every epoch</span>
            </div>
            <div id="buckets">
              {buckets.map((b, idx) => (
                <div className="bucket" key={idx}>
                  <div>
                    <b>{b.pct}%</b> {b.name}
                    <small>{b.desc}</small>
                  </div>
                  <div className="bar" role="img" aria-label={`${b.pct}% of inflow`}>
                    <i style={{ width: `${b.pct}%`, background: b.color }} />
                  </div>
                  <b>
                    {b.val}
                    {b.sub && <small style={{ textAlign: "right" }}>{b.sub}</small>}
                  </b>
                </div>
              ))}
            </div>
          </div>

          <div className="panel" data-reveal>
            <div className="panel-head">
              <h2>Today&apos;s quota budget</h2>
              <span className="chip" id="budgetChip" suppressHydrationWarning>{todayEpoch}</span>
            </div>
            <div className="calc" id="calc">
              70% of yesterday&apos;s inflow <b>{fmtUSD(yBudget, 2)}</b>
              <br />
              + reserve yield <b>{fmtUSD(reserveYield, 2)}</b>
              <br />
              × utilization <b>0.9</b> (10% held back)
              <br />
              = budget <b className="res">{fmtUSD(budget, 2)}</b>
              <br />
              <br />
              Stock pool (80%) <b className="res">{fmtUSD(stockPoolBudget, 2)}</b>
              <br />
              $TYR pool (20%) <b className="res">{fmtUSD(tyrPoolBudget, 2)}</b>
              <br />
              <span style={{ fontSize: "12px", display: "block", marginTop: "8px", opacity: 0.8 }}>
                USDG pool is funded by its own yield, not this budget. If the budget drops below 70% of its 7-day average, the reserve tops it up by at most 2% of principal per day.
              </span>
            </div>
          </div>
        </section>

        {/* Stock Token portfolio */}
        <section className="section" aria-labelledby="pfH" style={{ paddingTop: 0 }}>
          <div className="section-title">
            <h2 id="pfH">Stock Token portfolio</h2>
            <p>Equal-weight basket of 8 tickers, held by the Safe as protocol cash management. Not counted as stake and capped at 20% of the treasury.</p>
          </div>
          <div className="table-wrap" data-reveal>
            <table className="data" id="pfTable">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th className="num">Holdings</th>
                  <th className="num">Avg buy</th>
                  <th className="num">Price</th>
                  <th className="num">Value</th>
                  <th className="num">Weight</th>
                  <th>Drift</th>
                </tr>
              </thead>
              <tbody id="pfBody">
                {portfolioRows.map((x) => (
                  <tr key={x.sym}>
                    <td>
                      <b style={{ fontWeight: 500 }}>{x.sym}</b>{" "}
                      <span className="muted">{x.name}</span>
                    </td>
                    <td className="num" data-l="Holdings">
                      {x.held > 0 ? x.held.toFixed(3) : "0.000"}
                    </td>
                    <td className="num" data-l="Avg buy">
                      {x.avg !== null ? fmtUSD(x.avg, 2) : "—"}
                    </td>
                    <td className="num" data-l="Price">
                      {x.price !== null ? fmtUSD(x.price, 2) : "—"}
                    </td>
                    <td className="num" data-l="Value">
                      {fmtUSD(x.val, 2)}
                    </td>
                    <td className="num" data-l="Weight">
                      {x.weight > 0 ? `${x.weight.toFixed(1)}%` : "0.0%"}
                    </td>
                    <td data-l="Drift">
                      {x.val > 0 ? (
                        Math.abs(x.drift) > 5 ? (
                          <span className="chip chip-warn">
                            <i />
                            {x.drift > 0 ? "+" : ""}
                            {x.drift.toFixed(1)} pts
                          </span>
                        ) : (
                          <span className="chip chip-muted">
                            {x.drift > 0 ? "+" : ""}
                            {x.drift.toFixed(1)} pts
                          </span>
                        )
                      ) : (
                        <span className="chip chip-muted">Pending allocation</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: "12px", fontSize: "13px", color: "var(--text-muted)" }}>
            PortfolioVault holds 0 Stock Tokens on testnet. Equal-weight DCA execution (12.5% per ticker, capped at 20% of Treasury) will activate upon mainnet feed and regulatory clearance.
          </p>
        </section>

        {/* Activity & Contracts Grid */}
        <section
          className="section grid-2"
          style={{ paddingTop: 0 }}
          aria-label="Activity and contracts"
        >
          {/* Recent Activity Live Feed */}
          <div className="panel" data-reveal>
            <div className="panel-head">
              <h2>Recent activity</h2>
              <span className={`chip ${isLiveLoaded ? "" : "chip-warn"}`}>
                {isLiveLoaded ? "On-chain" : "Sample"}
              </span>
            </div>
            <ul className="feed" id="feed">
              {liveFlow && liveFlow.recentHarvests.length > 0 ? (
                <>
                  {liveFlow.recentHarvests.map((h) => (
                    <li key={h.id}>
                      <span className="chip ev" style={{ borderColor: "rgba(46,158,107,.4)", color: "var(--success)" }}>
                        Harvested
                      </span>
                      <span>
                        {h.tokenSymbol} vault yield to Treasury
                        <small>
                          <a
                            href={`${activeNetwork.explorer}/tx/${h.txHash}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: "var(--gold-400)", textDecoration: "underline" }}
                          >
                            {h.txHash.slice(0, 8)}…{h.txHash.slice(-6)} ↗
                          </a>
                        </small>
                      </span>
                      <span className="amt">{fmtUSD(h.yieldAmountNum, 2)}</span>
                    </li>
                  ))}
                  {liveFlow.recentBurns.map((b) => (
                    <li key={b.id}>
                      <span className="chip ev" style={{ borderColor: "rgba(255,100,100,.4)", color: "var(--danger)" }}>
                        Burned
                      </span>
                      <span>
                        {b.source} burned to dead address
                        <small>
                          <a
                            href={`${activeNetwork.explorer}/tx/${b.txHash}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: "var(--gold-400)", textDecoration: "underline" }}
                          >
                            {b.txHash.slice(0, 8)}…{b.txHash.slice(-6)} ↗
                          </a>
                        </small>
                      </span>
                      <span className="amt">{fmtNum(b.amountNum)} TYR</span>
                    </li>
                  ))}
                </>
              ) : (
                <>
                  <li>
                    <span className="chip ev">Harvested</span>
                    <span>
                      USDG vault yield to Treasury
                      <small>Recorded in smoke test</small>
                    </span>
                    <span className="amt">{fmtUSD(5.0, 2)}</span>
                  </li>
                  <li>
                    <span className="chip ev">FeesSplit</span>
                    <span>
                      80% Treasury · 20% buyback
                      <small>Creator fee routing</small>
                    </span>
                    <span className="amt">{fmtUSD(0.0, 2)}</span>
                  </li>
                </>
              )}
            </ul>
          </div>

          {/* Contracts Registry with Live Testnet Addresses */}
          <div data-reveal>
            <h2 style={{ marginBottom: "16px" }}>Protocol Contracts</h2>
            <div className="contracts" id="contracts">
              {contractsList.map((c, i) => (
                <div key={i}>
                  <b>{c.name}</b>
                  <p>{c.desc}</p>
                  {c.addr && isAddress(c.addr) ? (
                    <a
                      href={`${activeNetwork.explorer}/address/${c.addr}`}
                      target="_blank"
                      rel="noreferrer"
                      className="chip chip-gold mono"
                      style={{ alignSelf: "flex-start", fontSize: "11px" }}
                    >
                      {c.addr.slice(0, 6)}…{c.addr.slice(-4)} ↗
                    </a>
                  ) : (
                    <span className="chip chip-muted" style={{ alignSelf: "flex-start" }}>
                      Not configured
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
