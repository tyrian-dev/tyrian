// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IBurnSource.sol";
import "./interfaces/ISwapRouterV3.sol";

/**
 * @title BuybackBurner
 * @notice Converts the WETH buyback allocation into TYR and burns it.
 *
 * TYR fee burn is handled directly in FeeSplitter. This contract only burns
 * TYR that it actually bought (source BUYBACK) or received for a direct fee
 * burn (source FEE). Recipients are fixed; no arbitrary recipient function.
 */
contract BuybackBurner is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address public immutable tyrToken;
    address public immutable weth;

    address public swapRouter;
    address public keeper;
    uint24 public poolFee;
    uint256 public totalBurned;

    event Burned(address indexed token, uint256 amount, BurnSource indexed source);
    event RouterUpdated(address indexed oldRouter, address indexed newRouter, uint24 poolFee);
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);

    error InvalidAddress();
    error ZeroAmount();
    error InvalidDeadline();
    error InsufficientOutput();
    error RouterNotConfigured();
    error NotKeeper();

    modifier onlyKeeper() {
        if (msg.sender != owner() && msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(address tyr_, address weth_, address initialOwner) Ownable(initialOwner) {
        if (tyr_ == address(0) || weth_ == address(0)) revert InvalidAddress();
        tyrToken = tyr_;
        weth = weth_;
        keeper = initialOwner;
    }

    function setRouter(address newRouter, uint24 newPoolFee) external onlyOwner {
        if (newRouter == address(0)) revert InvalidAddress();
        emit RouterUpdated(swapRouter, newRouter, newPoolFee);
        swapRouter = newRouter;
        poolFee = newPoolFee;
    }

    function setKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert InvalidAddress();
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    /**
     * @notice Swap WETH held by this contract into TYR and burn the output.
     */
    function buybackAndBurn(uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        onlyKeeper
        returns (uint256 burned)
    {
        if (swapRouter == address(0)) revert RouterNotConfigured();
        if (amountIn == 0) revert ZeroAmount();
        if (deadline < block.timestamp) revert InvalidDeadline();
        if (IERC20(weth).balanceOf(address(this)) < amountIn) revert ZeroAmount();

        uint256 tyrBefore = IERC20(tyrToken).balanceOf(address(this));

        IERC20(weth).forceApprove(swapRouter, amountIn);
        ISwapRouterV3(swapRouter)
            .exactInputSingle(
                ISwapRouterV3.ExactInputSingleParams({
                    tokenIn: weth,
                    tokenOut: tyrToken,
                    fee: poolFee,
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
        IERC20(weth).forceApprove(swapRouter, 0);

        burned = IERC20(tyrToken).balanceOf(address(this)) - tyrBefore;
        if (burned < minOut) revert InsufficientOutput();
        if (burned == 0) revert ZeroAmount();

        totalBurned += burned;
        IERC20(tyrToken).safeTransfer(DEAD_ADDRESS, burned);

        emit Burned(tyrToken, burned, BurnSource.BUYBACK);
    }

    /**
     * @notice Burn TYR that was sent here directly as a fee.
     */
    function burnTyr() external nonReentrant returns (uint256 burned) {
        burned = IERC20(tyrToken).balanceOf(address(this));
        if (burned == 0) revert ZeroAmount();

        totalBurned += burned;
        IERC20(tyrToken).safeTransfer(DEAD_ADDRESS, burned);

        emit Burned(tyrToken, burned, BurnSource.FEE);
    }
}
