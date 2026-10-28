// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../script/lib/TreasuryManifest.sol";

/// @dev External wrapper so `vm.expectRevert` sees a revert below the cheatcode
/// call depth. Internal library calls are inlined into the caller.
contract TreasuryManifestHarness {
    function readTargets(Vm vm, string memory json) external view returns (TreasuryManifest.Targets memory) {
        return TreasuryManifest.readTargets(vm, json);
    }
}

contract TreasuryManifestTest is Test {
    address internal constant TOKEN_A = address(0xA11CE);
    address internal constant TOKEN_B = address(0xB0B);
    address internal constant TOKEN_C = address(0xC0FFEE);
    address internal constant ORACLE_A = address(0x0A11);
    address internal constant ORACLE_B = address(0x0B0B);
    address internal constant ORACLE_C = address(0x0C0C);

    TreasuryManifestHarness internal harness;

    function setUp() public {
        harness = new TreasuryManifestHarness();
    }

    function test_ReadsOnlyEnabledStocks() public view {
        string memory json = _manifest();

        TreasuryManifest.Targets memory targets = TreasuryManifest.readTargets(vm, json);

        assertEq(targets.tokens.length, 2);
        assertEq(targets.tokens[_indexOf(targets, "AAPL")], TOKEN_A);
        assertEq(targets.oracles[_indexOf(targets, "AAPL")], ORACLE_A);
        assertEq(targets.tokens[_indexOf(targets, "NVDA")], TOKEN_B);
        assertEq(targets.oracles[_indexOf(targets, "NVDA")], ORACLE_B);
        assertEq(targets.weights[0] + targets.weights[1], 10_000);
    }

    function test_SplitsRemainderToFirstTarget() public view {
        // Add a third enabled ticker through the same fixture builder.
        string memory json = string.concat(
            '{"stocks":{',
            _stock("AAPL", TOKEN_A, ORACLE_A, true),
            ",",
            _stock("NVDA", TOKEN_B, ORACLE_B, true),
            ",",
            _stock("MSFT", TOKEN_C, ORACLE_C, true),
            "}}"
        );

        TreasuryManifest.Targets memory targets = TreasuryManifest.readTargets(vm, json);

        assertEq(targets.tokens.length, 3);
        uint256 total;
        for (uint256 i; i < targets.tokens.length; ++i) {
            total += targets.weights[i];
        }
        assertEq(total, 10_000);
        assertEq(targets.weights[0], 3334);
        assertEq(targets.weights[1], 3333);
        assertEq(targets.weights[2], 3333);
    }

    function test_ReadsEightTargetsEvenly() public view {
        string memory json = '{"stocks":{';
        for (uint256 i; i < 8; ++i) {
            if (i != 0) json = string.concat(json, ",");
            json = string.concat(
                json,
                _stock(
                    string.concat("S", vm.toString(i)), address(uint160(0x1000 + i)), address(uint160(0x2000 + i)), true
                )
            );
        }
        json = string.concat(json, "}}");

        TreasuryManifest.Targets memory targets = TreasuryManifest.readTargets(vm, json);

        assertEq(targets.tokens.length, 8);
        for (uint256 i; i < 8; ++i) {
            assertEq(targets.weights[i], 1250);
        }
    }

    function test_IgnoresDisabledStocksWithNullFields() public view {
        string memory json = string.concat(
            '{"stocks":{',
            _stock("AAPL", TOKEN_A, ORACLE_A, true),
            ",",
            '"MSFT":{"address":null,"oracle":null,"enabled":false}',
            "}}"
        );

        TreasuryManifest.Targets memory targets = TreasuryManifest.readTargets(vm, json);

        assertEq(targets.tokens.length, 1);
        assertEq(targets.weights[0], 10_000);
    }

    function test_RevertsWithoutEnabledStocks() public {
        string memory json = string.concat('{"stocks":{', _stock("AAPL", TOKEN_A, ORACLE_A, false), "}}");

        vm.expectRevert(TreasuryManifest.NoEnabledStocks.selector);
        harness.readTargets(vm, json);
    }

    function test_RevertsAboveEightTargets() public {
        string memory json = '{"stocks":{';
        for (uint256 i; i < 9; ++i) {
            if (i != 0) json = string.concat(json, ",");
            json = string.concat(
                json,
                _stock(
                    string.concat("S", vm.toString(i)), address(uint160(0x1000 + i)), address(uint160(0x2000 + i)), true
                )
            );
        }
        json = string.concat(json, "}}");

        vm.expectRevert(abi.encodeWithSelector(TreasuryManifest.TooManyEnabledStocks.selector, 9));
        harness.readTargets(vm, json);
    }

    function test_RevertsOnMissingTokenAddress() public {
        string memory json = string.concat(
            '{"stocks":{', '"AAPL":{"address":null,"oracle":"', vm.toString(ORACLE_A), '","enabled":true}', "}}"
        );

        vm.expectRevert(abi.encodeWithSelector(TreasuryManifest.MissingStockAddress.selector, "AAPL", "address"));
        harness.readTargets(vm, json);
    }

    function test_RevertsOnMissingOracleAddress() public {
        string memory json = string.concat(
            '{"stocks":{', '"AAPL":{"address":"', vm.toString(TOKEN_A), '","oracle":null,"enabled":true}', "}}"
        );

        vm.expectRevert(abi.encodeWithSelector(TreasuryManifest.MissingStockAddress.selector, "AAPL", "oracle"));
        harness.readTargets(vm, json);
    }

    function test_ReadAddressTreatsMissingAndNullAsZero() public view {
        string memory json =
            string.concat('{"stocks":{"AAPL":{"address":null,"oracle":"', vm.toString(ORACLE_A), '"}}}');

        assertEq(TreasuryManifest.readAddress(vm, json, ".stocks.AAPL.address"), address(0));
        assertEq(TreasuryManifest.readAddress(vm, json, ".stocks.AAPL.oracle"), ORACLE_A);
        assertEq(TreasuryManifest.readAddress(vm, json, ".stocks.NVDA.address"), address(0));
    }

    function _manifest() internal pure returns (string memory) {
        return string.concat(
            '{"stocks":{',
            _stock("AAPL", TOKEN_A, ORACLE_A, true),
            ",",
            _stock("NVDA", TOKEN_B, ORACLE_B, true),
            ",",
            _stock("MSFT", TOKEN_C, ORACLE_C, false),
            "}}"
        );
    }

    function _stock(string memory ticker, address token, address oracle, bool enabled)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '"',
            ticker,
            '":{"address":"',
            vm.toString(token),
            '","oracle":"',
            vm.toString(oracle),
            '","enabled":',
            enabled ? "true" : "false",
            "}"
        );
    }

    function _indexOf(TreasuryManifest.Targets memory targets, string memory ticker) internal pure returns (uint256) {
        for (uint256 i; i < targets.tickers.length; ++i) {
            if (keccak256(bytes(targets.tickers[i])) == keccak256(bytes(ticker))) return i;
        }
        revert("ticker not found");
    }
}
