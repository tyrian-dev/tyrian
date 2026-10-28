// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IBurnSource.sol";
import "./interfaces/IWETH.sol";

/**
 * @title FeeSplitter
 * @notice Receives Pons creator fees.
 *
 * Policy:
 * - WETH: 80% treasury, 20% buyback burner.
 * - TYR: 100% burn, never sent to treasury and never swapped.
 * - Native ETH is wrapped into WETH before splitting.
 *
 * This contract never swaps tokens. Swap/buyback logic belongs to
 * BuybackBurner.
 */
contract FeeSplitter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant TREASURY_BPS = 8000;
    uint256 public constant BUYBACK_BPS = 2000;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    address public immutable weth;
    address public immutable tyr;

    address public treasury;
    address public buybackBurner;

    event FeesSplit(address indexed token, uint256 treasuryAmt, uint256 buybackAmt);
    event Burned(address indexed token, uint256 amount, BurnSource indexed source);
    event AddressesUpdated(address indexed newTreasury, address indexed newBurner);
    event NativeWrapped(uint256 amount);

    error InvalidAddress();
    error ZeroBalance();
    error UnsupportedToken();

    constructor(address weth_, address tyr_, address initialTreasury, address initialBurner, address initialOwner)
        Ownable(initialOwner)
    {
        if (weth_ == address(0) || tyr_ == address(0) || initialTreasury == address(0) || initialBurner == address(0)) {
            revert InvalidAddress();
        }

        weth = weth_;
        tyr = tyr_;
        treasury = initialTreasury;
        buybackBurner = initialBurner;
    }

    function setRecipients(address newTreasury, address newBurner) external onlyOwner {
        if (newTreasury == address(0) || newBurner == address(0)) revert InvalidAddress();
        treasury = newTreasury;
        buybackBurner = newBurner;
        emit AddressesUpdated(newTreasury, newBurner);
    }

    /**
     * @notice Split the contract's WETH balance 80/20.
     */
    function splitWeth() external nonReentrant {
        _splitWeth();
    }

    /**
     * @notice Compatibility entry point. Only WETH is split; TYR must be burned.
     */
    function split(address token) external nonReentrant {
        if (token != weth) revert UnsupportedToken();
        _splitWeth();
    }

    /**
     * @notice Burn 100% of the TYR fee balance. No treasury transfer.
     */
    function burnTyr() external nonReentrant returns (uint256 burned) {
        burned = IERC20(tyr).balanceOf(address(this));
        if (burned == 0) revert ZeroBalance();

        IERC20(tyr).safeTransfer(DEAD_ADDRESS, burned);
        emit Burned(tyr, burned, BurnSource.FEE);
    }

    /**
     * @notice Wrap native ETH from Pons into WETH.
     */
    receive() external payable {
        if (msg.value == 0) revert ZeroBalance();
        IWETH(weth).deposit{value: msg.value}();
        emit NativeWrapped(msg.value);
    }

    function _splitWeth() internal {
        uint256 balance = IERC20(weth).balanceOf(address(this));
        if (balance == 0) revert ZeroBalance();

        uint256 treasuryAmt = (balance * TREASURY_BPS) / BPS_DENOMINATOR;
        uint256 buybackAmt = balance - treasuryAmt;

        if (treasuryAmt > 0) IERC20(weth).safeTransfer(treasury, treasuryAmt);
        if (buybackAmt > 0) IERC20(weth).safeTransfer(buybackBurner, buybackAmt);

        emit FeesSplit(weth, treasuryAmt, buybackAmt);
    }
}
