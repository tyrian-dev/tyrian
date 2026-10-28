import { getDefaultConfig, type WalletList } from "@rainbow-me/rainbowkit";
import {
  base,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { defineChain } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { getNetworkManifest } from "@shared/contracts/addresses";

const testnetManifest = getNetworkManifest("testnet");
const mainnetManifest = getNetworkManifest("mainnet");

export const robinhoodTestnet = defineChain({
  id: testnetManifest.chainId,
  name: testnetManifest.label,
  nativeCurrency: {
    decimals: 18,
    name: "Ether",
    symbol: "ETH",
  },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_TESTNET_RPC_URL || testnetManifest.rpcUrl],
    },
    public: {
      http: [process.env.NEXT_PUBLIC_TESTNET_RPC_URL || testnetManifest.rpcUrl],
    },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Testnet Explorer",
      url: testnetManifest.explorer,
    },
  },
  testnet: true,
});

export const robinhoodMainnet = defineChain({
  id: mainnetManifest.chainId,
  name: mainnetManifest.label,
  nativeCurrency: {
    decimals: 18,
    name: "Ether",
    symbol: "ETH",
  },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_MAINNET_RPC_URL || mainnetManifest.rpcUrl],
    },
    public: {
      http: [process.env.NEXT_PUBLIC_MAINNET_RPC_URL || mainnetManifest.rpcUrl],
    },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: mainnetManifest.explorer,
    },
  },
  testnet: false,
});

const PROJECT_ID =
  process.env.NEXT_PUBLIC_WC_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64";

// MetaMask and Phantom are intentionally not listed here. Both announce
// themselves through EIP-6963, and a manual entry would claim their rdns first,
// preventing wagmi from registering the real injected provider. Letting
// EIP-6963 discover them keeps `window.ethereum` ownership irrelevant and puts
// installed wallets in RainbowKit's "Installed" group.
const wallets: WalletList = [
  {
    groupName: "Popular",
    wallets: [safeWallet, rainbowWallet, base, walletConnectWallet],
  },
];

export const config = getDefaultConfig({
  appName: "Tyrian",
  projectId: PROJECT_ID,
  wallets,
  // Ethereum mainnet/Sepolia are connection-only chains. Without them
  // RainbowKit would force a network switch during wallet connection; if the
  // wallet (for example Phantom with an inactive network) cannot switch, the
  // connect request can hang before Tyrian's onboarding modal is even shown.
  chains: [robinhoodTestnet, robinhoodMainnet, mainnet, sepolia],
  ssr: true,
});
