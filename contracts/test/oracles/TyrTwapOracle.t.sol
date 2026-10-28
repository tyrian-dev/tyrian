// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../../src/oracles/TyrTwapOracle.sol";
import "../../src/mocks/MockERC20.sol";
import "../../src/mocks/MockAggregatorV3.sol";
import "../../src/mocks/MockUniswapV3Pool.sol";

contract TyrTwapOracleTest is Test {
    address internal owner = address(0xAA11);
    address internal user = address(0xBB22);

    MockERC20 internal tyr;
    MockERC20 internal weth;
    MockUniswapV3Pool internal pool;
    MockAggregatorV3 internal wethFeed;

    TyrTwapOracle internal oracle;

    function setUp() public {
        tyr = new MockERC20("Tyrian", "TYR", 18);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);

        // Sort addresses for token0 / token1
        address token0 = address(tyr) < address(weth) ? address(tyr) : address(weth);
        address token1 = address(tyr) < address(weth) ? address(weth) : address(tyr);

        pool = new MockUniswapV3Pool(token0, token1);

        // Chainlink WETH/USD feed ($2500 with 8 decimals)
        wethFeed = new MockAggregatorV3(8, 2500e8);

        // Default pool state: 10 cardinality, tick 0 (1:1 price)
        pool.setSlot0(79228162514264337593543950336, 0, 10);
        // Over 1800s, tick remains 0 -> cumulative delta = 0
        pool.setObserveData(0, 0);

        oracle = new TyrTwapOracle(
            address(tyr),
            address(weth),
            address(pool),
            address(wethFeed),
            owner
        );
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(TyrTwapOracle.InvalidAddress.selector);
        new TyrTwapOracle(address(0), address(weth), address(pool), address(0), owner);

        vm.expectRevert(TyrTwapOracle.InvalidAddress.selector);
        new TyrTwapOracle(address(tyr), address(0), address(pool), address(0), owner);

        vm.expectRevert(TyrTwapOracle.InvalidAddress.selector);
        new TyrTwapOracle(address(tyr), address(weth), address(0), address(0), owner);
    }

    function test_ConstructorRejectsTokenMismatch() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        vm.expectRevert(TyrTwapOracle.InvalidPoolTokens.selector);
        new TyrTwapOracle(address(other), address(weth), address(pool), address(0), owner);
    }

    function test_ConsultRejectsZeroAmount() public {
        vm.expectRevert(TyrTwapOracle.ZeroAmount.selector);
        oracle.consult(0);
    }

    function test_ConsultRejectsInsufficientCardinality() public {
        // Pool only has 5 observations, oracle requires 10
        pool.setSlot0(79228162514264337593543950336, 0, 5);

        vm.expectRevert(TyrTwapOracle.InsufficientCardinality.selector);
        oracle.consult(1 ether);
    }

    function test_ConsultRejectsFailedObserve() public {
        pool.setShouldFailObserve(true);

        vm.expectRevert(TyrTwapOracle.TwapObserveFailed.selector);
        oracle.consult(1 ether);
    }

    function test_ConsultCalculatesOneToOneAtZeroTick() public view {
        // At tick 0, 1 TYR = 1 WETH
        uint256 out = oracle.consult(1 ether);
        assertEq(out, 1 ether);
    }

    function test_ConsultCalculatesPositiveTick() public {
        // Tick 6932 corresponds to ratio ~2.0
        // If tyr is token0, 1 TYR gets ~2 quote tokens
        // Over 1800 seconds, delta = 6932 * 1800 = 12477600
        int56 delta = int56(6932) * int56(uint56(1800));
        pool.setObserveData(0, delta);

        uint256 out = oracle.consult(1 ether);
        if (oracle.tyrIsToken0()) {
            assertApproxEqRel(out, 2 ether, 0.01e18); // within 1%
        } else {
            assertApproxEqRel(out, 0.5 ether, 0.01e18);
        }
    }

    function test_GetPriceWithQuoteFeed() public view {
        // 1 TYR = 1 WETH, WETH is $2500 -> 1 TYR = $2500 (18 decimals)
        uint256 price = oracle.getPrice();
        assertEq(price, 2500e18);
    }

    function test_GetPriceWithoutQuoteFeedAssumesPegged() public {
        vm.prank(owner);
        oracle.setQuoteFeed(address(0));

        // Without feed, quoteToken treated as 1:1 USD
        uint256 price = oracle.getPrice();
        assertEq(price, 1e18);
    }

    function test_GetUsdValue() public view {
        // 10 TYR * $2500 = $25000
        uint256 val = oracle.getUsdValue(10 ether);
        assertEq(val, 25000e18);
    }

    function test_CheckPriceReturnsTrueWhenHealthy() public {
        bool ok = oracle.checkPrice();
        assertTrue(ok);
    }

    function test_CheckPriceReturnsFalseOnLowCardinality() public {
        pool.setSlot0(79228162514264337593543950336, 0, 3);
        bool ok = oracle.checkPrice();
        assertFalse(ok);
    }

    function test_CheckPriceReturnsFalseOnObserveFailure() public {
        pool.setShouldFailObserve(true);
        bool ok = oracle.checkPrice();
        assertFalse(ok);
    }

    function test_CheckPriceReturnsFalseOnStaleQuoteFeed() public {
        // Make feed stale (> 96 hours)
        vm.warp(block.timestamp + 100 hours);
        bool ok = oracle.checkPrice();
        assertFalse(ok);
    }

    function test_AdminSetters() public {
        vm.startPrank(owner);

        oracle.setTwapPeriod(3600);
        assertEq(oracle.twapPeriod(), 3600);

        oracle.setMinCardinality(15);
        assertEq(oracle.minCardinality(), 15);

        oracle.setMaxFeedStalePeriod(48 hours);
        assertEq(oracle.maxFeedStalePeriod(), 48 hours);

        vm.stopPrank();

        // Non-owner cannot change
        vm.startPrank(user);
        vm.expectRevert();
        oracle.setTwapPeriod(1800);
        vm.stopPrank();
    }
}
