import { fallback, http, type Transport } from "viem";

export interface RpcTransportOptions {
  timeout?: number;
  retryCount?: number;
  retryDelay?: number;
  rank?: boolean;
}

/**
 * Creates a resilient Viem Transport supporting automatic RPC failover.
 * If multiple endpoints are configured, requests automatically fall back to
 * healthy providers when one endpoint is degraded or responds with 429/timeout.
 */
export function createResilientRpcTransport(
  primaryRpcUrl: string,
  fallbackUrls: string[] | string = [],
  options?: RpcTransportOptions,
): Transport {
  const parsedFallbacks = (
    Array.isArray(fallbackUrls)
      ? fallbackUrls
      : (fallbackUrls || "").split(",")
  )
    .map((u) => u.trim())
    .filter(Boolean);

  const allUrls = Array.from(
    new Set([primaryRpcUrl.trim(), ...parsedFallbacks]),
  ).filter(Boolean);

  if (allUrls.length === 0) {
    throw new Error("No RPC URLs provided to createResilientRpcTransport");
  }

  const timeout = options?.timeout ?? 10_000;
  const retryCount = options?.retryCount ?? 3;
  const retryDelay = options?.retryDelay ?? 1_000;
  const rank = options?.rank ?? true;

  const transports = allUrls.map((url) =>
    http(url, {
      timeout,
      retryCount,
      retryDelay,
    }),
  );

  if (transports.length === 1) {
    return transports[0];
  }

  return fallback(transports, { rank });
}
