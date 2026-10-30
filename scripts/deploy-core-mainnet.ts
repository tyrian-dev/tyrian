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
console.log("🚀 TYRIAN CORE PROTOCOL MAINNET DEPLOYMENT RUNNER");
console.log("========================================================");
console.log(`Network       : ${manifest.label} (${manifest.name})`);
console.log(`Chain ID      : ${chainId}`);
console.log(`RPC URL       : ${rpcUrl}`);
console.log(`Deployer EOA  : ${deployerAddress}`);
console.log(`Timelock Owner: ${manifest.external.timelock}`);
console.log(`Treasury Safe : ${manifest.external.treasurySafe}`);
console.log(`USDG Token    : ${manifest.tokens.USDG.address}`);
console.log(`TYRN Token    : ${manifest.tokens.TYRN.address}`);
console.log(`WETH Token    : ${manifest.tokens.WETH.address}`);
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

const baseEnv = {
  ...process.env,
  DEPLOYER_PRIVATE_KEY: privateKey,
  TREASURY_SAFE: manifest.external.treasurySafe,
  TREASURY_BUDGET: manifest.external.budget,
  TREASURY_RESERVE: manifest.external.reserve,
  TIMELOCK: manifest.external.timelock,
  PROTOCOL_OWNER: manifest.external.timelock,
  GUARDIAN: manifest.external.guardian,
  DEX_ROUTER: manifest.external.dexRouter,
  USDG_ADDRESS: manifest.tokens.USDG.address,
  TYRN_ADDRESS: manifest.tokens.TYRN.address,
  TYR_ADDRESS: manifest.tokens.TYRN.address,
  WETH_ADDRESS: manifest.tokens.WETH.address,
  EXPECTED_CHAIN_ID: String(chainId),
};

const deployedContracts: Record<string, string> = {};

function runScript(label: string, scriptTarget: string, scriptFile: string) {
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
    env: { ...baseEnv, ...deployedContracts },
    stdio: "pipe",
  });
  console.log(output);

  // Parse deployed addresses from logs
  const matches = output.matchAll(/(StakeManager|UsdgVault|BuybackBurner|FeeSplitter|TreasuryRouter|PortfolioVault):\s*(0x[a-fA-F0-9]{40})/g);
  for (const m of matches) {
    deployedContracts[m[1]] = m[2];
  }

  // Parse from run-latest.json if broadcast
  if (isBroadcast) {
    const runLatestPath = path.join(contractsDir, "broadcast", scriptFile, String(chainId), "run-latest.json");
    if (fs.existsSync(runLatestPath)) {
      try {
        const runData = JSON.parse(fs.readFileSync(runLatestPath, "utf-8"));
        for (const tx of runData.transactions || []) {
          if (tx.transactionType === "CREATE" && tx.contractName && tx.contractAddress) {
            deployedContracts[tx.contractName] = tx.contractAddress;
          }
        }
      } catch {}
    }
  }
}

// -----------------------------------------------------------------------------
// Execute Deployments
// -----------------------------------------------------------------------------
try {
  runScript(
    "Deploy Protocol Core (StakeManager, UsdgVault, FeeSplitter, BuybackBurner)",
    "script/DeployProtocol.s.sol:DeployProtocolScript",
    "DeployProtocol.s.sol"
  );

  runScript(
    "Deploy Treasury (TreasuryRouter, PortfolioVault)",
    "script/DeployTreasury.s.sol:DeployTreasuryScript",
    "DeployTreasury.s.sol"
  );
} catch (err: any) {
  console.error("\n❌ Core deployment step failed:");
  if (err.stdout) console.log(err.stdout.toString());
  if (err.stderr) console.error(err.stderr.toString());
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Update Manifest & Preflight
// -----------------------------------------------------------------------------
if (isBroadcast) {
  console.log("\n========================================================");
  console.log("🎉 CORE PROTOCOL SUCCESSFULLY DEPLOYED ON MAINNET!");
  console.log("========================================================");
  for (const [name, addr] of Object.entries(deployedContracts)) {
    console.log(`   - ${name.padEnd(16)}: ${addr}`);
    manifest.contracts[name] = addr;
  }

  fs.writeFileSync(mainnetJsonPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`\n💾 Successfully updated config/networks/mainnet.json with core contract addresses.`);

  console.log("\n🛡️  Running mainnet preflight check...\n");
  try {
    execSync("bun scripts/preflight-mainnet.ts", {
      cwd: rootDir,
      stdio: "inherit",
    });
  } catch {}
} else {
  console.log("\n========================================================");
  console.log("✅ DRY-RUN COMPLETED SUCCESSFULLY!");
  console.log("========================================================");
  console.log("Semua simulasi deploy core protocol (StakeManager, UsdgVault, FeeSplitter,");
  console.log("BuybackBurner, TreasuryRouter, PortfolioVault) lolos tanpa revert.");
  console.log("Untuk mengeksekusi transaksi nyata ke Mainnet, jalankan:\n");
  console.log("👉  bun run contracts:deploy:core:mainnet --broadcast\n");
}
