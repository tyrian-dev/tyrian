// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/StakeManager.sol";
import "../src/vaults/StockVault.sol";
import "./lib/MainnetGuards.sol";
import "./lib/ManifestReader.sol";

/**
 * @notice Register one deployed StockVault with StakeManager.
 *
 * Required env:
 * - DEPLOYER_PRIVATE_KEY
 * - STAKE_MANAGER
 * - STOCK_TICKER (manifest key, e.g. AAPL)
 * - STOCK_TOKEN
 * - STOCK_VAULT
 * - STOCK_FEED
 * - STOCK_CAP
 *
 * Optional:
 * - TREASURY_SAFE (checked against `external.treasurySafe` on mainnet)
 *
 * On mainnet the token, feed, and vault must all match the same
 * `stocks.<STOCK_TICKER>` entry, and the vault's asset must be that token.
 * Without this, a mainnet run could register the AAPL vault under NVDA.
 */
contract ConfigureStockVaultScript is Script {
    function run() external {
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address stakeManagerAddr = vm.envAddress("STAKE_MANAGER");
        address token = vm.envAddress("STOCK_TOKEN");
        address vault = vm.envAddress("STOCK_VAULT");
        address feed = vm.envAddress("STOCK_FEED");
        uint256 cap = vm.envUint("STOCK_CAP");
        string memory ticker = vm.envOr("STOCK_TICKER", vm.envString("STOCK_SYMBOL"));

        MainnetGuards.StockVaultConfig memory config = MainnetGuards.StockVaultConfig({
            chainId: block.chainid,
            privateKey: privateKey,
            deployer: vm.addr(privateKey),
            token: token,
            feed: feed,
            vault: vault,
            treasury: vm.envOr("TREASURY_SAFE", address(0)),
            stakeManager: stakeManagerAddr,
            guardian: address(0),
            depositCap: cap,
            ticker: ticker,
            manifestToken: address(0),
            manifestFeed: address(0),
            manifestVault: address(0),
            manifestTreasury: address(0)
        });

        if (block.chainid == MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID) {
            string memory json = vm.readFile(ManifestReader.path(vm, "mainnet"));
            string memory base = string.concat(".stocks.", ticker);
            config.manifestToken = ManifestReader.readAddress(vm, json, string.concat(base, ".address"));
            config.manifestFeed = ManifestReader.readAddress(vm, json, string.concat(base, ".feed"));
            config.manifestVault = ManifestReader.readAddress(vm, json, string.concat(base, ".vault"));
            config.manifestTreasury = ManifestReader.readAddress(vm, json, ".external.treasurySafe");
        }

        MainnetGuards.validateStockVaultConfig(config);

        // Defense in depth: the vault must actually hold the manifest token.
        require(StockVault(vault).asset() == token, "vault asset mismatch");

        vm.startBroadcast(privateKey);
        StakeManager(stakeManagerAddr).setAssetConfig(token, true, StakeManager.AssetKind.STOCK, vault, feed, cap);
        vm.stopBroadcast();

        console.log("Registered stock asset:", ticker);
        console.log("Token:", token);
        console.log("Vault:", vault);
        console.log("Feed:", feed);
    }
}
