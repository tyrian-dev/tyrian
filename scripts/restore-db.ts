#!/usr/bin/env bun
import { backupService } from "../backend/src/services/backup";
import path from "node:path";
import fs from "node:fs/promises";

async function main() {
  console.log("=== Tyrian Protocol Cloud Operations: Database Disaster Recovery CLI (OPS-009) ===");

  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isVerifyOnly = args.includes("--verify");
  const isExecute = args.includes("--execute");

  const manifestArg = args.find((a) => !a.startsWith("--"));
  let manifestPath = manifestArg;

  // If no path specified, pick the most recent backup in backups/
  if (!manifestPath) {
    const backupsDir = path.resolve(process.cwd(), "backups");
    try {
      const files = await fs.readdir(backupsDir);
      const metaFiles = files.filter((f) => f.endsWith(".meta.json")).sort().reverse();
      if (metaFiles.length > 0) {
        manifestPath = path.join(backupsDir, metaFiles[0]);
        console.log(`[Recovery CLI] No manifest specified. Auto-selected latest backup: ${metaFiles[0]}`);
      } else {
        console.error("❌ No backup manifests found in backups/ directory.");
        process.exit(1);
      }
    } catch {
      console.error("❌ backups/ directory does not exist.");
      process.exit(1);
    }
  }

  console.log(`[Recovery CLI] Target Manifest: ${manifestPath}`);

  // 1. Verification phase
  console.log("[Recovery CLI] Verifying backup checksum and payload integrity...");
  const verifyResult = await backupService.verifyBackup(manifestPath);

  if (!verifyResult.valid) {
    console.error(`\n❌ Integrity verification FAILED: ${verifyResult.error}`);
    process.exit(1);
  }

  console.log("✅ Backup integrity verified 100%!");
  console.log(`- Backup ID:   ${verifyResult.manifest.backupId}`);
  console.log(`- Environment: ${verifyResult.manifest.environment}`);
  console.log(`- Created At:  ${verifyResult.manifest.createdAt}`);
  console.log(`- SHA-256:     ${verifyResult.manifest.sha256}`);
  console.log(`- Total Rows:  ${verifyResult.manifest.totalRows}`);

  if (isVerifyOnly) {
    console.log("\n[Recovery CLI] Verification complete (--verify flag supplied). Exiting.");
    process.exit(0);
  }

  // 2. Restore execution / Dry run
  const dryRun = !isExecute || isDryRun;
  console.log(`\n[Recovery CLI] Mode: ${dryRun ? "🔍 DRY-RUN SIMULATION" : "🚨 LIVE RESTORATION"}`);

  try {
    const result = await backupService.restoreBackup(manifestPath, { dryRun });
    if (dryRun) {
      console.log(`✅ Dry-run simulation completed! ${result.totalRestored} rows across ${result.tables.length} tables verified ready for restoration.`);
    } else {
      console.log(`✅ LIVE RESTORATION COMPLETED! ${result.totalRestored} rows successfully restored.`);
    }
    process.exit(0);
  } catch (err) {
    console.error("❌ Restoration failed:", err);
    process.exit(1);
  }
}

main();
