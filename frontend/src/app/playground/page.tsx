"use client";

import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { useAccount } from "wagmi";
import { useTyrianSession } from "@/providers/TyrianSessionProvider";
import { useWalletOnboarding } from "@/hooks/useWalletOnboarding";

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
  const [temp, setTemp] = useState<number>(0.7);
  const [maxTok, setMaxTok] = useState<number>(1024);
  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [quotaLeft, setQuotaLeft] = useState<string>("—");
  const [quotaUsd, setQuotaUsd] = useState<number | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<"checking" | "live" | "offline">("checking");

  const msgsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // The model selector on the Models page links here with ?model=...
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
    const found = AVAILABLE_MODELS.find((model) => model.id === id);
    if (!found) return;
    setSelectedModel(found);
    const url = new URL(window.location.href);
    url.searchParams.set("model", found.id);
    window.history.replaceState(null, "", url);
  };

  const sendMessage = async (promptText: string) => {
    const textToSend = promptText || input;
    if (!textToSend.trim() || loading) return;

    if (quotaUsd !== null && maxCostValue > quotaUsd) {
      setMessages((prev) => [
        ...prev,
        {
          role: "error",
          content: `Not enough quota left today. This message could cost up to $${maxCostValue.toFixed(
            4
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
        if (response.status === 401 && authenticated) {
          void refreshSession();
        }
        const body = await response.json().catch(() => null);
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
            <span className={`chip ${gatewayStatus === "live" ? "chip-ok" : gatewayStatus === "checking" ? "chip-warn" : "chip-err"}`}>
              <i />
              {gatewayStatus === "live" ? "Gateway live" : gatewayStatus === "checking" ? "Checking gateway" : "Gateway offline"}
            </span>
            <Link className="btn btn-ghost btn-sm" href="/models">
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
            <div className="field">
              <label htmlFor="model">Model</label>
              <select
                className="select"
                id="model"
                value={selectedModel.id}
                onChange={(e) => chooseModel(e.target.value)}
              >
                {AVAILABLE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.provider})
                  </option>
                ))}
              </select>
              <p className="hint" id="modelHint">
                6 models on the allowlist.
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
              <button className="btn btn-primary" type="submit" id="send" disabled={loading || !input.trim()}>
                Send
              </button>
            </form>
            <div className="foot-note">Enter to send · Shift + Enter for a new line</div>
          </section>
        </div>
      </div>
    </main>
  );
}
