// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Vm.sol";

/**
 * @title ManifestReader
 * @notice Shared reader for `config/networks/*.json` inside forge scripts.
 *
 * `null` entries exist as keys but cannot be parsed as an address. Both a
 * missing key and a `null` value mean "not configured yet" (zero address) so
 * `MainnetGuards.requireManifestMatch` can name the failing field instead of
 * surfacing an opaque cheatcode error.
 */
library ManifestReader {
    function path(Vm vm, string memory networkName) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../config/networks/", networkName, ".json");
    }

    function readAddress(Vm vm, string memory json, string memory key) internal view returns (address) {
        if (!vm.keyExistsJson(json, key)) return address(0);

        (bool ok, bytes memory data) =
            address(vm).staticcall(abi.encodeWithSignature("parseJsonAddress(string,string)", json, key));
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }

    function readBool(Vm vm, string memory json, string memory key) internal view returns (bool) {
        if (!vm.keyExistsJson(json, key)) return false;
        (bool ok, bytes memory data) =
            address(vm).staticcall(abi.encodeWithSignature("parseJsonBool(string,string)", json, key));
        if (!ok || data.length < 32) return false;
        return abi.decode(data, (bool));
    }
}
