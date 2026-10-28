// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "../../src/StakeManager.sol";
import "../../src/vaults/UsdgVault.sol";
import "../../src/FeeSplitter.sol";
import "../../src/BuybackBurner.sol";
import "../../src/TreasuryRouter.sol";
import "../../src/PortfolioVault.sol";
import "../../script/lib/TreasuryManifest.sol";

/**
 * @title ForkRobinhoodTestnetTest
 * @notice Fork test against live Robinhood Chain Testnet (Chain ID 46630).
 *
 * Verifies:
 * - Real EVM bytecode and opcodes on Robinhood Chain Arbitrum Orbit stack.
 * - Deployed protocol addresses from config/networks/testnet.json have non-zero bytecode.
 * - Live token metadata (symbol, decimals) on-chain.
 * - Live contract view functions and state queries.
 */
contract ForkRobinhoodTestnetTest is Test {
    uint256 internal forkId;
    bool internal forkActive;

    address internal stakeManagerAddr;
    address internal usdgVaultAddr;
    address internal feeSplitterAddr;
    address internal buybackBurnerAddr;
    address internal treasuryRouterAddr;
    address internal portfolioVaultAddr;

    address internal usdgAddr;
    address internal tyrAddr;
    address internal wethAddr;

    function setUp() public {
        // Attempt fork connection; gracefully skip if offline
        try vm.createSelectFork("robinhood_testnet") returns (uint256 id) {
            forkId = id;
            forkActive = true;
        } catch {
            emit log("Warning: robinhood_testnet RPC endpoint unreachable; skipping live fork calls.");
            return;
        }

        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../config/networks/testnet.json"));

        stakeManagerAddr = TreasuryManifest.readAddress(vm, json, ".contracts.StakeManager");
        usdgVaultAddr = TreasuryManifest.readAddress(vm, json, ".contracts.UsdgVault");
        feeSplitterAddr = TreasuryManifest.readAddress(vm, json, ".contracts.FeeSplitter");
        buybackBurnerAddr = TreasuryManifest.readAddress(vm, json, ".contracts.BuybackBurner");
        treasuryRouterAddr = TreasuryManifest.readAddress(vm, json, ".contracts.TreasuryRouter");
        portfolioVaultAddr = TreasuryManifest.readAddress(vm, json, ".contracts.PortfolioVault");

        usdgAddr = TreasuryManifest.readAddress(vm, json, ".tokens.USDG.address");
        tyrAddr = TreasuryManifest.readAddress(vm, json, ".tokens.TYR.address");
        wethAddr = TreasuryManifest.readAddress(vm, json, ".tokens.WETH.address");
    }

    modifier onlyWhenForkActive() {
        if (!forkActive) return;
        _;
    }

    function test_ForkChainId() public view onlyWhenForkActive {
        assertEq(block.chainid, 46630, "Must be Robinhood Chain Testnet");
    }

    function test_DeployedContractsHaveBytecode() public view onlyWhenForkActive {
        assertGt(stakeManagerAddr.code.length, 0, "StakeManager has no bytecode on-chain");
        assertGt(usdgVaultAddr.code.length, 0, "UsdgVault has no bytecode on-chain");
        assertGt(feeSplitterAddr.code.length, 0, "FeeSplitter has no bytecode on-chain");
        assertGt(buybackBurnerAddr.code.length, 0, "BuybackBurner has no bytecode on-chain");
        assertGt(treasuryRouterAddr.code.length, 0, "TreasuryRouter has no bytecode on-chain");
        assertGt(portfolioVaultAddr.code.length, 0, "PortfolioVault has no bytecode on-chain");
    }

    function test_LiveTokenMetadata() public view onlyWhenForkActive {
        assertGt(usdgAddr.code.length, 0, "USDG has no bytecode");
        assertGt(tyrAddr.code.length, 0, "TYR has no bytecode");
        assertGt(wethAddr.code.length, 0, "WETH has no bytecode");

        assertEq(IERC20Metadata(usdgAddr).symbol(), "USDG");
        assertEq(IERC20Metadata(usdgAddr).decimals(), 18);

        assertEq(IERC20Metadata(tyrAddr).symbol(), "TYR");
        assertEq(IERC20Metadata(tyrAddr).decimals(), 18);

        assertEq(IERC20Metadata(wethAddr).symbol(), "WETH");
        assertEq(IERC20Metadata(wethAddr).decimals(), 18);
    }

    function test_LiveContractViews() public view onlyWhenForkActive {
        // Test StakeManager live views
        StakeManager sm = StakeManager(stakeManagerAddr);
        assertEq(sm.paused(), false);
        (, , address configuredVault, , , ) = sm.assetConfig(usdgAddr);
        assertEq(configuredVault, usdgVaultAddr);

        // Test UsdgVault live views
        UsdgVault vault = UsdgVault(usdgVaultAddr);
        assertEq(vault.asset(), usdgAddr);
        assertEq(vault.paused(), false);

        // Test FeeSplitter live views
        FeeSplitter fs = FeeSplitter(payable(feeSplitterAddr));
        assertEq(fs.weth(), wethAddr);
        assertEq(fs.tyr(), tyrAddr);

        // Test BuybackBurner live views
        BuybackBurner bb = BuybackBurner(buybackBurnerAddr);
        assertEq(bb.weth(), wethAddr);
        assertEq(bb.tyrToken(), tyrAddr);
    }
}
