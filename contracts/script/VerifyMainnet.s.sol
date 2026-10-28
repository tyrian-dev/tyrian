// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "../src/StakeManager.sol";
import "../src/FeeSplitter.sol";
import "../src/BuybackBurner.sol";
import "../src/TreasuryRouter.sol";
import "../src/PortfolioVault.sol";
import "../src/vaults/UsdgVault.sol";
import "../src/vaults/StockVault.sol";
import "../src/oracles/StockPriceOracle.sol";
import "../src/oracles/TyrTwapOracle.sol";

interface ISafeView {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

interface ITimelockView {
    function getMinDelay() external view returns (uint256);
}

/**
 * @notice Fail-closed post-deploy verification.
 *
 * This checks the whole ownership surface, not just the four core contracts.
 * Previously `TreasuryRouter`, `PortfolioVault`, `StockPriceOracle`, and
 * `TyrTwapOracle` were left out, so the script could print "passed" while an
 * EOA still controlled the portfolio vault and could redirect `sell()` proceeds.
 *
 * The check itself lives in `verify(Input)`, which takes an explicit struct so
 * the rehearsal can exercise every rejection path without touching process-wide
 * env vars. `run()` only reads env and delegates.
 *
 * Required env for `run()`:
 * - EXPECTED_CHAIN_ID (4663 for mainnet)
 * - TIMELOCK, TREASURY_SAFE
 * - STAKE_MANAGER, USDG_VAULT, USDG_ADDRESS
 * - FEE_SPLITTER, BUYBACK_BURNER
 * - TREASURY_ROUTER, PORTFOLIO_VAULT
 *
 * Optional:
 * - TREASURY_BUDGET, TREASURY_RESERVE (checked against router recipients)
 * - STOCK_VAULT_COUNT, STOCK_VAULT_1..N
 * - STOCK_TOKEN_1..N, STOCK_FEED_1..N
 * - STOCK_ORACLE_COUNT, STOCK_ORACLE_1..N
 * - TYR_TWAP_ORACLE
 * - MIN_SAFE_THRESHOLD (default 2), MIN_SAFE_OWNERS (default 3)
 * - MIN_TIMELOCK_DELAY (default 172800 = 48 hours)
 *
 * Every check reverts with the failing field. There is no "warn and continue".
 */
contract VerifyMainnetScript is Script {
    uint256 internal constant DEFAULT_MIN_SAFE_THRESHOLD = 2;
    uint256 internal constant DEFAULT_MIN_SAFE_OWNERS = 3;
    uint256 internal constant DEFAULT_MIN_TIMELOCK_DELAY = 48 hours;

    struct Input {
        uint256 expectedChainId;
        address timelock;
        address treasury;
        address stakeManager;
        address usdgVault;
        address usdg;
        address feeSplitter;
        address burner;
        address router;
        address portfolio;
        address budget;
        address reserve;
        address tyrOracle;
        address[] stockVaults;
        address[] stockTokens;
        address[] stockFeeds;
        address[] stockOracles;
        uint256 minSafeThreshold;
        uint256 minSafeOwners;
        uint256 minTimelockDelay;
    }

    function run() external view {
        verify(readEnv());
        console.log("mainnet verification passed");
    }

    function readEnv() public view returns (Input memory input) {
        input.expectedChainId = vm.envUint("EXPECTED_CHAIN_ID");
        input.timelock = vm.envAddress("TIMELOCK");
        input.treasury = vm.envAddress("TREASURY_SAFE");
        input.stakeManager = vm.envAddress("STAKE_MANAGER");
        input.usdgVault = vm.envAddress("USDG_VAULT");
        input.usdg = vm.envAddress("USDG_ADDRESS");
        input.feeSplitter = vm.envAddress("FEE_SPLITTER");
        input.burner = vm.envAddress("BUYBACK_BURNER");
        input.router = vm.envAddress("TREASURY_ROUTER");
        input.portfolio = vm.envAddress("PORTFOLIO_VAULT");
        input.budget = vm.envOr("TREASURY_BUDGET", address(0));
        input.reserve = vm.envOr("TREASURY_RESERVE", address(0));
        input.tyrOracle = vm.envOr("TYR_TWAP_ORACLE", address(0));
        input.minSafeThreshold = vm.envOr("MIN_SAFE_THRESHOLD", DEFAULT_MIN_SAFE_THRESHOLD);
        input.minSafeOwners = vm.envOr("MIN_SAFE_OWNERS", DEFAULT_MIN_SAFE_OWNERS);
        input.minTimelockDelay = vm.envOr("MIN_TIMELOCK_DELAY", DEFAULT_MIN_TIMELOCK_DELAY);

        uint256 stockVaultCount = vm.envOr("STOCK_VAULT_COUNT", uint256(0));
        input.stockVaults = new address[](stockVaultCount);
        input.stockTokens = new address[](stockVaultCount);
        input.stockFeeds = new address[](stockVaultCount);
        for (uint256 i; i < stockVaultCount; ++i) {
            string memory suffix = vm.toString(i + 1);
            input.stockVaults[i] = vm.envAddress(string.concat("STOCK_VAULT_", suffix));
            input.stockTokens[i] = vm.envAddress(string.concat("STOCK_TOKEN_", suffix));
            input.stockFeeds[i] = vm.envAddress(string.concat("STOCK_FEED_", suffix));
        }

        uint256 stockOracleCount = vm.envOr("STOCK_ORACLE_COUNT", uint256(0));
        input.stockOracles = new address[](stockOracleCount);
        for (uint256 i; i < stockOracleCount; ++i) {
            input.stockOracles[i] = vm.envAddress(string.concat("STOCK_ORACLE_", vm.toString(i + 1)));
        }
    }

    function verify(Input memory input) public view {
        require(block.chainid == input.expectedChainId, "wrong chain");

        _requireCoreContracts(input);
        _verifyOwnership(input);
        _verifyTreasury(input);
        _verifyStaking(input);
        _verifyStockVaults(input);
        _verifyGovernance(input);
    }

    function _requireCoreContracts(Input memory input) internal view {
        _requireContract(input.timelock);
        _requireContract(input.treasury);
        _requireContract(input.stakeManager);
        _requireContract(input.usdgVault);
        _requireContract(input.usdg);
        _requireContract(input.feeSplitter);
        _requireContract(input.burner);
        _requireContract(input.router);
        _requireContract(input.portfolio);
    }

    /// @dev Every contract that can move funds or change parameters must be
    /// owned by the timelock. A missing entry here is how the previous handover
    /// silently skipped the treasury and oracles.
    function _verifyOwnership(Input memory input) internal view {
        require(Ownable2Step(input.stakeManager).owner() == input.timelock, "StakeManager owner");
        require(Ownable2Step(input.usdgVault).owner() == input.timelock, "UsdgVault owner");
        require(Ownable2Step(input.feeSplitter).owner() == input.timelock, "FeeSplitter owner");
        require(Ownable2Step(input.burner).owner() == input.timelock, "BuybackBurner owner");
        require(Ownable2Step(input.router).owner() == input.timelock, "TreasuryRouter owner");
        require(Ownable2Step(input.portfolio).owner() == input.timelock, "PortfolioVault owner");

        if (input.tyrOracle != address(0)) {
            _requireContract(input.tyrOracle);
            require(Ownable2Step(input.tyrOracle).owner() == input.timelock, "TyrTwapOracle owner");
            require(TyrTwapOracle(input.tyrOracle).tyrToken() != address(0), "TyrTwapOracle tyr token");
            require(TyrTwapOracle(input.tyrOracle).quoteToken() != address(0), "TyrTwapOracle quote token");
        }

        for (uint256 i; i < input.stockOracles.length; ++i) {
            address stockOracle = input.stockOracles[i];
            _requireContract(stockOracle);
            require(Ownable2Step(stockOracle).owner() == input.timelock, "StockPriceOracle owner");
            require(StockPriceOracle(stockOracle).stockToken() != address(0), "StockPriceOracle token");
            require(StockPriceOracle(stockOracle).feed() != address(0), "StockPriceOracle feed");
        }
    }

    function _verifyTreasury(Input memory input) internal view {
        TreasuryRouter router = TreasuryRouter(input.router);

        require(router.usdg() == input.usdg, "router usdg mismatch");
        require(router.portfolio() == input.portfolio, "router portfolio mismatch");
        require(
            router.budgetBps() + router.reserveBps() + router.portfolioBps() == router.BPS_DENOMINATOR(),
            "router split must equal 100%"
        );
        require(router.keeper() != address(0), "router keeper not set");

        if (input.budget != address(0)) require(router.budget() == input.budget, "router budget mismatch");
        if (input.reserve != address(0)) require(router.reserve() == input.reserve, "router reserve mismatch");

        PortfolioVault portfolio = PortfolioVault(input.portfolio);
        require(portfolio.usdg() == input.usdg, "portfolio usdg mismatch");
        require(portfolio.treasury() == input.treasury, "portfolio treasury mismatch");
        require(portfolio.keeper() != address(0), "portfolio keeper not set");

        require(FeeSplitter(payable(input.feeSplitter)).treasury() == input.treasury, "fee treasury mismatch");
        require(
            FeeSplitter(payable(input.feeSplitter)).buybackBurner() == input.burner, "fee burner mismatch"
        );
        require(BuybackBurner(input.burner).swapRouter() != address(0), "buyback router not set");
    }

    function _verifyStaking(Input memory input) internal view {
        UsdgVault vault = UsdgVault(input.usdgVault);
        require(vault.asset() == input.usdg, "vault asset mismatch");
        require(vault.treasury() == input.treasury, "vault treasury mismatch");
        require(vault.operator() == input.stakeManager, "vault operator mismatch");

        (bool enabled,, address configuredVault,,,) = StakeManager(input.stakeManager).assetConfig(input.usdg);
        require(enabled, "USDG not enabled in StakeManager");
        require(configuredVault == input.usdgVault, "USDG vault mismatch");
    }

    function _verifyStockVaults(Input memory input) internal view {
        require(
            input.stockVaults.length == input.stockTokens.length
                && input.stockVaults.length == input.stockFeeds.length,
            "stock vault env length mismatch"
        );

        for (uint256 i; i < input.stockVaults.length; ++i) {
            address stockVault = input.stockVaults[i];
            address stockToken = input.stockTokens[i];
            address stockFeed = input.stockFeeds[i];

            _requireContract(stockVault);
            _requireContract(stockToken);
            _requireContract(stockFeed);

            require(Ownable2Step(stockVault).owner() == input.timelock, "StockVault owner");
            require(StockVault(stockVault).asset() == stockToken, "stock vault asset mismatch");
            require(StockVault(stockVault).treasury() == input.treasury, "stock vault treasury mismatch");
            require(StockVault(stockVault).priceFeed() == stockFeed, "stock vault feed mismatch");
            require(StockVault(stockVault).operator() == input.stakeManager, "stock vault operator mismatch");
        }
    }

    /// @dev A 1-of-N Safe and a short timelock are the same single-key risk the
    /// handover is meant to remove, so both are verified with explicit minimums.
    function _verifyGovernance(Input memory input) internal view {
        try ISafeView(input.treasury).getThreshold() returns (uint256 threshold) {
            require(threshold >= input.minSafeThreshold, "Safe threshold below minimum");
        } catch {
            revert("treasury Safe getThreshold failed");
        }

        try ISafeView(input.treasury).getOwners() returns (address[] memory owners) {
            require(owners.length >= input.minSafeOwners, "Safe owners below minimum");
        } catch {
            revert("treasury Safe getOwners failed");
        }

        try ITimelockView(input.timelock).getMinDelay() returns (uint256 delay) {
            require(delay >= input.minTimelockDelay, "timelock delay below minimum");
        } catch {
            revert("timelock getMinDelay failed");
        }
    }

    function _requireContract(address account) internal view {
        require(account != address(0), "zero address");
        require(account.code.length > 0, "not a contract");
    }
}
