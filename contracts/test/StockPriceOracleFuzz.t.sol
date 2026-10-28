// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../src/oracles/StockPriceOracle.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockAggregatorV3.sol";

/**
 * @dev Fuzz coverage for feed normalization and fail-closed stale/invalid
 * handling. Every oracle instance wraps exactly one stock token.
 */
contract StockPriceOracleFuzzTest is Test {
    MockERC20 public tsla;

    address public owner = address(0xA11CE);
    address public stranger = address(0xB0B);

    function setUp() public {
        vm.warp(1_700_000_000);
        tsla = new MockERC20("Tesla Tokenized Stock", "TSLA", 18);
    }

    function testFuzz_NormalizesFeedDecimals(uint8 rawDecimals, uint96 rawAnswer) public {
        uint8 feedDecimals = uint8(bound(rawDecimals, 0, 36));

        uint256 answer;
        if (feedDecimals <= 18) {
            answer = bound(rawAnswer, 1, 1e30);
        } else {
            answer = bound(rawAnswer, 10 ** (feedDecimals - 18), 1e30);
        }

        MockAggregatorV3 feed = new MockAggregatorV3(feedDecimals, int256(answer));
        StockPriceOracle oracle = new StockPriceOracle(address(tsla), address(feed), owner);

        uint256 expected = feedDecimals <= 18 ? answer * 10 ** (18 - feedDecimals) : answer / 10 ** (feedDecimals - 18);

        assertEq(oracle.getPrice(), expected);
    }

    function testFuzz_RejectsNonPositiveAnswer(int96 rawAnswer) public {
        vm.assume(rawAnswer <= 0);

        MockAggregatorV3 feed = new MockAggregatorV3(8, rawAnswer);
        StockPriceOracle oracle = new StockPriceOracle(address(tsla), address(feed), owner);

        vm.expectRevert(StockPriceOracle.InvalidPrice.selector);
        oracle.getPrice();
    }

    function testFuzz_StaleAfterMaxPeriod(uint32 rawElapsed) public {
        uint256 elapsed = bound(rawElapsed, 0, 14 days);

        MockAggregatorV3 feed = new MockAggregatorV3(8, 250e8);
        StockPriceOracle oracle = new StockPriceOracle(address(tsla), address(feed), owner);

        vm.warp(block.timestamp + elapsed);

        if (elapsed > 96 hours) {
            vm.expectRevert(StockPriceOracle.StalePrice.selector);
            oracle.getPrice();
        } else {
            assertEq(oracle.getPrice(), 250e18);
        }
    }

    function testFuzz_CustomStalePeriod(uint32 rawPeriod, uint32 rawElapsed) public {
        uint256 period = bound(rawPeriod, 1, 7 days);
        uint256 elapsed = bound(rawElapsed, 0, 8 days);

        MockAggregatorV3 feed = new MockAggregatorV3(8, 123e8);
        StockPriceOracle oracle = new StockPriceOracle(address(tsla), address(feed), owner);

        vm.prank(owner);
        oracle.setMaxStalePeriod(period);

        vm.warp(block.timestamp + elapsed);

        if (elapsed > period) {
            vm.expectRevert(StockPriceOracle.StalePrice.selector);
            oracle.getPrice();
        } else {
            assertEq(oracle.getPrice(), 123e18);
        }
    }

    function testFuzz_CheckPriceMirrorsGetPrice(uint32 rawElapsed, uint96 rawAnswer) public {
        uint256 answer = bound(rawAnswer, 1, 1e30);
        uint256 elapsed = bound(rawElapsed, 0, 14 days);

        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(answer));
        StockPriceOracle oracle = new StockPriceOracle(address(tsla), address(feed), owner);

        vm.warp(block.timestamp + elapsed);

        bool ok = oracle.checkPrice();

        try oracle.getPrice() returns (uint256 price) {
            assertTrue(ok, "valid feed must report ok");
            assertEq(price, answer * 1e10);
        } catch {
            assertFalse(ok, "invalid feed must report not ok");
        }
    }

    function testFuzz_GetUsdValue(uint96 rawAmount) public {
        uint256 amount = bound(rawAmount, 0, 1e30);

        MockAggregatorV3 feed = new MockAggregatorV3(8, 250e8);
        StockPriceOracle oracle = new StockPriceOracle(address(tsla), address(feed), owner);

        assertEq(oracle.getUsdValue(address(tsla), amount), amount * 250);
    }

    function testFuzz_GetUsdValueRejectsOtherToken(address rawToken) public {
        vm.assume(rawToken != address(tsla));

        MockAggregatorV3 feed = new MockAggregatorV3(8, 250e8);
        StockPriceOracle oracle = new StockPriceOracle(address(tsla), address(feed), owner);

        vm.expectRevert(StockPriceOracle.StockNotAllowed.selector);
        oracle.getUsdValue(rawToken, 1e18);
    }

    function testFuzz_RejectsFeedAboveThirtySixDecimals(uint8 rawDecimals) public {
        uint8 feedDecimals = uint8(bound(rawDecimals, 37, 255));

        MockAggregatorV3 feed = new MockAggregatorV3(feedDecimals, 1);
        StockPriceOracle oracle = new StockPriceOracle(address(tsla), address(feed), owner);

        vm.expectRevert(StockPriceOracle.InvalidPrice.selector);
        oracle.getPrice();
    }
}
