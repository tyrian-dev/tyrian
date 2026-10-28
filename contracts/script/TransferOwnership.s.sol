// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "./lib/MainnetGuards.sol";
import "./lib/ManifestReader.sol";
import "./lib/Ownership.sol";

/**
 * @notice Start the two-step ownership handover to the timelock.
 *
 * Every contract that extends `Ownable2Step` and can affect user funds or
 * protocol parameters must be in this list. That explicitly includes the
 * treasury contracts and the oracles, which were missing before: leaving
 * `PortfolioVault` with the deployer EOA means the EOA can call `sell()` and
 * `setTreasury()`.
 *
 * The timelock must call `acceptOwnership()` on every contract afterwards; use
 * `AcceptOwnership.s.sol` to schedule/execute that batch.
 *
 * Required env:
 * - DEPLOYER_PRIVATE_KEY
 * - TIMELOCK (timelock controller contract)
 * - STAKE_MANAGER
 * - USDG_VAULT
 * - FEE_SPLITTER
 * - BUYBACK_BURNER
 * - TREASURY_ROUTER
 * - PORTFOLIO_VAULT
 *
 * Optional:
 * - STOCK_VAULT_COUNT, then STOCK_VAULT_1..N
 * - STOCK_ORACLE_COUNT, then STOCK_ORACLE_1..N
 * - TYR_TWAP_ORACLE
 *
 * On mainnet every env address must match config/networks/mainnet.json. The
 * script is idempotent: a target already owned by the timelock is skipped, and
 * a target owned by anybody else reverts instead of being ignored.
 */
contract TransferOwnershipScript is Script {
    function run() external {
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address timelock = vm.envAddress("TIMELOCK");

        address[] memory targets = collectTargets();
        _guard(block.chainid, privateKey, deployer, timelock);

        vm.startBroadcast(privateKey);
        Ownership.transferAll(targets, timelock, deployer);
        vm.stopBroadcast();

        console.log("Chain ID:", block.chainid);
        console.log("Deployer:", deployer);
        console.log("Timelock:", timelock);
        console.log("Contracts handed over:", targets.length);
        console.log("");
        console.log("Next step: AcceptOwnership.s.sol must run from the timelock.");
        console.log("Until acceptOwnership() executes, the deployer is still the owner.");
    }

    /**
     * @notice Build the handover list from env. Required addresses are read with
     * `envAddress` so a missing treasury contract fails loudly instead of being
     * silently skipped.
     */
    function collectTargets() public view returns (address[] memory targets) {
        uint256 stockVaultCount = vm.envOr("STOCK_VAULT_COUNT", uint256(0));
        uint256 stockOracleCount = vm.envOr("STOCK_ORACLE_COUNT", uint256(0));
        address tyrOracle = vm.envOr("TYR_TWAP_ORACLE", address(0));

        uint256 index;
        targets = new address[](6 + stockVaultCount + stockOracleCount + (tyrOracle == address(0) ? 0 : 1));

        targets[index++] = vm.envAddress("STAKE_MANAGER");
        targets[index++] = vm.envAddress("USDG_VAULT");
        targets[index++] = vm.envAddress("FEE_SPLITTER");
        targets[index++] = vm.envAddress("BUYBACK_BURNER");
        targets[index++] = vm.envAddress("TREASURY_ROUTER");
        targets[index++] = vm.envAddress("PORTFOLIO_VAULT");

        for (uint256 i = 1; i <= stockVaultCount; ++i) {
            targets[index++] = vm.envAddress(string.concat("STOCK_VAULT_", vm.toString(i)));
        }
        for (uint256 i = 1; i <= stockOracleCount; ++i) {
            targets[index++] = vm.envAddress(string.concat("STOCK_ORACLE_", vm.toString(i)));
        }
        if (tyrOracle != address(0)) targets[index++] = tyrOracle;
    }

    function _guard(uint256 chainId, uint256 privateKey, address deployer, address timelock) internal view {
        MainnetGuards.OwnershipTargets memory config = MainnetGuards.OwnershipTargets({
            chainId: chainId,
            privateKey: privateKey,
            deployer: deployer,
            timelock: timelock,
            router: vm.envAddress("TREASURY_ROUTER"),
            portfolio: vm.envAddress("PORTFOLIO_VAULT"),
            tyrOracle: vm.envOr("TYR_TWAP_ORACLE", address(0)),
            manifestTimelock: address(0),
            manifestRouter: address(0),
            manifestPortfolio: address(0),
            manifestTyrOracle: address(0)
        });

        if (chainId == MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID) {
            string memory json = vm.readFile(ManifestReader.path(vm, "mainnet"));
            config.manifestTimelock = ManifestReader.readAddress(vm, json, ".external.timelock");
            config.manifestRouter = ManifestReader.readAddress(vm, json, ".contracts.TreasuryRouter");
            config.manifestPortfolio = ManifestReader.readAddress(vm, json, ".contracts.PortfolioVault");
            config.manifestTyrOracle = ManifestReader.readAddress(vm, json, ".contracts.TyrTwapOracle");
        }

        MainnetGuards.validateOwnershipTargets(config);
    }
}
