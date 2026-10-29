"use client";

import { useState, useEffect, type ReactNode } from "react";
import Link from "next/link";

const SNIP: Record<string, string> = {
  curl: `curl https://api.tyrian.example/v1/chat/completions \\
  -H "Authorization: Bearer tyr_live_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"anthropic/claude-sonnet-4.5","messages":[{"role":"user","content":"Hello"}]}'`,
  py: `from openai import OpenAI

client = OpenAI(
    base_url="https://api.tyrian.example/v1",
    api_key="tyr_live_xxx",
)
reply = client.chat.completions.create(
    model="anthropic/claude-sonnet-4.5",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)`,
  js: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://api.tyrian.example/v1",
  apiKey: "tyr_live_xxx",
});
const reply = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4.5",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(reply.choices[0].message.content);`,
};

const SECTIONS = [
  { id: "overview", title: "Overview" },
  { id: "quickstart", title: "Quickstart" },
  { id: "auth", title: "Authentication" },
  { id: "quota", title: "Quota" },
  { id: "endpoints", title: "Endpoints" },
  { id: "errors", title: "Errors and limits" },
  { id: "staking", title: "Staking rules" },
  { id: "network", title: "Network" },
];

const KEYWORDS =
  /\b(curl|from|import|const|let|var|new|await|async|function|return|print)\b/;

function highlightCode(code: string) {
  const tokens =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|#[^\n]*|\b(?:curl|from|import|const|let|var|new|await|async|function|return|print)\b)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = tokens.exec(code))) {
    if (match.index > last) nodes.push(code.slice(last, match.index));
    const token = match[0];
    const className = token.startsWith("#")
      ? "c"
      : /^["'`]/.test(token)
        ? "s"
        : KEYWORDS.test(token)
          ? "k"
          : undefined;
    nodes.push(
      className ? (
        <span className={className} key={`${match.index}-${token}`}>
          {token}
        </span>
      ) : (
        token
      )
    );
    last = match.index + token.length;
  }

  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

export default function DocsPage() {
  const [activeTab, setActiveTab] = useState<"curl" | "py" | "js">("curl");
  const [activeSec, setActiveSec] = useState(SECTIONS[0].id);

  const showToast = (msg: string) => {
    const toast = document.getElementById("toast");
    const toastText = document.getElementById("toastText");
    if (toast && toastText) {
      toastText.textContent = msg;
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 2400);
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      showToast("Copied to clipboard");
    });
  };

  useEffect(() => {
    const sections = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => Boolean(el)
    );
    if (!sections.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveSec(visible[0].target.id);
      },
      { rootMargin: "-16% 0px -68% 0px", threshold: 0 }
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (window.__lenis) {
      window.__lenis.scrollTo(el, { offset: -90 });
    } else {
      window.scrollTo({
        top: window.scrollY + el.getBoundingClientRect().top - 90,
        behavior: reducedMotion ? "auto" : "smooth",
      });
    }
    setActiveSec(id);
  };

  return (
    <main className="page-docs">
      <header className="page-head">
        <svg className="orn" viewBox="-100 -100 200 200" aria-hidden="true">
          <use href="#murex" />
        </svg>
        <div className="wrap">
          <div>
            <div className="eyebrow">Docs</div>
            <h1>Build on Tyrian.</h1>
            <p className="lead">
              The gateway speaks the OpenAI API. Point any OpenAI SDK at the Tyrian base URL, use your tyr_live_ key, and requests draw from your daily quota.
            </p>
          </div>
          <div className="aside">
            <div className="telemetry-box" role="status" aria-label="API specification">
              <div className="telemetry-item">
                <span className="telemetry-label">API Status</span>
                <span className="telemetry-value success">v1.0 Live</span>
              </div>
              <div className="telemetry-item">
                <span className="telemetry-label">Protocol</span>
                <span className="telemetry-value">OpenAI Compatible</span>
              </div>
            </div>
            <Link className="btn btn-ghost btn-sm" href="/dashboard" style={{ alignSelf: "center" }}>
              Get an API key
            </Link>
          </div>
        </div>
      </header>

      <div className="wrap">
        <div className="mtoc">
          <label className="sr-only" htmlFor="jump">
            Jump to section
          </label>
          <select
            className="select"
            id="jump"
            value={activeSec || SECTIONS[0].id}
            onChange={(e) => scrollToSection(e.target.value)}
          >
            {SECTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </div>

        <div className="docs">
          <nav className="toc" aria-label="On this page">
            <p>On this page</p>
            <div id="toc">
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className={activeSec === s.id ? "on" : ""}
                  onClick={(e) => {
                    e.preventDefault();
                    scrollToSection(s.id);
                  }}
                >
                  {s.title}
                </a>
              ))}
            </div>
          </nav>

          <article className="doc">
            <section id="overview">
              <h2>Overview</h2>
              <p>
                Tyrian is an AI gateway on Robinhood Chain. You stake USDG, Stock Tokens or $TYR. Yield from staked assets and 80% of $TYR creator fees pay for inference, so you never buy credits.
              </p>
              <p>
                Your stake sets a daily quota in USD. Every request through the gateway is metered against it at the provider&apos;s price. Quota resets at <strong>00:00 UTC</strong>.
              </p>
              <div className="callout">
                Base URL: <code className="inline">https://api.tyrian.example/v1</code>. The domain is a placeholder until launch.
              </div>
            </section>

            <section id="quickstart">
              <h2>Quickstart</h2>
              <ol>
                <li>
                  Stake on the{" "}
                  <Link href="/stake" style={{ textDecoration: "underline" }}>
                    Stake page
                  </Link>
                  . It counts from the next epoch.
                </li>
                <li>
                  Sign in with your wallet and create a key on the{" "}
                  <Link href="/dashboard" style={{ textDecoration: "underline" }}>
                    Dashboard
                  </Link>
                  .
                </li>
                <li>Send a request.</li>
              </ol>
              <div className="code" id="qs">
                <div className="code-bar">
                  <div className="tabs" role="tablist" aria-label="Language">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeTab === "curl"}
                      onClick={() => setActiveTab("curl")}
                    >
                      curl
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeTab === "py"}
                      onClick={() => setActiveTab("py")}
                    >
                      Python
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeTab === "js"}
                      onClick={() => setActiveTab("js")}
                    >
                      JavaScript
                    </button>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => copyText(SNIP[activeTab])}
                  >
                    Copy
                  </button>
                </div>
                <pre id="qsCode">{highlightCode(SNIP[activeTab])}</pre>
              </div>
              <p>
                Streaming works the same way: set <code className="inline">stream: true</code> and read server-sent events.
              </p>
            </section>

            <section id="auth">
              <h2>Authentication</h2>
              <h3>Sign in with your wallet</h3>
              <p>The web app uses Sign-In with Ethereum (EIP-4361). No email or password.</p>
              <ol>
                <li>
                  <code className="inline">GET /api/auth/nonce</code> returns a random nonce, valid for 5 minutes.
                </li>
                <li>Your wallet signs a message with the domain, chain ID, nonce and time.</li>
                <li>
                  <code className="inline">POST /api/auth/verify</code> checks the signature and sets a 7-day session cookie.
                </li>
              </ol>
              <h3>API keys</h3>
              <ul>
                <li>
                  Keys look like <code className="inline">tyr_live_</code> followed by 64 hex characters.
                </li>
                <li>A key is shown once when you create it. Tyrian stores only a SHA-256 hash.</li>
                <li>Rotating creates a new key and revokes the old one. Revoking takes effect at once.</li>
              </ul>
              <div className="code">
                <div className="code-bar">
                  <span>Header</span>
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => copyText("Authorization: Bearer tyr_live_xxx")}
                  >
                    Copy
                  </button>
                </div>
                <pre>Authorization: Bearer tyr_live_xxx</pre>
              </div>
            </section>

            <section id="quota">
              <h2>Quota</h2>
              <p>
                Each asset class has its own pool and budget, so stakers of one asset don&apos;t subsidize another. Your quota is your share of each pool:
              </p>
              <div className="code">
                <div className="code-bar">
                  <span>Formula</span>
                </div>
                <pre>{`quota_i = Σ_a  B_a × w_i,a ÷ Σ_j w_j,a   +   B_TYR × t_i ÷ Σ_j t_j

w_i,a  = USD value of your stake in asset a × boost_i
boost_i = 1 + 0.5 × min(1, $TYR value staked ÷ base asset value)   (max 1.5×)
t_i    = $TYR you have staked`}</pre>
              </div>
              <ul>
                <li>
                  <strong>USDG pool:</strong> B = yield harvested yesterday × 0.9. The other 10% goes to reserve.
                </li>
                <li>
                  <strong>Stock pool:</strong> 40% of the daily budget, funded by $TYR fees.
                </li>
                <li>
                  <strong>$TYR pool:</strong> the other 60% of the daily budget.
                </li>
                <li>Prices come from Chainlink for Stock Tokens and a 30-minute TWAP for $TYR.</li>
              </ul>
              <div className="callout">
                <strong>Example.</strong> The USDG pool harvested $300 yesterday, so B = $270. You stake 1,000 USDG of a 100,000 USDG pool with no $TYR. Your quota from this pool is $270 × 1% = <strong>$2.70 per day</strong>.
              </div>
              <p>
                Before a request goes out, the gateway estimates its maximum cost as model price × (input tokens + <code className="inline">max_tokens</code>). If that&apos;s more than you have left, it returns <code className="inline">402</code>. After the response, the actual cost from <code className="inline">usage</code> is deducted.
              </p>
            </section>

            <section id="endpoints">
              <h2>Endpoints</h2>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Path</th>
                      <th>What it does</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="mono">POST</td>
                      <td className="mono">/v1/chat/completions</td>
                      <td>
                        OpenAI-compatible chat. Supports <code className="inline">stream: true</code>.
                      </td>
                    </tr>
                    <tr>
                      <td className="mono">GET</td>
                      <td className="mono">/v1/models</td>
                      <td>Models on the allowlist, with prices.</td>
                    </tr>
                    <tr>
                      <td className="mono">GET</td>
                      <td className="mono">/v1/quota</td>
                      <td>Today&apos;s quota, used, left and reset time.</td>
                    </tr>
                    <tr>
                      <td className="mono">GET</td>
                      <td className="mono">/v1/usage?from=&amp;to=</td>
                      <td>Daily usage history.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <h3>Example: check your quota</h3>
              <div className="code">
                <div className="code-bar">
                  <span>GET /v1/quota</span>
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() =>
                      copyText(
                        'curl https://api.tyrian.example/v1/quota \\\n  -H "Authorization: Bearer tyr_live_xxx"'
                      )
                    }
                  >
                    Copy
                  </button>
                </div>
                <pre id="quotaEx">
                  {highlightCode(
                    'curl https://api.tyrian.example/v1/quota \\\n  -H "Authorization: Bearer tyr_live_xxx"'
                  )}
                </pre>
              </div>
              <p>
                The response includes today&apos;s quota, the amount used, the amount left and the next reset time in UTC. Field names will be published with the live API.
              </p>
            </section>

            <section id="errors">
              <h2>Errors and limits</h2>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>When</th>
                      <th>What to do</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="mono">401</td>
                      <td>Missing, wrong or revoked key</td>
                      <td>Check the header or create a new key.</td>
                    </tr>
                    <tr>
                      <td className="mono">402</td>
                      <td>
                        <code className="inline">quota_exceeded</code>: the request could cost more than you have left
                      </td>
                      <td>
                        Lower <code className="inline">max_tokens</code>, pick a cheaper model, or wait for 00:00 UTC.
                      </td>
                    </tr>
                    <tr>
                      <td className="mono">429</td>
                      <td>More than about 60 requests a minute on one key, or the wallet limit</td>
                      <td>Back off and retry.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <h3>Privacy</h3>
              <p>
                The gateway does not store prompt or response content. It logs only the model, token counts, cost and latency. Requests are routed only to providers that don&apos;t train on your data.
              </p>
              <h3>Acceptable use</h3>
              <p>Keys that break the Acceptable Use Policy or provider rules are revoked.</p>
            </section>

            <section id="staking">
              <h2>Staking rules</h2>
              <ul>
                <li>Stakes count from the next epoch (00:00 UTC). This stops flash-staking.</li>
                <li>
                  <code className="inline">requestUnstake</code> stops quota at once. Withdraw after a 7-day cooldown.
                </li>
                <li>Withdraw always returns the same token you staked.</li>
                <li>No admin function can move user assets. Parameter changes go through a 48-hour timelock.</li>
                <li>There is no minimum stake.</li>
                <li>Stock Tokens are not available in the US, UK, Canada, Switzerland or UAE.</li>
              </ul>
            </section>

            <section id="network">
              <h2>Network</h2>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    <tr>
                      <td>Testnet chain ID</td>
                      <td className="mono">46630</td>
                    </tr>
                    <tr>
                      <td>Testnet RPC</td>
                      <td className="mono" style={{ overflowWrap: "anywhere" }}>
                        https://rpc.testnet.chain.robinhood.com/rpc
                      </td>
                    </tr>
                    <tr>
                      <td>Testnet explorer</td>
                      <td className="mono" style={{ overflowWrap: "anywhere" }}>
                        explorer.testnet.chain.robinhood.com
                      </td>
                    </tr>
                    <tr>
                      <td>Testnet faucet</td>
                      <td className="mono" style={{ overflowWrap: "anywhere" }}>
                        faucet.testnet.chain.robinhood.com
                      </td>
                    </tr>
                    <tr>
                      <td>Mainnet chain ID</td>
                      <td className="mono">4663</td>
                    </tr>
                    <tr>
                      <td>Mainnet explorer</td>
                      <td className="mono" style={{ overflowWrap: "anywhere" }}>
                        robinhoodchain.blockscout.com
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                Contract addresses will be listed here and on the{" "}
                <Link href="/treasury" style={{ textDecoration: "underline" }}>
                  Treasury page
                </Link>{" "}
                after deployment.
              </p>
            </section>
          </article>
        </div>
      </div>
    </main>
  );
}
