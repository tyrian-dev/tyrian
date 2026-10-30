// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/StakeManager.sol";
import "../src/FeeSplitter.sol";
import "../src/BuybackBurner.sol";
import "../src/vaults/UsdgVault.sol";
import "./lib/MainnetGuards.sol";

/**
 * @notice Deploy real protocol contracts. No mocks, no zero addresses.
 *
 * Required environment:
 * - DEPLOYER_PRIVATE_KEY
 * - TREASURY_SAFE
 * - GUARDIAN
 * - USDG_ADDRESS
 * - TYR_ADDRESS
 * - WETH_ADDRESS
 *
 * Optional:
 * - PROTOCOL_OWNER (expected final owner, for the mainnet guard only; contracts
 *   start owned by the deployer and are transferred later)
 *
 * Mainnet guard rejects EOA treasury/guardian, zero addresses, the Anvil key,
 * and token/Safe addresses that do not match config/networks/mainnet.json.
 * Fill the token and Safe entries in the manifest before the first mainnet
 * deploy; core contract addresses are filled after deployment.
 */
contract DeployProtocolScript is Script {
    function run() external {
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(privateKey);

        address treasury = vm.envAddress("TREASURY_SAFE");
        address guardian = vm.envAddress("GUARDIAN");
        address usdg = vm.envAddress("USDG_ADDRESS");
        address tyr = vm.envOr("TYRN_ADDRESS", vm.envOr("TYR_ADDRESS", address(0)));
        address weth = vm.envAddress("WETH_ADDRESS");
        address owner = vm.envOr("PROTOCOL_OWNER", deployer);

        MainnetGuards.DeployConfig memory config = MainnetGuards.DeployConfig({
            chainId: block.chainid,
            deployer: deployer,
            treasury: treasury,
            guardian: guardian,
            usdg: usdg,
            tyr: tyr,
            weth: weth,
            owner: owner,
            privateKey: privateKey,
            manifestTreasury: address(0),
            manifestGuardian: address(0),
            manifestUsdg: address(0),
            manifestTyr: address(0),
            manifestWeth: address(0)
        });

        if (block.chainid == MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID) {
            string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../config/networks/mainnet.json"));
            config.manifestTreasury = _manifestAddress(json, ".external.treasurySafe");
            config.manifestGuardian = _manifestAddress(json, ".external.guardian");
            config.manifestUsdg = _manifestAddress(json, ".tokens.USDG.address");
            config.manifestTyr = _manifestAddress(json, ".tokens.TYRN.address");
            config.manifestWeth = _manifestAddress(json, ".tokens.WETH.address");
        }

        MainnetGuards.validate(config);

        vm.startBroadcast(privateKey);

        StakeManager stakeManager = new StakeManager(deployer);
        UsdgVault usdgVault = new UsdgVault(usdg, treasury, address(stakeManager), deployer);
        BuybackBurner burner = new BuybackBurner(tyr, weth, deployer);
        FeeSplitter feeSplitter = new FeeSplitter(weth, tyr, treasury, address(burner), deployer);

        // Owner is still the deployer here. Hand ownership to the timelock in
        // TransferOwnership after configuration is complete.
        stakeManager.setGuardian(guardian);
        usdgVault.setGuardian(guardian);

        vm.stopBroadcast();

        console.log("Chain ID:", block.chainid);
        console.log("StakeManager:", address(stakeManager));
        console.log("UsdgVault:", address(usdgVault));
        console.log("BuybackBurner:", address(burner));
        console.log("FeeSplitter:", address(feeSplitter));
        console.log("Final owner (set by TransferOwnership):", owner);
    }

    function _manifestAddress(string memory json, string memory key) private view returns (address) {
        if (!vm.keyExistsJson(json, key)) return address(0);

        // A `null` entry exists as a key but cannot be parsed as an address.
        // Treat any parse failure as "not configured yet" so the guard reports
        // the manifest field instead of an opaque cheatcode error.
        (bool ok, bytes memory data) =
            address(vm).staticcall(abi.encodeWithSignature("parseJsonAddress(string,string)", json, key));
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }
}
