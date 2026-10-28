"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useAccount, useChains } from "wagmi";
import { useWalletOnboarding } from "@/hooks/useWalletOnboarding";
import { useTyrianSession } from "@/providers/TyrianSessionProvider";
import { isPhantomConnector } from "@/lib/wallet/providerChain";

function shortenAddress(address?: string) {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletOnboardingModal() {
  const {
    open,
    step,
    error,
    switching,
    targetChain,
    currentChainId,
    termsEnabled,
    termsAccepted,
    closeWalletOnboarding,
    switchToTargetChain,
    switchWallet,
    acceptTerms,
  } = useWalletOnboarding();
  const { address, isConnected, connector } = useAccount();
  const chains = useChains();
  const phantomWallet = isPhantomConnector(connector);
  const {
    authenticated,
    loading: sessionLoading,
    signingIn,
    error: sessionError,
    signIn,
  } = useTyrianSession();

  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const currentChain = chains.find((chain) => chain.id === currentChainId);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 30);

    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    window.__lenis?.stop();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeWalletOnboarding();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = cardRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.documentElement.style.overflow = previousOverflow;
      window.__lenis?.start();
      previousFocusRef.current?.focus?.();
    };
  }, [closeWalletOnboarding, open]);

  if (!open || !isConnected) return null;

  const networkReady = currentChainId === targetChain.id;
  const steps = termsEnabled
    ? ["network", "terms", "signin", "done"]
    : ["network", "signin", "done"];
  const activeStep = Math.max(0, steps.indexOf(step));

  return (
    <div className="modal wallet-onboarding" role="dialog" aria-modal="true" aria-labelledby="walletOnboardingTitle">
      <div className="modal-backdrop" onClick={closeWalletOnboarding} />
      <div className="modal-card wallet-modal-card" ref={cardRef}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">Tyrian onboarding</div>
            <h3 id="walletOnboardingTitle">
              {step === "network"
                ? "Choose your network"
                : step === "terms"
                  ? "Before you continue"
                  : step === "signin"
                    ? "Sign in with your wallet"
                    : "You're in."}
            </h3>
          </div>
          <button
            className="icon-btn"
            ref={closeRef}
            type="button"
            onClick={closeWalletOnboarding}
            aria-label="Close onboarding"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <ol className="wallet-steps" aria-label="Onboarding progress">
          {steps.map((item, index) => (
            <li
              key={item}
              className={`wallet-step${index === activeStep ? " is-active" : ""}${index < activeStep ? " is-done" : ""}`}
              aria-current={index === activeStep ? "step" : undefined}
            >
              <span>{index < activeStep ? "✓" : index + 1}</span>
              {item === "network"
                ? "Network"
                : item === "terms"
                  ? "Terms"
                  : item === "signin"
                    ? "Sign in"
                    : "Done"}
            </li>
          ))}
        </ol>

        {step === "network" ? (
          <div className="wallet-step-body">
            <p className="hint">
              Tyrian runs on <b>{targetChain.name}</b>. Switch networks before signing in.
            </p>
            <div className="wallet-route" aria-live="polite">
              <div>
                <span>Current</span>
                <b>{currentChain?.name ?? `Chain ${currentChainId ?? "unknown"}`}</b>
              </div>
              <span className="wallet-route-arrow" aria-hidden="true">
                →
              </span>
              <div>
                <span>Required</span>
                <b>{targetChain.name}</b>
              </div>
            </div>
            {phantomWallet ? (
              <p className="wallet-note">
                Phantom needs Robinhood Chain enabled once. Open Settings → Active
                Networks, turn on {targetChain.name}, then switch again.
              </p>
            ) : null}
            {error ? (
              <p className="wallet-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="modal-actions">
              <button className="btn btn-ghost" type="button" onClick={closeWalletOnboarding}>
                Not now
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void switchToTargetChain()}
                disabled={switching || networkReady}
              >
                {switching
                  ? "Switching…"
                  : networkReady
                    ? "Network ready"
                    : `Switch to ${targetChain.name}`}
              </button>
            </div>
            <button
              className="wallet-switch-wallet"
              type="button"
              onClick={() => void switchWallet()}
            >
              Use a different wallet
            </button>
          </div>
        ) : step === "terms" ? (
          <div className="wallet-step-body">
            <p className="hint">
              Tyrian is non-custodial. You keep your keys, and protocol interactions are subject to the Terms of Service.
            </p>
            <ul className="wallet-terms-list">
              <li>You are responsible for wallet security and transaction approval.</li>
              <li>Preview data is not a live financial quote.</li>
              <li>Access is restricted in sanctioned jurisdictions (OFAC, US, and restricted regions).</li>
            </ul>
            {termsAccepted ? (
              <p className="hint">Terms acknowledged and recorded. Continue to sign-in.</p>
            ) : (
              <p className="wallet-note">
                By accepting, your acknowledgement is bound to your connected wallet and recorded in the audit log.
              </p>
            )}
            <div className="modal-actions">
              <button className="btn btn-ghost" type="button" onClick={closeWalletOnboarding}>
                Not now
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={acceptTerms}
                disabled={termsAccepted}
              >
                {termsAccepted ? "Acknowledged" : "Accept and continue"}
              </button>
            </div>
          </div>
        ) : step === "signin" ? (
          <div className="wallet-step-body">
            <div className="wallet-account">
              <span className="wallet-account-dot" aria-hidden="true" />
              <div>
                <span>Wallet</span>
                <b className="mono">{shortenAddress(address)}</b>
              </div>
              <span className="chip">{targetChain.name}</span>
            </div>
            <p className="hint">
              Sign a one-time message to prove this wallet owns your Tyrian keys. No transaction and no gas.
            </p>
            {sessionError ? (
              <p className="wallet-error" role="alert">
                {sessionError}
              </p>
            ) : null}
            <div className="modal-actions">
              <button className="btn btn-ghost" type="button" onClick={closeWalletOnboarding}>
                Not now
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={signingIn || sessionLoading}
                onClick={() => void signIn()}
              >
                {signingIn ? "Waiting for signature…" : "Sign in with wallet"}
              </button>
            </div>
            <button
              className="wallet-switch-wallet"
              type="button"
              onClick={() => void switchWallet()}
            >
              Use a different wallet
            </button>
          </div>
        ) : (
          <div className="wallet-step-body">
            <div className="wallet-success">
              <span aria-hidden="true">✓</span>
              <div>
                <b>{authenticated ? "Wallet signed in" : "Wallet connected"}</b>
                <p className="mono">{shortenAddress(address)}</p>
              </div>
            </div>
            <p className="hint">
              You can now manage API keys, check quota, or open the playground. The account menu stays available from
              the navbar.
            </p>
            <div className="wallet-route">
              <div>
                <span>Network</span>
                <b>{targetChain.name}</b>
              </div>
              <div>
                <span>Session</span>
                <b>{authenticated ? "Signed in" : "Connected"}</b>
              </div>
            </div>
            <div className="modal-actions wallet-done-actions">
              <Link className="btn btn-secondary" href="/dashboard" onClick={closeWalletOnboarding}>
                Dashboard
              </Link>
              <Link className="btn btn-primary" href="/playground" onClick={closeWalletOnboarding}>
                Playground
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
