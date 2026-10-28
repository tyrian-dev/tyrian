// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "../src/PortfolioVault.sol";
import "../src/oracles/StockPriceOracle.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockAggregatorV3.sol";
import "../src/mocks/MockSwapRouterV3.sol";

contract PortfolioVaultTest is Test {
    PortfolioVault public portfolio;
    MockERC20 public usdg;
    MockSwapRouterV3 public swapRouter;

    address[] internal tokens;
    address[] internal oracles;
    address[] internal feeds;

    address public owner = address(0xA11CE);
    address public keeper = address(0x1111);
    address public guardian = address(0x2222);
    address public stranger = address(0xB0B);

    uint256 public constant TREASURY_TOTAL = 10_000e18;
    uint256 public constant DCA_AMOUNT = 1000e18;

    function setUp() public {
        vm.warp(1_700_000_000);

        usdg = new MockERC20("Robinhood USDG", "USDG", 18);
        swapRouter = new MockSwapRouterV3();

        address[] memory tokenArgs = new address[](8);
        address[] memory oracleArgs = new address[](8);
        uint16[] memory weightArgs = new uint16[](8);

        for (uint256 i; i < 8; ++i) {
            MockERC20 token =
                new MockERC20(string.concat("Stock ", vm.toString(i)), string.concat("S", vm.toString(i)), 18);
            MockAggregatorV3 feed = new MockAggregatorV3(8, 1e8);
            StockPriceOracle oracle = new StockPriceOracle(address(token), address(feed), owner);

            tokens.push(address(token));
            oracles.push(address(oracle));
            feeds.push(address(feed));
            tokenArgs[i] = address(token);
            oracleArgs[i] = address(oracle);
            weightArgs[i] = 1250;

            // The 1:1 mock router pays stock tokens from its own balance.
            token.mint(address(swapRouter), 1_000_000e18);
        }

        portfolio = new PortfolioVault(address(usdg), owner);

        vm.startPrank(owner);
        portfolio.setTargets(tokenArgs, weightArgs, oracleArgs);
        portfolio.setRouter(address(swapRouter), 3000);
        portfolio.setTreasuryTotalUsd(TREASURY_TOTAL);
        portfolio.setDcaAmountUsd(DCA_AMOUNT);
        portfolio.setKeeper(keeper);
        portfolio.setGuardian(guardian);
        vm.stopPrank();

        usdg.mint(address(portfolio), 100_000e18);
        // The mock router needs USDG for the sell direction.
        usdg.mint(address(swapRouter), 1_000_000e18);
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    function test_SetTargetsStoresBasket() public view {
        assertEq(portfolio.targetCount(), 8);

        (uint8 decimals, uint16 weightBps, address oracle, bool found) = portfolio.targetOf(tokens[0]);

        assertTrue(found);
        assertEq(decimals, 18);
        assertEq(weightBps, 1250);
        assertEq(oracle, oracles[0]);

        (,,, bool missing) = portfolio.targetOf(address(0xDEAD));
        assertFalse(missing);
    }

    function test_SetTargetsRejectsBadWeightSum() public {
        uint16[] memory weights = _weights();
        weights[7] = 1000; // 9750 total

        vm.prank(owner);
        vm.expectRevert(PortfolioVault.InvalidTargets.selector);
        portfolio.setTargets(tokens, weights, oracles);
    }

    function test_SetTargetsRejectsMoreThanEight() public {
        address[] memory nineTokens = new address[](9);
        address[] memory nineOracles = new address[](9);
        uint16[] memory nineWeights = new uint16[](9);
        for (uint256 i; i < 9; ++i) {
            nineTokens[i] = address(new MockERC20("X", "X", 18));
            nineOracles[i] = oracles[0];
            nineWeights[i] = 1111;
        }

        vm.prank(owner);
        vm.expectRevert(PortfolioVault.InvalidTargets.selector);
        portfolio.setTargets(nineTokens, nineWeights, nineOracles);
    }

    function test_SetTargetsRejectsDuplicateToken() public {
        address[] memory dupTokens = new address[](2);
        address[] memory dupOracles = new address[](2);
        uint16[] memory weights = new uint16[](2);
        dupTokens[0] = tokens[0];
        dupTokens[1] = tokens[0];
        dupOracles[0] = oracles[0];
        dupOracles[1] = oracles[1];
        weights[0] = 5000;
        weights[1] = 5000;

        vm.prank(owner);
        vm.expectRevert(PortfolioVault.InvalidTargets.selector);
        portfolio.setTargets(dupTokens, weights, dupOracles);
    }

    function test_SetTargetsRejectsZeroWeight() public {
        uint16[] memory weights = _weights();
        weights[0] = 0;

        vm.prank(owner);
        vm.expectRevert(PortfolioVault.InvalidTargets.selector);
        portfolio.setTargets(tokens, weights, oracles);
    }

    function test_SetTargetsRejectsZeroOracle() public {
        address[] memory oracleArgs = _oracles();
        oracleArgs[0] = address(0);

        vm.prank(owner);
        vm.expectRevert(PortfolioVault.InvalidTargets.selector);
        portfolio.setTargets(tokens, _weights(), oracleArgs);
    }

    function test_SetTargetsRejectsNonContractOracle() public {
        address[] memory oracleArgs = _oracles();
        oracleArgs[0] = address(0xBEEF);

        vm.prank(owner);
        vm.expectRevert(PortfolioVault.InvalidTargets.selector);
        portfolio.setTargets(tokens, _weights(), oracleArgs);
    }

    function test_SetTargetsRejectsOracleForDifferentToken() public {
        address[] memory oracleArgs = _oracles();
        // oracles[1] tracks tokens[1], not tokens[0].
        oracleArgs[0] = oracles[1];

        vm.prank(owner);
        vm.expectRevert(PortfolioVault.OracleTokenMismatch.selector);
        portfolio.setTargets(tokens, _weights(), oracleArgs);
    }

    function test_SetTargetsOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        portfolio.setTargets(tokens, _weights(), oracles);
    }

    function test_SetTargetsRejectsRemovingTokenWithBalance() public {
        _buy(tokens[0], 100e18, 99e18);

        address[] memory twoTokens = new address[](2);
        address[] memory twoOracles = new address[](2);
        uint16[] memory twoWeights = new uint16[](2);
        twoTokens[0] = tokens[1];
        twoTokens[1] = tokens[2];
        twoOracles[0] = oracles[1];
        twoOracles[1] = oracles[2];
        twoWeights[0] = 5000;
        twoWeights[1] = 5000;

        vm.prank(owner);
        vm.expectRevert(PortfolioVault.TargetHasBalance.selector);
        portfolio.setTargets(twoTokens, twoWeights, twoOracles);

        // Sell first, then the basket can be replaced.
        vm.prank(owner);
        portfolio.sell(tokens[0], 100e18, 99e18, block.timestamp);

        vm.prank(owner);
        portfolio.setTargets(twoTokens, twoWeights, twoOracles);

        assertEq(portfolio.targetCount(), 2);
    }

    function test_TreasuryTotalOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        portfolio.setTreasuryTotalUsd(1);

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit PortfolioVault.TreasuryTotalUpdated(TREASURY_TOTAL, 20_000e18);
        portfolio.setTreasuryTotalUsd(20_000e18);

        assertEq(portfolio.portfolioCapUsd(), 4000e18);
    }

    // ---------------------------------------------------------------------
    // Valuation
    // ---------------------------------------------------------------------

    function test_PortfolioValueTracksOracle() public {
        _buy(tokens[0], 1000e18, 990e18);
        assertEq(portfolio.portfolioValueUsd(), 1000e18);

        MockAggregatorV3(feeds[0]).setPrice(2e8);
        assertEq(portfolio.portfolioValueUsd(), 2000e18);
    }

    function test_PortfolioCapIsTwentyPercent() public view {
        assertEq(portfolio.portfolioCapUsd(), 2000e18);
    }

    // ---------------------------------------------------------------------
    // Buy
    // ---------------------------------------------------------------------

    function test_BuyExecutesAndUpdatesValue() public {
        vm.expectEmit(true, false, false, true);
        emit PortfolioVault.Bought(tokens[0], 1000e18, 1000e18);

        uint256 tokenOut = _buy(tokens[0], 1000e18, 990e18);

        assertEq(tokenOut, 1000e18);
        assertEq(MockERC20(tokens[0]).balanceOf(address(portfolio)), 1000e18);
        assertEq(portfolio.portfolioValueUsd(), 1000e18);
        assertEq(portfolio.lastBuyAt(), block.timestamp);
    }

    function test_BuyEnforcesDcaInterval() public {
        _buy(tokens[0], 100e18, 99e18);

        vm.prank(keeper);
        vm.expectRevert(PortfolioVault.DcaNotDue.selector);
        portfolio.buy(tokens[0], 100e18, 99e18, block.timestamp);

        vm.warp(block.timestamp + 7 days);
        _refreshFeeds();

        _buy(tokens[0], 100e18, 99e18);
    }

    function test_BuyEnforcesDcaAmount() public {
        vm.prank(keeper);
        vm.expectRevert(PortfolioVault.DcaAmountExceeded.selector);
        portfolio.buy(tokens[0], 1001e18, 991e18, block.timestamp);
    }

    function test_BuyEnforcesPortfolioCap() public {
        vm.prank(owner);
        portfolio.setTreasuryTotalUsd(2000e18); // cap 400 USD

        vm.prank(keeper);
        vm.expectRevert(PortfolioVault.PortfolioCapExceeded.selector);
        portfolio.buy(tokens[0], 401e18, 397e18, block.timestamp);

        _buy(tokens[0], 400e18, 396e18);
        assertEq(portfolio.portfolioValueUsd(), 400e18);
    }

    function test_BuyEnforcesSlippageBound() public {
        vm.prank(keeper);
        vm.expectRevert(PortfolioVault.SlippageTooHigh.selector);
        portfolio.buy(tokens[0], 1000e18, 989e18, block.timestamp);
    }

    function test_BuyRejectsNonKeeper() public {
        vm.prank(stranger);
        vm.expectRevert(PortfolioVault.NotKeeper.selector);
        portfolio.buy(tokens[0], 100e18, 99e18, block.timestamp);
    }

    function test_BuyRejectsUnknownToken() public {
        vm.prank(keeper);
        vm.expectRevert(PortfolioVault.TargetNotFound.selector);
        portfolio.buy(address(0xDEAD), 100e18, 99e18, block.timestamp);
    }

    function test_BuyRejectsStaleOracle() public {
        MockAggregatorV3(feeds[0]).setUpdatedAt(block.timestamp - 96 hours - 1);

        vm.prank(keeper);
        vm.expectRevert(StockPriceOracle.StalePrice.selector);
        portfolio.buy(tokens[0], 100e18, 99e18, block.timestamp);
    }

    function test_BuyRejectsWhenTreasuryNotSet() public {
        vm.prank(owner);
        portfolio.setTreasuryTotalUsd(0);

        vm.prank(keeper);
        vm.expectRevert(PortfolioVault.TreasuryNotSet.selector);
        portfolio.buy(tokens[0], 100e18, 99e18, block.timestamp);
    }

    function test_BuyRejectsWhenDcaDisabled() public {
        vm.prank(owner);
        portfolio.setDcaAmountUsd(0);

        vm.prank(keeper);
        vm.expectRevert(PortfolioVault.DcaDisabled.selector);
        portfolio.buy(tokens[0], 100e18, 99e18, block.timestamp);
    }

    function test_BuyRejectsUnconfiguredRouter() public {
        vm.prank(owner);
        portfolio.setRouter(address(0), 0);

        vm.prank(keeper);
        vm.expectRevert(PortfolioVault.RouterNotConfigured.selector);
        portfolio.buy(tokens[0], 100e18, 99e18, block.timestamp);
    }

    function test_BuyRejectsPastDeadline() public {
        vm.prank(keeper);
        vm.expectRevert(PortfolioVault.InvalidDeadline.selector);
        portfolio.buy(tokens[0], 100e18, 99e18, block.timestamp - 1);
    }

    // ---------------------------------------------------------------------
    // Sell
    // ---------------------------------------------------------------------

    function test_SellSendsProceedsToOwner() public {
        _buy(tokens[0], 400e18, 396e18);

        uint256 ownerBefore = usdg.balanceOf(owner);

        vm.prank(owner);
        uint256 usdgOut = portfolio.sell(tokens[0], 400e18, 396e18, block.timestamp);

        assertEq(usdgOut, 400e18);
        assertEq(usdg.balanceOf(owner), ownerBefore + 400e18);
        assertEq(MockERC20(tokens[0]).balanceOf(address(portfolio)), 0);
        assertEq(portfolio.portfolioValueUsd(), 0);
    }

    function test_TreasuryDefaultsToInitialOwner() public view {
        assertEq(portfolio.treasury(), owner);
    }

    function test_SetTreasuryUpdatesRecipient() public {
        address newTreasury = makeAddr("treasurySafe");

        vm.expectEmit(true, true, false, false, address(portfolio));
        emit PortfolioVault.TreasuryUpdated(owner, newTreasury);

        vm.prank(owner);
        portfolio.setTreasury(newTreasury);

        assertEq(portfolio.treasury(), newTreasury);
    }

    function test_SetTreasuryRejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(PortfolioVault.InvalidAddress.selector);
        portfolio.setTreasury(address(0));
    }

    function test_SellSendsProceedsToTreasuryNotOwner() public {
        address treasury = makeAddr("treasurySafe");
        vm.prank(owner);
        portfolio.setTreasury(treasury);

        _buy(tokens[0], 400e18, 396e18);

        uint256 ownerBefore = usdg.balanceOf(owner);

        vm.prank(owner);
        uint256 usdgOut = portfolio.sell(tokens[0], 400e18, 396e18, block.timestamp);

        assertEq(usdgOut, 400e18);
        assertEq(usdg.balanceOf(treasury), 400e18);
        assertEq(usdg.balanceOf(owner), ownerBefore);
        assertEq(MockERC20(tokens[0]).balanceOf(address(portfolio)), 0);
    }

    function test_TargetAtAndKeptTargetWithBalance() public {
        _buy(tokens[0], 400e18, 396e18);

        // tokens[0] keeps a balance, so it must stay in the new basket.
        address[] memory newTokens = new address[](2);
        address[] memory newOracles = new address[](2);
        uint16[] memory newWeights = new uint16[](2);
        newTokens[0] = tokens[0];
        newTokens[1] = tokens[1];
        newOracles[0] = oracles[0];
        newOracles[1] = oracles[1];
        newWeights[0] = 5000;
        newWeights[1] = 5000;

        vm.prank(owner);
        portfolio.setTargets(newTokens, newWeights, newOracles);

        (address token, uint8 decimals, uint16 weightBps, address oracle) = portfolio.targetAt(0);
        assertEq(token, tokens[0], "kept token stays");
        assertEq(decimals, 18);
        assertEq(weightBps, 5000);
        assertEq(oracle, oracles[0]);
        assertEq(portfolio.targetCount(), 2);
    }

    function test_SellOnlyOwner() public {
        _buy(tokens[0], 400e18, 396e18);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        portfolio.sell(tokens[0], 100e18, 99e18, block.timestamp);
    }

    function test_SellEnforcesSlippageBound() public {
        _buy(tokens[0], 400e18, 396e18);

        vm.prank(owner);
        vm.expectRevert(PortfolioVault.SlippageTooHigh.selector);
        portfolio.sell(tokens[0], 400e18, 395e18, block.timestamp);
    }

    function test_SellRejectsPastDeadline() public {
        vm.prank(owner);
        vm.expectRevert(PortfolioVault.InvalidDeadline.selector);
        portfolio.sell(tokens[0], 1e18, 0, block.timestamp - 1);
    }

    // ---------------------------------------------------------------------
    // Pause
    // ---------------------------------------------------------------------

    function test_PauseBlocksBuyButNotSell() public {
        _buy(tokens[0], 400e18, 396e18);

        vm.prank(guardian);
        portfolio.pause();

        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        portfolio.buy(tokens[1], 100e18, 99e18, block.timestamp);

        vm.prank(owner);
        portfolio.sell(tokens[0], 100e18, 99e18, block.timestamp);

        vm.prank(owner);
        portfolio.unpause();

        vm.warp(block.timestamp + 7 days);
        _refreshFeeds();

        _buy(tokens[1], 100e18, 99e18);
    }

    function test_PauseOnlyGuardian() public {
        vm.prank(stranger);
        vm.expectRevert(PortfolioVault.NotGuardian.selector);
        portfolio.pause();
    }

    function test_OnlyOwnerCanUnpause() public {
        vm.prank(guardian);
        portfolio.pause();

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        portfolio.unpause();
    }

    // ---------------------------------------------------------------------
    // Cost Basis (GAP-011 / Brief §7)
    // ---------------------------------------------------------------------

    function test_BuyTracksCostBasisAndAvgPrice() public {
        // Initial cost basis should be 0
        assertEq(portfolio.totalCostUsdg(tokens[0]), 0);
        assertEq(portfolio.totalTokensBought(tokens[0]), 0);
        assertEq(portfolio.getAvgCostUsd(tokens[0]), 0);

        // First buy: 200 USDG for 200 tokens (mock feed is 1:1, $1/token)
        _buy(tokens[0], 200e18, 198e18);

        assertEq(portfolio.totalCostUsdg(tokens[0]), 200e18);
        assertEq(portfolio.totalTokensBought(tokens[0]), 200e18);
        assertEq(portfolio.getAvgCostUsd(tokens[0]), 1e18); // $1 per token

        // Fast-forward 7 days for next DCA buy
        vm.warp(block.timestamp + 7 days);
        _refreshFeeds();

        // Second buy: 400 USDG for 400 tokens
        _buy(tokens[0], 400e18, 396e18);

        assertEq(portfolio.totalCostUsdg(tokens[0]), 600e18);
        assertEq(portfolio.totalTokensBought(tokens[0]), 600e18);
        assertEq(portfolio.getAvgCostUsd(tokens[0]), 1e18);

        (uint256 cumCost, uint256 cumBought, uint256 avgCost) = portfolio.getCostBasis(tokens[0]);
        assertEq(cumCost, 600e18);
        assertEq(cumBought, 600e18);
        assertEq(avgCost, 1e18);
    }

    function test_SellReducesCostBasisProRata() public {
        _buy(tokens[0], 400e18, 396e18);

        assertEq(portfolio.totalCostUsdg(tokens[0]), 400e18);
        assertEq(portfolio.totalTokensBought(tokens[0]), 400e18);

        // Sell half (200 tokens)
        vm.prank(owner);
        portfolio.sell(tokens[0], 200e18, 198e18, block.timestamp);

        // Remaining cost basis should be reduced by 50%
        assertEq(portfolio.totalCostUsdg(tokens[0]), 200e18);
        assertEq(portfolio.totalTokensBought(tokens[0]), 200e18);
        assertEq(portfolio.getAvgCostUsd(tokens[0]), 1e18);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _buy(address token, uint256 usdgAmount, uint256 minTokenOut) internal returns (uint256 tokenOut) {
        vm.prank(keeper);
        tokenOut = portfolio.buy(token, usdgAmount, minTokenOut, block.timestamp);
    }

    function _refreshFeeds() internal {
        for (uint256 i; i < feeds.length; ++i) {
            MockAggregatorV3(feeds[i]).setPrice(1e8);
        }
    }

    function _weights() internal pure returns (uint16[] memory weights) {
        weights = new uint16[](8);
        for (uint256 i; i < 8; ++i) {
            weights[i] = 1250;
        }
    }

    function _oracles() internal view returns (address[] memory oracleArgs) {
        oracleArgs = new address[](8);
        for (uint256 i; i < 8; ++i) {
            oracleArgs[i] = oracles[i];
        }
    }
}
