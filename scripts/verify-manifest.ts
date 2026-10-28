import {
  getMainnetReadinessIssues,
  getManifestIssues,
  networkManifests,
  resolveNetworkName,
  type NetworkManifest,
  type NetworkName,
} from "../shared/contracts/addresses";

type Target = NetworkName | "all";

function parseTarget(value: string | undefined): Target {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "" || normalized === "testnet") return "testnet";
  if (normalized === "mainnet") return "mainnet";
  if (normalized === "all") return "all";
  return resolveNetworkName(normalized);
}

function describe(manifest: NetworkManifest): string {
  return `${manifest.name} (chain ${manifest.chainId})`;
}

function verifyOne(manifest: NetworkManifest, requireReady: boolean): string[] {
  const issues = requireReady
    ? getMainnetReadinessIssues(manifest)
    : getManifestIssues(manifest);

  if (issues.length === 0) {
    console.log(`OK   ${describe(manifest)} — manifest valid`);
  } else {
    console.error(`FAIL ${describe(manifest)} — ${issues.length} issue(s)`);
    for (const issue of issues) console.error(`     - ${issue}`);
  }

  return issues;
}

const target = parseTarget(process.argv[2] ?? process.env.TYRIAN_NETWORK);
const targets: NetworkName[] =
  target === "all" ? ["testnet", "mainnet"] : [target];

let failed = false;
for (const name of targets) {
  const manifest = networkManifests[name];
  const requireReady = manifest.name === "mainnet";
  const issues = verifyOne(manifest, requireReady);
  if (issues.length > 0) failed = true;
}

if (failed) {
  console.error(
    "\nManifest verification failed. Isi alamat/feed/startBlock dari deployment " +
      "yang sudah diverifikasi; jangan memakai zero address atau mock.",
  );
  process.exit(1);
}

console.log("\nManifest verification passed.");
