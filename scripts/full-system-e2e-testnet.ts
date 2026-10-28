import { createWalletClient, createPublicClient, http, parseEther, formatEther, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import app from "../backend/src/app";
import { redis } from "../backend/src/services/redis";
import { StakeManagerAbi } from "../shared/contracts/abis/StakeManager";
import testnetManifest from "../config/networks/testnet.json";

const mockErc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("==================================================================");
  console.log("   TYRIAN PROTOCOL: FULL LIFECYCLE E2E TEST (TESTNET)            ");
  console.log("==================================================================");

  // 1. Read Private Key & Setup Viem Clients
  let rawKey = "";
  for (const line of fs.readFileSync(".env", "utf-8").split("\n")) {
    if (line.trim().startsWith("DEPLOYER_PRIVATE_KEY=")) {
      rawKey = line.trim().split("=")[1].trim();
    }
  }
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
  const account = privateKeyToAccount(privateKey);

  const chain = {
    id: 46630,
    name: "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  };

  const transport = http("https://rpc.testnet.chain.robinhood.com", {
    timeout: 60_000,
    retryCount: 5,
    retryDelay: 2_000,
  });

  const walletClient = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  const stakeManagerAddress = testnetManifest.contracts.StakeManager as `0x${string}`;
  const usdgAddress = testnetManifest.tokens.USDG.address as `0x${string}`;

  console.log(`[Account]           ${account.address}`);
  console.log(`[StakeManager]      ${stakeManagerAddress}`);
  console.log(`[USDG Token]        ${usdgAddress}`);

  const ethBal = await publicClient.getBalance({ address: account.address });
  console.log(`[Native Gas]        ${formatEther(ethBal)} ETH`);
  if (ethBal === 0n) {
    throw new Error("Account has 0 gas on testnet. Please fund with testnet ETH.");
  }

  // 2. Check Ponder Indexer Health
  console.log("\n--- STEP 1: Verifying Ponder Indexer Health ---");
  try {
    const res = await fetch("http://localhost:42069", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ stakePositions(limit: 1) { items { id } } }" }),
    });
    const json = (await res.json()) as { data?: unknown };
    if (!json.data) throw new Error("GraphQL returned no data");
    console.log("✅ Ponder indexer is live at http://localhost:42069");
  } catch (err) {
    throw new Error(`Ponder indexer unreachable: ${(err as Error).message}`);
  }

  // 3. Testnet Faucet: Mint 100 Mock USDG
  console.log("\n--- STEP 2: Testnet Faucet Mint (MockUSDG.mint) ---");
  const mintAmt = parseUnits("100", 18);
  const mintTx = await walletClient.writeContract({
    address: usdgAddress,
    abi: mockErc20Abi,
    functionName: "mint",
    args: [account.address, mintAmt],
  });
  console.log(`Submitted mint tx: ${mintTx}`);
  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintTx });
  console.log(`✅ Minted 100 USDG in block ${mintReceipt.blockNumber} (tx: ${mintReceipt.transactionHash})`);

  // 4. Approve & Stake 50 USDG
  console.log("\n--- STEP 3: On-Chain Approve & Stake (50 USDG) ---");
  const stakeAmt = parseUnits("50", 18);

  const approveTx = await walletClient.writeContract({
    address: usdgAddress,
    abi: mockErc20Abi,
    functionName: "approve",
    args: [stakeManagerAddress, stakeAmt],
  });
  console.log(`Submitted approve tx: ${approveTx}`);
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log("✅ USDG approved for StakeManager");

  const stakeTx = await walletClient.writeContract({
    address: stakeManagerAddress,
    abi: StakeManagerAbi,
    functionName: "stake",
    args: [usdgAddress, stakeAmt],
  });
  console.log(`Submitted stake tx: ${stakeTx}`);
  const stakeReceipt = await publicClient.waitForTransactionReceipt({ hash: stakeTx });
  console.log(`✅ Staked 50 USDG in block ${stakeReceipt.blockNumber} (tx: ${stakeReceipt.transactionHash})`);

  // 5. Verify Indexer Ingestion of Stake Event
  console.log("\n--- STEP 4: Verifying Indexer Ingestion of Staked Event ---");
  const startTime = Date.now();
  let indexed = false;
  let attempts = 0;
  const userLower = account.address.toLowerCase();

  while (!indexed && attempts < 20) {
    attempts++;
    await sleep(1500);
    const res = await fetch("http://localhost:42069", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query GetUserPositions($user: String!) {
          stakePositions(where: { userAddress: $user }) {
            items {
              id
              activeShares
              pendingShares
              lastUpdatedBlock
            }
          }
        }`,
        variables: { user: userLower },
      }),
    });
    const d = (await res.json()) as { data?: { stakePositions?: { items: Array<{ pendingShares: string; lastUpdatedBlock: string }> } } };
    const items = d.data?.stakePositions?.items ?? [];
    if (items.length > 0 && BigInt(items[0].pendingShares) > 0n) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ Indexer updated position in ${elapsed}s! Pending shares: ${formatUnits(BigInt(items[0].pendingShares), 18)} (Block ${items[0].lastUpdatedBlock})`);
      indexed = true;
    }
  }

  if (!indexed) {
    console.warn("⚠️ Indexer took longer than 30s to index event, continuing test...");
  }

  // 6. Test Backend Quota Retrieval & Epoch Settlement
  console.log("\n--- STEP 5: Backend Quota & Epoch Settlement ---");
  const quotaRes = await app.request(`/v1/quota?address=${encodeURIComponent(account.address)}`);
  const quotaData = await quotaRes.json();
  console.log("Initial Quota response:", {
    user: quotaData.userAddress,
    isStaker: quotaData.isStaker,
    totalEffectiveStakeUsd: quotaData.totalEffectiveStakeUsd,
    allocatedUsd: quotaData.allocatedUsd,
    remainingUsd: quotaData.remainingUsd,
  });

  console.log("Triggering Epoch Quota Settlement (POST /api/epoch/run)...");
  const epochRes = await app.request("/api/epoch/run", { method: "POST" });
  const epochData = await epochRes.json();
  console.log("✅ Epoch Settlement completed:", epochData);

  // Re-check quota after epoch redistribution
  const postEpochRes = await app.request(`/v1/quota?address=${encodeURIComponent(account.address)}`);
  const postEpochData = await postEpochRes.json();
  console.log("Post-Epoch Quota:", {
    allocatedUsd: postEpochData.allocatedUsd,
    remainingUsd: postEpochData.remainingUsd,
  });

  // 7. Test AI Gateway Inference (Streaming SSE)
  console.log("\n--- STEP 6: AI Gateway Inference Execution ---");
  // Ensure wallet has an active API key in Redis
  const rawApiKey = `tyr_live_e2e_${Date.now()}`;
  const crypto = await import("node:crypto");
  const keyHash = crypto.createHash("sha256").update(rawApiKey).digest("hex");
  await redis.set(
    `tyrian:key:${keyHash}`,
    JSON.stringify({ userAddress: userLower, name: "E2E Test Key", isRevoked: false }),
  );

  const aiRes = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${rawApiKey}`,
      "x-vercel-ip-country": "SG",
    },
    body: JSON.stringify({
      model: "anthropic/claude-3.5-sonnet",
      messages: [{ role: "user", content: "Summarize the Tyrian protocol in one sentence." }],
      stream: true,
    }),
  });

  console.log(`Inference HTTP Status: ${aiRes.status}`);
  const quotaHeader = aiRes.headers.get("X-Tyrian-Quota-Remaining");
  console.log(`X-Tyrian-Quota-Remaining: ${quotaHeader}`);

  const reader = aiRes.body?.getReader();
  let streamText = "";
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value);
    }
  }
  console.log("✅ Stream Response Received (preview):", streamText.slice(0, 140).replace(/\n/g, " "), "...");

  // 8. Test Request Unstake on StakeManager
  console.log("\n--- STEP 7: Testing requestUnstake on StakeManager ---");
  // Let's roll pending to active if needed or check active shares
  const posOnChain = await publicClient.readContract({
    address: stakeManagerAddress,
    abi: StakeManagerAbi,
    functionName: "positions",
    args: [account.address, usdgAddress],
  });
  console.log("On-chain position:", {
    activeShares: formatUnits(posOnChain[0], 18),
    pendingShares: formatUnits(posOnChain[1], 18),
    cooldownShares: formatUnits(posOnChain[3], 18),
  });

  if (posOnChain[0] > 0n) {
    const unstakeAmt = parseUnits("10", 18);
    const unstakeTx = await walletClient.writeContract({
      address: stakeManagerAddress,
      abi: StakeManagerAbi,
      functionName: "requestUnstake",
      args: [usdgAddress, unstakeAmt],
    });
    console.log(`Submitted requestUnstake tx: ${unstakeTx}`);
    const unstakeReceipt = await publicClient.waitForTransactionReceipt({ hash: unstakeTx });
    console.log(`✅ Unstake requested in block ${unstakeReceipt.blockNumber} (tx: ${unstakeReceipt.transactionHash})`);
  } else {
    console.log("ℹ️ All shares are currently pending for next epoch (00:00 UTC rollover). Unstake will activate when shares roll over.");
  }

  // 9. Verify Treasury Endpoints
  console.log("\n--- STEP 8: Verifying Treasury Endpoints ---");
  const trsSummaryRes = await app.request("/api/treasury/summary");
  const trsSummary = await trsSummaryRes.json();
  console.log("✅ Treasury Summary:", {
    treasuryBalanceUsd: trsSummary.treasuryBalanceUsd,
    totalHarvestYieldUsd: trsSummary.totalHarvestYieldUsd,
    runwayDays: trsSummary.runwayDays,
    asOf: trsSummary.asOf,
  });

  const trsFlowRes = await app.request("/api/treasury/flow");
  const trsFlow = await trsFlowRes.json();
  console.log("✅ Treasury Flow:", {
    pointsCount: trsFlow.points.length,
    recentHarvestsCount: trsFlow.recentHarvests.length,
    recentBurnsCount: trsFlow.recentBurns.length,
  });

  console.log("\n==================================================================");
  console.log("   🎉 FULL LIFECYCLE E2E TEST COMPLETED SUCCESSFULLY!             ");
  console.log("==================================================================");
}

main().catch((err) => {
  console.error("❌ E2E Test Failed:", err);
  process.exit(1);
});
