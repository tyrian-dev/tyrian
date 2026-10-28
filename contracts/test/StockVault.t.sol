// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/vaults/PrincipalVault.sol";
import "../src/vaults/StockVault.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockAggregatorV3.sol";

contract StockVaultTest is Test {
    StockVault public vault;
    MockERC20 public tsla;
    MockAggregatorV3 public tslaFeed;

    address public owner = address(0xA11CE);
    address public treasury = address(0xCAFE);
    address public user = address(0x1111);

    uint256 public constant CAP = 1_000_000 ether;

    function setUp() public {
        vm.startPrank(owner);

        tsla = new MockERC20("Tesla Tokenized Stock", "TSLA", 18);
        tslaFeed = new MockAggregatorV3(8, 250_00000000);
        vault = new StockVault(address(tsla), "TSLA", address(tslaFeed), CAP, treasury, address(this), owner);

        vm.stopPrank();

        tsla.mint(address(this), 10_000 ether);
        tsla.approve(address(vault), type(uint256).max);
    }

    function test_GetLatestPriceAndUsdValue() public view {
        (uint256 price, uint8 decimals) = vault.getLatestPrice(address(tsla));
        assertEq(price, 250_00000000);
        assertEq(decimals, 8);

        uint256 usdValue = vault.getUsdValue(address(tsla), 2 ether);
        assertEq(usdValue, 500 ether, "USD value must equal $500");
    }

    function test_StalePriceRejection() public {
        vm.warp(block.timestamp + 97 hours);

        vm.expectRevert(StockVault.StalePrice.selector);
        vault.getLatestPrice(address(tsla));
    }

    function test_InvalidAndNegativePriceRejected() public {
        tslaFeed.setPrice(0);
        vm.expectRevert(StockVault.InvalidPrice.selector);
        vault.getLatestPrice(address(tsla));

        tslaFeed.setPrice(-1);
        vm.expectRevert(StockVault.InvalidPrice.selector);
        vault.getLatestPrice(address(tsla));
    }

    function test_DepositAndRedeemSameToken() public {
        uint256 shares = vault.depositFor(user, 100 ether);
        assertEq(shares, 100 ether, "shares");
        assertEq(vault.sharesOf(user), 100 ether, "user shares");
        assertEq(tsla.balanceOf(address(vault)), 100 ether, "vault custody");

        uint256 amount = vault.redeemFor(user, shares);
        assertEq(amount, 100 ether, "same token amount");
        assertEq(tsla.balanceOf(user), 100 ether, "user received TSLA");
        assertEq(vault.totalPrincipal(), 0, "principal cleared");
    }

    function test_DepositCapEnforced() public {
        vm.expectRevert(StockVault.DepositCapExceeded.selector);
        vault.depositFor(user, CAP + 1);
    }

    function test_ConstructorRejectsInvalidConfig() public {
        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        new StockVault(address(tsla), "TSLA", address(0), CAP, treasury, address(this), owner);

        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        new StockVault(address(tsla), "TSLA", address(tslaFeed), 0, treasury, address(this), owner);
    }

    function test_OnlyAssetTokenIsAllowed() public {
        MockERC20 other = new MockERC20("Other", "OTR", 18);

        vm.expectRevert(StockVault.StockNotAllowed.selector);
        vault.getLatestPrice(address(other));

        vm.expectRevert(StockVault.StockNotAllowed.selector);
        vault.getUsdValue(address(other), 1 ether);
    }

    function test_FutureAndZeroUpdatedAtRejected() public {
        tslaFeed.setUpdatedAt(block.timestamp + 1);
        vm.expectRevert(StockVault.InvalidPrice.selector);
        vault.getLatestPrice(address(tsla));

        tslaFeed.setUpdatedAt(0);
        vm.expectRevert(StockVault.InvalidPrice.selector);
        vault.getLatestPrice(address(tsla));
    }

    function test_SetDepositCap() public {
        vm.prank(owner);
        vault.setDepositCap(500 ether);
        assertEq(vault.depositCap(), 500 ether);

        vm.prank(owner);
        vm.expectRevert(StockVault.InvalidCap.selector);
        vault.setDepositCap(0);
    }

    function test_SetPriceFeed() public {
        MockAggregatorV3 newFeed = new MockAggregatorV3(8, 300_00000000);

        vm.expectEmit(true, true, false, false, address(vault));
        emit StockVault.PriceFeedUpdated(address(tslaFeed), address(newFeed));

        vm.prank(owner);
        vault.setPriceFeed(address(newFeed));
        assertEq(vault.priceFeed(), address(newFeed));

        (uint256 price,) = vault.getLatestPrice(address(tsla));
        assertEq(price, 300_00000000, "new feed is used");

        vm.prank(owner);
        vm.expectRevert(PrincipalVault.InvalidAddress.selector);
        vault.setPriceFeed(address(0));
    }

    function test_SetMaxStalePeriod() public {
        vm.prank(owner);
        vault.setMaxStalePeriod(1 hours);
        assertEq(vault.maxStalePeriod(), 1 hours);

        vm.prank(owner);
        vm.expectRevert(StockVault.InvalidStalePeriod.selector);
        vault.setMaxStalePeriod(0);

        vm.prank(owner);
        vm.expectRevert(StockVault.InvalidStalePeriod.selector);
        vault.setMaxStalePeriod(8 days);
    }

    function test_DepositAtCapBoundary() public {
        vm.prank(owner);
        vault.setDepositCap(100 ether);

        vault.depositFor(user, 100 ether);
        assertEq(vault.totalPrincipal(), 100 ether);

        vm.expectRevert(StockVault.DepositCapExceeded.selector);
        vault.depositFor(user, 1);
    }

    function test_DisableStockBlocksDepositButNotRedeem() public {
        vault.depositFor(user, 100 ether);

        vm.prank(owner);
        vault.setStockEnabled(false);

        vm.expectRevert(StockVault.StockNotAllowed.selector);
        vault.depositFor(user, 1 ether);

        uint256 amount = vault.redeemFor(user, 100 ether);
        assertEq(amount, 100 ether, "redeem remains available");
    }
}
