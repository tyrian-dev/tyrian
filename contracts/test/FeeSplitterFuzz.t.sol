// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../src/FeeSplitter.sol";
import "../src/BuybackBurner.sol";
import "../src/interfaces/IBurnSource.sol";
import "../src/interfaces/ISwapRouterV3.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockWETH.sol";
import "../src/mocks/MockSwapRouterV3.sol";

/// @dev Pays half the input and ignores `amountOutMinimum`, so the burner's own
/// output check is the code under test.
contract ShortPayingSwapRouter is ISwapRouterV3 {
    using SafeERC20 for IERC20;

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut) {
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn / 2;
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }
}

/**
 * @dev Fuzz coverage for fee conservation and the TYR burn path. The splitter
 * must never retain WETH/TYR, and TYR must never reach the treasury.
 */
contract FeeSplitterFuzzTest is Test {
    FeeSplitter public splitter;
    BuybackBurner public burner;
    MockWETH public weth;
    MockERC20 public tyr;
    MockSwapRouterV3 public swapRouter;

    address public owner = address(0xA11CE);
    address public treasury = address(0xCAFE);
    address public dead = address(0x000000000000000000000000000000000000dEaD);

    function setUp() public {
        vm.warp(1_700_000_000);

        weth = new MockWETH();
        tyr = new MockERC20("Tyrian", "TYR", 18);
        swapRouter = new MockSwapRouterV3();

        burner = new BuybackBurner(address(tyr), address(weth), owner);
        splitter = new FeeSplitter(address(weth), address(tyr), treasury, address(burner), owner);

        vm.startPrank(owner);
        burner.setRouter(address(swapRouter), 3000);
        burner.setKeeper(address(this));
        vm.stopPrank();

        // The 1:1 mock router pays TYR from its own balance.
        tyr.mint(address(swapRouter), 1e30);
    }

    function testFuzz_WethSplitConservesBalance(uint96 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, 1e28);

        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        weth.transfer(address(splitter), amount);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        uint256 burnerBefore = weth.balanceOf(address(burner));

        splitter.splitWeth();

        uint256 treasuryOut = weth.balanceOf(treasury) - treasuryBefore;
        uint256 buybackOut = weth.balanceOf(address(burner)) - burnerBefore;

        assertEq(treasuryOut, (amount * 8000) / 10_000, "treasury gets 80%");
        assertEq(buybackOut, amount - treasuryOut, "buyback gets the rest");
        assertEq(treasuryOut + buybackOut, amount, "split conserves WETH");
        assertEq(weth.balanceOf(address(splitter)), 0, "splitter retains no WETH");
    }

    function testFuzz_TyrFeeIsBurnedNotTransferred(uint96 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, 1e28);
        tyr.mint(address(splitter), amount);

        uint256 deadBefore = tyr.balanceOf(dead);
        uint256 burned = splitter.burnTyr();

        assertEq(burned, amount);
        assertEq(tyr.balanceOf(dead) - deadBefore, amount, "all TYR burned");
        assertEq(tyr.balanceOf(address(splitter)), 0);
        assertEq(tyr.balanceOf(treasury), 0, "treasury never receives TYR");
        assertEq(tyr.balanceOf(address(burner)), 0, "burner never receives TYR fee");
    }

    function testFuzz_SplitRejectsTyr(uint96 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, 1e28);
        tyr.mint(address(splitter), amount);

        vm.expectRevert(FeeSplitter.UnsupportedToken.selector);
        splitter.split(address(tyr));

        assertEq(tyr.balanceOf(address(splitter)), amount, "TYR cannot be split");
    }

    function testFuzz_NativeEthWrapsToWeth(uint96 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, 1e28);

        vm.deal(address(this), amount);
        (bool ok,) = address(splitter).call{value: amount}("");

        assertTrue(ok);
        assertEq(weth.balanceOf(address(splitter)), amount);
        assertEq(address(splitter).balance, 0, "no native balance remains");
    }

    function testFuzz_BuybackBurnsAllSwapOutput(uint96 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, 1e27);

        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        weth.transfer(address(burner), amount);

        uint256 deadBefore = tyr.balanceOf(dead);
        uint256 burned = burner.buybackAndBurn(amount, amount, block.timestamp);

        assertEq(burned, amount);
        assertEq(tyr.balanceOf(dead) - deadBefore, amount, "all bought TYR is burned");
        assertEq(burner.totalBurned(), amount);
        assertEq(weth.balanceOf(address(burner)), 0);
        assertEq(weth.allowance(address(burner), address(swapRouter)), 0);
    }

    function testFuzz_BuybackRejectsInsufficientOutput(uint96 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, 1e27);

        ShortPayingSwapRouter shortRouter = new ShortPayingSwapRouter();
        tyr.mint(address(shortRouter), 1e30);

        vm.prank(owner);
        burner.setRouter(address(shortRouter), 3000);

        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        weth.transfer(address(burner), amount);

        vm.expectRevert(BuybackBurner.InsufficientOutput.selector);
        burner.buybackAndBurn(amount, amount, block.timestamp);

        assertEq(burner.totalBurned(), 0);
        assertEq(tyr.balanceOf(dead), 0);
        assertEq(weth.balanceOf(address(burner)), amount, "failed buyback keeps WETH");
    }

    function testFuzz_DirectTyrBurn(uint96 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, 1e28);
        tyr.mint(address(burner), amount);

        uint256 deadBefore = tyr.balanceOf(dead);
        uint256 burned = burner.burnTyr();

        assertEq(burned, amount);
        assertEq(tyr.balanceOf(dead) - deadBefore, amount);
        assertEq(burner.totalBurned(), amount);
        assertEq(tyr.balanceOf(address(burner)), 0);
    }
}
