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
import { TreasuryRouterAbi } from "@shared/contracts/abis/TreasuryRouter";
import { tyrianNetwork } from "../config/network";
import { alertService } from "./alert";

export interface RouteExecutionResult {
  executed: boolean;
  reason?: string;
  txHash?: Hash;
  blockNumber?: bigint;
  error?: string;
}

export interface TreasuryKeeperDeps {
  executeRoute?: () => Promise<{ txHash: Hash; blockNumber: bigint }>;
  now?: () => number;
}

export class TreasuryKeeperService {
  private deps: TreasuryKeeperDeps;

  constructor(deps: TreasuryKeeperDeps = {}) {
    this.deps = deps;
  }

  configure(deps: TreasuryKeeperDeps): void {
    this.deps = deps;
  }

  /**
   * Executes TreasuryRouter.route() on-chain (GAP-006 / Brief §7).
   * Swaps any pending WETH to USDG, then splits USDG 70% budget / 20% reserve / 10% portfolio.
   * Idempotent: If no funds are pending, contract emits NothingToRoute without failing.
   */
  async triggerRoute(options?: { minUsdgOut?: bigint; deadlineSeconds?: number }): Promise<RouteExecutionResult> {
    const routerAddress = tyrianNetwork.contracts.TreasuryRouter as Address | null;
    if (!routerAddress) {
      console.log("[TreasuryKeeper] TreasuryRouter address not configured in network manifest. Skipping.");
      return { executed: false, reason: "contract_not_configured" };
    }

    if (this.deps.executeRoute) {
      try {
        const res = await this.deps.executeRoute();
        console.log(`[TreasuryKeeper] Custom route executed: tx ${res.txHash}`);
        return { executed: true, txHash: res.txHash, blockNumber: res.blockNumber };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await alertService.dispatchAlert(
          "BUDGET_WARNING",
          "WARNING",
          "TreasuryRouter Route Failed",
          `Automated route call failed: ${errorMsg}`,
        );
        return { executed: false, reason: "execution_failed", error: errorMsg };
      }
    }

    const keeperKey = process.env.TREASURY_KEEPER_KEY || process.env.KEEPER_PRIVATE_KEY;
    if (!keeperKey || !keeperKey.startsWith("0x")) {
      console.log("[TreasuryKeeper] No keeper private key configured. Automated on-chain routing skipped.");
      return { executed: false, reason: "keeper_key_missing" };
    }

    const rpcUrl = process.env.RPC_URL || tyrianNetwork.rpcUrl;
    const nowSec = this.deps.now ? Math.floor(this.deps.now() / 1000) : Math.floor(Date.now() / 1000);
    const deadline = BigInt(nowSec + (options?.deadlineSeconds ?? 1800)); // 30m deadline
    const minOut = options?.minUsdgOut ?? 0n;

    try {
      const account = privateKeyToAccount(keeperKey as `0x${string}`);
      const publicClient: PublicClient = createPublicClient({
        transport: http(rpcUrl),
      });

      const walletClient: WalletClient = createWalletClient({
        account,
        transport: http(rpcUrl),
      });

      console.log(`[TreasuryKeeper] Sending route transaction to ${routerAddress} via keeper ${account.address}...`);

      const hash = await walletClient.writeContract({
        address: routerAddress,
        abi: TreasuryRouterAbi,
        functionName: "route",
        args: [minOut, deadline],
        account,
        chain: null,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`[TreasuryKeeper] ✅ route() confirmed in block ${receipt.blockNumber} (tx: ${hash})`);

      return {
        executed: true,
        txHash: hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[TreasuryKeeper] ❌ route() transaction failed:", errorMsg);

      await alertService.dispatchAlert(
        "BUDGET_WARNING",
        "WARNING",
        "TreasuryRouter Execution Reverted",
        `Automated daily treasury routing failed: ${errorMsg}`,
      );

      return {
        executed: false,
        reason: "execution_failed",
        error: errorMsg,
      };
    }
  }
}

export const treasuryKeeperService = new TreasuryKeeperService();
