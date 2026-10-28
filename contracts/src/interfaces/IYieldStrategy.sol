// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title IYieldStrategy
 * @notice Minimal adapter used by PrincipalVault to move idle assets into an
 * external yield venue (for example, a verified Morpho market adapter).
 */
interface IYieldStrategy {
    function asset() external view returns (address);

    function totalAssets() external view returns (uint256);

    function deposit(uint256 amount) external;

    function withdraw(uint256 amount) external returns (uint256 withdrawn);
}
