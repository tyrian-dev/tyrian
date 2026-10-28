// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Vm.sol";

/**
 * @title TreasuryManifest
 * @notice Reads the PortfolioVault target basket from the network manifest.
 *
 * The manifest stays the single source of truth: ConfigureTreasury does not
 * accept a hand-written target list. Only stocks with `enabled: true` are
 * included. Weights are split evenly because the brief does not assign
 * per-ticker weights; the rounding remainder goes to the first target so the
 * sum is exactly 10000 bps.
 */
library TreasuryManifest {
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant MAX_TARGETS = 8;

    struct Targets {
        address[] tokens;
        address[] oracles;
        uint16[] weights;
        string[] tickers;
    }

    error NoEnabledStocks();
    error TooManyEnabledStocks(uint256 count);
    error MissingStockAddress(string ticker, string field);

    function readTargets(Vm vm, string memory json) internal view returns (Targets memory targets) {
        string[] memory allTickers = vm.parseJsonKeys(json, ".stocks");

        address[] memory tokens = new address[](allTickers.length);
        address[] memory oracles = new address[](allTickers.length);
        string[] memory tickers = new string[](allTickers.length);
        uint256 count;

        for (uint256 i; i < allTickers.length; ++i) {
            string memory ticker = allTickers[i];
            string memory base = string.concat(".stocks.", ticker);
            if (!vm.parseJsonBool(json, string.concat(base, ".enabled"))) continue;

            address token = readAddress(vm, json, string.concat(base, ".address"));
            if (token == address(0)) revert MissingStockAddress(ticker, "address");

            address oracle = readAddress(vm, json, string.concat(base, ".oracle"));
            if (oracle == address(0)) revert MissingStockAddress(ticker, "oracle");

            tokens[count] = token;
            oracles[count] = oracle;
            tickers[count] = ticker;
            ++count;
        }

        if (count == 0) revert NoEnabledStocks();
        if (count > MAX_TARGETS) revert TooManyEnabledStocks(count);

        targets.tokens = new address[](count);
        targets.oracles = new address[](count);
        targets.weights = new uint16[](count);
        targets.tickers = new string[](count);

        uint16 baseWeight = uint16(BPS_DENOMINATOR / count);
        uint16 assigned;
        for (uint256 i; i < count; ++i) {
            targets.tokens[i] = tokens[i];
            targets.oracles[i] = oracles[i];
            targets.tickers[i] = tickers[i];
            targets.weights[i] = baseWeight;
            assigned += baseWeight;
        }
        // 10000 is not divisible by 3, 6, 7, ...; the remainder stays with the
        // first target instead of being left unassigned.
        targets.weights[0] += uint16(BPS_DENOMINATOR - assigned);
    }

    /**
     * @notice Read a manifest address, treating `null`/missing as zero.
     */
    function readAddress(Vm vm, string memory json, string memory key) internal view returns (address) {
        if (!vm.keyExistsJson(json, key)) return address(0);

        // A `null` entry exists as a key but cannot be parsed as an address.
        // Treat any parse failure as "not configured" so callers can report the
        // manifest field instead of an opaque cheatcode error.
        (bool ok, bytes memory data) =
            address(vm).staticcall(abi.encodeWithSignature("parseJsonAddress(string,string)", json, key));
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }
}
