"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { useTyrianSession } from "@/providers/TyrianSessionProvider";
import { useWalletOnboarding } from "@/hooks/useWalletOnboarding";
import { TARGET_CHAIN, TARGET_CHAIN_ID } from "@/lib/wallet/targetChain";

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { ready: Promise<void> };
};

export function Navbar() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [acctMenuOpen, setAcctMenuOpen] = useState(false);
  const { address } = useAccount();
  const { openWalletOnboarding } = useWalletOnboarding();
  const acctMenuRef = useRef<HTMLDivElement>(null);
  const {
    authenticated,
    loading: sessionLoading,
    error: sessionError,
    signOut,
  } = useTyrianSession();

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 30);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();

    // The inline head script applies the stored theme before hydration.
    try {
      const stored = localStorage.getItem("tyr-theme");
      if (stored === "light" || stored === "dark") {
        setTheme(stored);
        document.documentElement.dataset.theme = stored;
      }
    } catch {}

    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const mmenu = document.getElementById("mmenu");
    const menuBtn = document.getElementById("menuBtn");
    if (!mmenu) return;

    if (mobileOpen) {
      if (menuBtn) {
        const rect = menuBtn.getBoundingClientRect();
        mmenu.style.setProperty("--cx", `${rect.left + rect.width / 2}px`);
        mmenu.style.setProperty("--cy", `${rect.top + rect.height / 2}px`);
      }
      window.__lenis?.stop();
      document.documentElement.style.overflow = "hidden";
    } else {
      window.__lenis?.start();
      document.documentElement.style.overflow = "";
    }
  }, [mobileOpen]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileOpen(false);
      setAcctMenuOpen(false);
    };
    const handleResize = () => {
      if (window.innerWidth > 1100) {
        setMobileOpen(false);
        setAcctMenuOpen(false);
      }
    };

    window.addEventListener("keydown", handleKey);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("resize", handleResize);
      window.__lenis?.start();
      document.documentElement.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    setMobileOpen(false);
    setAcctMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    setAcctMenuOpen(false);
  }, [address]);

  useEffect(() => {
    if (!acctMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (acctMenuRef.current?.contains(target)) return;
      if (document.getElementById("walletBtn")?.contains(target)) return;
      setAcctMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    const focusFrame = requestAnimationFrame(() => {
      acctMenuRef.current?.querySelector<HTMLElement>("button, a")?.focus();
    });

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      cancelAnimationFrame(focusFrame);
    };
  }, [acctMenuOpen]);

  const toggleTheme = (event?: ReactMouseEvent<HTMLButtonElement>) => {
    const next = theme === "dark" ? "light" : "dark";

    const apply = () => {
      setTheme(next);
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("tyr-theme", next);
      } catch {}
      window.dispatchEvent(new Event("themechange"));
    };

    const doc = document as ViewTransitionDocument;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!doc.startViewTransition || reduceMotion) {
      apply();
      return;
    }

    const x = event?.clientX || window.innerWidth / 2;
    const y = event?.clientY || 40;
    const radius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );

    const transition = doc.startViewTransition(apply);
    transition.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`],
          },
          {
            duration: 700,
            easing: "cubic-bezier(.16,1,.3,1)",
            pseudoElement: "::view-transition-new(root)",
          } as KeyframeAnimationOptions
        );
      })
      .catch(() => {});
  };

  const links = [
    { href: "/stake", label: "Stake" },
    { href: "/dashboard", label: "Dashboard" },
    { href: "/playground", label: "Playground" },
    { href: "/models", label: "Models" },
    { href: "/treasury", label: "Treasury" },
    { href: "/docs", label: "Docs" },
  ];

  return (
    <>
      <nav className={`nav ${scrolled ? "scrolled" : ""}`} id="nav" aria-label="Main">
        <div className="wrap">
          <Link href="/" className="wordmark" aria-label="Tyrian home">
            <Image
              src="/logo.png"
              alt="Tyrian logo"
              width={32}
              height={32}
              className="mark"
              priority
            />
            TYRIAN
          </Link>

          <div className="nav-links">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={pathname === link.href ? "page" : undefined}
              >
                {link.label}
              </Link>
            ))}
          </div>

          <div className="nav-right">
            <a
              className="icon-btn nav-x"
              href="https://x.com/TYRIAN_HANDLE"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Tyrian on X"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.2-8.3L1.9 3h6.4l4.4 5.8L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z"
                />
              </svg>
            </a>

            <button
              className="icon-btn nav-theme theme-toggle"
              type="button"
              aria-label="Toggle light/dark theme"
              onClick={toggleTheme}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <circle cx="12" cy="12" r="5" />
                <path d="M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
              </svg>
            </button>

            {/* Custom RainbowKit Button preserving 100% of tyrian-site button classes */}
            <ConnectButton.Custom>
              {({ account, chain, mounted }) => {
                const ready = mounted;
                const connected = ready && account && chain;

                if (!connected) {
                  return (
                    <button
                      className="btn btn-primary"
                      id="walletBtn"
                      type="button"
                      aria-haspopup="dialog"
                      onClick={openWalletOnboarding}
                    >
                      <span className="lbl-long">Connect wallet</span>
                      <span className="lbl-short">Connect</span>
                    </button>
                  );
                }

                if (chain.unsupported || chain.id !== TARGET_CHAIN_ID) {
                  return (
                    <button
                      className="btn btn-warn"
                      id="walletBtn"
                      type="button"
                      aria-haspopup="dialog"
                      onClick={openWalletOnboarding}
                    >
                      Wrong network
                    </button>
                  );
                }

                return (
                  <button
                    className="btn btn-secondary"
                    id="walletBtn"
                    type="button"
                    onClick={() => {
                      if (!authenticated) {
                        openWalletOnboarding();
                        return;
                      }
                      setAcctMenuOpen((current) => !current);
                    }}
                    title={authenticated ? "Wallet signed in" : "Sign in required to manage keys"}
                    aria-haspopup={authenticated ? "menu" : "dialog"}
                    aria-expanded={authenticated ? acctMenuOpen : undefined}
                    aria-controls={authenticated ? "acctMenu" : undefined}
                  >
                    {authenticated ? <i className="live" aria-hidden="true" /> : null}
                    <span className="mono">{account.displayName}</span>
                  </button>
                );
              }}
            </ConnectButton.Custom>

            <button
              className="icon-btn menu-btn"
              id="menuBtn"
              type="button"
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileOpen}
              aria-controls="mmenu"
              onClick={() => {
                setMobileOpen((open) => !open);
                setAcctMenuOpen(false);
              }}
            >
              <span>
                <i />
                <i />
              </span>
            </button>
          </div>
        </div>
      </nav>

      {/* Account Menu Popup when connected */}
      <ConnectButton.Custom>
        {({ account }) => {
          if (!account || !acctMenuOpen) return null;
          return (
            <div
              className="acct-menu"
              id="acctMenu"
              ref={acctMenuRef}
              role="menu"
              aria-label="Wallet account"
              style={{ right: "clamp(16px, 4vw, 48px)", top: "72px" }}
            >
              <div className="who" id="acctWho">
                {account.address}
                <span className={authenticated ? "acct-status is-on" : "acct-status"}>
                  {sessionLoading
                    ? "Checking session…"
                    : authenticated
                      ? "Signed in"
                      : "Not signed in"}
                </span>
              </div>
              {!authenticated ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={sessionLoading}
                  onClick={() => {
                    setAcctMenuOpen(false);
                    openWalletOnboarding();
                  }}
                >
                  Continue sign-in
                </button>
              ) : null}
              {sessionError ? (
                <p className="acct-error" role="alert">
                  {sessionError}
                </p>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void navigator.clipboard.writeText(account.address);
                  setAcctMenuOpen(false);
                }}
              >
                Copy address
              </button>
              <a
                id="acctExplorer"
                role="menuitem"
                href={`${TARGET_CHAIN.blockExplorers?.default.url ?? "https://explorer.testnet.chain.robinhood.com"}/address/${account.address}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setAcctMenuOpen(false)}
              >
                View on explorer
              </a>
              <button
                type="button"
                role="menuitem"
                id="acctDisconnect"
                className="danger"
                onClick={() => {
                  setAcctMenuOpen(false);
                  void signOut();
                }}
              >
                Disconnect
              </button>
            </div>
          );
        }}
      </ConnectButton.Custom>

      {/* Mobile Drawer */}
      <div className={`mmenu ${mobileOpen ? "open" : ""}`} id="mmenu" aria-label="Menu">
        <nav aria-label="Mobile">
          <Link href="/" onClick={() => setMobileOpen(false)}>
            Home
          </Link>
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={pathname === link.href ? "page" : undefined}
              onClick={() => setMobileOpen(false)}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="mmenu-foot">
          <a
            className="btn btn-secondary btn-lg"
            href="https://x.com/TYRIAN_HANDLE"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.2-8.3L1.9 3h6.4l4.4 5.8L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z"
              />
            </svg>
            <span>Follow Tyrian on X</span>
          </a>
          <button className="btn btn-secondary btn-lg theme-toggle" type="button" onClick={toggleTheme}>
            Switch theme
          </button>
        </div>
      </div>
    </>
  );
}
