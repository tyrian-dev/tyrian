"use client";

import { useState, useCallback } from "react";
import { useAccount, useChainId, usePublicClient, useWriteContract } from "wagmi";
import { erc20Abi, parseUnits, formatUnits, type Address } from "viem";
import { StakeManagerAbi } from "@shared/contracts/abis/StakeManager";
import {
  activeNetwork,
  findContractAddress,
  isAddress,
} from "@shared/contracts/addresses";
import { TARGET_CHAIN_ID } from "@/lib/wallet/targetChain";
import { formatWalletError } from "@/lib/wallet/errors";

export const mockErc20Abi = [
  ...erc20Abi,
  {
    type: "function",
    name: "mint",
    inputs: [
      { name: "to", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export type StakeTxStep = "idle" | "approving" | "staking" | "unstaking" | "withdrawing" | "minting" | "success" | "error";

export interface StakeContractState {
  step: StakeTxStep;
  txHash: `0x${string}` | null;
  error: string | null;
  isBusy: boolean;
}

export function useStakeContract() {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [state, setState] = useState<StakeContractState>({
    step: "idle",
    txHash: null,
    error: null,
    isBusy: false,
  });

  const stakeManagerAddress = findContractAddress(
    chainId || TARGET_CHAIN_ID,
    "StakeManager",
  ) as Address | undefined;

  const resetState = useCallback(() => {
    setState({
      step: "idle",
      txHash: null,
      error: null,
      isBusy: false,
    });
  }, []);

  /**
   * Reads ERC20 balance for a given token
   */
  const getBalance = useCallback(
    async (tokenAddress: Address): Promise<bigint> => {
      if (!publicClient || !address) return 0n;
      try {
        const bal = await publicClient.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        });
        return bal;
      } catch (err) {
        console.warn(`[useStakeContract] Failed to read balance for ${tokenAddress}:`, err);
        return 0n;
      }
    },
    [publicClient, address],
  );

  /**
   * Reads ERC20 allowance for StakeManager
   */
  const getAllowance = useCallback(
    async (tokenAddress: Address): Promise<bigint> => {
      if (!publicClient || !address || !stakeManagerAddress) return 0n;
      try {
        const allowance = await publicClient.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, stakeManagerAddress],
        });
        return allowance;
      } catch (err) {
        console.warn(`[useStakeContract] Failed to read allowance for ${tokenAddress}:`, err);
        return 0n;
      }
    },
    [publicClient, address, stakeManagerAddress],
  );

  /**
   * Approves StakeManager to spend tokens
   */
  const approveToken = useCallback(
    async (tokenAddress: Address, amount: bigint): Promise<`0x${string}` | null> => {
      if (!address || !stakeManagerAddress) {
        setState({ step: "error", txHash: null, error: "Wallet or contract not connected", isBusy: false });
        return null;
      }

      try {
        setState({ step: "approving", txHash: null, error: null, isBusy: true });
        const hash = await writeContractAsync({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "approve",
          args: [stakeManagerAddress, amount],
        });

        setState((prev) => ({ ...prev, txHash: hash }));

        if (publicClient) {
          await publicClient.waitForTransactionReceipt({ hash });
        }

        setState({ step: "idle", txHash: hash, error: null, isBusy: false });
        return hash;
      } catch (err) {
        const cleanErr = formatWalletError(err, "Approval failed");
        console.error("[useStakeContract] approve error:", err);
        if (cleanErr) {
          setState({ step: "error", txHash: null, error: cleanErr, isBusy: false });
        } else {
          setState({ step: "idle", txHash: null, error: null, isBusy: false });
        }
        throw err;
      }
    },
    [address, stakeManagerAddress, writeContractAsync, publicClient],
  );

  /**
   * Executes stake(asset, amount) on StakeManager
   */
  const stakeTokens = useCallback(
    async (tokenAddress: Address, amount: bigint): Promise<`0x${string}` | null> => {
      if (!address || !stakeManagerAddress) {
        setState({ step: "error", txHash: null, error: "Wallet or contract not connected", isBusy: false });
        return null;
      }

      try {
        setState({ step: "staking", txHash: null, error: null, isBusy: true });
        const hash = await writeContractAsync({
          address: stakeManagerAddress,
          abi: StakeManagerAbi,
          functionName: "stake",
          args: [tokenAddress, amount],
        });

        setState((prev) => ({ ...prev, txHash: hash }));

        if (publicClient) {
          await publicClient.waitForTransactionReceipt({ hash });
        }

        setState({ step: "success", txHash: hash, error: null, isBusy: false });
        return hash;
      } catch (err) {
        const cleanErr = formatWalletError(err, "Staking transaction failed");
        console.error("[useStakeContract] stake error:", err);
        if (cleanErr) {
          setState({ step: "error", txHash: null, error: cleanErr, isBusy: false });
        } else {
          setState({ step: "idle", txHash: null, error: null, isBusy: false });
        }
        throw err;
      }
    },
    [address, stakeManagerAddress, writeContractAsync, publicClient],
  );

  /**
   * Requests unstake on StakeManager
   */
  const requestUnstakeTokens = useCallback(
    async (tokenAddress: Address, amount: bigint): Promise<`0x${string}` | null> => {
      if (!address || !stakeManagerAddress) {
        setState({ step: "error", txHash: null, error: "Wallet or contract not connected", isBusy: false });
        return null;
      }

      try {
        setState({ step: "unstaking", txHash: null, error: null, isBusy: true });
        const hash = await writeContractAsync({
          address: stakeManagerAddress,
          abi: StakeManagerAbi,
          functionName: "requestUnstake",
          args: [tokenAddress, amount],
        });

        setState((prev) => ({ ...prev, txHash: hash }));

        if (publicClient) {
          await publicClient.waitForTransactionReceipt({ hash });
        }

        setState({ step: "success", txHash: hash, error: null, isBusy: false });
        return hash;
      } catch (err) {
        const cleanErr = formatWalletError(err, "Unstake request failed");
        console.error("[useStakeContract] requestUnstake error:", err);
        if (cleanErr) {
          setState({ step: "error", txHash: null, error: cleanErr, isBusy: false });
        } else {
          setState({ step: "idle", txHash: null, error: null, isBusy: false });
        }
        throw err;
      }
    },
    [address, stakeManagerAddress, writeContractAsync, publicClient],
  );

  /**
   * Withdraws matured unstake request
   */
  const withdrawTokens = useCallback(
    async (tokenAddress: Address, requestId: bigint): Promise<`0x${string}` | null> => {
      if (!address || !stakeManagerAddress) {
        setState({ step: "error", txHash: null, error: "Wallet or contract not connected", isBusy: false });
        return null;
      }

      try {
        setState({ step: "withdrawing", txHash: null, error: null, isBusy: true });
        const hash = await writeContractAsync({
          address: stakeManagerAddress,
          abi: StakeManagerAbi,
          functionName: "withdraw",
          args: [tokenAddress, requestId],
        });

        setState((prev) => ({ ...prev, txHash: hash }));

        if (publicClient) {
          await publicClient.waitForTransactionReceipt({ hash });
        }

        setState({ step: "success", txHash: hash, error: null, isBusy: false });
        return hash;
      } catch (err) {
        const cleanErr = formatWalletError(err, "Withdrawal failed");
        console.error("[useStakeContract] withdraw error:", err);
        if (cleanErr) {
          setState({ step: "error", txHash: null, error: cleanErr, isBusy: false });
        } else {
          setState({ step: "idle", txHash: null, error: null, isBusy: false });
        }
        throw err;
      }
    },
    [address, stakeManagerAddress, writeContractAsync, publicClient],
  );

  /**
   * Testnet Faucet: Mint mock ERC20 tokens directly
   */
  const mintMockTokens = useCallback(
    async (tokenAddress: Address, amount: bigint): Promise<`0x${string}` | null> => {
      if (!address) {
        setState({ step: "error", txHash: null, error: "Wallet not connected", isBusy: false });
        return null;
      }

      try {
        setState({ step: "minting", txHash: null, error: null, isBusy: true });
        const hash = await writeContractAsync({
          address: tokenAddress,
          abi: mockErc20Abi,
          functionName: "mint",
          args: [address, amount],
        });

        setState((prev) => ({ ...prev, txHash: hash }));

        if (publicClient) {
          await publicClient.waitForTransactionReceipt({ hash });
        }

        setState({ step: "success", txHash: hash, error: null, isBusy: false });
        return hash;
      } catch (err) {
        const cleanErr = formatWalletError(err, "Faucet mint failed");
        console.error("[useStakeContract] mintMockTokens error:", err);
        if (cleanErr) {
          setState({ step: "error", txHash: null, error: cleanErr, isBusy: false });
        } else {
          setState({ step: "idle", txHash: null, error: null, isBusy: false });
        }
        throw err;
      }
    },
    [address, writeContractAsync, publicClient],
  );

  const getExplorerTxUrl = (hash: string | null) => {
    if (!hash) return "";
    const base = activeNetwork.explorer.replace(/\/+$/, "");
    return `${base}/tx/${hash}`;
  };

  return {
    stakeManagerAddress,
    state,
    resetState,
    getBalance,
    getAllowance,
    approveToken,
    stakeTokens,
    requestUnstakeTokens,
    withdrawTokens,
    mintMockTokens,
    getExplorerTxUrl,
  };
}
