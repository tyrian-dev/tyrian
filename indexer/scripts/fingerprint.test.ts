import { describe, expect, test } from "bun:test";
import {
  networkManifests,
  type NetworkManifest,
} from "../../shared/contracts/addresses";
import { composeInputs, describeChanges, hashInputs } from "./fingerprint";

const FILES = {
  "ponder.config.ts": "config-hash",
  "ponder.schema.ts": "schema-hash",
  "src/index.ts": "index-hash",
};

function testnet(): NetworkManifest {
  return structuredClone(networkManifests.testnet);
}

function hashOf(manifest: NetworkManifest, network = "testnet", files = FILES): string {
  return hashInputs(composeInputs(manifest, network, files));
}

describe("indexer fingerprint", () => {
  test("is deterministic for identical inputs", () => {
    expect(hashOf(testnet())).toBe(hashOf(testnet()));
  });

  test("ignores manifest fields the indexer never reads", () => {
    const base = testnet();
    const mutated = testnet();
    mutated.contracts.TyrTwapOracle = "0x1111111111111111111111111111111111111111";
    mutated.external.uniswapPool = "0x2222222222222222222222222222222222222222";
    mutated.tokens.USDG.address = "0x3333333333333333333333333333333333333333";
    mutated.verification = "verified";

    expect(hashOf(mutated)).toBe(hashOf(base));
  });

  test("changes when startBlock changes", () => {
    const mutated = testnet();
    mutated.startBlock = (mutated.startBlock ?? 0) + 1;
    expect(hashOf(mutated)).not.toBe(hashOf(testnet()));
  });

  test("changes when an indexed contract address changes", () => {
    const mutated = testnet();
    mutated.contracts.StakeManager = "0x4444444444444444444444444444444444444444";
    expect(hashOf(mutated)).not.toBe(hashOf(testnet()));
  });

  test("changes when a StockVault is added or removed", () => {
    const mutated = testnet();
    const withVault = Object.values(mutated.stocks).find((stock) => stock.vault !== null);
    if (!withVault) throw new Error("testnet manifest has no StockVault to mutate");
    withVault.vault = null;
    expect(hashOf(mutated)).not.toBe(hashOf(testnet()));
  });

  test("changes when handler or schema content changes", () => {
    const changed = { ...FILES, "src/index.ts": "different" };
    expect(hashOf(testnet(), "testnet", changed)).not.toBe(hashOf(testnet()));
  });

  test("changes when the network changes", () => {
    expect(hashOf(testnet(), "mainnet")).not.toBe(hashOf(testnet(), "testnet"));
  });

  test("describes field-level changes for operators", () => {
    const previous = composeInputs(testnet(), "testnet", FILES);
    const current = composeInputs(testnet(), "testnet", {
      ...FILES,
      "src/index.ts": "new-handler",
    });

    expect(describeChanges(previous, current)).toContain("file src/index.ts");

    const moved = testnet();
    moved.startBlock = (moved.startBlock ?? 0) + 10;
    const next = composeInputs(moved, "testnet", FILES);
    expect(describeChanges(previous, next).some((line) => line.startsWith("startBlock:"))).toBe(true);
  });
});
