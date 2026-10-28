// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./PrincipalVault.sol";

/**
 * @title UsdgVault
 * @notice Principal-protected USDG vault.
 *
 * If no verified yield strategy exists, the vault runs idle. In idle mode no
 * yield is fabricated and B_usdg remains zero.
 */
contract UsdgVault is PrincipalVault {
    constructor(address usdg_, address initialTreasury_, address initialOperator_, address initialOwner_)
        PrincipalVault(usdg_, initialTreasury_, initialOperator_, initialOwner_)
    {}
}
