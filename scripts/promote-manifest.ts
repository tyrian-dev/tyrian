import fs from "node:fs";
import path from "node:path";
import { isAddress, networkManifests } from "../shared/contracts/addresses";

/**
 * Promote a deployment artifact into config/networks/mainnet.json.
 *
 * The runner never edits the manifest itself: only this script writes it, only
 * with `--apply`, and only after every required address is present and valid.
 *
 * Verification status:
 * - default writes `verification: "pending"` because source verification has not
 *   been checked by this script.
 * - `--verified` writes `"verified"` and stamps `deployment.verifiedAt`. Use it
 *   only after every address is confirmed in the explorer.
 *
 * Usage:
 *   bun scripts/promote-manifest.ts            # preview the diff
 *   bun scripts/promote-manifest.ts --apply    # write verification: pending
 *   bun scripts/promote-manifest.ts --apply --verified
 */

const ROOT = process.cwd();
const ARTIFACT = path.join(ROOT, "deployments", "mainnet-latest.json");
const MANIFEST_PATH = path.join(ROOT, "config", "networks", "mainnet.json");

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const markVerified = argv.includes("--verified");

const REQUIRED_CONTRACTS = [
  "StakeManager",
  "UsdgVault",
  "FeeSplitter",
  "BuybackBurner",
  "TreasuryRouter",
  "PortfolioVault",
  // BUD-003: the epoch job prices TYR through this oracle. Promoting a manifest
  // without it would leave TYR stakers with an unsupported price at 00:00 UTC.
  "TyrTwapOracle",
] as const;

interface StockArtifact {
  address: string | null;
  feed: string | null;
  oracle: string | null;
  vault: string | null;
}

interface DeploymentArtifact {
  network: string;
  chainId: number;
  createdAt: string;
  startBlock: number | null;
  contracts: Record<string, string | null>;
  tokens: Record<string, string | null>;
  external: Record<string, string | null>;
  stocks: Record<string, StockArtifact>;
  scripts: Record<string, { txHash: string | null; blockNumber: number | null }>;
}

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function readArtifact(): DeploymentArtifact {
  if (!fs.existsSync(ARTIFACT)) {
    fail(
      `Deployment artifact not found at ${path.relative(ROOT, ARTIFACT)}. ` +
        "Run the guarded deploy runner with --broadcast first.",
    );
  }
  return JSON.parse(fs.readFileSync(ARTIFACT, "utf-8")) as DeploymentArtifact;
}

const artifact = readArtifact();
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));

const problems: string[] = [];

function requireAddress(label: string, value: string | null | undefined) {
  if (!isAddress(value)) problems.push(`${label} (${value ?? "null"})`);
}

if (artifact.chainId !== manifest.chainId) {
  problems.push(`artifact chainId ${artifact.chainId} != manifest chainId ${manifest.chainId}`);
}
if (!artifact.startBlock || artifact.startBlock <= 0) {
  problems.push("artifact.startBlock (must be the first deploy block, not 0)");
}
for (const contract of REQUIRED_CONTRACTS) {
  requireAddress(`contracts.${contract}`, artifact.contracts[contract]);
}

// Tokens and Safe addresses are verified before deployment, so the artifact
// only cross-checks them. A mismatch means the deploy ran against a different
// configuration than the manifest records.
for (const token of ["USDG", "TYR", "WETH"] as const) {
  const fromArtifact = artifact.tokens[token];
  const fromManifest = manifest.tokens[token].address;
  if (fromArtifact && fromManifest && fromArtifact.toLowerCase() !== fromManifest.toLowerCase()) {
    problems.push(`tokens.${token} artifact ${fromArtifact} != manifest ${fromManifest}`);
  }
  if (!fromArtifact && !fromManifest) {
    problems.push(`tokens.${token}.address`);
  }
}

for (const [ticker, deployed] of Object.entries(artifact.stocks)) {
  if (!manifest.stocks[ticker]) {
    problems.push(`stocks.${ticker} not present in the manifest`);
    continue;
  }
  requireAddress(`stocks.${ticker}.address`, deployed.address);
  requireAddress(`stocks.${ticker}.feed`, deployed.feed);
  requireAddress(`stocks.${ticker}.oracle`, deployed.oracle);
  requireAddress(`stocks.${ticker}.vault`, deployed.vault);
}

if (problems.length > 0) {
  fail(
    "Deployment artifact is incomplete:\n" +
      problems.map((problem) => `   - ${problem}`).join("\n") +
      "\nNothing was written to the manifest.",
  );
}

// ---------------------------------------------------------------------------
// Build the next manifest
// ---------------------------------------------------------------------------

const next = structuredClone(manifest) as typeof manifest;

next.startBlock = artifact.startBlock;
for (const contract of REQUIRED_CONTRACTS) {
  next.contracts[contract] = artifact.contracts[contract];
}
if (artifact.contracts.TyrTwapOracle) {
  next.contracts.TyrTwapOracle = artifact.contracts.TyrTwapOracle;
}
for (const token of ["USDG", "TYR", "WETH"] as const) {
  next.tokens[token].address = artifact.tokens[token] ?? next.tokens[token].address;
}
for (const [ticker, deployed] of Object.entries(artifact.stocks)) {
  next.stocks[ticker].oracle = deployed.oracle;
  next.stocks[ticker].vault = deployed.vault;
  // `enabled` stays false: turning on stock staking is a separate, explicit
  // decision that also needs feed/liquidity/legal verification.
  next.stocks[ticker].enabled = manifest.stocks[ticker].enabled === true;
}

const firstScript = artifact.scripts["DeployProtocol.s.sol"];
next.deployment.blockNumber = artifact.startBlock;
next.deployment.txHash = firstScript?.txHash ?? null;
next.deployment.verifiedAt = markVerified ? new Date().toISOString() : null;
next.verification = markVerified ? "verified" : "pending";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log("\n========================================================");
console.log("📝 PROMOTE MAINNET MANIFEST");
console.log("========================================================");
console.log(`Artifact    : ${path.relative(ROOT, ARTIFACT)}`);
console.log(`Created at  : ${artifact.createdAt}`);
console.log(`startBlock  : ${next.startBlock}`);
console.log(`Verification: ${next.verification}`);
console.log("--------------------------------------------------------");
for (const contract of REQUIRED_CONTRACTS) {
  console.log(`  ${contract.padEnd(16)} ${next.contracts[contract]}`);
}
for (const [ticker, deployed] of Object.entries(artifact.stocks)) {
  console.log(`  ${ticker.padEnd(16)} oracle ${deployed.oracle}`);
  console.log(`  ${"".padEnd(16)} vault  ${deployed.vault}`);
}
console.log("========================================================");

if (!apply) {
  console.log("\nDry run. Re-run with --apply to write the manifest.");
  console.log("Add --verified only after every address is confirmed in the explorer.\n");
  process.exit(0);
}

if (!markVerified) {
  console.log(
    '\nℹ️  Writing verification: "pending". Mainnet preflight will stay red until\n' +
      "   you rerun with --verified.",
  );
}

fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
console.log(`\n✅ Wrote ${path.relative(ROOT, MANIFEST_PATH)}`);
console.log("\nNext steps:");
console.log("  1. Verify each contract source in the explorer.");
console.log("  2. bun scripts/promote-manifest.ts --apply --verified");
console.log("  3. bun run verify:manifest:mainnet");
console.log("  4. bun run contracts:preflight:mainnet");
console.log("  5. bun run contracts:deploy:mainnet:guarded --phase verify\n");
