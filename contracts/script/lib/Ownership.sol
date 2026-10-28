// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title Ownership
 * @notice Two-step ownership handover helper shared by deploy scripts and tests.
 *
 * `Ownable2Step` needs two transactions: the current owner calls
 * `transferOwnership(timelock)` and the timelock later calls
 * `acceptOwnership()` itself. This library only performs the first half, so it
 * can run from the deployer key and be unit tested without forking mainnet.
 *
 * Rules:
 * - Every target must be a contract; an EOA in the list is a configuration
 *   mistake, not something to skip silently.
 * - A target already owned by the timelock is skipped, so a rerun after a
 *   partial failure is safe (idempotent).
 * - A target owned by anybody else reverts instead of stealing or ignoring it.
 * - The timelock must be a contract. An EOA "timelock" would leave the same
 *   single-key control this handover is meant to remove.
 */
library Ownership {
    error NotContract(address target);
    error TimelockMustBeContract();
    error UnexpectedOwner(address target, address current, address expected);
    error NotPendingOwner(address target, address pending, address expected);

    /**
     * @notice Start the two-step handover for every target.
     * @param targets Contracts that extend Ownable2Step.
     * @param timelock Final owner (timelock controller or Safe-controlled executor).
     * @param deployer Current owner expected on every target.
     */
    function transferAll(address[] memory targets, address timelock, address deployer) internal {
        if (timelock == address(0) || timelock.code.length == 0) revert TimelockMustBeContract();

        for (uint256 i; i < targets.length; ++i) {
            address target = targets[i];
            if (target == address(0) || target.code.length == 0) revert NotContract(target);

            address current = Ownable2Step(target).owner();
            if (current == timelock) continue;
            if (current != deployer) revert UnexpectedOwner(target, current, deployer);

            Ownable2Step(target).transferOwnership(timelock);
        }
    }

    /**
     * @notice Complete the handover. Only a contract that is the pending owner
     * can call this, which in production is the timelock executing a batch.
     */
    function acceptAll(address[] memory targets, address caller) internal {
        for (uint256 i; i < targets.length; ++i) {
            address target = targets[i];
            address pending = Ownable2Step(target).pendingOwner();
            if (pending != caller) revert NotPendingOwner(target, pending, caller);
            Ownable2Step(target).acceptOwnership();
        }
    }

    /**
     * @notice Read the current owner of every target, for script logging.
     */
    function owners(address[] memory targets) internal view returns (address[] memory result) {
        result = new address[](targets.length);
        for (uint256 i; i < targets.length; ++i) {
            result[i] = Ownable2Step(targets[i]).owner();
        }
    }
}
