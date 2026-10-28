import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const BLOCKED_COUNTRIES = (process.env.BLOCKED_COUNTRIES || "US,GB,CA,CH,AE")
  .split(",")
  .map((country) => country.trim().toUpperCase())
  .filter(Boolean);

function isStrictGeoMode(): boolean {
  return process.env.GEO_GATE_STRICT === "true" || process.env.NODE_ENV === "production";
}

export function proxy(request: NextRequest) {
  // Read geo country from Vercel / Cloudflare headers.
  const rawCountry =
    request.headers.get("x-vercel-ip-country") ||
    request.headers.get("cf-ipcountry") ||
    request.headers.get("x-country-code") ||
    request.headers.get("x-country");

  const country = rawCountry?.trim().toUpperCase() || null;
  const knownCountry = country && country !== "XX" && country !== "T1" ? country : null;

  // Fail closed: in production/strict mode a missing or unknown country is
  // treated as restricted instead of silently allowing access.
  if (!knownCountry) {
    const response = NextResponse.next();
    if (isStrictGeoMode()) {
      response.headers.set("x-geo-blocked", "unknown");
    }
    return response;
  }

  if (BLOCKED_COUNTRIES.includes(knownCountry)) {
    const response = NextResponse.next();
    response.headers.set("x-geo-blocked", "true");
    response.headers.set("x-user-country", knownCountry);
    return response;
  }

  const response = NextResponse.next();
  response.headers.set("x-user-country", knownCountry);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|assets|.*\\..*).*)"],
};
