// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../interfaces/IUniswapV3Pool.sol";

/**
 * @dev Mock Uniswap V3 Pool for unit and fuzz tests.
 */
contract MockUniswapV3Pool is IUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public fee = 3000;

    uint160 public mockSqrtPriceX96 = 79228162514264337593543950336; // 1:1 price
    int24 public mockTick = 0;
    uint16 public mockCardinality = 10;
    uint16 public mockCardinalityNext = 10;

    bool public shouldFailObserve;
    int56 public mockCumulativeStart;
    int56 public mockCumulativeEnd;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setSlot0(
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 cardinality
    ) external {
        mockSqrtPriceX96 = sqrtPriceX96;
        mockTick = tick;
        mockCardinality = cardinality;
    }

    function setObserveData(int56 cumulativeStart, int56 cumulativeEnd) external {
        mockCumulativeStart = cumulativeStart;
        mockCumulativeEnd = cumulativeEnd;
        shouldFailObserve = false;
    }

    function setShouldFailObserve(bool fail) external {
        shouldFailObserve = fail;
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (
            mockSqrtPriceX96,
            mockTick,
            0,
            mockCardinality,
            mockCardinalityNext,
            0,
            true
        );
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (shouldFailObserve) {
            revert("OLD");
        }

        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);

        if (secondsAgos.length >= 2) {
            tickCumulatives[0] = mockCumulativeStart;
            tickCumulatives[1] = mockCumulativeEnd;
        }
    }
}
