// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../script/ConfigureTreasury.s.sol";
import "../script/lib/MainnetGuards.sol";
import "../script/lib/TreasuryManifest.sol";
import "../src/PortfolioVault.sol";
import "../src/TreasuryRouter.sol";
import "../src/mocks/MockAggregatorV3.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockSwapRouterV3.sol";
import "../src/mocks/MockWETH.sol";
import "../src/oracles/StockPriceOracle.sol";

/// @dev External wrapper so `vm.expectRevert` sees a revert below the cheatcode
/// call depth. Internal library calls are inlined into the caller.
contract TreasuryConfigureGuardHarness {
    function validate(MainnetGuards.TreasuryConfiguration memory config) external view {
        MainnetGuards.validateTreasuryConfiguration(config);
    }
}

/// @dev Exercises the script's internal apply path with manifest-parsed targets.
contract ConfigureTreasuryApplyHarness is ConfigureTreasuryScript {
    function applyTargets(
        address router,
        address portfolio,
        address keeper,
        address dexRouter,
        address treasury,
        TreasuryManifest.Targets memory targets
    ) external {
        Settings memory settings = Settings({
            router: router,
            portfolio: portfolio,
            keeper: keeper,
            dexRouter: dexRouter,
            treasury: treasury,
            poolFee: 3000,
            treasuryTotalUsd: 10_000e18,
            dcaAmountUsd: 1_000e18,
            dcaInterval: 7 days,
            maxSlippageBps: 100
        });
        _apply(settings, true, targets);
    }
}

contract TreasuryConfigureGuardTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0x1234;
    address internal deployer;

    TreasuryConfigureGuardHarness internal harness;
    MockERC20 internal usdg;
    MockWETH internal weth;
    MockSwapRouterV3 internal dexRouter;
    TreasuryRouter internal router;
    PortfolioVault internal portfolio;

    address internal keeper = address(0x4EE9);
    address internal treasury;

    function setUp() public {
        deployer = vm.addr(DEPLOYER_KEY);
        harness = new TreasuryConfigureGuardHarness();
        usdg = new MockERC20("Robinhood USDG", "USDG", 18);
        weth = new MockWETH();
        dexRouter = new MockSwapRouterV3();
        router = new TreasuryRouter(address(usdg), address(weth), deployer);
        portfolio = new PortfolioVault(address(usdg), deployer);
        // Stand-in for the Safe that owns the treasury role; only `code.length`
        // matters to the guard.
        treasury = address(new MockERC20("Treasury Safe", "SAFE", 18));
    }

    function test_MainnetAcceptsCompleteConfiguration() public view {
        harness.validate(_validConfig());
    }

    function test_RejectsUnsupportedChain() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.chainId = 1;

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.UnsupportedChain.selector, 1));
        harness.validate(config);
    }

    function test_RejectsZeroRouter() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.router = address(0);

        vm.expectRevert(MainnetGuards.ZeroAddress.selector);
        harness.validate(config);
    }

    function test_RejectsZeroPortfolio() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.portfolio = address(0);

        vm.expectRevert(MainnetGuards.ZeroAddress.selector);
        harness.validate(config);
    }

    function test_RejectsZeroKeeper() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.keeper = address(0);

        vm.expectRevert(MainnetGuards.ZeroAddress.selector);
        harness.validate(config);
    }

    function test_RejectsAnvilDeployerKeyOnMainnet() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.privateKey = MainnetGuards.ANVIL_KEY;

        vm.expectRevert(MainnetGuards.DefaultDeployerKeyOnMainnet.selector);
        harness.validate(config);
    }

    function test_RejectsEOARouter() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.router = makeAddr("eoaRouter");
        config.manifestRouter = config.router;

        vm.expectRevert(MainnetGuards.TreasuryMustBeContract.selector);
        harness.validate(config);
    }

    function test_RejectsEOAPortfolio() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.portfolio = makeAddr("eoaPortfolio");
        config.manifestPortfolio = config.portfolio;

        vm.expectRevert(MainnetGuards.TreasuryMustBeContract.selector);
        harness.validate(config);
    }

    function test_RejectsZeroDexRouterOnMainnet() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.dexRouter = address(0);

        vm.expectRevert(MainnetGuards.ZeroAddress.selector);
        harness.validate(config);
    }

    function test_RejectsEOADexRouter() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.dexRouter = makeAddr("eoaDex");
        config.manifestDexRouter = config.dexRouter;

        vm.expectRevert(MainnetGuards.RouterMustBeContract.selector);
        harness.validate(config);
    }

    function test_RejectsZeroTreasuryOnMainnet() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.treasury = address(0);

        vm.expectRevert(MainnetGuards.ZeroAddress.selector);
        harness.validate(config);
    }

    function test_RejectsEOATreasury() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.treasury = makeAddr("eoaTreasury");
        config.manifestTreasury = config.treasury;

        vm.expectRevert(MainnetGuards.TreasuryRecipientMustBeContract.selector);
        harness.validate(config);
    }

    function test_RejectsManifestTreasuryMismatch() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.manifestTreasury = address(new MockERC20("Other Safe", "SAFE", 18));

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "external.treasurySafe"));
        harness.validate(config);
    }

    function test_RejectsUnconfiguredManifestTreasury() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.manifestTreasury = address(0);

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMissing.selector, "external.treasurySafe"));
        harness.validate(config);
    }

    function test_RejectsMissingManifestRouter() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.manifestRouter = address(0);

        vm.expectRevert(
            abi.encodeWithSelector(MainnetGuards.ManifestAddressMissing.selector, "contracts.TreasuryRouter")
        );
        harness.validate(config);
    }

    function test_RejectsManifestPortfolioMismatch() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.manifestPortfolio = address(new PortfolioVault(address(usdg), deployer));

        vm.expectRevert(
            abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "contracts.PortfolioVault")
        );
        harness.validate(config);
    }

    function test_RejectsManifestDexRouterMismatch() public {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.manifestDexRouter = address(new MockSwapRouterV3());

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "external.dexRouter"));
        harness.validate(config);
    }

    function test_TestnetAllowsMissingDexRouter() public view {
        MainnetGuards.TreasuryConfiguration memory config = _validConfig();
        config.chainId = MainnetGuards.ROBINHOOD_TESTNET_CHAIN_ID;
        config.privateKey = MainnetGuards.ANVIL_KEY;
        config.dexRouter = address(0);
        config.treasury = address(0);
        config.manifestRouter = address(0);
        config.manifestPortfolio = address(0);
        config.manifestDexRouter = address(0);
        config.manifestTreasury = address(0);

        harness.validate(config);
    }

    function test_ScriptConfiguresOnTestnet() public {
        vm.chainId(MainnetGuards.ROBINHOOD_TESTNET_CHAIN_ID);
        _setEnv();

        // Prove the script overwrites the split instead of relying on defaults.
        vm.prank(deployer);
        router.setSplit(1, 1, 9998);

        ConfigureTreasuryScript script = new ConfigureTreasuryScript();
        script.run();

        assertEq(router.budgetBps(), 7000);
        assertEq(router.reserveBps(), 2000);
        assertEq(router.portfolioBps(), 1000);
        assertEq(router.keeper(), keeper);
        assertEq(portfolio.keeper(), keeper);
        assertEq(router.swapRouter(), address(dexRouter));
        assertEq(router.poolFee(), 3000);
        assertEq(portfolio.swapRouter(), address(dexRouter));
        assertEq(portfolio.poolFee(), 3000);
        assertEq(portfolio.treasuryTotalUsd(), 10_000e18);
        assertEq(portfolio.dcaAmountUsd(), 1_000e18);
        assertEq(portfolio.dcaInterval(), 7 days);
        assertEq(portfolio.maxSlippageBps(), 100);
        // Testnet has no treasury Safe in the manifest, so the constructor
        // default (the owner at deploy time) is kept.
        assertEq(portfolio.treasury(), deployer);
        // Testnet has no enabled stocks yet, so targets are skipped.
        assertEq(portfolio.targetCount(), 0);
    }

    function test_ApplyConfiguresManifestTargets() public {
        ConfigureTreasuryApplyHarness applyHarness = new ConfigureTreasuryApplyHarness();
        address applyOwner = address(applyHarness);

        TreasuryRouter ownedRouter = new TreasuryRouter(address(usdg), address(weth), applyOwner);
        PortfolioVault ownedPortfolio = new PortfolioVault(address(usdg), applyOwner);

        MockERC20 tokenA = new MockERC20("Apple", "AAPL", 18);
        MockERC20 tokenB = new MockERC20("NVIDIA", "NVDA", 18);
        StockPriceOracle oracleA =
            new StockPriceOracle(address(tokenA), address(new MockAggregatorV3(8, 100e8)), address(this));
        StockPriceOracle oracleB =
            new StockPriceOracle(address(tokenB), address(new MockAggregatorV3(8, 200e8)), address(this));

        TreasuryManifest.Targets memory targets;
        targets.tokens = new address[](2);
        targets.oracles = new address[](2);
        targets.weights = new uint16[](2);
        targets.tickers = new string[](2);
        targets.tokens[0] = address(tokenA);
        targets.tokens[1] = address(tokenB);
        targets.oracles[0] = address(oracleA);
        targets.oracles[1] = address(oracleB);
        targets.weights[0] = 5000;
        targets.weights[1] = 5000;
        targets.tickers[0] = "AAPL";
        targets.tickers[1] = "NVDA";

        applyHarness.applyTargets(
            address(ownedRouter), address(ownedPortfolio), keeper, address(dexRouter), treasury, targets
        );

        assertEq(ownedRouter.budgetBps(), 7000);
        assertEq(ownedRouter.keeper(), keeper);
        assertEq(ownedRouter.swapRouter(), address(dexRouter));
        assertEq(ownedRouter.poolFee(), 3000);
        assertEq(ownedPortfolio.keeper(), keeper);
        assertEq(ownedPortfolio.swapRouter(), address(dexRouter));
        assertEq(ownedPortfolio.poolFee(), 3000);
        assertEq(ownedPortfolio.treasuryTotalUsd(), 10_000e18);
        assertEq(ownedPortfolio.dcaAmountUsd(), 1_000e18);
        assertEq(ownedPortfolio.dcaInterval(), 7 days);
        assertEq(ownedPortfolio.maxSlippageBps(), 100);
        assertEq(ownedPortfolio.treasury(), treasury);
        assertEq(ownedPortfolio.targetCount(), 2);

        (, uint16 weightA, address targetOracleA, bool foundA) = ownedPortfolio.targetOf(address(tokenA));
        assertTrue(foundA);
        assertEq(weightA, 5000);
        assertEq(targetOracleA, address(oracleA));
        (, uint16 weightB, address targetOracleB, bool foundB) = ownedPortfolio.targetOf(address(tokenB));
        assertTrue(foundB);
        assertEq(weightB, 5000);
        assertEq(targetOracleB, address(oracleB));
    }

    function test_ScriptStopsOnUnconfiguredMainnetManifest() public {
        vm.chainId(MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID);
        _setEnv();

        ConfigureTreasuryScript script = new ConfigureTreasuryScript();
        vm.expectRevert(
            abi.encodeWithSelector(MainnetGuards.ManifestAddressMissing.selector, "contracts.TreasuryRouter")
        );
        script.run();
    }

    function _setEnv() internal {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_KEY));
        vm.setEnv("TREASURY_ROUTER", vm.toString(address(router)));
        vm.setEnv("PORTFOLIO_VAULT", vm.toString(address(portfolio)));
        vm.setEnv("KEEPER", vm.toString(keeper));
        vm.setEnv("DEX_ROUTER", vm.toString(address(dexRouter)));
        vm.setEnv("DEX_POOL_FEE", "3000");
        vm.setEnv("TREASURY_TOTAL_USD", vm.toString(uint256(10_000e18)));
        vm.setEnv("DCA_AMOUNT_USD", vm.toString(uint256(1_000e18)));
        vm.setEnv("DCA_INTERVAL", vm.toString(uint256(7 days)));
        vm.setEnv("MAX_SLIPPAGE_BPS", "100");
    }

    function _validConfig() internal view returns (MainnetGuards.TreasuryConfiguration memory) {
        return MainnetGuards.TreasuryConfiguration({
            chainId: MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID,
            privateKey: DEPLOYER_KEY,
            router: address(router),
            portfolio: address(portfolio),
            dexRouter: address(dexRouter),
            keeper: keeper,
            treasury: treasury,
            manifestRouter: address(router),
            manifestPortfolio: address(portfolio),
            manifestDexRouter: address(dexRouter),
            manifestTreasury: treasury
        });
    }
}
