// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

import "../src/TreasuryRouter.sol";
import "../src/PortfolioVault.sol";
import "./lib/MainnetGuards.sol";

/**
 * @notice Deploy the treasury contracts: TreasuryRouter + PortfolioVault.
 *
 * Required environment:
 * - DEPLOYER_PRIVATE_KEY
 * - GUARDIAN
 * - TREASURY_BUDGET
 * - TREASURY_RESERVE
 * - USDG_ADDRESS
 * - WETH_ADDRESS
 *
 * Optional:
 * - PROTOCOL_OWNER (expected final owner, for the mainnet guard only; contracts
 *   start owned by the deployer and are transferred later)
 *
 * Budget and reserve must be different addresses because the router splits into
 * two distinct recipients. On mainnet all recipient addresses must be contracts
 * and must match config/networks/mainnet.json (`external.budget`,
 * `external.reserve`, `external.guardian`, `tokens.USDG`, `tokens.WETH`).
 *
 * This script only deploys and wires the split recipients/guardian. Router,
 * split parameters, portfolio targets, and treasury total are configured by
 * `ConfigureTreasury.s.sol` after the deployment is verified, following the same
 * pattern as DeployProtocol + ConfigureProtocol.
 */
contract DeployTreasuryScript is Script {
    function run() external {
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(privateKey);

        address guardian = vm.envAddress("GUARDIAN");
        address budget = vm.envAddress("TREASURY_BUDGET");
        address reserve = vm.envAddress("TREASURY_RESERVE");
        address usdg = vm.envAddress("USDG_ADDRESS");
        address weth = vm.envAddress("WETH_ADDRESS");
        address owner = vm.envOr("PROTOCOL_OWNER", deployer);

        MainnetGuards.TreasuryConfig memory config = MainnetGuards.TreasuryConfig({
            chainId: block.chainid,
            deployer: deployer,
            owner: owner,
            guardian: guardian,
            budget: budget,
            reserve: reserve,
            usdg: usdg,
            weth: weth,
            privateKey: privateKey,
            manifestBudget: address(0),
            manifestReserve: address(0),
            manifestGuardian: address(0),
            manifestUsdg: address(0),
            manifestWeth: address(0)
        });

        if (block.chainid == MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID) {
            string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../config/networks/mainnet.json"));
            config.manifestBudget = _manifestAddress(json, ".external.budget");
            config.manifestReserve = _manifestAddress(json, ".external.reserve");
            config.manifestGuardian = _manifestAddress(json, ".external.guardian");
            config.manifestUsdg = _manifestAddress(json, ".tokens.USDG.address");
            config.manifestWeth = _manifestAddress(json, ".tokens.WETH.address");
        }

        MainnetGuards.validateTreasury(config);

        vm.startBroadcast(privateKey);

        TreasuryRouter router = new TreasuryRouter(usdg, weth, deployer);
        PortfolioVault portfolio = new PortfolioVault(usdg, deployer);

        router.setRecipients(budget, reserve, address(portfolio));
        router.setGuardian(guardian);
        portfolio.setGuardian(guardian);

        vm.stopBroadcast();

        console.log("Chain ID:", block.chainid);
        console.log("TreasuryRouter:", address(router));
        console.log("PortfolioVault:", address(portfolio));
        console.log("Budget recipient:", budget);
        console.log("Reserve recipient:", reserve);
        console.log("Final owner (set by TransferOwnership):", owner);
    }

    function _manifestAddress(string memory json, string memory key) private view returns (address) {
        if (!vm.keyExistsJson(json, key)) return address(0);

        // A `null` entry exists as a key but cannot be parsed as an address.
        // Treat any parse failure as "not configured yet" so the guard reports
        // the manifest field instead of an opaque cheatcode error.
        (bool ok, bytes memory data) =
            address(vm).staticcall(abi.encodeWithSignature("parseJsonAddress(string,string)", json, key));
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }
}
