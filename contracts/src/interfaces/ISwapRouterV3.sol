// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @notice Uniswap V3 exact-input single-hop surface used by Tyrian.
 */
interface ISwapRouterV3 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}
