// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

import "../src/oracles/TyrTwapOracle.sol";
import "./lib/MainnetGuards.sol";
import "./lib/TreasuryManifest.sol";

/**
 * @notice Deploy TyrTwapOracle.
 *
 * Required environment:
 * - DEPLOYER_PRIVATE_KEY
 * - TYR_TOKEN (or read from manifest)
 * - QUOTE_TOKEN (e.g. WETH, or read from manifest)
 * - UNISWAP_POOL (Uniswap V3 pool address)
 *
 * Optional:
 * - QUOTE_FEED (Chainlink feed for quoteToken/USD)
 * - PROTOCOL_OWNER (defaults to deployer, transferred to Timelock later)
 */
contract DeployTyrOracleScript is Script {
    function run() external {
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(privateKey);

        address tyr = vm.envOr("TYR_TOKEN", address(0));
        address quoteToken = vm.envOr("QUOTE_TOKEN", address(0));
        address pool = vm.envOr("UNISWAP_POOL", address(0));
        address quoteFeed = vm.envOr("QUOTE_FEED", address(0));
        address owner = vm.envOr("PROTOCOL_OWNER", deployer);

        if (!MainnetGuards.isSupportedChain(block.chainid)) {
            revert MainnetGuards.UnsupportedChain(block.chainid);
        }

        if (tyr == address(0) || quoteToken == address(0) || pool == address(0)) {
            string memory network = block.chainid == MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID ? "mainnet" : "testnet";
            string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../config/networks/", network, ".json"));

            if (tyr == address(0)) {
                tyr = TreasuryManifest.readAddress(vm, json, ".tokens.TYR.address");
            }
            if (quoteToken == address(0)) {
                quoteToken = TreasuryManifest.readAddress(vm, json, ".tokens.WETH.address");
            }
            if (pool == address(0)) {
                pool = TreasuryManifest.readAddress(vm, json, ".external.uniswapPool");
            }
        }

        require(tyr != address(0), "TYR token address missing");
        require(quoteToken != address(0), "Quote token address missing");
        require(pool != address(0), "Uniswap pool address missing");

        vm.startBroadcast(privateKey);

        TyrTwapOracle oracle = new TyrTwapOracle(
            tyr,
            quoteToken,
            pool,
            quoteFeed,
            deployer
        );

        vm.stopBroadcast();

        console.log("TyrTwapOracle deployed at:", address(oracle));
        console.log("TYR Token:", tyr);
        console.log("Quote Token:", quoteToken);
        console.log("Uniswap Pool:", pool);
        console.log("Quote Feed:", quoteFeed);
        console.log("Initial Owner:", deployer);
        console.log("Expected Final Owner:", owner);
    }
}
