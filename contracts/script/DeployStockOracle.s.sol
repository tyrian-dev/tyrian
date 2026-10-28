// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

import "../src/oracles/StockPriceOracle.sol";
import "./lib/MainnetGuards.sol";
import "./lib/TreasuryManifest.sol";

/**
 * @notice Deploy one StockPriceOracle per ticker.
 *
 * Required environment:
 * - DEPLOYER_PRIVATE_KEY
 * - STOCK_TICKER (manifest key, e.g. AAPL)
 * - STOCK_TOKEN
 * - STOCK_FEED
 *
 * Optional:
 * - PROTOCOL_OWNER (expected final owner, for the mainnet guard only; the
 *   oracle starts owned by the deployer and is transferred later)
 *
 * On mainnet STOCK_TOKEN and STOCK_FEED must match
 * `stocks.<STOCK_TICKER>.address` and `stocks.<STOCK_TICKER>.feed` in
 * config/networks/mainnet.json. This keeps a feed for one ticker from being
 * wired to the token of another ticker.
 */
contract DeployStockOracleScript is Script {
    function run() external {
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        string memory ticker = vm.envString("STOCK_TICKER");
        address token = vm.envAddress("STOCK_TOKEN");
        address feed = vm.envAddress("STOCK_FEED");
        address owner = vm.envOr("PROTOCOL_OWNER", deployer);

        MainnetGuards.StockOracleConfig memory config = MainnetGuards.StockOracleConfig({
            chainId: block.chainid,
            deployer: deployer,
            owner: owner,
            token: token,
            feed: feed,
            privateKey: privateKey,
            ticker: ticker,
            manifestToken: address(0),
            manifestFeed: address(0)
        });

        if (block.chainid == MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID) {
            string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../config/networks/mainnet.json"));
            config.manifestToken = TreasuryManifest.readAddress(vm, json, string.concat(".stocks.", ticker, ".address"));
            config.manifestFeed = TreasuryManifest.readAddress(vm, json, string.concat(".stocks.", ticker, ".feed"));
        }

        MainnetGuards.validateStockOracle(config);

        vm.startBroadcast(privateKey);

        StockPriceOracle oracle = new StockPriceOracle(token, feed, deployer);

        vm.stopBroadcast();

        console.log("StockPriceOracle:", address(oracle));
        console.log("Ticker:", ticker);
        console.log("Token:", token);
        console.log("Feed:", feed);
        console.log("Final owner (set by TransferOwnership):", owner);
    }
}
