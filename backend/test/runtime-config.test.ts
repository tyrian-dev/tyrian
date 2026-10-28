import { describe, expect, it } from "bun:test";
import { networkManifests } from "@shared/contracts/addresses";
import { getRuntimeConfigIssues } from "../src/config/validate";

const mainnet = networkManifests.mainnet;

const validMainnetEnv = {
  TYRIAN_NETWORK: "mainnet",
  OPENROUTER_API_KEY: "sk-or-v1-real-key",
  OPENROUTER_MGMT_KEY: "mgmt-key",
  DATABASE_URL: "postgres://localhost/tyrian",
  INDEXER_URL: "http://indexer:42069",
  ADMIN_SECRET: "admin-secret",
  FRONTEND_URL: "https://tyrian.app",
  OR_KEY_ENC_KEY: "x".repeat(40),
  RPC_URL: "https://private-rpc.example.com",
};

describe("Runtime config validation (BE-CFG-001)", () => {
  it("accepts a complete mainnet environment", () => {
    expect(getRuntimeConfigIssues(validMainnetEnv, mainnet)).toEqual([]);
  });

  it("rejects mock inference on mainnet", () => {
    const issues = getRuntimeConfigIssues({ ...validMainnetEnv, MOCK_INFERENCE: "true" }, mainnet);
    expect(issues.join("\n")).toContain("MOCK_INFERENCE");
  });

  it("rejects a disabled geo gate on mainnet", () => {
    const issues = getRuntimeConfigIssues({ ...validMainnetEnv, ENABLE_GEO_GATE: "false" }, mainnet);
    expect(issues.join("\n")).toContain("ENABLE_GEO_GATE");
  });

  it("requires persistence, indexer, admin secret, and provider keys", () => {
    const issues = getRuntimeConfigIssues(
      {
        TYRIAN_NETWORK: "mainnet",
        FRONTEND_URL: "https://tyrian.app",
        OR_KEY_ENC_KEY: "x".repeat(40),
        RPC_URL: "https://private-rpc.example.com",
      },
      mainnet,
    );

    const text = issues.join("\n");
    expect(text).toContain("OPENROUTER_API_KEY");
    expect(text).toContain("OPENROUTER_MGMT_KEY");
    expect(text).toContain("DATABASE_URL");
    expect(text).toContain("INDEXER_URL");
    expect(text).toContain("ADMIN_SECRET");
  });

  it("rejects wildcard CORS and the default encryption secret", () => {
    const issues = getRuntimeConfigIssues(
      {
        ...validMainnetEnv,
        FRONTEND_URL: "*",
        OR_KEY_ENC_KEY: "tyrian_default_dev_sub_key_encryption_key_32_bytes",
      },
      mainnet,
    );

    const text = issues.join("\n");
    expect(text).toContain("FRONTEND_URL");
    expect(text).toContain("OR_KEY_ENC_KEY");
  });

  it("rejects the public manifest RPC as the mainnet backend RPC", () => {
    const issues = getRuntimeConfigIssues({ ...validMainnetEnv, RPC_URL: mainnet.rpcUrl }, mainnet);
    expect(issues.join("\n")).toContain("public mainnet RPC");
  });

  it("does not enforce production-only settings on testnet", () => {
    expect(
      getRuntimeConfigIssues({ MOCK_INFERENCE: "true" }, networkManifests.testnet),
    ).toEqual([]);
  });
});
