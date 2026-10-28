import fs from "node:fs";
import path from "node:path";

/**
 * Safety-critical coverage gate.
 *
 * Bun/Foundry report line coverage separately (`bun test --coverage`,
 * `bun run contracts:coverage`). This script enforces the smaller, binary
 * contract that matters before a release: every module on a fail-closed path
 * must have a test file that actually imports it and contains assertions.
 *
 * Usage:
 *   bun scripts/check-coverage.ts
 */

const ROOT = process.cwd();

interface Requirement {
  area: string;
  source: string;
  tests: string[];
  note: string;
}

const REQUIREMENTS: Requirement[] = [
  {
    area: "Price oracle routing",
    source: "backend/src/services/pricing.ts",
    tests: ["backend/test/pricing.test.ts"],
    note: "TYR/stock prices are fail-closed; tests cover zero, revert, absurd, cache, USDG peg",
  },
  {
    area: "Epoch fail-closed",
    source: "backend/src/cron/epoch.ts",
    tests: ["backend/test/pricing.test.ts", "backend/test/epoch-formula.test.ts"],
    note: "An unavailable TYR price must fail the epoch, never use a hardcoded value",
  },
  {
    area: "Quota/time pricing",
    source: "backend/src/services/quota.ts",
    tests: ["backend/test/gateway.test.ts", "backend/test/epoch-formula.test.ts"],
    note: "Quota math and zero-stake behavior",
  },
  {
    area: "Reconciliation status",
    source: "backend/src/services/reconciliation.ts",
    tests: ["backend/test/reconciliation.test.ts", "backend/test/epoch-reconciliation.test.ts"],
    note: "Failed/in-progress epochs are not reported as MATCH",
  },
  {
    area: "Provider credentials",
    source: "backend/src/services/openrouter.ts",
    tests: ["backend/test/openrouter.test.ts"],
    note: "No implicit mock, no global-key fallback, explicit 503",
  },
  {
    area: "Runtime config",
    source: "backend/src/config/validate.ts",
    tests: ["backend/test/runtime-config.test.ts"],
    note: "Mainnet refuses mock inference, geo opt-out, wildcard CORS, missing infra",
  },
  {
    area: "Geo fail-closed",
    source: "backend/src/middleware/geo.ts",
    tests: ["backend/test/geo.test.ts"],
    note: "Missing country header is denied in strict/production mode",
  },
  {
    area: "Mainnet deploy guards",
    source: "contracts/script/lib/MainnetGuards.sol",
    tests: [
      "contracts/test/ConfigureProtocolGuard.t.sol",
      "contracts/test/StockVaultGuard.t.sol",
    ],
    note: "Manifest/chain/deployer/treasury/stock guards",
  },
  {
    area: "Ownership handover",
    source: "contracts/script/lib/Ownership.sol",
    tests: ["contracts/test/MainnetRehearsal.t.sol"],
    note: "Full-stack deploy + transferOwnership rehearsal",
  },
  {
    area: "Post-deploy verification",
    source: "contracts/script/VerifyMainnet.s.sol",
    tests: ["contracts/test/MainnetRehearsal.t.sol"],
    note: "Ownership, treasury wiring, staking/stocks, governance thresholds",
  },
];

function read(relativePath: string): string {
  const absolute = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Missing file: ${relativePath}`);
  }
  return fs.readFileSync(absolute, "utf-8");
}

function testHasAssertion(contents: string): boolean {
  return /\b(expect|assert|assertEq|assertTrue|assertFalse|expectRevert|expectEmit)\b/.test(
    contents,
  );
}

let failures = 0;

console.log("\n========================================================");
console.log("🧪 TYRIAN SAFETY-CRITICAL COVERAGE GATE");
console.log("========================================================");

for (const requirement of REQUIREMENTS) {
  let ok = fs.existsSync(path.join(ROOT, requirement.source));

  for (const testFile of requirement.tests) {
    const absolute = path.join(ROOT, testFile);
    if (!fs.existsSync(absolute)) {
      console.log(`❌ ${requirement.area}: missing test ${testFile}`);
      ok = false;
      continue;
    }

    const contents = fs.readFileSync(absolute, "utf-8");
    const sourceModule = requirement.source
      .replace(/^backend\/src\//, "")
      .replace(/^contracts\//, "")
      .replace(/\.ts$/, "")
      .replace(/\.sol$/, "");
    const imported =
      contents.includes(sourceModule) ||
      contents.includes(path.basename(requirement.source).replace(/\.ts$/, "")) ||
      contents.includes(path.basename(requirement.source).replace(/\.sol$/, ""));

    if (!imported) {
      console.log(`❌ ${requirement.area}: ${testFile} does not reference ${requirement.source}`);
      ok = false;
    }
    if (!testHasAssertion(contents)) {
      console.log(`❌ ${requirement.area}: ${testFile} has no assertions`);
      ok = false;
    }
  }

  if (ok) {
    console.log(`✅ ${requirement.area.padEnd(26)} ${requirement.tests.join(", ")}`);
  } else {
    console.log(`   ↳ ${requirement.note}`);
    failures += 1;
  }
}

console.log("--------------------------------------------------------");
if (failures > 0) {
  console.error(`❌ ${failures} safety-critical area(s) lack a real test.`);
  console.error("   Add or fix the test before merging.\n");
  process.exit(1);
}

console.log("✅ All safety-critical modules have importing tests with assertions.\n");
