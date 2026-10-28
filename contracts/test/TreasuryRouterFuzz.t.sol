// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../src/TreasuryRouter.sol";
import "../src/interfaces/ISwapRouterV3.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockWETH.sol";
import "../src/mocks/MockSwapRouterV3.sol";

contract AlwaysFailingSwapRouter is ISwapRouterV3 {
    function exactInputSingle(ExactInputSingleParams calldata) external pure returns (uint256) {
        revert("swap failed");
    }
}

/**
 * @dev Fuzz coverage for treasury routing: every inflow is either swapped into
 * USDG or retained as WETH, and every routed USDG lands on a recipient.
 */
contract TreasuryRouterFuzzTest is Test {
    TreasuryRouter public router;
    MockERC20 public usdg;
    MockWETH public weth;
    MockSwapRouterV3 public swapRouter;

    address public owner = address(0xA11CE);
    address public keeper = address(0x1111);

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
        vm.stopPrank();

        // The 1:1 mock router pays USDG from its own balance.
        usdg.mint(address(swapRouter), 1e30);
    }

    function testFuzz_RouteConservesInflow(uint96 rawAmount, uint96 rawBudgetBps, uint96 rawReserveBps) public {
        uint256 budgetBps = bound(rawBudgetBps, 1, 9998);
        uint256 reserveBps = bound(rawReserveBps, 1, 9999 - budgetBps);
        uint256 portfolioBps = 10_000 - budgetBps - reserveBps;

        vm.prank(owner);
        router.setSplit(budgetBps, reserveBps, portfolioBps);

        uint256 amount = bound(rawAmount, 1, 1e30);
        usdg.mint(address(router), amount);

        uint256 budgetBefore = usdg.balanceOf(budget);
        uint256 reserveBefore = usdg.balanceOf(reserve);
        uint256 portfolioBefore = usdg.balanceOf(portfolio);
        uint256 routedBefore = router.totalRouted();

        vm.prank(keeper);
        (uint256 budgetOut, uint256 reserveOut, uint256 portfolioOut) = router.route(0, block.timestamp);

        assertEq(budgetOut + reserveOut + portfolioOut, amount, "split conserves the inflow");
        assertEq(usdg.balanceOf(budget) - budgetBefore, budgetOut);
        assertEq(usdg.balanceOf(reserve) - reserveBefore, reserveOut);
        assertEq(usdg.balanceOf(portfolio) - portfolioBefore, portfolioOut);

        assertEq(reserveOut, (amount * reserveBps) / 10_000);
        assertEq(portfolioOut, (amount * portfolioBps) / 10_000);

        uint256 exactBudget = (amount * budgetBps) / 10_000;
        assertGe(budgetOut, exactBudget, "rounding dust belongs to the budget");
        assertLe(budgetOut - exactBudget, 2, "at most two floor divisions of dust");

        assertEq(router.totalRouted() - routedBefore, amount);
        assertEq(usdg.balanceOf(address(router)), 0, "router keeps no USDG");
    }

    function testFuzz_RouteIncludesRetainedWeth(uint96 rawWeth, uint96 rawUsdg) public {
        uint256 wethIn = bound(rawWeth, 0, 1e27);
        uint256 usdgIn = bound(rawUsdg, 0, 1e27);

        if (wethIn > 0) {
            vm.deal(address(this), wethIn);
            weth.deposit{value: wethIn}();
            weth.transfer(address(router), wethIn);
        }
        if (usdgIn > 0) usdg.mint(address(router), usdgIn);

        uint256 totalIn = wethIn + usdgIn;

        vm.prank(keeper);
        (uint256 budgetOut, uint256 reserveOut, uint256 portfolioOut) = router.route(0, block.timestamp);

        assertEq(budgetOut + reserveOut + portfolioOut, totalIn);
        assertEq(router.totalRouted(), totalIn);
        assertEq(weth.balanceOf(address(router)), 0, "WETH swapped to USDG");
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    function testFuzz_FailedSwapRetainsWeth(uint96 rawWeth) public {
        uint256 wethIn = bound(rawWeth, 1, 1e27);

        AlwaysFailingSwapRouter failing = new AlwaysFailingSwapRouter();
        vm.prank(owner);
        router.setRouter(address(failing), 3000);

        vm.deal(address(this), wethIn);
        weth.deposit{value: wethIn}();
        weth.transfer(address(router), wethIn);

        uint256 budgetBefore = usdg.balanceOf(budget);

        vm.prank(keeper);
        (uint256 budgetOut, uint256 reserveOut, uint256 portfolioOut) = router.route(0, block.timestamp);

        assertEq(budgetOut + reserveOut + portfolioOut, 0);
        assertEq(weth.balanceOf(address(router)), wethIn, "WETH retained for retry");
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(usdg.balanceOf(budget), budgetBefore);
        assertEq(router.totalRouted(), 0);
        assertEq(weth.allowance(address(router), address(failing)), 0, "no allowance left behind");
    }

    function testFuzz_SetSplitRejectsInvalidCombination(uint16 first, uint16 second, uint16 third) public {
        uint256 sum = uint256(first) + uint256(second) + uint256(third);
        bool invalid = first == 0 || second == 0 || third == 0 || sum != 10_000;

        if (invalid) {
            vm.prank(owner);
            vm.expectRevert(TreasuryRouter.InvalidSplit.selector);
            router.setSplit(first, second, third);
            return;
        }

        vm.prank(owner);
        router.setSplit(first, second, third);

        assertEq(router.budgetBps(), first);
        assertEq(router.reserveBps(), second);
        assertEq(router.portfolioBps(), third);
    }
}
