// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "../src/BuybackBurner.sol";
import "../src/FeeSplitter.sol";
import "../src/PortfolioVault.sol";
import "../src/StakeManager.sol";
import "../src/TreasuryRouter.sol";
import "../src/mocks/MockAggregatorV3.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockSwapRouterV3.sol";
import "../src/mocks/MockWETH.sol";
import "../src/mocks/MockYieldStrategy.sol";
import "../src/oracles/StockPriceOracle.sol";
import "../src/vaults/StockVault.sol";
import "../src/vaults/UsdgVault.sol";

/**
 * @title AccessControlTest
 * @notice CTR-TST-006: access control and pause matrix for the production
 * contracts.
 *
 * Covers owner-only configuration, the guardian pause scope, the "pause never
 * blocks exits" rule, ownership through a real `TimelockController`, and the
 * absence of admin paths that move user assets.
 */
contract AccessControlTest is Test {
    address internal constant OWNER = address(0xA11CE);
    address internal constant TREASURY = address(0xCAFE);
    address internal constant GUARDIAN = address(0x2222);
    address internal constant NEW_GUARDIAN = address(0x3333);
    address internal constant STRANGER = address(0xB0B);
    address internal constant USER = address(0x1111);
    address internal constant USER_TWO = address(0x4444);
    address internal constant BURNER = address(0xBEEF);

    uint256 internal constant CAP = 10_000 ether;
    uint256 internal constant TIMELOCK_DELAY = 48 hours;

    MockERC20 internal usdg;
    MockERC20 internal tyr;
    MockERC20 internal stock;
    MockWETH internal weth;
    MockAggregatorV3 internal feed;
    MockSwapRouterV3 internal swapRouter;

    StakeManager internal stakeManager;
    UsdgVault internal vault;
    StockVault internal stockVault;
    StockPriceOracle internal oracle;
    TreasuryRouter internal router;
    PortfolioVault internal portfolio;
    FeeSplitter internal splitter;
    BuybackBurner internal burner;

    function setUp() public {
        vm.warp(1_700_000_000);

        usdg = new MockERC20("USDG", "USDG", 18);
        tyr = new MockERC20("TYR", "TYR", 18);
        stock = new MockERC20("Stock", "STK", 18);
        weth = new MockWETH();
        feed = new MockAggregatorV3(8, 100e8);
        swapRouter = new MockSwapRouterV3();

        stakeManager = new StakeManager(OWNER);
        vault = new UsdgVault(address(usdg), TREASURY, address(stakeManager), OWNER);
        stockVault = new StockVault(address(stock), "AAPL", address(feed), CAP, TREASURY, address(stakeManager), OWNER);
        oracle = new StockPriceOracle(address(stock), address(feed), OWNER);
        router = new TreasuryRouter(address(usdg), address(weth), OWNER);
        portfolio = new PortfolioVault(address(usdg), OWNER);
        splitter = new FeeSplitter(address(weth), address(tyr), TREASURY, BURNER, OWNER);
        burner = new BuybackBurner(address(tyr), address(weth), OWNER);

        vm.startPrank(OWNER);
        stakeManager.setGuardian(GUARDIAN);
        stakeManager.setAssetConfig(address(usdg), true, StakeManager.AssetKind.BASE, address(vault), address(0), CAP);

        vault.setGuardian(GUARDIAN);
        stockVault.setGuardian(GUARDIAN);

        router.setRecipients(address(0xB0B0), address(0xCAFE1), address(portfolio));
        router.setRouter(address(swapRouter), 3000);
        router.setGuardian(GUARDIAN);

        portfolio.setGuardian(GUARDIAN);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _stake(address user, uint256 amount) internal {
        usdg.mint(user, amount);
        vm.startPrank(user);
        usdg.approve(address(stakeManager), amount);
        stakeManager.stake(address(usdg), amount);
        vm.stopPrank();
    }

    function _unauthorized(address account) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, account);
    }

    function _timelock() internal returns (TimelockController timelock) {
        address[] memory proposers = new address[](1);
        proposers[0] = address(this);
        address[] memory executors = new address[](1);
        executors[0] = address(this);

        timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(0));
    }

    function _executeViaTimelock(TimelockController timelock, address target, bytes memory data, string memory saltSeed)
        internal
    {
        bytes32 salt = keccak256(abi.encodePacked(saltSeed, target, data));
        timelock.schedule(target, 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    // ---------------------------------------------------------------------
    // Owner-only configuration surface
    // ---------------------------------------------------------------------

    function test_StakeManagerSettersOnlyOwner() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        stakeManager.setGuardian(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        stakeManager.setCooldownDuration(1 days);
        vm.expectRevert(_unauthorized(STRANGER));
        stakeManager.setAssetConfig(address(usdg), true, StakeManager.AssetKind.BASE, address(vault), address(0), CAP);
        vm.stopPrank();
    }

    function test_UsdgVaultSettersOnlyOwner() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        vault.setTreasury(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        vault.setOperator(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        vault.setGuardian(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        vault.setStrategy(address(0));
        vm.expectRevert(_unauthorized(STRANGER));
        vault.allocateToStrategy(1);
        vm.expectRevert(_unauthorized(STRANGER));
        vault.deallocateFromStrategy(1);
        vm.stopPrank();
    }

    function test_StockVaultSettersOnlyOwner() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        stockVault.setStockEnabled(false);
        vm.expectRevert(_unauthorized(STRANGER));
        stockVault.setDepositCap(1 ether);
        vm.expectRevert(_unauthorized(STRANGER));
        stockVault.setPriceFeed(address(feed));
        vm.expectRevert(_unauthorized(STRANGER));
        stockVault.setMaxStalePeriod(1 hours);
        vm.stopPrank();
    }

    function test_StockPriceOracleSettersOnlyOwner() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        oracle.setFeed(address(feed));
        vm.expectRevert(_unauthorized(STRANGER));
        oracle.setMaxStalePeriod(1 hours);
        vm.stopPrank();
    }

    function test_TreasuryRouterSettersOnlyOwner() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        router.setRecipients(STRANGER, STRANGER, STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        router.setSplit(7000, 2000, 1000);
        vm.expectRevert(_unauthorized(STRANGER));
        router.setRouter(address(swapRouter), 3000);
        vm.expectRevert(_unauthorized(STRANGER));
        router.setKeeper(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        router.setGuardian(STRANGER);
        vm.stopPrank();
    }

    function test_PortfolioVaultSettersOnlyOwner() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        portfolio.setTreasury(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        portfolio.setKeeper(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        portfolio.setGuardian(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        portfolio.setRouter(STRANGER, 3000);
        vm.expectRevert(_unauthorized(STRANGER));
        portfolio.setMaxSlippageBps(100);
        vm.expectRevert(_unauthorized(STRANGER));
        portfolio.setDcaInterval(7 days);
        vm.expectRevert(_unauthorized(STRANGER));
        portfolio.setDcaAmountUsd(1 ether);
        vm.expectRevert(_unauthorized(STRANGER));
        portfolio.setTreasuryTotalUsd(1 ether);
        vm.stopPrank();
    }

    function test_FeeSplitterRecipientsOnlyOwner() public {
        vm.prank(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        splitter.setRecipients(STRANGER, STRANGER);
    }

    function test_BuybackBurnerSettersOnlyOwner() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(_unauthorized(STRANGER));
        burner.setRouter(address(swapRouter), 3000);
        vm.expectRevert(_unauthorized(STRANGER));
        burner.setKeeper(STRANGER);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Two-step ownership and real timelock
    // ---------------------------------------------------------------------

    function test_OwnershipTransferRequiresAcceptance() public {
        vm.prank(OWNER);
        vault.transferOwnership(STRANGER);

        assertEq(vault.owner(), OWNER, "owner must not change before acceptance");
        assertEq(vault.pendingOwner(), STRANGER);

        vm.prank(address(0xDEAD));
        vm.expectRevert(_unauthorized(address(0xDEAD)));
        vault.acceptOwnership();

        vm.prank(STRANGER);
        vault.acceptOwnership();
        assertEq(vault.owner(), STRANGER);
        assertEq(vault.pendingOwner(), address(0));
    }

    function test_TimelockOwnershipTransferAndDelayedExecution() public {
        TimelockController timelock = _timelock();

        vm.prank(OWNER);
        vault.transferOwnership(address(timelock));
        assertEq(vault.owner(), OWNER, "timelock is only pending");
        assertEq(vault.pendingOwner(), address(timelock));

        bytes memory acceptData = abi.encodeWithSignature("acceptOwnership()");
        bytes32 salt = keccak256("accept-ownership");
        timelock.schedule(address(vault), 0, acceptData, bytes32(0), salt, TIMELOCK_DELAY);

        vm.expectRevert();
        timelock.execute(address(vault), 0, acceptData, bytes32(0), salt);

        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        timelock.execute(address(vault), 0, acceptData, bytes32(0), salt);
        assertEq(vault.owner(), address(timelock));

        // The previous owner loses every owner-only path, including unpause.
        vm.prank(OWNER);
        vm.expectRevert(_unauthorized(OWNER));
        vault.setGuardian(OWNER);

        bytes memory setGuardianData = abi.encodeWithSignature("setGuardian(address)", NEW_GUARDIAN);
        _executeViaTimelock(timelock, address(vault), setGuardianData, "set-guardian");
        assertEq(vault.guardian(), NEW_GUARDIAN);
    }

    function test_TimelockRequiredToUnpause() public {
        TimelockController timelock = _timelock();

        vm.prank(OWNER);
        vault.transferOwnership(address(timelock));
        _executeViaTimelock(timelock, address(vault), abi.encodeWithSignature("acceptOwnership()"), "accept");

        vm.prank(GUARDIAN);
        vault.pause();
        assertTrue(vault.paused());

        vm.prank(OWNER);
        vm.expectRevert(_unauthorized(OWNER));
        vault.unpause();

        _executeViaTimelock(timelock, address(vault), abi.encodeWithSignature("unpause()"), "unpause");
        assertFalse(vault.paused());
    }

    // ---------------------------------------------------------------------
    // Guardian scope
    // ---------------------------------------------------------------------

    function test_GuardianCanPauseButNotUnpause_StakeManager() public {
        vm.prank(GUARDIAN);
        stakeManager.pause();
        assertTrue(stakeManager.paused());

        vm.prank(GUARDIAN);
        vm.expectRevert(_unauthorized(GUARDIAN));
        stakeManager.unpause();

        vm.prank(OWNER);
        stakeManager.unpause();
        assertFalse(stakeManager.paused());
    }

    function test_GuardianCanPauseButNotUnpause_Vault() public {
        vm.prank(GUARDIAN);
        vault.pause();

        vm.prank(GUARDIAN);
        vm.expectRevert(_unauthorized(GUARDIAN));
        vault.unpause();

        vm.prank(OWNER);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_GuardianCannotChangeParameters() public {
        vm.startPrank(GUARDIAN);
        vm.expectRevert(_unauthorized(GUARDIAN));
        stakeManager.setCooldownDuration(1 days);
        vm.expectRevert(_unauthorized(GUARDIAN));
        vault.setTreasury(GUARDIAN);
        vm.expectRevert(_unauthorized(GUARDIAN));
        router.setSplit(7000, 2000, 1000);
        vm.expectRevert(_unauthorized(GUARDIAN));
        portfolio.setTreasuryTotalUsd(1_000_000e18);
        vm.stopPrank();
    }

    function test_NonGuardianCannotPause() public {
        vm.prank(STRANGER);
        vm.expectRevert(StakeManager.NotGuardian.selector);
        stakeManager.pause();

        vm.prank(STRANGER);
        vm.expectRevert(PrincipalVault.NotGuardian.selector);
        vault.pause();

        vm.prank(STRANGER);
        vm.expectRevert(TreasuryRouter.NotGuardian.selector);
        router.pause();

        vm.prank(STRANGER);
        vm.expectRevert(PortfolioVault.NotGuardian.selector);
        portfolio.pause();
    }

    // ---------------------------------------------------------------------
    // Pause semantics: entries blocked, exits always open
    // ---------------------------------------------------------------------

    function test_PauseBlocksStakeButKeepsExitPath() public {
        _stake(USER, 1000 ether);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(GUARDIAN);
        stakeManager.pause();

        usdg.mint(USER_TWO, 100 ether);
        vm.startPrank(USER_TWO);
        usdg.approve(address(stakeManager), 100 ether);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        stakeManager.stake(address(usdg), 100 ether);
        vm.stopPrank();

        vm.prank(USER);
        uint256 requestId = stakeManager.requestUnstake(address(usdg), 400 ether);
        vm.warp(block.timestamp + 7 days + 1);

        vm.prank(USER);
        uint256 withdrawn = stakeManager.withdraw(address(usdg), requestId);
        assertEq(withdrawn, 400 ether, "withdraw must stay available while paused");
        assertEq(stakeManager.paused(), true);
    }

    function test_PauseBlocksVaultDepositAndHarvestButNotRedeem() public {
        _stake(USER, 1000 ether);

        vm.prank(GUARDIAN);
        vault.pause();

        vm.prank(address(stakeManager));
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.depositFor(USER, 1 ether);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.harvest();

        uint256 beforeBalance = usdg.balanceOf(USER);
        vm.prank(address(stakeManager));
        uint256 redeemed = vault.redeemFor(USER, 1000 ether);
        assertEq(redeemed, 1000 ether, "redeem must stay available while paused");
        assertEq(usdg.balanceOf(USER) - beforeBalance, 1000 ether);
    }

    function test_PauseBlocksRoutingAndUnpauseRestores() public {
        usdg.mint(address(router), 1000 ether);

        vm.prank(GUARDIAN);
        router.pause();

        vm.prank(OWNER);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.route(0, block.timestamp);

        vm.prank(OWNER);
        router.unpause();

        vm.prank(OWNER);
        router.route(0, block.timestamp);
        assertGt(usdg.balanceOf(address(0xB0B0)), 0, "budget receives its leg after unpause");
    }

    // ---------------------------------------------------------------------
    // No admin path moves user assets
    // ---------------------------------------------------------------------

    function test_StakeManagerCannotMoveUserAssets() public {
        _stake(USER, 1000 ether);
        uint256 vaultBalanceBefore = usdg.balanceOf(address(vault));

        vm.startPrank(OWNER);
        stakeManager.setGuardian(NEW_GUARDIAN);
        stakeManager.setCooldownDuration(3 days);
        stakeManager.setAssetConfig(address(usdg), true, StakeManager.AssetKind.BASE, address(vault), address(0), CAP);
        vm.stopPrank();

        assertEq(usdg.balanceOf(address(stakeManager)), 0, "manager never holds user assets");
        assertEq(usdg.balanceOf(address(vault)), vaultBalanceBefore, "vault custody unchanged");
        assertEq(vault.sharesOf(USER), 1000 ether, "user shares unchanged");

        (, uint256 pending,,) = stakeManager.getEffectivePosition(USER, address(usdg));
        assertEq(pending, 1000 ether, "user position unchanged");
    }

    function test_StakeManagerCannotReplaceVaultWithOutstandingShares() public {
        _stake(USER, 1000 ether);

        UsdgVault otherVault = new UsdgVault(address(usdg), TREASURY, address(stakeManager), OWNER);

        vm.prank(OWNER);
        vm.expectRevert(StakeManager.VaultAlreadyInUse.selector);
        stakeManager.setAssetConfig(
            address(usdg), true, StakeManager.AssetKind.BASE, address(otherVault), address(0), CAP
        );
    }

    function test_AllocateToStrategyRequiresMatchingAsset() public {
        _stake(USER, 1000 ether);

        MockYieldStrategy wrongStrategy = new MockYieldStrategy(address(tyr), address(vault));
        vm.prank(OWNER);
        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        vault.setStrategy(address(wrongStrategy));

        MockYieldStrategy strategy = new MockYieldStrategy(address(usdg), address(vault));
        vm.prank(OWNER);
        vault.setStrategy(address(strategy));

        vm.prank(OWNER);
        vault.allocateToStrategy(400 ether);

        assertEq(usdg.balanceOf(address(strategy)), 400 ether);
        assertEq(vault.totalAssets(), 1000 ether, "allocation must not change total assets");
        assertEq(vault.totalPrincipal(), 1000 ether, "allocation must not change principal");
    }

    function test_OwnerCannotPointStrategyAtArbitraryAddress() public {
        _stake(USER, 1000 ether);

        vm.prank(OWNER);
        vm.expectRevert();
        vault.setStrategy(STRANGER);
    }

    function test_HarvestNeverMovesPrincipal() public {
        _stake(USER, 1000 ether);
        uint256 vaultBalanceBefore = usdg.balanceOf(address(vault));

        uint256 yield = vault.harvest();

        assertEq(yield, 0, "no yield above principal");
        assertEq(usdg.balanceOf(address(vault)), vaultBalanceBefore);
        assertEq(vault.totalPrincipal(), 1000 ether);
        assertEq(usdg.balanceOf(TREASURY), 0, "treasury must not receive principal");
    }

    // ---------------------------------------------------------------------
    // Permissionless keepers keep fixed recipients
    // ---------------------------------------------------------------------

    function test_FeeSplitterSplitIsPermissionlessWithFixedRecipients() public {
        uint256 amount = 100 ether;
        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        weth.transfer(address(splitter), amount);

        vm.prank(STRANGER);
        splitter.splitWeth();

        assertEq(weth.balanceOf(TREASURY), 80 ether);
        assertEq(weth.balanceOf(BURNER), 20 ether);
        assertEq(weth.balanceOf(address(splitter)), 0);
    }

    function test_BuybackBurnerIsKeeperOnly() public {
        vm.prank(STRANGER);
        vm.expectRevert(BuybackBurner.NotKeeper.selector);
        burner.buybackAndBurn(1, 0, block.timestamp);

        vm.prank(OWNER);
        burner.setKeeper(USER);
        assertEq(burner.keeper(), USER);
    }

    function test_OracleCheckPriceIsPermissionless() public {
        vm.prank(STRANGER);
        assertTrue(oracle.checkPrice(), "monitoring hook must be callable by anyone");
    }
}
