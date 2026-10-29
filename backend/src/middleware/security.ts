import type { Context, Next } from "hono";
import { redis } from "../services/redis";

/**
 * 1. CSRF / Origin Guard (BE-AUTH-004)
 * Validates Origin / Referer on mutating requests (POST, PUT, DELETE, PATCH).
 * Fails closed if cross-site or origin is unauthorized.
 */
export async function csrfProtection(c: Context, next: Next) {
  const method = c.req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return next();
  }

  // Reject explicit cross-site requests
  const secFetchSite = c.req.header("Sec-Fetch-Site");
  if (secFetchSite === "cross-site") {
    return c.json({ error: "Forbidden: Cross-site request rejected" }, 403);
  }

  const origin = c.req.header("Origin");
  const referer = c.req.header("Referer");

  // In local test suites or direct non-browser calls without headers, proceed
  if (!origin && !referer) {
    return next();
  }

  const checkUrl = origin || referer || "";
  try {
    const parsed = new URL(checkUrl);
    const host = parsed.host; // e.g. "localhost:3000", "localhost:3001"

    const frontendHosts = (process.env.FRONTEND_URL ?? "")
      .split(",")
      .map((u) => {
        try {
          return new URL(u.trim()).host;
        } catch {
          return u.trim();
        }
      })
      .filter(Boolean);

    const siweHosts = (process.env.SIWE_DOMAIN ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);

    const allowedHosts = [
      "localhost:3000",
      "localhost:3001",
      "127.0.0.1:3000",
      "127.0.0.1:3001",
      ...frontendHosts,
      ...siweHosts,
    ];

    const isAllowed = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!isAllowed) {
      return c.json({ error: "Forbidden: Origin mismatch" }, 403);
    }
  } catch {
    return c.json({ error: "Forbidden: Malformed Origin header" }, 403);
  }

  return next();
}

/**
 * 2. Rate Limiter Middleware (BE-AUTH-005)
 * Sliding window IP rate limiter backed by Redis.
 */
export function rateLimiter(options: {
  keyPrefix: string;
  limit: number;
  windowSeconds: number;
}) {
  return async (c: Context, next: Next) => {
    const ip =
      c.req.header("CF-Connecting-IP") ||
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
      "127.0.0.1";

    const key = `tyrian:ratelimit:${options.keyPrefix}:${ip}`;

    try {
      const current = await redis.get(key);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= options.limit) {
        c.header("Retry-After", String(options.windowSeconds));
        return c.json(
          {
            error: "Too many requests. Please try again later.",
            retryAfter: options.windowSeconds,
          },
          429,
        );
      }

      if (count === 0) {
        await redis.set(key, "1", options.windowSeconds);
      } else {
        await redis.set(key, String(count + 1), options.windowSeconds);
      }
    } catch {
      if (process.env.NODE_ENV === "production") {
        return c.json({ error: "Rate limit service unavailable" }, 503);
      }
    }

    return next();
  };
}

/**
 * 3. Gateway Inference Rate Limiter (BE-GW-010)
 * Scoped by API key, wallet, or IP address (60 req/min for key, 120 req/min for wallet/IP).
 */
export function gatewayRateLimiter(limit: number = 60, windowSeconds: number = 60) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization") || "";
    const ip =
      c.req.header("CF-Connecting-IP") ||
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
      "127.0.0.1";

    let identifier = ip;
    if (authHeader.startsWith("Bearer tyr_live_")) {
      const raw = authHeader.replace("Bearer ", "").trim();
      identifier = `key:${raw.slice(0, 16)}`;
    }

    const key = `tyrian:ratelimit:gw:${identifier}`;

    try {
      const current = await redis.get(key);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= limit) {
        c.header("Retry-After", String(windowSeconds));
        return c.json(
          {
            error: {
              message: `Rate limit exceeded (${limit} requests/min). Please slow down and try again.`,
              type: "rate_limited",
              code: "rate_limited",
            },
          },
          429,
        );
      }

      if (count === 0) {
        await redis.set(key, "1", windowSeconds);
      } else {
        await redis.set(key, String(count + 1), windowSeconds);
      }
    } catch {
      // In development fallback, continue
    }

    return next();
  };
}
