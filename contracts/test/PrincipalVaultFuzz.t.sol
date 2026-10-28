// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../src/vaults/PrincipalVault.sol";
import "../src/vaults/UsdgVault.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockYieldStrategy.sol";

/**
 * @dev Fuzz coverage for the principal-protected vault accounting.
 *
 * The vault keeps `totalShares == totalPrincipal` because a share always
 * represents one unit of principal. Loss only reduces `totalAssets`, and the
 * redeemable basis is `min(totalAssets, totalPrincipal)`.
 */
contract PrincipalVaultFuzzTest is Test {
    UsdgVault public vault;
    MockERC20 public usdg;

    address public owner = address(0xA11CE);
    address public treasury = address(0xCAFE);
    address public operator = address(0x0BEEF);
    address public user1 = address(0x1111);
    address public user2 = address(0x2222);

    function setUp() public {
        vm.warp(1_700_000_000);

        usdg = new MockERC20("USDG Mock", "USDG", 18);
        vault = new UsdgVault(address(usdg), treasury, operator, owner);

        usdg.mint(operator, 1e30);
        vm.prank(operator);
        usdg.approve(address(vault), type(uint256).max);
    }

    function testFuzz_DepositAndRedeemSingleUser(uint96 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, 1e27);

        uint256 shares = _deposit(user1, amount);

        assertEq(shares, amount, "share is one unit of principal");
        assertEq(vault.sharesOf(user1), amount);
        assertEq(vault.totalShares(), amount);
        assertEq(vault.totalPrincipal(), amount);
        assertEq(vault.totalAssets(), amount);
        assertEq(vault.previewRedeem(shares), amount);

        assertEq(_redeem(user1, shares), amount);
        assertEq(vault.sharesOf(user1), 0);
        assertEq(vault.totalShares(), 0);
        assertEq(vault.totalPrincipal(), 0);
        assertEq(vault.totalAssets(), 0);
    }

    function testFuzz_TwoDepositorsRoundtrip(uint96 rawFirst, uint96 rawSecond) public {
        uint256 first = bound(rawFirst, 1, 1e24);
        uint256 second = bound(rawSecond, 1, 1e24);

        _deposit(user1, first);
        uint256 secondShares = _deposit(user2, second);

        assertEq(secondShares, second);
        assertEq(vault.totalShares(), first + second);
        assertEq(vault.totalPrincipal(), first + second);
        assertEq(vault.totalAssets(), first + second);

        assertEq(_redeem(user2, secondShares), second);
        assertEq(_redeem(user1, vault.sharesOf(user1)), first);

        assertEq(vault.totalShares(), 0);
        assertEq(vault.totalPrincipal(), 0);
        assertEq(vault.totalAssets(), 0);
    }

    /**
     * @dev A loss reduces the redeemable basis pro-rata. Redeeming during the
     * loss burns principal one-for-one with shares, while assets leave at the
     * loss-adjusted price. Recovery then restores the claim to principal.
     */
    function testFuzz_PartialRedeemDuringLossIsProRata(uint96 rawDeposit, uint96 rawLoss, uint96 rawShares) public {
        uint256 depositAmount = bound(rawDeposit, 1e6, 1e24);
        uint256 loss = bound(rawLoss, 1, depositAmount / 2);
        uint256 shares = bound(rawShares, 2, depositAmount - 1);

        _deposit(user1, depositAmount);
        usdg.burn(address(vault), loss);

        uint256 assetsBefore = vault.totalAssets();
        uint256 expectedAmount = (shares * assetsBefore) / vault.totalShares();
        assertGt(expectedAmount, 0, "loss bound keeps a non-zero claim");

        uint256 amount = _redeem(user1, shares);

        assertEq(amount, expectedAmount, "loss shared pro-rata");
        assertEq(vault.totalShares(), depositAmount - shares);
        assertEq(vault.totalPrincipal(), depositAmount - shares);
        assertEq(vault.totalAssets(), assetsBefore - amount);
        assertEq(vault.previewRedeem(vault.totalShares()), vault.totalAssets(), "assets are the binding basis");

        uint256 gap = vault.totalPrincipal() - vault.totalAssets();
        usdg.mint(address(vault), gap);

        assertEq(vault.totalAssets(), vault.totalPrincipal(), "recovery restores principal");
        assertEq(vault.previewRedeem(vault.totalShares()), vault.totalPrincipal());
    }

    function testFuzz_HarvestNeverMovesPrincipal(uint96 rawDeposit, uint96 rawDonation) public {
        uint256 depositAmount = bound(rawDeposit, 1, 1e27);
        uint256 donation = bound(rawDonation, 0, 1e27);

        _deposit(user1, depositAmount);
        if (donation > 0) usdg.mint(address(vault), donation);

        uint256 treasuryBefore = usdg.balanceOf(treasury);
        uint256 harvested = vault.harvest();

        assertEq(harvested, donation, "only the amount above principal is yield");
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, donation);
        assertEq(vault.totalAssets(), depositAmount, "principal remains in the vault");
        assertEq(vault.totalPrincipal(), depositAmount);
        assertEq(vault.previewRedeem(vault.totalShares()), depositAmount);
    }

    function testFuzz_DepositBlockedWhileUnderwater(uint96 rawDeposit, uint96 rawLoss) public {
        uint256 depositAmount = bound(rawDeposit, 1, 1e24);
        uint256 loss = bound(rawLoss, 1, depositAmount);

        _deposit(user1, depositAmount);
        usdg.burn(address(vault), loss);

        assertLt(vault.totalAssets(), vault.totalPrincipal(), "vault is underwater");

        vm.prank(operator);
        vm.expectRevert(PrincipalVault.VaultInLoss.selector);
        vault.depositFor(user2, 1e18);
    }

    function testFuzz_StrategyAllocationPreservesAssets(uint96 rawDeposit, uint96 rawAllocation, uint96 rawYield)
        public
    {
        uint256 depositAmount = bound(rawDeposit, 1e6, 1e24);
        uint256 allocation = bound(rawAllocation, 1, depositAmount);
        uint256 yieldAmount = bound(rawYield, 0, 1e24);

        _deposit(user1, depositAmount);

        MockYieldStrategy strategy = new MockYieldStrategy(address(usdg), address(vault));

        vm.startPrank(owner);
        vault.setStrategy(address(strategy));
        vault.allocateToStrategy(allocation);
        vm.stopPrank();

        assertEq(vault.totalAssets(), depositAmount, "allocation is not yield");
        assertEq(usdg.balanceOf(address(vault)), depositAmount - allocation);

        if (yieldAmount > 0) usdg.mint(address(strategy), yieldAmount);
        assertEq(vault.harvest(), yieldAmount, "strategy yield is harvested");

        assertEq(_redeem(user1, depositAmount), depositAmount, "principal returns across idle and strategy");
        assertEq(strategy.totalAssets(), 0, "strategy drained by the redemption");
        assertEq(vault.totalAssets(), 0);
    }

    function testFuzz_SharesAlwaysEqualPrincipal(uint96 rawFirst, uint96 rawSecond, uint96 rawLoss) public {
        uint256 first = bound(rawFirst, 1, 1e24);
        uint256 second = bound(rawSecond, 1, 1e24);

        _deposit(user1, first);
        _deposit(user2, second);

        uint256 totalAssets = vault.totalAssets();
        uint256 loss = bound(rawLoss, 0, totalAssets);
        if (loss > 0) usdg.burn(address(vault), loss);

        uint256 shares = vault.totalShares();
        uint256 principal = vault.totalPrincipal();

        assertEq(shares, principal, "share supply always tracks principal");
        assertEq(vault.totalAssets(), totalAssets - loss);

        uint256 expectedBasis = vault.totalAssets() < principal ? vault.totalAssets() : principal;
        assertEq(vault.previewRedeem(shares), expectedBasis);
    }

    function _deposit(address user, uint256 amount) internal returns (uint256 shares) {
        vm.prank(operator);
        shares = vault.depositFor(user, amount);
    }

    function _redeem(address user, uint256 shares) internal returns (uint256 amount) {
        vm.prank(operator);
        amount = vault.redeemFor(user, shares);
    }
}
