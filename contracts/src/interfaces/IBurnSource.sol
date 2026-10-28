// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @notice Identifies why TYR was burned. Indexers must store this value.
 */
enum BurnSource {
    FEE,
    BUYBACK
}
