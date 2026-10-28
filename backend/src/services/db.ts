import { eq, and, desc, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { db } from "../db/connection";
import {
  users,
  apiKeys,
  quotas,
  usageLogs,
  treasurySnapshots,
  auditLogs,
  quotaEpochs,
} from "../db/schema";

export interface QuotaEpochRecord {
  id: number;
  epochDate: string;
  snapshotBlock: string | null;
  totalBudgetUsd: string;
  totalAllocatedUsd: string;
  walletsCount: number;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
}

export interface StoredApiKey {
  id: string;
  userAddress: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  isRevoked: boolean;
  createdAt: Date;
}

export interface UsageLogItem {
  userAddress: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export class DbService {
  private hasDb(): boolean {
    return Boolean(process.env.DATABASE_URL);
  }

  /**
   * 1. Ensure user row exists in 'users' table
   */
  async ensureUser(address: string, tosSigned = false): Promise<void> {
    if (!this.hasDb()) return;
    const normalized = address.toLowerCase();

    try {
      if (tosSigned) {
        await db
          .insert(users)
          .values({
            address: normalized,
            tosSignedAt: new Date(),
            createdAt: new Date(),
          })
          .onConflictDoUpdate({
            target: users.address,
            set: { tosSignedAt: new Date() },
          });
      } else {
        await db
          .insert(users)
          .values({
            address: normalized,
            tosSignedAt: null,
            createdAt: new Date(),
          })
          .onConflictDoNothing();
      }
    } catch (err) {
      console.warn(`[DbService] ensureUser notice: ${(err as Error).message}`);
    }
  }

  /**
   * Look up user record by address
   */
  async getUser(address: string): Promise<{ address: string; tosSignedAt: Date | null } | null> {
    if (!this.hasDb()) return null;
    const normalized = address.toLowerCase();
    try {
      const records = await db
        .select({ address: users.address, tosSignedAt: users.tosSignedAt })
        .from(users)
        .where(eq(users.address, normalized))
        .limit(1);
      return records[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 2. Insert API key into persistent Postgres storage
   */
  async createApiKey(params: {
    id: string;
    userAddress: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    orKeyHash?: string;
  }): Promise<void> {
    if (!this.hasDb()) return;
    const normalized = params.userAddress.toLowerCase();

    try {
      await this.ensureUser(normalized);

      await db.insert(apiKeys).values({
        id: params.id,
        userAddress: normalized,
        name: params.name,
        keyHash: params.keyHash,
        keyPrefix: params.keyPrefix,
        orKeyHash: params.orKeyHash || null,
        isRevoked: false,
        createdAt: new Date(),
      });
    } catch (err) {
      console.warn(`[DbService] createApiKey notice: ${(err as Error).message}`);
    }
  }

  /**
   * 3. Fetch all active API keys for user from Postgres
   */
  async getUserApiKeys(userAddress: string): Promise<StoredApiKey[]> {
    if (!this.hasDb()) return [];
    const normalized = userAddress.toLowerCase();

    try {
      const records = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.userAddress, normalized), eq(apiKeys.isRevoked, false)))
        .orderBy(desc(apiKeys.createdAt));

      return records.map((r) => ({
        id: r.id,
        userAddress: r.userAddress,
        name: r.name,
        keyPrefix: r.keyPrefix,
        keyHash: r.keyHash,
        isRevoked: r.isRevoked,
        createdAt: r.createdAt,
      }));
    } catch (err) {
      console.warn(`[DbService] getUserApiKeys notice: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * 4. Lookup API key by SHA-256 hash
   */
  async getApiKeyByHash(keyHash: string): Promise<{ userAddress: string; isRevoked: boolean; name: string } | null> {
    if (!this.hasDb()) return null;

    try {
      const [record] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1);

      if (!record) return null;
      return {
        userAddress: record.userAddress,
        isRevoked: record.isRevoked,
        name: record.name,
      };
    } catch (err) {
      console.warn(`[DbService] getApiKeyByHash notice: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 5. Revoke API key in Postgres
   */
  async revokeApiKey(keyId: string, userAddress: string): Promise<boolean> {
    if (!this.hasDb()) return true;
    const normalized = userAddress.toLowerCase();

    try {
      const result = await db
        .update(apiKeys)
        .set({ isRevoked: true })
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userAddress, normalized)));

      return true;
    } catch (err) {
      console.warn(`[DbService] revokeApiKey notice: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 6. Rotate API key (revoke old, insert new in transaction)
   */
  async rotateApiKey(params: {
    oldKeyId: string;
    newId: string;
    userAddress: string;
    name: string;
    newKeyHash: string;
    newKeyPrefix: string;
  }): Promise<boolean> {
    if (!this.hasDb()) return true;
    const normalized = params.userAddress.toLowerCase();

    try {
      await db.transaction(async (tx) => {
        await tx
          .update(apiKeys)
          .set({ isRevoked: true })
          .where(and(eq(apiKeys.id, params.oldKeyId), eq(apiKeys.userAddress, normalized)));

        await tx.insert(apiKeys).values({
          id: params.newId,
          userAddress: normalized,
          name: params.name,
          keyHash: params.newKeyHash,
          keyPrefix: params.newKeyPrefix,
          isRevoked: false,
          createdAt: new Date(),
        });
      });

      return true;
    } catch (err) {
      console.warn(`[DbService] rotateApiKey notice: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 7. Log AI inference usage (Metadata strictly only, no prompt text!)
   */
  async logUsage(item: UsageLogItem): Promise<void> {
    if (!this.hasDb()) return;
    const normalized = item.userAddress.toLowerCase();

    try {
      await db.insert(usageLogs).values({
        userAddress: normalized,
        model: item.model,
        promptTokens: item.promptTokens,
        completionTokens: item.completionTokens,
        costUsd: item.costUsd.toFixed(6),
        latencyMs: item.latencyMs,
        createdAt: new Date(),
      });
    } catch (err) {
      console.warn(`[DbService] logUsage notice: ${(err as Error).message}`);
    }
  }

  /**
   * 8. Persist daily epoch quota record
   */
  async saveEpochQuota(params: {
    userAddress: string;
    epochDate: string;
    allocatedUsd: number;
    usedUsd: number;
    boostMultiplier: number;
  }): Promise<void> {
    if (!this.hasDb()) return;
    const normalized = params.userAddress.toLowerCase();

    try {
      await this.ensureUser(normalized);

      // Clean up previous quota entry for the same user and date to ensure idempotency
      await db
        .delete(quotas)
        .where(and(eq(quotas.userAddress, normalized), eq(quotas.epochDate, params.epochDate)));

      await db.insert(quotas).values({
        userAddress: normalized,
        epochDate: params.epochDate,
        allocatedUsd: params.allocatedUsd.toFixed(6),
        usedUsd: params.usedUsd.toFixed(6),
        boostMultiplier: params.boostMultiplier.toFixed(2),
        updatedAt: new Date(),
      });
    } catch (err) {
      console.warn(`[DbService] saveEpochQuota notice: ${(err as Error).message}`);
    }
  }

  /**
   * 9. Get user 30-day token usage summary from Postgres
   */
  async getUserUsageSummary(userAddress: string): Promise<{
    totalTokens: number;
    totalCostUsd: number;
    requestCount: number;
    dailyPoints: { date: string; costUsd: number }[];
    providerMix: { name: string; pct: number }[];
  }> {
    if (!this.hasDb()) {
      return { totalTokens: 0, totalCostUsd: 0, requestCount: 0, dailyPoints: [], providerMix: [] };
    }
    const normalized = userAddress.toLowerCase();

    try {
      const records = await db
        .select()
        .from(usageLogs)
        .where(eq(usageLogs.userAddress, normalized));

      let totalTokens = 0;
      let totalCostUsd = 0;

      // Generate 30 daily buckets
      const now = new Date();
      const dailyMap: Record<string, number> = {};
      const dailyPoints: { date: string; costUsd: number }[] = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400 * 1000);
        const key = d.toISOString().slice(0, 10);
        const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
        dailyMap[key] = 0;
        dailyPoints.push({ date: label, costUsd: 0 });
      }

      // Provider spend aggregation
      const providerCosts: Record<string, number> = {};

      for (const r of records) {
        const cost = Number(r.costUsd);
        totalTokens += r.promptTokens + r.completionTokens;
        totalCostUsd += cost;

        const dayKey = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "";
        if (dayKey && dailyMap[dayKey] !== undefined) {
          dailyMap[dayKey] += cost;
        }

        let provider = "Other";
        const modelLower = (r.model || "").toLowerCase();
        if (modelLower.startsWith("anthropic/")) provider = "Anthropic";
        else if (modelLower.startsWith("openai/")) provider = "OpenAI";
        else if (modelLower.startsWith("google/")) provider = "Google";
        else if (modelLower.startsWith("meta-llama/") || modelLower.startsWith("meta/")) provider = "Meta";
        else if (modelLower.startsWith("mistralai/") || modelLower.startsWith("mistral/")) provider = "Mistral";

        providerCosts[provider] = (providerCosts[provider] || 0) + cost;
      }

      for (let i = 29; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400 * 1000);
        const key = d.toISOString().slice(0, 10);
        const idx = 29 - i;
        if (dailyPoints[idx]) {
          dailyPoints[idx].costUsd = Number((dailyMap[key] || 0).toFixed(4));
        }
      }

      const providerMix: { name: string; pct: number }[] = [];
      if (totalCostUsd > 0) {
        for (const [name, cost] of Object.entries(providerCosts)) {
          providerMix.push({
            name,
            pct: Math.round((cost / totalCostUsd) * 100),
          });
        }
        providerMix.sort((a, b) => b.pct - a.pct);
      }

      return {
        totalTokens,
        totalCostUsd: Number(totalCostUsd.toFixed(4)),
        requestCount: records.length,
        dailyPoints,
        providerMix,
      };
    } catch (err) {
      console.warn(`[DbService] getUserUsageSummary notice: ${(err as Error).message}`);
      return { totalTokens: 0, totalCostUsd: 0, requestCount: 0, dailyPoints: [], providerMix: [] };
    }
  }

  /**
   * 10. Persist security and audit log (BE-AUTH-009)
   * Privacy rule: Strips any sensitive secret data before writing to database.
   */
  async logAudit(params: {
    userAddress: string;
    action: string;
    ipCountry?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.hasDb()) return;
    const normalized = params.userAddress.toLowerCase();

    try {
      let userAgentHash: string | null = null;
      if (params.userAgent) {
        userAgentHash = crypto
          .createHash("sha256")
          .update(params.userAgent)
          .digest("hex")
          .slice(0, 32);
      }

      let metadataJson: string | null = null;
      if (params.metadata) {
        // Redact any accidental secret fields
        const safeMetadata: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(params.metadata)) {
          if (/key|secret|signature|prompt|completion|password/i.test(k)) {
            safeMetadata[k] = "[REDACTED]";
          } else {
            safeMetadata[k] = v;
          }
        }
        metadataJson = JSON.stringify(safeMetadata);
      }

      await db.insert(auditLogs).values({
        userAddress: normalized,
        action: params.action,
        ipCountry: params.ipCountry ?? null,
        userAgentHash,
        metadataJson,
        createdAt: new Date(),
      });
    } catch (err) {
      console.warn(`[DbService] logAudit notice: ${(err as Error).message}`);
    }
  }

  /**
   * 11. Fetch epoch execution status (BE-EPOCH-009)
   */
  async getQuotaEpoch(epochDate: string): Promise<QuotaEpochRecord | null> {
    if (!this.hasDb()) return null;

    try {
      const [record] = await db
        .select()
        .from(quotaEpochs)
        .where(eq(quotaEpochs.epochDate, epochDate))
        .limit(1);

      return (record as QuotaEpochRecord) ?? null;
    } catch (err) {
      console.warn(`[DbService] getQuotaEpoch notice: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 12. Record start of daily epoch run (BE-EPOCH-009)
   */
  async startQuotaEpoch(params: {
    epochDate: string;
    snapshotBlock?: string;
    totalBudgetUsd?: number;
  }): Promise<void> {
    if (!this.hasDb()) return;

    try {
      await db
        .insert(quotaEpochs)
        .values({
          epochDate: params.epochDate,
          snapshotBlock: params.snapshotBlock ?? null,
          totalBudgetUsd: (params.totalBudgetUsd ?? 0).toFixed(4),
          totalAllocatedUsd: "0.0000",
          walletsCount: 0,
          status: "IN_PROGRESS",
          createdAt: new Date(),
        })
        .onConflictDoUpdate({
          target: quotaEpochs.epochDate,
          set: {
            status: "IN_PROGRESS",
            totalBudgetUsd: (params.totalBudgetUsd ?? 0).toFixed(4),
          },
        });
    } catch (err) {
      console.warn(`[DbService] startQuotaEpoch notice: ${(err as Error).message}`);
    }
  }

  /**
   * 13. Complete daily epoch run (BE-EPOCH-009)
   */
  async completeQuotaEpoch(params: {
    epochDate: string;
    totalAllocatedUsd: number;
    walletsCount: number;
  }): Promise<void> {
    if (!this.hasDb()) return;

    try {
      await db
        .update(quotaEpochs)
        .set({
          totalAllocatedUsd: params.totalAllocatedUsd.toFixed(4),
          walletsCount: params.walletsCount,
          status: "COMPLETED",
          completedAt: new Date(),
        })
        .where(eq(quotaEpochs.epochDate, params.epochDate));
    } catch (err) {
      console.warn(`[DbService] completeQuotaEpoch notice: ${(err as Error).message}`);
    }
  }

  /**
   * 14. Mark daily epoch run as failed (BE-EPOCH-009)
   */
  async failQuotaEpoch(epochDate: string): Promise<void> {
    if (!this.hasDb()) return;

    try {
      await db
        .update(quotaEpochs)
        .set({
          status: "FAILED",
        })
        .where(eq(quotaEpochs.epochDate, epochDate));
    } catch (err) {
      console.warn(`[DbService] failQuotaEpoch notice: ${(err as Error).message}`);
    }
  }

  /**
   * 15. Aggregate sum of allocated quota for a specific epoch (BE-EPOCH-010)
   */
  async getEpochQuotasAggregation(epochDate: string): Promise<{ totalAllocatedUsd: number; walletsCount: number }> {
    if (!this.hasDb()) return { totalAllocatedUsd: 0, walletsCount: 0 };

    try {
      const records = await db
        .select()
        .from(quotas)
        .where(eq(quotas.epochDate, epochDate));

      let sum = 0;
      for (const r of records) {
        sum += Number(r.allocatedUsd);
      }

      return {
        totalAllocatedUsd: Number(sum.toFixed(6)),
        walletsCount: records.length,
      };
    } catch (err) {
      console.warn(`[DbService] getEpochQuotasAggregation notice: ${(err as Error).message}`);
      return { totalAllocatedUsd: 0, walletsCount: 0 };
    }
  }

  /**
   * 16. Fetch recent completed epochs for rolling average calculations within 7-day window (GAP-007 / Brief §7)
   */
  async getRecentCompletedEpochs(limit = 7, beforeEpochDate?: string): Promise<QuotaEpochRecord[]> {
    if (!this.hasDb()) return [];

    try {
      const conditions = [eq(quotaEpochs.status, "COMPLETED")];

      if (beforeEpochDate) {
        const beforeTime = new Date(beforeEpochDate).getTime();
        if (!isNaN(beforeTime)) {
          const sevenDaysPrior = new Date(beforeTime - 7 * 86400 * 1000).toISOString().split("T")[0];
          conditions.push(sql`${quotaEpochs.epochDate} < ${beforeEpochDate}`);
          conditions.push(sql`${quotaEpochs.epochDate} >= ${sevenDaysPrior}`);
        }
      }

      const records = await db
        .select()
        .from(quotaEpochs)
        .where(and(...conditions))
        .orderBy(desc(quotaEpochs.epochDate))
        .limit(limit);

      return (records as QuotaEpochRecord[]) ?? [];
    } catch (err) {
      console.warn(`[DbService] getRecentCompletedEpochs notice: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * 17. Get total inference spend across all users for past N days (GAP-008 / Brief §5 & §7)
   */
  async getProtocolUsagePastDays(days = 7): Promise<number> {
    if (!this.hasDb()) return 0;

    try {
      const sinceDate = new Date(Date.now() - days * 86400 * 1000);
      const records = await db
        .select()
        .from(usageLogs)
        .where(sql`${usageLogs.createdAt} >= ${sinceDate}`);

      let total = 0;
      for (const r of records) {
        total += Number(r.costUsd || 0);
      }
      return Number(total.toFixed(6));
    } catch (err) {
      console.warn(`[DbService] getProtocolUsagePastDays notice: ${(err as Error).message}`);
      return 0;
    }
  }
}

export const dbService = new DbService();
