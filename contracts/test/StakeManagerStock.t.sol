// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/StakeManager.sol";
import "../src/vaults/StockVault.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockAggregatorV3.sol";

contract StakeManagerStockTest is Test {
    StakeManager public stakeManager;
    StockVault public stockVault;
    MockERC20 public aapl;
    MockAggregatorV3 public aaplFeed;

    address public owner = address(0xA11CE);
    address public treasury = address(0xCAFE);
    address public user = address(0x1111);

    uint256 public constant CAP = 100_000 ether; // 100,000 shares
    uint256 public constant AAPL_PRICE = 200_00000000; // $200.00 (8 decimals)

    function setUp() public {
        vm.startPrank(owner);

        stakeManager = new StakeManager(owner);
        aapl = new MockERC20("Apple Tokenized Stock", "AAPL", 18);
        aaplFeed = new MockAggregatorV3(8, int256(AAPL_PRICE));

        stockVault = new StockVault(
            address(aapl),
            "AAPL",
            address(aaplFeed),
            CAP,
            treasury,
            address(stakeManager),
            owner
        );

        stakeManager.setAssetConfig(
            address(aapl),
            true,
            StakeManager.AssetKind.STOCK,
            address(stockVault),
            address(aaplFeed),
            CAP
        );

        aapl.mint(user, 1_000 ether);

        vm.stopPrank();
    }

    function test_StockStakingCustodyAndValuation() public {
        vm.startPrank(user);
        aapl.approve(address(stakeManager), 50 ether);
        stakeManager.stake(address(aapl), 50 ether);
        vm.stopPrank();

        // 1. Vault holds the stock assets, StakeManager does not hold assets
        assertEq(aapl.balanceOf(address(stockVault)), 50 ether, "vault holds custody of stock token");
        assertEq(aapl.balanceOf(address(stakeManager)), 0, "StakeManager holds 0 tokens");
        assertEq(stockVault.sharesOf(user), 50 ether, "vault records user shares");

        // 2. Oracle valuation ($200 per AAPL * 50 = $10,000 USD)
        uint256 usdValue = stockVault.getUsdValue(address(aapl), 50 ether);
        assertEq(usdValue, 10_000 ether, "USD valuation must be $10,000");

        // 3. Epoch rollover: pending becomes active
        (uint256 active, uint256 pending,,) = stakeManager.getEffectivePosition(user, address(aapl));
        assertEq(active, 0, "pending on day 0");
        assertEq(pending, 50 ether, "pending 50 shares");

        vm.warp(block.timestamp + 1 days + 1);

        (active, pending,,) = stakeManager.getEffectivePosition(user, address(aapl));
        assertEq(active, 50 ether, "active after epoch");
        assertEq(pending, 0, "pending cleared");
    }

    function test_StockUnstakeAndWithdrawalFlow() public {
        vm.startPrank(user);
        aapl.approve(address(stakeManager), 50 ether);
        stakeManager.stake(address(aapl), 50 ether);

        // Epoch rollover
        vm.warp(block.timestamp + 1 days + 1);

        // Request unstake
        uint256 requestId = stakeManager.requestUnstake(address(aapl), 50 ether);
        assertEq(requestId, 1);

        // Wait cooldown (7 days)
        vm.warp(block.timestamp + 7 days + 1);

        // Withdraw
        stakeManager.withdraw(address(aapl), requestId);
        vm.stopPrank();

        // User got exactly 50 AAPL back
        assertEq(aapl.balanceOf(user), 1_000 ether, "user recovered full stock token balance");
        assertEq(aapl.balanceOf(address(stockVault)), 0, "vault stock balance emptied");
        assertEq(stockVault.totalPrincipal(), 0, "vault principal cleared");
    }

    function test_DisabledStockBlocksNewDepositButAllowsWithdraw() public {
        vm.startPrank(user);
        aapl.approve(address(stakeManager), 50 ether);
        stakeManager.stake(address(aapl), 50 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days + 1);

        // Owner disables the stock vault
        vm.prank(owner);
        stockVault.setStockEnabled(false);

        // New deposits revert
        vm.startPrank(user);
        aapl.approve(address(stakeManager), 10 ether);
        vm.expectRevert(StockVault.StockNotAllowed.selector);
        stakeManager.stake(address(aapl), 10 ether);

        // But user can still unstake and withdraw (fail-safe exit guarantee)
        uint256 requestId = stakeManager.requestUnstake(address(aapl), 50 ether);
        vm.warp(block.timestamp + 7 days + 1);
        stakeManager.withdraw(address(aapl), requestId);
        vm.stopPrank();

        assertEq(aapl.balanceOf(user), 1_000 ether, "user exit succeeded despite stock disabled");
    }

    function test_StaleOracleRejection() public {
        // Warp past 96 hours stale limit
        vm.warp(block.timestamp + 97 hours);

        vm.expectRevert(StockVault.StalePrice.selector);
        stockVault.getLatestPrice(address(aapl));
    }
}
