import { describe, expect, it } from "bun:test";
import { createResilientRpcTransport } from "./rpc";

describe("createResilientRpcTransport", () => {
  it("creates a single http transport when no fallbacks provided", () => {
    const transport = createResilientRpcTransport("https://rpc.testnet.chain.robinhood.com");
    expect(transport).toBeDefined();
    expect(typeof transport).toBe("function");
  });

  it("creates a fallback transport when array of fallbacks provided", () => {
    const transport = createResilientRpcTransport("https://rpc.testnet.chain.robinhood.com", [
      "https://backup-rpc.testnet.chain.robinhood.com",
    ]);
    expect(transport).toBeDefined();
    expect(typeof transport).toBe("function");
  });

  it("creates a fallback transport when comma-separated fallbacks provided", () => {
    const transport = createResilientRpcTransport(
      "https://rpc.testnet.chain.robinhood.com",
      "https://backup1.robinhood.com, https://backup2.robinhood.com",
    );
    expect(transport).toBeDefined();
  });

  it("deduplicates identical URLs", () => {
    const transport = createResilientRpcTransport("https://rpc.testnet.chain.robinhood.com", [
      "https://rpc.testnet.chain.robinhood.com",
    ]);
    expect(transport).toBeDefined();
  });

  it("throws when empty string provided with no valid URL", () => {
    expect(() => createResilientRpcTransport("", [])).toThrow("No RPC URLs provided");
  });
});
