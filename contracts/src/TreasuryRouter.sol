// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "./interfaces/ISwapRouterV3.sol";

/**
 * @title TreasuryRouter
 * @notice Splits treasury inflow 70/20/10 into budget, reserve, and portfolio.
 *
 * Policy:
 * - Only USDG is routed. WETH is swapped to USDG first; TYR never enters the
 *   treasury and has no path in this contract.
 * - 70% daily budget / 20% reserve (Morpho or Safe) / 10% PortfolioVault.
 * - The rounding dust stays in the budget leg, so the split never underfunds
 *   the liquid treasury.
 * - If the swap fails the WETH stays here and `SwapFailed` is emitted. `route()`
 *   does not revert, so the alert is visible and the keeper can retry later.
 * - Pause blocks routing only; funds already routed are not affected.
 */
contract TreasuryRouter is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    address public immutable usdg;
    address public immutable weth;

    address public budget;
    address public reserve;
    address public portfolio;

    address public swapRouter;
    uint24 public poolFee;
    address public keeper;
    address public guardian;

    uint256 public budgetBps = 7000;
    uint256 public reserveBps = 2000;
    uint256 public portfolioBps = 1000;

    uint256 public totalRouted;

    event Routed(uint256 usdgIn, uint256 budgetOut, uint256 reserveOut, uint256 portfolioOut);
    event NothingToRoute();
    event SwapFailed(uint256 amountIn, bytes reason);
    event RecipientsUpdated(address budget, address reserve, address portfolio);
    event SplitUpdated(uint256 budgetBps, uint256 reserveBps, uint256 portfolioBps);
    event RouterUpdated(address indexed oldRouter, address indexed newRouter, uint24 poolFee);
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event GuardianUpdated(address indexed oldGuardian, address indexed newGuardian);

    error InvalidAddress();
    error InvalidSplit();
    error InvalidDeadline();
    error ZeroAmount();
    error RouterNotConfigured();
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

    constructor(address usdg_, address weth_, address initialOwner) Ownable(initialOwner) {
        if (usdg_ == address(0) || weth_ == address(0)) revert InvalidAddress();
        usdg = usdg_;
        weth = weth_;
        keeper = initialOwner;
        guardian = initialOwner;
    }

    function setRecipients(address budget_, address reserve_, address portfolio_) external onlyOwner {
        if (budget_ == address(0) || reserve_ == address(0) || portfolio_ == address(0)) {
            revert InvalidAddress();
        }
        if (budget_ == reserve_ || budget_ == portfolio_ || reserve_ == portfolio_) {
            revert InvalidAddress();
        }

        budget = budget_;
        reserve = reserve_;
        portfolio = portfolio_;

        emit RecipientsUpdated(budget_, reserve_, portfolio_);
    }

    function setSplit(uint256 budgetBps_, uint256 reserveBps_, uint256 portfolioBps_) external onlyOwner {
        if (budgetBps_ == 0 || reserveBps_ == 0 || portfolioBps_ == 0) revert InvalidSplit();
        if (budgetBps_ + reserveBps_ + portfolioBps_ != BPS_DENOMINATOR) revert InvalidSplit();

        budgetBps = budgetBps_;
        reserveBps = reserveBps_;
        portfolioBps = portfolioBps_;

        emit SplitUpdated(budgetBps_, reserveBps_, portfolioBps_);
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

    function pause() external onlyGuardian {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Swap any WETH balance to USDG, then split all USDG 70/20/10.
     * @dev A failed swap is recorded, not forced. The call returns zero legs and
     * the WETH stays in the router for a later retry.
     */
    function route(uint256 minOut, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        onlyKeeper
        returns (uint256 budgetOut, uint256 reserveOut, uint256 portfolioOut)
    {
        if (budget == address(0) || reserve == address(0) || portfolio == address(0)) {
            revert InvalidAddress();
        }

        uint256 wethIn = IERC20(weth).balanceOf(address(this));
        if (wethIn > 0) {
            if (swapRouter == address(0)) revert RouterNotConfigured();
            if (deadline < block.timestamp) revert InvalidDeadline();
            _swapWeth(wethIn, minOut, deadline);
        }

        uint256 usdgIn = IERC20(usdg).balanceOf(address(this));
        if (usdgIn == 0) {
            emit NothingToRoute();
            return (0, 0, 0);
        }

        reserveOut = Math.mulDiv(usdgIn, reserveBps, BPS_DENOMINATOR);
        portfolioOut = Math.mulDiv(usdgIn, portfolioBps, BPS_DENOMINATOR);
        // Rounding dust stays in the budget leg.
        budgetOut = usdgIn - reserveOut - portfolioOut;

        if (budgetOut > 0) IERC20(usdg).safeTransfer(budget, budgetOut);
        if (reserveOut > 0) IERC20(usdg).safeTransfer(reserve, reserveOut);
        if (portfolioOut > 0) IERC20(usdg).safeTransfer(portfolio, portfolioOut);

        totalRouted += usdgIn;

        emit Routed(usdgIn, budgetOut, reserveOut, portfolioOut);
    }

    function _swapWeth(uint256 amountIn, uint256 minOut, uint256 deadline) private {
        IERC20(weth).forceApprove(swapRouter, amountIn);

        try ISwapRouterV3(swapRouter)
            .exactInputSingle(
                ISwapRouterV3.ExactInputSingleParams({
                    tokenIn: weth,
                    tokenOut: usdg,
                    fee: poolFee,
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            ) {
        // Output is measured from the USDG balance below.
        }
        catch (bytes memory reason) {
            emit SwapFailed(amountIn, reason);
        }

        // Never leave an allowance behind, including after a failed swap.
        IERC20(weth).forceApprove(swapRouter, 0);
    }
}
