import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  getNetworkManifest,
  resolveNetworkName,
} from "../../shared/contracts/addresses";
import {
  buildFingerprint,
  describeChanges,
  type Fingerprint,
  type FingerprintInputs,
} from "./fingerprint";

/**
 * Ponder schema guard.
 *
 * `ponder start` refuses to reuse a Postgres schema created by a different
 * build (`NonRetryableError: Schema '<x>' was previously used by a different
 * Ponder app`). Ponder derives that build id from the resolved config, the
 * schema file and the indexing handlers, and 0.8 has no migrations, so any
 * change means a full reindex.
 *
 * Railway runs `bun run start` on every deploy, which becomes a crash loop
 * (10 restarts, then "Crashed") because the error is deterministic. This guard
 * runs before Ponder and either:
 * - lets the start continue when the indexer inputs did not change;
 * - drops the schema automatically when `PONDER_AUTO_RESET=1` (testnet);
 * - fails with an actionable message instead of an opaque Ponder stack.
 *
 * The fingerprint lives in `tyrian_indexer_meta`, a table owned by this script.
 * Ponder's own `_ponder_meta` is only read, never written, so the guard cannot
 * corrupt Ponder's bookkeeping. See `fingerprint.ts` for what is hashed.
 *
 * Usage:
 *   bun scripts/prepare-db.ts              # guard, then Ponder starts
 *   bun scripts/prepare-db.ts --check      # report only, never writes
 *   bun scripts/prepare-db.ts --print      # print fingerprint inputs, no DB
 *   bun scripts/prepare-db.ts --reset      # force drop schema + reindex
 *
 * Env:
 *   DATABASE_URL       required for DB modes (skipped when absent)
 *   DATABASE_SCHEMA    schema name; must match the `--schema` flag of Ponder
 *   INDEXER_NETWORK    testnet | mainnet (falls back to TYRIAN_NETWORK/APP_ENV)
 *   PONDER_AUTO_RESET  1/true enables automatic drop on mismatch
 */

const GUARD_TABLE = "tyrian_indexer_meta";
const PONDER_META_TABLE = "_ponder_meta";
const FINGERPRINT_KEY = "fingerprint";
const DEFAULT_SCHEMA = "ponder";
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

const INDEXER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const hasFlag = (flag: string) => argv.includes(flag);
const flagValue = (flag: string) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

const printOnly = hasFlag("--print");
const checkOnly = hasFlag("--check");
const forceReset = hasFlag("--reset");
const autoReset = ["1", "true", "yes"].includes(
  (process.env.PONDER_AUTO_RESET ?? "").trim().toLowerCase(),
);

function log(message: string) {
  console.log(`[prepare-db] ${message}`);
}

function fail(message: string): never {
  console.error(`[prepare-db] ERROR: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// schema name
// ---------------------------------------------------------------------------

function resolveSchemaName(): string {
  const fromFlag = flagValue("--schema")?.trim();
  const fromEnv = process.env.DATABASE_SCHEMA?.trim();

  if (fromFlag && fromEnv && fromFlag !== fromEnv) {
    fail(
      `Schema conflict: --schema ${fromFlag} but DATABASE_SCHEMA=${fromEnv}. ` +
        "Ponder (CLI flag) and this guard (env) would target different schemas. " +
        "Make both values identical.",
    );
  }

  const schema = fromFlag || fromEnv || DEFAULT_SCHEMA;
  if (!SCHEMA_PATTERN.test(schema)) {
    fail(`Invalid schema name '${schema}'. Use lowercase letters, digits and underscores.`);
  }
  if (schema === "public") {
    fail(
      "Refusing to manage the 'public' schema: the backend owns it. " +
        "Use an isolated schema such as 'ponder'.",
    );
  }
  return schema;
}

// ---------------------------------------------------------------------------
// database helpers
// ---------------------------------------------------------------------------

interface StoredFingerprint {
  hash: string;
  inputs: FingerprintInputs;
  recordedAt: string;
}

interface PonderAppMeta {
  build_id?: string;
  is_locked?: number;
  checkpoint?: string;
}

function quoteIdentifier(schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) fail(`Invalid schema name '${schema}'.`);
  return `"${schema}"`;
}

async function schemaExists(client: Client, schema: string): Promise<boolean> {
  const result = await client.query(
    "select 1 from information_schema.schemata where schema_name = $1",
    [schema],
  );
  return (result.rowCount ?? 0) === 1;
}

async function tableExists(client: Client, schema: string, table: string): Promise<boolean> {
  const result = await client.query(
    "select 1 from information_schema.tables where table_schema = $1 and table_name = $2",
    [schema, table],
  );
  return (result.rowCount ?? 0) === 1;
}

async function ensureGuardTable(client: Client, schema: string) {
  await client.query(
    `create table if not exists ${quoteIdentifier(schema)}.${GUARD_TABLE} ` +
      "(key text primary key, value jsonb, updated_at timestamptz not null default now())",
  );
}

async function readStoredFingerprint(
  client: Client,
  schema: string,
): Promise<StoredFingerprint | null> {
  if (!(await tableExists(client, schema, GUARD_TABLE))) return null;
  const result = await client.query<{ value: StoredFingerprint }>(
    `select value from ${quoteIdentifier(schema)}.${GUARD_TABLE} where key = $1`,
    [FINGERPRINT_KEY],
  );
  return result.rows[0]?.value ?? null;
}

async function writeStoredFingerprint(
  client: Client,
  schema: string,
  fingerprint: Fingerprint,
) {
  const stored: StoredFingerprint = {
    hash: fingerprint.hash,
    inputs: fingerprint.inputs,
    recordedAt: new Date().toISOString(),
  };
  await ensureGuardTable(client, schema);
  await client.query(
    `insert into ${quoteIdentifier(schema)}.${GUARD_TABLE} (key, value) values ($1, $2::jsonb) ` +
      "on conflict (key) do update set value = excluded.value, updated_at = now()",
    [FINGERPRINT_KEY, JSON.stringify(stored)],
  );
}

/** Read-only: Ponder's own metadata, used to report the previous build id. */
async function readPonderApp(
  client: Client,
  schema: string,
): Promise<PonderAppMeta | null> {
  if (!(await tableExists(client, schema, PONDER_META_TABLE))) return null;
  const result = await client.query<{ value: PonderAppMeta }>(
    `select value from ${quoteIdentifier(schema)}.${PONDER_META_TABLE} where key = 'app'`,
  );
  return result.rows[0]?.value ?? null;
}

async function dropSchema(client: Client, schema: string) {
  await client.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
}

async function createSchema(client: Client, schema: string) {
  await client.query(`create schema if not exists ${quoteIdentifier(schema)}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const networkName = resolveNetworkName(
    process.env.INDEXER_NETWORK ?? process.env.TYRIAN_NETWORK ?? process.env.APP_ENV,
  );
  const manifest = getNetworkManifest(networkName);
  const fingerprint = buildFingerprint(INDEXER_ROOT, networkName, manifest);

  if (printOnly) {
    console.log(JSON.stringify({ hash: fingerprint.hash, inputs: fingerprint.inputs }, null, 2));
    return;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    log("DATABASE_URL is not set (PGlite/dev) — schema guard skipped.");
    return;
  }

  const schema = resolveSchemaName();
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "tyrian-prepare-db",
    statement_timeout: 120_000,
  });

  try {
    await client.connect();
  } catch (error) {
    fail(
      `Cannot connect to DATABASE_URL: ${(error as Error).message}. ` +
        "The indexer cannot start until Postgres is reachable.",
    );
  }

  try {
    log(`schema=${schema} fingerprint=${fingerprint.hash}${checkOnly ? " mode=check" : ""}`);

    if (!(await schemaExists(client, schema))) {
      if (checkOnly) {
        log("schema does not exist yet — a fresh start would be safe.");
        return;
      }
      await createSchema(client, schema);
      await writeStoredFingerprint(client, schema, fingerprint);
      log(`created schema '${schema}' with a fresh fingerprint.`);
      return;
    }

    const stored = await readStoredFingerprint(client, schema);
    const app = await readPonderApp(client, schema);

    if (!app) {
      // Ponder treats this as a brand new app: it will create its own tables.
      if (checkOnly) {
        log(
          stored
            ? `schema '${schema}' holds no Ponder app; stored fingerprint ${stored.hash}.`
            : `schema '${schema}' holds no Ponder app — safe to start.`,
        );
        return;
      }
      if (stored?.hash === fingerprint.hash) {
        log("no previous Ponder app found — fingerprint already up to date.");
      } else {
        await writeStoredFingerprint(client, schema, fingerprint);
        log("no previous Ponder app found — fingerprint recorded.");
      }
      return;
    }

    if (stored?.hash === fingerprint.hash) {
      log(
        `fingerprint matches (ponder build_id=${app.build_id ?? "unknown"}) — keeping existing data.`,
      );
      return;
    }

    const changes = describeChanges(stored?.inputs ?? null, fingerprint.inputs);
    const summary = changes.map((change) => `  - ${change}`).join("\n");

    if (checkOnly) {
      fail(
        `indexer inputs changed; Ponder would refuse to reuse schema '${schema}'.\n` +
          `ponder build_id=${app.build_id ?? "unknown"}, stored fingerprint=${stored?.hash ?? "none"}.\n` +
          `${summary}\n` +
          "Run 'bun run --cwd indexer reset-db' to drop the schema and reindex.",
      );
    }

    if (!forceReset && !autoReset) {
      fail(
        `indexer inputs changed; Ponder would refuse to reuse schema '${schema}'.\n` +
          `ponder build_id=${app.build_id ?? "unknown"}, stored fingerprint=${stored?.hash ?? "none"}.\n` +
          `${summary}\n` +
          "Ponder 0.8 has no migrations: the schema must be dropped and reindexed from " +
          "startBlock.\n" +
          "  - Automatic (recommended on testnet): set PONDER_AUTO_RESET=1\n" +
          "  - Manual: bun run --cwd indexer reset-db\n" +
          "See docs/runbooks/RUN-006-indexer-recovery.md.",
      );
    }

    log(
      `${forceReset ? "--reset" : "PONDER_AUTO_RESET=1"} → dropping schema '${schema}' ` +
        `(reindex from startBlock ${fingerprint.inputs.startBlock ?? "?"}):`,
    );
    for (const change of changes) log(`  - ${change}`);
    await dropSchema(client, schema);
    await createSchema(client, schema);
    await writeStoredFingerprint(client, schema, fingerprint);
    log(`schema '${schema}' recreated; Ponder will backfill from startBlock.`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

await main();
