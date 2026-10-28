import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isAddress,
  type NetworkManifest,
} from "../../shared/contracts/addresses";

/**
 * Pure helpers behind `prepare-db.ts`.
 *
 * Ponder derives its own `build_id` from the resolved config, `ponder.schema.ts`
 * and the indexing handlers; a different build id means the existing Postgres
 * schema is rejected and Ponder 0.8 has no migration path. We cannot import
 * Ponder internals, so the guard keeps a fingerprint over exactly the inputs
 * that feed `ponder.config.ts`.
 *
 * Kept side-effect free so it can be unit tested without a database.
 */

export const FINGERPRINT_VERSION = "1";

/** Contracts registered in `indexer/ponder.config.ts`. Order is part of the hash. */
export const INDEXED_CONTRACTS = [
  "StakeManager",
  "FeeSplitter",
  "UsdgVault",
  "BuybackBurner",
  "TreasuryRouter",
] as const;

export interface FingerprintInputs {
  version: string;
  network: string;
  chainId: number;
  startBlock: number | null;
  contracts: Record<string, string | null>;
  stockVaults: string[];
  files: Record<string, string>;
}

export interface Fingerprint {
  hash: string;
  inputs: FingerprintInputs;
}

/**
 * Build the fingerprint payload from a manifest.
 *
 * Only fields the indexer actually reads are included: network name, chainId,
 * startBlock, the indexed contracts, and StockVault addresses. Fields such as
 * `contracts.TyrTwapOracle` or `external.uniswapPool` are deliberately ignored
 * so unrelated deploy work does not force a reindex.
 */
export function composeInputs(
  manifest: NetworkManifest,
  networkName: string,
  files: Record<string, string>,
): FingerprintInputs {
  const contracts: Record<string, string | null> = {};
  for (const name of INDEXED_CONTRACTS) {
    contracts[name] = manifest.contracts[name] ?? null;
  }

  const stockVaults = Object.values(manifest.stocks)
    .map((stock) => stock.vault)
    .filter(isAddress)
    .map((vault) => vault.toLowerCase())
    .sort();

  return {
    version: FINGERPRINT_VERSION,
    network: networkName,
    chainId: manifest.chainId,
    startBlock: manifest.startBlock,
    contracts,
    stockVaults,
    files,
  };
}

export function hashInputs(inputs: FingerprintInputs): string {
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
}

/** Normalize line endings so a CRLF checkout is not mistaken for a code change. */
export function hashSourceFile(absolutePath: string): string {
  const content = fs.readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(content).digest("hex");
}

export function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(absolute));
      continue;
    }
    if (entry.isFile() && /\.(ts|tsx|js|json)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

/** Hash `ponder.config.ts`, `ponder.schema.ts` and every file under `src/`. */
export function collectFileHashes(indexerRoot: string): Record<string, string> {
  const sources = [
    path.join(indexerRoot, "ponder.config.ts"),
    path.join(indexerRoot, "ponder.schema.ts"),
    ...listSourceFiles(path.join(indexerRoot, "src")),
  ].sort();

  const files: Record<string, string> = {};
  for (const absolute of sources) {
    if (!fs.existsSync(absolute)) continue;
    files[path.relative(indexerRoot, absolute).split(path.sep).join("/")] =
      hashSourceFile(absolute);
  }
  return files;
}

export function buildFingerprint(
  indexerRoot: string,
  networkName: string,
  manifest: NetworkManifest,
): Fingerprint {
  const inputs = composeInputs(manifest, networkName, collectFileHashes(indexerRoot));
  return { hash: hashInputs(inputs), inputs };
}

/** Field-level diff between two stored fingerprints, used for operator logs. */
export function describeChanges(
  previous: FingerprintInputs | null,
  current: FingerprintInputs,
): string[] {
  if (!previous) return ["no stored fingerprint (schema created before the guard existed)"];

  const changes: string[] = [];
  for (const key of ["version", "network", "chainId", "startBlock"] as const) {
    if (previous[key] !== current[key]) {
      changes.push(`${key}: ${String(previous[key])} -> ${String(current[key])}`);
    }
  }
  const previousContracts = previous.contracts ?? {};
  for (const name of INDEXED_CONTRACTS) {
    const before = previousContracts[name] ?? null;
    const after = current.contracts[name] ?? null;
    if (before !== after) changes.push(`contracts.${name}: ${before} -> ${after}`);
  }
  if (JSON.stringify(previous.stockVaults) !== JSON.stringify(current.stockVaults)) {
    changes.push(
      `stockVaults: [${(previous.stockVaults ?? []).join(", ")}] -> [${current.stockVaults.join(", ")}]`,
    );
  }
  const previousFiles = previous.files ?? {};
  for (const file of new Set([...Object.keys(previousFiles), ...Object.keys(current.files)])) {
    const before = previousFiles[file] ?? "missing";
    const after = current.files[file] ?? "missing";
    if (before !== after) changes.push(`file ${file}`);
  }
  if (changes.length === 0) changes.push("fingerprint hash differs (serialization version?)");
  return changes;
}
