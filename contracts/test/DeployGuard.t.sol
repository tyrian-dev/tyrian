// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../script/lib/MainnetGuards.sol";
import "../script/DeployTyrian.s.sol";
import "../script/DeployProtocol.s.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockWETH.sol";

contract ContractStub {}

/// @dev External wrapper so `vm.expectRevert` sees a revert below the cheatcode
/// call depth. Internal library calls are inlined into the caller.
contract GuardHarness {
    function validate(MainnetGuards.DeployConfig memory config) external view {
        MainnetGuards.validate(config);
    }
}

contract DeployGuardTest is Test {
    address internal constant DEPLOYER = address(0xD3D3);

    GuardHarness internal harness;
    MockERC20 internal usdg;
    MockERC20 internal tyr;
    MockWETH internal weth;

    address internal treasury;
    address internal guardian;
    address internal owner;

    function setUp() public {
        harness = new GuardHarness();
        usdg = new MockERC20("USDG", "USDG", 18);
        tyr = new MockERC20("Tyrian", "TYR", 18);
        weth = new MockWETH();
        treasury = address(new ContractStub());
        guardian = address(new ContractStub());
        owner = address(new ContractStub());
    }

    function test_MainnetAcceptsCompleteConfig() public view {
        MainnetGuards.validate(_validConfig());
    }

    function test_RejectsUnsupportedChain() public {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.chainId = 1;

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.UnsupportedChain.selector, 1));
        harness.validate(config);
    }

    function test_RejectsZeroTokenAddress() public {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.tyr = address(0);

        vm.expectRevert(MainnetGuards.ZeroTokenAddress.selector);
        harness.validate(config);
    }

    function test_RejectsAnvilDeployerKeyOnMainnet() public {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.privateKey = MainnetGuards.ANVIL_KEY;

        vm.expectRevert(MainnetGuards.DefaultDeployerKeyOnMainnet.selector);
        harness.validate(config);
    }

    function test_RejectsEOATreasury() public {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.treasury = makeAddr("eoaTreasury");
        config.manifestTreasury = config.treasury;

        vm.expectRevert(MainnetGuards.TreasuryMustBeContract.selector);
        harness.validate(config);
    }

    function test_RejectsEOAGuardian() public {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.guardian = makeAddr("eoaGuardian");
        config.manifestGuardian = config.guardian;

        vm.expectRevert(MainnetGuards.GuardianMustBeContract.selector);
        harness.validate(config);
    }

    function test_RejectsEOAOwner() public {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.owner = makeAddr("eoaOwner");

        vm.expectRevert(MainnetGuards.OwnerMustBeContract.selector);
        harness.validate(config);
    }

    function test_RejectsDeployerAsOwner() public {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.owner = config.deployer;

        vm.expectRevert(MainnetGuards.DeployerMustNotBeOwner.selector);
        harness.validate(config);
    }

    function test_RejectsNonContractToken() public {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.usdg = makeAddr("fakeUsdg");
        config.manifestUsdg = config.usdg;

        vm.expectRevert(MainnetGuards.TokenMustBeContract.selector);
        harness.validate(config);
    }

    function test_RejectsTreasuryEqualToToken() public {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.treasury = address(usdg);
        config.manifestTreasury = config.treasury;

        vm.expectRevert(MainnetGuards.BadTreasury.selector);
        harness.validate(config);
    }

    /// @dev T-17: a mock token supplied through env vars must not reach mainnet
    /// because it does not match the verified manifest.
    function test_RejectsMockTokenNotInManifest() public {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.usdg = address(new MockERC20("Mock USDG", "USDG", 18));

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "tokens.USDG.address"));
        harness.validate(config);
    }

    function test_RejectsUnconfiguredManifestEntry() public {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.manifestWeth = address(0);

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMissing.selector, "tokens.WETH.address"));
        harness.validate(config);
    }

    function test_TestnetSkipsMainnetOnlyChecks() public view {
        MainnetGuards.DeployConfig memory config = _validConfig();
        config.chainId = MainnetGuards.ROBINHOOD_TESTNET_CHAIN_ID;
        config.privateKey = MainnetGuards.ANVIL_KEY;
        config.treasury = DEPLOYER;
        config.guardian = DEPLOYER;
        config.owner = DEPLOYER;
        config.manifestTreasury = address(0);
        config.manifestGuardian = address(0);
        config.manifestUsdg = address(0);
        config.manifestTyr = address(0);
        config.manifestWeth = address(0);

        harness.validate(config);
    }

    function test_DeployTyrianRejectsMainnet() public {
        DeployTyrianScript script = new DeployTyrianScript();
        vm.chainId(MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID);

        vm.expectRevert(bytes("DeployTyrian: local/testnet only"));
        script.run();
    }

    /// @dev The pre-deployment manifest stores `null`, which exists as a JSON key
    /// but is not parseable as an address. DeployProtocol treats a parse failure
    /// as "not configured" so the guard returns ManifestAddressMissing.
    function test_MainnetManifestNullAddressIsNotParseable() public view {
        string memory json = vm.readFile("../config/networks/mainnet.json");

        assertTrue(vm.keyExistsJson(json, ".tokens.USDG.address"));
        (bool ok,) = address(vm)
            .staticcall(abi.encodeWithSignature("parseJsonAddress(string,string)", json, ".tokens.USDG.address"));
        assertFalse(ok);
    }

    /// @dev The helper uses a low-level staticcall so a `null` entry does not
    /// abort with an opaque cheatcode error. Verify the selector still decodes a
    /// real address correctly.
    function test_ParseJsonAddressSelectorReturnsAddress() public view {
        string memory json = '{"addr":"0x000000000000000000000000000000000000dead"}';
        (bool ok, bytes memory data) =
            address(vm).staticcall(abi.encodeWithSignature("parseJsonAddress(string,string)", json, ".addr"));

        assertTrue(ok);
        assertEq(abi.decode(data, (address)), address(0xdead));
    }

    /// @dev End-to-end guard check: the real deploy script stops before broadcast
    /// while the mainnet manifest still has null token addresses.
    function test_DeployProtocolStopsOnUnconfiguredManifest() public {
        vm.chainId(MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0x1234");
        vm.setEnv("TREASURY_SAFE", vm.toString(treasury));
        vm.setEnv("GUARDIAN", vm.toString(guardian));
        vm.setEnv("USDG_ADDRESS", vm.toString(address(usdg)));
        vm.setEnv("TYR_ADDRESS", vm.toString(address(tyr)));
        vm.setEnv("WETH_ADDRESS", vm.toString(address(weth)));
        vm.setEnv("PROTOCOL_OWNER", vm.toString(owner));

        DeployProtocolScript script = new DeployProtocolScript();
        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMissing.selector, "tokens.USDG.address"));
        script.run();
    }

    function _validConfig() internal view returns (MainnetGuards.DeployConfig memory) {
        return MainnetGuards.DeployConfig({
            chainId: MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID,
            deployer: DEPLOYER,
            treasury: treasury,
            guardian: guardian,
            usdg: address(usdg),
            tyr: address(tyr),
            weth: address(weth),
            owner: owner,
            privateKey: 0x1234,
            manifestTreasury: treasury,
            manifestGuardian: guardian,
            manifestUsdg: address(usdg),
            manifestTyr: address(tyr),
            manifestWeth: address(weth)
        });
    }
}
