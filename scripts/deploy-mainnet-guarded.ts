import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  getMainnetReadinessIssues,
  networkManifests,
  type StockConfig,
} from "../shared/contracts/addresses";

/**
 * Guarded mainnet deployment runner.
 *
 * Design rules:
 * - Dry run by default. `--broadcast` is required and must be paired with
 *   `MAINNET_DEPLOY_CONFIRM=yes`; a typo cannot send a transaction.
 * - Order is fixed: deploy -> configure -> handover -> (wait) accept -> verify.
 *   `--phase all` stops before `accept` because the timelock delay must elapse.
 * - Addresses are read back from forge broadcast artifacts, never retyped by
 *   hand. `config/networks/mainnet.json` is only written by
 *   `scripts/promote-manifest.ts --apply`.
 * - Every phase re-checks the manifest prerequisites it needs. A missing token
 *   or Safe stops the run before anything is broadcast.
 *
 * Usage:
 *   bun scripts/deploy-mainnet-guarded.ts --phase deploy            # dry run
 *   bun scripts/deploy-mainnet-guarded.ts --phase deploy --broadcast
 *   bun scripts/deploy-mainnet-guarded.ts --phase accept
 */

const ROOT = process.cwd();
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const DEPLOYMENTS_DIR = path.join(ROOT, "deployments");
const MAINNET_CHAIN_ID = 4663;

const manifest = networkManifests.mainnet;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const hasFlag = (flag: string) => argv.includes(flag);
const flagValue = (flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

const PHASES = ["deploy", "configure", "handover", "accept", "verify", "all"] as const;
type Phase = (typeof PHASES)[number];

const phase = (flagValue("--phase") ?? "all") as Phase;
const broadcast = hasFlag("--broadcast");
const allowPublicRpc = hasFlag("--allow-public-rpc");
const verifySource = hasFlag("--verify");
const tickers = (flagValue("--tickers") ?? "")
  .split(",")
  .map((ticker) => ticker.trim().toUpperCase())
  .filter(Boolean);

if (!PHASES.includes(phase)) {
  fail(`Unknown --phase "${phase}". Expected one of: ${PHASES.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function assertBroadcastGuards() {
  if (!broadcast) return;

  if (process.env.MAINNET_DEPLOY_CONFIRM !== "yes") {
    fail(
      "Refusing to broadcast. Set MAINNET_DEPLOY_CONFIRM=yes explicitly, " +
        "then rerun with --broadcast.",
    );
  }
  if (!process.env.DEPLOYER_PRIVATE_KEY?.trim()) {
    fail("DEPLOYER_PRIVATE_KEY is required for --broadcast.");
  }

  const anvilKey =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const normalized = normalizeKey(process.env.DEPLOYER_PRIVATE_KEY);
  if (normalized.toLowerCase() === anvilKey) {
    fail("Refusing to broadcast mainnet with the default Anvil deployer key.");
  }

  if (isPublicRpc(rpcUrl) && !allowPublicRpc) {
    fail(
      `Refusing to broadcast over the public RPC (${rpcUrl}). Set MAINNET_RPC_URL ` +
        "to a private/paid endpoint, or pass --allow-public-rpc if that is intentional.",
    );
  }
}

function normalizeKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function isPublicRpc(url: string): boolean {
  return url === manifest.rpcUrl;
}

function assertManifestPrerequisites() {
  if (manifest.chainId !== MAINNET_CHAIN_ID) {
    fail(`Manifest chainId is ${manifest.chainId}, expected ${MAINNET_CHAIN_ID}.`);
  }
  if (manifest.verification === "unverified") {
    fail(
      "config/networks/mainnet.json is still unverified. Fill tokens, Safe, " +
        "timelock, budget, reserve, guardian, and dexRouter, then set " +
        'verification to "pending" before deploying.',
    );
  }

  const missing: string[] = [];
  for (const token of ["USDG", "TYRN", "WETH"] as const) {
    if (!manifest.tokens[token]?.address) missing.push(`tokens.${token}.address`);
  }
  for (const field of [
    "treasurySafe",
    "budget",
    "reserve",
    "timelock",
    "guardian",
    "dexRouter",
  ] as const) {
    if (!manifest.external[field]) missing.push(`external.${field}`);
  }

  if (missing.length > 0) {
    fail(
      "Mainnet manifest is missing addresses needed before deployment:\n" +
        missing.map((entry) => `   - ${entry}`).join("\n"),
    );
  }
}

function assertReadyForVerify() {
  const issues = getMainnetReadinessIssues(manifest);
  if (issues.length > 0) {
    fail(
      "Mainnet manifest is not ready for verification:\n" +
        issues.map((issue) => `   - ${issue}`).join("\n") +
        "\nRun scripts/promote-manifest.ts --apply after deployment.",
    );
  }
}

// ---------------------------------------------------------------------------
// RPC / env
// ---------------------------------------------------------------------------

const rpcUrl = process.env.MAINNET_RPC_URL?.trim() || manifest.rpcUrl;
const verifierUrl =
  process.env.VERIFIER_URL?.trim() ||
  `${manifest.explorer.replace(/\/$/, "")}/api`;

function selectedStocks(): Array<[string, StockConfig]> {
  const entries = Object.entries(manifest.stocks) as Array<[string, StockConfig]>;
  if (tickers.length > 0) {
    return entries.filter(([ticker]) => tickers.includes(ticker.toUpperCase()));
  }
  return entries.filter(([, stock]) => stock.enabled);
}

// ---------------------------------------------------------------------------
// Artifact handling
// ---------------------------------------------------------------------------

interface StockArtifact {
  address: string | null;
  feed: string | null;
  oracle: string | null;
  vault: string | null;
}

interface DeploymentArtifact {
  network: "mainnet";
  chainId: number;
  createdAt: string;
  startBlock: number | null;
  contracts: Record<string, string>;
  tokens: Record<string, string>;
  external: Record<string, string>;
  stocks: Record<string, StockArtifact>;
  scripts: Record<string, { txHash: string | null; blockNumber: number | null }>;
}

function emptyArtifact(): DeploymentArtifact {
  return {
    network: "mainnet",
    chainId: MAINNET_CHAIN_ID,
    createdAt: new Date().toISOString(),
    startBlock: null,
    contracts: {},
    tokens: {},
    external: {},
    stocks: {},
    scripts: {},
  };
}

function latestArtifactPath(): string {
  return path.join(DEPLOYMENTS_DIR, "mainnet-latest.json");
}

function loadArtifact(): DeploymentArtifact {
  const file = latestArtifactPath();
  if (!fs.existsSync(file)) return emptyArtifact();
  return JSON.parse(fs.readFileSync(file, "utf-8")) as DeploymentArtifact;
}

function saveArtifact(artifact: DeploymentArtifact) {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(DEPLOYMENTS_DIR, `mainnet-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  fs.writeFileSync(latestArtifactPath(), `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  console.log(`\n📝 Deployment artifact: ${path.relative(ROOT, file)}`);
}

interface BroadcastTransaction {
  transactionType?: string;
  contractName?: string;
  contractAddress?: string;
  hash?: string;
  arguments?: unknown[];
}

interface BroadcastRun {
  transactions?: BroadcastTransaction[];
  receipts?: Array<{ blockNumber?: string; transactionHash?: string }>;
}

function broadcastPath(scriptFile: string): string {
  // Per-ticker runs use "<script>?AAPL" to keep artifact keys unique; forge
  // still writes to the plain script directory.
  const directory = scriptFile.split("?")[0];
  return path.join(
    CONTRACTS_DIR,
    "broadcast",
    directory,
    String(MAINNET_CHAIN_ID),
    "run-latest.json",
  );
}

function readBroadcast(scriptFile: string): BroadcastRun | null {
  const file = broadcastPath(scriptFile);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8")) as BroadcastRun;
}

function createdContracts(run: BroadcastRun | null): Map<string, string> {
  const created = new Map<string, string>();
  for (const tx of run?.transactions ?? []) {
    if (tx.transactionType !== "CREATE" || !tx.contractName || !tx.contractAddress) {
      continue;
    }
    // Multiple deployments of the same contract name keep the last one, which
    // matches the per-ticker flow (one oracle/vault per script run).
    created.set(tx.contractName, tx.contractAddress);
  }
  return created;
}

function recordScript(
  artifact: DeploymentArtifact,
  scriptFile: string,
  run: BroadcastRun | null,
) {
  const firstReceipt = run?.receipts?.[0];
  artifact.scripts[scriptFile] = {
    txHash: firstReceipt?.transactionHash ?? null,
    blockNumber: firstReceipt?.blockNumber
      ? Number.parseInt(firstReceipt.blockNumber, 16)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Forge execution
// ---------------------------------------------------------------------------

function runForge(
  label: string,
  scriptTarget: string,
  scriptFile: string,
  extraEnv: Record<string, string> = {},
) {
  const args = ["script", scriptTarget, "--rpc-url", rpcUrl, "-vv", "--retries", "5", "--delay", "2"];
  if (broadcast) args.push("--broadcast");
  if (verifySource) {
    args.push("--verify", "--verifier", "blockscout", "--verifier-url", verifierUrl);
  }

  console.log(`\n▶ ${label}`);
  console.log(`  forge ${args.join(" ")}`);

  try {
    execFileSync("forge", args, {
      cwd: CONTRACTS_DIR,
      stdio: "inherit",
      env: {
        ...process.env,
        EXPECTED_CHAIN_ID: String(MAINNET_CHAIN_ID),
        ...extraEnv,
      },
    });
  } catch {
    fail(
      `Step failed: ${label}. Nothing after this step was run. ` +
        "Fix the error above and rerun the same phase once the state is consistent.",
    );
  }

  const run = readBroadcast(scriptFile);
  if (broadcast && !run) {
    fail(`No broadcast artifact found for ${scriptFile} (chain ${MAINNET_CHAIN_ID}).`);
  }
  return run;
}

function baseEnv(artifact: DeploymentArtifact): Record<string, string> {
  const env: Record<string, string> = {
    DEPLOYER_PRIVATE_KEY: normalizeKey(process.env.DEPLOYER_PRIVATE_KEY ?? ""),
    TREASURY_SAFE: manifest.external.treasurySafe ?? "",
    TREASURY_BUDGET: manifest.external.budget ?? "",
    TREASURY_RESERVE: manifest.external.reserve ?? "",
    TIMELOCK: manifest.external.timelock ?? "",
    PROTOCOL_OWNER: manifest.external.timelock ?? "",
    GUARDIAN: manifest.external.guardian ?? "",
    DEX_ROUTER: manifest.external.dexRouter ?? "",
    USDG_ADDRESS: manifest.tokens.USDG.address ?? "",
    TYRN_ADDRESS: manifest.tokens.TYRN.address ?? "",
    TYR_ADDRESS: manifest.tokens.TYRN.address ?? "",
    WETH_ADDRESS: manifest.tokens.WETH.address ?? "",
  };

  for (const [name, address] of Object.entries(artifact.contracts)) {
    env[`${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = address;
  }

  return env;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

function deployPhase(artifact: DeploymentArtifact) {
  console.log("\n=== Phase: deploy ===");

  let run = runForge(
    "Deploy protocol core (StakeManager, UsdgVault, FeeSplitter, BuybackBurner)",
    "script/DeployProtocol.s.sol:DeployProtocolScript",
    "DeployProtocol.s.sol",
    baseEnv(artifact),
  );
  for (const [name, address] of createdContracts(run)) {
    artifact.contracts[name] = address;
  }
  recordScript(artifact, "DeployProtocol.s.sol", run);
  artifact.startBlock =
    artifact.scripts["DeployProtocol.s.sol"]?.blockNumber ?? artifact.startBlock;

  run = runForge(
    "Deploy treasury (TreasuryRouter, PortfolioVault)",
    "script/DeployTreasury.s.sol:DeployTreasuryScript",
    "DeployTreasury.s.sol",
    baseEnv(artifact),
  );
  for (const [name, address] of createdContracts(run)) {
    artifact.contracts[name] = address;
  }
  recordScript(artifact, "DeployTreasury.s.sol", run);

  // TYR TWAP oracle (BUD-003 / GAP-012). The epoch job needs a TYR/USD price, so
  // the oracle is part of the deploy, not a manual follow-up. Fail closed when
  // the manifest has no pons pool: a zero pool would deploy an oracle that can
  // never price TYR.
  const twapPool = manifest.external.uniswapPool;
  if (!twapPool) {
    fail(
      "external.uniswapPool is required to deploy TyrTwapOracle. " +
        "Fill it in config/networks/mainnet.json after verifying the pons TYR pool.",
    );
  }

  const quoteToken =
    process.env.TYR_TWAP_QUOTE_TOKEN?.trim() || manifest.tokens.USDG.address;
  if (!quoteToken) {
    fail("TYR_TWAP_QUOTE_TOKEN is unset and tokens.USDG.address is empty.");
  }
  // USDG is a USD stablecoin, so the quote feed is optional and defaults to
  // address(0). Set TYR_TWAP_QUOTE_FEED when the pool quotes in WETH.
  const quoteFeed = process.env.TYR_TWAP_QUOTE_FEED?.trim() || "0x0000000000000000000000000000000000000000";
  const protocolOwner = manifest.external.timelock;
  if (!protocolOwner) {
    fail("external.timelock is required as the TyrTwapOracle owner on mainnet.");
  }

  run = runForge(
    "Deploy TyrTwapOracle (TYR 30m TWAP)",
    "script/DeployTyrTwapOracle.s.sol:DeployTyrTwapOracleScript",
    "DeployTyrTwapOracle.s.sol",
    {
      ...baseEnv(artifact),
      QUOTE_TOKEN: quoteToken,
      UNISWAP_POOL: twapPool,
      QUOTE_FEED: quoteFeed,
      PROTOCOL_OWNER: protocolOwner,
    },
  );
  const tyrOracle = createdContracts(run).get("TyrTwapOracle") ?? null;
  if (!tyrOracle) {
    fail("DeployTyrTwapOracle did not report a TyrTwapOracle address.");
  }
  artifact.contracts.TyrTwapOracle = tyrOracle;
  recordScript(artifact, "DeployTyrTwapOracle.s.sol", run);

  for (const [ticker, stock] of selectedStocks()) {
    if (!stock.address || !stock.feed) {
      fail(`Stock ${ticker} is missing address or feed in the manifest.`);
    }

    run = runForge(
      `Deploy StockPriceOracle for ${ticker}`,
      "script/DeployStockOracle.s.sol:DeployStockOracleScript",
      `DeployStockOracle.s.sol?${ticker}`,
      {
        ...baseEnv(artifact),
        STOCK_TICKER: ticker,
        STOCK_TOKEN: stock.address,
        STOCK_FEED: stock.feed,
      },
    );
    const oracle = createdContracts(run).get("StockPriceOracle") ?? null;
    artifact.stocks[ticker] = {
      address: stock.address,
      feed: stock.feed,
      oracle,
      vault: artifact.stocks[ticker]?.vault ?? null,
    };
    artifact.scripts[`DeployStockOracle.${ticker}`] = {
      txHash: run?.receipts?.[0]?.transactionHash ?? null,
      blockNumber: run?.receipts?.[0]?.blockNumber
        ? Number.parseInt(run.receipts[0].blockNumber, 16)
        : null,
    };
  }

  for (const [ticker, stock] of selectedStocks()) {
    if (!stock.address || !stock.feed) continue;

    const cap = process.env[`STOCK_CAP_${ticker}`]?.trim();
    if (!cap) {
      fail(
        `STOCK_CAP_${ticker} is required (token units, not USD). ` +
          "Set it in the environment before deploying this ticker.",
      );
    }

    run = runForge(
      `Deploy StockVault for ${ticker}`,
      "script/DeployStockVault.s.sol:DeployStockVaultScript",
      `DeployStockVault.s.sol?${ticker}`,
      {
        ...baseEnv(artifact),
        STOCK_TICKER: ticker,
        STOCK_SYMBOL: ticker,
        STOCK_TOKEN: stock.address,
        STOCK_FEED: stock.feed,
        STOCK_CAP: cap,
      },
    );
    const vault = createdContracts(run).get("StockVault") ?? null;
    artifact.stocks[ticker] = {
      ...(artifact.stocks[ticker] ?? {
        address: stock.address,
        feed: stock.feed,
        oracle: null,
      }),
      vault,
    };
    artifact.scripts[`DeployStockVault.${ticker}`] = {
      txHash: run?.receipts?.[0]?.transactionHash ?? null,
      blockNumber: run?.receipts?.[0]?.blockNumber
        ? Number.parseInt(run.receipts[0].blockNumber, 16)
        : null,
    };
  }

  if (broadcast) saveArtifact(artifact);
}

function configurePhase(artifact: DeploymentArtifact) {
  console.log("\n=== Phase: configure ===");

  const env = {
    ...baseEnv(artifact),
    STAKE_MANAGER: artifact.contracts.StakeManager ?? "",
    USDG_VAULT: artifact.contracts.UsdgVault ?? "",
    FEE_SPLITTER: artifact.contracts.FeeSplitter ?? "",
    BUYBACK_BURNER: artifact.contracts.BuybackBurner ?? "",
    TREASURY_ROUTER: artifact.contracts.TreasuryRouter ?? "",
    PORTFOLIO_VAULT: artifact.contracts.PortfolioVault ?? "",
    BUYBACK_ROUTER: manifest.external.dexRouter ?? "",
    KEEPER: process.env.KEEPER?.trim() ?? "",
  };

  for (const key of [
    "STAKE_MANAGER",
    "USDG_VAULT",
    "FEE_SPLITTER",
    "BUYBACK_BURNER",
    "TREASURY_ROUTER",
    "PORTFOLIO_VAULT",
  ]) {
    if (!env[key as keyof typeof env]) {
      fail(`Missing ${key} in the deployment artifact. Run --phase deploy first.`);
    }
  }

  runForge(
    "Configure protocol core",
    "script/ConfigureProtocol.s.sol:ConfigureProtocolScript",
    "ConfigureProtocol.s.sol",
    env,
  );

  runForge(
    "Configure treasury",
    "script/ConfigureTreasury.s.sol:ConfigureTreasuryScript",
    "ConfigureTreasury.s.sol",
    env,
  );

  for (const [ticker, stock] of selectedStocks()) {
    const deployed = artifact.stocks[ticker];
    if (!deployed?.vault) {
      fail(`No StockVault address for ${ticker}. Run --phase deploy for this ticker first.`);
    }
    const cap = process.env[`STOCK_CAP_${ticker}`]?.trim();
    if (!cap) fail(`STOCK_CAP_${ticker} is required to register the stock vault.`);

    runForge(
      `Register StockVault for ${ticker}`,
      "script/ConfigureStockVault.s.sol:ConfigureStockVaultScript",
      "ConfigureStockVault.s.sol",
      {
        ...env,
        STOCK_TICKER: ticker,
        STOCK_SYMBOL: ticker,
        STOCK_TOKEN: stock.address ?? "",
        STOCK_FEED: stock.feed ?? "",
        STOCK_VAULT: deployed.vault,
        STOCK_CAP: cap,
      },
    );
  }
}

function handoverPhase(artifact: DeploymentArtifact) {
  console.log("\n=== Phase: handover ===");

  const env: Record<string, string> = {
    ...baseEnv(artifact),
    STAKE_MANAGER: artifact.contracts.StakeManager ?? "",
    USDG_VAULT: artifact.contracts.UsdgVault ?? "",
    FEE_SPLITTER: artifact.contracts.FeeSplitter ?? "",
    BUYBACK_BURNER: artifact.contracts.BuybackBurner ?? "",
    TREASURY_ROUTER: artifact.contracts.TreasuryRouter ?? "",
    PORTFOLIO_VAULT: artifact.contracts.PortfolioVault ?? "",
    STOCK_VAULT_COUNT: "0",
    STOCK_ORACLE_COUNT: "0",
  };

  const oracles: string[] = [];
  const vaults: string[] = [];
  for (const [, deployed] of Object.entries(artifact.stocks)) {
    if (deployed.oracle) oracles.push(deployed.oracle);
    if (deployed.vault) vaults.push(deployed.vault);
  }
  vaults.forEach((address, index) => {
    env[`STOCK_VAULT_${index + 1}`] = address;
  });
  oracles.forEach((address, index) => {
    env[`STOCK_ORACLE_${index + 1}`] = address;
  });
  env.STOCK_VAULT_COUNT = String(vaults.length);
  env.STOCK_ORACLE_COUNT = String(oracles.length);

  runForge(
    "Transfer ownership of every Ownable2Step contract to the timelock",
    "script/TransferOwnership.s.sol:TransferOwnershipScript",
    "TransferOwnership.s.sol",
    env,
  );

  console.log(
    "\n⏳ Ownership is pending. The timelock must call acceptOwnership() before\n" +
      "   the contracts change hands. Run: --phase accept (schedule), wait for\n" +
      "   the timelock delay, then rerun with TIMELOCK_ACTION=execute.",
  );
}

function acceptPhase(artifact: DeploymentArtifact) {
  console.log("\n=== Phase: accept ===");

  const env: Record<string, string> = {
    ...baseEnv(artifact),
    STAKE_MANAGER: artifact.contracts.StakeManager ?? "",
    USDG_VAULT: artifact.contracts.UsdgVault ?? "",
    FEE_SPLITTER: artifact.contracts.FeeSplitter ?? "",
    BUYBACK_BURNER: artifact.contracts.BuybackBurner ?? "",
    TREASURY_ROUTER: artifact.contracts.TreasuryRouter ?? "",
    PORTFOLIO_VAULT: artifact.contracts.PortfolioVault ?? "",
    TIMELOCK_ACTION: process.env.TIMELOCK_ACTION?.trim() || "schedule",
  };

  if (process.env.TIMELOCK_PRIVATE_KEY) {
    env.TIMELOCK_PRIVATE_KEY = normalizeKey(process.env.TIMELOCK_PRIVATE_KEY);
  }

  runForge(
    `Timelock ${env.TIMELOCK_ACTION} of the acceptOwnership batch`,
    "script/AcceptOwnership.s.sol:AcceptOwnershipScript",
    "AcceptOwnership.s.sol",
    env,
  );
}

function verifyPhase() {
  console.log("\n=== Phase: verify ===");
  assertReadyForVerify();

  const artifact = loadArtifact();
  const tyrOracle = artifact.contracts.TyrTwapOracle;
  if (!tyrOracle) {
    fail(
      "TyrTwapOracle is missing from deployments/mainnet-latest.json. " +
        "Run --phase deploy first; VerifyMainnet would otherwise skip the oracle checks.",
    );
  }

  runForge(
    "Verify mainnet ownership, wiring, and governance",
    "script/VerifyMainnet.s.sol:VerifyMainnetScript",
    "VerifyMainnet.s.sol",
    {
      ...baseEnv(artifact),
      STAKE_MANAGER: artifact.contracts.StakeManager ?? "",
      USDG_VAULT: artifact.contracts.UsdgVault ?? "",
      FEE_SPLITTER: artifact.contracts.FeeSplitter ?? "",
      BUYBACK_BURNER: artifact.contracts.BuybackBurner ?? "",
      TREASURY_ROUTER: artifact.contracts.TreasuryRouter ?? "",
      PORTFOLIO_VAULT: artifact.contracts.PortfolioVault ?? "",
      TYR_TWAP_ORACLE: tyrOracle,
    },
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("\n========================================================");
  console.log("🔒 TYRIAN GUARDED MAINNET DEPLOYMENT");
  console.log("========================================================");
  console.log(`Phase      : ${phase}`);
  console.log(`Mode       : ${broadcast ? "BROADCAST" : "dry run (no transactions)"}`);
  console.log(`Chain ID   : ${manifest.chainId}`);
  console.log(`RPC URL    : ${rpcUrl}`);
  console.log(`Verify src : ${verifySource ? "yes" : "no"}`);
  console.log("========================================================");

  assertManifestPrerequisites();
  assertBroadcastGuards();

  if (phase === "verify") {
    verifyPhase();
    return;
  }

  const artifact = loadArtifact();

  if (phase === "deploy" || phase === "all") deployPhase(artifact);
  if (phase === "configure" || phase === "all") configurePhase(artifact);
  if (phase === "handover" || phase === "all") handoverPhase(artifact);
  if (phase === "accept") acceptPhase(artifact);

  console.log("\n========================================================");
  console.log("✅ Requested phase(s) finished.");
  if (!broadcast) {
    console.log("   Dry run only: no transactions were sent and no artifact was written.");
  }
  console.log("   Next: bun scripts/promote-manifest.ts --apply");
  console.log("========================================================\n");
}

main();
