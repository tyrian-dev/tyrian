import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// -----------------------------------------------------------------------------
// 1. Environment and Path Resolution
// -----------------------------------------------------------------------------
const rootDir = process.cwd();
const contractsDir = path.join(rootDir, "contracts");
const testnetJsonPath = path.join(rootDir, "config", "networks", "testnet.json");

// Helper to load env from file if present
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

const manifest = JSON.parse(fs.readFileSync(testnetJsonPath, "utf-8"));
const chainId: number = manifest.chainId ?? 46630;
const rpcUrl: string =
  process.env.TESTNET_RPC_URL?.trim() ||
  process.env.NEXT_PUBLIC_TESTNET_RPC_URL?.trim() ||
  manifest.rpcUrl;

const rawKey: string | undefined = process.env.DEPLOYER_PRIVATE_KEY?.trim();

if (!rawKey) {
  console.error("\n❌ ERROR: DEPLOYER_PRIVATE_KEY is not set.");
  console.error("Please add DEPLOYER_PRIVATE_KEY=0x... in .env or contracts/.env\n");
  process.exit(1);
}

// Auto-normalize: ensure 0x prefix
const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
process.env.DEPLOYER_PRIVATE_KEY = privateKey;

let deployerAddress = "unknown";
try {
  deployerAddress = execSync(`cast wallet address --private-key "${privateKey}"`, {
    encoding: "utf8",
  }).trim();
} catch {}

console.log("\n========================================================");
console.log("🚀 TYRIAN TESTNET DEPLOYMENT RUNNER");
console.log("========================================================");
console.log(`Network   : ${manifest.label} (${manifest.name})`);
console.log(`Chain ID  : ${chainId}`);
console.log(`Deployer  : ${deployerAddress}`);
console.log(`RPC URL   : ${rpcUrl}`);
console.log("========================================================\n");

// -----------------------------------------------------------------------------
// 2. Execute DeployTyrian.s.sol (Core Protocol + Mocks)
// -----------------------------------------------------------------------------
console.log("📦 [1/4] Deploying Core Protocol & Mock Tokens (DeployTyrian.s.sol)...");

const deployTyrianCmd = [
  "forge script script/DeployTyrian.s.sol:DeployTyrianScript",
  `--rpc-url "${rpcUrl}"`,
  "--broadcast",
  `--private-key "${privateKey}"`,
  "-vv",
].join(" ");

try {
  execSync(deployTyrianCmd, {
    cwd: contractsDir,
    stdio: "inherit",
    env: { ...process.env, DEPLOYER_PRIVATE_KEY: privateKey },
  });
} catch (err) {
  console.error("\n❌ Deployment of DeployTyrian failed.");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 3. Parse Broadcast Artifacts for DeployTyrian
// -----------------------------------------------------------------------------
const tyrianBroadcastPath = path.join(
  contractsDir,
  "broadcast",
  "DeployTyrian.s.sol",
  String(chainId),
  "run-latest.json",
);

if (!fs.existsSync(tyrianBroadcastPath)) {
  console.error(`\n❌ Broadcast artifact not found at ${tyrianBroadcastPath}`);
  process.exit(1);
}

const tyrianRun = JSON.parse(fs.readFileSync(tyrianBroadcastPath, "utf-8"));

// Extract contract addresses by contract name and arguments
const contractsFound: Record<string, string> = {};
let startBlockHex: string | null = null;

if (Array.isArray(tyrianRun.receipts) && tyrianRun.receipts.length > 0) {
  startBlockHex = tyrianRun.receipts[0].blockNumber;
}

for (const tx of tyrianRun.transactions || []) {
  if (tx.transactionType === "CREATE" && tx.contractName && tx.contractAddress) {
    if (tx.contractName === "MockERC20") {
      const symbol = tx.arguments?.[1];
      if (symbol) contractsFound[`Mock_${symbol}`] = tx.contractAddress;
    } else if (tx.contractName === "MockWETH") {
      contractsFound["Mock_WETH"] = tx.contractAddress;
    } else if (tx.contractName === "MockAggregatorV3") {
      contractsFound["Mock_Feed_TSLA"] = tx.contractAddress;
    } else {
      contractsFound[tx.contractName] = tx.contractAddress;
    }
  }
}

console.log("\n✅ Core contracts deployed:");
console.log(`   - StakeManager  : ${contractsFound.StakeManager}`);
console.log(`   - UsdgVault     : ${contractsFound.UsdgVault}`);
console.log(`   - StockVault    : ${contractsFound.StockVault}`);
console.log(`   - FeeSplitter   : ${contractsFound.FeeSplitter}`);
console.log(`   - BuybackBurner : ${contractsFound.BuybackBurner}`);
console.log(`   - USDG (Mock)   : ${contractsFound.Mock_USDG}`);
console.log(`   - TYR (Mock)    : ${contractsFound.Mock_TYR}`);
console.log(`   - WETH (Mock)   : ${contractsFound.Mock_WETH}`);
console.log(`   - TSLA (Mock)   : ${contractsFound.Mock_TSLA}`);

// -----------------------------------------------------------------------------
// 4. Execute DeployTreasury.s.sol (TreasuryRouter + PortfolioVault)
// -----------------------------------------------------------------------------
console.log("\n📦 [2/4] Deploying Treasury Contracts (DeployTreasury.s.sol)...");

// Use deployer address for guardian & budget on testnet, distinct dead address for reserve
const deadReserve = "0x000000000000000000000000000000000000dEaD";
const treasuryEnv = {
  ...process.env,
  DEPLOYER_PRIVATE_KEY: privateKey,
  USDG_ADDRESS: contractsFound.Mock_USDG,
  WETH_ADDRESS: contractsFound.Mock_WETH,
  GUARDIAN: contractsFound.StakeManager, // valid contract on testnet
  TREASURY_BUDGET: contractsFound.FeeSplitter, // valid contract on testnet
  TREASURY_RESERVE: deadReserve,
};

const deployTreasuryCmd = [
  "forge script script/DeployTreasury.s.sol:DeployTreasuryScript",
  `--rpc-url "${rpcUrl}"`,
  "--broadcast",
  `--private-key "${privateKey}"`,
  "-vv",
].join(" ");

try {
  execSync(deployTreasuryCmd, {
    cwd: contractsDir,
    stdio: "inherit",
    env: treasuryEnv,
  });
} catch (err) {
  console.error("\n❌ Deployment of DeployTreasury failed.");
  process.exit(1);
}

const treasuryBroadcastPath = path.join(
  contractsDir,
  "broadcast",
  "DeployTreasury.s.sol",
  String(chainId),
  "run-latest.json",
);

if (fs.existsSync(treasuryBroadcastPath)) {
  const treasuryRun = JSON.parse(fs.readFileSync(treasuryBroadcastPath, "utf-8"));
  for (const tx of treasuryRun.transactions || []) {
    if (tx.transactionType === "CREATE" && tx.contractName && tx.contractAddress) {
      contractsFound[tx.contractName] = tx.contractAddress;
    }
  }
}

console.log("\n✅ Treasury contracts deployed:");
console.log(`   - TreasuryRouter: ${contractsFound.TreasuryRouter}`);
console.log(`   - PortfolioVault: ${contractsFound.PortfolioVault}`);

// -----------------------------------------------------------------------------
// 4b. Deploy StockPriceOracle for TSLA
// -----------------------------------------------------------------------------
if (contractsFound.Mock_TSLA && contractsFound.Mock_Feed_TSLA) {
  console.log("\n📦 Deploying StockPriceOracle for TSLA (DeployStockOracle.s.sol)...");
  const oracleCmd = [
    "forge script script/DeployStockOracle.s.sol:DeployStockOracleScript",
    `--rpc-url "${rpcUrl}"`,
    "--broadcast",
    `--private-key "${privateKey}"`,
    "-vv",
  ].join(" ");

  try {
    execSync(oracleCmd, {
      cwd: contractsDir,
      stdio: "inherit",
      env: {
        ...process.env,
        DEPLOYER_PRIVATE_KEY: privateKey,
        STOCK_TICKER: "TSLA",
        STOCK_TOKEN: contractsFound.Mock_TSLA,
        STOCK_FEED: contractsFound.Mock_Feed_TSLA,
      },
    });

    const oracleBroadcastPath = path.join(
      contractsDir,
      "broadcast",
      "DeployStockOracle.s.sol",
      String(chainId),
      "run-latest.json",
    );
    if (fs.existsSync(oracleBroadcastPath)) {
      const oracleRun = JSON.parse(fs.readFileSync(oracleBroadcastPath, "utf-8"));
      for (const tx of oracleRun.transactions || []) {
        if (tx.transactionType === "CREATE" && tx.contractName === "StockPriceOracle" && tx.contractAddress) {
          contractsFound["StockPriceOracle_TSLA"] = tx.contractAddress;
        }
      }
    }
    console.log(`✅ StockPriceOracle (TSLA): ${contractsFound.StockPriceOracle_TSLA}`);
  } catch (err) {
    console.error("\n❌ Deployment of DeployStockOracle failed.");
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// 5. Update config/networks/testnet.json
// -----------------------------------------------------------------------------
console.log("\n📝 [3/4] Writing deployed addresses & startBlock to testnet.json...");

let parsedStartBlock = manifest.startBlock;
if (startBlockHex) {
  parsedStartBlock = parseInt(startBlockHex, 16);
}

manifest.startBlock = parsedStartBlock;
manifest.contracts.StakeManager = contractsFound.StakeManager || manifest.contracts.StakeManager;
manifest.contracts.UsdgVault = contractsFound.UsdgVault || manifest.contracts.UsdgVault;
manifest.contracts.FeeSplitter = contractsFound.FeeSplitter || manifest.contracts.FeeSplitter;
manifest.contracts.BuybackBurner = contractsFound.BuybackBurner || manifest.contracts.BuybackBurner;
manifest.contracts.TreasuryRouter = contractsFound.TreasuryRouter || manifest.contracts.TreasuryRouter;
manifest.contracts.PortfolioVault = contractsFound.PortfolioVault || manifest.contracts.PortfolioVault;

if (contractsFound.Mock_USDG) manifest.tokens.USDG.address = contractsFound.Mock_USDG;
if (contractsFound.Mock_TYR) manifest.tokens.TYR.address = contractsFound.Mock_TYR;
if (contractsFound.Mock_WETH) manifest.tokens.WETH.address = contractsFound.Mock_WETH;

if (manifest.stocks?.TSLA) {
  if (contractsFound.Mock_TSLA) manifest.stocks.TSLA.address = contractsFound.Mock_TSLA;
  if (contractsFound.Mock_Feed_TSLA) manifest.stocks.TSLA.feed = contractsFound.Mock_Feed_TSLA;
  if (contractsFound.StockVault) manifest.stocks.TSLA.vault = contractsFound.StockVault;
  if (contractsFound.StockPriceOracle_TSLA) {
    manifest.stocks.TSLA.oracle = contractsFound.StockPriceOracle_TSLA;
  }
  manifest.stocks.TSLA.enabled = false;
  manifest.features.stockTokens = false;
}

fs.writeFileSync(testnetJsonPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
console.log(`✅ Updated ${testnetJsonPath} successfully (startBlock: ${parsedStartBlock}).`);

// -----------------------------------------------------------------------------
// 6. Run sync & manifest verification
// -----------------------------------------------------------------------------
console.log("\n🔄 [4/4] Synchronizing ABIs & Verifying Manifest...");

execSync("node scripts/sync-foundry.mjs", { cwd: rootDir, stdio: "inherit" });
execSync("bun scripts/verify-manifest.ts testnet", { cwd: rootDir, stdio: "inherit" });

console.log("\n========================================================");
console.log("🎉 TESTNET DEPLOYMENT COMPLETE & MANIFEST VERIFIED!");
console.log("========================================================");
console.log("Next steps to start Ponder indexer:");
console.log("  1. bun run dev:indexer");
console.log("========================================================\n");
