import { describe, it, expect, afterEach } from "bun:test";
import { ReserveService } from "../src/services/reserve";

describe("ReserveService (BUD-002)", () => {
  const service = new ReserveService();

  afterEach(() => {
    service.configure({});
  });

  it("converts an 18-decimal USDG balance to USD", async () => {
    service.configure({
      readUsdgBalance: async () => 1_234_500_000_000_000_000_000n, // 1,234.5 USDG
      readUsdgDecimals: async () => 18,
    });

    expect(await service.getReserveUsdgBalanceUsd()).toBe(1234.5);
  });

  it("respects non-18-decimal USDG", async () => {
    service.configure({
      readUsdgBalance: async () => 250_000_000n, // 250.00 with 6 decimals
      readUsdgDecimals: async () => 6,
    });

    expect(await service.getReserveUsdgBalanceUsd()).toBe(250);
  });

  it("returns null when the read fails so the damper cannot invent budget", async () => {
    service.configure({
      readUsdgBalance: async () => {
        throw new Error("rpc down");
      },
    });

    expect(await service.getReserveUsdgBalanceUsd()).toBeNull();
  });

  it("returns null when the reserve address is not configured", async () => {
    service.configure({});
    const originalReserve = (service as unknown as { getReserveAddress: () => string | null })
      .getReserveAddress;

    (service as unknown as { getReserveAddress: () => string | null }).getReserveAddress = () => null;
    try {
      expect(await service.getReserveUsdgBalanceUsd()).toBeNull();
    } finally {
      (service as unknown as { getReserveAddress: () => string | null }).getReserveAddress =
        originalReserve;
    }
  });

  it("rejects an implausible decimals value instead of returning a wrong amount", async () => {
    service.configure({
      readUsdgBalance: async () => 1_000_000n,
      readUsdgDecimals: async () => 99,
    });

    expect(await service.getReserveUsdgBalanceUsd()).toBeNull();
  });
});
