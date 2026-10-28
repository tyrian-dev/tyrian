import type { NetworkManifest } from "@shared/contracts/addresses";
import { tyrianNetwork } from "./network";

export type RuntimeEnv = Record<string, string | undefined>;

const DEV_OR_KEY_FALLBACK = "tyrian_default_dev_sub_key_encryption_key_32_bytes";

/**
 * Boot-time configuration checks for the backend.
 *
 * Mainnet must never start with development escape hatches enabled: mock
 * inference, a disabled geo gate, wildcard CORS, missing persistence, or a
 * missing provider credential. Each of those silently turns a fail-closed path
 * into a permissive one, so they are startup errors on mainnet.
 *
 * The function is exported for tests; `assertRuntimeConfig` is the production
 * entry point.
 */
export function getRuntimeConfigIssues(
  env: RuntimeEnv,
  network: NetworkManifest = tyrianNetwork,
): string[] {
  const issues: string[] = [];

  if (network.name !== "mainnet") {
    // Testnet/local may run with reduced infrastructure, but mock inference must
    // still be explicit. Nothing else is enforced here.
    return issues;
  }

  if (env.MOCK_INFERENCE === "true") {
    issues.push("MOCK_INFERENCE must not be true on mainnet (no fake completions).");
  }
  if (env.ENABLE_GEO_GATE === "false") {
    issues.push("ENABLE_GEO_GATE must not be false on mainnet (geo is fail-closed).");
  }
  if (env.GEO_GATE_STRICT === "false") {
    issues.push("GEO_GATE_STRICT must not be false on mainnet.");
  }

  if (!env.TYRIAN_NETWORK) {
    issues.push("TYRIAN_NETWORK must be set explicitly on mainnet.");
  }

  const openRouterKey = env.OPENROUTER_API_KEY?.trim() ?? "";
  if (!openRouterKey.startsWith("sk-or-v1-")) {
    issues.push("OPENROUTER_API_KEY is missing or malformed on mainnet.");
  }
  if (!env.OPENROUTER_MGMT_KEY?.trim()) {
    issues.push("OPENROUTER_MGMT_KEY is required to issue per-user sub-keys.");
  }

  if (!env.DATABASE_URL?.trim()) {
    issues.push("DATABASE_URL is required on mainnet (epoch ledger and API keys).");
  }
  if (!env.INDEXER_URL?.trim()) {
    issues.push("INDEXER_URL is required on mainnet (live stake positions).");
  }
  if (!env.ADMIN_SECRET?.trim()) {
    issues.push("ADMIN_SECRET is required on mainnet (protects POST /api/epoch/run).");
  }

  const frontendOrigins = (env.FRONTEND_URL ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (frontendOrigins.length === 0 || frontendOrigins.includes("*")) {
    issues.push("FRONTEND_URL must list explicit origins on mainnet (no wildcard CORS).");
  }

  const secret = env.OR_KEY_ENC_KEY?.trim() || env.SESSION_SECRET?.trim() || "";
  if (secret.length < 32 || secret === DEV_OR_KEY_FALLBACK) {
    issues.push("OR_KEY_ENC_KEY (or SESSION_SECRET) must be a non-default 32+ character secret.");
  }

  const rpc = env.RPC_URL?.trim() ?? "";
  if (rpc && rpc === network.rpcUrl) {
    issues.push("RPC_URL points at the public mainnet RPC; use a private/paid endpoint.");
  }

  return issues;
}

export function assertRuntimeConfig(
  env: RuntimeEnv = process.env,
  network: NetworkManifest = tyrianNetwork,
): void {
  const issues = getRuntimeConfigIssues(env, network);
  if (issues.length === 0) return;

  throw new Error(
    `Refusing to start on ${network.name}: ${issues.length} configuration issue(s):\n` +
      issues.map((issue) => `  - ${issue}`).join("\n"),
  );
}
