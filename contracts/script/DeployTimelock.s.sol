// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @notice Deploy standard OpenZeppelin TimelockController for Tyrian Protocol governance.
 *
 * Environment variables:
 * - DEPLOYER_PRIVATE_KEY : EOA private key with native gas to deploy
 * - TREASURY_SAFE        : Gnosis Safe multisig address (e.g. 0x56e335892745ed42228525BF74da8755924Ad740)
 * - TIMELOCK_DELAY       : (Optional) Delay in seconds. Default is 48 hours (172800).
 * - ALLOW_PUBLIC_EXECUTE : (Optional) If true, address(0) is an executor (anyone can trigger execution after delay). Default: false.
 */
contract DeployTimelockScript is Script {
    uint256 public constant DEFAULT_DELAY = 48 hours; // 172,800 seconds

    function run() external returns (address timelockAddress) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        address safeMultisig = vm.envAddress("TREASURY_SAFE");
        require(safeMultisig != address(0), "TREASURY_SAFE cannot be zero");

        uint256 delay = vm.envOr("TIMELOCK_DELAY", DEFAULT_DELAY);
        require(delay >= 48 hours, "Timelock delay must be at least 48 hours");

        bool allowPublicExecute = vm.envOr("ALLOW_PUBLIC_EXECUTE", false);

        // Proposers: Only the Safe multisig can propose actions
        address[] memory proposers = new address[](1);
        proposers[0] = safeMultisig;

        // Executors: Safe multisig (or public address(0) if explicitly allowed)
        address[] memory executors;
        if (allowPublicExecute) {
            executors = new address[](2);
            executors[0] = safeMultisig;
            executors[1] = address(0);
        } else {
            executors = new address[](1);
            executors[0] = safeMultisig;
        }

        // Admin: Safe multisig holds DEFAULT_ADMIN_ROLE (deployer has no administrative role)
        address admin = safeMultisig;

        console.log("=== Deploying TimelockController ===");
        console.log("Chain ID         :", block.chainid);
        console.log("Deployer         :", deployer);
        console.log("Safe Multisig    :", safeMultisig);
        console.log("Min Delay        :", delay, "seconds (48 hours)");
        console.log("Public Execute   :", allowPublicExecute);

        vm.startBroadcast(deployerPrivateKey);

        TimelockController timelock = new TimelockController(
            delay,
            proposers,
            executors,
            admin
        );

        vm.stopBroadcast();

        timelockAddress = address(timelock);
        console.log("Timelock deployed successfully at:", timelockAddress);
        console.log("Proposer role    : Safe Multisig");
        console.log("Executor role    : Safe Multisig", allowPublicExecute ? "+ Public" : "");
        console.log("Admin role       : Safe Multisig");

        return timelockAddress;
    }
}
