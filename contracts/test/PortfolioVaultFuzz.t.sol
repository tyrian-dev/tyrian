// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../src/PortfolioVault.sol";
import "../src/oracles/StockPriceOracle.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockAggregatorV3.sol";
import "../src/mocks/MockSwapRouterV3.sol";

/**
 * @dev Fuzz coverage for the treasury portfolio: 20% cap, DCA window/amount,
 * oracle-derived slippage floor, and exact target-weight validation.
 */
contract PortfolioVaultFuzzTest is Test {
    PortfolioVault public portfolio;
    MockERC20 public usdg;
    MockSwapRouterV3 public swapRouter;

    MockERC20 public stock18;
    MockERC20 public stock6;
    StockPriceOracle public oracle18;
    StockPriceOracle public oracle6;
    MockAggregatorV3 public feed18;
    MockAggregatorV3 public feed6;

    address public owner = address(0xA11CE);
    address public keeper = address(0x1111);

    function setUp() public {
        vm.warp(1_700_000_000);

        usdg = new MockERC20("Robinhood USDG", "USDG", 18);
        swapRouter = new MockSwapRouterV3();

        stock18 = new MockERC20("Stock 18", "S18", 18);
        stock6 = new MockERC20("Stock 6", "S6", 6);
        feed18 = new MockAggregatorV3(8, 1e8);
        feed6 = new MockAggregatorV3(8, 1e8);
        oracle18 = new StockPriceOracle(address(stock18), address(feed18), owner);
        oracle6 = new StockPriceOracle(address(stock6), address(feed6), owner);

        address[] memory tokens = new address[](2);
        tokens[0] = address(stock18);
        tokens[1] = address(stock6);

        address[] memory oracles = new address[](2);
        oracles[0] = address(oracle18);
        oracles[1] = address(oracle6);

        uint16[] memory weights = new uint16[](2);
        weights[0] = 5000;
        weights[1] = 5000;

        portfolio = new PortfolioVault(address(usdg), owner);

        vm.startPrank(owner);
        portfolio.setTargets(tokens, weights, oracles);
        portfolio.setRouter(address(swapRouter), 3000);
        portfolio.setTreasuryTotalUsd(1_000_000e18);
        portfolio.setDcaAmountUsd(1_000_000e18);
        portfolio.setKeeper(keeper);
        vm.stopPrank();

        usdg.mint(address(portfolio), 1e30);
        usdg.mint(address(swapRouter), 1e30);
        stock18.mint(address(swapRouter), 1e30);
        stock6.mint(address(swapRouter), 1e30);
    }

    function testFuzz_BuyRespectsPortfolioCap(uint96 rawTreasuryTotal, uint96 rawAmount) public {
        uint256 treasuryTotal = bound(rawTreasuryTotal, 1, 1e30);
        uint256 amount = bound(rawAmount, 1, 1e27);

        vm.startPrank(owner);
        portfolio.setTreasuryTotalUsd(treasuryTotal);
        portfolio.setDcaAmountUsd(type(uint128).max);
        vm.stopPrank();

        uint256 cap = portfolio.portfolioCapUsd();

        if (amount > cap) {
            vm.prank(keeper);
            vm.expectRevert(PortfolioVault.PortfolioCapExceeded.selector);
            portfolio.buy(address(stock18), amount, amount, block.timestamp);
            return;
        }

        vm.prank(keeper);
        uint256 tokenOut = portfolio.buy(address(stock18), amount, amount, block.timestamp);

        assertEq(tokenOut, amount);
        assertLe(portfolio.portfolioValueUsd(), cap, "basket never exceeds 20% of treasury");
    }

    function testFuzz_BuyRespectsDcaAmount(uint96 rawDcaAmount, uint96 rawAmount) public {
        uint256 dcaAmount = bound(rawDcaAmount, 1, 1e27);
        uint256 amount = bound(rawAmount, 1, 1e27);

        vm.startPrank(owner);
        portfolio.setTreasuryTotalUsd(1e30);
        portfolio.setDcaAmountUsd(dcaAmount);
        vm.stopPrank();

        if (amount > dcaAmount) {
            vm.prank(keeper);
            vm.expectRevert(PortfolioVault.DcaAmountExceeded.selector);
            portfolio.buy(address(stock18), amount, amount, block.timestamp);
            return;
        }

        vm.prank(keeper);
        uint256 tokenOut = portfolio.buy(address(stock18), amount, amount, block.timestamp);
        assertEq(tokenOut, amount);
    }

    function testFuzz_BuyRejectsSlippageBelowOracleFloor(uint96 rawAmount, uint16 rawSlippage) public {
        uint256 amount = bound(rawAmount, 1, 1e24);
        uint256 slippageBps = bound(rawSlippage, 0, 1000);

        vm.startPrank(owner);
        portfolio.setTreasuryTotalUsd(1e30);
        portfolio.setDcaAmountUsd(type(uint128).max);
        portfolio.setMaxSlippageBps(slippageBps);
        vm.stopPrank();

        // Both stock tokens and USDG use a $1 price in this fixture.
        uint256 expectedOut = amount;
        uint256 floor = expectedOut - (expectedOut * slippageBps) / 10_000;

        if (floor > 0) {
            vm.prank(keeper);
            vm.expectRevert(PortfolioVault.SlippageTooHigh.selector);
            portfolio.buy(address(stock18), amount, floor - 1, block.timestamp);
        }

        vm.prank(keeper);
        uint256 tokenOut = portfolio.buy(address(stock18), amount, floor, block.timestamp);
        assertEq(tokenOut, amount);
    }

    function testFuzz_BuyRespectsDcaWindow(uint32 rawElapsed) public {
        uint256 amount = 100e18;

        vm.startPrank(owner);
        portfolio.setTreasuryTotalUsd(10_000e18);
        portfolio.setDcaAmountUsd(1000e18);
        vm.stopPrank();

        _buy(address(stock18), amount, amount);

        uint256 elapsed = bound(rawElapsed, 0, 14 days);
        vm.warp(block.timestamp + elapsed);
        _refreshFeeds();

        if (elapsed < 7 days) {
            vm.prank(keeper);
            vm.expectRevert(PortfolioVault.DcaNotDue.selector);
            portfolio.buy(address(stock18), amount, amount, block.timestamp);
            return;
        }

        vm.prank(keeper);
        uint256 tokenOut = portfolio.buy(address(stock18), amount, amount, block.timestamp);
        assertEq(tokenOut, amount);
    }

    function testFuzz_SetTargetsRequiresExactWeightSum(uint16 rawWeight) public {
        uint16 first = uint16(bound(rawWeight, 1, 9999));
        uint16 second = uint16(10_000 - first);

        address[] memory tokens = new address[](2);
        tokens[0] = address(stock18);
        tokens[1] = address(stock6);

        address[] memory oracles = new address[](2);
        oracles[0] = address(oracle18);
        oracles[1] = address(oracle6);

        uint16[] memory weights = new uint16[](2);
        weights[0] = first;
        weights[1] = second;

        vm.prank(owner);
        portfolio.setTargets(tokens, weights, oracles);
        assertEq(portfolio.targetCount(), 2);

        weights[1] = second == 1 ? 2 : second - 1;

        vm.prank(owner);
        vm.expectRevert(PortfolioVault.InvalidTargets.selector);
        portfolio.setTargets(tokens, weights, oracles);
    }

    function _buy(address token, uint256 amount, uint256 minTokenOut) internal returns (uint256 tokenOut) {
        vm.prank(keeper);
        tokenOut = portfolio.buy(token, amount, minTokenOut, block.timestamp);
    }

    function _refreshFeeds() internal {
        feed18.setUpdatedAt(block.timestamp);
        feed6.setUpdatedAt(block.timestamp);
    }
}
