// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/vaults/StockVault.sol";
import "./lib/MainnetGuards.sol";
import "./lib/ManifestReader.sol";

/**
 * @notice Deploy one StockVault per ticker.
 *
 * Required environment:
 * - DEPLOYER_PRIVATE_KEY
 * - STAKE_MANAGER
 * - TREASURY_SAFE
 * - STOCK_TICKER (manifest key, e.g. AAPL)
 * - STOCK_TOKEN
 * - STOCK_SYMBOL
 * - STOCK_FEED
 * - STOCK_CAP (token units, not USD)
 *
 * Optional:
 * - GUARDIAN (defaults to deployer on local/testnet; required on mainnet)
 *
 * On mainnet `STOCK_TOKEN` and `STOCK_FEED` must match
 * `stocks.<STOCK_TICKER>.address` and `.feed` in config/networks/mainnet.json,
 * and `stocks.<TICKER>.vault` must still be empty. This keeps a feed for one
 * ticker from being wired to the token of another ticker, and refuses to deploy
 * a second vault for a ticker that already has one.
 */
contract DeployStockVaultScript is Script {
    function run() external {
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory symbol = vm.envString("STOCK_SYMBOL");
        string memory ticker = vm.envOr("STOCK_TICKER", symbol);

        MainnetGuards.StockVaultConfig memory config;
        config.chainId = block.chainid;
        config.privateKey = privateKey;
        config.deployer = vm.addr(privateKey);
        config.token = vm.envAddress("STOCK_TOKEN");
        config.feed = vm.envAddress("STOCK_FEED");
        config.treasury = vm.envAddress("TREASURY_SAFE");
        config.stakeManager = vm.envAddress("STAKE_MANAGER");
        config.guardian = vm.envOr("GUARDIAN", config.deployer);
        config.depositCap = vm.envUint("STOCK_CAP");
        config.ticker = ticker;

        if (block.chainid == MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID) {
            string memory json = vm.readFile(ManifestReader.path(vm, "mainnet"));
            string memory base = string.concat(".stocks.", ticker);
            config.manifestToken = ManifestReader.readAddress(vm, json, string.concat(base, ".address"));
            config.manifestFeed = ManifestReader.readAddress(vm, json, string.concat(base, ".feed"));
            config.manifestVault = ManifestReader.readAddress(vm, json, string.concat(base, ".vault"));
            config.manifestTreasury = ManifestReader.readAddress(vm, json, ".external.treasurySafe");
        }

        MainnetGuards.validateStockVaultDeploy(config);

        vm.startBroadcast(privateKey);
        StockVault vault = new StockVault(
            config.token,
            symbol,
            config.feed,
            config.depositCap,
            config.treasury,
            config.stakeManager,
            config.deployer
        );
        vault.setGuardian(config.guardian);
        vm.stopBroadcast();

        console.log("StockVault:", address(vault));
        console.log("Ticker:", ticker);
        console.log("Token:", config.token);
        console.log("Feed:", config.feed);
        console.log("Symbol:", symbol);
        console.log("Cap (token units):", config.depositCap);
    }
}
