// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/StakeManager.sol";
import "../src/FeeSplitter.sol";
import "../src/BuybackBurner.sol";
import "../src/vaults/UsdgVault.sol";
import "../src/vaults/StockVault.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockWETH.sol";
import "../src/mocks/MockAggregatorV3.sol";

/**
 * @notice Local/testnet convenience deployer. Never use for mainnet.
 * Production uses DeployProtocol + ConfigureProtocol + TransferOwnership.
 */
contract DeployTyrianScript is Script {
    uint256 private constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        require(block.chainid == 31337 || block.chainid == 46630, "DeployTyrian: local/testnet only");

        uint256 deployerPrivateKey;
        if (block.chainid == 46630) {
            deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
            require(deployerPrivateKey != ANVIL_KEY, "DeployTyrian: cannot use default Anvil key on testnet");
        } else {
            deployerPrivateKey = vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_KEY);
        }
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        MockERC20 mockUsdg = new MockERC20("Robinhood USDG", "USDG", 18);
        MockERC20 mockTyr = new MockERC20("Tyrian", "TYRN", 18);
        MockWETH mockWeth = new MockWETH();
        MockERC20 mockTsla = new MockERC20("Tesla Tokenized Stock", "TSLA", 18);
        MockAggregatorV3 mockTslaFeed = new MockAggregatorV3(8, 250_00000000);

        StakeManager stakeManager = new StakeManager(deployer);
        UsdgVault usdgVault = new UsdgVault(address(mockUsdg), deployer, address(stakeManager), deployer);
        StockVault stockVault = new StockVault(
            address(mockTsla), "TSLA", address(mockTslaFeed), 500_000 ether, deployer, address(stakeManager), deployer
        );
        BuybackBurner burner = new BuybackBurner(address(mockTyr), address(mockWeth), deployer);
        FeeSplitter feeSplitter =
            new FeeSplitter(address(mockWeth), address(mockTyr), deployer, address(burner), deployer);

        stakeManager.setAssetConfig(
            address(mockUsdg), true, StakeManager.AssetKind.BASE, address(usdgVault), address(0), 0
        );
        stakeManager.setAssetConfig(
            address(mockTsla),
            true,
            StakeManager.AssetKind.STOCK,
            address(stockVault),
            address(mockTslaFeed),
            500_000 ether
        );

        vm.stopBroadcast();

        console.log("--- Tyrian local/testnet deployment ---");
        console.log("Deployer:", deployer);
        console.log("StakeManager:", address(stakeManager));
        console.log("UsdgVault:", address(usdgVault));
        console.log("StockVault:", address(stockVault));
        console.log("FeeSplitter:", address(feeSplitter));
        console.log("BuybackBurner:", address(burner));
        console.log("MockUSDG:", address(mockUsdg));
        console.log("MockTYR:", address(mockTyr));
        console.log("MockWETH:", address(mockWeth));
        console.log("MockTSLA:", address(mockTsla));
    }
}
