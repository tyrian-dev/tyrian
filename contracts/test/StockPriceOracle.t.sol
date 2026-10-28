// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../src/oracles/StockPriceOracle.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockAggregatorV3.sol";

contract RevertingFeed {
    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert("feed down");
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

contract ConfigurableFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    uint80 public answeredInRound;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = updatedAt_;
        roundId = 10;
        answeredInRound = 10;
    }

    function setRound(uint80 roundId_, uint80 answeredInRound_) external {
        roundId = roundId_;
        answeredInRound = answeredInRound_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

contract StockPriceOracleTest is Test {
    StockPriceOracle public oracle;
    MockERC20 public tsla;
    MockAggregatorV3 public feed;

    address public owner = address(0xA11CE);
    address public stranger = address(0xB0B);

    function setUp() public {
        vm.warp(1_700_000_000);
        tsla = new MockERC20("Tesla Tokenized Stock", "TSLA", 18);
        feed = new MockAggregatorV3(8, 250_00000000);
        oracle = new StockPriceOracle(address(tsla), address(feed), owner);
    }

    function test_NormalizesEightDecimalsToEighteen() public view {
        assertEq(oracle.getPrice(), 250e18);
    }

    function test_NormalizesEighteenDecimalFeed() public {
        MockAggregatorV3 feed18 = new MockAggregatorV3(18, 123_456e18);
        StockPriceOracle oracle18 = new StockPriceOracle(address(tsla), address(feed18), owner);

        assertEq(oracle18.getPrice(), 123_456e18);
    }

    function test_RejectsZeroPrice() public {
        feed.setPrice(0);

        vm.expectRevert(StockPriceOracle.InvalidPrice.selector);
        oracle.getPrice();
    }

    function test_RejectsNegativePrice() public {
        feed.setPrice(-1);

        vm.expectRevert(StockPriceOracle.InvalidPrice.selector);
        oracle.getPrice();
    }

    function test_RejectsZeroUpdatedAt() public {
        feed.setUpdatedAt(0);

        vm.expectRevert(StockPriceOracle.InvalidPrice.selector);
        oracle.getPrice();
    }

    function test_RejectsFutureUpdatedAt() public {
        feed.setUpdatedAt(block.timestamp + 1);

        vm.expectRevert(StockPriceOracle.InvalidPrice.selector);
        oracle.getPrice();
    }

    function test_RejectsIncompleteRound() public {
        ConfigurableFeed incomplete = new ConfigurableFeed(8, 100e8, block.timestamp);
        incomplete.setRound(10, 9);

        StockPriceOracle incompleteOracle = new StockPriceOracle(address(tsla), address(incomplete), owner);

        vm.expectRevert(StockPriceOracle.InvalidPrice.selector);
        incompleteOracle.getPrice();
    }

    function test_RejectsStalePrice() public {
        vm.warp(block.timestamp + 96 hours + 1);

        vm.expectRevert(StockPriceOracle.StalePrice.selector);
        oracle.getPrice();
    }

    function test_AcceptsPriceExactlyAtStaleBoundary() public {
        vm.warp(block.timestamp + 96 hours);

        assertEq(oracle.getPrice(), 250e18);
    }

    function test_GetUsdValueForEighteenDecimalToken() public view {
        assertEq(oracle.getUsdValue(address(tsla), 2e18), 500e18);
    }

    function test_GetUsdValueForSixDecimalToken() public {
        MockERC20 six = new MockERC20("Six Decimals", "SIX", 6);
        StockPriceOracle sixOracle = new StockPriceOracle(address(six), address(feed), owner);

        assertEq(sixOracle.getUsdValue(address(six), 2e6), 500e18);
    }

    function test_RejectsUnknownToken() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);

        vm.expectRevert(StockPriceOracle.StockNotAllowed.selector);
        oracle.getUsdValue(address(other), 1e18);
    }

    function test_OnlyOwnerCanSetFeed() public {
        MockAggregatorV3 newFeed = new MockAggregatorV3(8, 300_00000000);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oracle.setFeed(address(newFeed));

        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit StockPriceOracle.FeedUpdated(address(feed), address(newFeed));
        oracle.setFeed(address(newFeed));

        assertEq(oracle.feed(), address(newFeed));
        assertEq(oracle.getPrice(), 300e18);
    }

    function test_RejectsZeroFeed() public {
        vm.prank(owner);
        vm.expectRevert(StockPriceOracle.InvalidAddress.selector);
        oracle.setFeed(address(0));
    }

    function test_MaxStalePeriodBounds() public {
        vm.startPrank(owner);

        vm.expectRevert(StockPriceOracle.InvalidStalePeriod.selector);
        oracle.setMaxStalePeriod(0);

        vm.expectRevert(StockPriceOracle.InvalidStalePeriod.selector);
        oracle.setMaxStalePeriod(7 days + 1);

        oracle.setMaxStalePeriod(7 days);
        assertEq(oracle.maxStalePeriod(), 7 days);

        vm.stopPrank();
    }

    function test_OnlyOwnerCanSetMaxStalePeriod() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oracle.setMaxStalePeriod(48 hours);
    }

    function test_CheckPriceIsTrueWhenFresh() public {
        assertTrue(oracle.checkPrice());
    }

    function test_CheckPriceEmitsStaleAndDoesNotRevert() public {
        vm.warp(block.timestamp + 96 hours + 1);

        vm.expectEmit(true, false, false, true);
        emit StockPriceOracle.PriceStale(address(tsla), 1_700_000_000);

        assertFalse(oracle.checkPrice());
    }

    function test_CheckPriceEmitsInvalidAndDoesNotRevert() public {
        feed.setPrice(-5);

        vm.expectEmit(true, false, false, true);
        emit StockPriceOracle.PriceInvalid(address(tsla), -5, 1_700_000_000);

        assertFalse(oracle.checkPrice());
    }

    function test_CheckPriceHandlesRevertingFeed() public {
        RevertingFeed broken = new RevertingFeed();
        StockPriceOracle brokenOracle = new StockPriceOracle(address(tsla), address(broken), owner);

        vm.expectEmit(true, false, false, true);
        emit StockPriceOracle.PriceInvalid(address(tsla), 0, 0);

        assertFalse(brokenOracle.checkPrice());
    }
}
