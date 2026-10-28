import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { backupService, type BackupManifest } from "../src/services/backup";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("Tyrian Database Backup & Disaster Recovery Suite (OPS-009)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tyrian-backup-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("calculates exact SHA-256 checksums", () => {
    const data = "Tyrian Protocol Decentralized AI Inference";
    const checksum = backupService.calculateChecksum(data);
    expect(checksum).toBeDefined();
    expect(checksum.length).toBe(64); // SHA-256 hex string is 64 characters
    expect(backupService.calculateChecksum(data)).toBe(checksum);
  });

  it("sanitizes sensitive credentials from database URLs", () => {
    const raw = "postgres://tyrian_admin:superSecret123@postgres.railway.internal:5432/railway";
    const sanitized = backupService.sanitizeUrl(raw);
    expect(sanitized).not.toContain("superSecret123");
    expect(sanitized).toContain("******");
    expect(sanitized).toContain("tyrian_admin");
  });

  it("creates a valid backup manifest and data dump", async () => {
    const manifest = await backupService.createBackup({
      outDir: tempDir,
      schemas: ["public"],
    });

    expect(manifest).toBeDefined();
    expect(manifest.backupId).toMatch(/^bkp_/);
    expect(manifest.schemas).toContain("public");
    expect(typeof manifest.totalRows).toBe("number");
    expect(manifest.sha256.length).toBe(64);
    expect(manifest.sizeBytes).toBeGreaterThan(0);

    // Verify files exist on disk
    const dumpPath = path.join(tempDir, manifest.dumpFile);
    const metaPath = path.join(tempDir, `${manifest.backupId}.meta.json`);

    const dumpExists = await fs.stat(dumpPath).then(() => true).catch(() => false);
    const metaExists = await fs.stat(metaPath).then(() => true).catch(() => false);

    expect(dumpExists).toBe(true);
    expect(metaExists).toBe(true);
  });

  it("verifies backup integrity with SHA-256 validation", async () => {
    const manifest = await backupService.createBackup({
      outDir: tempDir,
      schemas: ["public"],
    });

    const metaPath = path.join(tempDir, `${manifest.backupId}.meta.json`);
    const verification = await backupService.verifyBackup(metaPath);

    expect(verification.valid).toBe(true);
    expect(verification.manifest.backupId).toBe(manifest.backupId);
    expect(verification.manifest.sha256).toBe(manifest.sha256);
  });

  it("fails closed when backup data has been tampered with or corrupted", async () => {
    const manifest = await backupService.createBackup({
      outDir: tempDir,
      schemas: ["public"],
    });

    const dumpPath = path.join(tempDir, manifest.dumpFile);
    const metaPath = path.join(tempDir, `${manifest.backupId}.meta.json`);

    // Tamper with the dump file
    await fs.appendFile(dumpPath, "\n-- MALICIOUS_INJECTION --");

    const verification = await backupService.verifyBackup(metaPath);

    expect(verification.valid).toBe(false);
    expect(verification.error).toContain("Checksum mismatch");
  });

  it("performs safe dry-run restore simulation without modifying data", async () => {
    const manifest = await backupService.createBackup({
      outDir: tempDir,
      schemas: ["public"],
    });

    const metaPath = path.join(tempDir, `${manifest.backupId}.meta.json`);
    const restoreResult = await backupService.restoreBackup(metaPath, { dryRun: true });

    expect(restoreResult.success).toBe(true);
    expect(restoreResult.dryRun).toBe(true);
    expect(restoreResult.totalRestored).toBe(manifest.totalRows);
    expect(restoreResult.tables.length).toBeGreaterThanOrEqual(1);
  });
});
