import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

export interface BackupManifest {
  backupId: string;
  createdAt: string;
  environment: string;
  schemas: string[];
  tables: Record<string, number>;
  totalRows: number;
  sha256: string;
  dumpFile: string;
  sizeBytes: number;
  version: "1.0.0";
}

export interface BackupOptions {
  outDir?: string;
  schemas?: string[];
  databaseUrl?: string;
}

export interface RestoreOptions {
  databaseUrl?: string;
  dryRun?: boolean;
}

export class BackupService {
  /**
   * Sanitizes database URL by masking password
   */
  sanitizeUrl(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.password) {
        parsed.password = "******";
      }
      return parsed.toString();
    } catch {
      return "postgres://[REDACTED]";
    }
  }

  /**
   * Generates SHA-256 checksum of a buffer or string
   */
  calculateChecksum(content: Buffer | string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /**
   * Creates a structured snapshot backup of PostgreSQL schemas and records manifest
   */
  async createBackup(options: BackupOptions = {}): Promise<BackupManifest> {
    const databaseUrl =
      options.databaseUrl ||
      process.env.DATABASE_URL ||
      "postgres://postgres:postgres@localhost:5432/tyrian";
    const schemas = options.schemas && options.schemas.length > 0 ? options.schemas : ["public", "ponder"];
    const outDir = options.outDir || path.resolve(process.cwd(), "backups");

    await fs.mkdir(outDir, { recursive: true });

    const sql = postgres(databaseUrl, { max: 1, idle_timeout: 10 });
    const backupId = `bkp_${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomBytes(3).toString("hex")}`;
    const dumpFileName = `${backupId}.dump.json`;
    const metaFileName = `${backupId}.meta.json`;
    const dumpFilePath = path.join(outDir, dumpFileName);
    const metaFilePath = path.join(outDir, metaFileName);

    try {
      // 1. Discover all tables in requested schemas
      const tablesQuery = await sql<{ table_schema: string; table_name: string }[]>`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_schema = ANY(${schemas})
          AND table_type = 'BASE TABLE'
        ORDER BY table_schema, table_name;
      `;

      const dumpData: Record<string, unknown[]> = {};
      const tableCounts: Record<string, number> = {};
      let totalRows = 0;

      // 2. Fetch rows per table
      for (const row of tablesQuery) {
        const fullTableName = `"${row.table_schema}"."${row.table_name}"`;
        const key = `${row.table_schema}.${row.table_name}`;
        try {
          const rows = await sql.unsafe<unknown[]>(`SELECT * FROM ${fullTableName}`);
          dumpData[key] = rows;
          tableCounts[key] = rows.length;
          totalRows += rows.length;
        } catch (tableErr) {
          console.warn(`[BackupService] Warning: Could not dump table ${key}:`, tableErr);
          dumpData[key] = [];
          tableCounts[key] = 0;
        }
      }

      // 3. Serialize dump data
      const serialized = JSON.stringify(
        {
          backupId,
          createdAt: new Date().toISOString(),
          environment: process.env.APP_ENV || process.env.TYRIAN_NETWORK || "testnet",
          database: this.sanitizeUrl(databaseUrl),
          tables: dumpData,
        },
        null,
        2,
      );

      const buffer = Buffer.from(serialized, "utf-8");
      const sha256 = this.calculateChecksum(buffer);

      await fs.writeFile(dumpFilePath, buffer);

      // 4. Construct manifest
      const manifest: BackupManifest = {
        backupId,
        createdAt: new Date().toISOString(),
        environment: process.env.APP_ENV || process.env.TYRIAN_NETWORK || "testnet",
        schemas,
        tables: tableCounts,
        totalRows,
        sha256,
        dumpFile: dumpFileName,
        sizeBytes: buffer.length,
        version: "1.0.0",
      };

      await fs.writeFile(metaFilePath, JSON.stringify(manifest, null, 2), "utf-8");
      console.log(`[BackupService] Backup ${backupId} completed successfully. Total rows: ${totalRows}, SHA-256: ${sha256}`);

      return manifest;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  /**
   * Verifies the SHA-256 checksum and integrity of a backup manifest and dump file
   */
  async verifyBackup(manifestPath: string): Promise<{ valid: boolean; manifest: BackupManifest; error?: string }> {
    const rawMeta = await fs.readFile(manifestPath, "utf-8");
    const manifest: BackupManifest = JSON.parse(rawMeta);

    const dir = path.dirname(manifestPath);
    const dumpPath = path.join(dir, manifest.dumpFile);

    try {
      const dumpBuffer = await fs.readFile(dumpPath);
      const computedSha256 = this.calculateChecksum(dumpBuffer);

      if (computedSha256 !== manifest.sha256) {
        return {
          valid: false,
          manifest,
          error: `Checksum mismatch! Expected ${manifest.sha256}, got ${computedSha256}`,
        };
      }

      const parsedDump = JSON.parse(dumpBuffer.toString("utf-8"));
      if (!parsedDump.tables) {
        return { valid: false, manifest, error: "Dump file does not contain valid tables payload" };
      }

      return { valid: true, manifest };
    } catch (err: unknown) {
      return {
        valid: false,
        manifest,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Restores a verified backup into PostgreSQL (supports dry-run)
   */
  async restoreBackup(
    manifestPath: string,
    options: RestoreOptions = {},
  ): Promise<{ success: boolean; dryRun: boolean; totalRestored: number; tables: string[]; error?: string }> {
    const verification = await this.verifyBackup(manifestPath);
    if (!verification.valid) {
      throw new Error(`Cannot restore corrupted backup: ${verification.error}`);
    }

    const { manifest } = verification;
    const tables = Object.keys(manifest.tables);

    if (options.dryRun) {
      return {
        success: true,
        dryRun: true,
        totalRestored: manifest.totalRows,
        tables,
      };
    }

    const databaseUrl =
      options.databaseUrl ||
      process.env.DATABASE_URL ||
      "postgres://postgres:postgres@localhost:5432/tyrian";

    const dir = path.dirname(manifestPath);
    const dumpPath = path.join(dir, manifest.dumpFile);
    const dumpBuffer = await fs.readFile(dumpPath, "utf-8");
    const parsedDump = JSON.parse(dumpBuffer);

    const sql = postgres(databaseUrl, { max: 1 });
    let totalRestored = 0;

    try {
      for (const [tableKey, rows] of Object.entries(parsedDump.tables as Record<string, Array<Record<string, unknown>>>)) {
        if (!rows || rows.length === 0) continue;
        const [schema, tableName] = tableKey.split(".");

        // Insert rows with ON CONFLICT DO NOTHING
        for (const row of rows) {
          const columns = Object.keys(row);
          if (columns.length === 0) continue;

          await sql`
            INSERT INTO ${sql(`${schema}.${tableName}`)} ${sql(row)}
            ON CONFLICT DO NOTHING
          `;
          totalRestored++;
        }
      }

      return {
        success: true,
        dryRun: false,
        totalRestored,
        tables,
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

export const backupService = new BackupService();
