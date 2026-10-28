// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "./interfaces/ISwapRouterV3.sol";
import "./interfaces/IStockPriceOracle.sol";

/**
 * @title PortfolioVault
 * @notice Treasury-owned basket of allowlisted Stock Tokens.
 *
 * Policy:
 * - The basket is capped at 20% of total treasury (`treasuryTotalUsd`), which
 *   the Safe/timelock owner sets from the latest treasury report. USDG is
 *   treated as $1 as per the brief.
 * - Weekly DCA buy is executed by a keeper, capped by `dcaAmountUsd` per
 *   window. Sell is owner-only and stays available while paused.
 * - Every buy/sell uses `StockPriceOracle` and a caller-supplied minimum output.
 *   The contract additionally rejects a minimum output that is worse than
 *   `maxSlippageBps` from the oracle price, so a compromised keeper cannot set
 *   an unprotected slippage bound.
 * - Rebalance execution and DEX spread checks are deferred until a verified
 *   pool exists; targets are stored now so weights are auditable.
 * - This basket is treasury property. It is never counted as user stake.
 */
contract PortfolioVault is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_PORTFOLIO_BPS = 2000;
    uint256 public constant MAX_TARGETS = 8;
    uint256 public constant MAX_SLIPPAGE_BPS = 1000;

    address public immutable usdg;
    uint8 public immutable usdgDecimals;

    struct Target {
        address token;
        uint8 decimals;
        uint16 weightBps;
        address oracle;
    }

    Target[] private _targets;

    address public swapRouter;
    uint24 public poolFee;
    address public keeper;
    address public guardian;

    /// @notice Recipient of the USDG proceeds from `sell()`.
    address public treasury;

    /// @notice Total treasury value in USD (18 decimals), set by the owner.
    uint256 public treasuryTotalUsd;

    uint256 public maxSlippageBps = 100;
    uint256 public dcaInterval = 7 days;
    uint256 public dcaAmountUsd;
    uint256 public lastBuyAt;

    /// @notice Cumulative USD value spent (18 decimals) per token (GAP-011 / Brief §7).
    mapping(address => uint256) public totalCostUsdg;

    /// @notice Cumulative tokens bought in nominal token decimals per token (GAP-011 / Brief §7).
    mapping(address => uint256) public totalTokensBought;

    event TargetsConfigured(uint256 count);
    event TargetUpdated(address indexed token, address indexed oracle, uint256 weightBps);
    event TreasuryTotalUpdated(uint256 oldTotalUsd, uint256 newTotalUsd);
    event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);
    event DcaIntervalUpdated(uint256 oldInterval, uint256 newInterval);
    event DcaAmountUpdated(uint256 oldAmountUsd, uint256 newAmountUsd);
    event RouterUpdated(address indexed oldRouter, address indexed newRouter, uint24 poolFee);
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event GuardianUpdated(address indexed oldGuardian, address indexed newGuardian);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event Bought(address indexed token, uint256 usdgIn, uint256 tokenOut);
    event Sold(address indexed token, uint256 tokenIn, uint256 usdgOut, address indexed recipient);

    error InvalidAddress();
    error InvalidTargets();
    error TargetNotFound();
    error TargetHasBalance();
    error OracleTokenMismatch();
    error InvalidDeadline();
    error InvalidSlippage();
    error ZeroAmount();
    error RouterNotConfigured();
    error TreasuryNotSet();
    error DcaDisabled();
    error DcaNotDue();
    error DcaAmountExceeded();
    error PortfolioCapExceeded();
    error SlippageTooHigh();
    error InsufficientOutput();
    error NotKeeper();
    error NotGuardian();

    modifier onlyKeeper() {
        if (msg.sender != owner() && msg.sender != keeper) revert NotKeeper();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(address usdg_, address initialOwner) Ownable(initialOwner) {
        if (usdg_ == address(0)) revert InvalidAddress();
        usdg = usdg_;
        usdgDecimals = IERC20Metadata(usdg_).decimals();
        keeper = initialOwner;
        guardian = initialOwner;
        treasury = initialOwner;
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    /**
     * @notice Replace the whole basket. Weights must sum to 10000 bps.
     */
    function setTargets(address[] calldata tokens, uint16[] calldata weights, address[] calldata oracles)
        external
        onlyOwner
    {
        uint256 count = tokens.length;
        if (count == 0 || count > MAX_TARGETS) revert InvalidTargets();
        if (count != weights.length || count != oracles.length) revert InvalidTargets();

        // A token with an open balance must be sold before it leaves the
        // basket; otherwise the treasury position would be stranded.
        for (uint256 i; i < _targets.length; ++i) {
            address oldToken = _targets[i].token;
            if (IERC20(oldToken).balanceOf(address(this)) == 0) continue;

            bool kept;
            for (uint256 j; j < count; ++j) {
                if (tokens[j] == oldToken) {
                    kept = true;
                    break;
                }
            }
            if (!kept) revert TargetHasBalance();
        }

        delete _targets;

        uint256 weightSum;
        for (uint256 i; i < count; ++i) {
            address token = tokens[i];
            address oracle = oracles[i];
            if (token == address(0) || oracle == address(0) || weights[i] == 0) {
                revert InvalidTargets();
            }
            for (uint256 j; j < i; ++j) {
                if (tokens[j] == token) revert InvalidTargets();
            }
            if (oracle.code.length == 0) revert InvalidTargets();
            if (IStockPriceOracle(oracle).stockToken() != token) revert OracleTokenMismatch();

            _targets.push(
                Target({
                    token: token, decimals: IERC20Metadata(token).decimals(), weightBps: weights[i], oracle: oracle
                })
            );
            weightSum += weights[i];

            emit TargetUpdated(token, oracle, weights[i]);
        }

        if (weightSum != BPS_DENOMINATOR) revert InvalidTargets();

        emit TargetsConfigured(count);
    }

    function setTreasuryTotalUsd(uint256 newTotalUsd) external onlyOwner {
        emit TreasuryTotalUpdated(treasuryTotalUsd, newTotalUsd);
        treasuryTotalUsd = newTotalUsd;
    }

    function setMaxSlippageBps(uint256 newBps) external onlyOwner {
        if (newBps > MAX_SLIPPAGE_BPS) revert InvalidSlippage();
        emit MaxSlippageUpdated(maxSlippageBps, newBps);
        maxSlippageBps = newBps;
    }

    function setDcaInterval(uint256 newInterval) external onlyOwner {
        if (newInterval == 0) revert InvalidSlippage();
        emit DcaIntervalUpdated(dcaInterval, newInterval);
        dcaInterval = newInterval;
    }

    function setDcaAmountUsd(uint256 newAmountUsd) external onlyOwner {
        emit DcaAmountUpdated(dcaAmountUsd, newAmountUsd);
        dcaAmountUsd = newAmountUsd;
    }

    function setRouter(address newRouter, uint24 newPoolFee) external onlyOwner {
        emit RouterUpdated(swapRouter, newRouter, newPoolFee);
        swapRouter = newRouter;
        poolFee = newPoolFee;
    }

    function setKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert InvalidAddress();
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert InvalidAddress();
        emit GuardianUpdated(guardian, newGuardian);
        guardian = newGuardian;
    }

    /**
     * @notice Set the treasury that receives `sell()` proceeds.
     * @dev Kept separate from `owner()` so ownership can move to the timelock
     * while sale proceeds still land on the Safe.
     */
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function pause() external onlyGuardian {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function targetCount() external view returns (uint256) {
        return _targets.length;
    }

    function targetAt(uint256 index)
        external
        view
        returns (address token, uint8 decimals, uint16 weightBps, address oracle)
    {
        Target storage target = _targets[index];
        return (target.token, target.decimals, target.weightBps, target.oracle);
    }

    function targetOf(address token)
        external
        view
        returns (uint8 decimals, uint16 weightBps, address oracle, bool found)
    {
        for (uint256 i; i < _targets.length; ++i) {
            Target storage target = _targets[i];
            if (target.token == token) {
                return (target.decimals, target.weightBps, target.oracle, true);
            }
        }
        return (0, 0, address(0), false);
    }

    /**
     * @notice Current basket value in USD (18 decimals) from the oracle set.
     */
    function portfolioValueUsd() public view returns (uint256 valueUsd18) {
        for (uint256 i; i < _targets.length; ++i) {
            Target storage target = _targets[i];
            uint256 balance = IERC20(target.token).balanceOf(address(this));
            if (balance == 0) continue;
            valueUsd18 += IStockPriceOracle(target.oracle).getUsdValue(target.token, balance);
        }
    }

    /**
     * @notice Maximum basket value allowed at the current treasury size.
     */
    function portfolioCapUsd() public view returns (uint256) {
        return Math.mulDiv(treasuryTotalUsd, MAX_PORTFOLIO_BPS, BPS_DENOMINATOR);
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    /**
     * @notice Weekly DCA buy. Keeper or owner only.
     */
    function buy(address token, uint256 usdgAmount, uint256 minTokenOut, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        onlyKeeper
        returns (uint256 tokenOut)
    {
        if (usdgAmount == 0) revert ZeroAmount();
        if (deadline < block.timestamp) revert InvalidDeadline();
        if (swapRouter == address(0)) revert RouterNotConfigured();
        if (treasuryTotalUsd == 0) revert TreasuryNotSet();
        if (dcaAmountUsd == 0) revert DcaDisabled();
        if (lastBuyAt != 0 && block.timestamp < lastBuyAt + dcaInterval) revert DcaNotDue();

        Target storage target = _target(_find(token));

        uint256 usdgAmountUsd = _toUsd18(usdgAmount, usdgDecimals);
        if (usdgAmountUsd > dcaAmountUsd) revert DcaAmountExceeded();

        uint256 capUsd = portfolioCapUsd();
        if (portfolioValueUsd() + usdgAmountUsd > capUsd) revert PortfolioCapExceeded();

        uint256 price18 = IStockPriceOracle(target.oracle).getPrice();
        uint256 expectedOut = Math.mulDiv(usdgAmountUsd, 10 ** target.decimals, price18);
        if (minTokenOut < _minAcceptable(expectedOut)) revert SlippageTooHigh();

        lastBuyAt = block.timestamp;

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        _swap(usdg, token, usdgAmount, minTokenOut, deadline);
        tokenOut = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (tokenOut < minTokenOut) revert InsufficientOutput();

        // Track cost basis (cumulative USD value spent & tokens bought) (GAP-011 / Brief §7)
        totalCostUsdg[token] += usdgAmountUsd;
        totalTokensBought[token] += tokenOut;

        emit Bought(token, usdgAmount, tokenOut);
    }

    /**
     * @notice Sell basket tokens for USDG and send the proceeds to the treasury.
     * @dev Owner-only. Stays available while paused so the treasury can de-risk.
     */
    function sell(address token, uint256 tokenAmount, uint256 minUsdgOut, uint256 deadline)
        external
        nonReentrant
        onlyOwner
        returns (uint256 usdgOut)
    {
        if (tokenAmount == 0) revert ZeroAmount();
        if (deadline < block.timestamp) revert InvalidDeadline();
        if (swapRouter == address(0)) revert RouterNotConfigured();

        Target storage target = _target(_find(token));

        uint256 price18 = IStockPriceOracle(target.oracle).getPrice();
        uint256 expectedUsdg = _fromUsd18(Math.mulDiv(tokenAmount, price18, 10 ** target.decimals), usdgDecimals);
        if (minUsdgOut < _minAcceptable(expectedUsdg)) revert SlippageTooHigh();

        uint256 balanceBefore = IERC20(usdg).balanceOf(address(this));
        _swap(token, usdg, tokenAmount, minUsdgOut, deadline);
        usdgOut = IERC20(usdg).balanceOf(address(this)) - balanceBefore;
        if (usdgOut < minUsdgOut) revert InsufficientOutput();

        // Pro-rata reduce cost basis on sell
        uint256 priorTokenBalance = IERC20(token).balanceOf(address(this)) + tokenAmount;
        if (priorTokenBalance > 0 && totalCostUsdg[token] > 0) {
            uint256 costReduction = Math.mulDiv(totalCostUsdg[token], tokenAmount, priorTokenBalance);
            totalCostUsdg[token] = totalCostUsdg[token] > costReduction ? totalCostUsdg[token] - costReduction : 0;
            totalTokensBought[token] = totalTokensBought[token] > tokenAmount ? totalTokensBought[token] - tokenAmount : 0;
        }

        address recipient = treasury;
        IERC20(usdg).safeTransfer(recipient, usdgOut);

        emit Sold(token, tokenAmount, usdgOut, recipient);
    }

    /**
     * @notice Average buy cost in USD (18 decimals) for a token in the basket (GAP-011 / Brief §7).
     * @dev Returns 0 if no tokens have been bought or remaining balance is 0.
     */
    function getAvgCostUsd(address token) external view returns (uint256) {
        uint256 bought = totalTokensBought[token];
        if (bought == 0) return 0;
        Target storage target = _target(_find(token));
        return Math.mulDiv(totalCostUsdg[token], 10 ** target.decimals, bought);
    }

    /**
     * @notice Cost basis report for a token.
     */
    function getCostBasis(address token)
        external
        view
        returns (uint256 cumulativeCostUsd, uint256 cumulativeTokensBought, uint256 avgCostUsd18)
    {
        cumulativeCostUsd = totalCostUsdg[token];
        cumulativeTokensBought = totalTokensBought[token];
        if (cumulativeTokensBought > 0) {
            Target storage target = _target(_find(token));
            avgCostUsd18 = Math.mulDiv(cumulativeCostUsd, 10 ** target.decimals, cumulativeTokensBought);
        }
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _find(address token) private view returns (uint256 index) {
        for (uint256 i; i < _targets.length; ++i) {
            if (_targets[i].token == token) return i;
        }
        revert TargetNotFound();
    }

    function _target(uint256 index) private view returns (Target storage target) {
        target = _targets[index];
    }

    function _minAcceptable(uint256 expected) private view returns (uint256) {
        return expected - Math.mulDiv(expected, maxSlippageBps, BPS_DENOMINATOR);
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 deadline) private {
        IERC20(tokenIn).forceApprove(swapRouter, amountIn);
        ISwapRouterV3(swapRouter)
            .exactInputSingle(
                ISwapRouterV3.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: poolFee,
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
        IERC20(tokenIn).forceApprove(swapRouter, 0);
    }

    function _toUsd18(uint256 amount, uint8 decimals) private pure returns (uint256) {
        if (decimals == 18) return amount;
        if (decimals < 18) return amount * 10 ** (18 - decimals);
        return amount / 10 ** (decimals - 18);
    }

    function _fromUsd18(uint256 amount, uint8 decimals) private pure returns (uint256) {
        if (decimals == 18) return amount;
        if (decimals < 18) return amount / 10 ** (18 - decimals);
        return amount * 10 ** (decimals - 18);
    }
}
