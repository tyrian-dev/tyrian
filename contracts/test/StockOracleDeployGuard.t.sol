// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../script/DeployStockOracle.s.sol";
import "../script/lib/MainnetGuards.sol";
import "../src/oracles/StockPriceOracle.sol";
import "../src/mocks/MockAggregatorV3.sol";
import "../src/mocks/MockERC20.sol";

contract OracleGuardStub {}

/// @dev External wrapper so `vm.expectRevert` sees a revert below the cheatcode
/// call depth. Internal library calls are inlined into the caller.
contract StockOracleGuardHarness {
    function validateStockOracle(MainnetGuards.StockOracleConfig memory config) external view {
        MainnetGuards.validateStockOracle(config);
    }
}

contract StockOracleDeployGuardTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0x1234;

    StockOracleGuardHarness internal harness;
    MockERC20 internal token;
    MockAggregatorV3 internal feed;

    address internal owner;

    function setUp() public {
        harness = new StockOracleGuardHarness();
        token = new MockERC20("Apple", "AAPL", 18);
        feed = new MockAggregatorV3(8, 200e8);
        owner = address(new OracleGuardStub());
    }

    function test_MainnetAcceptsCompleteOracleConfig() public view {
        harness.validateStockOracle(_validConfig());
    }

    function test_RejectsUnsupportedChain() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.chainId = 1;

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.UnsupportedChain.selector, 1));
        harness.validateStockOracle(config);
    }

    function test_RejectsZeroToken() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.token = address(0);

        vm.expectRevert(MainnetGuards.ZeroTokenAddress.selector);
        harness.validateStockOracle(config);
    }

    function test_RejectsZeroFeed() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.feed = address(0);

        vm.expectRevert(MainnetGuards.ZeroTokenAddress.selector);
        harness.validateStockOracle(config);
    }

    function test_RejectsZeroOwner() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.owner = address(0);

        vm.expectRevert(MainnetGuards.ZeroAddress.selector);
        harness.validateStockOracle(config);
    }

    function test_RejectsAnvilDeployerKeyOnMainnet() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.privateKey = MainnetGuards.ANVIL_KEY;

        vm.expectRevert(MainnetGuards.DefaultDeployerKeyOnMainnet.selector);
        harness.validateStockOracle(config);
    }

    function test_RejectsDeployerAsOwner() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.deployer = config.owner;

        vm.expectRevert(MainnetGuards.DeployerMustNotBeOwner.selector);
        harness.validateStockOracle(config);
    }

    function test_RejectsEOAOwner() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.owner = makeAddr("eoaOwner");

        vm.expectRevert(MainnetGuards.OwnerMustBeContract.selector);
        harness.validateStockOracle(config);
    }

    function test_RejectsEOAToken() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.token = makeAddr("eoaToken");
        config.manifestToken = config.token;

        vm.expectRevert(MainnetGuards.TokenMustBeContract.selector);
        harness.validateStockOracle(config);
    }

    function test_RejectsEOAFeed() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.feed = makeAddr("eoaFeed");
        config.manifestFeed = config.feed;

        vm.expectRevert(MainnetGuards.TokenMustBeContract.selector);
        harness.validateStockOracle(config);
    }

    function test_RejectsMissingManifestToken() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.manifestToken = address(0);

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMissing.selector, "stocks.AAPL.address"));
        harness.validateStockOracle(config);
    }

    function test_RejectsManifestTokenMismatch() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.manifestToken = address(new MockERC20("Other", "OTH", 18));

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "stocks.AAPL.address"));
        harness.validateStockOracle(config);
    }

    function test_RejectsManifestFeedMismatch() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.manifestFeed = address(new MockAggregatorV3(8, 1e8));

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "stocks.AAPL.feed"));
        harness.validateStockOracle(config);
    }

    function test_TestnetSkipsMainnetOnlyChecks() public {
        MainnetGuards.StockOracleConfig memory config = _validConfig();
        config.chainId = MainnetGuards.ROBINHOOD_TESTNET_CHAIN_ID;
        config.privateKey = MainnetGuards.ANVIL_KEY;
        config.deployer = config.owner;
        config.owner = makeAddr("eoaOwner");
        config.token = makeAddr("eoaToken");
        config.feed = makeAddr("eoaFeed");
        config.manifestToken = address(0);
        config.manifestFeed = address(0);

        harness.validateStockOracle(config);
    }

    /// @dev The real script stops before broadcast while the mainnet manifest is
    /// still unconfigured.
    function test_ScriptStopsOnUnconfiguredMainnetManifest() public {
        vm.chainId(MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID);
        _setEnv(address(token), address(feed));

        DeployStockOracleScript script = new DeployStockOracleScript();
        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMissing.selector, "stocks.AAPL.address"));
        script.run();
    }

    function test_ScriptDeploysOnTestnet() public {
        vm.chainId(MainnetGuards.ROBINHOOD_TESTNET_CHAIN_ID);
        _setEnv(address(token), address(feed));

        uint64 nonce = vm.getNonce(vm.addr(DEPLOYER_KEY));
        address oracleAddress = vm.computeCreateAddress(vm.addr(DEPLOYER_KEY), nonce);

        DeployStockOracleScript script = new DeployStockOracleScript();
        script.run();

        StockPriceOracle oracle = StockPriceOracle(oracleAddress);
        assertEq(oracle.stockToken(), address(token));
        assertEq(oracle.feed(), address(feed));
        assertEq(oracle.owner(), vm.addr(DEPLOYER_KEY));
    }

    function _setEnv(address token_, address feed_) internal {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_KEY));
        vm.setEnv("STOCK_TICKER", "AAPL");
        vm.setEnv("STOCK_TOKEN", vm.toString(token_));
        vm.setEnv("STOCK_FEED", vm.toString(feed_));
        vm.setEnv("PROTOCOL_OWNER", vm.toString(owner));
    }

    function _validConfig() internal view returns (MainnetGuards.StockOracleConfig memory) {
        return MainnetGuards.StockOracleConfig({
            chainId: MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID,
            deployer: vm.addr(DEPLOYER_KEY),
            owner: owner,
            token: address(token),
            feed: address(feed),
            privateKey: DEPLOYER_KEY,
            ticker: "AAPL",
            manifestToken: address(token),
            manifestFeed: address(feed)
        });
    }
}
