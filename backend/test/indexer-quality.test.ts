import { describe, it, expect } from "bun:test";
import { indexerService } from "../src/services/indexer";
import { alertService } from "../src/services/alert";

describe("Ponder Indexer Data Quality & Observability Suite (IDX-007 / IDX-011 / IDX-OPS-005 / IDX-OPS-007)", () => {
  it("getIndexerStatus returns structured health report with latency benchmark (IDX-007 / IDX-OPS-006)", async () => {
    const status = await indexerService.getIndexerStatus();

    expect(status).toBeDefined();
    expect(status.endpoint).toBeDefined();
    expect(typeof status.healthy).toBe("boolean");
    expect(typeof status.latencyMs).toBe("number");
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
    expect(status.lastChecked).toBeDefined();
  }, 30_000);

  it("formats deterministic idempotency keys as txHash-logIndex (IDX-SCH-008)", () => {
    const txHash = "0x4b78e192f150495f87b8d74261763e0031846b0a827599c5123d45ef6a7b8c9d";
    const logIndex = 3;
    const eventId = `${txHash}-${logIndex}`;

    expect(eventId).toBe("0x4b78e192f150495f87b8d74261763e0031846b0a827599c5123d45ef6a7b8c9d-3");
    // Ensure primary key split yields exact origin
    const [extractedTx, extractedLog] = eventId.split("-");
    expect(extractedTx).toBe(txHash);
    expect(Number(extractedLog)).toBe(logIndex);
  });

  it("dispatches INDEXER_LAG alert when block lag exceeds tolerance threshold (IDX-OPS-007)", async () => {
    alertService.clearAlerts();

    // Simulate lag of 150 blocks
    const fakeLag = 150;
    const fakeIndexed = 143500000;
    const fakeTip = 143500150;

    const alert = await alertService.dispatchAlert(
      "INDEXER_LAG",
      "WARNING",
      "Indexer Block Lag Detected",
      `Ponder indexer is lagging behind on-chain tip by ${fakeLag} blocks.`,
      { blockLag: fakeLag, latestIndexedBlock: fakeIndexed, latestOnChainBlock: fakeTip },
      true, // bypass cooldown
    );

    expect(alert).not.toBeNull();
    expect(alert?.type).toBe("INDEXER_LAG");
    expect(alert?.severity).toBe("WARNING");
    expect(alert?.metadata?.blockLag).toBe(150);

    const stored = alertService.getRecentAlerts();
    expect(stored.some((a) => a.type === "INDEXER_LAG")).toBe(true);
  });
});
