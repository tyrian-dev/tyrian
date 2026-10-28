import fs from "node:fs";
import path from "node:path";
import {
  getMainnetReadinessIssues,
  networkManifests,
} from "../shared/contracts/addresses";

const manifest = networkManifests.mainnet;
console.log("\n========================================================");
console.log("🛡️  TYRIAN MAINNET PREFLIGHT CHECK");
console.log("========================================================");
console.log(`Chain ID   : ${manifest.chainId}`);
console.log(`RPC URL    : ${manifest.rpcUrl}`);
console.log(`Explorer   : ${manifest.explorer}`);
console.log("========================================================\n");

const issues = getMainnetReadinessIssues(manifest);

if (issues.length === 0) {
  console.log("✅ Mainnet manifest is complete, verified, and ready for deployment!");
  process.exit(0);
} else {
  console.error(`❌ Mainnet preflight FAILED with ${issues.length} blocking issue(s):\n`);
  for (const issue of issues) {
    console.error(`   - ${issue}`);
  }
  console.error(
    "\n⚠️  Mainnet deployment is blocked until all external gates (Safe, timelock, feeds, DEX pools, and audit) are fulfilled.\n",
  );
  process.exit(1);
}
