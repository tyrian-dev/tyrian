"use client";

import React from "react";
import Image from "next/image";

interface TokenLogoProps {
  symbol: string;
  size?: number;
  className?: string;
  variant?: "top-right" | "center";
}

interface TokenConfig {
  src: string;
  scale?: number;
  isCustomBadge?: boolean;
}

const TOKEN_CONFIG: Record<string, TokenConfig> = {
  TYR: {
    src: "/tokens/tyr.png",
    scale: 0.76,
    isCustomBadge: true,
  },
  USDG: {
    src: "/tokens/usdg.png",
    scale: 0.86,
    isCustomBadge: true,
  },
  AAPL: {
    src: "/tokens/aapl.svg",
    scale: 0.64,
  },
  NVDA: {
    src: "/tokens/nvda.svg",
    scale: 0.66,
  },
  MSFT: {
    src: "/tokens/msft.svg",
    scale: 0.64,
  },
  GOOGL: {
    src: "/tokens/googl.svg",
    scale: 0.64,
  },
  AMZN: {
    src: "/tokens/amzn.svg",
    scale: 0.66,
  },
  META: {
    src: "/tokens/meta.svg",
    scale: 0.66,
  },
  TSLA: {
    src: "/tokens/tsla.svg",
    scale: 0.64,
  },
  AMD: {
    src: "/tokens/amd.svg",
    scale: 0.66,
  },
};

export function TokenLogo({ symbol, size = 40, className = "", variant = "top-right" }: TokenLogoProps) {
  const cleanSymbol = symbol.replace(/^\$/, "").toUpperCase();
  const config = TOKEN_CONFIG[cleanSymbol];

  const isTyr = cleanSymbol === "TYR";

  // Obsidian glass disc with subtle hairline highlight, adhering strictly to Tyrian brand tokens
  const containerStyle: React.CSSProperties = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    position: "relative",
    background: isTyr
      ? "radial-gradient(circle at 35% 35%, rgba(201, 162, 74, 0.16) 0%, rgba(35, 2, 20, 0.85) 100%)"
      : "radial-gradient(circle at 35% 35%, rgba(255, 255, 255, 0.06) 0%, rgba(20, 1, 14, 0.82) 100%)",
    border: isTyr
      ? "1px solid rgba(201, 162, 74, 0.35)"
      : "1px solid rgba(234, 182, 208, 0.15)",
    boxShadow: isTyr
      ? "inset 0 1px 0 rgba(201, 162, 74, 0.25), 0 4px 16px rgba(0, 0, 0, 0.4)"
      : "inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 4px 16px rgba(0, 0, 0, 0.35)",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
    overflow: "hidden",
    transition: "transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.25s ease, box-shadow 0.25s ease",
  };

  const scale = config?.scale ?? 0.58;
  const iconSize = Math.round(size * scale);

  return (
    <div
      className={`token-emblem token-emblem-${variant} ${className}`}
      style={containerStyle}
      title={`${cleanSymbol} official token asset`}
    >
      {config ? (
        <Image
          src={config.src}
          alt={`${cleanSymbol} logo`}
          width={iconSize}
          height={iconSize}
          unoptimized
          style={{
            objectFit: "contain",
            maxWidth: `${iconSize}px`,
            maxHeight: `${iconSize}px`,
            display: "block",
          }}
        />
      ) : (
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 600,
            fontSize: `${Math.round(size * 0.36)}px`,
            color: "var(--gold-400, #C9A24A)",
            letterSpacing: "0.02em",
          }}
        >
          {cleanSymbol.slice(0, 2)}
        </span>
      )}
    </div>
  );
}