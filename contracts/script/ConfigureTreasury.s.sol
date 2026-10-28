// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

import "../src/PortfolioVault.sol";
import "../src/TreasuryRouter.sol";
import "./lib/MainnetGuards.sol";
import "./lib/TreasuryManifest.sol";

/**
 * @notice Configure TreasuryRouter and PortfolioVault after deployment.
 *
 * Required environment:
 * - DEPLOYER_PRIVATE_KEY (still the owner at this point)
 * - TREASURY_ROUTER
 * - PORTFOLIO_VAULT
 * - KEEPER (may be an ops EOA)
 *
 * Optional:
 * - DEX_ROUTER (required on mainnet; Uniswap V3 router)
 * - DEX_POOL_FEE (default 3000)
 * - TREASURY_TOTAL_USD (18 decimals; 0 = leave unchanged)
 * - DCA_AMOUNT_USD (18 decimals; 0 = DCA stays disabled)
 * - DCA_INTERVAL (default 7 days)
 * - MAX_SLIPPAGE_BPS (default 100)
 *
 * The portfolio basket is read from the enabled stocks in the network
 * manifest. Weights are split evenly with the remainder on the first target.
 * The `sell()` treasury recipient comes from `external.treasurySafe`; when the
 * manifest field is `null` (local/testnet) the constructor default is kept.
 * On mainnet the router, portfolio, DEX router, and treasury must match the
 * manifest.
 */
contract ConfigureTreasuryScript is Script {
    uint256 private constant DEFAULT_DCA_INTERVAL = 7 days;
    uint256 private constant DEFAULT_MAX_SLIPPAGE_BPS = 100;

    struct Settings {
        address router;
        address portfolio;
        address keeper;
        address dexRouter;
        address treasury;
        uint24 poolFee;
        uint256 treasuryTotalUsd;
        uint256 dcaAmountUsd;
        uint256 dcaInterval;
        uint256 maxSlippageBps;
    }

    function run() external {
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Settings memory settings = _readSettings();

        string memory json = _readManifest();
        settings.treasury = TreasuryManifest.readAddress(vm, json, ".external.treasurySafe");
        _validate(privateKey, settings, json);

        bool configureTargets = vm.parseJsonBool(json, ".features.stockTokens");
        TreasuryManifest.Targets memory targets;
        if (configureTargets) targets = TreasuryManifest.readTargets(vm, json);

        vm.startBroadcast(privateKey);
        _apply(settings, configureTargets, targets);
        vm.stopBroadcast();

        _log(settings, configureTargets, targets);
    }

    function _readSettings() private view returns (Settings memory settings) {
        settings.router = vm.envAddress("TREASURY_ROUTER");
        settings.portfolio = vm.envAddress("PORTFOLIO_VAULT");
        settings.keeper = vm.envAddress("KEEPER");
        settings.dexRouter = vm.envOr("DEX_ROUTER", address(0));
        settings.poolFee = uint24(vm.envOr("DEX_POOL_FEE", uint256(3000)));
        settings.treasuryTotalUsd = vm.envOr("TREASURY_TOTAL_USD", uint256(0));
        settings.dcaAmountUsd = vm.envOr("DCA_AMOUNT_USD", uint256(0));
        settings.dcaInterval = vm.envOr("DCA_INTERVAL", DEFAULT_DCA_INTERVAL);
        settings.maxSlippageBps = vm.envOr("MAX_SLIPPAGE_BPS", DEFAULT_MAX_SLIPPAGE_BPS);
    }

    function _validate(uint256 privateKey, Settings memory settings, string memory json) private view {
        MainnetGuards.TreasuryConfiguration memory config = MainnetGuards.TreasuryConfiguration({
            chainId: block.chainid,
            privateKey: privateKey,
            router: settings.router,
            portfolio: settings.portfolio,
            dexRouter: settings.dexRouter,
            keeper: settings.keeper,
            treasury: settings.treasury,
            manifestRouter: address(0),
            manifestPortfolio: address(0),
            manifestDexRouter: address(0),
            manifestTreasury: address(0)
        });

        if (block.chainid == MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID) {
            config.manifestRouter = TreasuryManifest.readAddress(vm, json, ".contracts.TreasuryRouter");
            config.manifestPortfolio = TreasuryManifest.readAddress(vm, json, ".contracts.PortfolioVault");
            config.manifestDexRouter = TreasuryManifest.readAddress(vm, json, ".external.dexRouter");
            config.manifestTreasury = TreasuryManifest.readAddress(vm, json, ".external.treasurySafe");
        }

        MainnetGuards.validateTreasuryConfiguration(config);
    }

    function _apply(Settings memory settings, bool configureTargets, TreasuryManifest.Targets memory targets) internal {
        TreasuryRouter router = TreasuryRouter(settings.router);
        PortfolioVault portfolio = PortfolioVault(settings.portfolio);

        router.setSplit(7000, 2000, 1000);
        router.setKeeper(settings.keeper);
        portfolio.setKeeper(settings.keeper);

        if (settings.dexRouter != address(0)) {
            router.setRouter(settings.dexRouter, settings.poolFee);
            portfolio.setRouter(settings.dexRouter, settings.poolFee);
        }

        if (configureTargets) {
            portfolio.setTargets(targets.tokens, targets.weights, targets.oracles);
        }
        if (settings.treasury != address(0)) portfolio.setTreasury(settings.treasury);
        if (settings.treasuryTotalUsd != 0) portfolio.setTreasuryTotalUsd(settings.treasuryTotalUsd);
        if (settings.dcaAmountUsd != 0) portfolio.setDcaAmountUsd(settings.dcaAmountUsd);
        portfolio.setDcaInterval(settings.dcaInterval);
        portfolio.setMaxSlippageBps(settings.maxSlippageBps);
    }

    function _log(Settings memory settings, bool configureTargets, TreasuryManifest.Targets memory targets)
        private
        pure
    {
        console.log("TreasuryRouter:", settings.router);
        console.log("PortfolioVault:", settings.portfolio);
        console.log("Keeper:", settings.keeper);
        console.log("Treasury:", settings.treasury);
        console.log("DEX router:", settings.dexRouter);
        console.log("Targets configured:", configureTargets);
        if (configureTargets) console.log("Target count:", targets.tokens.length);
    }

    function _readManifest() private view returns (string memory) {
        string memory file = block.chainid == MainnetGuards.ROBINHOOD_MAINNET_CHAIN_ID
            ? "/../config/networks/mainnet.json"
            : "/../config/networks/testnet.json";
        return vm.readFile(string.concat(vm.projectRoot(), file));
    }
}
