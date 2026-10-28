import "dotenv/config";
import { createConfig, rateLimit } from "ponder";
import { createResilientRpcTransport } from "@shared/contracts/rpc";
import {
  StakeManagerAbi,
  FeeSplitterAbi,
  UsdgVaultAbi,
  StockVaultAbi,
  BuybackBurnerAbi,
  TreasuryRouterAbi,
} from "@shared/contracts/abis";
import {
  getNetworkManifest,
  getStockVaults,
  isAddress,
  resolveNetworkName,
  type ContractName,
} from "@shared/contracts/addresses";

const networkName = resolveNetworkName(
  process.env.INDEXER_NETWORK ?? process.env.TYRIAN_NETWORK ?? process.env.APP_ENV,
);
const manifest = getNetworkManifest(networkName);
const startBlock = manifest.startBlock;
const rpcUrl = process.env.INDEXER_RPC_URL?.trim() || manifest.rpcUrl;
const fallbackUrls = process.env.INDEXER_RPC_FALLBACK_URLS?.trim() || "";

if (startBlock === null || startBlock === 0) {
  throw new Error(
    `Indexer startBlock is not configured for ${networkName}. ` +
      `Fill config/networks/${networkName}.json after deployment.`,
  );
}

const abis = {
  StakeManager: StakeManagerAbi,
  FeeSplitter: FeeSplitterAbi,
  UsdgVault: UsdgVaultAbi,
  BuybackBurner: BuybackBurnerAbi,
  TreasuryRouter: TreasuryRouterAbi,
} as const;

const contracts: Record<string, unknown> = {};
for (const [name, abi] of Object.entries(abis) as Array<[ContractName, unknown]>) {
  const address = manifest.contracts[name];
  if (!isAddress(address)) continue;
  contracts[name] = {
    network: {
      [networkName]: { address, startBlock },
    },
    abi,
  };
}

// One StockVault per ticker. Ponder accepts multiple addresses for one contract
// key, so a single "StockVault:Harvested" handler covers all stock vaults.
// Register it even with an empty array: the handler still resolves, and an
// empty address list matches no logs until vaults are added to the manifest.
const stockVaults = getStockVaults(networkName);
contracts.StockVault = {
  network: {
    [networkName]: { address: stockVaults, startBlock },
  },
  abi: StockVaultAbi,
};

if (!contracts.StakeManager) {
  throw new Error(
    `StakeManager address is missing in config/networks/${networkName}.json.`,
  );
}

const databaseConfig = process.env.DATABASE_URL
  ? {
      kind: "postgres" as const,
      connectionString: process.env.DATABASE_URL,
      schema: process.env.DATABASE_SCHEMA || "ponder",
    }
  : undefined;

export default createConfig({
  database: databaseConfig,
  networks: {
    [networkName]: {
      chainId: manifest.chainId,
      transport: rateLimit(
        createResilientRpcTransport(rpcUrl, fallbackUrls, {
          timeout: 60_000,
          retryCount: 5,
          retryDelay: 1_000,
        }),
        { requestsPerSecond: 15 },
      ),
    },
  },
  contracts,
} as never);
