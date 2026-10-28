import type { Chain } from "viem";
import { robinhoodMainnet, robinhoodTestnet } from "@/config/wagmi";
import { activeNetwork, networkManifests } from "@shared/contracts/addresses";

export const TARGET_CHAIN_ID = networkManifests[activeNetwork.name].chainId;

export const TARGET_CHAIN: Chain =
  TARGET_CHAIN_ID === robinhoodMainnet.id ? robinhoodMainnet : robinhoodTestnet;

export function isTargetChain(chainId?: number): boolean {
  return chainId === TARGET_CHAIN_ID;
}
