import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const outDir = path.join(rootDir, "contracts", "out");
const sharedAbisDir = path.join(rootDir, "shared", "contracts", "abis");

const contractsToExport = [
  { name: "StakeManager", sol: "StakeManager.sol" },
  { name: "UsdgVault", sol: "UsdgVault.sol" },
  { name: "StockVault", sol: "StockVault.sol" },
  { name: "FeeSplitter", sol: "FeeSplitter.sol" },
  { name: "BuybackBurner", sol: "BuybackBurner.sol" },
  { name: "TreasuryRouter", sol: "TreasuryRouter.sol" },
  { name: "PortfolioVault", sol: "PortfolioVault.sol" },
  { name: "StockPriceOracle", sol: "StockPriceOracle.sol" },
  { name: "TyrTwapOracle", sol: "TyrTwapOracle.sol" },
];

if (!fs.existsSync(sharedAbisDir)) {
  fs.mkdirSync(sharedAbisDir, { recursive: true });
}

const exportedNames = [];

for (const { name, sol } of contractsToExport) {
  const artifactPath = path.join(outDir, sol, `${name}.json`);
  if (!fs.existsSync(artifactPath)) {
    console.warn(`Artifact not found: ${artifactPath}`);
    continue;
  }

  const content = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  const abi = content.abi;

  const tsContent = `// Auto-generated ABI for ${name}
export const ${name}Abi = ${JSON.stringify(abi, null, 2)} as const;
`;

  fs.writeFileSync(path.join(sharedAbisDir, `${name}.ts`), tsContent, "utf-8");
  exportedNames.push(name);
  console.log(`Exported ABI for ${name}`);
}

const indexContent = exportedNames
  .map((name) => `export * from "./${name}";`)
  .join("\n") + "\n";

fs.writeFileSync(path.join(sharedAbisDir, "index.ts"), indexContent, "utf-8");
console.log("ABI index updated successfully.");
