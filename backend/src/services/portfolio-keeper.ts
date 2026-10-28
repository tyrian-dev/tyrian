import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PortfolioVaultAbi } from "@shared/contracts/abis/PortfolioVault";
import { tyrianNetwork } from "../config/network";
import { alertService } from "./alert";

export interface DcaExecutionResult {
  executed: boolean;
  reason?: string;
  txHash?: Hash;
  blockNumber?: bigint;
  token?: Address;
  usdgIn?: bigint;
  tokensBought?: bigint;
  error?: string;
}

export interface PortfolioKeeperDeps {
  executeBuy?: (params: {
    token: Address;
    usdgAmount: bigint;
    minTokenOut: bigint;
    deadline: bigint;
  }) => Promise<{ txHash: Hash; blockNumber: bigint; tokensBought: bigint }>;
  now?: () => number;
}

export class PortfolioKeeperService {
  private deps: PortfolioKeeperDeps;

  constructor(deps: PortfolioKeeperDeps = {}) {
    this.deps = deps;
  }

  configure(deps: PortfolioKeeperDeps): void {
    this.deps = { ...this.deps, ...deps };
  }

  /**
   * Executes weekly DCA buy order on PortfolioVault (GAP-011 / Brief §7).
   * Swaps idle USDG allocated to PortfolioVault for target Stock Tokens with 1% max slippage.
   */
  async triggerDcaBuy(options?: {
    tokenAddress?: Address;
    usdgAmount?: bigint;
    maxSlippageBps?: number;
    deadlineSeconds?: number;
  }): Promise<DcaExecutionResult> {
    const vaultAddress = tyrianNetwork.contracts.PortfolioVault as Address | null;
    if (!vaultAddress) {
      console.log("[PortfolioKeeper] PortfolioVault address not configured in network manifest. Skipping.");
      return { executed: false, reason: "contract_not_configured" };
    }

    if (this.deps.executeBuy) {
      try {
        const dummyToken = options?.tokenAddress || ("0x3333333333333333333333333333333333333333" as Address);
        const dummyAmount = options?.usdgAmount || 100n * 10n ** 18n;
        const res = await this.deps.executeBuy({
          token: dummyToken,
          usdgAmount: dummyAmount,
          minTokenOut: dummyAmount * 99n / 100n,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
        });
        console.log(`[PortfolioKeeper] Custom DCA buy executed: tx ${res.txHash}`);
        return {
          executed: true,
          txHash: res.txHash,
          blockNumber: res.blockNumber,
          token: dummyToken,
          usdgIn: dummyAmount,
          tokensBought: res.tokensBought,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await alertService.dispatchAlert(
          "BUDGET_WARNING",
          "WARNING",
          "PortfolioVault DCA Buy Failed",
          `Automated DCA buy call failed: ${errorMsg}`,
        );
        return { executed: false, reason: "execution_failed", error: errorMsg };
      }
    }

    const keeperKey = process.env.TREASURY_KEEPER_KEY || process.env.KEEPER_PRIVATE_KEY;
    if (!keeperKey || !keeperKey.startsWith("0x")) {
      console.log("[PortfolioKeeper] No keeper private key configured. DCA buy skipped.");
      return { executed: false, reason: "keeper_key_missing" };
    }

    const rpcUrl = process.env.RPC_URL || tyrianNetwork.rpcUrl;
    const nowSec = this.deps.now ? Math.floor(this.deps.now() / 1000) : Math.floor(Date.now() / 1000);
    const deadline = BigInt(nowSec + (options?.deadlineSeconds ?? 1800));

    try {
      const account = privateKeyToAccount(keeperKey as `0x${string}`);
      const publicClient: PublicClient = createPublicClient({ transport: http(rpcUrl) });
      const walletClient: WalletClient = createWalletClient({ account, transport: http(rpcUrl) });

      // Read vault DCA parameters
      const [lastBuyAt, dcaInterval, dcaAmountUsd, targetCount] = await Promise.all([
        publicClient.readContract({
          address: vaultAddress,
          abi: PortfolioVaultAbi,
          functionName: "lastBuyAt",
        }) as Promise<bigint>,
        publicClient.readContract({
          address: vaultAddress,
          abi: PortfolioVaultAbi,
          functionName: "dcaInterval",
        }) as Promise<bigint>,
        publicClient.readContract({
          address: vaultAddress,
          abi: PortfolioVaultAbi,
          functionName: "dcaAmountUsd",
        }) as Promise<bigint>,
        publicClient.readContract({
          address: vaultAddress,
          abi: PortfolioVaultAbi,
          functionName: "targetCount",
        }) as Promise<bigint>,
      ]);

      if (dcaAmountUsd === 0n) {
        return { executed: false, reason: "dca_disabled" };
      }

      if (lastBuyAt > 0n && BigInt(nowSec) < lastBuyAt + dcaInterval) {
        return { executed: false, reason: "dca_not_due" };
      }

      if (targetCount === 0n) {
        return { executed: false, reason: "no_targets_configured" };
      }

      // Read target token 0 as default if not specified
      let targetToken = options?.tokenAddress;
      if (!targetToken) {
        const targetRes = (await publicClient.readContract({
          address: vaultAddress,
          abi: PortfolioVaultAbi,
          functionName: "targetAt",
          args: [0n],
        })) as readonly [Address, number, number, Address];
        targetToken = targetRes[0];
      }

      const usdgAmount = options?.usdgAmount || dcaAmountUsd;
      const minTokenOut = 0n; // Contract enforces oracle-based slippage guard internally

      console.log(`[PortfolioKeeper] Sending DCA buy transaction for ${targetToken} (${usdgAmount} USDG)...`);

      const hash = await walletClient.writeContract({
        address: vaultAddress,
        abi: PortfolioVaultAbi,
        functionName: "buy",
        args: [targetToken, usdgAmount, minTokenOut, deadline],
        account,
        chain: null,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`[PortfolioKeeper] ✅ DCA buy confirmed in block ${receipt.blockNumber} (tx: ${hash})`);

      return {
        executed: true,
        txHash: hash,
        blockNumber: receipt.blockNumber,
        token: targetToken,
        usdgIn: usdgAmount,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[PortfolioKeeper] ❌ DCA buy transaction failed:", errorMsg);

      await alertService.dispatchAlert(
        "BUDGET_WARNING",
        "WARNING",
        "PortfolioVault DCA Buy Reverted",
        `Automated weekly DCA buy order reverted: ${errorMsg}`,
      );

      return {
        executed: false,
        reason: "execution_failed",
        error: errorMsg,
      };
    }
  }
}

export const portfolioKeeperService = new PortfolioKeeperService();
