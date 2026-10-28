// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "../src/TreasuryRouter.sol";
import "../src/interfaces/ISwapRouterV3.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockWETH.sol";
import "../src/mocks/MockSwapRouterV3.sol";

contract FailingSwapRouter is ISwapRouterV3 {
    function exactInputSingle(ExactInputSingleParams calldata) external pure returns (uint256) {
        revert("swap failed");
    }
}

contract TreasuryRouterTest is Test {
    TreasuryRouter public router;
    MockERC20 public usdg;
    MockWETH public weth;
    MockSwapRouterV3 public swapRouter;

    address public owner = address(0xA11CE);
    address public keeper = address(0x1111);
    address public guardian = address(0x2222);
    address public stranger = address(0xB0B);

    address public budget = address(0xB0B0);
    address public reserve = address(0xCAFE);
    address public portfolio = address(0xF01D);

    function setUp() public {
        vm.warp(1_700_000_000);

        usdg = new MockERC20("Robinhood USDG", "USDG", 18);
        weth = new MockWETH();
        swapRouter = new MockSwapRouterV3();

        router = new TreasuryRouter(address(usdg), address(weth), owner);

        vm.startPrank(owner);
        router.setRecipients(budget, reserve, portfolio);
        router.setRouter(address(swapRouter), 3000);
        router.setKeeper(keeper);
        router.setGuardian(guardian);
        vm.stopPrank();

        // The 1:1 mock router pays USDG from its own balance.
        usdg.mint(address(swapRouter), 1_000_000e18);
    }

    function test_RouteSplitsUsdgSeventyTwentyTen() public {
        _fundUsdg(1000e18);

        vm.prank(keeper);
        router.route(0, block.timestamp);

        assertEq(usdg.balanceOf(budget), 700e18);
        assertEq(usdg.balanceOf(reserve), 200e18);
        assertEq(usdg.balanceOf(portfolio), 100e18);
        assertEq(router.totalRouted(), 1000e18);
    }

    /// @dev 101 wei: reserve = 20, portfolio = 10, and the 1 wei dust stays in
    /// the budget leg so the split never loses funds.
    function test_RoundingDustStaysInBudget() public {
        _fundUsdg(101);

        vm.prank(keeper);
        router.route(0, block.timestamp);

        assertEq(usdg.balanceOf(budget), 71);
        assertEq(usdg.balanceOf(reserve), 20);
        assertEq(usdg.balanceOf(portfolio), 10);
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    function test_RouteSwapsWethToUsdgFirst() public {
        _fundWeth(1000e18);

        vm.prank(keeper);
        router.route(1000e18, block.timestamp);

        assertEq(weth.balanceOf(address(router)), 0);
        assertEq(usdg.balanceOf(budget), 700e18);
        assertEq(usdg.balanceOf(reserve), 200e18);
        assertEq(usdg.balanceOf(portfolio), 100e18);
    }

    function test_FailedSwapKeepsWethAndDoesNotRevert() public {
        FailingSwapRouter failing = new FailingSwapRouter();
        vm.prank(owner);
        router.setRouter(address(failing), 3000);

        _fundWeth(100e18);

        vm.prank(keeper);
        router.route(0, block.timestamp);

        assertEq(weth.balanceOf(address(router)), 100e18);
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(weth.allowance(address(router), address(failing)), 0);
        assertEq(router.totalRouted(), 0);
    }

    /// @dev After an alert, the keeper fixes the router and the retained WETH is
    /// routed on the next call.
    function test_RetriesRetainedWethAfterFailure() public {
        FailingSwapRouter failing = new FailingSwapRouter();
        vm.prank(owner);
        router.setRouter(address(failing), 3000);

        _fundWeth(50e18);
        vm.prank(keeper);
        router.route(0, block.timestamp);

        vm.prank(owner);
        router.setRouter(address(swapRouter), 3000);

        vm.prank(keeper);
        router.route(50e18, block.timestamp);

        assertEq(weth.balanceOf(address(router)), 0);
        assertEq(usdg.balanceOf(budget), 35e18);
        assertEq(usdg.balanceOf(reserve), 10e18);
        assertEq(usdg.balanceOf(portfolio), 5e18);
    }

    function test_RouteWithNoBalanceEmitsNothingToRoute() public {
        vm.expectEmit(false, false, false, true);
        emit TreasuryRouter.NothingToRoute();

        vm.prank(keeper);
        (uint256 budgetOut, uint256 reserveOut, uint256 portfolioOut) = router.route(0, block.timestamp);

        assertEq(budgetOut, 0);
        assertEq(reserveOut, 0);
        assertEq(portfolioOut, 0);
    }

    function test_OnlyKeeperOrOwnerCanRoute() public {
        _fundUsdg(100e18);

        vm.prank(stranger);
        vm.expectRevert(TreasuryRouter.NotKeeper.selector);
        router.route(0, block.timestamp);
    }

    function test_PauseBlocksRoute() public {
        _fundUsdg(100e18);

        vm.prank(guardian);
        router.pause();

        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.route(0, block.timestamp);

        vm.prank(owner);
        router.unpause();

        vm.prank(keeper);
        router.route(0, block.timestamp);

        assertEq(usdg.balanceOf(budget), 70e18);
    }

    function test_OnlyOwnerCanUnpause() public {
        vm.prank(guardian);
        router.pause();

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        router.unpause();
    }

    function test_OnlyGuardianCanPause() public {
        vm.prank(stranger);
        vm.expectRevert(TreasuryRouter.NotGuardian.selector);
        router.pause();
    }

    function test_SetSplitRequiresOneHundredPercent() public {
        vm.prank(owner);
        vm.expectRevert(TreasuryRouter.InvalidSplit.selector);
        router.setSplit(6000, 2000, 1000);
    }

    function test_SetSplitRejectsZeroLeg() public {
        vm.prank(owner);
        vm.expectRevert(TreasuryRouter.InvalidSplit.selector);
        router.setSplit(8000, 2000, 0);
    }

    function test_SetSplitOnlyOwnerAndEmits() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        router.setSplit(7000, 2000, 1000);

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit TreasuryRouter.SplitUpdated(5000, 3000, 2000);
        router.setSplit(5000, 3000, 2000);

        _fundUsdg(100e18);
        vm.prank(keeper);
        router.route(0, block.timestamp);

        assertEq(usdg.balanceOf(budget), 50e18);
        assertEq(usdg.balanceOf(reserve), 30e18);
        assertEq(usdg.balanceOf(portfolio), 20e18);
    }

    function test_SetRecipientsRejectsZeroAndDuplicates() public {
        vm.startPrank(owner);

        vm.expectRevert(TreasuryRouter.InvalidAddress.selector);
        router.setRecipients(address(0), reserve, portfolio);

        vm.expectRevert(TreasuryRouter.InvalidAddress.selector);
        router.setRecipients(budget, budget, portfolio);

        vm.stopPrank();
    }

    function test_RouteRejectsPastDeadlineWhenSwapping() public {
        _fundWeth(10e18);

        vm.prank(keeper);
        vm.expectRevert(TreasuryRouter.InvalidDeadline.selector);
        router.route(0, block.timestamp - 1);
    }

    function test_RouteRejectsUnconfiguredRouterWhenWethPresent() public {
        TreasuryRouter bare = new TreasuryRouter(address(usdg), address(weth), owner);

        vm.startPrank(owner);
        bare.setRecipients(budget, reserve, portfolio);
        vm.stopPrank();

        vm.deal(address(this), 10 ether);
        weth.deposit{value: 1 ether}();
        weth.transfer(address(bare), 1 ether);

        vm.prank(owner);
        vm.expectRevert(TreasuryRouter.RouterNotConfigured.selector);
        bare.route(0, block.timestamp);
    }

    function test_RouteRejectsUnconfiguredRecipients() public {
        TreasuryRouter bare = new TreasuryRouter(address(usdg), address(weth), owner);
        usdg.transfer(address(bare), 100e18);

        vm.prank(owner);
        vm.expectRevert(TreasuryRouter.InvalidAddress.selector);
        bare.route(0, block.timestamp);
    }

    function test_SetRouterOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        router.setRouter(address(swapRouter), 500);
    }

    function _fundUsdg(uint256 amount) internal {
        usdg.transfer(address(router), amount);
    }

    function _fundWeth(uint256 amount) internal {
        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        weth.transfer(address(router), amount);
    }
}
