// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../src/StakeManager.sol";
import "../src/vaults/UsdgVault.sol";
import "../src/mocks/MockERC20.sol";

/**
 * @dev Random action handler for StakeManager invariants.
 *
 * The handler owns no user funds. It only calls the public API as a user, and
 * catches reverts (cap, cooldown, pause) so a rejected action does not stop the
 * invariant sequence.
 */
contract StakeManagerHandler is Test {
    StakeManager public immutable manager;
    UsdgVault public immutable vault;
    MockERC20 public immutable usdg;
    address public immutable asset;

    address[] public actors;

    uint256 public successfulStakes;
    uint256 public successfulRequests;
    uint256 public successfulWithdrawals;
    uint256 public successfulHarvests;
    uint256 public simulatedLosses;
    uint256 public recoveries;

    constructor(StakeManager manager_, UsdgVault vault_, MockERC20 usdg_, address[] memory actors_) {
        manager = manager_;
        vault = vault_;
        usdg = usdg_;
        asset = address(usdg_);
        actors = actors_;
    }

    function stake(uint256 rawActor, uint96 rawAmount) external {
        address actor = _actor(rawActor);
        uint256 balance = usdg.balanceOf(actor);
        if (balance == 0) return;

        uint256 amount = bound(rawAmount, 1, balance);

        vm.startPrank(actor);
        usdg.approve(address(manager), amount);
        try manager.stake(asset, amount) {
            successfulStakes++;
        } catch {}
        vm.stopPrank();
    }

    function requestUnstake(uint256 rawActor, uint96 rawAmount) external {
        address actor = _actor(rawActor);
        (uint256 active,,,) = manager.getEffectivePosition(actor, asset);
        if (active == 0) return;

        uint256 activeValue = vault.previewRedeem(active);
        if (activeValue == 0) return;

        uint256 amount = bound(rawAmount, 1, activeValue);

        vm.prank(actor);
        try manager.requestUnstake(asset, amount) {
            successfulRequests++;
        } catch {}
    }

    function withdraw(uint256 rawActor, uint96 rawRequestId) external {
        address actor = _actor(rawActor);
        uint256 lastRequestId = manager.nextRequestId(actor, asset);
        if (lastRequestId == 0) return;

        uint256 requestId = bound(rawRequestId, 1, lastRequestId);

        vm.prank(actor);
        try manager.withdraw(asset, requestId) {
            successfulWithdrawals++;
        } catch {}
    }

    function warp(uint96 rawSeconds) external {
        vm.warp(block.timestamp + bound(rawSeconds, 0, 2 days));
    }

    function harvest() external {
        try vault.harvest() {
            successfulHarvests++;
        } catch {}
    }

    function donateYield(uint96 rawAmount) external {
        usdg.mint(address(vault), bound(rawAmount, 0, 1e24));
    }

    function simulateLoss(uint96 rawAmount) external {
        uint256 balance = usdg.balanceOf(address(vault));
        if (balance == 0) return;

        usdg.burn(address(vault), bound(rawAmount, 1, balance));
        simulatedLosses++;
    }

    function recoverLoss(uint96 rawAmount) external {
        uint256 assets = vault.totalAssets();
        uint256 principal = vault.totalPrincipal();
        if (assets >= principal) return;

        usdg.mint(address(vault), bound(rawAmount, 1, principal - assets));
        recoveries++;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }
}

contract StakeManagerInvariantTest is Test {
    StakeManager public manager;
    UsdgVault public vault;
    MockERC20 public usdg;
    StakeManagerHandler public handler;

    address public treasury = address(0xCAFE);
    address public asset;

    address[] internal actors;

    function setUp() public {
        vm.warp(1_700_000_000);

        usdg = new MockERC20("USDG Mock", "USDG", 18);
        manager = new StakeManager(address(this));
        vault = new UsdgVault(address(usdg), treasury, address(manager), address(this));

        manager.setAssetConfig(address(usdg), true, StakeManager.AssetKind.BASE, address(vault), address(0), 0);

        asset = address(usdg);

        actors.push(address(0x1111));
        actors.push(address(0x2222));
        actors.push(address(0x3333));

        for (uint256 i; i < actors.length; ++i) {
            usdg.mint(actors[i], 1e27);
        }

        handler = new StakeManagerHandler(manager, vault, usdg, actors);

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: _handlerSelectors()}));

        excludeContract(address(manager));
        excludeContract(address(vault));
        excludeContract(address(usdg));
    }

    /**
     * @notice Every share tracked by a position lives in the vault, and the
     * vault share supply always equals total principal.
     */
    function invariant_SharesMatchVaultAndPrincipal() public view {
        uint256 trackedShares;

        for (uint256 i; i < actors.length; ++i) {
            address actor = actors[i];
            (uint256 active, uint256 pending,, uint256 cooldown,) = manager.positions(actor, asset);

            assertEq(vault.sharesOf(actor), active + pending + cooldown, "position shares != vault custody");
            trackedShares += active + pending + cooldown;
        }

        (,,,,, uint256 configShares) = manager.assetConfig(asset);

        assertEq(trackedShares, configShares, "tracked shares != asset config");
        assertEq(configShares, vault.totalShares(), "config shares != vault supply");
        assertEq(vault.totalShares(), vault.totalPrincipal(), "share supply must equal principal");
    }

    /// @notice Unclaimed request shares are exactly the cooldown balance.
    function invariant_RequestsMatchCooldown() public view {
        for (uint256 i; i < actors.length; ++i) {
            address actor = actors[i];
            (,,, uint256 cooldown,) = manager.positions(actor, asset);

            uint256 lastRequestId = manager.nextRequestId(actor, asset);
            uint256 unclaimed;

            for (uint256 id = 1; id <= lastRequestId; ++id) {
                (uint256 shares,, bool claimed) = manager.unstakeRequests(actor, asset, id);
                if (!claimed) unclaimed += shares;
            }

            assertEq(unclaimed, cooldown, "unclaimed requests != cooldown shares");
        }
    }

    /// @notice The accounting layer never takes custody of user assets.
    function invariant_ManagerHoldsNoAssets() public view {
        assertEq(usdg.balanceOf(address(manager)), 0);
    }

    /**
     * @notice The vault can always pay the loss-adjusted claim. A donation or
     * harvest changes assets, never the share/principal identity.
     */
    function invariant_VaultSolvencyAndBasis() public view {
        uint256 assets = vault.totalAssets();
        uint256 principal = vault.totalPrincipal();
        uint256 shares = vault.totalShares();

        assertEq(assets, usdg.balanceOf(address(vault)), "idle-only vault assets mismatch");
        assertEq(shares, principal, "share supply must equal principal");

        if (shares == 0) {
            assertEq(vault.previewRedeem(0), 0);
        } else {
            uint256 expectedBasis = assets < principal ? assets : principal;
            assertEq(vault.previewRedeem(shares), expectedBasis, "redeemable basis mismatch");
            assertLe(expectedBasis, assets, "vault must stay solvent");
        }
    }

    /**
     * @notice Deterministic smoke test proving the handler actually reaches
     * each lifecycle operation; the random invariants above are not vacuous.
     */
    function test_HandlerExercisesLifecycle() public {
        handler.stake(0, 100e18);
        assertGt(handler.successfulStakes(), 0, "stake not executed");

        handler.warp(1 days + 1);
        handler.requestUnstake(0, 50e18);
        assertGt(handler.successfulRequests(), 0, "request not executed");

        vm.warp(block.timestamp + 7 days);
        handler.withdraw(0, 1);
        assertGt(handler.successfulWithdrawals(), 0, "withdraw not executed");

        handler.simulateLoss(1e18);
        assertGt(handler.simulatedLosses(), 0, "loss not simulated");
        handler.recoverLoss(1e18);
        assertGt(handler.recoveries(), 0, "loss not recovered");
        handler.harvest();

        invariant_SharesMatchVaultAndPrincipal();
        invariant_RequestsMatchCooldown();
        invariant_ManagerHoldsNoAssets();
        invariant_VaultSolvencyAndBasis();
    }

    function _handlerSelectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](8);
        selectors[0] = StakeManagerHandler.stake.selector;
        selectors[1] = StakeManagerHandler.requestUnstake.selector;
        selectors[2] = StakeManagerHandler.withdraw.selector;
        selectors[3] = StakeManagerHandler.warp.selector;
        selectors[4] = StakeManagerHandler.harvest.selector;
        selectors[5] = StakeManagerHandler.donateYield.selector;
        selectors[6] = StakeManagerHandler.simulateLoss.selector;
        selectors[7] = StakeManagerHandler.recoverLoss.selector;
    }
}
