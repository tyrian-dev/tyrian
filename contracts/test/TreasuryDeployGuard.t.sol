// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../script/DeployTreasury.s.sol";
import "../script/lib/MainnetGuards.sol";
import "../src/PortfolioVault.sol";
import "../src/TreasuryRouter.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockWETH.sol";

contract GuardStub {}

/// @dev External wrapper so `vm.expectRevert` sees a revert below the cheatcode
/// call depth. Internal library calls are inlined into the caller.
contract TreasuryGuardHarness {
    function validateTreasury(MainnetGuards.TreasuryConfig memory config) external view {
        MainnetGuards.validateTreasury(config);
    }
}

contract TreasuryDeployGuardTest is Test {
    address internal constant DEPLOYER = address(0xD3D3);
    uint256 internal constant DEPLOYER_KEY = 0x1234;

    TreasuryGuardHarness internal harness;
    MockERC20 internal usdg;
    MockWETH internal weth;

    address internal budget;
    address internal reserve;
    address internal guardian;
    address internal owner;

    function setUp() public {
        harness = new TreasuryGuardHarness();
        usdg = new MockERC20("USDG", "USDG", 18);
        weth = new MockWETH();
        budget = address(new GuardStub());
        reserve = address(new GuardStub());
        guardian = address(new GuardStub());
        owner = address(new GuardStub());
    }

    function test_MainnetAcceptsCompleteTreasuryConfig() public view {
        harness.validateTreasury(_validConfig());
    }

    function test_RejectsUnsupportedChain() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.chainId = 1;

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.UnsupportedChain.selector, 1));
        harness.validateTreasury(config);
    }

    function test_RejectsZeroToken() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.weth = address(0);

        vm.expectRevert(MainnetGuards.ZeroTokenAddress.selector);
        harness.validateTreasury(config);
    }

    function test_RejectsZeroRecipient() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.reserve = address(0);

        vm.expectRevert(MainnetGuards.ZeroAddress.selector);
        harness.validateTreasury(config);
    }

    function test_RejectsSameBudgetAndReserve() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.reserve = config.budget;

        vm.expectRevert(MainnetGuards.ReservesMustDiffer.selector);
        harness.validateTreasury(config);
    }

    function test_RejectsAnvilDeployerKeyOnMainnet() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.privateKey = MainnetGuards.ANVIL_KEY;

        vm.expectRevert(MainnetGuards.DefaultDeployerKeyOnMainnet.selector);
        harness.validateTreasury(config);
    }

    function test_RejectsDeployerAsBudget() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.deployer = config.budget;
        config.manifestBudget = config.budget;

        vm.expectRevert(MainnetGuards.DeployerMustNotBeTreasury.selector);
        harness.validateTreasury(config);
    }

    function test_RejectsEOABudget() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.budget = makeAddr("eoaBudget");
        config.manifestBudget = config.budget;

        vm.expectRevert(MainnetGuards.TreasuryRecipientMustBeContract.selector);
        harness.validateTreasury(config);
    }

    function test_RejectsEOAReserve() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.reserve = makeAddr("eoaReserve");
        config.manifestReserve = config.reserve;

        vm.expectRevert(MainnetGuards.TreasuryRecipientMustBeContract.selector);
        harness.validateTreasury(config);
    }

    function test_RejectsBudgetEqualToToken() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.budget = address(usdg);
        config.manifestBudget = config.budget;

        vm.expectRevert(MainnetGuards.BadTreasury.selector);
        harness.validateTreasury(config);
    }

    function test_RejectsMissingManifestBudget() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.manifestBudget = address(0);

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMissing.selector, "external.budget"));
        harness.validateTreasury(config);
    }

    function test_RejectsManifestReserveMismatch() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.manifestReserve = address(new GuardStub());

        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMismatch.selector, "external.reserve"));
        harness.validateTreasury(config);
    }

    function test_TestnetSkipsMainnetOnlyChecks() public {
        MainnetGuards.TreasuryConfig memory config = _validConfig();
        config.chainId = MainnetGuards.ROBINHOOD_TESTNET_CHAIN_ID;
        config.privateKey = MainnetGuards.ANVIL_KEY;
        config.deployer = config.budget;
        config.budget = makeAddr("eoaBudget");
        config.reserve = makeAddr("eoaReserve");
        config.guardian = makeAddr("eoaGuardian");
        config.owner = makeAddr("eoaOwner");
        config.manifestBudget = address(0);
        config.manifestReserve = address(0);
        config.manifestGuardian = address(0);
        config.manifestUsdg = address(0);
        config.manifestWeth = address(0);

        harness.validateTreasury(config);
    }

    /// @dev The real script stops before broadcast while the mainnet manifest is
    /// still unconfigured. USDG is checked first, matching DeployProtocol.
    function test_ScriptStopsOnUnconfiguredMainnetManifest() public {
        vm.chainId(MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID);
        _setEnv(address(usdg), address(weth));

        DeployTreasuryScript script = new DeployTreasuryScript();
        vm.expectRevert(abi.encodeWithSelector(MainnetGuards.ManifestAddressMissing.selector, "tokens.USDG.address"));
        script.run();
    }

    function test_ScriptDeploysOnTestnet() public {
        vm.chainId(MainnetGuards.ROBINHOOD_TESTNET_CHAIN_ID);
        _setEnv(address(usdg), address(weth));

        address deployer = vm.addr(DEPLOYER_KEY);
        uint64 nonce = vm.getNonce(deployer);
        address routerAddress = vm.computeCreateAddress(deployer, nonce);
        address portfolioAddress = vm.computeCreateAddress(deployer, nonce + 1);

        DeployTreasuryScript script = new DeployTreasuryScript();
        script.run();

        TreasuryRouter router = TreasuryRouter(routerAddress);
        PortfolioVault portfolio = PortfolioVault(portfolioAddress);

        assertEq(router.owner(), deployer);
        assertEq(portfolio.owner(), deployer);
        assertEq(router.budget(), budget);
        assertEq(router.reserve(), reserve);
        assertEq(router.portfolio(), portfolioAddress);
        assertEq(router.guardian(), guardian);
        assertEq(portfolio.guardian(), guardian);
        assertEq(router.usdg(), address(usdg));
        assertEq(portfolio.usdg(), address(usdg));
    }

    function _setEnv(address usdg_, address weth_) internal {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_KEY));
        vm.setEnv("GUARDIAN", vm.toString(guardian));
        vm.setEnv("TREASURY_BUDGET", vm.toString(budget));
        vm.setEnv("TREASURY_RESERVE", vm.toString(reserve));
        vm.setEnv("USDG_ADDRESS", vm.toString(usdg_));
        vm.setEnv("WETH_ADDRESS", vm.toString(weth_));
        vm.setEnv("PROTOCOL_OWNER", vm.toString(owner));
    }

    function _validConfig() internal view returns (MainnetGuards.TreasuryConfig memory) {
        return MainnetGuards.TreasuryConfig({
            chainId: MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID,
            deployer: DEPLOYER,
            owner: owner,
            guardian: guardian,
            budget: budget,
            reserve: reserve,
            usdg: address(usdg),
            weth: address(weth),
            privateKey: DEPLOYER_KEY,
            manifestBudget: budget,
            manifestReserve: reserve,
            manifestGuardian: guardian,
            manifestUsdg: address(usdg),
            manifestWeth: address(weth)
        });
    }
}
