import {
  pgTable,
  text,
  timestamp,
  boolean,
  numeric,
  integer,
  serial,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  address: text("address").primaryKey(),
  tosSignedAt: timestamp("tos_signed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  userAddress: text("user_address").notNull().references(() => users.address),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(), // SHA-256 hash of tyr_live_...
  keyPrefix: text("key_prefix").notNull(),     // e.g. tyr_live_••••a9f2
  orKeyHash: text("or_key_hash"),              // OpenRouter encrypted sub-key hash
  isRevoked: boolean("is_revoked").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const quotas = pgTable("quotas", {
  id: serial("id").primaryKey(),
  userAddress: text("user_address").notNull().references(() => users.address),
  epochDate: text("epoch_date").notNull(), // YYYY-MM-DD
  allocatedUsd: numeric("allocated_usd", { precision: 12, scale: 6 }).default("0").notNull(),
  usedUsd: numeric("used_usd", { precision: 12, scale: 6 }).default("0").notNull(),
  boostMultiplier: numeric("boost_multiplier", { precision: 4, scale: 2 }).default("1.00").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Privacy rule: No prompt or completion text stored, strictly metadata only
export const usageLogs = pgTable("usage_logs", {
  id: serial("id").primaryKey(),
  userAddress: text("user_address").notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").notNull(),
  completionTokens: integer("completion_tokens").notNull(),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
  latencyMs: integer("latency_ms").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const treasurySnapshots = pgTable("treasury_snapshots", {
  id: serial("id").primaryKey(),
  epochDate: text("epoch_date").notNull(),
  harvestedYieldUsd: numeric("harvested_yield_usd", { precision: 14, scale: 4 }).default("0").notNull(),
  creatorFeesUsd: numeric("creator_fees_usd", { precision: 14, scale: 4 }).default("0").notNull(),
  dailyQuotaBudgetUsd: numeric("daily_quota_budget_usd", { precision: 14, scale: 4 }).default("0").notNull(),
  inferenceCostUsd: numeric("inference_cost_usd", { precision: 14, scale: 4 }).default("0").notNull(),
  totalBurnedTyr: text("total_burned_tyr").default("0").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Persistent audit log for sensitive mutations (BE-AUTH-009)
// Privacy rule: No raw API keys, private keys, SIWE signatures, or prompt/completion bodies stored
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userAddress: text("user_address").notNull(),
  action: text("action").notNull(), // e.g. AUTH_VERIFY, AUTH_LOGOUT, SESSIONS_REVOKE, KEY_CREATE, KEY_ROTATE, KEY_REVOKE, TERMS_ACCEPT
  ipCountry: text("ip_country"),
  userAgentHash: text("user_agent_hash"),
  metadataJson: text("metadata_json"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Idempotent daily epoch settlement tracker (BE-EPOCH-009)
export const quotaEpochs = pgTable("quota_epochs", {
  id: serial("id").primaryKey(),
  epochDate: text("epoch_date").notNull().unique(), // e.g. "2026-10-28"
  snapshotBlock: text("snapshot_block"),
  totalBudgetUsd: numeric("total_budget_usd", { precision: 14, scale: 4 }).default("0").notNull(),
  totalAllocatedUsd: numeric("total_allocated_usd", { precision: 14, scale: 4 }).default("0").notNull(),
  walletsCount: integer("wallets_count").default(0).notNull(),
  status: text("status").notNull().default("IN_PROGRESS"), // IN_PROGRESS | COMPLETED | FAILED
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});
