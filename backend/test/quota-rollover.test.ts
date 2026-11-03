import { describe, expect, test, mock } from "bun:test";
import { quotaService } from "../src/services/quota";
import { indexerService } from "../src/services/indexer";
import { tyrianNetwork } from "../src/config/network";

describe("Dynamic Pending Shares Rollover Suite (BE-QUOTA-001)", () => {
  test("matures pending shares into active shares when effectiveEpoch <= currentEpoch", async () => {
    const user = "0x116656849Ac1aC9dDF2A35f2359b78E3e8022621";
    const usdgAddress = tyrianNetwork.tokens.USDG.address?.toLowerCase() || "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

    const currentEpoch = BigInt(Math.floor(Date.now() / 86400000));
    const maturedEpoch = (currentEpoch - 1n).toString();

    // Mock indexer response with 0.20 active and 1.367614 pending matured yesterday
    const originalGetUserPositions = indexerService.getUserStakePositions;
    const originalGetUserUnstakes = indexerService.getUserUnstakeRequests;

    indexerService.getUserStakePositions = mock(async () => [
      {
        id: `${user}-${usdgAddress}`,
        userAddress: user,
        assetAddress: usdgAddress,
        activeShares: "200000",
        pendingShares: "1367614",
        cooldownShares: "0",
        effectiveEpoch: maturedEpoch,
        lastUpdatedBlock: "100",
      },
    ]);
    indexerService.getUserUnstakeRequests = mock(async () => []);

    try {
      const quota = await quotaService.getUserQuota(user);
      expect(quota.positions).toHaveLength(1);
      const pos = quota.positions[0];
      expect(pos.asset).toBe("USDG");
      // Pending shares must be rolled into activeShares
      expect(pos.activeShares).toBe("1567614");
      expect(pos.pendingShares).toBe("0");
    } finally {
      indexerService.getUserStakePositions = originalGetUserPositions;
      indexerService.getUserUnstakeRequests = originalGetUserUnstakes;
    }
  });

  test("keeps pending shares pending when effectiveEpoch > currentEpoch", async () => {
    const user = "0x2222222222222222222222222222222222222222";
    const usdgAddress = tyrianNetwork.tokens.USDG.address?.toLowerCase() || "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

    const currentEpoch = BigInt(Math.floor(Date.now() / 86400000));
    const tomorrowEpoch = (currentEpoch + 1n).toString();

    const originalGetUserPositions = indexerService.getUserStakePositions;
    const originalGetUserUnstakes = indexerService.getUserUnstakeRequests;

    indexerService.getUserStakePositions = mock(async () => [
      {
        id: `${user}-${usdgAddress}`,
        userAddress: user,
        assetAddress: usdgAddress,
        activeShares: "200000",
        pendingShares: "1367614",
        cooldownShares: "0",
        effectiveEpoch: tomorrowEpoch,
        lastUpdatedBlock: "100",
      },
    ]);
    indexerService.getUserUnstakeRequests = mock(async () => []);

    try {
      const quota = await quotaService.getUserQuota(user);
      expect(quota.positions).toHaveLength(1);
      const pos = quota.positions[0];
      expect(pos.asset).toBe("USDG");
      // Pending shares must remain pending until next epoch
      expect(pos.activeShares).toBe("200000");
      expect(pos.pendingShares).toBe("1367614");
    } finally {
      indexerService.getUserStakePositions = originalGetUserPositions;
      indexerService.getUserUnstakeRequests = originalGetUserUnstakes;
    }
  });
});
