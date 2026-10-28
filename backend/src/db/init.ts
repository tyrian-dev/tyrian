import "dotenv/config";
import { Client } from "pg";

export async function initPostgresDatabase(): Promise<boolean> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log("[Database] DATABASE_URL not set. Skipping Postgres initialization.");
    return false;
  }

  try {
    // 1. Parse URL to connect to the 'postgres' maintenance database first
    const parsed = new URL(dbUrl);
    const targetDb = parsed.pathname.replace(/^\//, "") || "tyrian";

    parsed.pathname = "/postgres";
    const maintenanceClient = new Client({ connectionString: parsed.toString() });

    try {
      await maintenanceClient.connect();
      const checkRes = await maintenanceClient.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [targetDb],
      );

      if (checkRes.rowCount === 0) {
        console.log(`[Database] Database '${targetDb}' does not exist. Creating...`);
        await maintenanceClient.query(`CREATE DATABASE "${targetDb}"`);
        console.log(`[Database] Database '${targetDb}' created successfully!`);
      }
    } catch (err) {
      console.warn(`[Database] Notice: could not check maintenance db: ${(err as Error).message}`);
    } finally {
      await maintenanceClient.end().catch(() => {});
    }

    // 2. Connect to the target database and ensure schema tables exist
    const client = new Client({ connectionString: dbUrl });
    await client.connect();

    console.log(`[Database] Connected to PostgreSQL '${targetDb}'. Initializing tables...`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        address TEXT PRIMARY KEY,
        tos_signed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_address TEXT NOT NULL REFERENCES users(address),
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        or_key_hash TEXT,
        is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS quotas (
        id SERIAL PRIMARY KEY,
        user_address TEXT NOT NULL REFERENCES users(address),
        epoch_date TEXT NOT NULL,
        allocated_usd NUMERIC(12, 6) NOT NULL DEFAULT '0',
        used_usd NUMERIC(12, 6) NOT NULL DEFAULT '0',
        boost_multiplier NUMERIC(4, 2) NOT NULL DEFAULT '1.00',
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS usage_logs (
        id SERIAL PRIMARY KEY,
        user_address TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cost_usd NUMERIC(12, 6) NOT NULL,
        latency_ms INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS treasury_snapshots (
        id SERIAL PRIMARY KEY,
        epoch_date TEXT NOT NULL,
        harvested_yield_usd NUMERIC(14, 4) NOT NULL DEFAULT '0',
        creator_fees_usd NUMERIC(14, 4) NOT NULL DEFAULT '0',
        daily_quota_budget_usd NUMERIC(14, 4) NOT NULL DEFAULT '0',
        inference_cost_usd NUMERIC(14, 4) NOT NULL DEFAULT '0',
        total_burned_tyr TEXT NOT NULL DEFAULT '0',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_address TEXT NOT NULL,
        action TEXT NOT NULL,
        ip_country TEXT,
        user_agent_hash TEXT,
        metadata_json TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS quota_epochs (
        id SERIAL PRIMARY KEY,
        epoch_date TEXT NOT NULL UNIQUE,
        snapshot_block TEXT,
        total_budget_usd NUMERIC(14, 4) NOT NULL DEFAULT '0',
        total_allocated_usd NUMERIC(14, 4) NOT NULL DEFAULT '0',
        wallets_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_address);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_quotas_user_epoch ON quotas(user_address, epoch_date);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_address);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_quota_epochs_date ON quota_epochs(epoch_date);
    `);

    console.log("[Database] All PostgreSQL tables and indexes are ready!");
    await client.end();
    return true;
  } catch (err) {
    console.warn(`[Database] PostgreSQL initialization failed: ${(err as Error).message}`);
    return false;
  }
}

if (import.meta.main) {
  initPostgresDatabase().then((ok) => {
    if (ok) process.exit(0);
    else process.exit(1);
  });
}
