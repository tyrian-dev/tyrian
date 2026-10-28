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

// Auto-fix deprecated hostname if present in old .env
if (rawRpcUrl === "https://rpc.chain.robinhood.com") {
  rawRpcUrl = "https://rpc.mainnet.chain.robinhood.com";
}

const rpcUrl: string = rawRpcUrl;

const safeAddress: string =
  process.env.TREASURY_SAFE?.trim() ||
  manifest.external?.treasurySafe ||
  "0x56e335892745ed42228525BF74da8755924Ad740";

if (!safeAddress || safeAddress === "0x0000000000000000000000000000000000000000") {
  console.error("\n❌ ERROR: Safe multisig address (external.treasurySafe) is missing or zero.");
  process.exit(1);
}

const rawKey: string | undefined = process.env.DEPLOYER_PRIVATE_KEY?.trim();
if (!rawKey) {
  console.error("\n❌ ERROR: DEPLOYER_PRIVATE_KEY is not set.");
  console.error("Please add DEPLOYER_PRIVATE_KEY=0x... to .env or pass it as an environment variable.\n");
  process.exit(1);
}

const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
process.env.DEPLOYER_PRIVATE_KEY = privateKey;
process.env.TREASURY_SAFE = safeAddress;

let deployerAddress = "unknown";
try {
  deployerAddress = execSync(`cast wallet address --private-key "${privateKey}"`, {
    encoding: "utf8",
  }).trim();
} catch (e: any) {
  console.error("\n❌ ERROR: Invalid DEPLOYER_PRIVATE_KEY. Could not derive wallet address.");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 3. Flags & Mode
// -----------------------------------------------------------------------------
const args = process.argv.slice(2);
const isBroadcast = args.includes("--broadcast") || process.env.MAINNET_DEPLOY_CONFIRM === "yes";

console.log("\n========================================================");
console.log("⏳ TYRIAN TIMELOCK CONTROLLER DEPLOYMENT RUNNER");
console.log("========================================================");
console.log(`Network       : ${manifest.label} (${manifest.name})`);
console.log(`Chain ID      : ${chainId}`);
console.log(`RPC URL       : ${rpcUrl}`);
console.log(`Deployer EOA  : ${deployerAddress}`);
console.log(`Safe Multisig : ${safeAddress} (Admin, Proposer, Executor)`);
console.log(`Timelock Delay: 48 hours (172,800 seconds)`);
console.log(`Execution Mode: ${isBroadcast ? "🚀 BROADCAST (REAL MAINNET TX)" : "🧪 DRY-RUN (SIMULATION ONLY)"}`);
console.log("========================================================\n");

// -----------------------------------------------------------------------------
// 4. Check Deployer Balance on Mainnet
// -----------------------------------------------------------------------------
try {
  const balanceRaw = execSync(`cast balance ${deployerAddress} --rpc-url "${rpcUrl}"`, {
    encoding: "utf8",
  }).trim();
  const balanceEth = (Number(BigInt(balanceRaw)) / 1e18).toFixed(5);
  console.log(`💰 Deployer Balance: ${balanceEth} ETH`);

  if (isBroadcast && BigInt(balanceRaw) < 1000000000000000n) {
    // < 0.001 ETH
    console.warn(`\n⚠️  WARNING: Deployer balance (${balanceEth} ETH) is low. Deployment might fail if gas is insufficient.\n`);
  }
} catch (err: any) {
  console.warn(`⚠️  Could not fetch deployer balance via RPC: ${err?.message || err}`);
}

// -----------------------------------------------------------------------------
// 5. Execute Deployment
// -----------------------------------------------------------------------------
const forgeCmdParts = [
  "forge script script/DeployTimelock.s.sol:DeployTimelockScript",
  `--root "${contractsDir}"`,
  `--rpc-url "${rpcUrl}"`,
  "-vv",
];

if (isBroadcast) {
  forgeCmdParts.push("--broadcast");
}

const forgeCmd = forgeCmdParts.join(" ");

console.log(`\n📦 Running: ${forgeCmd}\n`);

const scriptEnv = {
  ...process.env,
  DEPLOYER_PRIVATE_KEY: privateKey,
  TREASURY_SAFE: safeAddress,
  TIMELOCK_DELAY: "172800",
};

let output = "";
try {
  output = execSync(forgeCmd, {
    cwd: contractsDir,
    encoding: "utf8",
    env: scriptEnv,
    stdio: "pipe",
  });
  console.log(output);
} catch (err: any) {
  console.error("\n❌ Deployment script failed:");
  if (err.stdout) console.log(err.stdout.toString());
  if (err.stderr) console.error(err.stderr.toString());
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 6. Extract Deployed Address
// -----------------------------------------------------------------------------
let deployedTimelockAddress: string | null = null;

// Pattern 1: Search in stdout
const match = output.match(/Timelock deployed successfully at:\s*(0x[a-fA-F0-9]{40})/i);
if (match && match[1]) {
  deployedTimelockAddress = match[1];
}

// Pattern 2: Search in broadcast run-latest.json if broadcast was used
if (isBroadcast) {
  const runLatestPath = path.join(contractsDir, "broadcast", "DeployTimelock.s.sol", chainId.toString(), "run-latest.json");
  if (fs.existsSync(runLatestPath)) {
    try {
      const runData = JSON.parse(fs.readFileSync(runLatestPath, "utf-8"));
      for (const tx of runData.transactions || []) {
        if (tx.transactionType === "CREATE" && tx.contractName === "TimelockController" && tx.contractAddress) {
          deployedTimelockAddress = tx.contractAddress;
          break;
        }
      }
    } catch {}
  }
}

// -----------------------------------------------------------------------------
// 7. Update Manifest (if Broadcast & Success)
// -----------------------------------------------------------------------------
if (isBroadcast && deployedTimelockAddress) {
  console.log("\n========================================================");
  console.log(`🎉 TIMELOCK DEPLOYED ON MAINNET: ${deployedTimelockAddress}`);
  console.log("========================================================");

  manifest.external = manifest.external || {};
  manifest.external.timelock = deployedTimelockAddress;

  fs.writeFileSync(mainnetJsonPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`\n💾 Successfully updated config/networks/mainnet.json with external.timelock = ${deployedTimelockAddress}`);

  console.log("\n🛡️  Running mainnet preflight check...\n");
  try {
    execSync("bun scripts/preflight-mainnet.ts", {
      cwd: rootDir,
      stdio: "inherit",
    });
  } catch {}
} else if (!isBroadcast) {
  console.log("\n========================================================");
  console.log("✅ DRY-RUN COMPLETED SUCCESSFULLY!");
  console.log("========================================================");
  console.log("Simulasi eksekusi berhasil tanpa ada revert.");
  console.log("Untuk mengirim transaksi nyata ke Mainnet, jalankan:");
  console.log("\n👉  bun run contracts:deploy:timelock:mainnet --broadcast\n");
}
