// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/StakeManager.sol";
import "../src/FeeSplitter.sol";
import "../src/BuybackBurner.sol";
import "./lib/MainnetGuards.sol";
import "./lib/ManifestReader.sol";

/**
 * @notice Wire core protocol parameters after deployment.
 *
 * Required env:
 * - DEPLOYER_PRIVATE_KEY (still the owner at this point)
 * - STAKE_MANAGER
 * - USDG_ADDRESS
 * - USDG_VAULT
 * - TREASURY_SAFE
 * - BUYBACK_BURNER
 *
 * Optional:
 * - USDG_DEPOSIT_CAP (0 = uncapped)
 * - FEE_SPLITTER
 * - BUYBACK_ROUTER (required on mainnet; Uniswap V3 router)
 * - BUYBACK_POOL_FEE
 * - KEEPER (buyback keeper; may be an ops EOA)
 *
 * On mainnet every contract address must match config/networks/mainnet.json.
 * This closes the gap where a mainnet run could enable staking against a
 * different vault, point the fee splitter at an EOA, or wire a mock router.
 */
contract ConfigureProtocolScript is Script {
    function run() external {
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address stakeManagerAddr = vm.envAddress("STAKE_MANAGER");
        address usdg = vm.envAddress("USDG_ADDRESS");
        address usdgVault = vm.envAddress("USDG_VAULT");
        address treasury = vm.envAddress("TREASURY_SAFE");
        address burnerAddr = vm.envAddress("BUYBACK_BURNER");
        address feeSplitterAddr = vm.envOr("FEE_SPLITTER", address(0));
        address buybackRouter = vm.envOr("BUYBACK_ROUTER", address(0));
        address keeper = vm.envOr("KEEPER", address(0));
        uint256 usdgCap = vm.envOr("USDG_DEPOSIT_CAP", uint256(0));

        MainnetGuards.ProtocolConfiguration memory config = MainnetGuards.ProtocolConfiguration({
            chainId: block.chainid,
            privateKey: privateKey,
            stakeManager: stakeManagerAddr,
            usdg: usdg,
            usdgVault: usdgVault,
            treasury: treasury,
            feeSplitter: feeSplitterAddr,
            burner: burnerAddr,
            buybackRouter: buybackRouter,
            keeper: keeper,
            manifestStakeManager: address(0),
            manifestUsdg: address(0),
            manifestUsdgVault: address(0),
            manifestTreasury: address(0),
            manifestFeeSplitter: address(0),
            manifestBurner: address(0),
            manifestBuybackRouter: address(0)
        });

        if (block.chainid == MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID) {
            string memory json = vm.readFile(ManifestReader.path(vm, "mainnet"));
            config.manifestStakeManager = ManifestReader.readAddress(vm, json, ".contracts.StakeManager");
            config.manifestUsdg = ManifestReader.readAddress(vm, json, ".tokens.USDG.address");
            config.manifestUsdgVault = ManifestReader.readAddress(vm, json, ".contracts.UsdgVault");
            config.manifestTreasury = ManifestReader.readAddress(vm, json, ".external.treasurySafe");
            config.manifestFeeSplitter = ManifestReader.readAddress(vm, json, ".contracts.FeeSplitter");
            config.manifestBurner = ManifestReader.readAddress(vm, json, ".contracts.BuybackBurner");
            config.manifestBuybackRouter = ManifestReader.readAddress(vm, json, ".external.dexRouter");
        }

        MainnetGuards.validateProtocolConfiguration(config);

        vm.startBroadcast(privateKey);

        StakeManager stakeManager = StakeManager(stakeManagerAddr);
        stakeManager.setAssetConfig(usdg, true, StakeManager.AssetKind.BASE, usdgVault, address(0), usdgCap);

        if (feeSplitterAddr != address(0)) {
            FeeSplitter(payable(feeSplitterAddr)).setRecipients(treasury, burnerAddr);
        }

        if (buybackRouter != address(0)) {
            uint24 poolFee = uint24(vm.envOr("BUYBACK_POOL_FEE", uint256(3000)));
            BuybackBurner(burnerAddr).setRouter(buybackRouter, poolFee);
        }

        if (keeper != address(0)) {
            BuybackBurner(burnerAddr).setKeeper(keeper);
        }

        vm.stopBroadcast();

        console.log("USDG enabled for staking:", usdg);
        console.log("USDG vault:", usdgVault);
        console.log("Treasury:", treasury);
    }
}
