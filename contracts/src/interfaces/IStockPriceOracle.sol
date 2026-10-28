// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @notice USD price source for one stock token.
 *
 * Prices are normalized to 18 decimals. A stale or invalid feed must revert so
 * callers fail closed instead of valuing the portfolio with an old price.
 */
interface IStockPriceOracle {
    function stockToken() external view returns (address);

    function getPrice() external view returns (uint256 price18);

    function getUsdValue(address token, uint256 amount) external view returns (uint256 valueUsd18);
}
