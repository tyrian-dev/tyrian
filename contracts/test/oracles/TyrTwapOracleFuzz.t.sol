// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../../src/oracles/TyrTwapOracle.sol";
import "../../src/mocks/MockERC20.sol";
import "../../src/mocks/MockAggregatorV3.sol";
import "../../src/mocks/MockUniswapV3Pool.sol";

contract TyrTwapOracleFuzzTest is Test {
    MockERC20 internal tyr;
    MockERC20 internal weth;
    MockUniswapV3Pool internal pool;
    MockAggregatorV3 internal wethFeed;
    TyrTwapOracle internal oracle;

    function setUp() public {
        tyr = new MockERC20("Tyrian", "TYR", 18);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);

        address token0 = address(tyr) < address(weth) ? address(tyr) : address(weth);
        address token1 = address(tyr) < address(weth) ? address(weth) : address(tyr);

        pool = new MockUniswapV3Pool(token0, token1);
        wethFeed = new MockAggregatorV3(8, 2500e8);

        pool.setSlot0(79228162514264337593543950336, 0, 10);
        pool.setObserveData(0, 0);

        oracle = new TyrTwapOracle(
            address(tyr),
            address(weth),
            address(pool),
            address(wethFeed),
            address(this)
        );
    }

    function testFuzz_ConsultAmountScaling(uint96 amountIn) public view {
        vm.assume(amountIn > 0);
        uint256 out = oracle.consult(amountIn);
        // At tick 0, output equals input exactly
        assertEq(out, amountIn);
    }

    function testFuzz_TickVariation(int16 tick) public {
        // Limit tick to realistic range [-20000, 20000]
        vm.assume(tick > -20000 && tick < 20000);

        uint32 twapSecs = 1800;
        int56 delta = int56(int32(tick)) * int56(uint56(twapSecs));
        pool.setObserveData(0, delta);

        uint256 out = oracle.consult(1 ether);
        assertGt(out, 0);

        uint256 price = oracle.getPrice();
        assertGt(price, 0);
    }

    function testFuzz_QuoteFeedPriceVariation(uint96 feedPrice) public {
        vm.assume(feedPrice > 1e6 && feedPrice < 1e12); // $0.01 to $10,000 in 8 decimals
        wethFeed.setPrice(int256(uint256(feedPrice)));

        uint256 price = oracle.getPrice();
        assertGt(price, 0);
    }
}
