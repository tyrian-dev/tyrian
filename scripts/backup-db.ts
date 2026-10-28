#!/usr/bin/env bun
import { backupService } from "../backend/src/services/backup";
import path from "node:path";

async function main() {
  console.log("=== Tyrian Protocol Cloud Operations: Database Backup CLI (OPS-009) ===");

  const args = process.argv.slice(2);
  const schemaArg = args.find((a) => a.startsWith("--schema="));
  const schemas = schemaArg ? schemaArg.replace("--schema=", "").split(",") : ["public", "ponder"];

  const outDir = path.resolve(process.cwd(), "backups");

  console.log(`[Backup CLI] Target schemas: ${schemas.join(", ")}`);
  console.log(`[Backup CLI] Output directory: ${outDir}`);

  const start = Date.now();
  try {
    const manifest = await backupService.createBackup({ schemas, outDir });
    const duration = Date.now() - start;

    console.log("\n✅ Backup completed successfully!");
    console.log(`- Backup ID:   ${manifest.backupId}`);
    console.log(`- Total Rows:  ${manifest.totalRows}`);
    console.log(`- File Size:   ${(manifest.sizeBytes / 1024).toFixed(2)} KB`);
    console.log(`- SHA-256:     ${manifest.sha256}`);
    console.log(`- Manifest:    ${path.join(outDir, `${manifest.backupId}.meta.json`)}`);
    console.log(`- Duration:    ${duration} ms`);
    console.log("\nTable Breakdown:");
    for (const [table, count] of Object.entries(manifest.tables)) {
      console.log(`  • ${table.padEnd(30)} : ${count} rows`);
    }

    process.exit(0);
  } catch (err) {
    console.error("\n❌ Backup failed with error:", err);
    process.exit(1);
  }
}

main();
