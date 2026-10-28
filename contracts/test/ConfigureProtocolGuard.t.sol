// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../script/lib/MainnetGuards.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockWETH.sol";

contract ProtocolGuardStub {}

/// @dev External wrapper so `vm.expectRevert` sees a revert below the cheatcode
/// call depth. Internal library calls are inlined into the caller.
contract ProtocolGuardHarness {
    function validateProtocol(MainnetGuards.ProtocolConfiguration memory config) external view {
        MainnetGuards.validateProtocolConfiguration(config);
    }
}

/**
 * @notice Guard tests for ConfigureProtocol.
 *
 * These cover the manifest wiring that was previously missing: a mainnet run
 * could enable staking against any vault, point the fee splitter at an EOA, or
 * wire a mock buyback router without the script noticing.
 */
contract ConfigureProtocolGuardTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0x1234;
    address internal constant DEPLOYER = address(0xD3D3);

    ProtocolGuardHarness internal harness;
    MockERC20 internal usdg;
    MockWETH internal weth;

    address internal stakeManager;
    address internal usdgVault;
    address internal treasury;
    address internal feeSplitter;
    address internal burner;
    address internal dexRouter;

    function setUp() public {
        harness = new ProtocolGuardHarness();
        usdg = new MockERC20("USDG", "USDG", 18);
        weth = new MockWETH();

        stakeManager = address(new ProtocolGuardStub());
        usdgVault = address(new ProtocolGuardStub());
        treasury = address(new ProtocolGuardStub());
        feeSplitter = address(new ProtocolGuardStub());
        burner = address(new ProtocolGuardStub());
        dexRouter = address(new ProtocolGuardStub());
    }

    function _validConfig() internal view returns (MainnetGuards.ProtocolConfiguration memory config) {
        config = MainnetGuards.ProtocolConfiguration({
            chainId: MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID,
            privateKey: DEPLOYER_KEY,
            stakeManager: stakeManager,
            usdg: address(usdg),
            usdgVault: usdgVault,
            treasury: treasury,
            feeSplitter: feeSplitter,
            burner: burner,
            buybackRouter: dexRouter,
            keeper: address(0xBEEF),
            manifestStakeManager: stakeManager,
            manifestUsdg: address(usdg),
            manifestUsdgVault: usdgVault,
            manifestTreasury: treasury,
            manifestFeeSplitter: feeSplitter,
            manifestBurner: burner,
            manifestBuybackRouter: dexRouter
        });
    }

    function test_MainnetAcceptsCompleteConfig() public view {
        harness.validateProtocol(_validConfig());
    }

    function test_RejectsUnsupportedChain() public {
        MainnetGuards.ProtocolConfiguration memory config = _validConfig();
        config.chainId = 1;

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.UnsupportedChain.selector, 1));
        harness.validateProtocol(config);
    }

    function test_RejectsAnvilKeyOnMainnet() public {
        MainnetGuards.ProtocolConfiguration memory config = _validConfig();
        config.privateKey = MainnetGuards.ANVIL_KEY;

        vm.expectRevert(MainnetGuards.DefaultDeployerKeyOnMainnet.selector);
        harness.validateProtocol(config);
    }

    function test_RejectsUnconfiguredManifestEntry() public {
        MainnetGuards.ProtocolConfiguration memory config = _validConfig();
        config.manifestStakeManager = address(0);

        vm.expectRevert(
            abi.encodeWithSelector(MainnetGuards.ManifestAddressMissing.selector, "contracts.StakeManager")
        );
        harness.validateProtocol(config);
    }

    function test_RejectsUsdgVaultNotInManifest() public {
        MainnetGuards.ProtocolConfiguration memory config = _validConfig();
        config.usdgVault = address(new ProtocolGuardStub());

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "contracts.UsdgVault"));
        harness.validateProtocol(config);
    }

    function test_RejectsEoaTreasury() public {
        MainnetGuards.ProtocolConfiguration memory config = _validConfig();
        config.treasury = address(0xF00D);
        config.manifestTreasury = address(0xF00D);

        vm.expectRevert(MainnetGuards.TreasuryMustBeContract.selector);
        harness.validateProtocol(config);
    }

    function test_RejectsMockBuybackRouterNotInManifest() public {
        MainnetGuards.ProtocolConfiguration memory config = _validConfig();
        config.buybackRouter = address(new ProtocolGuardStub());

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "external.dexRouter"));
        harness.validateProtocol(config);
    }

    function test_RejectsZeroCoreAddress() public {
        MainnetGuards.ProtocolConfiguration memory config = _validConfig();
        config.usdgVault = address(0);

        vm.expectRevert(MainnetGuards.ZeroAddress.selector);
        harness.validateProtocol(config);
    }

    function test_TestnetSkipsManifestChecks() public {
        MainnetGuards.ProtocolConfiguration memory config = _validConfig();
        config.chainId = MainnetGuards.ROBINHOOD_TESTNET_CHAIN_ID;
        config.manifestStakeManager = address(0);
        config.buybackRouter = address(0);

        harness.validateProtocol(config);
    }
}
