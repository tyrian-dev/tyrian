// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/oracles/TyrTwapOracle.sol";
import "./lib/MainnetGuards.sol";
import "./lib/ManifestReader.sol";

/**
 * @notice Deploy TyrTwapOracle for Uniswap V3 TWAP pricing on pons DEX (GAP-012 / Brief §4).
 *
 * Required environment:
 * - DEPLOYER_PRIVATE_KEY
 * - TYR_ADDRESS
 * - QUOTE_TOKEN (e.g. WETH or USDG)
 * - UNISWAP_POOL (Pons Uniswap V3 pair for TYR/QUOTE_TOKEN)
 *
 * Optional:
 * - QUOTE_FEED (Chainlink feed for QUOTE_TOKEN/USD; address(0) if 1:1 USD peg)
 * - PROTOCOL_OWNER (defaults to deployer on local/testnet; required Timelock/Safe on mainnet)
 */
contract DeployTyrTwapOracleScript is Script {
    function run() external returns (address oracleAddress) {
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address tyrToken = vm.envOr("TYRN_ADDRESS", vm.envOr("TYR_ADDRESS", address(0)));
        address quoteToken = vm.envAddress("QUOTE_TOKEN");
        address pool = vm.envAddress("UNISWAP_POOL");
        address quoteFeed = vm.envOr("QUOTE_FEED", address(0));
        address owner = vm.envOr("PROTOCOL_OWNER", deployer);

        if (!MainnetGuards.isSupportedChain(block.chainid)) revert MainnetGuards.UnsupportedChain(block.chainid);
        if (tyrToken == address(0) || quoteToken == address(0) || pool == address(0)) {
            revert MainnetGuards.ZeroAddress();
        }

        if (block.chainid == MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID) {
            if (privateKey == MainnetGuards.ANVIL_KEY) revert MainnetGuards.DefaultDeployerKeyOnMainnet();
            if (owner.code.length == 0) revert MainnetGuards.OwnerMustBeContract();
            if (pool.code.length == 0) revert MainnetGuards.RouterMustBeContract();
            if (tyrToken.code.length == 0 || quoteToken.code.length == 0) revert MainnetGuards.TokenMustBeContract();

            // Verify manifest matches
            string memory json = vm.readFile(ManifestReader.path(vm, "mainnet"));
            address manifestTyr = ManifestReader.readAddress(vm, json, ".tokens.TYRN.address");
            MainnetGuards.requireManifestMatch(tyrToken, manifestTyr, "tokens.TYRN.address");
        }

        vm.startBroadcast(privateKey);

        TyrTwapOracle oracle = new TyrTwapOracle(
            tyrToken,
            quoteToken,
            pool,
            quoteFeed,
            owner
        );

        vm.stopBroadcast();

        oracleAddress = address(oracle);
        console2.log("TyrTwapOracle deployed at:", oracleAddress);
    }
}
