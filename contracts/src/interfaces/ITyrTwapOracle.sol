// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title ITyrTwapOracle
 * @notice Interface for on-chain 30-minute Uniswap V3 TWAP oracle for TYR.
 */
interface ITyrTwapOracle {
    function tyrToken() external view returns (address);
    function quoteToken() external view returns (address);
    function pool() external view returns (address);
    function quoteFeed() external view returns (address);
    function twapPeriod() external view returns (uint32);
    function minCardinality() external view returns (uint16);

    /**
     * @notice Returns quote token output amount for amountIn of TYR based on TWAP.
     */
    function consult(uint256 amountIn) external view returns (uint256 amountOutQuote);

    /**
     * @notice Returns latest price of 1 TYR normalized to 18 decimals USD.
     */
    function getPrice() external view returns (uint256 price18);

    /**
     * @notice Returns USD value (18 decimals) of amount TYR tokens.
     */
    function getUsdValue(uint256 amount) external view returns (uint256 valueUsd18);

    /**
     * @notice Monitoring / keeper hook. Returns false instead of reverting on error.
     */
    function checkPrice() external returns (bool ok);
}
