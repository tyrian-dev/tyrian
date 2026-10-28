import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// -----------------------------------------------------------------------------
// 1. Environment and Path Resolution
// -----------------------------------------------------------------------------
const rootDir = process.cwd();
const contractsDir = path.join(rootDir, "contracts");
const mainnetJsonPath = path.join(rootDir, "config", "networks", "mainnet.json");

function loadEnvFile(envPath: string) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnvFile(path.join(rootDir, ".env"));
loadEnvFile(path.join(contractsDir, ".env"));

// -----------------------------------------------------------------------------
// 2. Validate Manifest & Parameters
// -----------------------------------------------------------------------------
if (!fs.existsSync(mainnetJsonPath)) {
  console.error(`\n❌ ERROR: Manifest not found at ${mainnetJsonPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(mainnetJsonPath, "utf-8"));
const chainId: number = manifest.chainId ?? 4663;

let rawRpcUrl =
  process.env.MAINNET_RPC_URL?.trim() ||
  manifest.rpcUrl ||
  process.env.NEXT_PUBLIC_MAINNET_RPC_URL?.trim() ||
  "https://rpc.mainnet.chain.robinhood.com";

if (rawRpcUrl === "https://rpc.chain.robinhood.com") {
  rawRpcUrl = "https://rpc.mainnet.chain.robinhood.com";
}
const rpcUrl: string = rawRpcUrl;

const rawKey: string | undefined = process.env.DEPLOYER_PRIVATE_KEY?.trim();
if (!rawKey) {
  console.error("\n❌ ERROR: DEPLOYER_PRIVATE_KEY is not set.");
  process.exit(1);
}

const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
process.env.DEPLOYER_PRIVATE_KEY = privateKey;

let deployerAddress = "unknown";
try {
  deployerAddress = execSync(`cast wallet address --private-key "${privateKey}"`, {
    encoding: "utf8",
  }).trim();
} catch (e: any) {
  console.error("\n❌ ERROR: Invalid DEPLOYER_PRIVATE_KEY.");
  process.exit(1);
}

const args = process.argv.slice(2);
const isBroadcast = args.includes("--broadcast") || process.env.MAINNET_DEPLOY_CONFIRM === "yes";

console.log("\n========================================================");
console.log("⚙️  TYRIAN CORE PROTOCOL CONFIGURATION RUNNER");
console.log("========================================================");
console.log(`Network       : ${manifest.label} (${manifest.name})`);
console.log(`Chain ID      : ${chainId}`);
console.log(`RPC URL       : ${rpcUrl}`);
console.log(`Deployer / Ops: ${deployerAddress}`);
console.log(`StakeManager  : ${manifest.contracts.StakeManager}`);
console.log(`UsdgVault     : ${manifest.contracts.UsdgVault}`);
console.log(`FeeSplitter   : ${manifest.contracts.FeeSplitter}`);
console.log(`BuybackBurner : ${manifest.contracts.BuybackBurner}`);
console.log(`TreasuryRouter: ${manifest.contracts.TreasuryRouter}`);
console.log(`PortfolioVault: ${manifest.contracts.PortfolioVault}`);
console.log(`Execution Mode: ${isBroadcast ? "🚀 BROADCAST (REAL MAINNET TX)" : "🧪 DRY-RUN (SIMULATION ONLY)"}`);
console.log("========================================================\n");

// Check balance
try {
  const balanceRaw = execSync(`cast balance ${deployerAddress} --rpc-url "${rpcUrl}"`, {
    encoding: "utf8",
  }).trim();
  const balanceEth = (Number(BigInt(balanceRaw)) / 1e18).toFixed(5);
  console.log(`💰 Deployer Balance: ${balanceEth} ETH\n`);
} catch {}

const baseEnv: Record<string, string> = {
  ...process.env,
  DEPLOYER_PRIVATE_KEY: privateKey,
  STAKE_MANAGER: manifest.contracts.StakeManager,
  USDG_VAULT: manifest.contracts.UsdgVault,
  USDG_ADDRESS: manifest.tokens.USDG.address,
  TREASURY_SAFE: manifest.external.treasurySafe,
  BUYBACK_BURNER: manifest.contracts.BuybackBurner,
  FEE_SPLITTER: manifest.contracts.FeeSplitter,
  TREASURY_ROUTER: manifest.contracts.TreasuryRouter,
  PORTFOLIO_VAULT: manifest.contracts.PortfolioVault,
  BUYBACK_ROUTER: manifest.external.dexRouter,
  DEX_ROUTER: manifest.external.dexRouter,
  DEX_POOL_FEE: "3000",
  BUYBACK_POOL_FEE: "3000",
  KEEPER: deployerAddress,
  EXPECTED_CHAIN_ID: String(chainId),
};

function runScript(label: string, scriptTarget: string) {
  const forgeCmdParts = [
    "forge",
    "script",
    scriptTarget,
    "--root",
    `"${contractsDir}"`,
    "--rpc-url",
    `"${rpcUrl}"`,
    "-vv",
    "--retries",
    "5",
    "--delay",
    "2",
  ];

  if (isBroadcast) {
    forgeCmdParts.push("--broadcast");
  }

  const forgeCmd = forgeCmdParts.join(" ");
  console.log(`▶ ${label}`);
  console.log(`  ${forgeCmd}\n`);

  const output = execSync(forgeCmd, {
    cwd: contractsDir,
    encoding: "utf8",
    env: baseEnv,
    stdio: "inherit",
  });
}

// -----------------------------------------------------------------------------
// Execute Configurations
// -----------------------------------------------------------------------------
try {
  runScript(
    "Configure Protocol Core (StakeManager, FeeSplitter, BuybackBurner)",
    "script/ConfigureProtocol.s.sol:ConfigureProtocolScript"
  );

  runScript(
    "Configure Treasury (TreasuryRouter, PortfolioVault)",
    "script/ConfigureTreasury.s.sol:ConfigureTreasuryScript"
  );
} catch (err: any) {
  console.error("\n❌ Configuration step failed.");
  process.exit(1);
}

if (isBroadcast) {
  console.log("\n========================================================");
  console.log("🎉 CORE PROTOCOL SUCCESSFULLY CONFIGURED ON MAINNET!");
  console.log("========================================================");
} else {
  console.log("\n========================================================");
  console.log("✅ DRY-RUN CONFIGURATION COMPLETED SUCCESSFULLY!");
  console.log("========================================================");
  console.log("Semua parameter konfigurasi lolos validasi tanpa revert.");
  console.log("Untuk menerapkan transaksi ke Mainnet, jalankan:\n");
  console.log("👉  bun run contracts:configure:core:mainnet --broadcast\n");
}
