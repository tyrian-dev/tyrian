// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title IStakeVault
 * @notice Custom principal-protected vault interface used by StakeManager.
 *
 * This is intentionally not ERC-4626 compliant. Shares represent a claim on
 * principal, not a yield-bearing token. Yield above principal is harvested to
 * the protocol treasury.
 */
interface IStakeVault {
    function asset() external view returns (address);

    function totalPrincipal() external view returns (uint256);

    function totalAssets() external view returns (uint256);

    function totalShares() external view returns (uint256);

    function sharesOf(address user) external view returns (uint256);

    function previewDeposit(uint256 amount) external view returns (uint256 shares);

    function previewRedeem(uint256 shares) external view returns (uint256 amount);

    function depositFor(address user, uint256 amount) external returns (uint256 shares);

    function redeemFor(address user, uint256 shares) external returns (uint256 amount);

    function harvest() external returns (uint256 yieldAmount);

    function setStrategy(address strategy) external;

    function pause() external;

    function unpause() external;
}
