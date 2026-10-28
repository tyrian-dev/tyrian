import {
  getNetworkManifest,
  resolveNetworkName,
  type NetworkManifest,
} from "@shared/contracts/addresses";

export interface NetworkEnv {
  NODE_ENV?: string;
  TYRIAN_NETWORK?: string;
  APP_ENV?: string;
  [key: string]: string | undefined;
}

/**
 * Backend network selection is explicit: `TYRIAN_NETWORK` (or `APP_ENV` for
 * local tooling). Unlike the frontend loader it deliberately ignores
 * `NEXT_PUBLIC_*` values so a shared env file cannot switch the backend by
 * accident.
 */
export function resolveBackendNetwork(
  env: NetworkEnv = process.env,
): NetworkManifest {
  const selected = env.TYRIAN_NETWORK ?? env.APP_ENV;
  if (!env.TYRIAN_NETWORK && env.NODE_ENV === "production") {
    throw new Error(
      "TYRIAN_NETWORK is required in production; refusing to default to testnet.",
    );
  }

  const name = resolveNetworkName(selected ?? "testnet");
  return getNetworkManifest(name);
}

export const tyrianNetwork = resolveBackendNetwork();
export const tyrianNetworkName = tyrianNetwork.name;
export const tyrianChainId = tyrianNetwork.chainId;

export function getSiweDomain(): string | null {
  return process.env.SIWE_DOMAIN?.trim() || null;
}

/**
 * SIWE chain allowlist comes from the selected manifest, not from env. A
 * signature for the other network is rejected.
 */
export function isAllowedSiweChainId(
  chainId: number,
  network: NetworkManifest = tyrianNetwork,
): boolean {
  return chainId === network.chainId;
}
