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
console.log("🔐 TYRIAN CORE PROTOCOL OWNERSHIP HANDOVER RUNNER");
console.log("========================================================");
console.log(`Network       : ${manifest.label} (${manifest.name})`);
console.log(`Chain ID      : ${chainId}`);
console.log(`RPC URL       : ${rpcUrl}`);
console.log(`Deployer / Ops: ${deployerAddress}`);
console.log(`Timelock Target: ${manifest.external.timelock}`);
console.log(`Execution Mode: ${isBroadcast ? "🚀 BROADCAST (REAL MAINNET TX)" : "🧪 DRY-RUN (SIMULATION ONLY)"}`);
console.log("========================================================\n");

const baseEnv: Record<string, string> = {
  ...process.env,
  DEPLOYER_PRIVATE_KEY: privateKey,
  TIMELOCK: manifest.external.timelock,
  STAKE_MANAGER: manifest.contracts.StakeManager,
  USDG_VAULT: manifest.contracts.UsdgVault,
  FEE_SPLITTER: manifest.contracts.FeeSplitter,
  BUYBACK_BURNER: manifest.contracts.BuybackBurner,
  TREASURY_ROUTER: manifest.contracts.TreasuryRouter,
  PORTFOLIO_VAULT: manifest.contracts.PortfolioVault,
  STOCK_VAULT_COUNT: "0",
  STOCK_ORACLE_COUNT: "0",
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

  execSync(forgeCmd, {
    cwd: contractsDir,
    encoding: "utf8",
    env: baseEnv,
    stdio: "inherit",
  });
}

try {
  runScript(
    "Transfer ownership of core contracts to Timelock",
    "script/TransferOwnership.s.sol:TransferOwnershipScript"
  );
} catch (err: any) {
  console.error("\n❌ Ownership handover step failed.");
  process.exit(1);
}

if (isBroadcast) {
  console.log("\n========================================================");
  console.log("🎉 OWNERSHIP HANDOVER INITIATED ON MAINNET!");
  console.log("========================================================");
  console.log("Kepemilikan telah diajukan ke TimelockController.");
  console.log("Langkah selanjutnya: Timelock harus memanggil acceptOwnership() melalui Safe.");
} else {
  console.log("\n========================================================");
  console.log("✅ DRY-RUN HANDOVER COMPLETED SUCCESSFULLY!");
  console.log("========================================================");
  console.log("Untuk mengeksekusi handover ke Timelock di Mainnet, jalankan:\n");
  console.log("👉  bun run contracts:handover:core:mainnet --broadcast\n");
}
