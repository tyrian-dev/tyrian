import { describe, expect, test } from "bun:test";
import app from "../src/app";
import {
  isAllowedSiweChainId,
  resolveBackendNetwork,
} from "../src/config/network";

describe("backend network config", () => {
  test("resolves testnet from the manifest", () => {
    const network = resolveBackendNetwork({ TYRIAN_NETWORK: "testnet" });

    expect(network.name).toBe("testnet");
    expect(network.chainId).toBe(46630);
  });

  test("resolves mainnet from the manifest", () => {
    const network = resolveBackendNetwork({ TYRIAN_NETWORK: "mainnet" });

    expect(network.name).toBe("mainnet");
    expect(network.chainId).toBe(4663);
  });

  test("rejects an unknown network instead of defaulting to mainnet", () => {
    expect(() =>
      resolveBackendNetwork({ TYRIAN_NETWORK: "not-a-network" }),
    ).toThrow(/Unknown Tyrian network/);
  });

  test("requires an explicit network in production", () => {
    expect(() =>
      resolveBackendNetwork({ NODE_ENV: "production" }),
    ).toThrow(/TYRIAN_NETWORK is required in production/);
  });

  test("only allows the selected manifest chain for SIWE", () => {
    const testnet = resolveBackendNetwork({ TYRIAN_NETWORK: "testnet" });
    const mainnet = resolveBackendNetwork({ TYRIAN_NETWORK: "mainnet" });

    expect(isAllowedSiweChainId(46630, testnet)).toBe(true);
    expect(isAllowedSiweChainId(4663, testnet)).toBe(false);
    expect(isAllowedSiweChainId(4663, mainnet)).toBe(true);
    expect(isAllowedSiweChainId(46630, mainnet)).toBe(false);
  });

  test("/health reports the selected network and chain ID", async () => {
    const response = await app.request("/health");
    const body = (await response.json()) as {
      status: string;
      network: string;
      chainId: number;
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.network).toBe("testnet");
    expect(body.chainId).toBe(46630);
  });

  test("/health/indexer reports indexer connection status and latency (IDX-007 / IDX-OPS-006)", async () => {
    const response = await app.request("/health/indexer");
    expect([200, 503]).toContain(response.status);
    const body = (await response.json()) as {
      healthy: boolean;
      endpoint: string;
      latencyMs: number;
      lastChecked: string;
    };
    expect(body.endpoint).toBeDefined();
    expect(typeof body.healthy).toBe("boolean");
    expect(typeof body.latencyMs).toBe("number");
    expect(body.lastChecked).toBeDefined();
  });
});
