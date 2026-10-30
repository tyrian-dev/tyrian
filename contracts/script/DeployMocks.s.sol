// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockWETH.sol";
import "../src/mocks/MockAggregatorV3.sol";

/**
 * @notice Deploy mock test assets on local/testnet only.
 * Never run this on mainnet.
 */
contract DeployMocksScript is Script {
    uint256 private constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        require(block.chainid == 31337 || block.chainid == 46630, "DeployMocks: local/testnet only");

        uint256 privateKey = vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_KEY);
        vm.startBroadcast(privateKey);

        MockERC20 usdg = new MockERC20("Robinhood USDG", "USDG", 18);
        MockERC20 tyr = new MockERC20("Tyrian", "TYRN", 18);
        MockWETH weth = new MockWETH();

        console.log("MockUSDG:", address(usdg));
        console.log("MockTYRN:", address(tyr));
        console.log("MockWETH:", address(weth));

        _deployStocks();

        vm.stopBroadcast();
    }

    function _deployStocks() internal {
        string[8] memory symbols = ["AAPL", "NVDA", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "AMD"];
        int256[8] memory prices = [
            int256(220_00000000),
            int256(120_00000000),
            int256(430_00000000),
            int256(180_00000000),
            int256(210_00000000),
            int256(560_00000000),
            int256(250_00000000),
            int256(160_00000000)
        ];

        for (uint256 i = 0; i < symbols.length; i++) {
            MockERC20 token = new MockERC20(symbols[i], symbols[i], 18);
            MockAggregatorV3 feed = new MockAggregatorV3(8, prices[i]);
            console.log(symbols[i], address(token));
            console.log("  feed", address(feed));
        }
    }
}
