// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../src/PortfolioVault.sol";
import "../src/mocks/MockAggregatorV3.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockSwapRouterV3.sol";
import "../src/oracles/StockPriceOracle.sol";

/// @dev USDG is expected to have 6 decimals on some deployments and 18 on
/// others. These tests pin the 18-decimal internal conversion in both
/// directions so a token-decimals change cannot silently misprice the basket.
contract PortfolioVaultDecimalsTest is Test {
    address internal owner = address(0xA11CE);

    MockSwapRouterV3 internal swapRouter;

    function setUp() public {
        vm.warp(1_700_000_000);
        swapRouter = new MockSwapRouterV3();
    }

    /// @dev 6-decimal USDG: `_toUsd18` scales up and `_fromUsd18` scales down.
    function test_SixDecimalUsdgBuyAndSell() public {
        MockERC20 usdg = new MockERC20("USDG6", "USDG6", 6);
        PortfolioVault portfolio = new PortfolioVault(address(usdg), owner);

        MockERC20 token = new MockERC20("Stock", "STK", 18);
        MockAggregatorV3 feed = new MockAggregatorV3(8, 1e20); // $1e12 per token
        StockPriceOracle oracle = new StockPriceOracle(address(token), address(feed), owner);

        _configure(portfolio, address(token), address(oracle));
        vm.startPrank(owner);
        portfolio.setTreasuryTotalUsd(1_000_000e18);
        portfolio.setDcaAmountUsd(1_000e18);
        vm.stopPrank();

        usdg.mint(address(portfolio), 100e6);
        token.mint(address(swapRouter), 1_000_000e18);

        uint256 bought = _buyAsOwner(portfolio, address(token), 100e6, 1e8);
        assertEq(bought, 1e8, "raw 1:1 output");

        usdg.mint(address(swapRouter), 100e6);
        uint256 sold = _sellAsOwner(portfolio, address(token), bought, 1e8);
        assertEq(sold, 1e8, "6-decimal proceeds");
        assertEq(usdg.balanceOf(owner), 1e8, "treasury receives 6-decimal USDG");
    }

    /// @dev 24-decimal USDG: `_toUsd18` scales down and `_fromUsd18` scales up.
    function test_TwentyFourDecimalUsdgBuyAndSell() public {
        MockERC20 usdg = new MockERC20("USDG24", "USDG24", 24);
        PortfolioVault portfolio = new PortfolioVault(address(usdg), owner);

        MockERC20 token = new MockERC20("Stock", "STK", 18);
        MockAggregatorV3 feed = new MockAggregatorV3(8, 1e8); // $1 per token
        StockPriceOracle oracle = new StockPriceOracle(address(token), address(feed), owner);

        _configure(portfolio, address(token), address(oracle));
        vm.startPrank(owner);
        portfolio.setTreasuryTotalUsd(1_000_000e18);
        portfolio.setDcaAmountUsd(1_000e18);
        vm.stopPrank();

        usdg.mint(address(portfolio), 100e24);
        token.mint(address(swapRouter), 1e30);

        uint256 bought = _buyAsOwner(portfolio, address(token), 100e24, 1e20);
        assertEq(bought, 100e24, "raw 1:1 output");

        // Price drops to $1e-6 so the 1:1 mock router can cover the ask.
        feed.setPrice(100);

        usdg.mint(address(swapRouter), 1e26);
        uint256 sold = _sellAsOwner(portfolio, address(token), bought, 1e26);
        assertEq(sold, 1e26, "24-decimal proceeds");
    }

    function _buyAsOwner(PortfolioVault portfolio, address token, uint256 amount, uint256 minOut)
        internal
        returns (uint256)
    {
        vm.prank(owner);
        return portfolio.buy(token, amount, minOut, block.timestamp);
    }

    function _sellAsOwner(PortfolioVault portfolio, address token, uint256 amount, uint256 minOut)
        internal
        returns (uint256)
    {
        vm.prank(owner);
        return portfolio.sell(token, amount, minOut, block.timestamp);
    }

    function _configure(PortfolioVault portfolio, address token, address oracle) internal {
        address[] memory tokens = new address[](1);
        uint16[] memory weights = new uint16[](1);
        address[] memory oracles = new address[](1);
        tokens[0] = token;
        weights[0] = 10_000;
        oracles[0] = oracle;

        vm.startPrank(owner);
        portfolio.setTargets(tokens, weights, oracles);
        portfolio.setRouter(address(swapRouter), 3000);
        vm.stopPrank();
    }
}
