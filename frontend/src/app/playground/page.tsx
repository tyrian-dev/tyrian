"use client";

import Link from "next/link";
import { useState, useRef, useEffect, useMemo } from "react";
import { useAccount } from "wagmi";
import { useTyrianSession } from "@/providers/TyrianSessionProvider";
import { useWalletOnboarding } from "@/hooks/useWalletOnboarding";
import { activeNetwork } from "@shared/contracts/addresses";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  context: string;
  inPrice: number;
  outPrice: number;
}

const AVAILABLE_MODELS: ModelInfo[] = [
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", provider: "Anthropic", context: "200K", inPrice: 3.0, outPrice: 15.0 },
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "OpenAI", context: "128K", inPrice: 2.5, outPrice: 10.0 },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google", context: "1M", inPrice: 0.075, outPrice: 0.3 },
  { id: "deepseek/deepseek-chat", name: "DeepSeek V3", provider: "DeepSeek", context: "64K", inPrice: 0.14, outPrice: 0.28 },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", provider: "Meta", context: "128K", inPrice: 0.2, outPrice: 0.4 },
  { id: "qwen/qwen-2.5-72b-instruct", name: "Qwen 2.5 72B", provider: "Qwen", context: "128K", inPrice: 0.35, outPrice: 0.4 },
];

type ChatRole = "user" | "assistant" | "error" | "note";

interface ChatMessage {
  role: ChatRole;
  content: string;
}

const PLAYGROUND_SESSION_KEY = "tyr_live_playground_session";

const ERROR_MESSAGES: Record<number, string> = {
  401: "Your session ended. Sign in again to continue.",
  402: "You've used today's quota. It resets at 00:00 UTC.",
  429: "Too many requests. Wait a moment and try again.",
};

export default function PlaygroundPage() {
  const { address, isConnected } = useAccount();
  const { openWalletOnboarding } = useWalletOnboarding();
  const {
    authenticated,
    loading: sessionLoading,
    signingIn,
    error: sessionError,
    refresh: refreshSession,
  } = useTyrianSession();
  const [selectedModel, setSelectedModel] = useState<ModelInfo>(AVAILABLE_MODELS[0]);
  const [modelsList, setModelsList] = useState<ModelInfo[]>(AVAILABLE_MODELS);
  const [catalogSource, setCatalogSource] = useState<"live" | "curated" | "cache" | "fallback">("curated");
  const [temp, setTemp] = useState<number>(0.7);
  const [maxTok, setMaxTok] = useState<number>(1024);
  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [quotaLeft, setQuotaLeft] = useState<string>("-");
  const [quotaUsd, setQuotaUsd] = useState<number | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<"checking" | "live" | "offline">("checking");

  // Model Picker State (Two-Column Split Modal)
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [splitCategory, setSplitCategory] = useState<string>("featured");
  const [modelSearch, setModelSearch] = useState("");
  const [hideBatch, setHideBatch] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modalCardRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const modalBackdropRef = useRef<HTMLDivElement>(null);
  const triggerBtnRef = useRef<HTMLButtonElement>(null);

  const PROVIDERS = [
    { id: "all", label: "All" },
    { id: "anthropic", label: "Anthropic" },
    { id: "openai", label: "OpenAI" },
    { id: "google", label: "Google" },
    { id: "deepseek", label: "DeepSeek" },
    { id: "qwen", label: "Qwen" },
    { id: "meta", label: "Meta" },
  ];

  const providerCounts = useMemo(() => {
    const counts: Record<string, number> = { all: modelsList.length };
    modelsList.forEach((m) => {
      const p = m.provider.toLowerCase();
      counts[p] = (counts[p] || 0) + 1;
    });
    return counts;
  }, [modelsList]);

  const FEATURED_SLUGS = [
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-3.5-sonnet",
    "openai/gpt-4o-mini",
    "openai/gpt-4o",
    "deepseek/deepseek-chat",
    "google/gemini-2.5-flash",
    "meta-llama/llama-3.3-70b-instruct",
    "qwen/qwen-2.5-72b-instruct",
  ];

  const featuredModels = useMemo(() => {
    return modelsList.filter((m) => FEATURED_SLUGS.includes(m.id));
  }, [modelsList]);

  const splitModels = useMemo(() => {
    let list = modelsList;
    if (hideBatch && !modelSearch.toLowerCase().includes("batch")) {
      list = list.filter((m) => !m.id.includes(":batch"));
    }
    if (splitCategory === "featured") {
      list = list.filter((m) => FEATURED_SLUGS.includes(m.id));
    } else if (splitCategory === "coding") {
      list = list.filter((m) => /(coder|code|sonnet|gpt-4o|qwen.*coder)/i.test(m.id + m.name));
    } else if (splitCategory === "reasoning") {
      list = list.filter((m) => /(r1|o1|o3|reasoning)/i.test(m.id + m.name));
    } else if (splitCategory === "fast") {
      list = list.filter((m) => m.inPrice < 0.25 || /(flash|mini|turbo|7b|8b)/i.test(m.id + m.name));
    } else if (splitCategory !== "all") {
      list = list.filter(
        (m) =>
          m.provider.toLowerCase() === splitCategory.toLowerCase() ||
          m.id.toLowerCase().startsWith(splitCategory.toLowerCase() + "/") ||
          (splitCategory === "meta" && m.id.toLowerCase().startsWith("meta-llama/")),
      );
    }
    if (modelSearch.trim()) {
      const q = modelSearch.toLowerCase().trim();
      list = list.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q),
      );
    }
    return list;
  }, [modelsList, hideBatch, splitCategory, modelSearch]);

  // Two-Column Modal Scroll Lock & Smart Wheel Forwarding
  useEffect(() => {
    if (!modelPickerOpen) return;

    // 1. Capture scroll position and existing document styles
    const scrollY = window.scrollY;
    const prevBodyPosition = document.body.style.position;
    const prevBodyTop = document.body.style.top;
    const prevBodyLeft = document.body.style.left;
    const prevBodyRight = document.body.style.right;
    const prevBodyWidth = document.body.style.width;
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;

    // 2. Lock page scroll completely (position: fixed prevents background displacement on any browser)
    document.documentElement.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";

    try {
      (window as unknown as { __lenis?: { stop: () => void; start: () => void } }).__lenis?.stop();
    } catch {}

    // 3. Two-Column Smart Wheel Routing:
    // If cursor is over left sidebar -> scroll left sidebar.
    // If cursor is over right column, header, search bar, or footer -> scroll right model list.
    const cardEl = modalCardRef.current;
    const backdropEl = modalBackdropRef.current;

    const handleCardWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      const isOverSidebar = Boolean(
        sidebarRef.current && (sidebarRef.current === target || sidebarRef.current.contains(target))
      );

      if (isOverSidebar && sidebarRef.current) {
        sidebarRef.current.scrollTop += e.deltaY;
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (modelListRef.current) {
        modelListRef.current.scrollTop += e.deltaY;
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleBackdropWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleBackdropTouchMove = (e: TouchEvent) => {
      e.preventDefault();
    };

    if (cardEl) {
      cardEl.addEventListener("wheel", handleCardWheel, { passive: false });
    }
    if (backdropEl) {
      backdropEl.addEventListener("wheel", handleBackdropWheel, { passive: false });
      backdropEl.addEventListener("touchmove", handleBackdropTouchMove, { passive: false });
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModelPickerOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    const timer = setTimeout(() => searchInputRef.current?.focus(), 60);

    return () => {
      if (cardEl) {
        cardEl.removeEventListener("wheel", handleCardWheel);
      }
      if (backdropEl) {
        backdropEl.removeEventListener("wheel", handleBackdropWheel);
        backdropEl.removeEventListener("touchmove", handleBackdropTouchMove);
      }
      window.removeEventListener("keydown", handleKeyDown);
      clearTimeout(timer);

      // Restore scroll lock
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.position = prevBodyPosition;
      document.body.style.top = prevBodyTop;
      document.body.style.left = prevBodyLeft;
      document.body.style.right = prevBodyRight;
      document.body.style.width = prevBodyWidth;
      document.body.style.overflow = prevBodyOverflow;
      window.scrollTo(0, scrollY);

      try {
        (window as unknown as { __lenis?: { stop: () => void; start: () => void } }).__lenis?.start();
      } catch {}
    };
  }, [modelPickerOpen]);

  const msgsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Dynamically load all available models from /v1/models with safe curated fallback
  useEffect(() => {
    let cancelled = false;

    fetch("/v1/models", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => {
        if (cancelled) return;
        const rawList = Array.isArray(json?.data) ? json.data : [];
        if (rawList.length > 0) {
          const parsed: ModelInfo[] = rawList.map((m: any) => {
            const providerKey = (m.id || "").split("/")[0] || "ai";
            const providerMap: Record<string, string> = {
              openai: "OpenAI",
              anthropic: "Anthropic",
              google: "Google",
              "meta-llama": "Meta",
              qwen: "Qwen",
              deepseek: "DeepSeek",
            };
            const providerLabel = providerMap[providerKey] || providerKey;

            const ctxNum = m.context_length || m.top_provider?.context_length || 128000;
            const ctxLabel =
              ctxNum >= 1e6
                ? `${(ctxNum / 1e6).toFixed(ctxNum % 1e6 ? 1 : 0)}M`
                : `${Math.round(ctxNum / 1000)}K`;

            const inPrice =
              m.pricing?.promptTokenPriceUsd !== undefined
                ? m.pricing.promptTokenPriceUsd
                : +(m.pricing?.prompt ?? 0) * 1e6;
            const outPrice =
              m.pricing?.completionTokenPriceUsd !== undefined
                ? m.pricing.completionTokenPriceUsd
                : +(m.pricing?.completion ?? 0) * 1e6;

            return {
              id: m.id,
              name: (m.name || m.id).replace(/^[^:]+:\s*/, ""),
              provider: providerLabel,
              context: ctxLabel,
              inPrice: Number.isFinite(inPrice) ? inPrice : 0,
              outPrice: Number.isFinite(outPrice) ? outPrice : 0,
            };
          });

          setModelsList(parsed);
          setCatalogSource(json.source === "live" ? "live" : "curated");

          // Sync requested model from URL query parameter ?model=...
          const requested = new URLSearchParams(window.location.search).get("model");
          if (requested) {
            const found = parsed.find((model) => model.id === requested);
            if (found) setSelectedModel(found);
          }
        }
      })
      .catch((err) => {
        console.warn("[Playground] Live model catalog fetch failed, using curated safe-list:", err);
        if (!cancelled) {
          setCatalogSource("fallback");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Sync initial model if already present before fetch completes
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("model");
    if (!requested) return;
    const found = AVAILABLE_MODELS.find((model) => model.id === requested);
    if (found) setSelectedModel(found);
  }, []);

  // Load the session quota so the sidebar shows a real number instead of a
  // hardcoded figure. Signed-in users are authenticated by the session cookie;
  // the internal key remains available for local preview only.
  useEffect(() => {
    if (sessionLoading) return;

    let cancelled = false;
    const quotaUrl = authenticated
      ? "/v1/quota"
      : address
        ? `/v1/quota?address=${encodeURIComponent(address)}`
        : "/v1/quota";

    fetch(quotaUrl, {
      headers: authenticated || address
        ? undefined
        : { Authorization: `Bearer ${PLAYGROUND_SESSION_KEY}` },
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data) => {
        if (cancelled) return;
        const remaining = Number(data.remainingUsd);
        if (Number.isFinite(remaining)) {
          setQuotaUsd(Math.max(0, remaining));
          setQuotaLeft(`$${Math.max(0, remaining).toFixed(4)}`);
        }
        setGatewayStatus("live");
      })
      .catch(() => {
        if (!cancelled) setGatewayStatus("offline");
      });

    return () => {
      cancelled = true;
    };
  }, [address, authenticated, sessionLoading]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const inputTokensEst = Math.ceil(input.length / 4);
  const maxCostValue = (inputTokensEst * selectedModel.inPrice + maxTok * selectedModel.outPrice) / 1000000;
  const maxCost = maxCostValue.toFixed(4);

  const chooseModel = (id: string) => {
    const found = modelsList.find((model) => model.id === id) || AVAILABLE_MODELS.find((model) => model.id === id);
    if (!found) return;
    setSelectedModel(found);
    const url = new URL(window.location.href);
    url.searchParams.set("model", found.id);
    window.history.replaceState(null, "", url);
  };

  const sendMessage = async (promptText: string) => {
    const textToSend = promptText || input;
    if (!textToSend.trim() || loading) return;

    if (!authenticated) {
      openWalletOnboarding();
      setMessages((prev) => [
        ...prev,
        {
          role: "note",
          content: "Please connect and sign in with your wallet to send inference prompts using your daily quota.",
        },
      ]);
      return;
    }

    if (quotaUsd !== null && (quotaUsd <= 0 || maxCostValue > quotaUsd)) {
      setMessages((prev) => [
        ...prev,
        {
          role: "error",
          content:
            quotaUsd <= 0
              ? "Your daily inference quota is currently $0.00. Stake USDG or Stock Tokens on the Stake page to activate your daily inference allowance."
              : `Not enough quota left today. This message could cost up to $${maxCostValue.toFixed(
                  4,
                )} and you have $${quotaUsd.toFixed(4)} left. Lower max output tokens, pick a cheaper model, or wait for the 00:00 UTC reset.`,
        },
      ]);
      return;
    }

    const userMessage: ChatMessage = { role: "user", content: textToSend };
    const newHistory = [...messages, userMessage];
    const apiHistory = newHistory
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content }));

    setMessages(newHistory);
    setInput("");
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authenticated
            ? {}
            : { Authorization: `Bearer ${PLAYGROUND_SESSION_KEY}` }),
        },
        credentials: "same-origin",
        signal: controller.signal,
        body: JSON.stringify({
          model: selectedModel.id,
          messages: apiHistory,
          stream: true,
          temperature: temp,
          max_tokens: maxTok,
        }),
      });

      const remHeader = response.headers.get("x-tyrian-quota-remaining");
      if (remHeader) {
        const remaining = Number(remHeader);
        if (Number.isFinite(remaining)) {
          setQuotaUsd(Math.max(0, remaining));
          setQuotaLeft(`$${Math.max(0, remaining).toFixed(4)}`);
        }
      }

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const errorCode = body?.error?.code;
        const isProviderError =
          errorCode === "provider_auth_failed" ||
          errorCode === "provider_credits_exhausted" ||
          errorCode === "provider_key_unavailable" ||
          errorCode === "provider_rate_limited";

        if (response.status === 401 && authenticated && !isProviderError) {
          void refreshSession();
        }

        const serverMessage = body?.error?.message || body?.error || body?.message;
        throw new Error(
          typeof serverMessage === "string"
            ? serverMessage
            : ERROR_MESSAGES[response.status] || `Gateway returned ${response.status}.`
        );
      }

      setGatewayStatus("live");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("The gateway returned an empty response.");

      const decoder = new TextDecoder("utf-8");
      let assistantText = "";
      let buffer = "";
      let doneStreaming = false;

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (!doneStreaming) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;
          if (dataStr === "[DONE]") {
            doneStreaming = true;
            break;
          }
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta?.content || "";
            if (!delta) continue;
            assistantText += delta;
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = { role: "assistant", content: assistantText };
              return updated;
            });
          } catch {
            // Ignore keep-alive or partial SSE frames.
          }
        }
      }

      if (!assistantText) {
        setMessages((prev) => [
          ...prev,
          { role: "note", content: "The model returned no content. Try a different prompt or model." },
        ]);
      }
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError") {
        return;
      }
      const message =
        error instanceof Error && error.message
          ? error.message
          : "The model could not answer right now. Please try again.";
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && !last.content) next.pop();
        return [...next, { role: "error", content: message }];
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setLoading(false);
    }
  };

  const handleClear = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setMessages([]);
  };



  return (
    <main className="page-playground">
      <header className="page-head">
        <svg className="orn" viewBox="-100 -100 200 200" aria-hidden="true">
          <use href="#murex" />
        </svg>
        <div className="wrap">
          <div>
            <div className="eyebrow">Playground</div>
            <h1>Ask any model.</h1>
            <p className="lead">
              Pick a model and chat. Every request is checked against your quota before it goes out, so you see the maximum
              cost first.
            </p>
          </div>
          <div className="aside">
            <div className="telemetry-box" role="status" aria-label="Gateway status">
              <div className="telemetry-item">
                <span className="telemetry-label">AI Gateway</span>
                <span
                  className={`telemetry-value ${
                    gatewayStatus === "live" && catalogSource === "live"
                      ? "success"
                      : "gold"
                  }`}
                >
                  {gatewayStatus === "offline"
                    ? "Offline"
                    : catalogSource === "live"
                      ? "Operational"
                      : "Fallback Mode"}
                </span>
              </div>
              <div className="telemetry-item">
                <span className="telemetry-label">Network</span>
                <span className="telemetry-value">{activeNetwork.label}</span>
              </div>
            </div>
            <Link className="btn btn-ghost btn-sm" href="/models" style={{ alignSelf: "center" }}>
              Browse models
            </Link>
          </div>
        </div>
      </header>

      {!sessionLoading && !authenticated ? (
        <div className="wrap">
          <div className="session-banner" role="status">
            <div>
              <p>
                <b>Unauthenticated session.</b>{" "}
                {isConnected
                  ? "Sign in with your wallet to use your own quota."
                  : "Connect a wallet, then sign in to use your own quota."}
              </p>
              {sessionError ? (
                <p className="err" role="alert">
                  {sessionError}
                </p>
              ) : null}
            </div>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              disabled={signingIn || sessionLoading}
              onClick={openWalletOnboarding}
            >
              {signingIn
                ? "Waiting for signature…"
                : isConnected
                  ? "Sign in with wallet"
                  : "Connect wallet"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="wrap">
        <div className="pg">
          {/* Settings Sidebar */}
          <aside className="panel side" aria-label="Request settings" data-reveal>
            <div className="field" style={{ position: "relative" }}>
              <label htmlFor="modelPickerBtn">Model</label>
              <button
                ref={triggerBtnRef}
                type="button"
                id="modelPickerBtn"
                className="model-trigger-btn"
                onClick={() => setModelPickerOpen((prev) => !prev)}
                aria-haspopup="dialog"
                aria-expanded={modelPickerOpen}
              >
                <div className="model-trigger-info">
                  <span className="model-trigger-name">{selectedModel.name}</span>
                  <span className="model-trigger-tags">
                    <span className="model-tag-prov">{selectedModel.provider}</span>
                    <span className="model-tag-ctx">{selectedModel.context}</span>
                  </span>
                </div>
                <span className="model-trigger-action">
                  <span>Change</span>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="4 6 8 10 12 6" />
                  </svg>
                </span>
              </button>

              <p className="hint" id="modelHint">
                {modelsList.length} models available · {catalogSource === "live" ? "Live upstream catalog" : "Curated safe-list"}
              </p>
            </div>

            <div className="meta" id="modelMeta">
              <div>
                <small>Context</small>
                <b id="mCtx">{selectedModel.context}</b>
              </div>
              <div>
                <small>Provider</small>
                <b id="mProv">{selectedModel.provider}</b>
              </div>
              <div>
                <small>Input / 1M</small>
                <b id="mIn">${selectedModel.inPrice}</b>
              </div>
              <div>
                <small>Output / 1M</small>
                <b id="mOut">${selectedModel.outPrice}</b>
              </div>
            </div>

            <div className="field">
              <div className="label-row">
                <label htmlFor="temp">Temperature</label>
                <output className="mono" id="tempOut" htmlFor="temp">{temp}</output>
              </div>
              <input
                type="range"
                id="temp"
                min="0"
                max="2"
                step="0.1"
                value={temp}
                onChange={(e) => setTemp(Number(e.target.value))}
              />
            </div>

            <div className="field">
              <label htmlFor="maxTok">Max output tokens</label>
              <div className="inp">
                <input
                  id="maxTok"
                  type="number"
                  min="1"
                  max="32000"
                  step="1"
                  value={maxTok}
                  onChange={(e) => setMaxTok(Number(e.target.value) || 1024)}
                  inputMode="numeric"
                />
                <span className="unit">tokens</span>
              </div>
            </div>

            <div className="est" aria-live="polite">
              <div className="row">
                <span>Input (est.)</span>
                <b id="eIn">{inputTokensEst} tok</b>
              </div>
              <div className="row">
                <span>Max cost, this message</span>
                <b id="eMax">${maxCost}</b>
              </div>
              <div className="row total">
                <span>Quota left today</span>
                <b id="eLeft">{quotaLeft}</b>
              </div>
            </div>
            <p className="hint">
              Max cost = price × (input tokens + max output tokens). The gateway refuses with 402 if it&#39;s more than you have left.
            </p>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              id="clear"
              style={{ marginTop: "10px" }}
              onClick={handleClear}
            >
              Clear chat
            </button>
          </aside>

          {/* Chat Section */}
          <section className="panel chat" aria-label="Chat" data-reveal>
            <div className="msgs" id="msgs" role="log" aria-live="polite">
              {messages.length === 0 ? (
                <div className="intro" id="intro">
                  <h2>Start with a question</h2>
                  <p>Messages are not stored by Tyrian. Only the model, token count, cost and latency are logged.</p>
                  <div className="sugg">
                    <button type="button" onClick={() => sendMessage("Explain ERC-4626 vaults in two sentences")}>
                      Explain ERC-4626 vaults in two sentences
                    </button>
                    <button type="button" onClick={() => sendMessage("Write a haiku about Tyrian purple")}>
                      Write a haiku about Tyrian purple
                    </button>
                    <button type="button" onClick={() => sendMessage("Summarize how pro-rata quota works")}>
                      Summarize how pro-rata quota works
                    </button>
                  </div>
                </div>
              ) : (
                messages.map((m, idx) => {
                  const roleClass =
                    m.role === "user"
                      ? "user"
                      : m.role === "assistant"
                        ? "ai"
                        : m.role === "error"
                          ? "err"
                          : m.role;
                  return (
                    <div key={idx} className={`msg ${roleClass}`}>
                      {m.role === "assistant" && <span className="who">{selectedModel.name}</span>}
                      {m.role === "note" && <span className="who">Gateway</span>}
                      {m.role === "assistant" && !m.content && loading ? (
                        <span style={{ color: "var(--gold-500)" }}>Streaming inference...</span>
                      ) : (
                        m.content
                      )}
                    </div>
                  );
                })
              )}
              {loading && messages[messages.length - 1]?.role !== "assistant" && (
                <div className="msg ai">
                  <span className="who">{selectedModel.name}</span>
                  <span style={{ color: "var(--gold-500)" }}>Waiting for the model...</span>
                </div>
              )}
              <div ref={msgsEndRef} />
            </div>

            <form
              className="composer"
              id="composer"
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage(input);
              }}
            >
              <label className="sr-only" htmlFor="prompt">
                Message
              </label>
              <textarea
                id="prompt"
                rows={1}
                placeholder="Message the model…"
                maxLength={20000}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage(input);
                  }
                }}
              />
              <button
                className="btn btn-primary"
                type="submit"
                id="send"
                disabled={loading || (authenticated && !input.trim())}
              >
                {!authenticated ? "Sign in to prompt" : "Send"}
              </button>
            </form>
            <div className="foot-note">Enter to send · Shift + Enter for newline</div>
          </section>
        </div>
      </div>

      {/* Model Picker Split Modal */}
      {modelPickerOpen ? (
        <div
          className="modal"
          data-lenis-prevent="true"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modelPickerHeading"
        >
          <div
            ref={modalBackdropRef}
            className="modal-backdrop"
            onClick={() => setModelPickerOpen(false)}
          />
          <div
            ref={modalCardRef}
            className="model-picker-modal-card"
            data-lenis-prevent="true"
          >
            {/* Modal Header */}
            <div className="model-picker-head">
              <div className="model-picker-title">
                <h3 id="modelPickerHeading">Select AI Model</h3>
                <p>
                  {splitModels.length} models in category &bull; {modelsList.length} total available
                </p>
              </div>

              <div className="model-head-actions">
                <button
                  type="button"
                  className="model-picker-close"
                  onClick={() => setModelPickerOpen(false)}
                  aria-label="Close modal"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="3" y1="3" x2="13" y2="13" />
                    <line x1="13" y1="3" x2="3" y2="13" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Split Container: Left Sidebar & Right Main List */}
            <div className="model-split-container">
              {/* Left Sidebar: Categories */}
              <div ref={sidebarRef} className="model-split-sidebar" data-lenis-prevent="true">
                <div className="model-split-group-label">Views</div>
                <button
                  type="button"
                  className={`model-split-nav-btn ${splitCategory === "featured" ? "active" : ""}`}
                  onClick={() => setSplitCategory("featured")}
                >
                  <span className="split-nav-label">
                    <svg className="split-nav-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M8 1c0 3.866 3.134 7 7 7-3.866 0-7 3.134-7 7 0-3.866-3.134-7-7-7 3.866 0 7-3.134 7-7z" />
                    </svg>
                    <span>Featured</span>
                  </span>
                  <span className="model-split-count">{featuredModels.length}</span>
                </button>
                <button
                  type="button"
                  className={`model-split-nav-btn ${splitCategory === "all" ? "active" : ""}`}
                  onClick={() => setSplitCategory("all")}
                >
                  <span className="split-nav-label">
                    <svg className="split-nav-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2" y="2" width="5" height="5" rx="1" />
                      <rect x="9" y="2" width="5" height="5" rx="1" />
                      <rect x="2" y="9" width="5" height="5" rx="1" />
                      <rect x="9" y="9" width="5" height="5" rx="1" />
                    </svg>
                    <span>All Models</span>
                  </span>
                  <span className="model-split-count">{modelsList.length}</span>
                </button>

                <div className="model-split-divider" />
                <div className="model-split-group-label">Use Cases</div>
                <button
                  type="button"
                  className={`model-split-nav-btn ${splitCategory === "coding" ? "active" : ""}`}
                  onClick={() => setSplitCategory("coding")}
                >
                  <span className="split-nav-label">
                    <svg className="split-nav-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="5 4 1.5 8 5 12" />
                      <polyline points="11 4 14.5 8 11 12" />
                      <line x1="9.5" y1="3" x2="6.5" y2="13" />
                    </svg>
                    <span>Coding &amp; Dev</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={`model-split-nav-btn ${splitCategory === "reasoning" ? "active" : ""}`}
                  onClick={() => setSplitCategory("reasoning")}
                >
                  <span className="split-nav-label">
                    <svg className="split-nav-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="8" cy="3.5" r="1.75" />
                      <circle cx="4" cy="12.5" r="1.75" />
                      <circle cx="12" cy="12.5" r="1.75" />
                      <path d="M8 5.25v2.5M8 7.75l-4 3M8 7.75l4 3" />
                    </svg>
                    <span>Deep Reasoning</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={`model-split-nav-btn ${splitCategory === "fast" ? "active" : ""}`}
                  onClick={() => setSplitCategory("fast")}
                >
                  <span className="split-nav-label">
                    <svg className="split-nav-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polygon points="8.5 1.5 3 8.5 7.5 8.5 6.5 14.5 13 7.5 8.5 7.5 9.5 1.5" />
                    </svg>
                    <span>Fast &amp; Efficient</span>
                  </span>
                </button>

                <div className="model-split-divider" />
                <div className="model-split-group-label">Providers</div>
                {PROVIDERS.filter((p) => p.id !== "all").map((prov) => {
                  const count = providerCounts[prov.id] ?? 0;
                  if (count === 0) return null;
                  return (
                    <button
                      key={`split-${prov.id}`}
                      type="button"
                      className={`model-split-nav-btn ${splitCategory === prov.id ? "active" : ""}`}
                      onClick={() => setSplitCategory(prov.id)}
                    >
                      <span className="split-nav-label">
                        <span className="split-nav-bullet" aria-hidden="true">•</span>
                        <span>{prov.label}</span>
                      </span>
                      <span className="model-split-count">{count}</span>
                    </button>
                  );
                })}
              </div>

              {/* Right Column: Model List with Search & Batch Filter */}
              <div className="model-split-main">
                <div className="model-split-search">
                  <div className="model-search-input-wrap">
                    <svg className="model-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="7" cy="7" r="4.5" />
                      <line x1="10.5" y1="10.5" x2="14" y2="14" />
                    </svg>
                    <input
                      ref={searchInputRef}
                      type="text"
                      className="model-search-input"
                      placeholder={`Search ${splitCategory === "all" ? "all" : splitCategory} models...`}
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                    />
                    {modelSearch ? (
                      <button
                        type="button"
                        className="model-search-clear"
                        onClick={() => setModelSearch("")}
                        aria-label="Clear search"
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <line x1="3" y1="3" x2="13" y2="13" />
                          <line x1="13" y1="3" x2="3" y2="13" />
                        </svg>
                      </button>
                    ) : null}
                  </div>

                  <label className="model-batch-toggle" title="Hide non-interactive batch variant models">
                    <input
                      type="checkbox"
                      checked={hideBatch}
                      onChange={(e) => setHideBatch(e.target.checked)}
                    />
                    <span>Hide :batch</span>
                  </label>
                </div>

                <div
                  ref={modelListRef}
                  className="model-split-list"
                  role="listbox"
                  data-lenis-prevent="true"
                >
                  {splitModels.length === 0 ? (
                    <div className="model-picker-empty">
                      <p>No models found matching &quot;{modelSearch}&quot;</p>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setModelSearch("");
                          setSplitCategory("all");
                        }}
                      >
                        Reset search
                      </button>
                    </div>
                  ) : (
                    splitModels.map((m) => (
                      <button
                        key={`split-m-${m.id}`}
                        type="button"
                        role="option"
                        aria-selected={selectedModel.id === m.id}
                        className={`model-item-mini ${selectedModel.id === m.id ? "selected" : ""}`}
                        onClick={() => {
                          chooseModel(m.id);
                          setModelPickerOpen(false);
                        }}
                      >
                        <div className="model-mini-left">
                          <span className="model-mini-prov">{m.provider}</span>
                          <span className="model-mini-name">{m.name}</span>
                        </div>
                        <div className="model-mini-right">
                          <span className="model-mini-ctx">{m.context}</span>
                          <span className="model-mini-price">${m.inPrice.toFixed(2)}/1M</span>
                          {selectedModel.id === m.id ? (
                            <svg className="model-check-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="3 8.5 6.5 12 13 4" />
                            </svg>
                          ) : null}
                        </div>
                      </button>
                    ))
                  )}
                </div>

                <div className="model-picker-footer">
                  <span>Press <kbd style={{ padding: "2px 5px", background: "var(--surface-2)", borderRadius: 4, border: "1px solid var(--border)", font: "500 11px monospace" }}>Esc</kbd> to close</span>
                  <Link href="/models" onClick={() => setModelPickerOpen(false)}>
                    Browse Models Catalog →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
