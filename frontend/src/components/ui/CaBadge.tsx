"use client";

import { useState, useEffect, useCallback } from "react";
import { activeNetwork, isAddress, networkManifests } from "@shared/contracts/addresses";

export interface CaBadgeProps {
  variant?: "hero" | "footer" | "compact";
  status?: "auto" | "tba" | "live";
  className?: string;
  showNetwork?: boolean;
}

export function CaBadge({
  variant = "hero",
  status = "auto",
  className = "",
  showNetwork = true,
}: CaBadgeProps) {
  // Address from network manifest; fallback to mainnet manifest address if available
  const canonicalMainnetAddress = networkManifests.mainnet.tokens.TYR?.address ?? null;
  const rawAddress = (activeNetwork.name === "mainnet"
    ? activeNetwork.tokens.TYR?.address
    : canonicalMainnetAddress) ?? activeNetwork.tokens.TYR?.address ?? null;

  const explorerUrl =
    (activeNetwork.name === "mainnet" ? activeNetwork.explorer : networkManifests.mainnet.explorer) ||
    "https://robinhoodchain.blockscout.com";
  const networkLabel = "Robinhood Chain";

  // Determine initial TBA state deterministically for SSR hydration safety
  const defaultIsTba = (() => {
    if (status === "tba") return true;
    if (status === "live") return false;
    if (process.env.NEXT_PUBLIC_TYR_CA_STATUS === "tba") return true;
    if (process.env.NEXT_PUBLIC_TYR_CA_STATUS === "live") return false;
    // For "auto": if a valid token address is configured in manifest -> live, otherwise TBA
    return !isAddress(rawAddress);
  })();

  const [isTba, setIsTba] = useState<boolean>(defaultIsTba);
  const [copied, setCopied] = useState<boolean>(false);
  const [tooltip, setTooltip] = useState<string | null>(null);

  // Client-side query param override for developers (?ca=live or ?ca=tba)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const params = new URLSearchParams(window.location.search);
      const queryCa = params.get("ca");
      if (queryCa === "live" && rawAddress) {
        setIsTba(false);
      } else if (queryCa === "tba") {
        setIsTba(true);
      }
    } catch {
      // Ignore URL parsing errors
    }
  }, [rawAddress]);

  const activeAddress = rawAddress || "0xe7a401dc74196ed5aeb96f24f7ac5c02e1b793d7";
  const displayAddress = `${activeAddress.slice(0, 6)}…${activeAddress.slice(-4)}`;

  const handleCopy = useCallback(async () => {
    if (isTba) {
      setTooltip("Official $TYR CA is TBA · Beware of scams!");
      setTimeout(() => setTooltip(null), 2400);
      return;
    }

    try {
      await navigator.clipboard.writeText(activeAddress);
      setCopied(true);
      setTooltip("Address copied to clipboard!");
      setTimeout(() => {
        setCopied(false);
        setTooltip(null);
      }, 2000);
    } catch {
      setTooltip("Failed to copy address");
      setTimeout(() => setTooltip(null), 2000);
    }
  }, [isTba, activeAddress]);

  return (
    <div
      className={`tyr-ca-badge ${isTba ? "is-tba" : "is-live"} ${className}`}
      role="group"
      aria-label="Official $TYR contract information"
    >
      {/* Tooltip notice */}
      {tooltip && (
        <div className="tyr-ca-tooltip" role="status" aria-live="polite">
          {tooltip}
        </div>
      )}

      {/* Pulsing indicator dot */}
      <span
        className="tyr-ca-status-dot"
        aria-hidden="true"
        title={isTba ? "Contract TBA (Pending announcement)" : "Live Contract"}
      />

      {/* Label */}
      <span className="tyr-ca-label">$TYR CA:</span>

      {/* Value */}
      {isTba ? (
        <span
          className="tyr-ca-value mono"
          title="Official contract address will be announced at launch"
          onClick={handleCopy}
          style={{ cursor: "pointer" }}
        >
          TBA
        </span>
      ) : (
        <span
          className="tyr-ca-value mono"
          title={`Click to copy: ${activeAddress}`}
          onClick={handleCopy}
          style={{ cursor: "pointer" }}
        >
          {displayAddress}
        </span>
      )}

      {/* Network Tag */}
      {showNetwork && (
        <span className="tyr-ca-network-tag" title={activeNetwork.label}>
          {networkLabel}
        </span>
      )}

      {/* Action buttons */}
      <div className="tyr-ca-actions">
        {isTba ? (
          <button
            type="button"
            className="tyr-ca-btn"
            onClick={handleCopy}
            aria-label="Official CA status info"
            title="Official contract To Be Announced. Beware of scams."
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`tyr-ca-btn ${copied ? "is-copied" : ""}`}
              onClick={handleCopy}
              aria-label={copied ? "Copied" : "Copy contract address"}
              title={copied ? "Copied!" : "Copy address"}
            >
              {copied ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
            <a
              href={`${explorerUrl}/token/${activeAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="tyr-ca-btn"
              aria-label="View on Robinhood Chain Explorer"
              title="View on Robinhood Chain Explorer"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </>
        )}
      </div>
    </div>
  );
}
