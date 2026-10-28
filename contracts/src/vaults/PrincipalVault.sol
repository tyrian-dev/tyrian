// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "../interfaces/IStakeVault.sol";
import "../interfaces/IYieldStrategy.sol";

/**
 * @title PrincipalVault
 * @notice Principal-protected vault with ERC-4626-inspired accounting.
 *
 * Important: this contract is NOT ERC-4626 compliant. Shares are not a
 * transferable yield-bearing token. They only track a user's claim on
 * principal inside this custom vault.
 *
 * Rules:
 * - totalPrincipal is the principal still owned by users.
 * - totalAssets is idle assets plus assets held by the selected strategy.
 * - Any positive difference is yield and can only be harvested to treasury.
 * - A strategy loss is shared pro-rata by reducing redeemable assets.
 * - Pause blocks deposits and harvest, never withdrawals.
 */
abstract contract PrincipalVault is IStakeVault, Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;

    address public treasury;
    address public operator;
    address public guardian;
    address public strategy;

    uint256 public totalPrincipal;
    uint256 public totalShares;
    uint256 public totalYieldHarvested;

    mapping(address => uint256) private _shares;

    event Deposited(address indexed user, uint256 amount, uint256 shares);
    event Redeemed(address indexed user, uint256 shares, uint256 amount);
    event Harvested(address indexed asset, uint256 yieldAmount, address indexed treasury);
    event LossRecorded(address indexed asset, uint256 lossAmount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event GuardianUpdated(address indexed oldGuardian, address indexed newGuardian);
    event StrategyUpdated(address indexed oldStrategy, address indexed newStrategy);
    event StrategyAllocated(address indexed strategy, uint256 amount);
    event StrategyDeallocated(address indexed strategy, uint256 amount);

    error InvalidAddress();
    error InvalidUser();
    error ZeroAmount();
    error ZeroShares();
    error NotOperator();
    error NotGuardian();
    error InsufficientShares();
    error InsufficientLiquidity();
    error FeeOnTransferNotSupported();
    error StrategyNotEmpty();
    error VaultInLoss();

    constructor(address asset_, address initialTreasury_, address initialOperator_, address initialOwner_)
        Ownable(initialOwner_)
    {
        if (
            asset_ == address(0) || initialTreasury_ == address(0) || initialOperator_ == address(0)
                || initialOwner_ == address(0)
        ) revert InvalidAddress();

        assetToken = IERC20(asset_);
        treasury = initialTreasury_;
        operator = initialOperator_;
        guardian = initialOwner_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert NotGuardian();
        _;
    }

    function asset() external view override returns (address) {
        return address(assetToken);
    }

    function sharesOf(address user) public view override returns (uint256) {
        return _shares[user];
    }

    /**
     * @notice Total assets controlled by the vault, including strategy assets.
     */
    function totalAssets() public view virtual override returns (uint256) {
        uint256 idle = assetToken.balanceOf(address(this));
        if (strategy == address(0)) return idle;
        return idle + IYieldStrategy(strategy).totalAssets();
    }

    function strategyAssets() public view returns (uint256) {
        if (strategy == address(0)) return 0;
        return IYieldStrategy(strategy).totalAssets();
    }

    /**
     * @notice Shares received for a deposit at the current principal-per-share.
     * @dev Deposits are blocked while totalAssets < totalPrincipal, so this
     * price is only used when the vault has no unrealised loss.
     */
    function previewDeposit(uint256 amount) public view override returns (uint256 shares) {
        if (amount == 0) return 0;
        if (totalShares == 0) return amount;

        uint256 basis = _redeemableBasis();
        if (basis == 0) return amount;

        return (amount * totalShares) / basis;
    }

    /**
     * @notice Assets returned for a share amount. Unharvested yield is not
     * included in the user claim; only principal (or the loss-adjusted
     * principal) is redeemable.
     */
    function previewRedeem(uint256 shares) public view override returns (uint256 amount) {
        if (shares == 0 || totalShares == 0) return 0;
        return (shares * _redeemableBasis()) / totalShares;
    }

    function depositFor(address user, uint256 amount)
        external
        override
        nonReentrant
        onlyOperator
        whenNotPaused
        returns (uint256 shares)
    {
        if (user == address(0)) revert InvalidUser();
        if (amount == 0) revert ZeroAmount();

        // Do not mix new principal with an unrealised loss. Otherwise a new
        // depositor could be diluted by the old loss, while a later recovery
        // would be misclassified as yield above principal.
        if (totalShares > 0 && totalAssets() < totalPrincipal) revert VaultInLoss();

        _beforeDeposit(user, amount);

        shares = previewDeposit(amount);
        if (shares == 0) revert ZeroShares();

        uint256 balanceBefore = assetToken.balanceOf(address(this));
        assetToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = assetToken.balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert FeeOnTransferNotSupported();

        _shares[user] += shares;
        totalShares += shares;
        totalPrincipal += amount;

        emit Deposited(user, amount, shares);
    }

    function redeemFor(address user, uint256 shares)
        external
        override
        nonReentrant
        onlyOperator
        returns (uint256 amount)
    {
        if (user == address(0)) revert InvalidUser();
        if (shares == 0) revert ZeroShares();
        if (_shares[user] < shares) revert InsufficientShares();

        amount = previewRedeem(shares);
        if (amount == 0) revert ZeroAmount();

        uint256 principalRedeemed = (shares * totalPrincipal) / totalShares;
        uint256 loss = principalRedeemed > amount ? principalRedeemed - amount : 0;

        _shares[user] -= shares;
        totalShares -= shares;
        totalPrincipal -= principalRedeemed;

        _ensureLiquidity(amount);
        assetToken.safeTransfer(user, amount);

        if (loss > 0) emit LossRecorded(address(assetToken), loss);
        emit Redeemed(user, shares, amount);
    }

    /**
     * @notice Moves yield above principal to treasury. Never moves principal.
     */
    function harvest() external override nonReentrant whenNotPaused returns (uint256 yieldAmount) {
        uint256 assets = totalAssets();
        if (assets <= totalPrincipal) return 0;

        yieldAmount = assets - totalPrincipal;
        _ensureLiquidity(yieldAmount);
        assetToken.safeTransfer(treasury, yieldAmount);

        totalYieldHarvested += yieldAmount;
        emit Harvested(address(assetToken), yieldAmount, treasury);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert InvalidAddress();
        emit GuardianUpdated(guardian, newGuardian);
        guardian = newGuardian;
    }

    function setStrategy(address newStrategy) external override onlyOwner {
        if (newStrategy != address(0)) {
            if (IYieldStrategy(newStrategy).asset() != address(assetToken)) revert InvalidAddress();
        }
        if (strategy != address(0) && IYieldStrategy(strategy).totalAssets() != 0) {
            revert StrategyNotEmpty();
        }

        emit StrategyUpdated(strategy, newStrategy);
        strategy = newStrategy;
    }

    function allocateToStrategy(uint256 amount) external nonReentrant onlyOwner {
        if (strategy == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        if (assetToken.balanceOf(address(this)) < amount) revert InsufficientLiquidity();

        assetToken.forceApprove(strategy, amount);
        IYieldStrategy(strategy).deposit(amount);
        assetToken.forceApprove(strategy, 0);

        emit StrategyAllocated(strategy, amount);
    }

    function deallocateFromStrategy(uint256 amount) external nonReentrant onlyOwner {
        if (strategy == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();

        IYieldStrategy(strategy).withdraw(amount);
        emit StrategyDeallocated(strategy, amount);
    }

    function pause() external override onlyGuardian {
        _pause();
    }

    function unpause() external override onlyOwner {
        _unpause();
    }

    /**
     * @dev Hook for vault-specific deposit checks. StockVault uses it for its
     * per-ticker allowlist and cap.
     */
    function _beforeDeposit(address user, uint256 amount) internal virtual {}

    function _redeemableBasis() internal view returns (uint256) {
        uint256 assets = totalAssets();
        uint256 principal = totalPrincipal;
        return assets < principal ? assets : principal;
    }

    function _ensureLiquidity(uint256 amount) internal {
        uint256 balance = assetToken.balanceOf(address(this));
        if (balance >= amount) return;

        if (strategy == address(0)) revert InsufficientLiquidity();

        IYieldStrategy(strategy).withdraw(amount - balance);
        balance = assetToken.balanceOf(address(this));
        if (balance < amount) revert InsufficientLiquidity();
    }
}
