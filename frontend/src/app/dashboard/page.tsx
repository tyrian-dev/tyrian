"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useTyrianSession } from "@/providers/TyrianSessionProvider";
import { useWalletOnboarding } from "@/hooks/useWalletOnboarding";
import { activeNetwork } from "@shared/contracts/addresses";

interface KeyItem {
  id: string;
  name: string;
  keyMasked: string;
  created: string;
  lastUsed: string;
}

interface LivePositionItem {
  asset: string;
  assetAddress: string;
  activeShares: string;
  pendingShares: string;
  cooldownShares: string;
  estimatedUsdValue: number;
}

function formatKeyDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function readApiError(response: Response) {
  try {
    const body = await response.json();
    const message = body?.error || body?.message || body?.details;
    if (typeof message === "string" && message.trim()) return message;
  } catch {}
  return `Request failed (HTTP ${response.status}).`;
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
  );
  return Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
}

function UsageChart({ points }: { points?: { date: string; costUsd: number }[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const W = 720;
  const H = 240;
  const padL = 54;
  const padR = 12;
  const padT = 12;
  const padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const usage = points && points.length > 0 ? points : [];
  const axisMax = Math.max(
    1,
    Math.ceil(Math.max(1, ...(usage.map((point) => point.costUsd) || [0])) * 1.08 * 10) / 10,
  );
  const x = (i: number) => padL + ((i + 0.5) * innerW) / Math.max(1, usage.length);
  const y = (v: number) => padT + innerH - (v / axisMax) * innerH;
  const barW = Math.max(3, innerW / Math.max(1, usage.length) - 3);
  const labelIndexes = new Set([0, 5, 10, 15, 20, 25, Math.max(0, usage.length - 1)]);

  return (
    <div id="usageChart" className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Daily inference cost, last 30 days"
        data-chart-bars
      >
        <g className="axis">
          {[0, 1, 2, 3, 4].map((k) => {
            const value = (axisMax * k) / 4;
            const yy = y(value);
            return (
              <g key={k}>
                <line
                  className={k ? "gridline" : "baseline"}
                  x1={padL}
                  x2={W - padR}
                  y1={yy}
                  y2={yy}
                />
                <text x={padL - 8} y={yy + 4} textAnchor="end">
                  {value === 0 ? "$0" : `$${value.toFixed(2)}`}
                </text>
              </g>
            );
          })}
          {usage.map((point, i) =>
            labelIndexes.has(i) ? (
              <text key={i} x={x(i)} y={H - 8} textAnchor="middle">
                {point.date}
              </text>
            ) : null
          )}
        </g>
        {usage.length === 0 ? (
          <text x={W / 2} y={H / 2} textAnchor="middle" fill="var(--text-sub)" fontSize="13">
            No inference usage recorded in the last 30 days
          </text>
        ) : null}
        {usage.map((point, i) => {
          const height = Math.max(1, y(0) - y(point.costUsd));
          const x0 = x(i) - barW / 2;
          const r = Math.min(4, barW / 2, height);
          const d = `M${x0},${y(0)} V${y(point.costUsd) + r} Q${x0},${y(point.costUsd)} ${x0 + r},${y(point.costUsd)} H${
            x0 + barW - r
          } Q${x0 + barW},${y(point.costUsd)} ${x0 + barW},${y(point.costUsd) + r} V${y(0)} Z`;
          return (
            <path
              key={i}
              className="bar"
              data-i={i}
              d={d}
              style={{
                fill: "var(--series-2)",
                opacity: hoverIndex === null || hoverIndex === i ? 1 : 0.45,
              }}
            />
          );
        })}
        <rect
          className="hit"
          x={padL}
          y={padT}
          width={innerW}
          height={innerH}
          fill="transparent"
          onPointerMove={(event) => {
            if (!usage || usage.length === 0) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const px = ((event.clientX - rect.left) / rect.width) * W;
            const index = Math.max(
              0,
              Math.min(
                usage.length - 1,
                Math.floor((px - padL) / (innerW / usage.length))
              )
            );
            setHoverIndex(index);
          }}
          onPointerLeave={() => setHoverIndex(null)}
        />
      </svg>

      {hoverIndex !== null && usage[hoverIndex] && (
        <div
          className="chart-tip on"
          style={{
            position: "absolute",
            left: `${Math.min(84, Math.max(8, (x(hoverIndex) / W) * 100))}%`,
            top: "8px",
          }}
        >
          <div className="t">{usage[hoverIndex].date}</div>
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
              Inference cost
            </span>
            <b>${usage[hoverIndex].costUsd.toFixed(2)}</b>
          </div>
        </div>
      )}

      <details className="chart-table" style={{ marginTop: "10px" }}>
        <summary className="btn btn-ghost btn-sm" style={{ display: "inline-flex", listStyle: "none" }}>
          View as table
        </summary>
        <div className="table-wrap" style={{ marginTop: "10px", maxHeight: "300px", overflow: "auto" }}>
          <table className="data">
            <caption className="sr-only">Daily inference cost, last 30 days</caption>
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((point, i) => (
                <tr key={i}>
                  <td>{point.date}</td>
                  <td className="num">${point.costUsd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const { openWalletOnboarding } = useWalletOnboarding();
  const {
    authenticated,
    loading: sessionLoading,
    signingIn,
    error: sessionError,
    refresh: refreshSession,
  } = useTyrianSession();
  const canManageKeys = isConnected && authenticated;

  // Track client mount to prevent SSR/client hydration mismatches on dynamic clocks and wallet states
  const [mounted, setMounted] = useState<boolean>(false);

  // Live user quota starts at 0 until live session endpoint responds
  const [allocatedUsd, setAllocatedUsd] = useState<number>(0);
  const [usedUsd, setUsedUsd] = useState<number>(0);
  const [resetSeconds, setResetSeconds] = useState<number>(0);

  // Live 30-day usage and provider mix from /v1/usage
  const [liveUsage, setLiveUsage] = useState<{
    totalCostUsd: number;
    requestCount: number;
    dailyPoints: { date: string; costUsd: number }[];
    providerMix: { name: string; pct: number }[];
    loaded: boolean;
  }>({
    totalCostUsd: 0,
    requestCount: 0,
    dailyPoints: [],
    providerMix: [],
    loaded: false,
  });

  // Live on-chain positions from backend/indexer
  const [livePositions, setLivePositions] = useState<LivePositionItem[]>([]);
  const [isStaker, setIsStaker] = useState<boolean>(false);
  const [totalStakeUsd, setTotalStakeUsd] = useState<number>(0);
  const [quotaLoaded, setQuotaLoaded] = useState<boolean>(false);

  // Keys are tied to a signed-in wallet, so start empty instead of showing
  // sample keys that the user cannot manage.
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [keyError, setKeyError] = useState("");
  const [generatedRawKey, setGeneratedRawKey] = useState<string | null>(null);
  const [keyAction, setKeyAction] = useState<"create" | "rotate" | "revoke">("create");
  const [modalTarget, setModalTarget] = useState<KeyItem | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const keyRequestRef = useRef(0);

  const actionBusy = createPending || actionPending;

  // Session-aware quota: signed-in users use the cookie; unauthenticated
  // preview users may ask for the address-scoped preview endpoint.
  useEffect(() => {
    if (!address) {
      setLivePositions([]);
      setIsStaker(false);
      setTotalStakeUsd(0);
      setQuotaLoaded(false);
      setAllocatedUsd(0);
      setUsedUsd(0);
      setResetSeconds(secondsUntilUtcMidnight());
      return;
    }
    if (sessionLoading) return;
    let cancelled = false;
    const quotaUrl = authenticated
      ? "/v1/quota"
      : `/v1/quota?address=${encodeURIComponent(address)}`;

    fetch(quotaUrl, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancelled || d.allocatedUsd === undefined) return;
        const allocated = Number(d.allocatedUsd);
        const used = Number(d.usedUsd);
        const reset = Number(d.resetInSeconds);
        if (Number.isFinite(allocated)) setAllocatedUsd(allocated);
        if (Number.isFinite(used)) setUsedUsd(used);
        if (Number.isFinite(reset)) setResetSeconds(reset);
        if (Array.isArray(d.positions)) setLivePositions(d.positions);
        if (typeof d.isStaker === "boolean") setIsStaker(d.isStaker);
        if (typeof d.totalEffectiveStakeUsd === "number") setTotalStakeUsd(d.totalEffectiveStakeUsd);
        setQuotaLoaded(true);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [address, authenticated, sessionLoading]);

  // Fetch live usage summary from /v1/usage
  useEffect(() => {
    if (!authenticated || sessionLoading) {
      setLiveUsage({
        totalCostUsd: 0,
        requestCount: 0,
        dailyPoints: [],
        providerMix: [],
        loaded: false,
      });
      return;
    }

    let cancelled = false;
    fetch("/v1/usage", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setLiveUsage({
          totalCostUsd: Number(d.totalCostUsd) || 0,
          requestCount: Number(d.requestCount) || 0,
          dailyPoints: Array.isArray(d.dailyPoints) ? d.dailyPoints : [],
          providerMix: Array.isArray(d.providerMix) ? d.providerMix : [],
          loaded: true,
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [authenticated, sessionLoading]);

  const loadKeys = useCallback(async () => {
    const requestId = ++keyRequestRef.current;

    if (!authenticated) {
      if (requestId === keyRequestRef.current) {
        setKeys([]);
        setKeysError("");
        setKeysLoading(false);
      }
      return;
    }

    setKeysLoading(true);
    setKeysError("");
    try {
      const response = await fetch("/api/keys", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        if (response.status === 401) {
          if (requestId === keyRequestRef.current) {
            setKeys([]);
            setKeysError("");
          }
          await refreshSession();
          return;
        }
        throw new Error(await readApiError(response));
      }

      const data = await response.json();
      if (requestId !== keyRequestRef.current) return;
      const activeKeys = Array.isArray(data.keys) ? data.keys : [];
      setKeys(
        activeKeys
          .filter((key: { isRevoked?: boolean }) => !key.isRevoked)
          .map((key: {
            id: string;
            name: string;
            keyPrefix: string;
            createdAt: string;
          }) => ({
            id: String(key.id),
            name: String(key.name),
            keyMasked: String(key.keyPrefix),
            created: formatKeyDate(String(key.createdAt)),
            lastUsed: "Not tracked",
          })),
      );
    } catch (err) {
      if (requestId === keyRequestRef.current) {
        setKeysError(
          err instanceof Error && err.message
            ? err.message
            : "Could not load API keys.",
        );
      }
    } finally {
      if (requestId === keyRequestRef.current) setKeysLoading(false);
    }
  }, [authenticated, refreshSession]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  useEffect(() => {
    if (isConnected) return;
    setKeys([]);
    setKeysError("");
    setModalOpen(false);
    setGeneratedRawKey(null);
    setModalTarget(null);
  }, [isConnected]);

  // Countdown timer, always relative to the next 00:00 UTC reset.
  useEffect(() => {
    setMounted(true);
    const update = () => setResetSeconds(secondsUntilUtcMidnight());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatCountdown = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const addKeyRecord = (key: {
    id: string;
    name: string;
    keyPrefix: string;
    apiKey: string;
    createdAt: string;
  }) => {
    setKeyAction("create");
    setModalTarget(null);
    setGeneratedRawKey(key.apiKey);
    setKeys((prev) => [
      {
        id: key.id,
        name: key.name,
        keyMasked: key.keyPrefix,
        created: formatKeyDate(key.createdAt),
        lastUsed: "Not tracked",
      },
      ...prev.filter((item) => item.id !== key.id),
    ]);
    setNewKeyName("");
    setKeyError("");
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createPending) return;
    if (!canManageKeys) {
      setKeyError(
        authenticated
          ? "Connect a wallet before creating a key."
          : "Sign in with your wallet before creating a key.",
      );
      return;
    }
    const name = newKeyName.trim();
    if (!name) return;
    if (keys.some((key) => key.name.toLowerCase() === name.toLowerCase())) {
      setKeyError("You already have a key with this name.");
      return;
    }

    setCreatePending(true);
    setKeyError("");
    try {
      const response = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        setKeyError(await readApiError(response));
        return;
      }

      const data = await response.json();
      if (typeof data.apiKey !== "string" || !data.apiKey) {
        setKeyError("The server did not return a key.");
        return;
      }
      addKeyRecord(data);
      void loadKeys();
    } catch {
      setKeyError("Could not reach the gateway. Please try again.");
    } finally {
      setCreatePending(false);
    }
  };

  const handleRevokeKey = (key: KeyItem) => {
    if (!authenticated) {
      setKeysError("Sign in with your wallet before revoking a key.");
      return;
    }

    setModalTarget(key);
    setKeyAction("revoke");
    setGeneratedRawKey(null);
    setKeyError("");
    setKeysError("");
    setModalOpen(true);
  };

  const confirmRevokeKey = async () => {
    if (!modalTarget || actionPending) return;

    setActionPending(true);
    setKeyError("");
    try {
      const response = await fetch(`/api/keys/${modalTarget.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) {
        setKeyError(await readApiError(response));
        return;
      }
      setKeys((prev) => prev.filter((key) => key.id !== modalTarget.id));
      setModalOpen(false);
      setModalTarget(null);
      void loadKeys();
    } catch {
      setKeyError("Could not reach the gateway. Please try again.");
    } finally {
      setActionPending(false);
    }
  };

  const handleRotateKey = (key: KeyItem) => {
    if (!authenticated) {
      setKeysError("Sign in with your wallet before rotating a key.");
      return;
    }

    setModalTarget(key);
    setKeyAction("rotate");
    setGeneratedRawKey(null);
    setKeyError("");
    setKeysError("");
    setModalOpen(true);
  };

  const confirmRotateKey = async () => {
    if (!modalTarget || actionPending) return;

    setActionPending(true);
    setKeyError("");
    try {
      const response = await fetch(`/api/keys/${modalTarget.id}/rotate`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) {
        setKeyError(await readApiError(response));
        return;
      }

      const data = await response.json();
      if (typeof data.apiKey !== "string" || !data.apiKey) {
        setKeyError("The server did not return a rotated key.");
        return;
      }

      setGeneratedRawKey(data.apiKey);
      setKeys((prev) =>
        prev.map((item) =>
          item.id === modalTarget.id
            ? {
                ...item,
                keyMasked: String(data.keyPrefix),
                created: formatKeyDate(String(data.createdAt)),
                lastUsed: "Not tracked",
              }
            : item,
        ),
      );
      void loadKeys();
    } catch {
      setKeyError("Could not reach the gateway. Please try again.");
    } finally {
      setActionPending(false);
    }
  };

  const leftUsd = Math.max(0, allocatedUsd - usedUsd);
  const ringPct = allocatedUsd > 0 ? (leftUsd / allocatedUsd) : 0;
  const strokeDashoffset = 540.35 - ringPct * 540.35;

  return (
    <main className="page-dashboard">
      <header className="page-head">
        <svg className="orn" viewBox="-100 -100 200 200" aria-hidden="true">
          <use href="#murex" />
        </svg>
        <div className="wrap">
          <div>
            <div className="eyebrow">Dashboard</div>
            <h1>Your quota today.</h1>
            <p className="lead">
              Quota is your pro-rata share of each pool&#39;s daily budget. It resets every day at 00:00 UTC.
            </p>
          </div>
          <div className="aside">
            <span
              className={`chip ${mounted && canManageKeys ? "chip-ok" : mounted && isConnected ? "chip-warn" : ""}`}
              suppressHydrationWarning
            >
              <i />
              {mounted && canManageKeys
                ? `${activeNetwork.label} live`
                : mounted && isConnected
                  ? "Sign-in required"
                  : activeNetwork.label}
            </span>
            <span className="chip">
              Reset in{" "}
              <b className="mono" id="resetIn" suppressHydrationWarning style={{ fontWeight: 500 }}>
                {mounted ? formatCountdown(resetSeconds) : "--:--:--"}
              </b>
            </span>
          </div>
        </div>
      </header>

      <div className="wrap">
        {/* Banner Gate */}
        <div className="section" style={{ paddingBottom: "24px" }}>
          <div className="banner" id="gate" data-reveal>
            <svg className="ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            </svg>
            <div className="grow gate">
              <span id="gateText" suppressHydrationWarning>
                {!mounted || !isConnected ? (
                  <>
                    <b>Connect wallet.</b> Connect your wallet to view daily inference quota, stake positions, and manage API keys on {activeNetwork.label}.
                  </>
                ) : !authenticated ? (
                  <>
                    <b>Wallet connected.</b> Finish sign-in to authenticate your session and manage API keys on {activeNetwork.label}.
                  </>
                ) : isStaker ? (
                  <>
                    <b>Live quota active.</b> Daily inference quota is synced with your on-chain stake on {activeNetwork.label}.
                  </>
                ) : (
                  <>
                    <b>No active stake found.</b> Stake USDG or Stock Tokens in the vaults to activate your daily inference quota.
                  </>
                )}
              </span>
              <span id="gateCta" suppressHydrationWarning>
                {!mounted || !isConnected ? (
                  <button className="btn btn-primary btn-sm" type="button" onClick={openWalletOnboarding}>
                    Connect wallet
                  </button>
                ) : !authenticated ? (
                  <button className="btn btn-primary btn-sm" type="button" onClick={openWalletOnboarding}>
                    Continue sign-in
                  </button>
                ) : isStaker ? (
                  <Link href="/stake" className="btn btn-secondary btn-sm">
                    Manage stake
                  </Link>
                ) : (
                  <Link href="/stake" className="btn btn-primary btn-sm">
                    Stake now
                  </Link>
                )}
              </span>
            </div>
          </div>
        </div>

        {/* 2-Column Dash: Meter + Stake Weight */}
        <div className="dash">
          <section className="panel meter-panel" aria-labelledby="meterH" data-reveal>
            <h2 id="meterH" className="sr-only">
              Quota left today
            </h2>
            <div className="meter" role="img" id="meterRole">
              <svg viewBox="0 0 200 200" aria-hidden="true">
                <circle cx="100" cy="100" r="86" fill="none" stroke="var(--surface-2)" strokeWidth="10" />
                <circle
                  id="ring"
                  data-ring-animate
                  data-ring-target={strokeDashoffset}
                  cx="100"
                  cy="100"
                  r="86"
                  fill="none"
                  stroke="var(--gold-500)"
                  strokeWidth="10"
                  strokeLinecap="round"
                  strokeDasharray="540.35"
                  strokeDashoffset={strokeDashoffset}
                  style={{ transition: "stroke-dashoffset 0.4s ease" }}
                />
              </svg>
              <div className="center">
                <span className="sub">LEFT TODAY</span>
                <span className="big mono" id="left">
                  ${leftUsd.toFixed(2)}
                </span>
                <span className="sub" id="ofTotal">
                  of ${allocatedUsd.toFixed(2)}
                </span>
              </div>
            </div>
            <div className="meter-stats">
              <div>
                <small>Used today</small>
                <b id="used" className="mono">${usedUsd.toFixed(2)}</b>
              </div>
              <div>
                <small>Resets</small>
                <b className="mono">00:00 UTC</b>
              </div>
            </div>
          </section>

          <section className="panel" aria-labelledby="weightH" data-reveal>
            <div className="panel-head">
              <h2 id="weightH">Stake weight</h2>
              {mounted && isConnected && isStaker ? (
                <span className="chip chip-gold" id="boostChip" suppressHydrationWarning>
                  Active Staker
                </span>
              ) : mounted && isConnected ? (
                <span className="chip" id="boostChip" suppressHydrationWarning>
                  1.00× Base Weight
                </span>
              ) : (
                <span className="chip" id="boostChip" suppressHydrationWarning>
                  Connect Wallet
                </span>
              )}
            </div>
            {mounted && isConnected && livePositions.length > 0 ? (
              <>
                <div className="pools-wrap">
                  <table className="pools">
                    <thead>
                      <tr>
                        <th>Pool</th>
                        <th className="num">Your weight</th>
                        <th className="num">Status</th>
                        <th className="num">Pool budget</th>
                        <th className="num">Your quota</th>
                      </tr>
                    </thead>
                    <tbody id="poolsBody">
                      {livePositions.map((pos) => {
                        const isPending = BigInt(pos.pendingShares || "0") > 0n && BigInt(pos.activeShares || "0") === 0n;
                        return (
                          <tr key={pos.assetAddress}>
                            <td>
                              <b>{pos.asset}</b>
                              <div className="sharebar">
                                <i style={{ width: "100%" }} />
                              </div>
                            </td>
                            <td className="num">
                              ${pos.estimatedUsdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                            <td className="num">
                              {isPending ? (
                                <span className="chip chip-sm" style={{ fontSize: "11px" }}>Pending Rollover</span>
                              ) : (
                                <span className="chip chip-sm chip-gold" style={{ fontSize: "11px" }}>Active</span>
                              )}
                            </td>
                            <td className="num">${allocatedUsd.toFixed(2)}</td>
                            <td className="num" style={{ color: "var(--gold-500)", fontWeight: 600 }}>
                              ${allocatedUsd.toFixed(2)}
                            </td>
                          </tr>
                        );
                      })}
                      <tr>
                        <td><b style={{ fontWeight: 500 }}>Total</b></td>
                        <td className="num"><b style={{ fontWeight: 500 }}>${totalStakeUsd.toFixed(2)}</b></td>
                        <td />
                        <td />
                        <td className="num"><b style={{ fontWeight: 500, color: "var(--gold-500)" }}>${allocatedUsd.toFixed(2)}</b></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="hint" style={{ marginTop: "14px" }}>
                  Quota is computed pro-rata from on-chain vault harvests. Pending stakes become active on the next 00:00 UTC rollover.
                </p>
                <Link className="btn btn-ghost btn-sm" href="/stake" style={{ marginTop: "14px" }}>
                  Stake more assets
                </Link>
              </>
            ) : mounted && isConnected && quotaLoaded && !isStaker ? (
              <div style={{ padding: "20px 0" }}>
                <p className="lead" style={{ fontSize: "15px", marginBottom: "12px" }}>
                  No active stake found for this wallet on Robinhood Chain Testnet.
                </p>
                <p className="hint" style={{ marginBottom: "18px" }}>
                  Stake USDG or Stock Tokens in the vaults to unlock daily AI inference quota and create API keys.
                </p>
                <Link className="btn btn-primary btn-sm" href="/stake">
                  Stake USDG now
                </Link>
              </div>
            ) : (
              <div style={{ padding: "24px 0", textAlign: "center" }}>
                <p className="lead" style={{ fontSize: "15px", marginBottom: "12px" }}>
                  Connect your wallet to view active stake weights and daily quota allocation.
                </p>
                <p className="hint" style={{ marginBottom: "18px" }}>
                  Daily inference quota is calculated dynamically from on-chain vault shares.
                </p>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={openWalletOnboarding}
                >
                  Connect wallet
                </button>
              </div>
            )}
          </section>
        </div>

        {/* 30-Day Usage + Provider Mix */}
        <section className="section" aria-labelledby="usageH">
          <div className="grid-2 usage-grid">
            <div className="panel" data-reveal>
              <div className="usage-head">
                <div>
                  <h2 id="usageH" style={{ fontSize: "18px" }}>
                    Usage, last 30 days
                  </h2>
                  <p className="hint">Inference cost charged to your quota per day.</p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="big" id="u30">
                    ${liveUsage.loaded ? liveUsage.totalCostUsd.toFixed(2) : "0.00"}
                  </div>
                  <div className="hint" style={{ margin: 0 }}>
                    30-day total
                  </div>
                </div>
              </div>

              <UsageChart points={liveUsage.dailyPoints} />
            </div>

            <div className="panel" data-reveal>
              <h2 style={{ fontSize: "18px", marginBottom: "6px" }}>By provider</h2>
              <p className="hint" style={{ marginBottom: "14px" }}>
                Share of 30-day cost.
              </p>
              {liveUsage.providerMix.length > 0 ? (
                <div className="mix" id="mix">
                  {liveUsage.providerMix.map((p) => {
                    const color =
                      p.name === "Anthropic"
                        ? "var(--gold-500)"
                        : p.name === "OpenAI"
                          ? "var(--tyr-600)"
                          : p.name === "Google"
                            ? "var(--tyr-400)"
                            : "var(--series-2)";
                    return (
                      <div key={p.name}>
                        <span>{p.name}</span>
                        <span className="bar">
                          <i style={{ width: `${p.pct}%`, background: color }} />
                        </span>
                        <span className="pct">{p.pct}%</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ padding: "32px 0", color: "var(--text-sub)", fontSize: "13px" }}>
                  No inference usage recorded in this period. Use the Playground or generate an API key to execute AI requests.
                </div>
              )}
              <Link className="btn btn-ghost btn-sm" href="/playground" style={{ marginTop: "20px" }}>
                Open playground
              </Link>
            </div>
          </div>
        </section>

        {/* API Keys Table */}
        <section className="section" aria-labelledby="keysH" style={{ paddingTop: 0 }}>
          <div className="panel" data-reveal>
            <div className="panel-head">
              <div>
                <h2 id="keysH">API keys</h2>
                <p className="hint" style={{ marginTop: "4px" }}>
                  Use a key as <code className="inline">Authorization: Bearer tyr_live_…</code>.{" "}
                  {authenticated
                    ? "Keys are stored by the gateway and can be rotated or revoked."
                    : "Sign in with your wallet to create and manage keys."}
                </p>
              </div>
              <button
                className="btn btn-primary"
                type="button"
                id="newKey"
                disabled={!canManageKeys || sessionLoading || createPending}
                onClick={() => {
                  setGeneratedRawKey(null);
                  setModalTarget(null);
                  setKeyAction("create");
                  setKeyError("");
                  setModalOpen(true);
                }}
              >
                Create key
              </button>
            </div>

            {keysError ? (
              <p className="hint err" role="alert">{keysError}</p>
            ) : null}
            {sessionError && !keysError ? (
              <p className="hint err" role="alert">{sessionError}</p>
            ) : null}

            <div className="table-wrap" style={{ border: 0, background: "none" }}>
              <table className="data" id="keysTable">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Key</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th className="num">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody id="keysBody">
                  {!isConnected ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty">
                          <h3>Connect to manage keys</h3>
                          <p style={{ marginBottom: "16px" }}>Keys are tied to your wallet.</p>
                          <button className="btn btn-primary" type="button" onClick={openWalletOnboarding}>
                            Connect wallet
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : !authenticated ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty">
                          <h3>Sign in to manage keys</h3>
                          <p style={{ marginBottom: "16px" }}>
                            A wallet signature proves this wallet owns the keys.
                          </p>
                          <button
                            className="btn btn-primary"
                            type="button"
                            disabled={signingIn || sessionLoading}
                            onClick={openWalletOnboarding}
                          >
                            {signingIn ? "Waiting for signature…" : "Continue sign-in"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : keysLoading ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty">
                          <h3>Loading keys</h3>
                          <p>Fetching keys owned by this wallet.</p>
                        </div>
                      </td>
                    </tr>
                  ) : keys.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty">
                          <h3>No keys yet</h3>
                          <p>Create a key to call the gateway from your code or agent.</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    keys.map((k) => (
                      <tr key={k.id}>
                        <td data-l="Name">
                          <b style={{ fontWeight: 500 }}>{k.name}</b>
                        </td>
                        <td data-l="Key" className="mono">{k.keyMasked}</td>
                        <td data-l="Created">{k.created}</td>
                        <td data-l="Last used">{k.lastUsed}</td>
                        <td className="num">
                          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleRotateKey(k)}
                              disabled={actionBusy}
                              title="Rotate API key and revoke the old secret"
                            >
                              Rotate
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              onClick={() => handleRevokeKey(k)}
                              disabled={actionBusy}
                            >
                              Revoke
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      {/* Create / rotate / revoke Key Modal Dialog */}
      {modalOpen && (
        <div className="modal" id="keyModal" role="dialog" aria-modal="true" style={{ display: "grid" }}>
          <div
            className="modal-backdrop"
            onClick={() => {
              if (!actionBusy) setModalOpen(false);
            }}
          />
          <div className="modal-card">
            <div className="modal-head">
              <h3 id="kmTitle">
                {keyAction === "rotate"
                  ? "Rotate API key"
                  : keyAction === "revoke"
                    ? "Revoke API key"
                    : "Create API key"}
              </h3>
              <button
                className="icon-btn"
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Close"
                disabled={actionBusy}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            {generatedRawKey ? (
              <div>
                {keyAction === "rotate" ? (
                  <p className="hint" style={{ marginBottom: "12px" }}>
                    The previous key has been revoked. Update your client with this new secret.
                  </p>
                ) : null}
                <p style={{ fontSize: "13px", color: "var(--warning)", marginBottom: "12px" }}>
                  <b>Copy this key now.</b> It is shown only once. Tyrian stores a SHA-256 hash, so it cannot be recovered.
                </p>
                <div className="keybox">
                  <code id="kmKey">{generatedRawKey}</code>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(generatedRawKey)}
                  >
                    Copy
                  </button>
                </div>
                <div className="modal-actions">
                  <button className="btn btn-primary" type="button" onClick={() => setModalOpen(false)}>
                    I&#39;ve saved it
                  </button>
                </div>
              </div>
            ) : keyAction === "revoke" ? (
              <div>
                <p className="hint">
                  Revoke <b>{modalTarget?.name}</b>? Any application using this key will stop immediately. This cannot
                  be undone.
                </p>
                {keyError ? (
                  <p className="hint err" role="alert">{keyError}</p>
                ) : null}
                <div className="modal-actions">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => setModalOpen(false)}
                    disabled={actionPending}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-danger-solid"
                    type="button"
                    onClick={() => void confirmRevokeKey()}
                    disabled={actionPending}
                  >
                    {actionPending ? "Revoking…" : "Revoke key"}
                  </button>
                </div>
              </div>
            ) : keyAction === "rotate" ? (
              <div>
                {actionPending ? (
                  <p className="hint">Rotating key…</p>
                ) : keyError ? (
                  <p className="hint err" role="alert">{keyError}</p>
                ) : (
                  <p className="hint">
                    Rotate <b>{modalTarget?.name}</b>? The old secret will be revoked immediately. Copy the new secret
                    before closing this dialog.
                  </p>
                )}
                <div className="modal-actions">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => setModalOpen(false)}
                    disabled={actionPending}
                  >
                    Cancel
                  </button>
                  {!actionPending ? (
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => void confirmRotateKey()}
                    >
                      {keyError ? "Try again" : "Rotate key"}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreateKey}>
                <div className="field">
                  <label htmlFor="kmName">Key name</label>
                  <div className="inp">
                    <input
                      id="kmName"
                      type="text"
                      maxLength={40}
                      placeholder="e.g. laptop, cursor-agent"
                      value={newKeyName}
                      onChange={(e) => {
                        setNewKeyName(e.target.value);
                        if (keyError) setKeyError("");
                      }}
                      autoFocus
                      disabled={createPending}
                    />
                  </div>
                  <p className={`hint${keyError ? " err" : ""}`} role={keyError ? "alert" : undefined}>
                    {keyError || "Only you see this name."}
                  </p>
                </div>
                <div className="modal-actions">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => setModalOpen(false)}
                    disabled={createPending}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={!newKeyName.trim() || createPending}
                  >
                    {createPending ? "Creating…" : "Create key"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
