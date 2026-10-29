"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useAccount } from "wagmi";
import { MurexCanvas } from "@/components/hero/MurexCanvas";
import { HeroWaveBackground } from "@/components/hero/HeroWaveBackground";
import { Odometer } from "@/components/ui/Odometer";
import { CaBadge } from "@/components/ui/CaBadge";
import { TokenLogo } from "@/components/ui/TokenLogo";
import { useTyrianSession } from "@/providers/TyrianSessionProvider";
import { useWalletOnboarding } from "@/hooks/useWalletOnboarding";
import { TARGET_CHAIN_ID } from "@/lib/wallet/targetChain";
import { activeNetwork } from "@shared/contracts/addresses";

type DataMode = "loading" | "live" | "unavailable" | "preview";

function shortenAddress(address: string | null | undefined): string {
  if (!address) return "not configured";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const STOCK_ASSETS = ["AAPL", "NVDA", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "AMD"].map(
  (ticker) => ({
    tk: ticker,
    co: activeNetwork.stocks[ticker]?.name ?? ticker,
    a: shortenAddress(activeNetwork.stocks[ticker]?.address),
    b: shortenAddress(activeNetwork.stocks[ticker]?.feed),
    kind: "",
  }),
);

const ASSETS_LIST = [
  { tk: "USDG", co: "Stablecoin · base quota", a: "Morpho vault", b: "yield → own pool", kind: "base" },
  { tk: "$TYR", co: "Boost token · fee pool", a: "Uniswap V3 TWAP 30m", b: "boost ≤ 1.5×", kind: "boost" },
  ...STOCK_ASSETS,
];

export default function HomePage() {
  // Quota Calculator State
  const [harvestYield, setHarvestYield] = useState<number>(300);
  const [userStake, setUserStake] = useState<number>(1000);
  const [totalStake, setTotalStake] = useState<number>(99000);
  const [tyrStake, setTyrStake] = useState<number>(0);
  const [copiedKey, setCopiedKey] = useState<boolean>(false);
  const { isConnected } = useAccount();
  const { authenticated } = useTyrianSession();
  const { openWalletOnboarding } = useWalletOnboarding();

  // Live Protocol Figures
  const [statsMode, setStatsMode] = useState<DataMode>("loading");
  const [liveStats, setLiveStats] = useState<{
    tvlUsd: number | null;
    quotaDistributedToday: number | null;
    tyrBurned: number | null;
  }>({
    tvlUsd: null,
    quotaDistributedToday: null,
    tyrBurned: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/treasury/summary")
      .then((res) => {
        if (!res.ok) throw new Error(`treasury summary ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;

        const tvl = Number(data?.treasuryBalanceUsd);
        const burned = Number(data?.totalTyrBurned);
        const quota = data?.quotaDistributedTodayUsd;

        if (!Number.isFinite(tvl)) {
          setStatsMode("unavailable");
          return;
        }

        setLiveStats({
          tvlUsd: tvl,
          quotaDistributedToday:
            typeof quota === "number" && Number.isFinite(quota) ? quota : null,
          tyrBurned: Number.isFinite(burned) ? burned : null,
        });
        setStatsMode("live");
      })
      .catch(() => {
        if (!cancelled) setStatsMode("unavailable");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const openWallet = () => {
    if (!isConnected || !authenticated) {
      openWalletOnboarding();
      return;
    }
    window.location.assign("/dashboard");
  };

  // Quota Math per Developer Brief
  const boost = userStake > 0 ? 1 + 0.5 * Math.min(1, tyrStake / userStake) : 1;
  const userWeight = userStake * boost;
  const totalWeight = userWeight + totalStake;
  const dailyBudget = harvestYield * 0.9;
  const dailyQuota = totalWeight > 0 ? (dailyBudget * (userWeight / totalWeight)).toFixed(2) : "0.00";
  const poolShare = totalWeight > 0 ? ((userWeight / totalWeight) * 100).toFixed(2) : "0.00";

  // Live figures are only shown when the API returned a real value. A missing
  // epoch or a failed request renders "-", never a preview number.
  const statValue = (value: number | null, format: (n: number) => string): string => {
    if (statsMode === "live" && value !== null) return format(value);
    if (statsMode === "loading") return "…";
    return "-";
  };

  // Ring offset calculation (circumference: 540.35, visual scale from the template)
  const ringShare = Math.max(0, Math.min(1, Number(poolShare) / 100));
  const ringOffset = 540.35 * (1 - Math.min(1, Math.sqrt(ringShare) * 2.2));

  const handleCopyKey = () => {
    navigator.clipboard.writeText("tyr_live_••••••••a9f2");
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 1400);
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    gsap.registerPlugin(ScrollTrigger);

    const RM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fine = window.matchMedia("(hover:hover) and (pointer:fine)").matches;

    // Helper: Split text into characters for mask stagger animation
    function splitChars(el: HTMLElement) {
      // StrictMode runs effects twice in development. Splitting an already
      // split heading would wrap the split lines again and drop the .gold
      // class from the last word.
      if (el.dataset.split === "true") return;
      el.dataset.split = "true";
      const lines = el.innerHTML.split(/<br\s*\/?>/i);
      el.setAttribute("aria-label", el.textContent || "");
      el.innerHTML = lines
        .map((line) => {
          const tmp = document.createElement("div");
          tmp.innerHTML = line;
          let out = "";
          tmp.childNodes.forEach((n) => {
            const text = n.textContent || "";
            const cls = n.nodeType === 1 ? (n as HTMLElement).className : "";
            const chars = text
              .split(/(\s+)/)
              .map((w) =>
                /^\s+$/.test(w)
                  ? " "
                  : w
                  ? `<span style="display:inline-block;white-space:nowrap">${[...w]
                      .map((c) => `<span class="split-char">${c}</span>`)
                      .join("")}</span>`
                  : ""
              )
              .join("");
            out += cls ? `<span class="${cls}">${chars}</span>` : chars;
          });
          return `<span class="split-line" aria-hidden="true">${out}</span>`;
        })
        .join("");
    }

    function splitWords(el: HTMLElement) {
      if (el.dataset.split === "true") return;
      el.dataset.split = "true";
      el.setAttribute("aria-label", el.textContent || "");
      el.innerHTML = (el.textContent || "")
        .split(" ")
        .map(
          (w) =>
            `<span class="split-line" style="display:inline-block" aria-hidden="true"><span class="split-char">${w}</span></span>`
        )
        .join(" ");
    }

    document.querySelectorAll<HTMLElement>(".hero h1.split").forEach(splitChars);
    document.querySelectorAll<HTMLElement>(".cta h2.split").forEach(splitChars);
    document.querySelectorAll<HTMLElement>(".split-words").forEach(splitWords);

    if (RM) return;

    let tickerFn: (() => void) | null = null;

    const ctx = gsap.context(() => {
      // 1. Hero text mask intro
      const heroChars = document.querySelectorAll(".hero h1 .split-char");
      gsap.set(heroChars, { yPercent: 115 });
      gsap.set(".hero .reveal, .hero .eyebrow", { y: 24, opacity: 0 });
      const intro = gsap.timeline({ delay: 0.25 });
      intro
        .to(heroChars, { yPercent: 0, duration: 0.9, ease: "power3.out", stagger: 0.03 })
        .to(".hero .eyebrow", { y: 0, opacity: 1, duration: 0.7, ease: "power3.out" }, 0)
        .to(".hero .reveal", { y: 0, opacity: 1, duration: 0.8, ease: "expo.out", stagger: 0.08 }, "-=.5");

      // 2. Hero Z-depth parallax & 3D shell fading
      document.querySelectorAll<HTMLElement>("[data-depth]").forEach((el) => {
        gsap.to(el, {
          yPercent: parseFloat(el.dataset.depth || "0") * -60,
          ease: "none",
          scrollTrigger: { trigger: "#hero", start: "top top", end: "bottom top", scrub: true },
        });
      });

      // Crucial: 3D Canvas Scroll Parallax & Opacity Fade
      gsap.to("#gl", {
        yPercent: 18,
        opacity: 0.25,
        ease: "none",
        scrollTrigger: { trigger: "#hero", start: "top top", end: "bottom top", scrub: true },
      });

      ScrollTrigger.create({
        trigger: "#hero",
        start: "top top",
        end: "bottom top",
        onUpdate: (s) => {
          if (window.__tyr) window.__tyr.scroll = s.progress;
        },
      });

      // 3. Section heads reveal
      document.querySelectorAll<HTMLElement>(".split-words, .cta .split").forEach((h) => {
        gsap.from(h.querySelectorAll(".split-char"), {
          yPercent: 115,
          duration: 0.8,
          ease: "power3.out",
          stagger: 0.04,
          scrollTrigger: { trigger: h, start: "top 85%" },
        });
      });

      gsap.utils.toArray<HTMLElement>(".sec-head p, .flow-step, .legend > div, .phase, .p-grid .tilt, .dev ul li").forEach((el) => {
        gsap.from(el, {
          y: 28,
          opacity: 0,
          duration: 0.7,
          ease: "power3.out",
          scrollTrigger: { trigger: el, start: "top 90%" },
        });
      });

      // 4. Sticky Cards Stack: scrub the previous card down and dim it as
      // the next card slides over it (same values as tyrian-site).
      const cards = gsap.utils.toArray<HTMLElement>(".stack-card");
      cards.forEach((card, i) => {
        if (i === cards.length - 1) return;
        gsap.fromTo(
          card,
          { scale: 1, filter: "brightness(1)" },
          {
            scale: 0.92 + i * 0.02,
            filter: "brightness(.55)",
            ease: "none",
            scrollTrigger: {
              trigger: cards[i + 1],
              start: "top bottom",
              end: "top 14%",
              scrub: true,
            },
          }
        );
      });

      gsap.to(".vis .float", { y: -14, duration: 1.6, ease: "sine.inOut", yoyo: true, repeat: -1 });
      gsap.to(".vis .blink", { opacity: 0, duration: 0.5, ease: "steps(1)", yoyo: true, repeat: -1 });

      // 5. Pinned Horizontal Gallery for Assets
      const mm = gsap.matchMedia();
      mm.add("(min-width: 0px)", () => {
        const track = document.getElementById("track");
        if (!track) return;
        const dist = () => Math.max(0, track.scrollWidth - window.innerWidth + 40);
        gsap.to(track, {
          x: () => -dist(),
          ease: "none",
          scrollTrigger: {
            trigger: "#assets",
            start: "top top",
            end: () => "+=" + dist(),
            pin: ".assets-pin",
            scrub: 1,
            invalidateOnRefresh: true,
            onUpdate: (s) => {
              const el = document.getElementById("hprog");
              if (el) gsap.set(el, { scaleX: s.progress });
            },
            onToggle: (s) => document.querySelector(".cursor")?.classList.toggle("is-label", s.isActive && fine),
          },
        });
      });

      // 6. Treasury Split Bar
      const splitbar = document.getElementById("splitbar");
      if (splitbar) {
        gsap.from(splitbar.children, {
          scaleX: 0,
          duration: 1,
          ease: "expo.out",
          stagger: 0.12,
          scrollTrigger: { trigger: splitbar, start: "top 85%" },
        });
      }

      // 7. Marquee + scroll-velocity skew
      const mq = document.getElementById("marquee");
      if (mq) {
        const mqTween = gsap.to(mq, { xPercent: -50, duration: 28, ease: "none", repeat: -1 });
        const skewEls = document.querySelectorAll(".skew");
        const skewTo = gsap.quickTo(skewEls, "skewX", { duration: 0.5, ease: "power3.out" });
        const mqSkew = gsap.quickTo(mq, "skewX", { duration: 0.5, ease: "power3.out" });
        tickerFn = () => {
          const velocity = window.__tyr?.velocity || 0;
          const v = gsap.utils.clamp(-8, 8, velocity * -0.35);
          skewTo(v);
          mqSkew(v * 0.6);
          mqTween.timeScale(1 + Math.min(4, Math.abs(velocity) * 0.15));
          if (window.__tyr) window.__tyr.velocity *= 0.9;
        };
        gsap.ticker.add(tickerFn);
      }

      // 8. Magnetic buttons: the outer button and its label move at
      // different depths, exactly like the template.
      if (fine) {
        document.querySelectorAll<HTMLElement>(".magnetic").forEach((el) => {
          const xTo = gsap.quickTo(el, "x", { duration: 0.4, ease: "power3.out" });
          const yTo = gsap.quickTo(el, "y", { duration: 0.4, ease: "power3.out" });
          const inner = el.querySelector<HTMLElement>("span");
          const ixTo = inner ? gsap.quickTo(inner, "x", { duration: 0.4, ease: "power3.out" }) : null;
          const iyTo = inner ? gsap.quickTo(inner, "y", { duration: 0.4, ease: "power3.out" }) : null;

          el.addEventListener("mousemove", (e) => {
            const r = el.getBoundingClientRect();
            const mx = e.clientX - (r.left + r.width / 2);
            const my = e.clientY - (r.top + r.height / 2);
            xTo(mx * 0.35);
            yTo(my * 0.45);
            ixTo?.(mx * 0.15);
            iyTo?.(my * 0.2);
          });
          el.addEventListener("mouseleave", () => {
            gsap.to(el, { x: 0, y: 0, duration: 0.8, ease: "elastic.out(1,.35)" });
            if (inner) gsap.to(inner, { x: 0, y: 0, duration: 0.8, ease: "elastic.out(1,.35)" });
          });
        });
      }
    });

    return () => {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      ctx.revert();
    };
  }, []);

  return (
    <main id="top" className="page-home">
      {/* ================= HERO ================= */}
      <section className="hero" id="hero">
        <HeroWaveBackground />
        <div className="hero-layer layer-far" data-depth="0.45" aria-hidden="true">
          <svg viewBox="-100 -100 200 200" style={{ color: "var(--tyr-400)" }}>
            <use href="#murex" />
          </svg>
        </div>
        <MurexCanvas />
        <div className="hero-content" data-depth="-0.15">
          <div className="wrap">
            <div className="eyebrow" style={{ marginBottom: "26px" }}>
              AI gateway · Robinhood Chain
            </div>
            <h1 className="split" aria-label="Once only for emperors.">
              Once only<br />
              for <span className="gold">emperors.</span>
            </h1>
            <p className="lead reveal">
              Stake assets, use every AI model. You never buy credits. Yield from your stake and $TYR creator fees pay for
              inference.
            </p>
            <div className="hero-ctas reveal">
              <Link href="/stake" className="btn btn-primary btn-lg magnetic" data-cursor="link">
                <span>
                  Claim your purple
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </span>
              </Link>
              <Link href="/docs" className="btn btn-secondary btn-lg magnetic" data-cursor="link">
                <span>Read the docs</span>
              </Link>
            </div>
            <div className="hero-ca-wrap reveal">
              <CaBadge variant="hero" status="live" />
            </div>
            <div className="hero-meta reveal">
              <span>
                CHAIN <b>{TARGET_CHAIN_ID}</b>
              </span>
              <span>
                EPOCH <b>00:00 UTC</b>
              </span>
              <span>
                COOLDOWN <b>7 DAYS</b>
              </span>
              <span>
                BOOST <b>≤ 1.5×</b>
              </span>
            </div>
          </div>
        </div>
        <div className="scroll-hint" aria-hidden="true">
          SCROLL<i />
        </div>
      </section>

      {/* ================= MARQUEE ================= */}
      <div className="marquee" aria-hidden="true">
        <div className="marquee-track" id="marquee">
          <span>openai</span>
          <span className="dot">✦</span>
          <span><em>anthropic</em></span>
          <span className="dot">✦</span>
          <span>google</span>
          <span className="dot">✦</span>
          <span><em>meta-llama</em></span>
          <span className="dot">✦</span>
          <span>qwen</span>
          <span className="dot">✦</span>
          <span><em>deepseek</em></span>
          <span className="dot">✦</span>
          <span>openai</span>
          <span className="dot">✦</span>
          <span><em>anthropic</em></span>
          <span className="dot">✦</span>
          <span>google</span>
          <span className="dot">✦</span>
          <span><em>meta-llama</em></span>
          <span className="dot">✦</span>
          <span>qwen</span>
          <span className="dot">✦</span>
          <span><em>deepseek</em></span>
          <span className="dot">✦</span>
        </div>
      </div>

      {/* ================= QUOTA CALCULATOR ================= */}
      <section className="quota" id="quota">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">Quota · preview calculator</div>
              <h2 className="split-words" style={{ marginTop: "16px" }}>
                Pro-rata, not unlimited.
              </h2>
            </div>
            <p>
              Each asset class has its own budget pool, funded by its own yield. Splitting into many wallets adds nothing.
              Weight is weight. This panel is a preview calculator, not live protocol data.
            </p>
          </div>
          <div className="quota-grid">
            <div className="panel">
              <div className="field">
                <label htmlFor="yield">USDG pool harvested yesterday</label>
                <div className="inp">
                  <input
                    id="yield"
                    type="number"
                    value={harvestYield}
                    min="0"
                    inputMode="decimal"
                    onChange={(e) => setHarvestYield(Number(e.target.value) || 0)}
                  />
                  <span>USD</span>
                </div>
              </div>

              <div className="field">
                <label htmlFor="mine">Your USDG stake</label>
                <div className="inp">
                  <input
                    id="mine"
                    type="number"
                    value={userStake}
                    min="0"
                    inputMode="decimal"
                    onChange={(e) => setUserStake(Number(e.target.value) || 0)}
                  />
                  <span>USDG</span>
                  <button className="max" id="maxbtn" type="button" onClick={() => setUserStake(10000)}>
                    MAX
                  </button>
                </div>
              </div>

              <div className="field">
                <label htmlFor="total">Total USDG staked (others)</label>
                <div className="inp">
                  <input
                    id="total"
                    type="number"
                    value={totalStake}
                    min="0"
                    inputMode="decimal"
                    onChange={(e) => setTotalStake(Number(e.target.value) || 0)}
                  />
                  <span>USDG</span>
                </div>
              </div>

              <div className="field">
                <label htmlFor="tyr">
                  $TYR staked, USD value <output id="tyrOut">${tyrStake}</output>
                </label>
                <input
                  id="tyr"
                  type="range"
                  min="0"
                  max="1500"
                  step="10"
                  value={tyrStake}
                  onChange={(e) => setTyrStake(Number(e.target.value) || 0)}
                />
              </div>

              <div className="formula">
                B = yield × <b>0.9</b> (10% → reserve)<br />
                boost = 1 + 0.5 × min(1, TYR ÷ base) &nbsp;<span className="muted">≤ 1.5×</span><br />
                quota = B × <b>w<sub>i</sub></b> ÷ Σ<b>w</b>
              </div>
            </div>

            <div className="panel meter-wrap">
              <div className="meter">
                <svg viewBox="0 0 200 200">
                  <circle cx="100" cy="100" r="86" fill="none" stroke="var(--border)" strokeWidth="10" />
                  <circle
                    id="ring"
                    data-ring-animate
                    data-ring-target={ringOffset}
                    cx="100"
                    cy="100"
                    r="86"
                    fill="none"
                    stroke="var(--gold-500)"
                    strokeWidth="10"
                    strokeLinecap="round"
                    strokeDasharray="540.35"
                    style={{
                      strokeDashoffset: ringOffset,
                      transition: "stroke-dashoffset 0.6s cubic-bezier(0.2, 0.8, 0.2, 1)",
                    }}
                  />
                </svg>
                <div className="center">
                  <span className="sub">YOUR DAILY QUOTA</span>
                  <span className="big" id="qv">
                    ${dailyQuota}
                  </span>
                  <span className="sub" id="share">
                    {poolShare}% of pool
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
                <span className="boost-badge" id="boostB">
                  boost {boost.toFixed(2)}×
                </span>
                <span className="chip chip-warn">reset 00:00 UTC</span>
              </div>
              <p className="muted" style={{ fontSize: "13px", maxWidth: "36ch" }}>
                Estimate for the USDG pool only. Your real quota is set by the daily epoch job.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ================= HOW IT WORKS (Sticky Stack) ================= */}
      <section className="how" id="how">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">How it works</div>
              <h2 className="split-words" style={{ marginTop: "16px" }}>
                Three steps from stake to model.
              </h2>
            </div>
            <p>
              Money moves on-chain. Quota moves off-chain. The two meet at only two points: the indexer reading contract
              events, and the treasury topping up inference balance.
            </p>
          </div>
          <div className="stack">
            {/* Card 1 */}
            <article className="stack-card">
              <div className="txt">
                <div className="num">I</div>
                <div>
                  <h3>Stake your assets</h3>
                  <p>
                    Stake USDG or Stock Tokens for base quota, and $TYR to boost it up to 1.5×. Stakes count from the next
                    epoch; unstake any time with a 7-day cooldown.
                  </p>
                </div>
                <div className="chips">
                  <span className="chip">USDG</span>
                  <span className="chip">AAPL · NVDA · MSFT +5</span>
                  <span className="chip">$TYR boost</span>
                </div>
              </div>
              <div className="vis">
                <svg viewBox="0 0 300 300" fill="none">
                  <g stroke="var(--gold-500)" strokeWidth="1.2">
                    <ellipse cx="150" cy="210" rx="90" ry="26" />
                    <ellipse cx="150" cy="180" rx="90" ry="26" opacity=".7" />
                    <ellipse cx="150" cy="150" rx="90" ry="26" opacity=".5" />
                    <ellipse cx="150" cy="120" rx="90" ry="26" opacity=".35" />
                  </g>
                  <g stroke="var(--tyr-300)" strokeWidth="1">
                    <path d="M60 210V120M240 210V120" />
                  </g>
                  <circle className="float" cx="150" cy="70" r="14" fill="var(--tyr-500)" stroke="var(--gold-300)" />
                </svg>
              </div>
            </article>

            {/* Card 2 */}
            <article className="stack-card">
              <div className="txt">
                <div className="num">II</div>
                <div>
                  <h3>Yield funds the treasury</h3>
                  <p>
                    Vaults put assets to work and harvest yield to the Treasury. 80% of $TYR creator fees join it. Daily
                    quota never exceeds the treasury&#39;s daily budget, so the system can&#39;t run a deficit.
                  </p>
                </div>
                <div className="chips">
                  <span className="chip">ERC-4626 vaults</span>
                  <span className="chip">Safe 2-of-3</span>
                  <span className="chip">48h timelock</span>
                </div>
              </div>
              <div className="vis">
                <svg viewBox="0 0 300 300" fill="none">
                  <circle cx="150" cy="150" r="96" stroke="var(--border)" strokeWidth="18" />
                  <circle
                    cx="150"
                    cy="150"
                    r="96"
                    stroke="var(--tyr-600)"
                    strokeWidth="18"
                    strokeDasharray="422 603"
                    transform="rotate(-90 150 150)"
                  />
                  <circle
                    cx="150"
                    cy="150"
                    r="96"
                    stroke="var(--tyr-400)"
                    strokeWidth="18"
                    strokeDasharray="121 603"
                    strokeDashoffset="-422"
                    transform="rotate(-90 150 150)"
                  />
                  <circle
                    cx="150"
                    cy="150"
                    r="96"
                    stroke="var(--gold-500)"
                    strokeWidth="18"
                    strokeDasharray="60 603"
                    strokeDashoffset="-543"
                    transform="rotate(-90 150 150)"
                  />
                  <text
                    x="150"
                    y="146"
                    textAnchor="middle"
                    fill="currentColor"
                    fontFamily="JetBrains Mono"
                    fontSize="22"
                  >
                    70·20·10
                  </text>
                  <text
                    x="150"
                    y="172"
                    textAnchor="middle"
                    fill="var(--tyr-300)"
                    fontFamily="JetBrains Mono"
                    fontSize="11"
                  >
                    TREASURY ROUTER
                  </text>
                </svg>
              </div>
            </article>

            {/* Card 3 */}
            <article className="stack-card">
              <div className="txt">
                <div className="num">III</div>
                <div>
                  <h3>Call any model</h3>
                  <p>
                    Sign in with your wallet, mint a <span className="mono">tyr_live_</span> key, and point any OpenAI SDK
                    at Tyrian. Your daily quota is pro-rata to your stake weight. Prompts aren&#39;t stored, only usage metadata.
                  </p>
                </div>
                <div className="chips">
                  <span className="chip">SIWE · EIP-4361</span>
                  <span className="chip">/v1/chat/completions</span>
                  <span className="chip">stream: true</span>
                </div>
              </div>
              <div className="vis">
                <svg viewBox="0 0 300 300" fill="none" fontFamily="JetBrains Mono" fontSize="12">
                  <rect x="40" y="70" width="220" height="160" rx="14" stroke="var(--tyr-400)" />
                  <path d="M40 98h220" stroke="var(--tyr-400)" opacity=".5" />
                  <text x="58" y="130" fill="var(--tyr-300)">
                    POST /v1/chat
                  </text>
                  <text x="58" y="156" fill="var(--gold-500)">
                    → 200 OK · stream
                  </text>
                  <text x="58" y="182" fill="currentColor" opacity=".6">
                    quota −$0.0042
                  </text>
                  <rect className="blink" x="58" y="196" width="8" height="14" fill="var(--gold-500)" />
                </svg>
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* ================= ASSETS (Pinned Horizontal Gallery) ================= */}
      <section className="assets" id="assets">
        <div className="assets-pin">
          <div className="wrap sec-head" style={{ marginBottom: 0 }}>
            <div>
              <div className="eyebrow">Stakeable from day one</div>
              <h2 style={{ marginTop: "16px" }}>Your stake, your oracle.</h2>
            </div>
            <p>
              Eight Stock Tokens, USDG and $TYR. Stock Tokens are priced by Chainlink feeds; withdrawals always return the
              same token you staked.
            </p>
          </div>
          <div className="assets-track" id="track">
            {ASSETS_LIST.map((item) => (
              <div key={item.tk} className="tilt skew">
                <div className={`asset-card ${item.kind}`}>
                  <div className="shine" />
                  <svg
                    className="glyph"
                    viewBox="-100 -100 200 200"
                    style={{ color: item.kind === "boost" ? "var(--gold-500)" : "var(--tyr-300)" }}
                  >
                    <use href="#murex" />
                  </svg>

                  <div className="asset-header">
                    <div className="asset-header-text">
                      <div className="tk">{item.tk}</div>
                      <div className="co">{item.co}</div>
                    </div>
                    <TokenLogo symbol={item.tk} size={50} variant="top-right" />
                  </div>

                  <div className="rows">
                    {item.kind ? (
                      <>
                        <div>{item.a}</div>
                        <div><b>{item.b}</b></div>
                      </>
                    ) : (
                      <>
                        <div>token <b>{item.a}</b></div>
                        <div>feed&nbsp; <b>{item.b}</b></div>
                        <div>stale limit 96h</div>
                      </>
                    )}
                  </div>
                  <span className="chip tag">
                    {item.kind === "base" ? "base pool" : item.kind === "boost" ? "boost pool" : "stock pool"}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="progress-line">
            <i id="hprog" />
          </div>
        </div>
      </section>

      {/* ================= TREASURY ================= */}
      <section className="treasury" id="treasury">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">Treasury · public at /treasury</div>
              <h2 className="split-words" style={{ marginTop: "16px" }}>
                Every dollar, accounted for.
              </h2>
            </div>
            <p>
              Every $TYR trade on pons pays a 1% pool fee. Tyrian&#39;s creator share is split by an on-chain FeeSplitter that
              anyone can call.
            </p>
          </div>
          <div className="flow">
            <div className="flow-step">
              <div className="pct">1%</div>
              <p>Pool fee on every $TYR trade</p>
            </div>
            <div className="flow-step">
              <div className="pct">70%</div>
              <p>Creator share → FeeSplitter (0.7% of volume)</p>
            </div>
            <div className="flow-step">
              <div className="pct">80%</div>
              <p>To the Treasury, funding inference</p>
            </div>
            <div className="flow-step">
              <div className="pct">20%</div>
              <p>Buyback &amp; burn via small TWAP buys</p>
            </div>
          </div>
          <div className="split-bar" id="splitbar">
            <div className="a">70% daily budget</div>
            <div className="b">20% reserve</div>
            <div className="c">10%</div>
          </div>
          <div className="legend">
            <div>
              <h3>
                <i style={{ background: "var(--tyr-600)" }} />
                Daily budget
              </h3>
              <p>Liquid USDG that funds tomorrow&#39;s quota for the $TYR and Stock Token pools.</p>
            </div>
            <div>
              <h3>
                <i style={{ background: "var(--tyr-400)" }} />
                Reserve
              </h3>
              <p>USDG in a Morpho vault. Its yield tops up the budget and cushions volume drops.</p>
            </div>
            <div>
              <h3>
                <i style={{ background: "var(--gold-500)" }} />
                Stock Token portfolio
              </h3>
              <p>Equal-weight basket of 8 tickers, held as protocol cash management. Capped at 20% of treasury.</p>
            </div>
          </div>
          <div className="stats" style={{ padding: "64px 0 0" }}>
            <div className="stats-grid" aria-label="Treasury figures">
              <div className="stat">
                <div className="label">Total value staked</div>
                <Odometer
                  as="div"
                  text={statValue(liveStats.tvlUsd, (v) => `$${Math.round(v).toLocaleString("en-US")}`)}
                  step={1}
                  variant="home"
                />
                <div className="foot">USDG · Stock Tokens · $TYR</div>
              </div>
              <div className="stat">
                <div className="label">Daily quota distributed</div>
                <Odometer
                  as="div"
                  text={statValue(liveStats.quotaDistributedToday, (v) => `$${v.toFixed(2)}`)}
                  step={1}
                  variant="home"
                />
                <div className="foot">resets 00:00 UTC</div>
              </div>
              <div className="stat">
                <div className="label">$TYR burned</div>
                <Odometer
                  as="div"
                  text={statValue(liveStats.tyrBurned, (v) => v.toLocaleString("en-US"))}
                  step={1}
                  variant="home"
                />
                <div className="foot">sent to 0x…dEaD</div>
              </div>
            </div>
            <p className="note">
              {statsMode === "live"
                ? `Live figures from ${activeNetwork.label} contracts and indexer.`
                : statsMode === "loading"
                  ? "Loading live figures from the indexer…"
                  : "Live figures are unavailable right now. No preview values are shown."}
            </p>
          </div>
        </div>
      </section>

      {/* ================= BUILDERS / DEV ================= */}
      <section className="dev" id="docs">
        <div className="wrap dev-grid">
          <div>
            <div className="eyebrow">For builders</div>
            <h2 style={{ marginTop: "16px" }}>
              <span className="scramble" data-text="OpenAI-compatible.">
                OpenAI-compatible.
              </span>
              <br />
              Change one base URL.
            </h2>
            <p className="muted" style={{ marginTop: "18px", maxWidth: "46ch" }}>
              Bring your existing SDK. Tyrian enforces quota at the gateway and rejects over-budget calls with{" "}
              <span className="mono">402 quota_exceeded</span> before they cost anything.
            </p>
            <ul>
              <li>
                <b>POST</b>/v1/chat/completions
              </li>
              <li>
                <b>GET</b>/v1/models
              </li>
              <li>
                <b>GET</b>/v1/quota
              </li>
              <li>
                <b>GET</b>/v1/usage?from=&amp;to=
              </li>
            </ul>
          </div>
          <div>
            <div className="term">
              <div className="term-bar">
                <i />
                <i />
                <i />
                <span>quickstart.sh</span>
              </div>
              <pre>
                <span className="c"># any OpenAI-compatible client works</span>
                {"\n"}
                <span className="k">curl</span> https://api.tyrian.example/v1/chat/completions \{"\n"}
                {"  "}-H <span className="s">&quot;Authorization: Bearer tyr_live_xxx&quot;</span> \{"\n"}
                {"  "}-H <span className="s">&quot;Content-Type: application/json&quot;</span> \{"\n"}
                {"  "}-d{" "}
                <span className="s">
                  &#39;&#123;&quot;model&quot;:&quot;anthropic/claude-sonnet-4.5&quot;,
                  {"\n"}
                  {"       "}&quot;messages&quot;:[&#123;&quot;role&quot;:&quot;user&quot;,&quot;content&quot;:&quot;Ave&quot;&#125;]&#125;&#39;
                </span>
              </pre>
            </div>
            <div className="keybox">
              <code id="keyText">tyr_live_••••••••a9f2</code>
              <button id="copyKey" data-cursor="link" onClick={handleCopyKey}>
                {copiedKey ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ================= PRINCIPLES ================= */}
      <section className="principles">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">Design principles</div>
              <h2 className="split-words" style={{ marginTop: "16px" }}>
                Built to be audited, not trusted.
              </h2>
            </div>
            <p>All money logic lives in contracts. The gateway is the only part you touch when you use AI.</p>
          </div>
          <div className="p-grid">
            <div className="tilt">
              <div className="p-card">
                <div className="shine" />
                <h3>No one else&#39;s keys</h3>
                <p>Provider access runs on Tyrian&#39;s own accounts. You only ever hold a Tyrian key.</p>
              </div>
            </div>
            <div className="tilt">
              <div className="p-card">
                <div className="shine" />
                <h3>Non-custodial</h3>
                <p>Admins have no function that moves user assets. Pause stops deposits, never withdrawals.</p>
              </div>
            </div>
            <div className="tilt">
              <div className="p-card">
                <div className="shine" />
                <h3>Real yield first</h3>
                <p>$TYR boosts. Base quota stands on yield from real assets.</p>
              </div>
            </div>
            <div className="tilt">
              <div className="p-card">
                <div className="shine" />
                <h3>Prompt privacy</h3>
                <p>No prompt or response content is stored. Only model, tokens, cost and latency.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================= ROADMAP ================= */}
      <section className="roadmap">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">Testnet → mainnet</div>
              <h2 className="split-words" style={{ marginTop: "16px" }}>
                ~12 weeks. Audit is the gate.
              </h2>
            </div>
            <p>$TYR launches together with the live product, not before, so fees have a use from the first trade.</p>
          </div>
          <div className="phases">
            <div className="phase">
              <div className="w">PHASE 1</div>
              <h3>Foundation</h3>
              <ul>
                <li>Wallet &amp; geo-gate</li>
                <li>Stake / unstake</li>
                <li>Quota dashboard</li>
                <li>SIWE &amp; API keys</li>
              </ul>
            </div>
            <div className="phase">
              <div className="w">PHASE 2</div>
              <h3>Gateway</h3>
              <ul>
                <li>OpenAI-compatible API</li>
                <li>Model catalog</li>
                <li>Playground</li>
                <li>Docs</li>
              </ul>
            </div>
            <div className="phase">
              <div className="w">PHASE 3</div>
              <h3>Mainnet</h3>
              <ul>
                <li>Treasury page</li>
                <li>External audit closed</li>
                <li>$TYR on pons</li>
              </ul>
              <span className="chip gate">gate · audit</span>
            </div>
            <div className="phase">
              <div className="w">PHASE 4</div>
              <h3>Agents</h3>
              <ul>
                <li>Agent accounts</li>
                <li>Agents stake &amp; spend their own quota</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ================= CTA ================= */}
      <section className="cta">
        <svg className="ornament" viewBox="-100 -100 200 200" style={{ color: "var(--gold-500)" }}>
          <use href="#murex" />
        </svg>
        <div className="wrap" style={{ position: "relative" }}>
          <div className="eyebrow">Emperor tier, open to all</div>
          <h2 className="split" style={{ marginTop: "20px" }} aria-label="Claim your purple.">
            Claim your purple.
          </h2>
          <p>Connect a wallet on Robinhood Chain, stake, and mint your first key.</p>
          <button
            type="button"
            className="btn btn-primary btn-lg magnetic"
            id="connect2"
            data-cursor="link"
            aria-haspopup={isConnected && authenticated ? undefined : "dialog"}
            onClick={openWallet}
          >
            <span>{isConnected && authenticated ? "Open dashboard" : "Connect wallet"}</span>
          </button>
        </div>
      </section>
    </main>
  );
}
