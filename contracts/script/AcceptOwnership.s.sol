// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "./TransferOwnership.s.sol";

/**
 * @notice Complete the two-step ownership handover by making the timelock call
 * `acceptOwnership()` on every contract.
 *
 * `Ownable2Step` only accepts the new owner if `msg.sender` is the pending
 * owner. An EOA cannot impersonate a timelock, so the call has to travel inside
 * a timelock batch. This script builds that batch and either schedules or
 * executes it.
 *
 * Required env:
 * - TIMELOCK
 * - TIMELOCK_ACTION = schedule | execute
 * - TIMELOCK_PRIVATE_KEY (proposer for `schedule`, executor for `execute`)
 * - every address listed in TransferOwnership.s.sol
 *
 * Optional:
 * - TIMELOCK_SALT (default: "tyrian-accept-ownership")
 * - PRINT_ONLY=true (print the batch and exit without broadcasting)
 *
 * Typical sequence:
 *   1. TIMELOCK_ACTION=schedule bun run ... AcceptOwnership
 *   2. wait at least `getMinDelay()` (48 hours on mainnet)
 *   3. TIMELOCK_ACTION=execute bun run ... AcceptOwnership
 */
interface ITimelockController {
    function getMinDelay() external view returns (uint256);
    function hashOperationBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt
    ) external pure returns (bytes32);
    function scheduleBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) external;
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt
    ) external payable;
}

contract AcceptOwnershipScript is Script {
    bytes32 internal constant EMPTY_PREDECESSOR = bytes32(0);

    function run() external {
        address timelock = vm.envAddress("TIMELOCK");
        require(timelock != address(0) && timelock.code.length > 0, "timelock must be contract");

        string memory action = vm.envString("TIMELOCK_ACTION");
        require(
            keccak256(bytes(action)) == keccak256(bytes("schedule"))
                || keccak256(bytes(action)) == keccak256(bytes("execute")),
            "TIMELOCK_ACTION must be schedule or execute"
        );

        address[] memory targets = new TransferOwnershipScript().collectTargets();

        uint256[] memory values = new uint256[](targets.length);
        bytes[] memory payloads = new bytes[](targets.length);
        for (uint256 i; i < targets.length; ++i) {
            payloads[i] = abi.encodeWithSignature("acceptOwnership()");
        }

        bytes32 salt = keccak256(bytes(vm.envOr("TIMELOCK_SALT", string("tyrian-accept-ownership"))));
        bytes32 operationId =
            ITimelockController(timelock).hashOperationBatch(targets, values, payloads, EMPTY_PREDECESSOR, salt);
        uint256 minDelay = ITimelockController(timelock).getMinDelay();

        console.log("Timelock:", timelock);
        console.log("Action:", action);
        console.log("Targets:", targets.length);
        console.log("Min delay (seconds):", minDelay);
        console.logBytes32(operationId);

        if (vm.envOr("PRINT_ONLY", false)) {
            for (uint256 i; i < targets.length; ++i) {
                console.log("target:", targets[i]);
                console.logBytes(payloads[i]);
            }
            console.log("PRINT_ONLY=true, nothing broadcast");
            return;
        }

        uint256 privateKey = vm.envUint("TIMELOCK_PRIVATE_KEY");
        vm.startBroadcast(privateKey);

        if (keccak256(bytes(action)) == keccak256(bytes("schedule"))) {
            ITimelockController(timelock).scheduleBatch(
                targets, values, payloads, EMPTY_PREDECESSOR, salt, minDelay
            );
        } else {
            ITimelockController(timelock).executeBatch(targets, values, payloads, EMPTY_PREDECESSOR, salt);
        }

        vm.stopBroadcast();

        console.log("Batch submitted. Re-run VerifyMainnet after execution.");
    }
}
