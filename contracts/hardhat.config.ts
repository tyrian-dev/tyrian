import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
      },
      production: {
        version: "0.8.34",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    // Robinhood Chain testnet (chain id 46630).
    // chainType "generic": Robinhood Chain adalah Arbitrum Orbit L2, jadi bukan "l1"
    // dan bukan "op". URL RPC bersifat publik dan aman ditulis di file ini;
    // private key TIDAK boleh ditulis di file mana pun (pakai keystore / env).
    robinhoodTestnet: {
      type: "http",
      chainType: "generic",
      url: "https://rpc.testnet.chain.robinhood.com",
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
});
