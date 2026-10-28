// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../src/TreasuryRouter.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockWETH.sol";
import "../src/mocks/MockSwapRouterV3.sol";

/**
 * @dev Random action handler for treasury routing invariants.
 *
 * Each action funds the router with USDG and/or WETH, optionally changes the
 * split, and routes. The mock swap router is 1:1 and always succeeds, so any
 * WETH left in the router after a call is an accounting bug.
 */
contract TreasuryRouterHandler is Test {
    TreasuryRouter public immutable router;
    MockERC20 public immutable usdg;
    MockWETH public immutable weth;
    address public immutable owner;
    address public immutable keeper;

    constructor(TreasuryRouter router_, MockERC20 usdg_, MockWETH weth_, address owner_, address keeper_) {
        router = router_;
        usdg = usdg_;
        weth = weth_;
        owner = owner_;
        keeper = keeper_;
    }

    function route(uint96 rawUsdg, uint96 rawWeth) external {
        uint256 usdgIn = uint256(rawUsdg);
        uint256 wethIn = uint256(rawWeth);

        if (usdgIn > 0) usdg.mint(address(router), usdgIn);

        if (wethIn > 0) {
            vm.deal(address(this), wethIn);
            weth.deposit{value: wethIn}();
            weth.transfer(address(router), wethIn);
        }

        vm.prank(keeper);
        try router.route(0, block.timestamp) {} catch {}
    }

    function setSplit(uint96 rawBudgetBps, uint96 rawReserveBps) external {
        uint256 budgetBps = bound(rawBudgetBps, 1, 9998);
        uint256 reserveBps = bound(rawReserveBps, 1, 9999 - budgetBps);
        uint256 portfolioBps = 10_000 - budgetBps - reserveBps;

        vm.prank(owner);
        router.setSplit(budgetBps, reserveBps, portfolioBps);
    }
}

contract TreasuryRouterInvariantTest is Test {
    TreasuryRouter public router;
    MockERC20 public usdg;
    MockWETH public weth;
    MockSwapRouterV3 public swapRouter;
    TreasuryRouterHandler public handler;

    address public keeper = address(0x1111);

    address public budget = address(0xB0B0);
    address public reserve = address(0xCAFE);
    address public portfolio = address(0xF01D);

    function setUp() public {
        vm.warp(1_700_000_000);

        usdg = new MockERC20("Robinhood USDG", "USDG", 18);
        weth = new MockWETH();
        swapRouter = new MockSwapRouterV3();

        router = new TreasuryRouter(address(usdg), address(weth), address(this));

        router.setRecipients(budget, reserve, portfolio);
        router.setRouter(address(swapRouter), 3000);
        router.setKeeper(keeper);

        // The 1:1 mock router pays USDG from its own balance.
        usdg.mint(address(swapRouter), 1e30);

        handler = new TreasuryRouterHandler(router, usdg, weth, address(this), keeper);

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: _handlerSelectors()}));

        excludeContract(address(router));
        excludeContract(address(usdg));
        excludeContract(address(weth));
        excludeContract(address(swapRouter));
    }

    /// @notice Every USDG inflow is either still in the router or on a recipient.
    function invariant_RecipientsHoldAllRoutedUsdg() public view {
        uint256 recipientBalances = usdg.balanceOf(budget) + usdg.balanceOf(reserve) + usdg.balanceOf(portfolio);

        assertEq(recipientBalances, router.totalRouted(), "recipient balances != total routed");
        assertEq(usdg.balanceOf(address(router)), 0, "router must not retain USDG");
    }

    /// @notice A successful WETH swap leaves no WETH and no dangling allowance.
    function invariant_NoRetainedWethOrAllowance() public view {
        assertEq(weth.balanceOf(address(router)), 0, "router must not retain WETH");
        assertEq(weth.allowance(address(router), address(swapRouter)), 0, "allowance must be cleared");
    }

    /// @notice The configured split always sums to 100% and no leg is zero.
    function invariant_SplitIsAlwaysComplete() public view {
        uint256 budgetBps = router.budgetBps();
        uint256 reserveBps = router.reserveBps();
        uint256 portfolioBps = router.portfolioBps();

        assertGt(budgetBps, 0);
        assertGt(reserveBps, 0);
        assertGt(portfolioBps, 0);
        assertEq(budgetBps + reserveBps + portfolioBps, 10_000, "split must total 100%");
    }

    function _handlerSelectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](2);
        selectors[0] = TreasuryRouterHandler.route.selector;
        selectors[1] = TreasuryRouterHandler.setSplit.selector;
    }
}
