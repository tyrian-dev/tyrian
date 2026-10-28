// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "../src/StakeManager.sol";
import "../src/vaults/UsdgVault.sol";
import "../src/mocks/MockERC20.sol";

contract StakeManagerTest is Test {
    StakeManager public stakeManager;
    UsdgVault public vault;
    MockERC20 public usdg;

    address public owner = address(0xA11CE);
    address public treasury = address(0xCAFE);
    address public user1 = address(0x1111);
    address public user2 = address(0x2222);

    uint256 public constant CAP = 10_000 ether;

    function setUp() public {
        vm.startPrank(owner);

        usdg = new MockERC20("USDG Mock", "USDG", 18);
        stakeManager = new StakeManager(owner);
        vault = new UsdgVault(address(usdg), treasury, address(stakeManager), owner);

        stakeManager.setAssetConfig(address(usdg), true, StakeManager.AssetKind.BASE, address(vault), address(0), CAP);

        usdg.mint(user1, 1000 ether);
        usdg.mint(user2, 1000 ether);

        vm.stopPrank();
    }

    function _stake(address user, uint256 amount) internal {
        vm.startPrank(user);
        usdg.approve(address(stakeManager), amount);
        stakeManager.stake(address(usdg), amount);
        vm.stopPrank();
    }

    function test_StakeEpochRolloverAndVaultCustody() public {
        _stake(user1, 1000 ether);

        (uint256 active, uint256 pending,,) = stakeManager.getEffectivePosition(user1, address(usdg));
        assertEq(active, 0, "stake must not be active in same epoch");
        assertEq(pending, 1000 ether, "pending shares mismatch");
        assertEq(vault.sharesOf(user1), 1000 ether, "vault shares mismatch");
        assertEq(usdg.balanceOf(address(vault)), 1000 ether, "vault must hold assets");
        assertEq(usdg.balanceOf(address(stakeManager)), 0, "manager must not hold assets");

        vm.warp(block.timestamp + 1 days + 1);

        (active, pending,,) = stakeManager.getEffectivePosition(user1, address(usdg));
        assertEq(active, 1000 ether, "stake must be active next epoch");
        assertEq(pending, 0, "pending must be cleared");
    }

    function test_UnstakeCooldownAndWithdraw() public {
        _stake(user1, 1000 ether);
        vm.warp(block.timestamp + 1 days + 1);

        vm.startPrank(user1);
        uint256 requestId = stakeManager.requestUnstake(address(usdg), 500 ether);
        assertEq(requestId, 1, "request id");

        (uint256 active,, uint256 cooldown, uint256 unlockAt) = stakeManager.getEffectivePosition(user1, address(usdg));
        assertEq(active, 500 ether, "active shares must decrease immediately");
        assertEq(cooldown, 500 ether, "cooldown shares");
        assertGt(unlockAt, block.timestamp, "unlock must be in future");

        vm.expectRevert(StakeManager.CooldownNotElapsed.selector);
        stakeManager.withdraw(address(usdg), requestId);

        vm.warp(block.timestamp + 6 days);
        vm.expectRevert(StakeManager.CooldownNotElapsed.selector);
        stakeManager.withdraw(address(usdg), requestId);

        vm.warp(block.timestamp + 2 days);
        uint256 beforeBalance = usdg.balanceOf(user1);
        uint256 amount = stakeManager.withdraw(address(usdg), requestId);
        assertEq(amount, 500 ether, "withdraw amount");
        assertEq(usdg.balanceOf(user1) - beforeBalance, 500 ether, "user receives assets");
        vm.stopPrank();

        assertEq(vault.sharesOf(user1), 500 ether, "shares burned");
        assertEq(usdg.balanceOf(address(vault)), 500 ether, "remaining custody");

        vm.prank(user1);
        vm.expectRevert(StakeManager.RequestAlreadyClaimed.selector);
        stakeManager.withdraw(address(usdg), requestId);
    }

    function test_WithdrawWorksWhilePaused() public {
        _stake(user1, 1000 ether);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(owner);
        stakeManager.pause();

        vm.startPrank(user1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        stakeManager.stake(address(usdg), 1 ether);

        uint256 requestId = stakeManager.requestUnstake(address(usdg), 500 ether);
        vm.warp(block.timestamp + 8 days);

        uint256 beforeBalance = usdg.balanceOf(user1);
        stakeManager.withdraw(address(usdg), requestId);
        assertEq(usdg.balanceOf(user1) - beforeBalance, 500 ether, "withdraw during pause");
        vm.stopPrank();
    }

    function test_IndependentUnstakeRequests() public {
        _stake(user1, 1000 ether);
        vm.warp(block.timestamp + 1 days + 1);

        vm.startPrank(user1);
        uint256 first = stakeManager.requestUnstake(address(usdg), 300 ether);
        vm.warp(block.timestamp + 1 days);
        uint256 second = stakeManager.requestUnstake(address(usdg), 200 ether);

        assertTrue(first != second, "request ids must differ");
        StakeManager.UnstakeRequest memory req1 = stakeManager.getUnstakeRequest(user1, address(usdg), first);
        StakeManager.UnstakeRequest memory req2 = stakeManager.getUnstakeRequest(user1, address(usdg), second);
        assertTrue(req1.unlockAt != req2.unlockAt, "each request has its own unlock");

        vm.warp(req1.unlockAt);
        stakeManager.withdraw(address(usdg), first);

        vm.expectRevert(StakeManager.CooldownNotElapsed.selector);
        stakeManager.withdraw(address(usdg), second);

        vm.warp(req2.unlockAt);
        stakeManager.withdraw(address(usdg), second);
        vm.stopPrank();
    }

    function test_DisableAssetDoesNotBlockWithdraw() public {
        _stake(user1, 1000 ether);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(user1);
        uint256 requestId = stakeManager.requestUnstake(address(usdg), 1000 ether);

        vm.prank(owner);
        stakeManager.setAssetConfig(address(usdg), false, StakeManager.AssetKind.BASE, address(vault), address(0), CAP);

        vm.warp(block.timestamp + 8 days);
        vm.prank(user1);
        stakeManager.withdraw(address(usdg), requestId);
        assertEq(usdg.balanceOf(user1), 1000 ether, "disabled asset still withdrawable");
    }

    function test_CannotReplaceVaultWithOutstandingShares() public {
        _stake(user1, 1000 ether);
        vm.warp(block.timestamp + 1 days + 1);

        UsdgVault secondVault = new UsdgVault(address(usdg), treasury, address(stakeManager), owner);

        vm.prank(owner);
        vm.expectRevert(StakeManager.VaultAlreadyInUse.selector);
        stakeManager.setAssetConfig(
            address(usdg), false, StakeManager.AssetKind.BASE, address(secondVault), address(0), CAP
        );
    }

    function test_CannotReplaceVaultHoldingStrayAssets() public {
        _stake(user1, 1000 ether);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(user1);
        uint256 requestId = stakeManager.requestUnstake(address(usdg), 1000 ether);

        vm.warp(block.timestamp + 8 days);
        vm.prank(user1);
        stakeManager.withdraw(address(usdg), requestId);

        // Every share is redeemed, yet the vault still holds assets (dust or a
        // direct donation). Replacing it would strand those assets.
        assertEq(vault.totalShares(), 0, "all shares redeemed");
        usdg.mint(address(vault), 1 ether);
        assertEq(vault.totalAssets(), 1 ether, "stray assets remain");

        UsdgVault secondVault = new UsdgVault(address(usdg), treasury, address(stakeManager), owner);

        vm.prank(owner);
        vm.expectRevert(StakeManager.VaultNotEmpty.selector);
        stakeManager.setAssetConfig(
            address(usdg), false, StakeManager.AssetKind.BASE, address(secondVault), address(0), CAP
        );
    }

    function test_CanReplaceVaultOnceOldVaultIsEmpty() public {
        _stake(user1, 1000 ether);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(user1);
        uint256 requestId = stakeManager.requestUnstake(address(usdg), 1000 ether);

        vm.warp(block.timestamp + 8 days);
        vm.prank(user1);
        stakeManager.withdraw(address(usdg), requestId);

        assertEq(vault.totalShares(), 0);
        assertEq(vault.totalAssets(), 0);

        UsdgVault secondVault = new UsdgVault(address(usdg), treasury, address(stakeManager), owner);

        vm.prank(owner);
        stakeManager.setAssetConfig(
            address(usdg), true, StakeManager.AssetKind.BASE, address(secondVault), address(0), CAP
        );

        (,, address configuredVault,,,) = stakeManager.assetConfig(address(usdg));
        assertEq(configuredVault, address(secondVault));
    }

    function test_AssetListTracksConfiguredAssets() public view {
        assertEq(stakeManager.assetListLength(), 1);
    }

    function test_DisableAssetWithZeroVaultKeepsExistingVault() public {
        vm.prank(owner);
        stakeManager.setAssetConfig(address(usdg), false, StakeManager.AssetKind.BASE, address(0), address(0), CAP);

        (bool enabled,, address configuredVault,,,) = stakeManager.assetConfig(address(usdg));
        assertFalse(enabled, "asset disabled");
        assertEq(configuredVault, address(vault), "existing vault kept for withdraw");
    }

    function test_PauseBlocksStakeButNotWithdraw() public {
        _stake(user1, 1000 ether);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(user1);
        uint256 requestId = stakeManager.requestUnstake(address(usdg), 1000 ether);

        vm.prank(owner);
        stakeManager.pause();

        vm.startPrank(user2);
        usdg.approve(address(stakeManager), 1 ether);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        stakeManager.stake(address(usdg), 1 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 8 days);
        vm.prank(user1);
        stakeManager.withdraw(address(usdg), requestId);
        assertEq(usdg.balanceOf(user1), 1000 ether, "withdraw stays available while paused");

        vm.prank(owner);
        stakeManager.unpause();

        _stake(user2, 1 ether);
        assertEq(vault.sharesOf(user2), 1 ether, "stake works again after unpause");
    }

    function test_WithdrawMaturedRejectsZeroMaxRequests() public {
        vm.expectRevert(StakeManager.ZeroAmount.selector);
        stakeManager.withdrawMatured(address(usdg), 0);
    }

    function test_WithdrawMaturedSkipsUnmaturedRequests() public {
        _stake(user1, 1000 ether);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(user1);
        stakeManager.requestUnstake(address(usdg), 1000 ether);

        // Cooldown is 7 days; nothing is claimable yet.
        vm.prank(user1);
        assertEq(stakeManager.withdrawMatured(address(usdg), 10), 0, "nothing matured");
    }

    function test_WithdrawMaturedProcessesBatch() public {
        _stake(user1, 1000 ether);
        vm.warp(block.timestamp + 1 days + 1);

        vm.startPrank(user1);
        stakeManager.requestUnstake(address(usdg), 300 ether);
        stakeManager.requestUnstake(address(usdg), 200 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 8 days);

        // Batch limit of one claims only the first matured request.
        vm.prank(user1);
        assertEq(stakeManager.withdrawMatured(address(usdg), 1), 300 ether, "first request only");
        vm.prank(user1);
        assertEq(stakeManager.withdrawMatured(address(usdg), 10), 200 ether, "second request claimed");

        // Already-claimed requests are skipped, not reverted.
        vm.prank(user1);
        assertEq(stakeManager.withdrawMatured(address(usdg), 10), 0, "nothing left");
        assertEq(usdg.balanceOf(user1), 500 ether, "requested principal returned");

        (uint256 active,,,) = stakeManager.getEffectivePosition(user1, address(usdg));
        assertEq(active, 500 ether, "unrequested stake stays active");
    }

    function test_DepositCapEnforced() public {
        vm.prank(owner);
        stakeManager.setAssetConfig(
            address(usdg), true, StakeManager.AssetKind.BASE, address(vault), address(0), 500 ether
        );

        vm.startPrank(user1);
        usdg.approve(address(stakeManager), 501 ether);
        vm.expectRevert(StakeManager.DepositCapExceeded.selector);
        stakeManager.stake(address(usdg), 501 ether);
        vm.stopPrank();
    }
}
