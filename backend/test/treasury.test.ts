import { describe, expect, it } from "bun:test";
import app from "../src/app";

describe("Tyrian Treasury API Suite (BE-TRS)", () => {
  it("GET /api/treasury/summary returns structured treasury figures with valid asOf timestamp", async () => {
    const res = await app.request("/api/treasury/summary");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("asOf");
    expect(typeof data.asOf).toBe("string");
    expect(data).toHaveProperty("treasuryBalanceUsd");
    expect(typeof data.treasuryBalanceUsd).toBe("number");
    expect(data).toHaveProperty("inflow30dUsd");
    expect(data).toHaveProperty("spend30dUsd");
    expect(data).toHaveProperty("runwayDays");
    expect(data).toHaveProperty("totalHarvestYieldUsd");
    expect(data).toHaveProperty("totalCreatorFeeUsd");
    expect(data).toHaveProperty("totalTyrBurned");
    expect(Array.isArray(data.portfolio)).toBe(true);
  });

  it("GET /api/treasury/flow returns points timeline and recent events", async () => {
    const res = await app.request("/api/treasury/flow");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.points)).toBe(true);
    expect(data.points.length).toBe(30);
    expect(Array.isArray(data.recentHarvests)).toBe(true);
    expect(Array.isArray(data.recentBurns)).toBe(true);

    if (data.points.length > 0) {
      const pt = data.points[0];
      expect(pt).toHaveProperty("date");
      expect(pt).toHaveProperty("inflowUsd");
      expect(pt).toHaveProperty("spendUsd");
    }
  });
});
