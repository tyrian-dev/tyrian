import type { Context, Next } from "hono";
import crypto from "node:crypto";
import { tyrianNetwork } from "../config/network";

const DEFAULT_BLOCKED_COUNTRIES = ["US", "GB", "CA", "CH", "AE"];

export function getBlockedCountries(): Set<string> {
  const envBlocked = process.env.BLOCKED_COUNTRIES;
  if (!envBlocked) {
    return new Set(DEFAULT_BLOCKED_COUNTRIES);
  }
  return new Set(
    envBlocked
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * Extract two-letter ISO country code from reverse-proxy headers
 * (Vercel, Cloudflare, AWS CloudFront, or custom ingress).
 */
export function extractCountry(c: Context): string | null {
  const vercelCountry = c.req.header("x-vercel-ip-country");
  if (vercelCountry) return vercelCountry.trim().toUpperCase();

  const cfCountry = c.req.header("cf-ipcountry");
  if (cfCountry) return cfCountry.trim().toUpperCase();

  const customCountry = c.req.header("x-country-code");
  if (customCountry) return customCountry.trim().toUpperCase();

  const forwardedCountry = c.req.header("x-forwarded-country");
  if (forwardedCountry) return forwardedCountry.trim().toUpperCase();

  const geoCountry = c.req.header("x-geo-country");
  if (geoCountry) return geoCountry.trim().toUpperCase();

  return null;
}

/**
 * Middleware: Enforces fail-closed geo-blocking on restricted operations
 * (mutating SIWE auth, API key lifecycle, AI completions).
 */
/**
 * Geo enforcement is fail-closed: if the edge does not provide a country
 * header, restricted operations are refused in production, on mainnet, or when
 * GEO_GATE_STRICT=true. The only exception is local development, where there is
 * no proxy to inject the header. `ENABLE_GEO_GATE=false` is an explicit
 * operator override (and is validated at boot).
 */
function isStrictGeoMode(): boolean {
  if (process.env.GEO_GATE_STRICT === "true") return true;
  if (process.env.NODE_ENV === "production") return true;
  return tyrianNetwork.features.geoGate;
}

export async function geoGate(c: Context, next: Next) {
  if (process.env.ENABLE_GEO_GATE === "false") {
    return next();
  }

  const country = extractCountry(c);
  if (!country) {
    if (isStrictGeoMode()) {
      const requestId = crypto.randomUUID();
      return c.json(
        {
          error: {
            code: "geo_unavailable",
            message:
              "Country could not be determined. Access is denied until the edge sends a supported country header.",
            requestId,
          },
        },
        403,
      );
    }
    // Local development without a reverse proxy: no header is expected.
    return next();
  }

  const blockedList = getBlockedCountries();
  if (blockedList.has(country)) {
    const requestId = crypto.randomUUID();
    return c.json(
      {
        error: {
          code: "geo_blocked",
          message: "Access from your country is restricted by protocol policy.",
          country,
          requestId,
        },
      },
      403,
    );
  }

  return next();
}
