import { reconciliationService } from "../backend/src/services/reconciliation";

async function main() {
  console.log("=== Tyrian On-Chain & Indexer Reconciliation ===");
  console.log("Starting reconciliation at:", new Date().toISOString());

  try {
    const report = await reconciliationService.runReconciliation();
    console.log(`\nNetwork: ${report.network} (Block: ${report.blockNumber ?? "N/A"})`);
    console.log(`Overall Status: ${report.status}`);
    console.log(`Total Difference: ${report.totalDiff}\n`);

    console.log("Assets Reconciled:");
    for (const asset of report.assets) {
      const matchIcon = asset.matched ? "✅ MATCH" : "❌ DIFF";
      const solvencyIcon = asset.solvent ? "✅ SOLVENT" : "⚠️ UNDERWATER";
      console.log(`  [${asset.symbol}] ${matchIcon}`);
      console.log(`    On-Chain Total Shares: ${asset.onChainTotalShares}`);
      console.log(`    Indexer Total Shares : ${asset.indexerTotalShares}`);
      console.log(`    Difference           : ${asset.diff}`);
      console.log(`    Vault Assets/Principal: ${asset.vaultAssets} / ${asset.vaultPrincipal} (${solvencyIcon})`);
    }

    if (!report.allMatched) {
      console.error("\n❌ RECONCILIATION FAILED: Differences detected between on-chain state and indexer!");
      process.exit(1);
    }

    console.log("\n✅ RECONCILIATION PASSED: 0 diff between on-chain contract state and indexer read model.");
    process.exit(0);
  } catch (err) {
    console.error("Fatal error during reconciliation:", err);
    process.exit(1);
  }
}

main();
