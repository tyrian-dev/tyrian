"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { activeNetwork } from "@shared/contracts/addresses";

interface TelemetrySummary {
  uptimeSeconds: number;
  http: {
    totalRequests: number;
    requestsByPath: Record<string, number>;
  };
  gateway: {
    totalRequests: number;
    totalSpendUsd: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    activeStreams: number;
    quotaExceededCount: number;
    rateLimitedCount: number;
    upstreamErrorsCount: number;
  };
  budget: {
    dailySpendUsd: number;
    dailyBudgetCapUsd: number;
    utilizationRatio: number;
  };
  reconciliation: {
    lastDiff: number;
  };
  auth: {
    operations: Record<string, number>;
  };
}

interface ReconciliationAsset {
  symbol: string;
  assetAddress: string;
  vaultAddress: string;
  onChainTotalShares: string;
  indexerTotalShares: string;
  diff: string;
  matched: boolean;
  solvent: boolean;
}

interface ReconciliationReport {
  status: "MATCH" | "DIFF_DETECTED";
  timestamp: string;
  blockNumber: number;
  network: string;
  assets: ReconciliationAsset[];
  totalDiff: string;
  allMatched: boolean;
}

interface AlertItem {
  id: string;
  type: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export default function OpsMonitoringPage() {
  const [telemetry, setTelemetry] = useState<TelemetrySummary | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationReport | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");

  const fetchData = useCallback(async () => {
    try {
      const [metricsRes, reconRes, alertRes] = await Promise.all([
        fetch("/api/metrics/summary").catch(() => null),
        fetch("/api/treasury/reconciliation").catch(() => null),
        fetch("/api/metrics/alerts").catch(() => null),
      ]);

      if (metricsRes && metricsRes.ok) {
        setTelemetry(await metricsRes.json());
      }
      if (reconRes && reconRes.ok) {
        setReconciliation(await reconRes.json());
      }
      if (alertRes && alertRes.ok) {
        const body = await alertRes.json();
        setAlerts(body.alerts || []);
      }
      setLastRefreshed(new Date().toLocaleTimeString());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000); // 30s auto-refresh
    return () => clearInterval(interval);
  }, [fetchData]);

  const formatUptime = (seconds: number) => {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  };

  return (
    <div className="page-dashboard page-ops">
      <div className="wrap" style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 20px" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h1 style={{ margin: 0, fontSize: "2rem", fontWeight: 700 }}>Protocol Operations</h1>
              <span
                style={{
                  fontSize: "0.75rem",
                  padding: "4px 8px",
                  borderRadius: 4,
                  background: "rgba(100, 255, 100, 0.1)",
                  color: "#4ade80",
                  border: "1px solid rgba(74, 222, 128, 0.2)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                }}
              >
                {activeNetwork.name} ({activeNetwork.chainId})
              </span>
            </div>
            <p style={{ margin: "6px 0 0", opacity: 0.7, fontSize: "0.9rem" }}>
              Live telemetry, on-chain reconciliation sentinel, and budget guards
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <button
              className="btn btn-secondary"
              onClick={fetchData}
              disabled={loading}
              style={{ padding: "8px 16px", fontSize: "0.85rem", cursor: "pointer" }}
            >
              {loading ? "Refreshing..." : "↻ Refresh"}
            </button>
            <div style={{ fontSize: "0.75rem", opacity: 0.5, marginTop: 4 }}>
              Updated: {lastRefreshed || "loading"}
            </div>
          </div>
        </div>

        {/* Top Status Cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr)) ",
            gap: 16,
            marginBottom: 32,
          }}
        >
          {/* Uptime Card */}
          <div className="panel" style={{ padding: 20, borderRadius: 8, background: "var(--panel-bg, rgba(255,255,255,0.03))" }}>
            <div style={{ fontSize: "0.8rem", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
              Gateway Uptime
            </div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
              {telemetry ? formatUptime(telemetry.uptimeSeconds) : "—"}
            </div>
            <div style={{ fontSize: "0.8rem", opacity: 0.6, marginTop: 4 }}>
              Requests: {telemetry?.http.totalRequests.toLocaleString() ?? "—"}
            </div>
          </div>

          {/* Budget Guard Card */}
          <div className="panel" style={{ padding: 20, borderRadius: 8, background: "var(--panel-bg, rgba(255,255,255,0.03))" }}>
            <div style={{ fontSize: "0.8rem", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
              Daily Budget Guard
            </div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
              ${telemetry?.budget.dailySpendUsd.toFixed(4) ?? "0.0000"}{" "}
              <span style={{ fontSize: "0.9rem", fontWeight: 400, opacity: 0.6 }}>
                / ${telemetry?.budget.dailyBudgetCapUsd.toFixed(2) ?? "0.00"}
              </span>
            </div>
            <div style={{ fontSize: "0.8rem", marginTop: 4, color: (telemetry?.budget.utilizationRatio ?? 0) >= 0.8 ? "#f87171" : "#4ade80" }}>
              Utilized: {((telemetry?.budget.utilizationRatio ?? 0) * 100).toFixed(1)}%
            </div>
          </div>

          {/* Reconciliation Status Card */}
          <div className="panel" style={{ padding: 20, borderRadius: 8, background: "var(--panel-bg, rgba(255,255,255,0.03))" }}>
            <div style={{ fontSize: "0.8rem", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
              On-Chain Audit Diff
            </div>
            <div
              style={{
                fontSize: "1.4rem",
                fontWeight: 700,
                color: (reconciliation?.allMatched ?? true) ? "#4ade80" : "#ef4444",
              }}
            >
              {(reconciliation?.allMatched ?? true) ? "0 Diff (Solvent)" : `Discrepancy: ${reconciliation?.totalDiff}`}
            </div>
            <div style={{ fontSize: "0.8rem", opacity: 0.6, marginTop: 4 }}>
              Block: #{reconciliation?.blockNumber ?? "—"}
            </div>
          </div>

          {/* Active AI Streams */}
          <div className="panel" style={{ padding: 20, borderRadius: 8, background: "var(--panel-bg, rgba(255,255,255,0.03))" }}>
            <div style={{ fontSize: "0.8rem", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
              Inference Streams
            </div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
              {telemetry?.gateway.activeStreams ?? 0} Active
            </div>
            <div style={{ fontSize: "0.8rem", opacity: 0.6, marginTop: 4 }}>
              402 Quota Rejections: {telemetry?.gateway.quotaExceededCount ?? 0}
            </div>
          </div>
        </div>

        {/* Live On-Chain Reconciliation Table */}
        <div className="panel" style={{ padding: 24, borderRadius: 8, marginBottom: 32, background: "var(--panel-bg, rgba(255,255,255,0.03))" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ fontSize: "1.2rem", fontWeight: 600, margin: 0 }}>On-Chain & Indexer Balance Reconciliation</h2>
            <Link href="/api/treasury/reconciliation" target="_blank" style={{ fontSize: "0.85rem", opacity: 0.8, textDecoration: "underline" }}>
              Raw JSON API ↗
            </Link>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", textAlign: "left" }}>
                  <th style={{ padding: "8px 12px" }}>Asset</th>
                  <th style={{ padding: "8px 12px" }}>On-Chain Total Shares</th>
                  <th style={{ padding: "8px 12px" }}>Indexer Staker Sum</th>
                  <th style={{ padding: "8px 12px" }}>Diff</th>
                  <th style={{ padding: "8px 12px" }}>Vault Solvency</th>
                  <th style={{ padding: "8px 12px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {reconciliation?.assets && reconciliation.assets.length > 0 ? (
                  reconciliation.assets.map((asset) => (
                    <tr key={asset.assetAddress} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                      <td style={{ padding: "10px 12px", fontWeight: 600 }}>{asset.symbol}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace" }}>
                        {(BigInt(asset.onChainTotalShares || "0") / 10n ** 18n).toString()} {asset.symbol}
                      </td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace" }}>
                        {(BigInt(asset.indexerTotalShares || "0") / 10n ** 18n).toString()} {asset.symbol}
                      </td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", color: asset.matched ? "inherit" : "#ef4444" }}>
                        {asset.diff}
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <span style={{ color: asset.solvent ? "#4ade80" : "#ef4444", fontWeight: 600 }}>
                          {asset.solvent ? "✓ Solvent" : "⚠️ Underwater"}
                        </span>
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: 4,
                            fontSize: "0.75rem",
                            background: asset.matched ? "rgba(74, 222, 128, 0.15)" : "rgba(239, 68, 68, 0.15)",
                            color: asset.matched ? "#4ade80" : "#ef4444",
                          }}
                        >
                          {asset.matched ? "MATCHED" : "MISMATCH"}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} style={{ padding: 24, textAlign: "center", opacity: 0.5 }}>
                      No asset positions recorded yet or loading indexer data...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Operational Sentinel Alerts */}
        <div className="panel" style={{ padding: 24, borderRadius: 8, background: "var(--panel-bg, rgba(255,255,255,0.03))" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ fontSize: "1.2rem", fontWeight: 600, margin: 0 }}>Operational Alerts & Incidents Log</h2>
            <Link href="/metrics" target="_blank" style={{ fontSize: "0.85rem", opacity: 0.8, textDecoration: "underline" }}>
              Prometheus Metrics Exporter ↗
            </Link>
          </div>

          {alerts.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  style={{
                    padding: 12,
                    borderRadius: 6,
                    borderLeft: `4px solid ${
                      alert.severity === "CRITICAL" ? "#ef4444" : alert.severity === "WARNING" ? "#f59e0b" : "#3b82f6"
                    }`,
                    background: "rgba(255,255,255,0.02)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <strong style={{ fontSize: "0.95rem" }}>{alert.title}</strong>
                    <span style={{ fontSize: "0.75rem", opacity: 0.5 }}>{new Date(alert.timestamp).toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: "0.85rem", opacity: 0.8 }}>{alert.message}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: 24, textAlign: "center", opacity: 0.5, fontSize: "0.9rem" }}>
              ✓ All systems operating normally. Zero active incident alerts recorded.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
