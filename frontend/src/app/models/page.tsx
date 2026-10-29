"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  ctx: number;
  inM: number;
  outM: number;
  created: number;
  maxOut?: number | null;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  created?: number;
  architecture?: { output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
  };
}

const ALLOWLIST = [
  "openai/",
  "anthropic/",
  "google/",
  "meta-llama/",
  "qwen/",
  "deepseek/",
];

const providerName = (p: string) =>
  ({
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    "meta-llama": "Meta Llama",
    qwen: "Qwen",
    deepseek: "DeepSeek",
  }[p] || p);

const fmtP = (v: number) =>
  v === 0 ? "Free" : "$" + (v < 1 ? v.toFixed(3) : v.toFixed(2));

const fmtCtx = (n: number) =>
  !n
    ? "-"
    : n >= 1e6
    ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M"
    : Math.round(n / 1000) + "K";

type ModelSource = "live" | "cache" | "fallback";

export default function ModelsPage() {
  const [allModels, setAllModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [source, setSource] = useState<ModelSource>("live");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("new");
  const [selectedProv, setSelectedProv] = useState("all");

  const showToast = (msg: string) => {
    const toast = document.getElementById("toast");
    const toastText = document.getElementById("toastText");
    if (toast && toastText) {
      toastText.textContent = msg;
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 2400);
    }
  };

  const copyModelId = (id: string) => {
    navigator.clipboard.writeText(id).then(() => {
      showToast(`Copied ${id}`);
    });
  };

  const loadModels = useCallback(async (force = false) => {
    setLoading(true);
    setError(false);
    if (!force) {
      try {
        const c = JSON.parse(sessionStorage.getItem("tyr-models") || "null");
        if (c && Date.now() - c.t < 36e5 && Array.isArray(c.list) && c.list.length > 0) {
          setAllModels(c.list);
          setSource(c.source === "fallback" ? "fallback" : "cache");
          setError(c.source === "fallback");
          setLoading(false);
          return;
        }
      } catch {}
    }

    try {
      // Connect directly to Tyrian gateway endpoint /v1/models (never direct to upstream from browser)
      const res = await fetch("/v1/models", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Gateway returned status ${res.status}`);

      const json = (await res.json()) as {
        data?: Array<{
          id: string;
          name?: string;
          context_length?: number;
          created?: number;
          pricing?: {
            prompt?: string;
            completion?: string;
            promptTokenPriceUsd?: number;
            completionTokenPriceUsd?: number;
          };
          top_provider?: {
            context_length?: number;
            max_completion_tokens?: number | null;
          };
        }>;
        source?: string;
      };

      const rawList = Array.isArray(json.data) ? json.data : [];
      const parsed: ModelInfo[] = rawList
        .filter((m) => ALLOWLIST.some((p) => m.id.startsWith(p)))
        .map((m) => {
          const inM =
            m.pricing?.promptTokenPriceUsd !== undefined
              ? m.pricing.promptTokenPriceUsd
              : +(m.pricing?.prompt ?? 0) * 1e6;
          const outM =
            m.pricing?.completionTokenPriceUsd !== undefined
              ? m.pricing.completionTokenPriceUsd
              : +(m.pricing?.completion ?? 0) * 1e6;

          return {
            id: m.id,
            name: (m.name || m.id).replace(/^[^:]+:\s*/, ""),
            provider: m.id.split("/")[0],
            ctx: m.context_length || m.top_provider?.context_length || 0,
            inM,
            outM,
            created: m.created || 1718800000,
            maxOut: m.top_provider?.max_completion_tokens || null,
          };
        });

      if (parsed.length === 0) {
        throw new Error("No models available from gateway");
      }

      setAllModels(parsed);
      setSource("live");
      setError(false);
      try {
        sessionStorage.setItem(
          "tyr-models",
          JSON.stringify({ t: Date.now(), list: parsed, source: "live" })
        );
      } catch {}
    } catch (err) {
      console.error("[ModelsPage] Failed to load gateway catalog:", err);
      // In compliance with Rule 9: Never show fake preview numbers as live.
      // If session storage has a prior cache, we can use it with 'cache' badge.
      let recovered = false;
      try {
        const c = JSON.parse(sessionStorage.getItem("tyr-models") || "null");
        if (c && Array.isArray(c.list) && c.list.length > 0) {
          setAllModels(c.list);
          setSource("cache");
          setError(true);
          recovered = true;
        }
      } catch {}

      if (!recovered) {
        setAllModels([]);
        setSource("fallback");
        setError(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  const providers = useMemo(() => {
    return Array.from(new Set(allModels.map((m) => m.provider)));
  }, [allModels]);

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = allModels.filter(
      (m) =>
        (selectedProv === "all" || m.provider === selectedProv) &&
        (!q || m.name.toLowerCase().includes(q) || m.id.includes(q))
    );

    const by: Record<string, (a: ModelInfo, b: ModelInfo) => number> = {
      new: (a, b) => b.created - a.created,
      name: (a, b) => a.name.localeCompare(b.name),
      in: (a, b) => a.inM - b.inM,
      out: (a, b) => a.outM - b.outM,
      ctx: (a, b) => b.ctx - a.ctx,
    };

    if (by[sort]) {
      list.sort(by[sort]);
    }
    return list;
  }, [allModels, selectedProv, search, sort]);

  return (
    <main className="page-models">
      <header className="page-head">
        <svg className="orn" viewBox="-100 -100 200 200" aria-hidden="true">
          <use href="#murex" />
        </svg>
        <div className="wrap">
          <div>
            <div className="eyebrow">Model catalog</div>
            <h1>Every model, one key.</h1>
            <p className="lead">
              Models from OpenAI, Anthropic, Google, Meta Llama, Qwen and DeepSeek. Your quota is charged at the provider prices shown here.
            </p>
          </div>
          <div className="aside">
            <div className="telemetry-box" role="status" aria-label="Catalog telemetry">
              <div className="telemetry-item">
                <span className="telemetry-label">Catalog Source</span>
                <span className={`telemetry-value ${source === "live" ? "success" : "gold"}`}>
                  {loading ? "Loading…" : source === "live" ? "Live Gateway" : source === "cache" ? "Cached" : "Unavailable"}
                </span>
              </div>
              <div className="telemetry-item">
                <span className="telemetry-label">Total Models</span>
                <span className="telemetry-value gold" id="countChip">
                  {loading ? "…" : `${allModels.length} Models`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="wrap">
        <div className="controls">
          <div className="search">
            <label className="sr-only" htmlFor="q">
              Search models
            </label>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              className="text-inp"
              id="q"
              type="search"
              placeholder="Search by name or id"
              autoComplete="off"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label className="sr-only" htmlFor="sort">
            Sort by
          </label>
          <select
            className="select"
            id="sort"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="new">Newest first</option>
            <option value="name">Name A to Z</option>
            <option value="in">Input price, low to high</option>
            <option value="out">Output price, low to high</option>
            <option value="ctx">Largest context</option>
          </select>
          <button
            className="btn btn-ghost"
            type="button"
            id="refresh"
            onClick={() => loadModels(true)}
            disabled={loading}
          >
            Refresh
          </button>
        </div>

        {error && !loading && (
          <div className="banner" style={{ marginBottom: "18px" }} role="status">
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
              <b>Gateway catalog unavailable.</b> {source === "cache" ? "Showing cached model catalog. Click retry to reconnect to the live gateway." : "Failed to load model catalog from gateway. Please check your connection and retry."}
            </div>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => loadModels(true)}>
              Retry
            </button>
          </div>
        )}

        <div className="provs" role="group" aria-label="Filter by provider" id="provs">
          <button
            type="button"
            data-p="all"
            aria-pressed={selectedProv === "all"}
            onClick={() => setSelectedProv("all")}
          >
            All providers{" "}
            <span className="mono faint">{allModels.length}</span>
          </button>
          {providers.map((p) => {
            const count = allModels.filter((m) => m.provider === p).length;
            return (
              <button
                key={p}
                type="button"
                data-p={p}
                aria-pressed={selectedProv === p}
                onClick={() => setSelectedProv(p)}
              >
                {providerName(p)}{" "}
                <span className="mono faint">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="table-wrap">
          <table className="data" id="mTable">
            <caption className="sr-only">
              Models on the Tyrian allowlist with prices per million tokens
            </caption>
            <thead>
              <tr>
                <th>Model</th>
                <th className="prov">Provider</th>
                <th className="num">Context</th>
                <th className="num">Input / 1M</th>
                <th className="num">Output / 1M</th>
                <th className="num">
                  <span className="sr-only">Try</span>
                </th>
              </tr>
            </thead>
            <tbody id="mBody">
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    <td>
                      <span className="skel" style={{ width: "60%" }} />
                      <span
                        className="skel"
                        style={{ width: "40%", marginTop: "8px", height: "10px" }}
                      />
                    </td>
                    <td className="prov">
                      <span className="skel" style={{ width: "70px" }} />
                    </td>
                    <td>
                      <span className="skel" />
                    </td>
                    <td>
                      <span className="skel" />
                    </td>
                    <td>
                      <span className="skel" />
                    </td>
                    <td />
                  </tr>
                ))
              ) : filteredModels.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">
                      <h3>{error ? "Catalog unavailable" : "No models match"}</h3>
                      <p>{error ? "Unable to load model list from gateway. Please check your connection and retry." : "Try another name or clear the provider filter."}</p>
                      {error && (
                        <button className="btn btn-secondary btn-sm" style={{ marginTop: "12px" }} onClick={() => loadModels(true)}>
                          Retry
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                filteredModels.map((m) => (
                  <tr key={m.id}>
                    <td className="mname">
                      <b>{m.name}</b>
                      <span className="mid">
                        <code>{m.id}</code>
                        <button
                          type="button"
                          aria-label={`Copy model id ${m.id}`}
                          onClick={() => copyModelId(m.id)}
                        >
                          Copy
                        </button>
                      </span>
                    </td>
                    <td className="prov">{providerName(m.provider)}</td>
                    <td className="num" data-l="Context">
                      {fmtCtx(m.ctx)}
                    </td>
                    <td className="num" data-l="Input / 1M">
                      {fmtP(m.inM)}
                    </td>
                    <td className="num" data-l="Output / 1M">
                      {fmtP(m.outM)}
                    </td>
                    <td className="num act">
                      <Link
                        className="btn btn-ghost btn-sm try"
                        href={`/playground?model=${encodeURIComponent(m.id)}`}
                      >
                        Try in playground
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <p className="note">
          Prices come from OpenRouter and are refreshed when you load this page. Providers can change prices; the gateway always charges the actual cost reported for each request. Allowlist: <code className="inline">openai/*</code> <code className="inline">anthropic/*</code> <code className="inline">google/*</code> <code className="inline">meta-llama/*</code> <code className="inline">qwen/*</code> <code className="inline">deepseek/*</code>
        </p>
      </div>
    </main>
  );
}
