// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../script/VerifyMainnet.s.sol";
import "../script/lib/MainnetGuards.sol";
import "../script/lib/Ownership.sol";
import "../src/StakeManager.sol";
import "../src/FeeSplitter.sol";
import "../src/BuybackBurner.sol";
import "../src/TreasuryRouter.sol";
import "../src/PortfolioVault.sol";
import "../src/vaults/UsdgVault.sol";
import "../src/vaults/StockVault.sol";
import "../src/oracles/StockPriceOracle.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockWETH.sol";
import "../src/mocks/MockAggregatorV3.sol";

contract MockTimelockContract is Ownable2Step {
    uint256 internal minDelay = 48 hours;

    constructor() Ownable(msg.sender) {}

    function acceptTargetOwnership(address target) external {
        Ownable2Step(target).acceptOwnership();
    }

    function getMinDelay() external view returns (uint256) {
        return minDelay;
    }

    function setMinDelay(uint256 newDelay) external {
        minDelay = newDelay;
    }
}

contract MockSafeContract {
    uint256 internal threshold = 2;
    address[] internal safeOwners;

    constructor() {
        safeOwners.push(address(0xA11CE));
        safeOwners.push(address(0xB0B));
        safeOwners.push(address(0xCA401));
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return safeOwners;
    }

    function setThreshold(uint256 newThreshold) external {
        threshold = newThreshold;
    }
}

/**
 * @notice Full mainnet rehearsal.
 *
 * The previous version only deployed and handed over four core contracts, which
 * is exactly why the missing `TreasuryRouter` / `PortfolioVault` / oracle
 * handovers went unnoticed. This version deploys the whole stack, runs the real
 * `Ownership.transferAll`, and then runs `VerifyMainnet` against it.
 *
 * `VerifyMainnet.verify()` takes an explicit struct instead of reading env, so
 * these tests never mutate process-wide env vars. That matters because
 * `vm.setEnv` is global and leaks across parallel test threads.
 */
contract MainnetRehearsalTest is Test {
    uint256 internal constant MAINNET_CHAIN_ID = 4663;
    address internal constant KEEPER = address(0xBEEF);
    uint256 internal constant STOCK_CAP = 1_000_000e18;

    address internal deployer = address(0xD391);

    MockERC20 internal usdg;
    MockERC20 internal tyr;
    MockERC20 internal stockToken;
    MockWETH internal weth;
    MockAggregatorV3 internal stockFeed;

    MockTimelockContract internal timelock;
    MockSafeContract internal treasurySafe;
    MockSafeContract internal budgetSafe;
    MockSafeContract internal reserveSafe;
    MockSafeContract internal dexRouter;

    StakeManager internal stakeManager;
    UsdgVault internal usdgVault;
    FeeSplitter internal feeSplitter;
    BuybackBurner internal burner;
    TreasuryRouter internal router;
    PortfolioVault internal portfolio;
    StockVault internal stockVault;
    StockPriceOracle internal stockOracle;

    VerifyMainnetScript internal verifier;

    address[] internal targets;

    function setUp() public {
        vm.chainId(MAINNET_CHAIN_ID);

        usdg = new MockERC20("USDG", "USDG", 18);
        tyr = new MockERC20("Tyrian", "TYR", 18);
        stockToken = new MockERC20("Apple", "AAPL", 18);
        weth = new MockWETH();
        stockFeed = new MockAggregatorV3(8, 255e8);

        timelock = new MockTimelockContract();
        treasurySafe = new MockSafeContract();
        budgetSafe = new MockSafeContract();
        reserveSafe = new MockSafeContract();
        dexRouter = new MockSafeContract();
        verifier = new VerifyMainnetScript();

        vm.startPrank(deployer);

        stakeManager = new StakeManager(deployer);
        usdgVault = new UsdgVault(address(usdg), address(treasurySafe), address(stakeManager), deployer);
        burner = new BuybackBurner(address(tyr), address(weth), deployer);
        feeSplitter = new FeeSplitter(address(weth), address(tyr), address(treasurySafe), address(burner), deployer);
        router = new TreasuryRouter(address(usdg), address(weth), deployer);
        portfolio = new PortfolioVault(address(usdg), deployer);
        stockVault = new StockVault(
            address(stockToken),
            "AAPL",
            address(stockFeed),
            STOCK_CAP,
            address(treasurySafe),
            address(stakeManager),
            deployer
        );
        stockOracle = new StockPriceOracle(address(stockToken), address(stockFeed), deployer);

        // Deployment-time wiring, still under the deployer key.
        router.setRecipients(address(budgetSafe), address(reserveSafe), address(portfolio));
        router.setKeeper(KEEPER);
        router.setRouter(address(dexRouter), 3000);
        portfolio.setKeeper(KEEPER);
        portfolio.setRouter(address(dexRouter), 3000);
        portfolio.setTreasury(address(treasurySafe));
        burner.setRouter(address(dexRouter), 3000);
        burner.setKeeper(KEEPER);

        stakeManager.setAssetConfig(address(usdg), true, StakeManager.AssetKind.BASE, address(usdgVault), address(0), 0);
        stakeManager.setAssetConfig(
            address(stockToken), true, StakeManager.AssetKind.STOCK, address(stockVault), address(stockFeed), STOCK_CAP
        );
        vm.stopPrank();

        targets = new address[](8);
        targets[0] = address(stakeManager);
        targets[1] = address(usdgVault);
        targets[2] = address(feeSplitter);
        targets[3] = address(burner);
        targets[4] = address(router);
        targets[5] = address(portfolio);
        targets[6] = address(stockVault);
        targets[7] = address(stockOracle);

        _handover(targets);
    }

    function _handover(address[] memory list) internal {
        vm.startPrank(deployer);
        Ownership.transferAll(list, address(timelock), deployer);
        vm.stopPrank();

        for (uint256 i; i < list.length; ++i) {
            timelock.acceptTargetOwnership(list[i]);
        }
    }

    function _validInput() internal view returns (VerifyMainnetScript.Input memory input) {
        input.expectedChainId = MAINNET_CHAIN_ID;
        input.timelock = address(timelock);
        input.treasury = address(treasurySafe);
        input.stakeManager = address(stakeManager);
        input.usdgVault = address(usdgVault);
        input.usdg = address(usdg);
        input.feeSplitter = address(feeSplitter);
        input.burner = address(burner);
        input.router = address(router);
        input.portfolio = address(portfolio);
        input.budget = address(budgetSafe);
        input.reserve = address(reserveSafe);
        input.tyrOracle = address(0);

        input.stockVaults = new address[](1);
        input.stockTokens = new address[](1);
        input.stockFeeds = new address[](1);
        input.stockOracles = new address[](1);
        input.stockVaults[0] = address(stockVault);
        input.stockTokens[0] = address(stockToken);
        input.stockFeeds[0] = address(stockFeed);
        input.stockOracles[0] = address(stockOracle);

        input.minSafeThreshold = 2;
        input.minSafeOwners = 3;
        input.minTimelockDelay = 48 hours;
    }

    /// @dev External wrapper so `expectRevert` on library-internal calls sees a
    /// call boundary.
    function callTransferAll(address[] memory list, address timelock_, address deployer_) external {
        Ownership.transferAll(list, timelock_, deployer_);
    }

    // ---------------------------------------------------------------------
    // Happy path
    // ---------------------------------------------------------------------

    function test_MainnetRehearsalFullLifecycleAndVerification() public view {
        verifier.verify(_validInput());
    }

    function test_RehearsalHandsOverEveryContract() public view {
        address[] memory current = Ownership.owners(targets);
        for (uint256 i; i < current.length; ++i) {
            assertEq(current[i], address(timelock), "contract not owned by timelock");
        }
    }

    /// @dev Regression: the four treasury/oracle contracts used to be skipped.
    function test_RehearsalCoversTreasuryAndOracleOwnership() public view {
        assertEq(router.owner(), address(timelock), "TreasuryRouter not handed over");
        assertEq(portfolio.owner(), address(timelock), "PortfolioVault not handed over");
        assertEq(stockOracle.owner(), address(timelock), "StockPriceOracle not handed over");
    }

    // ---------------------------------------------------------------------
    // Ownership library
    // ---------------------------------------------------------------------

    function test_TransferAllIsIdempotent() public {
        // A second run must skip targets that already belong to the timelock.
        vm.startPrank(deployer);
        Ownership.transferAll(targets, address(timelock), deployer);
        vm.stopPrank();

        address[] memory current = Ownership.owners(targets);
        for (uint256 i; i < current.length; ++i) {
            assertEq(current[i], address(timelock));
        }
    }

    function test_TransferAllRejectsEoaTimelock() public {
        address eoa = makeAddr("eoaTimelock");
        vm.expectRevert(Ownership.TimelockMustBeContract.selector);
        this.callTransferAll(targets, eoa, deployer);
    }

    function test_TransferAllRejectsEoaTarget() public {
        address[] memory list = new address[](1);
        list[0] = address(0x1234);

        vm.expectRevert(abi.encodeWithSelector(Ownership.NotContract.selector, address(0x1234)));
        this.callTransferAll(list, address(timelock), deployer);
    }

    function test_TransferAllRejectsUnexpectedOwner() public {
        vm.prank(deployer);
        StakeManager foreign = new StakeManager(address(0xF0E1));

        address[] memory list = new address[](1);
        list[0] = address(foreign);

        vm.expectRevert(
            abi.encodeWithSelector(Ownership.UnexpectedOwner.selector, address(foreign), address(0xF0E1), deployer)
        );
        this.callTransferAll(list, address(timelock), deployer);
    }

    // ---------------------------------------------------------------------
    // VerifyMainnet negative cases
    // ---------------------------------------------------------------------

    function test_VerifyMainnetRejectsWrongChain() public {
        VerifyMainnetScript.Input memory input = _validInput();
        input.expectedChainId = 1;

        vm.expectRevert("wrong chain");
        verifier.verify(input);
    }

    function test_VerifyMainnetRejectsEoaTimelock() public {
        VerifyMainnetScript.Input memory input = _validInput();
        input.timelock = makeAddr("eoaTimelock");

        vm.expectRevert("not a contract");
        verifier.verify(input);
    }

    function test_VerifyMainnetRejectsUnacceptedOwnership() public {
        vm.prank(deployer);
        StakeManager unacceptedMgr = new StakeManager(deployer);

        VerifyMainnetScript.Input memory input = _validInput();
        input.stakeManager = address(unacceptedMgr);

        vm.expectRevert("StakeManager owner");
        verifier.verify(input);
    }

    function test_VerifyMainnetRejectsTreasuryMismatch() public {
        VerifyMainnetScript.Input memory input = _validInput();
        input.treasury = address(new MockSafeContract());

        vm.expectRevert("portfolio treasury mismatch");
        verifier.verify(input);
    }

    function test_VerifyMainnetRejectsEoaOwnedTreasuryRouter() public {
        vm.prank(deployer);
        TreasuryRouter strayRouter = new TreasuryRouter(address(usdg), address(weth), deployer);
        vm.prank(deployer);
        strayRouter.setRecipients(address(budgetSafe), address(reserveSafe), address(portfolio));

        VerifyMainnetScript.Input memory input = _validInput();
        input.router = address(strayRouter);

        vm.expectRevert("TreasuryRouter owner");
        verifier.verify(input);
    }

    function test_VerifyMainnetRejectsEoaOwnedPortfolioVault() public {
        vm.prank(deployer);
        PortfolioVault strayPortfolio = new PortfolioVault(address(usdg), deployer);

        // Keep the router pointing at the stray vault so the failure under test
        // is the ownership check, not a stale recipient.
        vm.prank(address(timelock));
        router.setRecipients(address(budgetSafe), address(reserveSafe), address(strayPortfolio));

        VerifyMainnetScript.Input memory input = _validInput();
        input.portfolio = address(strayPortfolio);

        vm.expectRevert("PortfolioVault owner");
        verifier.verify(input);
    }

    function test_VerifyMainnetRejectsEoaOwnedStockOracle() public {
        vm.prank(deployer);
        StockPriceOracle strayOracle = new StockPriceOracle(address(stockToken), address(stockFeed), deployer);

        VerifyMainnetScript.Input memory input = _validInput();
        input.stockOracles[0] = address(strayOracle);

        vm.expectRevert("StockPriceOracle owner");
        verifier.verify(input);
    }

    function test_VerifyMainnetRejectsEoaOwnedStockVault() public {
        vm.prank(deployer);
        StockVault strayVault = new StockVault(
            address(stockToken),
            "AAPL",
            address(stockFeed),
            STOCK_CAP,
            address(treasurySafe),
            address(stakeManager),
            deployer
        );

        VerifyMainnetScript.Input memory input = _validInput();
        input.stockVaults[0] = address(strayVault);

        vm.expectRevert("StockVault owner");
        verifier.verify(input);
    }

    function test_VerifyMainnetRejectsSafeThresholdOne() public {
        treasurySafe.setThreshold(1);

        vm.expectRevert("Safe threshold below minimum");
        verifier.verify(_validInput());
    }

    function test_VerifyMainnetRejectsTimelockBelow48Hours() public {
        timelock.setMinDelay(1 hours);

        vm.expectRevert("timelock delay below minimum");
        verifier.verify(_validInput());
    }

    function test_VerifyMainnetRejectsPortfolioTreasuryRedirect() public {
        vm.prank(address(timelock));
        portfolio.setTreasury(address(0xBADA55));

        vm.expectRevert("portfolio treasury mismatch");
        verifier.verify(_validInput());
    }

    function test_VerifyMainnetRejectsUsdgNotEnabled() public {
        vm.prank(address(timelock));
        stakeManager.setAssetConfig(address(usdg), false, StakeManager.AssetKind.BASE, address(usdgVault), address(0), 0);

        vm.expectRevert("USDG not enabled in StakeManager");
        verifier.verify(_validInput());
    }

    function test_VerifyMainnetRejectsVaultOperatorMismatch() public {
        vm.prank(address(timelock));
        usdgVault.setOperator(address(0xF00D));

        vm.expectRevert("vault operator mismatch");
        verifier.verify(_validInput());
    }
}
