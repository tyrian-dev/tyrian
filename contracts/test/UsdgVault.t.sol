// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "../src/vaults/UsdgVault.sol";
import "../src/vaults/PrincipalVault.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockYieldStrategy.sol";

contract UsdgVaultTest is Test {
    UsdgVault public vault;
    MockERC20 public usdg;

    address public owner = address(0xA11CE);
    address public treasury = address(0xCAFE);
    address public user = address(0x1111);

    function setUp() public {
        vm.startPrank(owner);
        usdg = new MockERC20("USDG Mock", "USDG", 18);
        vault = new UsdgVault(address(usdg), treasury, address(this), owner);
        vm.stopPrank();

        usdg.mint(address(this), 10_000 ether);
        usdg.approve(address(vault), type(uint256).max);
    }

    function _deposit(uint256 amount) internal {
        vault.depositFor(user, amount);
    }

    function test_HarvestMovesOnlyYield() public {
        _deposit(1000 ether);

        // Simulate strategy yield / external donation.
        usdg.mint(address(vault), 10 ether);

        uint256 harvested = vault.harvest();
        assertEq(harvested, 10 ether, "yield harvested");
        assertEq(usdg.balanceOf(treasury), 10 ether, "treasury receives yield");
        assertEq(vault.totalPrincipal(), 1000 ether, "principal unchanged");
        assertEq(vault.totalAssets(), 1000 ether, "assets after harvest");
        assertEq(vault.sharesOf(user), 1000 ether, "user shares unchanged");
    }

    function test_DonationIsNotCapturedByRedeem() public {
        _deposit(1000 ether);
        usdg.mint(address(vault), 10 ether);

        assertEq(vault.previewRedeem(1000 ether), 1000 ether, "user cannot capture donation");
        uint256 amount = vault.redeemFor(user, 1000 ether);
        assertEq(amount, 1000 ether, "principal only");
        assertEq(vault.totalAssets(), 10 ether, "donation remains for harvest");
    }

    function test_LossIsSharedProRata() public {
        _deposit(1000 ether);

        // Simulate a strategy loss / negative rebase.
        usdg.burn(address(vault), 100 ether);

        assertEq(vault.totalAssets(), 900 ether, "assets reduced");
        assertEq(vault.previewRedeem(1000 ether), 900 ether, "loss pro-rata");
        uint256 amount = vault.redeemFor(user, 1000 ether);
        assertEq(amount, 900 ether, "user bears loss");
        assertEq(vault.totalPrincipal(), 0, "principal cleared");
        assertEq(vault.totalShares(), 0, "shares cleared");
    }

    function test_PauseBlocksDepositButNotRedeem() public {
        _deposit(1000 ether);

        vm.prank(owner);
        vault.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.depositFor(user, 1 ether);

        uint256 amount = vault.redeemFor(user, 1000 ether);
        assertEq(amount, 1000 ether, "redeem during pause");
    }

    function test_OnlyOperatorCanMoveShares() public {
        vm.prank(user);
        vm.expectRevert(PrincipalVault.NotOperator.selector);
        vault.depositFor(user, 1 ether);

        vm.prank(user);
        vm.expectRevert(PrincipalVault.NotOperator.selector);
        vault.redeemFor(user, 1 ether);
    }

    function test_HarvestWithZeroYieldDoesNotRevert() public {
        _deposit(1000 ether);
        uint256 harvested = vault.harvest();
        assertEq(harvested, 0, "no yield");
    }

    function test_DepositBlockedDuringUnrealisedLoss() public {
        _deposit(1000 ether);
        usdg.burn(address(vault), 100 ether);

        vm.expectRevert(PrincipalVault.VaultInLoss.selector);
        vault.depositFor(user, 100 ether);
    }

    function test_LossRecoveryIsNotHarvestedAsYield() public {
        _deposit(1000 ether);
        usdg.burn(address(vault), 100 ether);

        // Recovery restores principal; it must not be sent to treasury.
        usdg.mint(address(vault), 100 ether);
        assertEq(vault.harvest(), 0, "recovery is not yield");
        assertEq(vault.totalPrincipal(), 1000 ether, "principal restored");
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        new UsdgVault(address(0), treasury, address(this), owner);

        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        new UsdgVault(address(usdg), address(0), address(this), owner);

        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        new UsdgVault(address(usdg), treasury, address(0), owner);

        // `Ownable` rejects a zero owner before the vault's own guard.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new UsdgVault(address(usdg), treasury, address(this), address(0));
    }

    function test_StrategyAssetsView() public {
        assertEq(vault.strategyAssets(), 0, "idle vault has no strategy assets");

        _deposit(1000 ether);
        MockYieldStrategy strategy = new MockYieldStrategy(address(usdg), address(vault));

        vm.startPrank(owner);
        vault.setStrategy(address(strategy));
        vault.allocateToStrategy(400 ether);
        vm.stopPrank();

        assertEq(vault.strategyAssets(), 400 ether, "strategy balance reported");
        assertEq(vault.totalAssets(), 1000 ether, "idle plus strategy");
    }

    function test_SetTreasuryAndOperator() public {
        address newTreasury = address(0xF00D);
        address newOperator = address(0xBEEF);

        vm.startPrank(owner);

        vm.expectEmit(true, true, false, false, address(vault));
        emit PrincipalVault.TreasuryUpdated(treasury, newTreasury);
        vault.setTreasury(newTreasury);
        assertEq(vault.treasury(), newTreasury);

        vm.expectEmit(true, true, false, false, address(vault));
        emit PrincipalVault.OperatorUpdated(address(this), newOperator);
        vault.setOperator(newOperator);
        assertEq(vault.operator(), newOperator);

        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        vault.setTreasury(address(0));

        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        vault.setOperator(address(0));

        vm.stopPrank();
    }

    function test_SetStrategyRejectsWrongAsset() public {
        MockERC20 other = new MockERC20("Other", "OTR", 18);
        MockYieldStrategy wrong = new MockYieldStrategy(address(other), address(vault));

        vm.prank(owner);
        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        vault.setStrategy(address(wrong));
    }

    function test_SetStrategyRejectsNonEmptyOldStrategy() public {
        _deposit(1000 ether);
        MockYieldStrategy strategy = new MockYieldStrategy(address(usdg), address(vault));
        MockYieldStrategy replacement = new MockYieldStrategy(address(usdg), address(vault));

        vm.startPrank(owner);
        vault.setStrategy(address(strategy));
        vault.allocateToStrategy(100 ether);

        vm.expectRevert(PrincipalVault.StrategyNotEmpty.selector);
        vault.setStrategy(address(replacement));

        // Once the old strategy is drained it can be replaced.
        vault.deallocateFromStrategy(100 ether);
        vault.setStrategy(address(replacement));
        vm.stopPrank();

        assertEq(vault.strategy(), address(replacement));
    }

    function test_AllocateRejectsUnconfiguredAndInvalidAmounts() public {
        vm.startPrank(owner);

        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        vault.allocateToStrategy(1 ether);

        MockYieldStrategy strategy = new MockYieldStrategy(address(usdg), address(vault));
        vault.setStrategy(address(strategy));

        vm.expectRevert(PrincipalVault.ZeroAmount.selector);
        vault.allocateToStrategy(0);

        vm.expectRevert(PrincipalVault.InsufficientLiquidity.selector);
        vault.allocateToStrategy(1 ether);

        vm.stopPrank();
    }

    function test_DeallocateRejectsUnconfiguredAndInvalidAmounts() public {
        vm.startPrank(owner);

        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        vault.deallocateFromStrategy(1 ether);

        MockYieldStrategy strategy = new MockYieldStrategy(address(usdg), address(vault));
        vault.setStrategy(address(strategy));

        vm.expectRevert(PrincipalVault.ZeroAmount.selector);
        vault.deallocateFromStrategy(0);

        vm.stopPrank();
    }

    function test_DeallocateReturnsFundsToVault() public {
        _deposit(1000 ether);
        MockYieldStrategy strategy = new MockYieldStrategy(address(usdg), address(vault));

        vm.startPrank(owner);
        vault.setStrategy(address(strategy));
        vault.allocateToStrategy(600 ether);
        vault.deallocateFromStrategy(250 ether);
        vm.stopPrank();

        assertEq(strategy.totalAssets(), 350 ether, "strategy balance reduced");
        assertEq(usdg.balanceOf(address(vault)), 650 ether, "idle balance restored");
        assertEq(vault.totalAssets(), 1000 ether, "total untouched");
    }

    function test_PauseOnlyGuardianAndUnpauseOnlyOwner() public {
        vm.prank(user);
        vm.expectRevert(PrincipalVault.NotGuardian.selector);
        vault.pause();

        vm.prank(owner);
        vault.pause();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vault.unpause();

        vm.prank(owner);
        vault.unpause();
    }

    function test_StrategyYieldAndWithdraw() public {
        _deposit(1000 ether);
        MockYieldStrategy strategy = new MockYieldStrategy(address(usdg), address(vault));

        vm.startPrank(owner);
        vault.setStrategy(address(strategy));
        vault.allocateToStrategy(500 ether);
        vm.stopPrank();

        assertEq(strategy.totalAssets(), 500 ether, "strategy allocation");
        assertEq(vault.totalAssets(), 1000 ether, "assets unchanged");

        usdg.mint(address(strategy), 10 ether);
        assertEq(vault.harvest(), 10 ether, "strategy yield harvested");
        assertEq(usdg.balanceOf(treasury), 10 ether, "treasury receives strategy yield");

        uint256 amount = vault.redeemFor(user, 1000 ether);
        assertEq(amount, 1000 ether, "principal redeemed across idle+strategy");
        assertEq(strategy.totalAssets(), 0, "strategy drained");
    }
}
