import { createWalletClient, createPublicClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";

async function main() {
  console.log("==================================================");
  console.log("   TYRIAN INDEXER LIVE SMOKE TEST (TESTNET)      ");
  console.log("==================================================");

  // 1. Setup Client
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
    rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } }
  };

  const transport = http("https://rpc.testnet.chain.robinhood.com", {
    timeout: 60_000,
    retryCount: 5,
    retryDelay: 2_000
  });

  const walletClient = createWalletClient({
    account,
    chain,
    transport
  });

  const publicClient = createPublicClient({
    chain,
    transport
  });

  const manifest = JSON.parse(fs.readFileSync("config/networks/testnet.json", "utf-8"));
  const stakeManagerAddress = manifest.contracts.StakeManager as `0x${string}`;
  const usdgVaultAddress = manifest.contracts.UsdgVault as `0x${string}`;
  const usdgAddress = manifest.tokens.USDG.address as `0x${string}`;

  console.log("Deployer Address :", account.address);
  console.log("StakeManager     :", stakeManagerAddress);
  console.log("UsdgVault        :", usdgVaultAddress);
  console.log("Mock USDG        :", usdgAddress);

  // Check ETH Balance
  const ethBalance = await publicClient.getBalance({ address: account.address });
  console.log("ETH Balance      :", formatEther(ethBalance), "ETH");

  const erc20Abi = [
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "uint256" }]
    },
    {
      type: "function",
      name: "mint",
      stateMutability: "nonpayable",
      inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
      outputs: []
    },
    {
      type: "function",
      name: "approve",
      stateMutability: "nonpayable",
      inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
      outputs: [{ name: "", type: "bool" }]
    },
    {
      type: "function",
      name: "transfer",
      stateMutability: "nonpayable",
      inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
      outputs: [{ name: "", type: "bool" }]
    }
  ] as const;

  const stakeManagerAbi = [
    {
      type: "function",
      name: "stake",
      stateMutability: "nonpayable",
      inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }],
      outputs: []
    }
  ] as const;

  const stakeAmount = parseEther("100");

  // Check USDG Balance
  let usdgBalance = await publicClient.readContract({
    address: usdgAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address]
  });
  console.log("USDG Balance     :", formatEther(usdgBalance), "USDG");

  if (usdgBalance < stakeAmount) {
    console.log("\n-> Minting 1,000 USDG to deployer...");
    const mintHash = await walletClient.writeContract({
      address: usdgAddress,
      abi: erc20Abi,
      functionName: "mint",
      args: [account.address, parseEther("1000")]
    });
    console.log("   Mint tx:", mintHash);
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    console.log("   Mint confirmed!");
  }

  // Approve USDG
  console.log("\n-> Step 1: Approving 100 USDG to StakeManager...");
  const approveHash = await walletClient.writeContract({
    address: usdgAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [stakeManagerAddress, stakeAmount]
  });
  console.log("   Approve tx hash:", approveHash);
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log("   Approve confirmed in block:", approveReceipt.blockNumber);

  // Stake USDG
  console.log("\n-> Step 2: Calling StakeManager.stake(MockUSDG, 100 USDG)...");
  const startTime = Date.now();
  const stakeHash = await walletClient.writeContract({
    address: stakeManagerAddress,
    abi: stakeManagerAbi,
    functionName: "stake",
    args: [usdgAddress, stakeAmount]
  });
  console.log("   Stake tx hash:", stakeHash);
  const stakeReceipt = await publicClient.waitForTransactionReceipt({ hash: stakeHash });
  const blockConfirmedTime = Date.now();
  console.log(`   Transaction included in block ${stakeReceipt.blockNumber} (tx wait: ${((blockConfirmedTime - startTime) / 1000).toFixed(1)}s)`);

  // Step 3: Verify Ponder live ingestion
  console.log("\n-> Step 3: Polling Ponder (http://localhost:42069) for live event ingestion...");
  let indexed = false;
  const pollStart = Date.now();

  for (let attempt = 1; attempt <= 20; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
    try {
      const res = await fetch("http://localhost:42069/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `{
            stakePositions(where: { userAddress: "${account.address.toLowerCase()}" }) {
              items {
                id
                userAddress
                assetAddress
                activeShares
                pendingShares
                cooldownShares
                lastUpdatedBlock
              }
            }
          }`
        })
      });
      const data = await res.json();
      const items = data.data?.stakePositions?.items || [];
      if (items.length > 0) {
        console.log(`\n🎉 SUCCESS! Ponder ingested StakeManager:Staked event!`);
        console.log(`   Ingestion Latency: ${elapsed}s after block confirmation`);
        console.log("   Position Record in Ponder DB:");
        console.log(JSON.stringify(items[0], null, 2));
        indexed = true;
        break;
      } else {
        process.stdout.write(`   [${elapsed}s] Waiting for Ponder poll head... \r`);
      }
    } catch (err) {
      process.stdout.write(`   [${elapsed}s] Ponder query error: ${err.message} \r`);
    }
  }

  if (!indexed) {
    console.log("\n⚠️ Timeout waiting for Ponder to index block. Check Ponder logs.");
  }

  // Step 4: Simulate Yield & Test Harvest Event
  console.log("\n-> Step 4: Simulating Yield by transferring 5 USDG directly to UsdgVault...");
  const yieldAmount = parseEther("5");
  const transferHash = await walletClient.writeContract({
    address: usdgAddress,
    abi: erc20Abi,
    functionName: "transfer",
    args: [usdgVaultAddress, yieldAmount]
  });
  console.log("   Transfer tx hash:", transferHash);
  await publicClient.waitForTransactionReceipt({ hash: transferHash });
  console.log("   Transfer confirmed!");

  console.log("\n-> Step 5: Calling UsdgVault.harvest()...");
  const harvestStartTime = Date.now();
  const harvestHash = await walletClient.writeContract({
    address: usdgVaultAddress,
    abi: [
      {
        type: "function",
        name: "harvest",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [{ name: "yieldAmount", type: "uint256" }]
      }
    ] as const,
    functionName: "harvest"
  });
  console.log("   Harvest tx hash:", harvestHash);
  const harvestReceipt = await publicClient.waitForTransactionReceipt({ hash: harvestHash });
  console.log(`   Harvest confirmed in block ${harvestReceipt.blockNumber} (tx wait: ${((Date.now() - harvestStartTime) / 1000).toFixed(1)}s)`);

  // Step 6: Verify Harvest event in Ponder
  console.log("\n-> Step 6: Polling Ponder (http://localhost:42069) for Harvested event...");
  let harvestIndexed = false;
  const harvestPollStart = Date.now();

  for (let attempt = 1; attempt <= 20; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const elapsed = ((Date.now() - harvestPollStart) / 1000).toFixed(1);
    try {
      const res = await fetch("http://localhost:42069/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `{
            harvestEvents {
              items {
                id
                token
                yieldAmount
                treasury
                txHash
                blockTimestamp
              }
            }
          }`
        })
      });
      const data = await res.json();
      const items = data.data?.harvestEvents?.items || [];
      if (items.length > 0) {
        console.log(`\n🎉 SUCCESS! Ponder ingested UsdgVault:Harvested event!`);
        console.log(`   Ingestion Latency: ${elapsed}s after block confirmation`);
        console.log("   Harvest Event Record in Ponder DB:");
        console.log(JSON.stringify(items[0], null, 2));
        harvestIndexed = true;
        break;
      } else {
        process.stdout.write(`   [${elapsed}s] Waiting for Ponder harvest head... \r`);
      }
    } catch (err) {
      process.stdout.write(`   [${elapsed}s] Ponder query error: ${err.message} \r`);
    }
  }

  if (!harvestIndexed) {
    console.log("\n⚠️ Timeout waiting for Ponder to index harvest block. Check Ponder logs.");
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
