// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../interfaces/ISwapRouterV3.sol";

/**
 * @dev Test-only 1:1 swap router used to exercise buyback, treasury routing,
 * and portfolio trades.
 */
contract MockSwapRouterV3 is ISwapRouterV3 {
    using SafeERC20 for IERC20;

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut) {
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn;
        require(amountOut >= params.amountOutMinimum, "slippage");
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }
}
