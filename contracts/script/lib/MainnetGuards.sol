// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @notice Address and chain guards shared by deploy scripts.
 *
 * The functions are `internal` and free of `vm` calls so unit tests can exercise
 * every rejection path without forking mainnet. Scripts read the network
 * manifest and pass the expected addresses in `DeployConfig`.
 *
 * Local and testnet deployments only get the chain and zero-address checks.
 * Mainnet additionally rejects the default Anvil key, EOAs acting as
 * treasury/guardian/owner, non-contract tokens, and addresses that do not match
 * the verified manifest.
 */
library MainnetGuards {
    uint256 internal constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant LOCAL_CHAIN_ID = 31337;
    uint256 internal constant ROBINHOOD_TESTNET_CHAIN_ID = 46630;
    uint256 internal constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;

    error UnsupportedChain(uint256 chainId);
    error ZeroTokenAddress();
    error ZeroAddress();
    error DefaultDeployerKeyOnMainnet();
    error DeployerMustNotBeTreasury();
    error DeployerMustNotBeGuardian();
    error DeployerMustNotBeOwner();
    error TreasuryMustBeContract();
    error GuardianMustBeContract();
    error OwnerMustBeContract();
    error TokenMustBeContract();
    error BadTreasury();
    error ReservesMustDiffer();
    error TreasuryRecipientMustBeContract();
    error RouterMustBeContract();
    error ManifestAddressMissing(string field);
    error ManifestAddressMismatch(string field);
    error InvalidDepositCap();

    struct DeployConfig {
        uint256 chainId;
        address deployer;
        address treasury;
        address guardian;
        address usdg;
        address tyr;
        address weth;
        address owner;
        uint256 privateKey;
        // Expected values from config/networks/mainnet.json. Ignored outside
        // mainnet; on mainnet a zero value means "not configured yet".
        address manifestTreasury;
        address manifestGuardian;
        address manifestUsdg;
        address manifestTyr;
        address manifestWeth;
    }

    function validate(DeployConfig memory config) internal view {
        if (!isSupportedChain(config.chainId)) revert UnsupportedChain(config.chainId);
        if (config.usdg == address(0) || config.tyr == address(0) || config.weth == address(0)) {
            revert ZeroTokenAddress();
        }

        if (config.chainId != ROBINHOOD_MAINNET_CHAIN_ID) return;

        if (config.privateKey == ANVIL_KEY) revert DefaultDeployerKeyOnMainnet();
        if (config.deployer == config.treasury) revert DeployerMustNotBeTreasury();
        if (config.deployer == config.guardian) revert DeployerMustNotBeGuardian();
        if (config.deployer == config.owner) revert DeployerMustNotBeOwner();
        if (config.treasury.code.length == 0) revert TreasuryMustBeContract();
        if (config.guardian.code.length == 0) revert GuardianMustBeContract();
        if (config.owner.code.length == 0) revert OwnerMustBeContract();
        if (config.usdg.code.length == 0 || config.tyr.code.length == 0 || config.weth.code.length == 0) {
            revert TokenMustBeContract();
        }
        if (config.treasury == config.usdg || config.treasury == config.tyr || config.treasury == config.weth) {
            revert BadTreasury();
        }

        requireManifestMatch(config.usdg, config.manifestUsdg, "tokens.USDG.address");
        requireManifestMatch(config.tyr, config.manifestTyr, "tokens.TYRN.address");
        requireManifestMatch(config.weth, config.manifestWeth, "tokens.WETH.address");
        requireManifestMatch(config.treasury, config.manifestTreasury, "external.treasurySafe");
        requireManifestMatch(config.guardian, config.manifestGuardian, "external.guardian");
    }

    struct TreasuryConfig {
        uint256 chainId;
        address deployer;
        address owner;
        address guardian;
        address budget;
        address reserve;
        address usdg;
        address weth;
        uint256 privateKey;
        // Expected values from config/networks/mainnet.json. Ignored outside
        // mainnet; on mainnet a zero value means "not configured yet".
        address manifestBudget;
        address manifestReserve;
        address manifestGuardian;
        address manifestUsdg;
        address manifestWeth;
    }

    /**
     * @notice Guard for TreasuryRouter and PortfolioVault deployment.
     *
     * Budget and reserve must differ because TreasuryRouter refuses to split
     * into the same recipient twice. On mainnet every recipient must be a
     * contract and match the verified manifest.
     */
    function validateTreasury(TreasuryConfig memory config) internal view {
        if (!isSupportedChain(config.chainId)) revert UnsupportedChain(config.chainId);
        if (config.usdg == address(0) || config.weth == address(0)) revert ZeroTokenAddress();
        if (config.budget == address(0) || config.reserve == address(0) || config.guardian == address(0)) {
            revert ZeroAddress();
        }
        if (config.budget == config.reserve) revert ReservesMustDiffer();

        if (config.chainId != ROBINHOOD_MAINNET_CHAIN_ID) return;

        if (config.privateKey == ANVIL_KEY) revert DefaultDeployerKeyOnMainnet();
        if (config.deployer == config.owner) revert DeployerMustNotBeOwner();
        if (config.deployer == config.guardian) revert DeployerMustNotBeGuardian();
        if (config.deployer == config.budget || config.deployer == config.reserve) {
            revert DeployerMustNotBeTreasury();
        }
        if (config.owner.code.length == 0) revert OwnerMustBeContract();
        if (config.guardian.code.length == 0) revert GuardianMustBeContract();
        if (config.budget.code.length == 0 || config.reserve.code.length == 0) {
            revert TreasuryRecipientMustBeContract();
        }
        if (config.usdg.code.length == 0 || config.weth.code.length == 0) revert TokenMustBeContract();
        if (config.budget == config.usdg || config.budget == config.weth) revert BadTreasury();
        if (config.reserve == config.usdg || config.reserve == config.weth) revert BadTreasury();

        requireManifestMatch(config.usdg, config.manifestUsdg, "tokens.USDG.address");
        requireManifestMatch(config.weth, config.manifestWeth, "tokens.WETH.address");
        requireManifestMatch(config.budget, config.manifestBudget, "external.budget");
        requireManifestMatch(config.reserve, config.manifestReserve, "external.reserve");
        requireManifestMatch(config.guardian, config.manifestGuardian, "external.guardian");
    }

    struct StockOracleConfig {
        uint256 chainId;
        address deployer;
        address owner;
        address token;
        address feed;
        uint256 privateKey;
        string ticker;
        // Expected values from config/networks/mainnet.json
        // (`stocks.<TICKER>.address` and `stocks.<TICKER>.feed`).
        address manifestToken;
        address manifestFeed;
    }

    /**
     * @notice Guard for the per-ticker StockPriceOracle deployment.
     *
     * The oracle is deployed once per ticker, so the token and feed must match
     * the same manifest entry. This prevents a feed for ticker A being wired to
     * the token of ticker B.
     */
    function validateStockOracle(StockOracleConfig memory config) internal view {
        if (!isSupportedChain(config.chainId)) revert UnsupportedChain(config.chainId);
        if (config.token == address(0) || config.feed == address(0)) revert ZeroTokenAddress();
        if (config.owner == address(0)) revert ZeroAddress();

        if (config.chainId != ROBINHOOD_MAINNET_CHAIN_ID) return;

        if (config.privateKey == ANVIL_KEY) revert DefaultDeployerKeyOnMainnet();
        if (config.deployer == config.owner) revert DeployerMustNotBeOwner();

        // Manifest first, so a partially configured mainnet manifest names the
        // missing field instead of failing an unrelated code-size check.
        requireManifestMatch(config.token, config.manifestToken, string.concat("stocks.", config.ticker, ".address"));
        requireManifestMatch(config.feed, config.manifestFeed, string.concat("stocks.", config.ticker, ".feed"));

        if (config.owner.code.length == 0) revert OwnerMustBeContract();
        if (config.token.code.length == 0 || config.feed.code.length == 0) revert TokenMustBeContract();
    }

    struct TreasuryConfiguration {
        uint256 chainId;
        uint256 privateKey;
        address router;
        address portfolio;
        address dexRouter;
        address keeper;
        address treasury;
        // Expected values from config/networks/mainnet.json.
        address manifestRouter;
        address manifestPortfolio;
        address manifestDexRouter;
        address manifestTreasury;
    }

    /**
     * @notice Guard for ConfigureTreasury.
     *
     * Env-provided addresses are matched against the manifest so a mainnet
     * configuration run cannot point at a different router or vault. Keeper may
     * be an ops EOA, but every contract address must have code. The treasury
     * that receives `PortfolioVault.sell()` proceeds must be the manifest Safe.
     */
    function validateTreasuryConfiguration(TreasuryConfiguration memory config) internal view {
        if (!isSupportedChain(config.chainId)) revert UnsupportedChain(config.chainId);
        if (config.router == address(0) || config.portfolio == address(0) || config.keeper == address(0)) {
            revert ZeroAddress();
        }

        if (config.chainId != ROBINHOOD_MAINNET_CHAIN_ID) return;

        if (config.privateKey == ANVIL_KEY) revert DefaultDeployerKeyOnMainnet();
        if (config.dexRouter == address(0)) revert ZeroAddress();

        // Manifest first, so a partially configured mainnet manifest names the
        // missing field instead of failing an unrelated code-size check.
        requireManifestMatch(config.router, config.manifestRouter, "contracts.TreasuryRouter");
        requireManifestMatch(config.portfolio, config.manifestPortfolio, "contracts.PortfolioVault");
        requireManifestMatch(config.dexRouter, config.manifestDexRouter, "external.dexRouter");
        if (config.treasury == address(0)) revert ZeroAddress();
        requireManifestMatch(config.treasury, config.manifestTreasury, "external.treasurySafe");

        if (config.router.code.length == 0 || config.portfolio.code.length == 0) revert TreasuryMustBeContract();
        if (config.dexRouter.code.length == 0) revert RouterMustBeContract();
        if (config.treasury.code.length == 0) revert TreasuryRecipientMustBeContract();
    }

    struct OwnershipTargets {
        uint256 chainId;
        uint256 privateKey;
        address deployer;
        address timelock;
        address router;
        address portfolio;
        address tyrOracle;
        // Expected values from config/networks/mainnet.json.
        address manifestTimelock;
        address manifestRouter;
        address manifestPortfolio;
        address manifestTyrOracle;
    }

    /**
     * @notice Guard for TransferOwnership.
     *
     * The treasury contracts were previously left out of the handover, so
     * `TreasuryRouter`, `PortfolioVault`, and the oracles stayed on the deployer
     * EOA while `VerifyMainnet` still reported success. On mainnet every address
     * must be the one recorded in the manifest, and an empty `TyrTwapOracle`
     * entry is allowed only when no oracle address is supplied.
     */
    function validateOwnershipTargets(OwnershipTargets memory config) internal view {
        if (!isSupportedChain(config.chainId)) revert UnsupportedChain(config.chainId);
        if (config.deployer == address(0) || config.timelock == address(0)) revert ZeroAddress();
        if (config.router == address(0) || config.portfolio == address(0)) revert ZeroAddress();
        if (config.timelock.code.length == 0) revert OwnerMustBeContract();
        if (config.timelock == config.deployer) revert DeployerMustNotBeOwner();

        if (config.chainId != ROBINHOOD_MAINNET_CHAIN_ID) return;

        if (config.privateKey == ANVIL_KEY) revert DefaultDeployerKeyOnMainnet();

        requireManifestMatch(config.timelock, config.manifestTimelock, "external.timelock");
        requireManifestMatch(config.router, config.manifestRouter, "contracts.TreasuryRouter");
        requireManifestMatch(config.portfolio, config.manifestPortfolio, "contracts.PortfolioVault");

        if (config.tyrOracle != address(0)) {
            requireManifestMatch(config.tyrOracle, config.manifestTyrOracle, "contracts.TyrTwapOracle");
            if (config.tyrOracle.code.length == 0) revert OwnerMustBeContract();
        }

        if (config.router.code.length == 0 || config.portfolio.code.length == 0) revert TreasuryMustBeContract();
    }

    struct ProtocolConfiguration {
        uint256 chainId;
        uint256 privateKey;
        address stakeManager;
        address usdg;
        address usdgVault;
        address treasury;
        address feeSplitter;
        address burner;
        address buybackRouter;
        address keeper;
        // Expected values from config/networks/mainnet.json.
        address manifestStakeManager;
        address manifestUsdg;
        address manifestUsdgVault;
        address manifestTreasury;
        address manifestFeeSplitter;
        address manifestBurner;
        address manifestBuybackRouter;
    }

    /**
     * @notice Guard for ConfigureProtocol.
     *
     * Without this, a mainnet run could enable staking against a different
     * vault, point the fee splitter at an EOA, or wire a mock buyback router.
     * `keeper` may be an ops EOA because it only triggers buybacks.
     */
    function validateProtocolConfiguration(ProtocolConfiguration memory config) internal view {
        if (!isSupportedChain(config.chainId)) revert UnsupportedChain(config.chainId);
        if (config.stakeManager == address(0) || config.usdg == address(0) || config.usdgVault == address(0)) {
            revert ZeroAddress();
        }
        if (config.treasury == address(0) || config.burner == address(0)) revert ZeroAddress();

        if (config.chainId != ROBINHOOD_MAINNET_CHAIN_ID) return;

        if (config.privateKey == ANVIL_KEY) revert DefaultDeployerKeyOnMainnet();
        if (config.treasury.code.length == 0) revert TreasuryMustBeContract();
        if (config.usdg.code.length == 0) revert TokenMustBeContract();

        // Manifest first, so a partially configured mainnet manifest names the
        // missing field instead of failing an unrelated code-size check.
        requireManifestMatch(config.stakeManager, config.manifestStakeManager, "contracts.StakeManager");
        requireManifestMatch(config.usdg, config.manifestUsdg, "tokens.USDG.address");
        requireManifestMatch(config.usdgVault, config.manifestUsdgVault, "contracts.UsdgVault");
        requireManifestMatch(config.treasury, config.manifestTreasury, "external.treasurySafe");
        requireManifestMatch(config.burner, config.manifestBurner, "contracts.BuybackBurner");

        if (config.feeSplitter != address(0)) {
            requireManifestMatch(config.feeSplitter, config.manifestFeeSplitter, "contracts.FeeSplitter");
            if (config.feeSplitter.code.length == 0) revert TreasuryRecipientMustBeContract();
        }
        if (config.buybackRouter != address(0)) {
            requireManifestMatch(config.buybackRouter, config.manifestBuybackRouter, "external.dexRouter");
            if (config.buybackRouter.code.length == 0) revert RouterMustBeContract();
        }

        if (config.stakeManager.code.length == 0 || config.usdgVault.code.length == 0) {
            revert TreasuryMustBeContract();
        }
        if (config.burner.code.length == 0) revert TreasuryRecipientMustBeContract();
    }

    struct StockVaultConfig {
        uint256 chainId;
        uint256 privateKey;
        address deployer;
        address token;
        address feed;
        address vault;
        address treasury;
        address stakeManager;
        address guardian;
        uint256 depositCap;
        string ticker;
        // Expected values from config/networks/mainnet.json.
        address manifestToken;
        address manifestFeed;
        address manifestVault;
        address manifestTreasury;
    }

    /**
     * @notice Guard for DeployStockVault.
     *
     * One vault per ticker, so the token and feed must belong to the same
     * manifest entry. On mainnet the vault entry must still be empty; deploying
     * a second vault for a ticker that already has one would split liquidity.
     */
    function validateStockVaultDeploy(StockVaultConfig memory config) internal view {
        if (!isSupportedChain(config.chainId)) revert UnsupportedChain(config.chainId);
        if (config.token == address(0) || config.feed == address(0)) revert ZeroTokenAddress();
        if (config.treasury == address(0) || config.guardian == address(0)) revert ZeroAddress();
        if (config.depositCap == 0) revert InvalidDepositCap();

        if (config.chainId != ROBINHOOD_MAINNET_CHAIN_ID) return;

        if (config.privateKey == ANVIL_KEY) revert DefaultDeployerKeyOnMainnet();
        if (config.deployer == config.treasury) revert DeployerMustNotBeTreasury();
        if (config.deployer == config.guardian) revert DeployerMustNotBeGuardian();

        requireManifestMatch(config.token, config.manifestToken, string.concat("stocks.", config.ticker, ".address"));
        requireManifestMatch(config.feed, config.manifestFeed, string.concat("stocks.", config.ticker, ".feed"));
        if (config.manifestVault != address(0)) revert ManifestAddressMismatch("stocks.<TICKER>.vault already set");

        if (config.treasury.code.length == 0) revert TreasuryRecipientMustBeContract();
        if (config.guardian.code.length == 0) revert GuardianMustBeContract();
        if (config.stakeManager.code.length == 0) revert OwnerMustBeContract();
        if (config.token.code.length == 0 || config.feed.code.length == 0) revert TokenMustBeContract();
    }

    /**
     * @notice Guard for ConfigureStockVault.
     *
     * The vault being registered must be the one recorded in the manifest, and
     * its asset must be the manifest token. This blocks a cross-ticker wiring
     * such as registering the AAPL vault under the NVDA token.
     */
    function validateStockVaultConfig(StockVaultConfig memory config) internal view {
        if (!isSupportedChain(config.chainId)) revert UnsupportedChain(config.chainId);
        if (config.token == address(0) || config.vault == address(0) || config.feed == address(0)) {
            revert ZeroAddress();
        }
        if (config.depositCap == 0) revert InvalidDepositCap();

        if (config.chainId != ROBINHOOD_MAINNET_CHAIN_ID) return;

        if (config.privateKey == ANVIL_KEY) revert DefaultDeployerKeyOnMainnet();

        requireManifestMatch(config.token, config.manifestToken, string.concat("stocks.", config.ticker, ".address"));
        requireManifestMatch(config.feed, config.manifestFeed, string.concat("stocks.", config.ticker, ".feed"));
        requireManifestMatch(config.vault, config.manifestVault, string.concat("stocks.", config.ticker, ".vault"));
        if (config.manifestTreasury != address(0)) {
            requireManifestMatch(config.treasury, config.manifestTreasury, "external.treasurySafe");
        }

        if (config.stakeManager.code.length == 0) revert TreasuryMustBeContract();
        if (config.vault.code.length == 0) revert TreasuryMustBeContract();
        if (config.token.code.length == 0) revert TokenMustBeContract();
    }

    function isSupportedChain(uint256 chainId) internal pure returns (bool) {
        return
            chainId == LOCAL_CHAIN_ID || chainId == ROBINHOOD_TESTNET_CHAIN_ID || chainId == ROBINHOOD_MAINNET_CHAIN_ID;
    }

    /**
     * @notice Reject an address that is not the one recorded in the manifest.
     * A mock supplied through an env var therefore cannot reach mainnet.
     */
    function requireManifestMatch(address configured, address expected, string memory field) internal pure {
        if (expected == address(0)) revert ManifestAddressMissing(field);
        if (configured != expected) revert ManifestAddressMismatch(field);
    }
}
