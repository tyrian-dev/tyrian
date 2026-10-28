// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../script/lib/MainnetGuards.sol";
import "../src/vaults/StockVault.sol";
import "../src/StakeManager.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockAggregatorV3.sol";

contract StockVaultGuardStub {}

/// @dev External wrapper so `vm.expectRevert` sees a revert below the cheatcode
/// call depth. Internal library calls are inlined into the caller.
contract StockVaultGuardHarness {
    function validateDeploy(MainnetGuards.StockVaultConfig memory config) external view {
        MainnetGuards.validateStockVaultDeploy(config);
    }

    function validateConfig(MainnetGuards.StockVaultConfig memory config) external view {
        MainnetGuards.validateStockVaultConfig(config);
    }
}

/**
 * @notice Guard tests for DeployStockVault and ConfigureStockVault.
 *
 * One vault per ticker: the token, feed, and vault must all come from the same
 * manifest entry, and a ticker that already has a vault cannot be deployed
 * again.
 */
contract StockVaultGuardTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0x1234;
    address internal constant DEPLOYER = address(0xD3D3);
    uint256 internal constant CAP = 1_000_000e18;

    StockVaultGuardHarness internal harness;
    MockERC20 internal token;
    MockAggregatorV3 internal feed;
    StakeManager internal stakeManager;

    address internal treasury;
    address internal guardian;
    address internal vault;

    function setUp() public {
        harness = new StockVaultGuardHarness();
        token = new MockERC20("Apple", "AAPL", 18);
        feed = new MockAggregatorV3(8, 200e8);
        treasury = address(new StockVaultGuardStub());
        guardian = address(new StockVaultGuardStub());
        vault = address(new StockVaultGuardStub());

        vm.prank(DEPLOYER);
        stakeManager = new StakeManager(DEPLOYER);
    }

    function _validDeployConfig() internal view returns (MainnetGuards.StockVaultConfig memory config) {
        config = MainnetGuards.StockVaultConfig({
            chainId: MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID,
            privateKey: DEPLOYER_KEY,
            deployer: DEPLOYER,
            token: address(token),
            feed: address(feed),
            vault: address(0),
            treasury: treasury,
            stakeManager: address(stakeManager),
            guardian: guardian,
            depositCap: CAP,
            ticker: "AAPL",
            manifestToken: address(token),
            manifestFeed: address(feed),
            manifestVault: address(0),
            manifestTreasury: treasury
        });
    }

    function _validConfigConfig() internal view returns (MainnetGuards.StockVaultConfig memory config) {
        config = _validDeployConfig();
        config.vault = vault;
        config.manifestVault = vault;
    }

    // ---------------------------------------------------------------------
    // Deploy guard
    // ---------------------------------------------------------------------

    function test_DeployAcceptsCompleteConfig() public view {
        harness.validateDeploy(_validDeployConfig());
    }

    function test_DeployRejectsUnsupportedChain() public {
        MainnetGuards.StockVaultConfig memory config = _validDeployConfig();
        config.chainId = 1;

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.UnsupportedChain.selector, 1));
        harness.validateDeploy(config);
    }

    function test_DeployRejectsAnvilKey() public {
        MainnetGuards.StockVaultConfig memory config = _validDeployConfig();
        config.privateKey = MainnetGuards.ANVIL_KEY;

        vm.expectRevert(MainnetGuards.DefaultDeployerKeyOnMainnet.selector);
        harness.validateDeploy(config);
    }

    function test_DeployRejectsZeroCap() public {
        MainnetGuards.StockVaultConfig memory config = _validDeployConfig();
        config.depositCap = 0;

        vm.expectRevert(MainnetGuards.InvalidDepositCap.selector);
        harness.validateDeploy(config);
    }

    function test_DeployRejectsCrossTickerFeed() public {
        // AAPL token paired with a feed that belongs to another ticker.
        MainnetGuards.StockVaultConfig memory config = _validDeployConfig();
        config.feed = address(new MockAggregatorV3(8, 100e8));

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "stocks.AAPL.feed"));
        harness.validateDeploy(config);
    }

    function test_DeployRejectsTokenNotInManifest() public {
        MainnetGuards.StockVaultConfig memory config = _validDeployConfig();
        config.token = address(new MockERC20("NVIDIA", "NVDA", 18));

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "stocks.AAPL.address"));
        harness.validateDeploy(config);
    }

    function test_DeployRejectsTickerThatAlreadyHasVault() public {
        MainnetGuards.StockVaultConfig memory config = _validDeployConfig();
        config.manifestVault = vault;

        vm.expectRevert(
            abi.encodeWithSelector(
                MainnetGuards.ManifestAddressMismatch.selector, "stocks.<TICKER>.vault already set"
            )
        );
        harness.validateDeploy(config);
    }

    function test_DeployRejectsEoaTreasury() public {
        MainnetGuards.StockVaultConfig memory config = _validDeployConfig();
        config.treasury = address(0xF00D);
        config.manifestTreasury = address(0xF00D);

        vm.expectRevert(MainnetGuards.TreasuryRecipientMustBeContract.selector);
        harness.validateDeploy(config);
    }

    function test_DeployTestnetSkipsManifestChecks() public {
        MainnetGuards.StockVaultConfig memory config = _validDeployConfig();
        config.chainId = MainnetGuards.ROBINHOOD_TESTNET_CHAIN_ID;
        config.manifestToken = address(0);
        config.manifestFeed = address(0);

        harness.validateDeploy(config);
    }

    // ---------------------------------------------------------------------
    // Configure guard
    // ---------------------------------------------------------------------

    function test_ConfigureAcceptsCompleteConfig() public view {
        harness.validateConfig(_validConfigConfig());
    }

    function test_ConfigureRejectsVaultNotInManifest() public {
        MainnetGuards.StockVaultConfig memory config = _validConfigConfig();
        config.vault = address(new StockVaultGuardStub());

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "stocks.AAPL.vault"));
        harness.validateConfig(config);
    }

    function test_ConfigureRejectsUnconfiguredVaultManifest() public {
        MainnetGuards.StockVaultConfig memory config = _validConfigConfig();
        config.manifestVault = address(0);

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMissing.selector, "stocks.AAPL.vault"));
        harness.validateConfig(config);
    }

    function test_ConfigureRejectsTokenMismatch() public {
        MainnetGuards.StockVaultConfig memory config = _validConfigConfig();
        config.token = address(new MockERC20("NVIDIA", "NVDA", 18));

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "stocks.AAPL.address"));
        harness.validateConfig(config);
    }

    function test_ConfigureRejectsZeroVault() public {
        MainnetGuards.StockVaultConfig memory config = _validConfigConfig();
        config.vault = address(0);

        vm.expectRevert(MainnetGuards.ZeroAddress.selector);
        harness.validateConfig(config);
    }

    function test_ConfigureTestnetSkipsManifestChecks() public {
        MainnetGuards.StockVaultConfig memory config = _validConfigConfig();
        config.chainId = MainnetGuards.ROBINHOOD_TESTNET_CHAIN_ID;
        config.manifestVault = address(0);

        harness.validateConfig(config);
    }
}
