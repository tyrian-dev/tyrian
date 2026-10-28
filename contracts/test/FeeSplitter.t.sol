// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/FeeSplitter.sol";
import "../src/BuybackBurner.sol";
import "../src/interfaces/IBurnSource.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockWETH.sol";
import "../src/mocks/MockSwapRouterV3.sol";

contract FeeSplitterTest is Test {
    FeeSplitter public splitter;
    BuybackBurner public burner;
    MockWETH public weth;
    MockERC20 public tyr;

    address public owner = address(0xA11CE);
    address public treasury = address(0xCAFE);
    address public dead = address(0x000000000000000000000000000000000000dEaD);

    function setUp() public {
        vm.startPrank(owner);
        weth = new MockWETH();
        tyr = new MockERC20("Tyrian", "TYR", 18);
        burner = new BuybackBurner(address(tyr), address(weth), owner);
        splitter = new FeeSplitter(address(weth), address(tyr), treasury, address(burner), owner);
        vm.stopPrank();
    }

    function test_WethSplit80_20() public {
        vm.deal(address(this), 1000 ether);
        weth.deposit{value: 1000 ether}();
        weth.transfer(address(splitter), 1000 ether);

        splitter.splitWeth();

        assertEq(weth.balanceOf(treasury), 800 ether, "treasury 80%");
        assertEq(weth.balanceOf(address(burner)), 200 ether, "burner 20%");
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(FeeSplitter.InvalidAddress.selector);
        new FeeSplitter(address(0), address(tyr), treasury, address(burner), owner);

        vm.expectRevert(FeeSplitter.InvalidAddress.selector);
        new FeeSplitter(address(weth), address(0), treasury, address(burner), owner);

        vm.expectRevert(FeeSplitter.InvalidAddress.selector);
        new FeeSplitter(address(weth), address(tyr), address(0), address(burner), owner);

        vm.expectRevert(FeeSplitter.InvalidAddress.selector);
        new FeeSplitter(address(weth), address(tyr), treasury, address(0), owner);
    }

    function test_SetRecipients() public {
        address newTreasury = address(0xF00D);
        address newBurner = address(0xBEEF);

        vm.expectEmit(true, true, false, false, address(splitter));
        emit FeeSplitter.AddressesUpdated(newTreasury, newBurner);

        vm.prank(owner);
        splitter.setRecipients(newTreasury, newBurner);

        assertEq(splitter.treasury(), newTreasury);
        assertEq(splitter.buybackBurner(), newBurner);

        vm.prank(owner);
        vm.expectRevert(FeeSplitter.InvalidAddress.selector);
        splitter.setRecipients(address(0), newBurner);

        vm.prank(owner);
        vm.expectRevert(FeeSplitter.InvalidAddress.selector);
        splitter.setRecipients(newTreasury, address(0));
    }

    function test_SplitWethAliasSplitsBalance() public {
        vm.deal(address(this), 100 ether);
        weth.deposit{value: 100 ether}();
        weth.transfer(address(splitter), 100 ether);

        splitter.split(address(weth));

        assertEq(weth.balanceOf(treasury), 80 ether, "treasury 80%");
        assertEq(weth.balanceOf(address(burner)), 20 ether, "burner 20%");
    }

    function test_TyrFeeIsBurned100Percent() public {
        tyr.mint(address(splitter), 1000 ether);

        vm.expectEmit(true, true, false, true, address(splitter));
        emit FeeSplitter.Burned(address(tyr), 1000 ether, BurnSource.FEE);

        splitter.burnTyr();

        assertEq(tyr.balanceOf(dead), 1000 ether, "TYR 100% burned");
        assertEq(tyr.balanceOf(treasury), 0, "treasury receives no TYR");
    }

    function test_TyrCannotBeSplit() public {
        tyr.mint(address(splitter), 1000 ether);
        vm.expectRevert(FeeSplitter.UnsupportedToken.selector);
        splitter.split(address(tyr));
    }

    function test_NativeEthWrappedToWeth() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(splitter).call{value: 1 ether}("");
        assertTrue(ok, "native transfer");
        assertEq(weth.balanceOf(address(splitter)), 1 ether, "wrapped");
    }

    function test_SetKeeperRejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(BuybackBurner.InvalidAddress.selector);
        burner.setKeeper(address(0));
    }

    function test_BuybackBurnSource() public {
        MockSwapRouterV3 router = new MockSwapRouterV3();
        vm.prank(owner);
        burner.setRouter(address(router), 3000);
        vm.prank(owner);
        burner.setKeeper(address(this));

        vm.deal(address(this), 1 ether);
        weth.deposit{value: 1 ether}();
        weth.transfer(address(burner), 1 ether);
        tyr.mint(address(router), 1 ether);

        vm.expectEmit(true, true, false, true, address(burner));
        emit BuybackBurner.Burned(address(tyr), 1 ether, BurnSource.BUYBACK);

        uint256 burned = burner.buybackAndBurn(1 ether, 1 ether, block.timestamp + 1);
        assertEq(burned, 1 ether, "burned output");
        assertEq(tyr.balanceOf(dead), 1 ether, "buyback burned");
    }
}
